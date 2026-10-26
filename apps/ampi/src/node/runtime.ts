// The AmPi node runtime: owns every pi-durable Harness on this host. Each top-level thread is one storage (one SQLite
// file) holding the thread's root conversation and everything it owns: forks, subagents, and Team workers. A storage
// failure therefore ends one thread tree, not the host (systems-observer risk 1), and each tree has its own commit
// line. The node is the only authority; clients see projections.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { basename, join } from "node:path";
import { type MutableReplicatedState, replicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { type Api, type AssistantMessage, type AssistantMessageEventStream, createAssistantMessageEventStream, type Model, type StreamOptions } from "@earendil-works/pi-ai";
import type { Models, MutableModels } from "@earendil-works/pi-ai/models";
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
	ProviderDoc,
	type Registry,
	type Storage,
	type SubmissionId,
	type TaskId,
	type ToolRegistration,
	UsageDoc,
	createRegistry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CODEMODE_TOOL_NAME, createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { contextTokensOf } from "@hypercarrier/auto-compact-durable/budget";
import type { ActionAck, Activity, ControlCompaction, ControlSubmission, EditQueuedResult, NodeHealth, NodeInfo, Placement, ThreadCreated, ThreadSummary, ThreadsState } from "../shared/protocol.ts";

/** The frozen node backend keys its threads by conversation id, outside the Pi wire contract (docs/wire-boundary.md). */
type NodeThreadsState = Omit<ThreadsState, "threads"> & { threads: Record<string, ThreadSummary> };
import { ampiCore } from "./core-extension.ts";
import { defaultModel, listModels, openModels, startModel, testSafeModels } from "./models.ts";
import { assertTestIsolation } from "./test-mode.ts";
import { type PiConfigOptions, piResources } from "./pi-config.ts";
import { activityOf, contentText, queueOrigin, RETURNED_KIND, type ReturnedState } from "./projection.ts";
import { nodeGuard, recordStop, stopLatch, toolBlockReason } from "./guard.ts";
import { type Marked, markStops, returnedInput, type StopIntent, type StopOutcome, settleStops } from "./stops.ts";
import { FIRST_ORDER, newTab, orderAfter, type Placed, type Tab, tabLayout } from "./tabs.ts";
import { Accounts } from "./accounts.ts";
import { buildId } from "../shared/build.ts";
import { type CacheTtl, cacheGoblinModels, CacheTtlDoc } from "../plugins/cache-goblin.ts";
import { photonImages, piCodingTools } from "./coding-tools.ts";
import { backupReason, backupStore, rootConversations, writeStoreFile } from "./store-file.ts";

export const VERSION = "0.1.0";

/** Session-scoped AmPi metadata: thread presentation and per-conversation migrations, never identity (P4). */
export type MetaState = {
	createdAt: number;
	root?: string;
	/** This storage's ID, so tools running inside it can find their own store. */
	store?: string;
	convs: Record<string, ConvMeta>;
};
/**
 * One conversation's AmPi metadata. `tab` and `order` place it (node-design.md, Tabs); stores written before tabs
 * have none and show unplaced. `closed` is the stored Close intent: the thread is read-only from then on. Its
 * `attention` keeps the reasons of the runs that were parked at Close, because Close removes their tasks.
 */
export type ConvMeta = {
	kind: ThreadSummary["kind"];
	createdAt: number;
	title?: string;
	archived?: boolean;
	/** Summary retirement committed; later boots skip the legacy document scan. */
	rarebitSummaryRetired?: true;
	tab?: Tab;
	order?: string;
	closed?: { at: number; by: string; attention?: string[] };
};
export const MetaDoc = defineDoc<MetaState>({
	kind: "ampi.meta",
	version: 1,
	checkpointWhen: () => false,
	scope: "session",
	initial: () => ({ createdAt: Date.now(), convs: {} }),
});

/** The newest queued-message edits by `editId`, so a retry after an unknown outcome gets the first answer. */
export type EditsState = { edits: Record<string, { submission: string; text: string; result: EditQueuedResult; at: number }> };
const KEEP_EDITS = 50;
export const EditsDoc = defineDoc<EditsState>({
	kind: "ampi.edits",
	version: 1,
	checkpointWhen: () => false,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ edits: {} }),
});

/** Inputs Esc took back from the queue, shown as `returned` in the thread's inbox until the owner dismisses them. */
export const ReturnedDoc = defineDoc<ReturnedState>({
	kind: RETURNED_KIND,
	version: 1,
	checkpointWhen: () => false,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ items: [] }),
});

export type OwnershipNames = { thread: string; owner: string };

/**
 * Esc stop intents not yet settled, by intent ID. Esc stores one before it marks anything, so a restart marks every
 * target it captured before work resumes; settlement deletes it.
 */
export const EscDoc = defineDoc<{ intents: Record<string, StopIntent> }>({
	kind: "ampi.esc",
	version: 1,
	checkpointWhen: () => false,
	scope: "session",
	initial: () => ({ intents: {} }),
});

/** Extra extensions and hooks contributed by HyperCarrier adapters (Team, Rarebit, compaction). */
export type NodePlugin = {
	extensions: Extension[];
	/** Conversations whose summaries depend on a changed Session document of this plugin. */
	touches?(kind: string, value: unknown): string[];
	/** Conversations this plugin owns as storage, not agent threads. A pure projection of committed state. */
	internal?(store: Store, conversationId: string): boolean | Promise<boolean>;
	/** Called when a storage opens, before work resumes. */
	attach?(store: Store, runtime: NodeRuntime): void | Promise<void>;
	/** Extra summary fields for one conversation. A pure projection of committed state: it never starts work. */
	summarize?(store: Store, conversationId: string, summary: ThreadSummary): void | Promise<void>;
	/**
	 * Names an owned conversation and its owner from committed state, as a refusal and a summary show them (a Team
	 * Worker and its `lead`). The node uses the first answer; without one it says `thread` and `owner`.
	 */
	ownership?(store: Store, conversationId: string): OwnershipNames | undefined | Promise<OwnershipNames | undefined>;
	/**
	 * Runs after the index changed. May start work, but only after recording the decision durably, so a restart or a
	 * repeated refresh finds the decision instead of making it again. Failures are reported, never thrown.
	 * The node calls it only for an open, unfenced thread of a store whose open recovery is done, inside the thread's
	 * Close section (`#react`): a Close either waits for the reaction or comes first, and then no reaction runs. The
	 * summary can be older than a Close; the gate is not. A reaction must not wait for the work it starts.
	 * Work that outlives the reaction (a detached job) runs through `runtime.effect`, admitted synchronously
	 * inside the reaction, so Close aborts it and it starts no request and writes nothing after the Close.
	 */
	react?(store: Store, conversationId: string, summary: ThreadSummary): void | Promise<void>;
	settings?: Partial<HarnessSettings> | ((models: MutableModels) => Partial<HarnessSettings>);
	/**
	 * The stop fence (src/node/stops.ts). `stops` lists this plugin's stored, unconfirmed stop intents of one store.
	 * On open the node marks every intent before `harness.resume()`, settles them after it, and reports each result
	 * to `confirmStop`, where the plugin stores its receipt. An intent that failed stays stored and is marked again
	 * on the next open. At run time a plugin commits its intents, then calls `runtime.stop(store, intents, plugin)`.
	 */
	stops?(store: Store): StopIntent[] | Promise<StopIntent[]>;
	confirmStop?(store: Store, intentId: string, outcome: StopOutcome): void | Promise<void>;
	/**
	 * The owner closes `conversationId` (a Team lead, for example). The Close intent is already stored. The plugin
	 * commits its own stop intents and returns them; the node marks and settles them with the thread's own work.
	 * Recovery replays this callback for each closed conversation before resume. It must be idempotent and must
	 * not start the scheduler or create runnable work.
	 */
	closing?(store: Store, conversationId: string): StopIntent[] | Promise<StopIntent[]>;
	/** Installed but not selected by default; conversations opt in with configure(). */
	optIn?: Extension[];
};

export type NodeOptions = {
	home?: string;
	/** Pi's agent directory (settings, models.json, auth.json, skills): default PI_CODING_AGENT_DIR, else ~/.pi/agent. */
	agentDir?: string;
	models?: MutableModels;
	/** Test-only provider IDs. Each selected model must use in-memory or loopback transport. */
	testProviders?: readonly string[];
	plugins?: NodePlugin[];
	/** Pace of ampi-sim streaming; tests raise it. */
	simTokensPerSecond?: number;
	simContextWindow?: number;
	report?: (error: unknown) => void;
	/**
	 * Test-only fault seam: wraps each storage as it opens, so a test can make one store's Storage throw. Unset in
	 * production; the node passes the SQLite storage through unchanged.
	 */
	wrapStorage?: (storeId: string, storage: Storage) => Storage;
	/** The reopen backoff timer; tests inject one to run the attempts without waiting. */
	setTimer?: (callback: () => void, delayMs: number) => void;
	/** How long Esc waits for its stop to settle before it answers `stopping` (default 2000 ms). */
	stopWaitMs?: number;
};

/** Automatic reopen budget per store for this node process (1 s doubling: about 63 s in all). */
export const REOPEN_ATTEMPTS = 6;

export class Store {
	readonly id: string;
	readonly dir: string;
	harness!: Harness;
	root!: Conversation;
	closed = false;
	/** `ProviderDoc.sessionId` to conversation: Cache Goblin's TTL lookup. A provider key never changes. */
	readonly providerKeys = new Map<string, ConversationId>();
	/** Each conversation's owning conversation, for the dispatch gate. An owner never changes. */
	readonly owners = new Map<string, string | undefined>();
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

/** A plugin job's admission was refused, or Close or a stop aborted it: it starts no request and writes nothing. */
export class EffectAborted extends Error {}

type Tx = Parameters<Parameters<Harness["commit"]>[0]>[0];

/**
 * An effectful plugin job on one thread, admitted by `NodeRuntime.effect`. Close and every stop that fences the
 * thread abort `signal`. Every write and every model request of the job goes through it.
 */
export type Effect = {
	readonly signal: AbortSignal;
	/** Commits only while the thread is open; an aborted effect or a closed thread throws `EffectAborted` and writes nothing. */
	commit<T>(change: (tx: Tx) => T | Promise<T>): Promise<T>;
	/** Starts one request with `signal`. It refuses after an abort and discards a result that arrives after one. */
	start<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T>;
	/** The node's models, behind the dispatch gate of this effect's conversation. A plugin dispatches only through these. */
	readonly models: MutableModels;
};

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

/**
 * A one-line excerpt of at most `max` characters, collapsed from a bounded head of `text`. V8 keeps a slice's whole
 * parent string alive, so the excerpt is a copy: a row preview or title never pins a large message body (D21).
 */
export function excerpt(text: string, max: number): string {
	const line = text.slice(0, max * 8).trim().replace(/\s+/g, " ").slice(0, max);
	return Buffer.from(line, "utf8").toString("utf8");
}

/**
 * SQLite page cache of one store, in KiB. The node keeps every thread's store open. SQLite's 2 MB default fills
 * with large bodies, so each idle store would hold about 2 MB of node memory (D21). The OS file cache serves rereads.
 */
const STORE_CACHE_KIB = 512;

/** pi-durable's `openNodeSqliteStorage`, with the store page cache bound. */
async function openStoreStorage(path: string): Promise<SqliteStorage> {
	const database = await openNodeSqliteDatabase(path);
	await database.exec(`PRAGMA cache_size = -${STORE_CACHE_KIB}`);
	return SqliteStorage.open(database);
}

function newId(): string {
	const time = Date.now().toString(36);
	return `t${time}${randomBytes(3).toString("hex")}`;
}

/** Pi's tool names the node registers; `defaultTools` enables or removes them per thread. grep, find, and ls are not provided. */
const PI_TOOLS = ["read", "bash", "edit", "write", CODEMODE_TOOL_NAME];

export class NodeRuntime {
	readonly home: string;
	/** Where the node reads Pi's configuration; passed to every pi-config.ts read. */
	readonly piConfig: PiConfigOptions;
	/** The registered tools named in PI_TOOLS, which `defaultTools` filters. */
	readonly #piTools: ToolRegistration[];
	readonly models: MutableModels;
	readonly registry: Registry;
	readonly plugins: NodePlugin[];
	readonly stores = new Map<string, Store>();
	readonly accounts: Accounts;
	readonly threads: MutableReplicatedState<NodeThreadsState>;
	readonly info: NodeInfo;
	readonly settings: HarnessSettings;
	/**
	 * Conversations a stop fences now: thread key to the ids of the unconfirmed stop intents that cover it. A key is
	 * fenced while any intent of any owner covers it, so one owner's receipt never lifts another owner's fence.
	 */
	readonly #fenced = new Map<string, Set<string>>();
	/** Conversations of a closed chain whose late work #sweepClosed stops now; true when a refresh came meanwhile. */
	readonly #sweeping = new Map<string, boolean>();
	/** Stores whose open marked every stored stop and resumed the scheduler: plugin reactions may run. */
	readonly #recovered = new WeakSet<Store>();
	/** Threads whose Close has begun, set before the Close commit: no effect is admitted for them. */
	readonly #closedKeys = new Set<string>();
	/** Archived conversations reject effects but keep their transcript and can be unarchived. */
	readonly #archivedKeys = new Set<string>();
	/** The live plugin effects of each thread, aborted by Close and by a fence. */
	readonly #effects = new Map<string, Set<AbortController>>();
	/**
	 * The conversation of the tool execution in progress, set at the tool seam (#scoped). The dispatch gate reads it for
	 * a request without a `sessionId`, such as code mode's `models.classify()` and `models.generateImages()`.
	 */
	readonly #toolScope = new AsyncLocalStorage<string>();
	/** Model requests held by the dispatch gate; each wakes when a Close or fence ends, to check again. */
	readonly #held = new Set<() => void>();
	/** Placement of every known thread, for `beside` orders and the tab layout. */
	readonly #placed = new Map<string, Placed>();
	/** Serializes Close against admission (submit, command, configure, compact) per thread. */
	readonly #admission = new Map<string, Promise<unknown>>();
	/** Placement of a root conversation being created, read by `conversationCreated`. */
	readonly #placing = new Map<string, { tab: Tab; order: string }>();
	#pending = new Map<string, ReturnType<typeof setTimeout>>();
	/** Refreshes in flight; a refresh never overlaps another for the same key, so plugin `react` runs one at a time. */
	#running = new Map<string, Promise<void>>();
	/** The tail of each conversation's refresh chain. */
	#conversationLocks = new Map<string, Promise<void>>();
	/** Thread topic listeners of each thread's `ampi.returned` document, which the conversation view does not mount. */
	readonly #returnedListeners = new Map<string, Set<(value: ReturnedState) => void>>();
	readonly #report: (error: unknown) => void;
	readonly #wrapStorage?: (storeId: string, storage: Storage) => Storage;
	readonly #setTimer: (callback: () => void, delayMs: number) => void;
	/** Stores whose storage failed and is not open now, with the failure. `gaveUp` stops the reopen timer. */
	readonly #failed = new Map<string, { error: string; attempts: number; gaveUp: boolean }>();
	readonly #reopenTimers = new Set<ReturnType<typeof setTimeout>>();
	/** A successful open does not replenish the budget: resumed work can fail its first write. */
	readonly #recoveryAttempts = new Map<string, number>();
	readonly #opening = new Map<string, Promise<Store>>();
	/** Stores this process already backed up before a migration: a reopen loop makes no second copy. */
	readonly #backedUp = new Set<string>();
	/** Rows `#unavailable` invented for a store that failed before it had rows; removed when the store opens. */
	readonly #placeholders = new Set<string>();
	/** Non-fatal failures of background work (Rarebit, compaction triggers): logged, never silent. */
	report(error: unknown): void {
		this.#report(error);
	}
	#closing = false;
	readonly #stopWaitMs: number;
	/** Confirms an Esc stop: a settled one leaves EscDoc; an unsettled one stays for the next open to mark again. */
	readonly #escStops: NodePlugin = {
		extensions: [],
		confirmStop: async (store, intentId, outcome) => {
			if (outcome.status !== "settled") return;
			await store.harness.commit(async (tx) => {
				delete (await tx.doc(EscDoc)).intents[intentId];
			}, BACKGROUND_CONTEXT);
		},
	};

	constructor(options: NodeOptions = {}) {
		assertTestIsolation();
		this.home = options.home ?? process.env.AMPI_HOME ?? join(homedir(), ".ampi");
		mkdirSync(join(this.home, "threads"), { recursive: true, mode: 0o700 });
		this.piConfig = options.agentDir ? { agentDir: options.agentDir } : {};
		this.models = testSafeModels(
			options.models ?? openModels({ agentDir: options.agentDir, home: this.home, sim: { tokensPerSecond: options.simTokensPerSecond, contextWindow: options.simContextWindow } }),
			options.testProviders,
		);
		this.accounts = new Accounts(this.models);
		this.plugins = options.plugins ?? [];
		this.#report = options.report ?? ((error) => console.error("[ampi node]", error));
		this.#wrapStorage = options.wrapStorage;
		this.#stopWaitMs = options.stopWaitMs ?? 2000;
		this.#setTimer =
			options.setTimer ??
			((callback, delayMs) => {
				const timer = setTimeout(() => {
					this.#reopenTimers.delete(timer);
					callback();
				}, delayMs);
				this.#reopenTimers.add(timer);
			});
		this.registry = createRegistry();
		const codingTools = this.#scoped(piCodingTools({ images: photonImages(), report: (error) => this.#report(error) }));
		const core = this.#scoped(ampiCore(this.piConfig));
		const codemode = this.#scoped(createCodemodeExtension({ sandbox: new CodemodeSandbox() }));
		this.registry.install(codingTools);
		this.registry.install(core);
		this.registry.install(codemode);
		this.#piTools = [...(codingTools.tools ?? []), ...(codemode.tools ?? [])].filter((tool) => PI_TOOLS.includes(tool.name));
		const guard = this.#scoped(nodeGuard(async (storeId, conversationId) => {
			const store = this.stores.get(storeId);
			const chain = store ? await this.#ownerChain(store, conversationId) : [`${storeId}.${conversationId}`];
			const state = this.#lifecycleBlock(chain)?.state;
			return state === "archived" ? "stopped" : state;
		}));
		this.registry.install(guard);
		const pluginExtensions = this.plugins.flatMap((plugin) => plugin.extensions).map((extension) => this.#scoped(extension));
		for (const extension of pluginExtensions) this.registry.install(extension);
		const merged: HarnessSettings = {};
		for (const plugin of this.plugins)
			Object.assign(merged, (typeof plugin.settings === "function" ? plugin.settings(this.models) : plugin.settings) ?? {});
		const optIn = new Set(this.plugins.flatMap((plugin) => (plugin.optIn ?? []).map((extension) => extension.name)));
		// The core renders first, as Pi renders its own sections before extension sections.
		const defaults = [codingTools, core, codemode, guard, ...pluginExtensions].filter((e) => !optIn.has(e.name));
		// A task cut off 5 times without progress is parked until /retry (pi-durable's default, set here on purpose).
		this.settings = { toolExecution: "parallel", retry: { maxRetries: 3 }, restartLimit: 5, ...merged, extensions: defaults };
		this.threads = replicatedState<NodeThreadsState>({ threads: {}, backend: "durable" });
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
				this.#recover(name, `storage unavailable: ${(error as Error).message}`);
			}
		}
	}

	async #open(id: string, context: Context): Promise<Store> {
		if (this.#closing) throw new NodeError("closed", "The node is closing");
		const opening = this.#opening.get(id);
		if (opening) return opening;
		const existing = this.stores.get(id);
		if (existing) return existing;
		const store = new Store(id, join(this.home, "threads", id));
		const run = this.#initialize(store, context).catch(async (error) => {
			store.closed = true;
			store.detach();
			if (this.stores.get(id) === store) this.stores.delete(id);
			if (store.harness) await store.harness.close(BACKGROUND_CONTEXT).catch(() => {});
			throw error;
		}).finally(() => this.#opening.delete(id));
		this.#opening.set(id, run);
		return run;
	}

	async #initialize(store: Store, context: Context): Promise<Store> {
		const { id, dir } = store;
		let ready = false;
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		// pi-durable migrates a store forward on open and has no way back: keep a copy first (store-file.ts).
		const reason = this.#backedUp.has(id) ? undefined : backupReason(dir);
		if (reason) {
			try {
				await backupStore(this.home, id, reason);
			} catch (error) {
				throw new Error(`backup before migration failed: ${(error as Error).message}`);
			}
			this.#backedUp.add(id);
		}
		const sqlite = await openStoreStorage(join(dir, "harness.sqlite"));
		let storage: Storage;
		try {
			storage = this.#wrapStorage ? this.#wrapStorage(id, sqlite) : sqlite;
		} catch (error) {
			await sqlite.close(BACKGROUND_CONTEXT);
			throw error;
		}
		store.harness = await Harness.open(
			storage,
			{
				// Cache Goblin places the cache marks of each request with its conversation's TTL (plugin-wiring.md).
				models: this.#gatedModels(store, cacheGoblinModels(this.models, (sessionId) => this.#cacheTtl(store, sessionId))),
				registry: this.registry,
				settings: this.settings,
				env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? homedir() }),
				conversationCreated: async (tx, record) => {
					// The placement commits with the conversation, so no conversation exists without one.
					const meta = await tx.doc(MetaDoc);
					const from = record.owner?.conversationId ?? record.parent?.conversationId;
					const source = from === undefined ? undefined : meta.convs[String(from)];
					let place = from === undefined ? this.#placing.get(id) : undefined;
					if (source?.tab && source.order) {
						const used = [...Object.values(meta.convs).filter((c) => c.tab?.id === source.tab!.id).map((c) => c.order!), ...this.#ordersIn(source.tab.id)];
						place = { tab: { id: source.tab.id, label: source.tab.label }, order: orderAfter(source.order, used) };
					}
					const createdAt = Date.now();
					meta.convs[String(record.id)] = {
						kind: record.owner ? "subagent" : record.parent ? "fork" : "thread",
						createdAt,
						...(place ? { tab: place.tab, order: place.order } : {}),
					};
					// Reserve the order now: the next placement in this tab may come before this thread's first refresh.
					this.#placed.delete(`${id}.*`);
					if (place) this.#placed.set(store.threadKey(record.id), { ...place, createdAt, closed: false });
				},
				onReport: (error, info) => {
					this.#report(error);
					// A parked, faulted, or outdated task changes no conversation document: refresh its row here.
					const task = "task" in info ? info.task : undefined;
					if (task && this.stores.get(id) === store) this.#schedule(store, String(task.conversationId));
				},
			},
			context,
		);
		writeStoreFile(dir);
		this.stores.set(id, store);
		const placeholders = [...this.#placeholders].filter((key) => parseThreadKey(key).storeId === id);
		if (placeholders.length > 0)
			this.threads.change(context, (draft) => {
				for (const key of placeholders) {
					this.#placeholders.delete(key);
					delete draft.threads[key];
				}
			});
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
			if (ready && !this.#closing && end.reason === "failed") {
				const message = `storage unavailable: ${String((end as { error?: unknown }).error)}`;
				this.#report(new Error(`Thread storage ${id} failed (${message}); reopening`));
				this.stores.delete(id);
				this.#recover(id, message);
			}
		});
		const known = await store.harness.snapshot(MetaDoc, context);
		if (known?.store && known.store !== id) throw new NodeError("store_identity", `Store identity ${known.store} does not match ${id}`);
		if (known?.store !== id)
			await store.harness.commit(async (tx) => {
				(await tx.doc(MetaDoc)).store = id;
			}, context);
		for (const plugin of this.plugins) await plugin.attach?.(store, this);
		const meta = await store.harness.snapshot(MetaDoc, context);
		if (meta?.root !== undefined) {
			store.root = await store.conversation(meta.root, context);
		}
		for (const [conversationId, conv] of Object.entries(meta?.convs ?? {})) {
			if (conv.closed && !(await this.#internal(store, conversationId))) this.#closedKeys.add(store.threadKey(conversationId));
			if (conv.archived) this.#archivedKeys.add(store.threadKey(conversationId));
		}
		// Phase 1 of the stop fence: mark every stored stop before the first call that starts the scheduler.
		const stops = await this.#storedStops(store, meta);
		const marked: Marked[] = [];
		for (const { intent } of stops) marked.push(await this.#mark(store, intent, context));
		store.harness.resume();
		this.#recovered.add(store);
		// Phase 2: settle and confirm. Failures are reported and stay stored, so the next open marks them again.
		stops.forEach(({ intent, plugin }, i) => void this.#settle(store, intent, marked[i]!, plugin));
		if (meta) for (const conversationId of Object.keys(meta.convs)) this.#schedule(store, conversationId, 0);
		this.#failed.delete(id);
		ready = true;
		return store;
	}

	/** Every stored stop of a store: the node's Close intents, then each plugin's. */
	async #storedStops(store: Store, meta: MetaState | undefined): Promise<{ intent: StopIntent; plugin?: NodePlugin }[]> {
		const stops: { intent: StopIntent; plugin?: NodePlugin }[] = [];
		const closed: string[] = [];
		for (const [id, conv] of Object.entries(meta?.convs ?? {}))
			if (conv.closed && !(await this.#internal(store, id))) closed.push(id);
		closed.sort((a, b) => Number(a) - Number(b));
		for (const id of closed) stops.push({ intent: { id: `close:${id}`, conversations: [id] } });
		// An owned thread, such as a Team Worker, stops through its owner's stops; only an ownerless archive replays its own.
		const archived: string[] = [];
		for (const [id, conv] of Object.entries(meta?.convs ?? {}).sort(([a], [b]) => Number(a) - Number(b)))
			if (conv.archived && conv.kind !== "worker" && (await this.#ownerChain(store, id)).length === 1) archived.push(id);
		for (const id of archived) stops.push({ intent: { id: `archive:${id}`, conversations: [id] } });
		const esc = await store.harness.snapshot(EscDoc, BACKGROUND_CONTEXT);
		for (const intent of Object.values(esc?.intents ?? {})) stops.push({ intent, plugin: this.#escStops });
		// A kill can land after the node's Close commit but before a plugin records its stop.
		// Replay in conversation and registration order before any scheduler-starting call.
		for (const plugin of this.plugins) {
			const intents = new Map<string, StopIntent>();
			for (const id of [...closed, ...archived])
				for (const intent of (await plugin.closing?.(store, id)) ?? []) intents.set(intent.id, intent);
			for (const intent of (await plugin.stops?.(store)) ?? []) intents.set(intent.id, intent);
			for (const intent of intents.values()) stops.push({ intent, plugin });
		}
		return stops;
	}

	async #mark(store: Store, intent: StopIntent, context: Context): Promise<Marked> {
		this.#fence(store, intent);
		await this.#abortEffects(store);
		const marked = await markStops(store.harness, [intent], context);
		recordStop({ kind: "mark", store: store.id, intent: intent.id, tasks: [...marked.tasks] });
		return marked;
	}

	async #settle(store: Store, intent: StopIntent, marked: Marked, plugin?: NodePlugin): Promise<StopOutcome> {
		let outcome: StopOutcome;
		await stopLatch();
		try {
			outcome = await settleStops(store.harness, marked, BACKGROUND_CONTEXT);
		} catch (error) {
			outcome = { status: "failed", tasks: {}, error: (error as Error).message };
		}
		if (outcome.status === "failed" && !store.closed) this.#report(new Error(`Stop ${intent.id} in ${store.id} did not settle: ${outcome.error}`));
		try {
			await plugin?.confirmStop?.(store, intent.id, outcome);
		} catch (error) {
			// An unconfirmed stop stays stored: keep the fence, and the next open marks it again.
			this.#report(error);
			return { status: "failed", tasks: outcome.tasks, error: `confirmStop failed: ${(error as Error).message}` };
		}
		// A plugin intent releases its hold only after the plugin stored its receipt; the fence lifts with the last hold.
		// The node's own Archive and Close holds stay until Unarchive.
		// A reaction skipped while fenced runs on the refresh after the lift, for the thread and each one it owns.
		if (outcome.status === "settled" && plugin) {
			const lifted = this.#unfence(store, intent.id, intent.conversations ?? []);
			for (const id of new Set([...(intent.conversations ?? []), ...store.owners.keys()]))
				if (this.#knownChain(store, id).some((key) => lifted.has(key))) this.#schedule(store, id, 0);
		}
		this.#wakeHeld();
		recordStop({ kind: "settled", store: store.id, intent: intent.id, status: outcome.status });
		return outcome;
	}

	/**
	 * Runs stops whose intents the caller has already stored, as open does: marks every intent before it settles
	 * any, then settles and confirms each. One outcome per intent, in order. A plugin that stops work at run time
	 * uses this, so a restart and a live stop take the same path, and a slow abort cannot let other stopped work
	 * start a model call or a tool.
	 */
	async stop(store: Store, intents: readonly StopIntent[], plugin?: NodePlugin): Promise<StopOutcome[]> {
		for (const intent of intents) this.#fence(store, intent);
		const marked: Marked[] = [];
		for (const intent of intents) marked.push(await this.#mark(store, intent, BACKGROUND_CONTEXT));
		// The node retains settlement and confirmation after the caller's bounded wait ends.
		// A later retry reads the same stored intents; a restart reconciles them before resume.
		return Promise.all(intents.map(async (intent, i) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const settling = this.#settle(store, intent, marked[i]!, plugin);
			try {
				return await Promise.race([
					settling,
					new Promise<StopOutcome>((resolve) => {
						timer = setTimeout(() => resolve({ status: "failed", tasks: {}, error: "Stop is recorded; settlement is still pending." }), 1000);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		}));
	}

	/** Orders already used in a tab, across stores. */
	#ordersIn(tabId: string): string[] {
		return [...this.#placed.values()].filter((row) => row.tab.id === tabId).map((row) => row.order);
	}

	/**
	 * Runs `fn` after every earlier admission or Close of this thread. Close commits its intent and marks inside the
	 * section, so an input is either admitted before the Close (and withdrawn by it) or refused as `closed`.
	 */
	#serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.#admission.get(key) ?? Promise.resolve();
		const run = previous.then(fn);
		const tail = run.catch(() => {});
		this.#admission.set(key, tail);
		void tail.then(() => {
			if (this.#admission.get(key) === tail) this.#admission.delete(key);
		});
		return run;
	}

	/**
	 * Runs a write on an open thread, serialized with Close of the thread and of every thread that owns it (a Team
	 * Worker's lead). The sections are taken owner first, so they nest without a deadlock, and an input is either
	 * admitted before an owner's Close (and aborted by it) or refused. A closed thread or owner answers `closed`, a
	 * fenced one `stopped`.
	 */
	async admit<T>(key: string, fn: (thread: { store: Store; conversation: Conversation; conversationId: string }) => Promise<T>): Promise<T> {
		const thread = await this.thread(key);
		const chain = await this.#ownerChain(thread.store, thread.conversationId);
		const body = async () => {
			const meta = await thread.store.harness.snapshot(MetaDoc, BACKGROUND_CONTEXT);
			const closed = chain.find((owner) => this.#closedKeys.has(owner) || meta?.convs[parseThreadKey(owner).conversationId]?.closed);
			if (closed === key) throw new NodeError("closed", `Thread ${key} is closed; fork it to continue.`);
			if (closed) {
				const names = await this.#ownership(thread.store, thread.conversationId);
				throw new NodeError("closed", `This ${names.thread}'s ${names.owner} is closed; it is read-only. Fork it to continue.`);
			}
			const block = this.#lifecycleBlock(chain);
			if (block?.state === "archived") throw new NodeError("archived", `Thread ${block.key} is archived. Unarchive it or send a message to continue.`);
			if (block) throw new NodeError("stopped", `Thread ${block.key} has a stop that is not confirmed yet.`);
			return fn(thread);
		};
		return chain.reduce<() => Promise<T>>((inner, owner) => () => this.#serial(owner, inner), body)();
	}

	/**
	 * Close (node-design.md, Close): store the intent, run the plugins' stops, mark the work before anything else is
	 * admitted, then settle. A restart between the intent and the abort marks it again before resume.
	 */
	async closeThread(key: string): Promise<ActionAck> {
		const { store, conversationId } = await this.thread(key);
		const summary = this.threads.value.threads[key];
		const marked = await this.#serial(key, async () => {
			const meta = await store.harness.snapshot(MetaDoc, BACKGROUND_CONTEXT);
			const conv = meta?.convs[conversationId];
			if (!conv) throw new NodeError("not_found", key);
			if (conv.kind === "worker" || summary?.team?.role === "worker")
				throw new NodeError("team_worker", "A Team Worker closes through its lead.");
			// Before the commit: once Close is stored, no plugin effect of this thread starts a request or writes.
			const opened = !this.#closedKeys.has(key);
			this.#closedKeys.add(key);
			await this.#abortEffects(store);
			if (!conv.closed)
				try {
					const attention = await this.#parkedReasons(store, conversationId, BACKGROUND_CONTEXT, true);
					await store.harness.commit(async (tx) => {
						(await tx.doc(MetaDoc)).convs[conversationId]!.closed = { at: Date.now(), by: "owner", ...(attention.length ? { attention } : {}) };
					}, BACKGROUND_CONTEXT);
				} catch (error) {
					if (opened) {
						this.#closedKeys.delete(key);
						this.#wakeHeld();
					}
					throw error;
				}
			this.#schedule(store, conversationId, 0);
			// Test-only kill point of crash-e: the intent is stored and nothing is marked yet.
			if (process.env.AMPI_FAULT === "close-intent-only") return undefined;
			const own = await this.#mark(store, { id: `close:${conversationId}`, conversations: [conversationId] }, BACKGROUND_CONTEXT);
			const plugins: { plugin: NodePlugin; intent: StopIntent; marked: Marked }[] = [];
			for (const plugin of this.plugins)
				for (const intent of (await plugin.closing?.(store, conversationId)) ?? [])
					plugins.push({ plugin, intent, marked: await this.#mark(store, intent, BACKGROUND_CONTEXT) });
			return { own, plugins };
		});
		if (!marked) return { via: "node", evidence: "closed" };
		const [outcome] = await Promise.all([
			this.#settle(store, { id: `close:${conversationId}`, conversations: [conversationId] }, marked.own),
			...marked.plugins.map(({ plugin, intent, marked }) => this.#settle(store, intent, marked, plugin)),
		]);
		if (outcome!.status === "failed") throw new NodeError("close_incomplete", `Thread ${key} is closed, but its work did not stop: ${outcome!.error}`);
		return { via: "node", evidence: "closed", submissions: marked.own.submissions };
	}

	/**
	 * Archive stops admitted work and stores the archive mark before its stop fence. It keeps history and is reversible.
	 * Archive is visibility state and never erases stop authority: Unarchive first settles every stop the Archive or a
	 * legacy Close requires, and refuses with `stop_pending` until each has its receipt. Fences of other stops, such as
	 * Esc or a Team stop, stay until their own receipts land. Memory changes only as the durable commit changes.
	 * `keepClosed` serves a submitted message: it unarchives an archived thread and leaves a legacy Close untouched.
	 */
	async archiveThread(key: string, archived = true, options: { keepClosed?: boolean } = {}): Promise<ActionAck> {
		const { store, conversationId } = await this.thread(key);
		return this.#serial(key, async () => {
			const meta = await store.harness.snapshot(MetaDoc, BACKGROUND_CONTEXT);
			const conv = meta?.convs[conversationId];
			if (!conv) throw new NodeError("not_found", key);
			const summary = this.threads.value.threads[key];
			const worker = conv.kind === "worker" || summary?.team?.role === "worker";
			// A submitted message changes nothing on an open thread, a legacy Close, or a Worker; admission then decides.
			if (!archived && (options.keepClosed && (conv.closed || worker) || (!conv.archived && !conv.closed)))
				return { via: "node", evidence: "unarchived" } as ActionAck;
			if (worker) throw new NodeError("team_worker", "The lead manages Workers.");
			const workers = summary?.team?.role === "lead"
				? Object.values(this.threads.value.threads).filter((thread) => thread.parentId === key && thread.team?.role === "worker").map((thread) => thread.id)
				: [];
			if (!archived) {
				// Settle the stops this mark stands for before the mark goes. A failure keeps the mark and every fence.
				const outcomes = await this.#settleLifecycle(store, conversationId, conv.closed ? "close" : "archive");
				const failed = outcomes.find((outcome) => outcome.status === "failed");
				if (failed?.status === "failed")
					throw new NodeError("stop_pending", `Thread ${key} still has a stop without a receipt (${failed.error}). Unarchive is refused until it settles; try again.`);
			}
			// Memory follows the commit. Archive blocks admission before its commit; a failed commit restores each key.
			const touched = archived || conv.closed ? [key, ...workers] : [];
			const prior = new Map(touched.map((id) => [id, this.#archivedKeys.has(id)]));
			if (archived) {
				for (const id of touched) this.#archivedKeys.add(id);
				await this.#abortEffects(store);
			}
			try {
				await store.harness.commit(async (tx) => {
					const meta = await tx.doc(MetaDoc);
					const current = meta.convs[conversationId];
					if (!current) throw new NodeError("not_found", key);
					current.archived = archived;
					if (!archived) delete current.closed;
					// Test-only fault: the archive metadata commit fails after memory changed.
					if (process.env.AMPI_FAULT === "archive-commit") throw new Error("disk full");
					if (archived || conv.closed)
						for (const worker of workers) {
							const id = parseThreadKey(worker).conversationId;
							if (meta.convs[id]) meta.convs[id]!.archived = true;
						}
				}, BACKGROUND_CONTEXT);
			} catch (error) {
				for (const [id, had] of prior) had ? this.#archivedKeys.add(id) : this.#archivedKeys.delete(id);
				this.#wakeHeld();
				throw error;
			}
			if (!archived) {
				for (const worker of workers) this.#archivedKeys.add(worker);
				this.#archivedKeys.delete(key);
				this.#closedKeys.delete(key);
				this.#liftLifecycleFence(store, conversationId);
			} else {
				if (process.env.AMPI_FAULT === "archive-intent-only") return { via: "node", evidence: "archived" } as ActionAck;
				const outcomes = await this.#settleLifecycle(store, conversationId, "archive");
				const failed = outcomes.find((outcome) => outcome.status === "failed");
				if (failed?.status === "failed") throw new NodeError("archive_incomplete", `Thread ${key} is archived, but its work did not stop: ${failed.error}`);
			}
			this.#schedule(store, conversationId, 0);
			this.#wakeHeld();
			return { via: "node", evidence: archived ? "archived" : "unarchived" } as ActionAck;
		});
	}

	/** Marks, then settles, the node's own stop and each plugin's closing stop for one Archive or legacy Close. */
	async #settleLifecycle(store: Store, conversationId: string, kind: "archive" | "close"): Promise<StopOutcome[]> {
		const own = { id: `${kind}:${conversationId}`, conversations: [conversationId] };
		const ownMark = await this.#mark(store, own, BACKGROUND_CONTEXT);
		const pluginStops: { plugin: NodePlugin; intent: StopIntent; marked: Marked }[] = [];
		for (const plugin of this.plugins)
			for (const intent of (await plugin.closing?.(store, conversationId)) ?? [])
				pluginStops.push({ plugin, intent, marked: await this.#mark(store, intent, BACKGROUND_CONTEXT) });
		return Promise.all([this.#settle(store, own, ownMark), ...pluginStops.map(({ plugin, intent, marked }) => this.#settle(store, intent, marked, plugin))]);
	}

	/** Drops the Archive and Close holds of one thread; the fence stays while a stop of another owner covers it. */
	#liftLifecycleFence(store: Store, conversationId: string): void {
		this.#unfence(store, `archive:${conversationId}`, [conversationId]);
		this.#unfence(store, `close:${conversationId}`, [conversationId]);
	}

	/** Adds the hold of `intent` on each conversation it covers. */
	#fence(store: Store, intent: StopIntent): void {
		for (const id of intent.conversations ?? []) {
			const key = store.threadKey(id);
			const holds = this.#fenced.get(key) ?? new Set<string>();
			holds.add(intent.id);
			this.#fenced.set(key, holds);
		}
	}

	/** Removes the hold of intent `intentId`; returns the keys whose fence lifted because no hold remains. */
	#unfence(store: Store, intentId: string, conversations: readonly string[]): Set<string> {
		const lifted = new Set<string>();
		for (const id of conversations) {
			const key = store.threadKey(id);
			const holds = this.#fenced.get(key);
			if (!holds?.delete(intentId) || holds.size > 0) continue;
			this.#fenced.delete(key);
			lifted.add(key);
		}
		return lifted;
	}

	/**
	 * Esc (node-design.md, HC Control meaning): stop the thread's run, withdraw its queued inputs, as Pi's editor takes
	 * them back, and cancel each live compaction (manual, threshold or overflow), as Pi's abort cancels a compaction.
	 * Team Workers and Rarebit jobs survive. It runs on the stop fence: store one intent with every captured target,
	 * mark them all, then wait once, bounded, for settlement; a restart marks the stored intent again before resume.
	 * Each queued input is reported by identity: `returned` with its text when it left the queue undelivered,
	 * `delivered` when the run took it first. Each compaction is reported with its task's outcome, `unknown` when the
	 * wait ended first; a compaction that had already finished reports where its summary is. `evidence: "stopping"`
	 * when some target was not confirmed terminal within the wait; the node keeps settling it.
	 */
	async abortThread(key: string): Promise<ActionAck> {
		const { store, conversationId } = await this.thread(key);
		const context = BACKGROUND_CONTEXT;
		const id = Number(conversationId) as ConversationId;
		const [inspection, inbox, live] = await Promise.all([
			store.harness.inspect(context),
			store.harness.snapshot(InboxDoc, id, context),
			store.harness.snapshot(LiveDoc, id, context),
		]);
		const mine = (s: { conversationId: ConversationId }) => String(s.conversationId) === conversationId;
		const queued = inspection.submissions.filter((s) => s.status === "queued" && s.type === "input" && mine(s));
		const compactions = live?.compactions ?? [];
		if (!live?.run && queued.length === 0 && compactions.length === 0) return { via: "node", evidence: "idle" };
		// A finished compaction's summary that waits for the turn boundary. Esc does not withdraw it; the ack says so.
		const finished = inspection.submissions.filter((s) => s.type === "write" && s.status === "queued" && mine(s) && s.requestId?.startsWith("compaction:"));
		const targets = [...(live?.run ? [String(live.run.taskId)] : []), ...compactions.map((c) => String(c.taskId))];
		const intent: StopIntent = { id: `esc:${conversationId}:${randomBytes(6).toString("hex")}`, tasks: targets, submissions: queued.map((s) => String(s.id)), spareBackground: true };
		await store.harness.commit(async (tx) => {
			(await tx.doc(EscDoc)).intents[intent.id] = intent;
		}, context);
		if (process.env.AMPI_FAULT === "esc-first-mark") {
			// Test-only kill point: the intent is stored and only its first target is marked.
			await markStops(store.harness, [{ ...intent, tasks: targets.slice(0, 1), submissions: [] }], context);
			return { via: "node", evidence: "stopping" };
		}
		const marked = await this.#mark(store, intent, context);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const settled = await Promise.race([
			this.#settle(store, intent, marked, this.#escStops).then((outcome) => outcome.status === "settled"),
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), this.#stopWaitMs);
			}),
		]).finally(() => clearTimeout(timer));
		const after = await store.harness.inspect(context);
		const running = new Set(after.tasks.filter(({ record }) => record.state.status !== "terminal").map(({ record }) => String(record.id)));
		const reported: ControlCompaction[] = [];
		for (const compaction of compactions) reported.push(await this.#compactionOutcome(store, String(compaction.taskId), compaction.reason, running));
		for (const write of finished) {
			const taskId = write.requestId!.slice("compaction:".length);
			if (!targets.includes(taskId)) reported.push({ ...(await this.#compactionOutcome(store, taskId, "", running)), summary: "pending" });
		}
		const at = Date.now();
		const submissions: ControlSubmission[] = [];
		for (const record of queued) {
			const item = inbox?.items.find((candidate) => candidate.id === record.id);
			const deliverAs = item?.mode === "steer" ? "steer" : "followUp";
			const now = await (await store.harness.submission(record.id, context))?.status(context);
			if (now && (now.status === "placed" || now.status === "done")) {
				submissions.push({ submission: String(record.id), deliverAs, state: "delivered", at, entryId: String(now.entry) });
				continue;
			}
			submissions.push({ submission: String(record.id), deliverAs, state: "returned", at, ...returnedInput(item) });
		}
		const returned = submissions.filter((s) => s.state === "returned");
		if (returned.length)
			await store.harness.commit(async (tx) => {
				const doc = await tx.doc(ReturnedDoc, id);
				doc.items.push(...returned.map((s) => ({ id: s.submission, mode: s.deliverAs, content: s.text ?? s.origin?.summary ?? "", at: s.at, ...(s.origin ? { origin: s.origin } : {}) })));
				doc.items.splice(0, Math.max(0, doc.items.length - 20));
			}, context);
		if (returned.length) await this.#publishReturned(key);
		const confirmed = settled || targets.every((task) => !running.has(task));
		return { via: "node", evidence: confirmed ? "aborted" : "stopping", ...(submissions.length ? { submissions } : {}), ...(reported.length ? { compactions: reported } : {}) };
	}

	/** One compaction's outcome for an Esc ack: `unknown` while its task runs; a completed one says where its summary is. */
	async #compactionOutcome(store: Store, taskId: string, reason: string, running: Set<string>): Promise<ControlCompaction> {
		if (running.has(taskId)) return { taskId, reason, outcome: "unknown" };
		const record = await store.harness.waitForTask(Number(taskId) as TaskId, BACKGROUND_CONTEXT);
		const named = reason || String((record.input as { reason?: string } | undefined)?.reason ?? "");
		const outcome = record.state.outcome;
		if (outcome.status !== "completed") return { taskId, reason: named, outcome: outcome.status };
		const result = (outcome as { result?: { submissionId?: SubmissionId; entryId?: unknown } }).result ?? {};
		if (result.entryId !== undefined) return { taskId, reason: named, outcome: "completed", summary: "placed" };
		if (result.submissionId === undefined) return { taskId, reason: named, outcome: "completed", summary: "none" };
		const write = await (await store.harness.submission(result.submissionId, BACKGROUND_CONTEXT))?.status(BACKGROUND_CONTEXT);
		const summary = write?.status === "done" ? "placed" : write?.status === "queued" ? "pending" : "stale";
		return { taskId, reason: named, outcome: "completed", summary };
	}

	#schedule(store: Store, conversationId: string, delay = 120): void {
		if (this.#closing || store.closed) return;
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
	#unavailable(storeId: string, message: string, attempts: number, gaveUp = false): void {
		this.#failed.set(storeId, { error: message, attempts, gaveUp });
		const retry = gaveUp ? ` (gave up after ${attempts} reopen attempts; /retry tries again)` : "";
		const shown = `${message.slice(0, 300 - retry.length)}${retry}`;
		this.threads.change(BACKGROUND_CONTEXT, (draft) => {
			let shownRows = 0;
			for (const [key, summary] of Object.entries(draft.threads))
				if (parseThreadKey(key).storeId === storeId) {
					summary.lastError = shown;
					summary.activity = "idle";
					shownRows++;
				}
			if (shownRows > 0) return;
			// A store that fails on a cold start has no rows yet: show its threads from a read-only scan, so the
			// failure is visible where the owner looks, not only in node.health.
			const now = Date.now();
			const ids = rootConversations(join(this.home, "threads", storeId));
			for (const id of ids.length > 0 ? ids : [0])
			{
				this.#placeholders.add(`${storeId}.${id}`);
				draft.threads[`${storeId}.${id}`] = {
					id: `${storeId}.${id}`,
					title: `Unavailable store ${storeId}`,
					cwd: "",
					createdAt: now,
					updatedAt: now,
					kind: "thread",
					activity: "idle",
					queued: 0,
					costUsd: 0,
					lastError: shown,
					attention: [{ source: "node", reason: shown }],
				};
			}
		});
	}

	/** Every failure uses the same budget, including a failure after open succeeds and work resumes. */
	#recover(id: string, message: string): void {
		const attempts = this.#recoveryAttempts.get(id) ?? 0;
		const gaveUp = attempts >= REOPEN_ATTEMPTS;
		this.#unavailable(id, message, attempts, gaveUp);
		if (!gaveUp && !this.#closing) this.#reopen(id, attempts + 1);
	}

	/** Reopens with backoff. The budget counts attempts before open and never resets on success. */
	#reopen(id: string, attempt: number): void {
		const delay = Math.min(60_000, 1000 * 2 ** (attempt - 1));
		this.#setTimer(() => {
			if (this.#closing) return;
			this.#recoveryAttempts.set(id, attempt);
			this.#open(id, BACKGROUND_CONTEXT).then(
				(store) => this.#schedule(store, "*", 0),
				(error) => {
					this.#report(error);
					this.#recover(id, `storage unavailable: ${(error as Error).message}`);
				},
			);
		}, delay);
	}

	/**
	 * The Cache Goblin TTL of the conversation whose `ProviderDoc.sessionId` is `sessionId`. No key, or no `/cache`
	 * choice, means `5m`. An unknown key is an error: a request never borrows another thread's TTL.
	 */
	async #cacheTtl(store: Store, sessionId: string | undefined): Promise<CacheTtl> {
		if (!sessionId) return "5m";
		const conversationId = await this.#sessionConversation(store, sessionId);
		if (conversationId === undefined) throw new Error(`Cache Goblin: no conversation in ${store.id} has provider session ${sessionId}`);
		return (await store.harness.snapshot(CacheTtlDoc, conversationId, BACKGROUND_CONTEXT))?.ttl ?? "5m";
	}

	/** The conversation whose `ProviderDoc.sessionId` is `sessionId`. */
	async #sessionConversation(store: Store, sessionId: string): Promise<ConversationId | undefined> {
		if (!store.providerKeys.has(sessionId)) {
			const meta = await store.harness.snapshot(MetaDoc, BACKGROUND_CONTEXT);
			for (const id of Object.keys(meta?.convs ?? {})) {
				const provider = await store.harness.snapshot(ProviderDoc, Number(id) as ConversationId, BACKGROUND_CONTEXT);
				if (provider) store.providerKeys.set(provider.sessionId, Number(id) as ConversationId);
			}
		}
		return store.providerKeys.get(sessionId);
	}

	/**
	 * The dispatch gate of the harness's inference (generation streams and compaction summaries, native and HC) and of
	 * plugin effects (Effect.models). Close aborts a task only after its commit, so a task can reach dispatch between
	 * the two. A request waits while #lifecycleBlock blocks its conversation: the effect's, else the one its `sessionId`
	 * names, else the one of the tool execution in progress (#toolScope). A request with none of these is not a thread's;
	 * only the sign-in probe sends one. On a closed thread it ends when its signal
	 * aborts: a completion rejects with the abort reason and a stream ends `aborted`, as a provider ends it. It starts
	 * if the thread opens again (a failed Close commit or a lifted fence), so an open run never commits an aborted
	 * answer. A request already sent is not withdrawn.
	 */
	#gatedModels<T extends Models>(store: Store, inner: T, conversation?: string): T {
		// The effect's conversation; else the one the request's `sessionId` names; else the tool execution's.
		const bound = (options?: { sessionId?: string }) => conversation !== undefined || !!options?.sessionId || this.#toolScope.getStore() !== undefined;
		const gate = async (options?: { sessionId?: string; signal?: AbortSignal }) => {
			const scope = this.#toolScope.getStore();
			const conversationId = conversation ?? (options?.sessionId ? await this.#sessionConversation(store, options.sessionId) : scope);
			if (conversationId !== undefined) await this.#dispatchGate(store, String(conversationId), options?.signal);
		};
		const stream = (model: Model<Api>, open: () => AssistantMessageEventStream, options?: StreamOptions): AssistantMessageEventStream => {
			if (!bound(options)) return open();
			const outer = createAssistantMessageEventStream();
			void (async () => {
				try {
					await gate(options);
				} catch (error) {
					const aborted = failedMessage(model, "aborted", error);
					outer.push({ type: "error", reason: "aborted", error: aborted });
					outer.end(aborted);
					return;
				}
				try {
					const events = open();
					for await (const event of events) outer.push(event);
					outer.end(await events.result());
				} catch (error) {
					// A provider ends its stream with an error event; a throw here would leave the outer stream open.
					const reason = options?.signal?.aborted ? "aborted" : "error";
					const failed = failedMessage(model, reason, error);
					outer.push({ type: "error", reason, error: failed });
					outer.end(failed);
				}
			})();
			return outer;
		};
		const gated: Pick<Models, "stream" | "streamSimple" | "complete" | "completeSimple" | "classify" | "generateImages"> = {
			classify: async (model, context, options) => {
				await gate(options);
				return inner.classify(model, context, options);
			},
			generateImages: async (model, context, options) => {
				await gate(options);
				return inner.generateImages(model, context, options);
			},
			stream: (model, context, options) => stream(model, () => inner.stream(model, context, options), options),
			streamSimple: (model, context, options) => stream(model, () => inner.streamSimple(model, context, options), options),
			complete: async (model, context, options) => {
				await gate(options);
				return inner.complete(model, context, options);
			},
			completeSimple: async (model, context, options) => {
				await gate(options);
				return inner.completeSimple(model, context, options);
			},
		};
		return new Proxy(inner, {
			get(target, key) {
				if (Object.hasOwn(gated, key)) return gated[key as keyof typeof gated];
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}

	/**
	 * The node's one lifecycle authority: the first thread of `chain` (a conversation and the conversations that own
	 * it) that is closing, closed or fenced. The dispatch gate, effect admission, start and write, and the effect
	 * sweeps of Close and of a fence all ask it.
	 */
	#lifecycleBlock(chain: readonly string[]): { key: string; state: "closed" | "archived" | "stopped" } | undefined {
		for (const key of chain) {
			if (this.#closedKeys.has(key)) return { key, state: "closed" };
			if (this.#archivedKeys.has(key)) return { key, state: "archived" };
			if (this.#fenced.has(key)) return { key, state: "stopped" };
		}
		return undefined;
	}

	/** The owner chain as far as `store.owners` knows it now, for a synchronous check; #ownerChain completes it. */
	#knownChain(store: Store, conversationId: string): string[] {
		const chain: string[] = [];
		for (let id: string | undefined = conversationId; id !== undefined && !chain.includes(store.threadKey(id)); id = store.owners.get(id))
			chain.push(store.threadKey(id));
		return chain;
	}

	/** Recheck lifecycle at the tool body, then bind its conversation for model dispatch. */
	#scoped(extension: Extension): Extension {
		if (!extension.tools?.length) return extension;
		return {
			...extension,
			tools: extension.tools.map((tool) => ({ ...tool, execute: async (args, api, context) => {
				const meta = await api.snapshot(MetaDoc, context);
				const store = meta?.store === undefined ? undefined : this.stores.get(meta.store);
				const conversationId = String(api.conversationId);
				const chain = store ? await this.#ownerChain(store, conversationId) : meta?.store === undefined ? [] : [`${meta.store}.${conversationId}`];
				return this.#toolScope.run(conversationId, () => {
					// No await between this shared predicate and the original body.
					const state = this.#lifecycleBlock(chain)?.state;
					if (state !== undefined) return {
						output: [], isError: true,
						diagnostics: [{ severity: "error", code: "blocked", message: `Tool call blocked: ${toolBlockReason(state === "archived" ? "stopped" : state)}` }],
					};
					return tool.execute(args, api, context);
				});
			} })),
		};
	}

	/** The thread keys of `conversationId` and the conversations that own it, nearest first. */
	async #ownerChain(store: Store, conversationId: string): Promise<string[]> {
		const chain: string[] = [];
		for (let id: string | undefined = conversationId; id !== undefined && !chain.includes(store.threadKey(id)); ) {
			chain.push(store.threadKey(id));
			if (!store.owners.has(id)) {
				const record = await store.harness.commit((tx) => tx.conversation(Number(id) as ConversationId), BACKGROUND_CONTEXT);
				const owner = record?.owner?.conversationId;
				store.owners.set(id, owner === undefined ? undefined : String(owner));
			}
			id = store.owners.get(id);
		}
		return chain;
	}

	async #dispatchGate(store: Store, conversationId: string, signal: AbortSignal | undefined): Promise<void> {
		const chain = await this.#ownerChain(store, conversationId);
		for (let block = this.#lifecycleBlock(chain); block !== undefined; block = this.#lifecycleBlock(chain)) {
			if (!signal) throw new EffectAborted(`Thread ${block.key} is ${block.state}`);
			signal.throwIfAborted();
			await new Promise<void>((resolve) => {
				const wake = () => {
					this.#held.delete(wake);
					signal.removeEventListener("abort", wake);
					resolve();
				};
				this.#held.add(wake);
				signal.addEventListener("abort", wake, { once: true });
			});
		}
	}

	#wakeHeld(): void {
		for (const wake of [...this.#held]) wake();
	}

	/**
	 * `node.backup`: consistent copies through SQLite's backup API, safe while the store is open. One store, or every
	 * store under `threads/`, failed ones included.
	 */
	async backup(storeId?: string): Promise<{ store: string; path: string }[]> {
		const dir = join(this.home, "threads");
		const ids = storeId !== undefined ? [storeId] : readdirSync(dir).filter((name) => existsSync(join(dir, name, "harness.sqlite"))).sort();
		if (storeId !== undefined && !existsSync(join(dir, storeId, "harness.sqlite"))) throw new NodeError("not_found", `No thread storage ${storeId}`);
		const done: { store: string; path: string }[] = [];
		for (const id of ids) done.push({ store: id, path: await backupStore(this.home, id, "manual") });
		return done;
	}

	/** Whether this store failed and is not open now. */
	unavailable(storeId: string): { error: string; attempts: number; gaveUp: boolean } | undefined {
		return this.#failed.get(storeId);
	}

	/**
	 * `store.reopen` and `/retry` on a store the backoff gave up on: one attempt now, no timer. A store still in its
	 * backoff answers `reopening`; an open store answers `open`.
	 */
	async reopenStore(storeId: string): Promise<{ store: string; state: "open" | "reopening" | "unavailable"; error?: string }> {
		const open = this.stores.get(storeId);
		if (open && !open.closed) return { store: storeId, state: "open" };
		const failed = this.#failed.get(storeId);
		if (!failed) throw new NodeError("not_found", `No thread storage ${storeId}`);
		if (!failed.gaveUp) return { store: storeId, state: "reopening", error: failed.error };
		try {
			const store = await this.#open(storeId, BACKGROUND_CONTEXT);
			this.#schedule(store, "*", 0);
			return { store: storeId, state: "open" };
		} catch (error) {
			this.#report(error);
			const message = `storage unavailable: ${(error as Error).message}`;
			this.#unavailable(storeId, message, failed.attempts + 1, true);
			return { store: storeId, state: "unavailable", error: message };
		}
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

	/** The plugins' names for an owned conversation and its owner, from committed state only. */
	async #ownership(store: Store, conversationId: string): Promise<OwnershipNames> {
		for (const plugin of this.plugins) {
			const names = await plugin.ownership?.(store, conversationId);
			if (names) return names;
		}
		return { thread: "thread", owner: "owner" };
	}

	/** The Close of the nearest closed owner in `chain`, by the owner's name (`owner thread`, or a Team Worker's `lead`). */
	async #ownerClosed(store: Store, meta: MetaState, chain: readonly string[]): Promise<{ at: number; by: string } | undefined> {
		for (const owner of chain.slice(1)) {
			const closed = meta.convs[parseThreadKey(owner).conversationId]?.closed;
			if (!closed) continue;
			const names = await this.#ownership(store, parseThreadKey(chain[0]!).conversationId);
			return { at: closed.at, by: names.owner === "owner" ? "owner thread" : names.owner };
		}
		return undefined;
	}

	/** The reasons of this conversation's blocked tasks, as its summary shows them. */
	async #parkedReasons(store: Store, conversationId: string, context: Context, closed: boolean): Promise<string[]> {
		const inspection = await store.harness.inspect(context);
		return this.#blockedReasons(
			inspection.tasks.filter(({ record, state }) => state.kind === "blocked" && String(record.conversationId) === conversationId),
			closed,
		);
	}

	#blockedReasons(blocked: Awaited<ReturnType<Store["harness"]["inspect"]>>["tasks"], closed: boolean): string[] {
		return blocked.map(({ record, state }) => blockedReason(record.kind, (state as { reason: string }).reason, this.settings.restartLimit ?? 5, closed));
	}

	async #internal(store: Store, conversationId: string): Promise<boolean> {
		for (const plugin of this.plugins) if (await plugin.internal?.(store, conversationId)) return true;
		return false;
	}

	async #refreshNow(store: Store, conversationId: string): Promise<void> {
		const context = BACKGROUND_CONTEXT;
		if (await this.#internal(store, conversationId)) {
			const key = store.threadKey(conversationId), placed = this.#placed.delete(key);
			if (placed || this.threads.value.threads[key]) this.threads.change(context, (draft) => {
				delete draft.threads[key];
				draft.layout = tabLayout(this.#placed);
			});
			return;
		}
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
		if (convMeta.archived || convMeta.closed) summary.archived = true;
		// A durable thread is live while it is open: the node runs it whether or not a client watches. Close ends it.
		summary.control = true;
		// A Close of an owner (a Worker's lead) closes this thread too: it projects as a closed thread of its own.
		const closed = convMeta.closed ?? await this.#ownerClosed(store, meta!, await this.#ownerChain(store, conversationId));
		summary.live = !closed;
		if (closed) summary.closed = { at: closed.at, by: closed.by };
		else if (convMeta.tab)
			summary.location = { workspace: convMeta.tab.id, workspaceLabel: convMeta.tab.label, tab: convMeta.tab.id, tabLabel: convMeta.tab.label };
		if (convMeta.tab && convMeta.order)
			this.#placed.set(summary.id, { tab: convMeta.tab, order: convMeta.order, createdAt: convMeta.createdAt, closed: !!closed });
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
				const text = excerpt(contentText(message?.content), 160);
				if (text) summary.preview = text;
			}
		}
		const lastAssistant = recent.find((entry) => entry.kind === "pi.assistant");
		// biome-ignore lint: loosely typed pi-ai message
		const assistantMessage = lastAssistant?.model?.[0] as any;
		if (assistantMessage?.stopReason === "error" && summary.activity === "idle")
			summary.lastError = excerpt(String(assistantMessage.errorMessage ?? "error"), 300);
		// A blocked task never runs again by itself: a parked run looks idle, so it must say why (idle never means done).
		// Close removes the parked tasks, so a closed thread shows the reasons its Close stored, without an action hint.
		const inspection = await store.harness.inspect(context);
		const blocked = inspection.tasks.filter(({ record, state }) => state.kind === "blocked" && String(record.conversationId) === conversationId);
		// pi.live still holds the cut-off run, so with nothing else of the thread live, the row must not look active.
		const running = inspection.tasks.some(({ record, state }) => state.kind !== "blocked" && String(record.conversationId) === conversationId);
		if (blocked.length && !running) summary.activity = "idle";
		const parked = blocked.length ? this.#blockedReasons(blocked, !!closed) : (convMeta.closed?.attention ?? []);
		if (parked.length) summary.attention = parked.map((reason) => ({ source: "node", reason }));
		// The last response's context size, also after a compaction, as a Pi Session shows it (pi/derive-worker.ts).
		if (assistantMessage?.usage) summary.contextTokens = contextTokensOf(assistantMessage.usage);
		// As the Pi backend's derive-worker computes it: the latest response's prompt share read from cache.
		const last = assistantMessage?.usage;
		const prompt = (last?.input ?? 0) + (last?.cacheRead ?? 0) + (last?.cacheWrite ?? 0);
		if (prompt > 0) summary.cacheHit = (100 * (last.cacheRead ?? 0)) / prompt;
		if (agent?.model) {
			const model = this.models.getModel(agent.model.provider, agent.model.modelId);
			if (model?.contextWindow) summary.contextWindow = model.contextWindow;
		}
		if (!summary.title) {
			summary.title = (await this.#firstUserTitle(store, conversation)) || "New thread";
		}
		for (const plugin of this.plugins) await plugin.summarize?.(store, conversationId, summary);
		if (store.closed || this.stores.get(store.id) !== store) return;
		this.threads.change(context, (draft) => {
			draft.threads[summary.id] = summary;
			draft.layout = tabLayout(this.#placed);
		});
		await this.#sweepClosed(store, conversationId);
		if (!convMeta.archived) await this.#react(store, conversationId, summary);
	}

	/**
	 * Ends work that reached a conversation of a closed chain without `admit`: a harness-level submit, such as a Team
	 * delivery whose eligibility commit came before the lead's Close. The dispatch gate holds its model requests until
	 * this stop aborts it. One sweep per conversation runs at a time and settles outside the refresh. A refresh that
	 * comes during a sweep can see work its mark missed, so the sweep's end schedules one more refresh for it.
	 */
	async #sweepClosed(store: Store, conversationId: string): Promise<void> {
		const key = store.threadKey(conversationId);
		if (this.#sweeping.has(key)) {
			this.#sweeping.set(key, true);
			return;
		}
		// Only a committed Close: a Close whose commit fails leaves the thread and what it owns running.
		const chain = await this.#ownerChain(store, conversationId);
		const meta = await store.harness.snapshot(MetaDoc, BACKGROUND_CONTEXT);
		if (!chain.some((owner) => meta?.convs[parseThreadKey(owner).conversationId]?.closed)) return;
		const inspection = await store.harness.inspect(BACKGROUND_CONTEXT);
		if (!inspection.tasks.some(({ record }) => record.state.status !== "terminal" && String(record.conversationId) === conversationId)) return;
		const intent: StopIntent = { id: `close:${conversationId}`, conversations: [conversationId] };
		this.#sweeping.set(key, false);
		const end = () => {
			if (this.#sweeping.get(key)) this.#schedule(store, conversationId, 0);
			this.#sweeping.delete(key);
		};
		try {
			const marked = await this.#mark(store, intent, BACKGROUND_CONTEXT);
			void this.#settle(store, intent, marked).finally(end);
		} catch (error) {
			end();
			throw error;
		}
	}

	#effectRefusal(store: Store, chain: readonly string[]): string | undefined {
		if (!this.#recovered.has(store) || store.closed || this.stores.get(store.id) !== store) return "storage not ready";
		const block = this.#lifecycleBlock(chain);
		return block && (block.key === chain[0] ? block.state : `owner ${block.key} ${block.state}`);
	}

	/** Aborts every live effect of `store` that #lifecycleBlock now blocks: a closing or fenced thread and all it owns. */
	async #abortEffects(store: Store): Promise<void> {
		for (const [effectKey, live] of [...this.#effects]) {
			const { storeId, conversationId } = parseThreadKey(effectKey);
			if (storeId !== store.id) continue;
			const refused = this.#effectRefusal(store, await this.#ownerChain(store, conversationId));
			if (refused) for (const controller of live) controller.abort(new EffectAborted(`Thread ${effectKey}: ${refused}`));
		}
	}

	/**
	 * Admits a plugin job that outlives its reaction or request (NodePlugin.react). #lifecycleBlock of the thread and
	 * its owners decides admission, each start and each write. The check and the registration are synchronous, so a
	 * job admitted before a Close of the thread or an owner is aborted by it. A later job is refused at admission, or
	 * at its first start or write when an owner was not known yet. `body` runs at once; the effect ends when its
	 * promise settles. A refused admission rejects with `EffectAborted`. An aborted effect that ends on an open,
	 * unfenced thread schedules one refresh, so the plugin reacts to its end.
	 */
	effect<T>(store: Store, conversationId: string, body: (effect: Effect) => Promise<T>): Promise<T> {
		const key = store.threadKey(conversationId);
		const refused = this.#effectRefusal(store, this.#knownChain(store, conversationId));
		if (refused) return Promise.reject(new EffectAborted(`Thread ${key}: ${refused}`));
		const controller = new AbortController();
		const { signal } = controller;
		let live = this.#effects.get(key);
		if (!live) this.#effects.set(key, (live = new Set()));
		live.add(controller);
		const aborted = () => (signal.aborted ? (signal.reason as EffectAborted) : undefined);
		const refusal = async () => {
			const refused = this.#effectRefusal(store, await this.#ownerChain(store, conversationId));
			return aborted() ?? (refused ? new EffectAborted(`Thread ${key}: ${refused}`) : undefined);
		};
		const effect: Effect = {
			signal,
			models: this.#gatedModels(store, this.models, conversationId),
			commit: async (change) => {
				const refused = await refusal();
				if (refused) throw refused;
				const chain = await this.#ownerChain(store, conversationId);
				return store.harness.commit(async (tx) => {
					// Read in the transaction, so a Close of the thread or an owner committed first refuses this write.
					const convs = (await tx.doc(MetaDoc)).convs;
					const closed = chain.find((owner) => convs[parseThreadKey(owner).conversationId]?.closed);
					if (closed) throw new EffectAborted(`Thread ${closed} closed`);
					if (aborted()) throw aborted();
					return change(tx);
				}, BACKGROUND_CONTEXT);
			},
			start: async (request) => {
				const refused = await refusal();
				if (refused) throw refused;
				const result = await request(signal);
				if (aborted()) throw aborted();
				return result;
			},
		};
		let run: Promise<T>;
		try {
			run = body(effect);
		} catch (error) {
			run = Promise.reject(error);
		}
		return run.finally(() => {
			live.delete(controller);
			if (live.size === 0 && this.#effects.get(key) === live) this.#effects.delete(key);
			// A job aborted by a fence can settle after the lift's refresh, which saw it as live; refresh once more.
			if (signal.aborted && !this.#effectRefusal(store, this.#knownChain(store, conversationId))) this.#schedule(store, conversationId, 0);
		});
	}

	/**
	 * The one gate of plugin reactions (NodePlugin.react). They may start model calls, compactions, and deliveries, so
	 * they run inside the thread's Close section and only after the gate reads committed state again: the store is
	 * recovered and current, #lifecycleBlock blocks neither the thread nor an owner, and `ampi.meta` marks none of
	 * them closed.
	 */
	async #react(store: Store, conversationId: string, summary: ThreadSummary): Promise<void> {
		if (!this.plugins.some((plugin) => plugin.react)) return;
		const key = store.threadKey(conversationId);
		await this.#serial(key, async () => {
			const chain = await this.#ownerChain(store, conversationId);
			if (this.#effectRefusal(store, chain)) return;
			const meta = await store.harness.snapshot(MetaDoc, BACKGROUND_CONTEXT);
			if (chain.some((owner) => meta?.convs[parseThreadKey(owner).conversationId]?.closed)) return;
			for (const plugin of this.plugins) {
				try {
					await plugin.react?.(store, conversationId, summary);
				} catch (error) {
					this.#report(error);
				}
			}
		});
	}

	/** The title excerpt of each thread's first user message; the cache never holds the message itself. */
	#firstUserTitles = new Map<string, string>();
	async #firstUserTitle(store: Store, conversation: Conversation): Promise<string | undefined> {
		const key = store.threadKey(conversation.id);
		const cached = this.#firstUserTitles.get(key);
		if (cached) return cached;
		const page = await conversation.entries({ order: "ascending" }, 50, undefined, BACKGROUND_CONTEXT);
		const first = (page.items as readonly EntryRecord[]).find((entry) => entry.kind === "pi.user");
		const found = first ? excerpt(contentText(first.model?.[0]?.content), 80) : undefined;
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
		if (await this.#internal(store, conversationId)) throw new NodeError("not_found", `No agent thread ${key}`);
		return { store, conversation: await store.conversation(conversationId), conversationId };
	}

	async createThread(args: {
		cwd?: string;
		model?: { provider: string; modelId: string };
		thinkingLevel?: string;
		title?: string;
		prompt?: string;
		requestId?: string;
		place?: Placement;
	}): Promise<ThreadCreated> {
		const cwd = args.cwd ? expandHome(args.cwd) : homedir();
		if (!existsSync(cwd)) throw new NodeError("bad_request", `Directory does not exist on ${hostname()}: ${cwd}`);
		// A request ID names the thread: a retried create (lost response, reconnect replay) opens the same storage and
		// finds its root and placement instead of making a second thread; the prompt's submission dedupes on the same ID.
		const id = args.requestId ? `r${createHash("sha256").update(args.requestId).digest("hex").slice(0, 20)}` : newId();
		const inflight = this.#creating.get(id);
		if (inflight) return inflight;
		const run = this.#createThread(id, cwd, args).finally(() => this.#creating.delete(id));
		this.#creating.set(id, run);
		return run;
	}

	#creating = new Map<string, Promise<ThreadCreated>>();

	/**
	 * Where a new root goes: a new tab, or directly after the `beside` thread in its tab. The order is reserved in
	 * the same synchronous step as it is chosen, so concurrent creates beside one thread get distinct orders.
	 */
	async #reserve(id: string, cwd: string, args: { place?: Placement; title?: string }): Promise<void> {
		const place = args.place;
		const reserve = (chosen: { tab: Tab; order: string }) => {
			this.#placing.set(id, chosen);
			this.#placed.set(`${id}.*`, { ...chosen, createdAt: Date.now(), closed: false });
		};
		if (place && "beside" in place) {
			const { store, conversationId } = await this.thread(place.beside);
			const meta = await store.harness.snapshot(MetaDoc, BACKGROUND_CONTEXT);
			const beside = meta?.convs[conversationId];
			if (!beside?.tab || !beside.order || beside.closed) throw new NodeError("bad_request", `Thread ${place.beside} is in no tab`);
			const used = [...this.#ordersIn(beside.tab.id), ...Object.values(meta!.convs).filter((c) => c.tab?.id === beside.tab!.id).map((c) => c.order!)];
			return reserve({ tab: beside.tab, order: orderAfter(beside.order, used) });
		}
		const label = (place?.label ?? args.title ?? "").trim() || basename(cwd) || cwd;
		reserve({ tab: newTab(label), order: FIRST_ORDER });
	}


	async #createThread(
		id: string,
		cwd: string,
		args: { model?: { provider: string; modelId: string }; thinkingLevel?: string; title?: string; prompt?: string; requestId?: string; place?: Placement },
	): Promise<ThreadCreated> {
		const context = BACKGROUND_CONTEXT;
		const store = await this.#open(id, context);
		const existing = await store.harness.snapshot(MetaDoc, context);
		const known = existing?.root ?? Object.entries(existing?.convs ?? {}).find(([, conv]) => conv.kind === "thread")?.[0];
		let root: Conversation;
		if (known !== undefined) root = await store.conversation(known, context);
		else {
			// Pi's settings for this directory pick the start model and thinking level, and `defaultTools` the enabled tools.
			const resources = piResources(cwd, this.piConfig);
			const start = await startModel(this.models, resources.settings);
			const model = args.model ?? { provider: start.provider, modelId: start.modelId };
			const thinkingLevel = args.thinkingLevel ?? (args.model ? undefined : start.thinkingLevel);
			const removed = this.#piTools.filter((tool) => !resources.tools.includes(tool.name));
			await this.#reserve(id, cwd, args);
			try {
				root = await store.harness.createConversation(
					{
						ownership: { kind: "ownerless" },
						agent: {
							model,
							cwd,
							...(thinkingLevel ? { thinkingLevel: thinkingLevel as never } : {}),
							...(removed.length > 0 ? { tools: { remove: removed } } : {}),
						},
					},
					context,
				);
			} finally {
				this.#placing.delete(id);
				this.#placed.delete(`${id}.*`);
			}
		}
		const meta = await store.harness.commit(async (tx) => {
			const meta = await tx.doc(MetaDoc);
			meta.root = String(root.id);
			if (args.title && meta.convs[String(root.id)]) meta.convs[String(root.id)]!.title = args.title;
			// Plain values: the transaction's drafts are unusable after the commit.
			const conv = meta.convs[String(root.id)];
			return { tab: conv?.tab ? { id: conv.tab.id, label: conv.tab.label } : undefined, closed: conv?.closed !== undefined };
		}, context);
		store.root = root;
		const threadId = store.threadKey(root.id);
		this.#schedule(store, String(root.id), 0);
		const created: ThreadCreated = { threadId, evidence: "created", ...(meta.tab ? { tab: { id: meta.tab.id, label: meta.tab.label } } : {}) };
		if (args.prompt && !meta.closed) {
			await root.submit({ type: "input", content: args.prompt, ...(args.requestId ? { requestId: args.requestId } : {}) }, context);
			created.submitted = { via: "node", evidence: "admitted" };
		}
		return created;
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

	/** Refuses an op on a queued Team input (`withdraw`, `editQueued` docs): a stale client may still offer it. */
	async #refuseTeamInput(store: Store, id: ConversationId, submissionId: string, verb: string): Promise<void> {
		const inbox = await store.harness.snapshot(InboxDoc, id, BACKGROUND_CONTEXT);
		const item = inbox?.items.find((candidate) => String(candidate.id) === submissionId);
		if (item && item.mode !== "write" && queueOrigin(item.entry as never, contentText(item.content as never)))
			throw new NodeError("bad_request", `A queued Team input cannot be ${verb}: durable-team owns its delivery`);
	}

	async listModels() {
		const [choices, preferred] = await Promise.all([listModels(this.models), defaultModel(this.models, piResources(homedir(), this.piConfig).settings)]);
		return choices.map((m) => (m.provider === preferred.provider && m.id === preferred.modelId ? { ...m, default: true as const } : m));
	}

	/**
	 * `thread.withdraw`: dismisses a returned input, or withdraws one queued input natively. Pi can take back queued
	 * input only all at once; a durable thread can take back one. A returned Team input can be dismissed, as its record
	 * is only a display record. A queued Team input is refused: aborting it would settle its delivery unanswered, and
	 * durable-team does not resend it. The Team's own lifecycle and Stop paths own that abort.
	 */
	async withdraw(key: string, submissionId: string): Promise<{ withdrawn: boolean }> {
		const { store, conversationId } = await this.thread(key);
		const id = Number(conversationId) as ConversationId;
		const returned = await store.harness.snapshot(ReturnedDoc, id, BACKGROUND_CONTEXT);
		if (returned?.items.some((item) => item.id === submissionId)) {
			await store.harness.commit(async (tx) => {
				const doc = await tx.doc(ReturnedDoc, id);
				doc.items = doc.items.filter((item) => item.id !== submissionId);
			}, BACKGROUND_CONTEXT);
			await this.#publishReturned(key);
			return { withdrawn: true };
		}
		await this.#refuseTeamInput(store, id, submissionId, "withdrawn");
		const submission = await store.harness.submission(Number(submissionId) as never, BACKGROUND_CONTEXT);
		if (!submission || String((await submission.status(BACKGROUND_CONTEXT)).conversationId) !== conversationId) return { withdrawn: false };
		return { withdrawn: (await submission.abort(BACKGROUND_CONTEXT)) === "aborted" };
	}

	/**
	 * `thread.editQueued`: replaces the text of one queued steer or follow-up in one commit, at its place in the queue,
	 * with its submission ID, mode and images kept. The replace holds only while the item still shows `expected`.
	 * Boundaries remove placed items in their own commits, so an item the run took first answers `taken`, and an item
	 * another edit changed answers `changed`. Neither writes, and the node never resends: the caller keeps the text.
	 * The same commit records the answer under `editId` in `ampi.edits` (newest 50). A retry with that `editId` gets the
	 * recorded answer, also after the run placed the item; another edit under it is refused `key_conflict`. A queued
	 * Team input is refused `bad_request`: it is not the owner's text.
	 * An item that left the queue without a record is judged by its own submission: when its placed entry carries
	 * `text`, the edit landed. Otherwise a first attempt answers `taken`. A `retry` without a record answers `unknown`
	 * where a first attempt would answer `taken` or `changed`, because its record may have left the newest 50.
	 */
	async editQueued(key: string, submissionId: string, editId: string, expected: string, text: string, retry = false): Promise<EditQueuedResult> {
		if (!text.trim()) throw new NodeError("bad_request", "A queued message cannot be empty; withdraw it instead");
		const { store, conversationId } = await this.thread(key);
		const id = Number(conversationId) as ConversationId;
		await this.#refuseTeamInput(store, id, submissionId, "edited");
		let result: EditQueuedResult | undefined;
		await store.harness.commit(async (tx) => {
			const record = await tx.doc(EditsDoc, id);
			const prior = record.edits[editId];
			if (prior) {
				if (prior.submission !== submissionId || prior.text !== text) throw new NodeError("key_conflict", `Edit key ${editId} already names a different edit. Save this edit with a new key.`);
				// Copy out of the document: the transaction's values settle with the commit.
				return void (result = prior.result.edited ? { edited: true } : { edited: false, reason: prior.result.reason });
			}
			const inbox = await tx.doc(InboxDoc, id);
			const found = inbox.items.find((candidate) => String(candidate.id) === submissionId);
			const item = found && found.mode !== "write" ? found : undefined;
			const current = item && contentText(item.content as never);
			// Left the queue: judged below by its submission, without a record.
			if (!item) return;
			// The item already shows this text, so the owner's intent holds.
			if (current === text) result = { edited: true };
			// Without a record, a retry cannot tell its own evicted edit, overwritten later, from no edit.
			else if (current !== expected && retry) return void (result = { edited: false, reason: "unknown" });
			else if (current !== expected) result = { edited: false, reason: "changed" };
			else {
				// Images stay; the text parts become the one new text part, ahead of the images as submit orders them.
				const images = typeof item.content === "string" ? [] : item.content.filter((part) => part.type !== "text");
				item.content = images.length ? [{ type: "text", text }, ...images] : text;
				result = { edited: true };
			}
			record.edits[editId] = { submission: submissionId, text, result, at: Date.now() };
			const keys = Object.keys(record.edits);
			if (keys.length > KEEP_EDITS)
				for (const old of keys.sort((a, b) => record.edits[a]!.at - record.edits[b]!.at).slice(0, keys.length - KEEP_EDITS)) delete record.edits[old];
		}, BACKGROUND_CONTEXT);
		if (result) return result;
		const placed = await (await store.harness.submission(Number(submissionId) as never, BACKGROUND_CONTEXT))?.status(BACKGROUND_CONTEXT);
		const entry = placed && String(placed.conversationId) === conversationId && (placed.status === "placed" || placed.status === "done") && placed.entry !== undefined
			? await store.harness.commit(async (tx) => tx.entry(placed.entry!), BACKGROUND_CONTEXT)
			: undefined;
		const message = entry?.kind === "pi.user" ? (entry.model?.[0] as { content?: unknown } | undefined) : undefined;
		if (message && contentText(message.content as never) === text) return { edited: true };
		return retry ? { edited: false, reason: "unknown" } : { edited: false, reason: "taken" };
	}

	/** The thread's returned inputs now, and each later change until `stop`. */
	async watchReturned(key: string, listener: (value: ReturnedState) => void): Promise<{ value: ReturnedState; stop: () => void }> {
		const { store, conversationId } = await this.thread(key);
		let listeners = this.#returnedListeners.get(key);
		if (!listeners) this.#returnedListeners.set(key, (listeners = new Set()));
		listeners.add(listener);
		const value = (await store.harness.snapshot(ReturnedDoc, Number(conversationId) as ConversationId, BACKGROUND_CONTEXT)) ?? { items: [] };
		return {
			value,
			stop: () => {
				listeners.delete(listener);
				if (listeners.size === 0 && this.#returnedListeners.get(key) === listeners) this.#returnedListeners.delete(key);
			},
		};
	}

	async #publishReturned(key: string): Promise<void> {
		const listeners = this.#returnedListeners.get(key);
		if (!listeners?.size) return;
		const { store, conversationId } = await this.thread(key);
		const value = (await store.harness.snapshot(ReturnedDoc, Number(conversationId) as ConversationId, BACKGROUND_CONTEXT)) ?? { items: [] };
		for (const listener of listeners) listener(value);
	}

	/** `node.health`: every open store's live tasks, from `harness.inspect()`. A blocked task names its reason. */
	async health(): Promise<NodeHealth> {
		const stores: NodeHealth["stores"] = [];
		for (const store of this.stores.values()) {
			if (store.closed) continue;
			const inspection = await store.harness.inspect(BACKGROUND_CONTEXT);
			stores.push({
				id: store.id,
				tasks: inspection.tasks.map(({ record, state }) => ({
					id: String(record.id),
					kind: record.kind,
					conversation: String(record.conversationId),
					state: state.kind,
					...(state.kind === "blocked" ? { reason: state.reason } : {}),
				})),
			});
		}
		for (const [id, failed] of this.#failed) stores.push({ id, tasks: [], unavailable: failed.error, ...(failed.gaveUp ? { gaveUp: true } : {}) });
		return { stores };
	}

	refresh(store: Store, conversationId: string): void {
		this.#schedule(store, conversationId, 0);
	}

	async close(context: Context = BACKGROUND_CONTEXT): Promise<void> {
		this.#closing = true;
		await Promise.allSettled(this.#opening.values());
		for (const timer of this.#pending.values()) clearTimeout(timer);
		for (const timer of this.#reopenTimers) clearTimeout(timer);
		this.#reopenTimers.clear();
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

/** The answer of a gated stream that ended without a provider answer: aborted in the gate, or a provider that threw. */
function failedMessage(model: Model<Api>, stopReason: "aborted" | "error", reason: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		errorMessage: reason instanceof Error ? reason.message : stopReason === "aborted" ? "Request was aborted" : String(reason),
		timestamp: Date.now(),
	};
}

/**
 * The owner's words for a blocked task (pi-durable `TaskState` `blocked.reason`). A closed thread runs nothing again,
 * so its reason has no action hint.
 */

function blockedReason(kind: string, reason: string, limit: number, closed: boolean): string {
	const what = ({ "pi.generation": "The model request", "pi.tool": "A tool call", "pi.compaction": "Compaction" } as Record<string, string>)[kind] ?? `Task ${kind}`;
	switch (reason) {
		case "restart_limit":
			return `${what} was cut off ${limit} times without progress and is parked${closed ? "" : "; /retry runs it again"}`;
		case "missing_task":
			return `${what} needs an extension this node does not have${closed ? "" : "; install it, then /retry"}`;
		case "task_too_old":
			return `${what} was stored by a newer node${closed ? "" : "; update the node"}`;
		case "migration_failed":
			return `${what} could not be migrated to this node's version`;
		default:
			return `${what} is blocked: ${reason}`;
	}
}

export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}
