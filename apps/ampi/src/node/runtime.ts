// The AmPi node runtime: owns every pi-durable Harness on this host. Each top-level thread is one storage (one SQLite
// file) holding the thread's root conversation and everything it owns: forks, subagents, and Team workers. A storage
// failure therefore ends one thread tree, not the host (systems-observer risk 1), and each tree has its own commit
// line. The node is the only authority; clients see projections.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import { type MutableReplicatedState, replicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import {
	AgentDoc,
	type Conversation,
	type ConversationId,
	type ConversationRecord,
	defineDoc,
	type EntryRecord,
	type Extension,
	Harness,
	type HarnessSettings,
	InboxDoc,
	LiveDoc,
	type Registry,
	UsageDoc,
	createRegistry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { Activity, NodeInfo, ThreadSummary, ThreadsState } from "../shared/protocol.ts";

/** The frozen node backend keys its threads by conversation id, outside the Pi wire contract (docs/wire-boundary.md). */
type NodeThreadsState = Omit<ThreadsState, "threads"> & { threads: Record<string, ThreadSummary> };
import { AmpiCore } from "./core-extension.ts";
import { defaultModel, listModels, openModels } from "./models.ts";
import { contentText } from "./projection.ts";
import { Terminals } from "./terminals.ts";
import { Accounts } from "./accounts.ts";
import { buildId } from "../shared/build.ts";

export const VERSION = "0.1.0";

/** Session-scoped AmPi metadata of one storage: thread titles and kinds. Presentation, never identity (P4). */
export type MetaState = {
	createdAt: number;
	root?: string;
	/** This storage's ID, so tools running inside it can find their own store. */
	store?: string;
	convs: Record<string, { kind: ThreadSummary["kind"]; createdAt: number; title?: string; archived?: boolean }>;
};
export const MetaDoc = defineDoc<MetaState>({
	kind: "ampi.meta",
	version: 1,
	scope: "session",
	initial: () => ({ createdAt: Date.now(), convs: {} }),
});

/** Extra extensions and hooks contributed by HyperCarrier adapters (Team, Rarebit, compaction). */
export type NodePlugin = {
	extensions: Extension[];
	/** Conversations whose summaries depend on a changed Session document of this plugin. */
	touches?(kind: string, value: unknown): string[];
	/** Called when a storage opens, before work resumes. */
	attach?(store: Store, runtime: NodeRuntime): void | Promise<void>;
	/** Extra summary fields for one conversation. A pure projection of committed state: it never starts work. */
	summarize?(store: Store, conversationId: string, summary: ThreadSummary): void | Promise<void>;
	/**
	 * Runs after the index changed. May start work, but only after recording the decision durably, so a restart or a
	 * repeated refresh finds the decision instead of making it again. Failures are reported, never thrown.
	 */
	react?(store: Store, conversationId: string, summary: ThreadSummary): void | Promise<void>;
	settings?: Partial<HarnessSettings> | ((models: MutableModels) => Partial<HarnessSettings>);
	/** Installed but not selected by default; conversations opt in with configure(). */
	optIn?: Extension[];
};

export type NodeOptions = {
	home?: string;
	models?: MutableModels;
	plugins?: NodePlugin[];
	/** Pace of ampi-sim streaming; tests raise it. */
	simTokensPerSecond?: number;
	simContextWindow?: number;
	report?: (error: unknown) => void;
};

export class Store {
	readonly id: string;
	readonly dir: string;
	harness!: Harness;
	root!: Conversation;
	closed = false;
	#unsubscribe?: () => void;

	constructor(id: string, dir: string) {
		this.id = id;
		this.dir = dir;
	}

	threadKey(conversationId: ConversationId | string): string {
		return `${this.id}.${conversationId}`;
	}

	async conversation(conversationId: string, context: Context = BACKGROUND_CONTEXT): Promise<Conversation> {
		const conversation = await this.harness.conversation(Number(conversationId) as ConversationId, context);
		if (conversation === undefined) throw new NodeError("not_found", `No conversation ${conversationId} in ${this.id}`);
		return conversation;
	}

	set unsubscribe(fn: () => void) {
		this.#unsubscribe = fn;
	}

	detach(): void {
		this.#unsubscribe?.();
	}
}

export class NodeError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

export function parseThreadKey(key: string): { storeId: string; conversationId: string } {
	const dot = key.lastIndexOf(".");
	if (dot <= 0) throw new NodeError("bad_request", `Bad thread id ${key}`);
	return { storeId: key.slice(0, dot), conversationId: key.slice(dot + 1) };
}

function newId(): string {
	const time = Date.now().toString(36);
	return `t${time}${randomBytes(3).toString("hex")}`;
}

export class NodeRuntime {
	readonly home: string;
	readonly models: MutableModels;
	readonly registry: Registry;
	readonly plugins: NodePlugin[];
	readonly stores = new Map<string, Store>();
	readonly terminals = new Terminals();
	readonly accounts: Accounts;
	readonly threads: MutableReplicatedState<NodeThreadsState>;
	readonly info: NodeInfo;
	readonly settings: HarnessSettings;
	#pending = new Map<string, ReturnType<typeof setTimeout>>();
	/** Refreshes in flight; a refresh never overlaps another for the same key, so plugin `react` runs one at a time. */
	#running = new Map<string, Promise<void>>();
	/** The tail of each conversation's refresh chain. */
	#conversationLocks = new Map<string, Promise<void>>();
	readonly #report: (error: unknown) => void;
	/** Non-fatal failures of background work (Rarebit, compaction triggers): logged, never silent. */
	report(error: unknown): void {
		this.#report(error);
	}
	#closing = false;

	constructor(options: NodeOptions = {}) {
		this.home = options.home ?? process.env.AMPI_HOME ?? join(homedir(), ".ampi");
		mkdirSync(join(this.home, "threads"), { recursive: true, mode: 0o700 });
		this.models =
			options.models ??
			openModels({ sim: { tokensPerSecond: options.simTokensPerSecond, contextWindow: options.simContextWindow } });
		this.accounts = new Accounts(this.models);
		this.plugins = options.plugins ?? [];
		this.#report = options.report ?? ((error) => console.error("[ampi node]", error));
		this.registry = createRegistry();
		this.registry.install(CodingTools);
		this.registry.install(AmpiCore);
		for (const plugin of this.plugins) for (const extension of plugin.extensions) this.registry.install(extension);
		const merged: HarnessSettings = {};
		for (const plugin of this.plugins)
			Object.assign(merged, (typeof plugin.settings === "function" ? plugin.settings(this.models) : plugin.settings) ?? {});
		const optIn = new Set(this.plugins.flatMap((plugin) => (plugin.optIn ?? []).map((extension) => extension.name)));
		const defaults = [CodingTools, AmpiCore, ...this.plugins.flatMap((plugin) => plugin.extensions)].filter((e) => !optIn.has(e.name));
		this.settings = { toolExecution: "parallel", retry: { maxRetries: 3 }, ...merged, extensions: defaults };
		this.threads = replicatedState<NodeThreadsState>({ threads: {} });
		this.info = {
			nodeId: this.#nodeId(),
			hostname: hostname(),
			platform: process.platform,
			user: userInfo().username,
			home: homedir(),
			version: VERSION,
			build: buildId(),
			pid: process.pid,
			startedAt: Date.now(),
			storage: this.home,
		};
	}

	#nodeId(): string {
		const path = join(this.home, "node-id");
		if (existsSync(path)) return readFileSync(path, "utf8").trim();
		const id = `n${randomBytes(6).toString("hex")}`;
		writeFileSync(path, `${id}\n`, { mode: 0o600 });
		return id;
	}

	/** Opens every storage under `threads/` and resumes unfinished work. */
	async start(context: Context = BACKGROUND_CONTEXT): Promise<void> {
		const dir = join(this.home, "threads");
		for (const name of readdirSync(dir).sort()) {
			if (!existsSync(join(dir, name, "harness.sqlite"))) continue;
			try {
				await this.#open(name, context);
			} catch (error) {
				this.#report(new Error(`Could not open thread storage ${name}: ${(error as Error).message}`));
			}
		}
	}

	async #open(id: string, context: Context): Promise<Store> {
		const existing = this.stores.get(id);
		if (existing) return existing;
		const dir = join(this.home, "threads", id);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const store = new Store(id, dir);
		const storage = await openNodeSqliteStorage(join(dir, "harness.sqlite"));
		store.harness = await Harness.open(
			storage,
			{
				models: this.models,
				registry: this.registry,
				settings: this.settings,
				env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? homedir() }),
				conversationCreated: async (tx, record) => {
					const meta = await tx.doc(MetaDoc);
					meta.convs[String(record.id)] = {
						kind: record.owner ? "subagent" : record.parent ? "fork" : "thread",
						createdAt: Date.now(),
					};
				},
				onReport: (error) => this.#report(error),
			},
			context,
		);
		this.stores.set(id, store);
		store.unsubscribe = store.harness.subscribeCommits((publication) => {
			const touched = new Set<string>();
			for (const change of publication.changes) {
				if (change.type === "entry") touched.add(String(change.value.conversationId));
				else if (change.type === "conversation") touched.add(String(change.value.id));
				else if (change.type === "document") {
					if (change.conversationId !== undefined) touched.add(String(change.conversationId));
					// Session documents: titles and archive state touch every thread; a plugin's document only the
					// threads it names. Refreshing the whole tree on every Team event would cost N refreshes per event.
					else if (change.record.kind === MetaDoc.definition.kind) touched.add("*");
					else
						for (const plugin of this.plugins)
							for (const conversationId of plugin.touches?.(change.record.kind, change.value) ?? []) touched.add(conversationId);
				} else if (change.type === "document.copy") touched.add(String(change.conversationId));
			}
			for (const conversationId of touched) this.#schedule(store, conversationId);
		});
		void store.harness.closed.then((end) => {
			store.closed = true;
			store.detach();
			if (!this.#closing && end.reason === "failed") {
				const message = `storage unavailable: ${String((end as { error?: unknown }).error)}`;
				this.#report(new Error(`Thread storage ${id} failed (${message}); reopening`));
				this.stores.delete(id);
				this.#unavailable(id, message);
				this.#reopen(id, 1);
			}
		});
		const known = await store.harness.snapshot(MetaDoc, context);
		if (known?.store !== id)
			await store.harness.commit(async (tx) => {
				(await tx.doc(MetaDoc)).store = id;
			}, context);
		for (const plugin of this.plugins) await plugin.attach?.(store, this);
		const meta = await store.harness.snapshot(MetaDoc, context);
		if (meta?.root !== undefined) {
			store.root = await store.conversation(meta.root, context);
		}
		store.harness.resume();
		if (meta) for (const conversationId of Object.keys(meta.convs)) this.#schedule(store, conversationId, 0);
		return store;
	}

	#schedule(store: Store, conversationId: string, delay = 120): void {
		const key = `${store.id}.${conversationId}`;
		if (this.#pending.has(key)) return;
		this.#pending.set(
			key,
			setTimeout(() => {
				this.#pending.delete(key);
				if (store.closed) return;
				const running = this.#running.get(key);
				if (running) {
					// Run again after the one in flight, with fresh state.
					void running.finally(() => this.#schedule(store, conversationId, 0));
					return;
				}
				const run = (conversationId === "*" ? this.#refreshStore(store) : this.#refresh(store, conversationId))
					.catch((error) => {
						if (!store.closed) this.#report(error);
					})
					.finally(() => this.#running.delete(key));
				this.#running.set(key, run);
			}, delay),
		);
	}

	/** A failed storage stays visible: its threads keep their last summary, marked with the failure, until it reopens. */
	#unavailable(storeId: string, message: string): void {
		this.threads.change(BACKGROUND_CONTEXT, (draft) => {
			for (const [key, summary] of Object.entries(draft.threads))
				if (parseThreadKey(key).storeId === storeId) {
					summary.lastError = message.slice(0, 300);
					summary.activity = "idle";
				}
		});
	}

	#reopen(id: string, attempt: number): void {
		const delay = Math.min(60_000, 1000 * 2 ** (attempt - 1));
		setTimeout(() => {
			if (this.#closing) return;
			this.#open(id, BACKGROUND_CONTEXT).then(
				(store) => this.#schedule(store, "*", 0),
				(error) => {
					this.#report(error);
					this.#unavailable(id, `storage unavailable: ${(error as Error).message}`);
					this.#reopen(id, attempt + 1);
				},
			);
		}, delay);
	}

	async #refreshStore(store: Store): Promise<void> {
		const meta = await store.harness.snapshot(MetaDoc, BACKGROUND_CONTEXT);
		for (const conversationId of Object.keys(meta?.convs ?? {})) await this.#refresh(store, conversationId);
	}

	/**
	 * Recomputes one thread summary from committed state (P5: activity, queue, error, and spend stay separate).
	 * Refreshes of one conversation never overlap, whichever path started them (its own schedule or a store-wide
	 * one), so a plugin's `react` sees each decision it commits before it decides again.
	 */
	#refresh(store: Store, conversationId: string): Promise<void> {
		const key = `${store.id}.${conversationId}`;
		const previous = this.#conversationLocks.get(key) ?? Promise.resolve();
		const run = previous.then(() => this.#refreshNow(store, conversationId));
		const settled = run.catch(() => {});
		this.#conversationLocks.set(key, settled);
		void settled.then(() => {
			if (this.#conversationLocks.get(key) === settled) this.#conversationLocks.delete(key);
		});
		return run;
	}

	async #refreshNow(store: Store, conversationId: string): Promise<void> {
		const context = BACKGROUND_CONTEXT;
		const id = Number(conversationId) as ConversationId;
		const meta = await store.harness.snapshot(MetaDoc, context);
		const convMeta = meta?.convs[conversationId];
		if (convMeta === undefined) return;
		const record = (await store.harness.conversation(id, context)) ? await this.#record(store, id) : undefined;
		const [agent, live, inbox, usage] = await Promise.all([
			store.harness.snapshot(AgentDoc, id, context),
			store.harness.snapshot(LiveDoc, id, context),
			store.harness.snapshot(InboxDoc, id, context),
			store.harness.snapshot(UsageDoc, id, context),
		]);
		const conversation = await store.conversation(conversationId, context);
		const page = await conversation.entries({}, 12, undefined, context);
		const recent = page.items as readonly EntryRecord[];
		const summary: ThreadSummary = {
			id: store.threadKey(conversationId),
			title: convMeta.title ?? "",
			cwd: agent?.cwd ?? homedir(),
			createdAt: convMeta.createdAt,
			updatedAt: convMeta.createdAt,
			kind: convMeta.kind,
			activity: activityOf(live),
			queued: inbox?.items.length ?? 0,
			costUsd: 0,
		};
		if (convMeta.archived) summary.archived = true;
		if (record?.owner) summary.parentId = store.threadKey(record.owner.conversationId);
		else if (record?.parent) summary.parentId = store.threadKey(record.parent.conversationId);
		if (agent?.model) summary.model = `${agent.model.provider}/${agent.model.modelId}`;
		for (const value of Object.values(usage?.models ?? {})) summary.costUsd += (value as { cost?: { total?: number } }).cost?.total ?? 0;
		for (const value of Object.values(usage?.tools ?? {})) summary.costUsd += (value as { cost?: { total?: number } }).cost?.total ?? 0;
		for (const entry of recent) {
			// biome-ignore lint: loosely typed pi-ai message
			const message = entry.model?.[0] as any;
			const ts = message?.timestamp ?? (entry.data as { ts?: number } | undefined)?.ts;
			if (typeof ts === "number" && ts > summary.updatedAt) summary.updatedAt = ts;
			if (summary.preview === undefined && (entry.kind === "pi.user" || entry.kind === "pi.assistant")) {
				const text = contentText(message?.content).trim();
				if (text) summary.preview = text.replace(/\s+/g, " ").slice(0, 160);
			}
		}
		const lastAssistant = recent.find((entry) => entry.kind === "pi.assistant");
		// biome-ignore lint: loosely typed pi-ai message
		const assistantMessage = lastAssistant?.model?.[0] as any;
		if (assistantMessage?.stopReason === "error" && summary.activity === "idle")
			summary.lastError = String(assistantMessage.errorMessage ?? "error").slice(0, 300);
		// After a compaction the last response's usage describes the old context; show nothing until the next response.
		const lastCompaction = recent.find((entry) => entry.kind === "pi.compaction" || entry.kind === "pi.reset");
		if (assistantMessage?.usage && !(lastCompaction && lastAssistant && lastCompaction.id > lastAssistant.id)) {
			const u = assistantMessage.usage;
			summary.contextTokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0);
		}
		if (agent?.model) {
			const model = this.models.getModel(agent.model.provider, agent.model.modelId);
			if (model?.contextWindow) summary.contextWindow = model.contextWindow;
		}
		if (!summary.title) {
			const firstUser = await this.#firstUserText(store, conversation);
			summary.title = firstUser ? firstUser.replace(/\s+/g, " ").slice(0, 80) : "New thread";
		}
		for (const plugin of this.plugins) await plugin.summarize?.(store, conversationId, summary);
		this.threads.change(context, (draft) => {
			draft.threads[summary.id] = summary;
		});
		for (const plugin of this.plugins) {
			try {
				await plugin.react?.(store, conversationId, summary);
			} catch (error) {
				this.#report(error);
			}
		}
	}

	#firstUserTitles = new Map<string, string>();
	async #firstUserText(store: Store, conversation: Conversation): Promise<string | undefined> {
		const key = store.threadKey(conversation.id);
		const cached = this.#firstUserTitles.get(key);
		if (cached) return cached;
		const page = await conversation.entries({ order: "ascending" }, 50, undefined, BACKGROUND_CONTEXT);
		const first = (page.items as readonly EntryRecord[]).find((entry) => entry.kind === "pi.user");
		const found = first ? contentText(first.model?.[0]?.content) : undefined;
		if (found) this.#firstUserTitles.set(key, found);
		return found;
	}

	async #record(store: Store, id: ConversationId): Promise<ConversationRecord | undefined> {
		return store.harness.commit((tx) => tx.conversation(id), BACKGROUND_CONTEXT);
	}

	store(storeId: string): Store {
		const store = this.stores.get(storeId);
		if (!store || store.closed) throw new NodeError("not_found", `No thread storage ${storeId}`);
		return store;
	}

	async thread(key: string): Promise<{ store: Store; conversation: Conversation; conversationId: string }> {
		const { storeId, conversationId } = parseThreadKey(key);
		const store = this.store(storeId);
		return { store, conversation: await store.conversation(conversationId), conversationId };
	}

	async createThread(args: {
		cwd?: string;
		model?: { provider: string; modelId: string };
		thinkingLevel?: string;
		title?: string;
		prompt?: string;
		requestId?: string;
	}): Promise<{ threadId: string; submissionId?: string }> {
		const context = BACKGROUND_CONTEXT;
		const cwd = args.cwd ? expandHome(args.cwd) : homedir();
		if (!existsSync(cwd)) throw new NodeError("bad_request", `Directory does not exist on ${hostname()}: ${cwd}`);
		// A request ID names the thread: a retried create (lost response, reconnect replay) opens the same storage and
		// finds its root instead of making a second thread; the prompt's submission dedupes on the same ID.
		const id = args.requestId ? `r${createHash("sha256").update(args.requestId).digest("hex").slice(0, 20)}` : newId();
		const inflight = this.#creating.get(id);
		if (inflight) return inflight;
		const run = this.#createThread(id, cwd, args).finally(() => this.#creating.delete(id));
		this.#creating.set(id, run);
		return run;
	}

	#creating = new Map<string, Promise<{ threadId: string; submissionId?: string }>>();

	async #createThread(
		id: string,
		cwd: string,
		args: { model?: { provider: string; modelId: string }; thinkingLevel?: string; title?: string; prompt?: string; requestId?: string },
	): Promise<{ threadId: string; submissionId?: string }> {
		const context = BACKGROUND_CONTEXT;
		const store = await this.#open(id, context);
		const existing = await store.harness.snapshot(MetaDoc, context);
		const known = existing?.root ?? Object.entries(existing?.convs ?? {}).find(([, conv]) => conv.kind === "thread")?.[0];
		let root: Conversation;
		if (known !== undefined) root = await store.conversation(known, context);
		else {
			const model = args.model ?? (await defaultModel(this.models));
			root = await store.harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: { model, cwd, ...(args.thinkingLevel ? { thinkingLevel: args.thinkingLevel as never } : {}) },
				},
				context,
			);
		}
		await store.harness.commit(async (tx) => {
			const meta = await tx.doc(MetaDoc);
			meta.root = String(root.id);
			if (args.title && meta.convs[String(root.id)]) meta.convs[String(root.id)]!.title = args.title;
		}, context);
		store.root = root;
		const threadId = store.threadKey(root.id);
		this.#schedule(store, String(root.id), 0);
		if (args.prompt) {
			const submission = await root.submit(
				{ type: "input", content: args.prompt, ...(args.requestId ? { requestId: args.requestId } : {}) },
				context,
			);
			return { threadId, submissionId: String(submission.id) };
		}
		return { threadId };
	}

	async updateMeta(key: string, change: { title?: string; archived?: boolean }): Promise<void> {
		const { store, conversationId } = await this.thread(key);
		await store.harness.commit(async (tx) => {
			const meta = await tx.doc(MetaDoc);
			const conv = meta.convs[conversationId];
			if (!conv) throw new NodeError("not_found", key);
			if (change.title !== undefined) conv.title = change.title;
			if (change.archived !== undefined) conv.archived = change.archived;
		}, BACKGROUND_CONTEXT);
		this.#schedule(store, conversationId, 0);
	}

	async listModels() {
		const [choices, preferred] = await Promise.all([listModels(this.models), defaultModel(this.models)]);
		return choices.map((m) => (m.provider === preferred.provider && m.id === preferred.modelId ? { ...m, default: true as const } : m));
	}

	refresh(store: Store, conversationId: string): void {
		this.#schedule(store, conversationId, 0);
	}

	async close(context: Context = BACKGROUND_CONTEXT): Promise<void> {
		this.#closing = true;
		for (const timer of this.#pending.values()) clearTimeout(timer);
		this.#pending.clear();
		await Promise.all(
			[...this.stores.values()].map(async (store) => {
				store.detach();
				if (!store.closed) await store.harness.close(context).catch(() => {});
			}),
		);
		this.stores.clear();
	}
}

export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

// biome-ignore lint: LiveState is loosely typed at this boundary
export function activityOf(live: any): Activity {
	if (!live) return "idle";
	if (live.compactions?.some((c: { blocking: boolean }) => c.blocking)) return "compacting";
	if (live.generation?.retry) return "retrying";
	if (live.tools?.some((t: { status: string }) => t.status !== "done")) return "tools";
	if (live.generation?.message) return "streaming";
	if (live.run) return live.generation ? "thinking" : "waiting";
	return "idle";
}
