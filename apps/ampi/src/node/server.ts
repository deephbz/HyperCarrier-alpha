// One client connection to the node: request dispatch and subscriptions. Transport-agnostic: the caller supplies
// `send` and feeds parsed frames into `receive`.

import { execFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { JsonValue, ReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { diffRevisions } from "@earendil-works/chord/delta";
import type { EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { type ClientFrame, type NodeFrame, type NodeOpName, type NodeOps, type Placement, PROTOCOL, THREAD_FIELDS, type Topic } from "../shared/protocol.ts";
import { auditSnapshot } from "../plugins/prompt-audit.ts";
import { type CommandArgs, listCommands, runCommand } from "./commands.ts";
import { loadPrompts, loadSkills } from "./core-extension.ts";
import { projectEntry, projectView, projectViewFields, type ReturnedState } from "./projection.ts";
import { expandHome, NodeError, type NodeRuntime } from "./runtime.ts";
import { IMAGE_MAGIC, NODE_IMAGE_LIMITS } from "./images.ts";
import { admitImages, rejectionLine } from "../shared/image-admission.ts";
import { claimSubmitKey, submitDigest } from "./submit-keys.ts";
// @ts-ignore: shared reader wire is plain ESM.
import { createReaderService } from "../../../trace-analytics/src/sources/durable-wire.mjs";

const execFileAsync = promisify(execFile);

/** A live value a subscription streams: its current value and change notifications. */
export type TopicSource = {
	value: JsonValue;
	subscribe(listener: (value: JsonValue) => void): () => void;
	dispose?(): void;
};

export type OpHandler = (args: Record<string, unknown>, runtime: NodeRuntime) => Promise<unknown>;
export type TopicHandler = (topic: Topic, runtime: NodeRuntime) => Promise<TopicSource>;

/** Registries plugins extend. */
export const ops = new Map<string, OpHandler>();
export const topics = new Map<string, TopicHandler>();

/**
 * Registers one node op. Its result must be the op's declared `NodeOps` result; its arguments arrive unchecked from the
 * wire, so the handler validates them.
 */
export function defineOp<K extends NodeOpName>(name: K, handler: (args: Record<string, unknown>, runtime: NodeRuntime) => Promise<NodeOps[K]["result"]>): void {
	ops.set(name, handler);
}

/** Validates submitted images: admission under NODE_IMAGE_LIMITS (the Composer's same decision), then the bytes. */
function imagesOf(value: unknown): { type: "image"; data: string; mimeType: string }[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new NodeError("bad_request", "images must be a list");
	const offered = value.map((image: { data?: unknown; mimeType?: unknown }, i) => {
		if (typeof image?.data !== "string" || typeof image.mimeType !== "string") throw new NodeError("bad_request", "each image needs base64 data and a mimeType");
		return { name: `image ${i + 1}`, type: image.mimeType, base64: image.data.length, data: image.data };
	});
	const line = rejectionLine(admitImages([], offered, NODE_IMAGE_LIMITS).rejected);
	if (line) throw new NodeError("bad_request", line);
	return offered.map(({ type, data }) => {
		const bytes = /^[A-Za-z0-9+/]*={0,2}$/.test(data) ? Buffer.from(data, "base64") : Buffer.alloc(0);
		if (bytes.length === 0 || !IMAGE_MAGIC[type]!(bytes)) throw new NodeError("bad_request", `the image data is not a valid ${type.slice(6)} file`);
		return { type: "image", data, mimeType: type };
	});
}

function str(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	if (typeof value !== "string" || value === "") throw new NodeError("bad_request", `Missing ${key}`);
	return value;
}

export function fromState<T>(state: ReplicatedState<T> & { dispose?: () => void }, map: (value: T) => JsonValue): TopicSource {
	let current = map(state.value as T);
	return {
		get value() {
			return current;
		},
		subscribe(listener) {
			return state.subscribe((value) => {
				current = map(value);
				listener(current);
			});
		},
		dispose: () => state.dispose?.(),
	};
}

defineOp("node.info", async (_args, runtime) => runtime.info);
defineOp("node.health", async (_args, runtime) => runtime.health());
defineOp("store.reopen", async (args, runtime) => runtime.reopenStore(str(args, "storeId")));
/** Restart this node (for example onto a newer build): durable work resumes; the hub reconnects through the bridge. */
defineOp("node.restart", async () => {
	if (process.env.AMPI_NODE_PROCESS !== "1") throw new NodeError("bad_request", "Only a standalone `ampi node` can restart itself.");
	// SIGUSR2 makes `ampi node` exit 75 after a clean stop: a supervisor restarts a failed exit only (supervisor.ts),
	// and an unsupervised node starts again on the next connection.
	setTimeout(() => process.kill(process.pid, "SIGUSR2"), 100);
	return { restarting: true };
});
defineOp("audit.snapshot", async (args, runtime) => {
	const { conversation } = await runtime.thread(str(args, "threadId"));
	let entryId: EntryId | undefined;
	if (args.entryId !== undefined) {
		entryId = Number(args.entryId) as EntryId;
		if (!Number.isSafeInteger(entryId) || entryId <= 0) throw new NodeError("bad_request", "entryId must be an entry ID.");
		const page = await conversation.entries({ minEntryId: entryId, maxEntryId: entryId }, 1, undefined, BACKGROUND_CONTEXT);
		if (page.items.length === 0) throw new NodeError("not_found", `No entry ${entryId} in this thread.`);
	}
	const snapshot = await auditSnapshot(conversation, BACKGROUND_CONTEXT, entryId === undefined ? {} : { entryId });
	if (!snapshot) throw new NodeError("not_found", "No system prompt recorded yet for this thread.");
	return snapshot;
});
defineOp("node.backup", async (args, runtime) => runtime.backup(typeof args.storeId === "string" ? args.storeId : undefined));
defineOp("models.list", async (_args, runtime) => runtime.listModels());
defineOp("accounts.list", async (_args, runtime) => runtime.accounts.providers());
defineOp("accounts.login", async (args, runtime) => runtime.accounts.start(str(args, "providerId"), args.type === "oauth" ? "oauth" : "api_key"));
defineOp("accounts.answer", async (args, runtime) => {
	runtime.accounts.answer(str(args, "loginId"), str(args, "promptId"), typeof args.value === "string" ? args.value : "");
	return {};
});
defineOp("accounts.cancel", async (args, runtime) => {
	runtime.accounts.cancel(str(args, "loginId"));
	return {};
});
defineOp("accounts.logout", async (args, runtime) => {
	await runtime.accounts.logout(str(args, "providerId"));
	return {};
});
defineOp("thread.create", async (args, runtime) =>
	runtime.createThread({
		cwd: args.cwd as string | undefined,
		model: args.model as { provider: string; modelId: string } | undefined,
		thinkingLevel: args.thinkingLevel as string | undefined,
		title: (args.name ?? args.title) as string | undefined,
		prompt: args.prompt as string | undefined,
		requestId: args.requestId as string | undefined,
		place: args.place as Placement | undefined,
	}),
);
defineOp("thread.close", async (args, runtime) => runtime.closeThread(str(args, "threadId")));
defineOp("thread.submit", async (args, runtime) => {
	const threadId = str(args, "threadId");
	// A message unarchives an archived thread first. Legacy Close stays read-only for API callers.
	await runtime.archiveThread(threadId, false, { keepClosed: true });
	return runtime.admit(threadId, async (thread) => {
	const { conversation } = thread;
	const whenBusy = (args.whenBusy as "steer" | "followUp" | "reject" | undefined) ?? "followUp";
	const text = typeof args.content === "string" ? args.content : "";
	const images = imagesOf(args.images);
	if (!text.trim() && images.length === 0) throw new NodeError("bad_request", "content is required");
	if (images.length) {
		// An image the model cannot take would be stored durably and fail every later turn: refuse it up front.
		const agent = await conversation.agent(BACKGROUND_CONTEXT);
		const ref = agent.model as { provider?: string; modelId?: string; id?: string } | undefined;
		const model = ref?.provider ? runtime.models.getModel(ref.provider, ref.modelId ?? ref.id ?? "") : undefined;
		if (model && !(model.input ?? ["text"]).includes("image"))
			throw new NodeError("bad_request", `${ref!.provider}/${ref!.modelId ?? ref!.id} does not accept images; switch the thread's model first`);
	}
	const content = images.length ? [...(text ? [{ type: "text" as const, text }] : []), ...images] : text;
	if (typeof args.requestId === "string") await claimSubmitKey(thread, args.requestId, submitDigest({ text, whenBusy, images }));
	const submission = await conversation.submit(
		{
			type: "input",
			content,
			whenBusy,
			...(typeof args.requestId === "string" ? { requestId: args.requestId } : {}),
		},
		BACKGROUND_CONTEXT,
	);
	// Admission is the commit (P7). An idle thread places the input in the same step, so `placed` proves a run started.
	const status = (await submission.status(BACKGROUND_CONTEXT)).status;
	return { via: "node", evidence: status === "queued" ? "admitted" : "started", submission: String(submission.id) };
});
});
defineOp("thread.withdraw", async (args, runtime) => runtime.withdraw(str(args, "threadId"), str(args, "submissionId")));
defineOp("thread.editQueued", async (args, runtime) => runtime.editQueued(str(args, "threadId"), str(args, "submissionId"), str(args, "editId"), typeof args.expected === "string" ? args.expected : "", typeof args.text === "string" ? args.text : "", args.retry === true));
defineOp("thread.abort", async (args, runtime) => {
	return runtime.abortThread(str(args, "threadId"));
});
defineOp("thread.commands", async (args, runtime) => listCommands(runtime, str(args, "threadId")));
defineOp("thread.command", async (args, runtime) => runCommand(runtime, { ...(args as CommandArgs), threadId: str(args, "threadId") }));
defineOp("thread.compact", async (args, runtime) => runtime.admit(str(args, "threadId"), async ({ conversation }) => {
	const taskId = await conversation.compact(args.instructions as string | undefined, BACKGROUND_CONTEXT);
	return { taskId: String(taskId) };
}));
defineOp("thread.configure", async (args, runtime) => runtime.admit(str(args, "threadId"), async ({ conversation }) => {
	const change: Record<string, unknown> = {};
	if (args.model) change.model = args.model;
	if (args.thinkingLevel !== undefined) change.thinkingLevel = args.thinkingLevel;
	if (typeof args.cwd === "string") change.cwd = expandHome(args.cwd);
	await conversation.configure(change, BACKGROUND_CONTEXT);
	return {};
}));
defineOp("thread.rename", async (args, runtime) => {
	await runtime.updateMeta(str(args, "threadId"), { title: String(args.title ?? "") });
	return {};
});
defineOp("thread.archive", async (args, runtime) => {
	await runtime.archiveThread(str(args, "threadId"), args.archived !== false);
	return {};
});
defineOp("thread.fork", async (args, runtime) => {
	const { store, conversation } = await runtime.thread(str(args, "threadId"));
	const fork = await conversation.fork(Number(str(args, "entryId")) as EntryId, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
	runtime.refresh(store, String(fork.id));
	return { threadId: store.threadKey(fork.id) };
});
defineOp("thread.history", async (args, runtime) => {
	const { conversation } = await runtime.thread(str(args, "threadId"));
	const before = Number(str(args, "before"));
	const limit = Math.min(Number(args.limit ?? 200), 500);
	const page = await conversation.entries({ maxEntryId: (before - 1) as EntryId }, limit, undefined, BACKGROUND_CONTEXT);
	const items = [...(page.items as readonly EntryRecord[])].reverse().map(projectEntry);
	return { entries: items, more: page.next !== undefined };
});
// Image bytes stay out of the transcript projection; the UI fetches them for one entry on demand.
defineOp("thread.images", async (args, runtime) => {
	const { conversation } = await runtime.thread(str(args, "threadId"));
	const id = Number(str(args, "entryId")) as EntryId;
	const page = await conversation.entries({ minEntryId: id, maxEntryId: id }, 1, undefined, BACKGROUND_CONTEXT);
	const entry = (page.items as readonly EntryRecord[])[0];
	const content = (entry?.model?.[0] as { content?: unknown } | undefined)?.content;
	const images = Array.isArray(content) ? content.filter((p: { type?: string }) => p?.type === "image") : [];
	// One image per response keeps every frame far below the transport's buffer caps.
	const index = Number(args.index ?? 0);
	const image = images[index] as { data: string; mimeType: string } | undefined;
	return { count: images.length, ...(image ? { image: { data: image.data, mimeType: image.mimeType } } : {}) };
});
// The repository state of a thread's directory: what is different, whoever changed it (the agent's tools, bash,
// Team Workers, or the owner). The thread's own edit log explains it; this is the review surface.
const GIT_PATCH_LIMIT = 2 * 1024 * 1024;
async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", ["-C", cwd, "--no-pager", ...args], { timeout: 10_000, maxBuffer: GIT_PATCH_LIMIT * 2, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
	return stdout;
}
defineOp("git.changes", async (args) => {
	const cwd = expandHome(typeof args.cwd === "string" && args.cwd ? args.cwd : homedir());
	let root: string;
	try {
		root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
	} catch {
		return { repo: false };
	}
	const [branch, status, patch] = await Promise.all([
		git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).then((s) => s.trim(), () => ""),
		git(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
		git(root, ["diff", "HEAD", "--no-color", "--no-ext-diff", "--find-renames"]).catch(() => git(root, ["diff", "--no-color", "--no-ext-diff"])),
	]);
	const files = status
		.split("\n")
		.filter((line) => line.length > 3)
		.slice(0, 2000)
		.map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }));
	return {
		repo: true,
		root,
		branch,
		files,
		patch: patch.length > GIT_PATCH_LIMIT ? patch.slice(0, GIT_PATCH_LIMIT) : patch,
		truncated: patch.length > GIT_PATCH_LIMIT,
	};
});

// The owner's pi prompt templates and skills for a working directory, offered as composer commands.
defineOp("prompts.list", async (args, runtime) => {
	const cwd = expandHome(typeof args.cwd === "string" && args.cwd ? args.cwd : homedir());
	return {
		prompts: loadPrompts(cwd, runtime.piConfig).map(({ name, description, body }) => ({ name, description, body })),
		skills: loadSkills(cwd, runtime.piConfig).map(({ name, description, path }) => ({ name, description, path })),
	};
});
defineOp("fs.dirs", async (args) => {
	const path = resolve(expandHome(typeof args.path === "string" && args.path ? args.path : homedir()));
	const dirs: string[] = [];
	try {
		for (const name of readdirSync(path)) {
			if (name.startsWith(".") && args.hidden !== true) continue;
			try {
				if (statSync(join(path, name)).isDirectory()) dirs.push(name);
			} catch {}
			if (dirs.length >= 500) break;
		}
	} catch (error) {
		throw new NodeError("bad_request", (error as Error).message);
	}
	return { path, parent: dirname(path), dirs: dirs.sort() };
});

topics.set("login", async (topic, runtime) => runtime.accounts.source((topic as { loginId: string }).loginId));
topics.set("threads", async (_topic, runtime) => fromState(runtime.threads, (value) => value as unknown as JsonValue));
topics.set("node", async (_topic, runtime) => ({ value: runtime.info as unknown as JsonValue, subscribe: () => () => {} }));
topics.set("thread", async (topic, runtime) => {
	if (topic.kind !== "thread") throw new NodeError("bad_request", "thread topic");
	const fields = topic.fields;
	if (fields !== undefined && !(Array.isArray(fields) && fields.every((f) => (THREAD_FIELDS as readonly string[]).includes(f))))
		throw new NodeError("bad_request", `thread topic fields are ${THREAD_FIELDS.join(", ")}`);
	const { conversation } = await runtime.thread(topic.threadId);
	const state = await conversation.viewState(BACKGROUND_CONTEXT);
	const listeners = new Set<(value: JsonValue) => void>();
	let returned: ReturnedState = { items: [] };
	let view = state.value;
	let current: JsonValue = null;
	const project = (): JsonValue => (fields ? projectViewFields(view, returned, fields) : projectView(view, returned)) as unknown as JsonValue;
	const publish = () => {
		current = project();
		for (const listener of listeners) listener(current);
	};
	const watch = await runtime.watchReturned(topic.threadId, (value) => {
		returned = value;
		publish();
	});
	returned = watch.value;
	current = project();
	const unsubscribe = state.subscribe((next) => {
		view = next;
		publish();
	});
	return {
		get value() {
			return current;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		dispose: () => {
			unsubscribe();
			watch.stop();
			state.dispose?.();
		},
	};
});

/** One connection of the reader service (trace-analytics durable-wire.mjs, contract: reader-design.md "Node read API"). */
type ReaderConnection = Record<ReaderOp | "watch" | "disconnect", (...args: any[]) => Promise<any>>;
type ReaderOp = "open" | "entries" | "fence" | "raw" | "cancel" | "close";
const READER_OPS = new Set<string>(["open", "entries", "fence", "raw", "cancel", "close"]);
/** The reader ops, served per connection beside the `ops` registry. */
export const readerOps = [...READER_OPS].map((name) => `reader.${name}`);
const readers = new WeakMap<NodeRuntime, ReturnType<typeof readerService>>();

/**
 * The node's reader service. A handle pins its conversation's watch in node memory until `reader.close` or the
 * connection ends; the service never keeps a handle without its connection. `epoch` is the node's start time, so it
 * changes at every restart.
 */
function readerService(runtime: NodeRuntime): { connect(): ReaderConnection; stats(): ReturnType<typeof readerStats> } {
	let service = readers.get(runtime);
	if (!service) {
		service = createReaderService({
			context: BACKGROUND_CONTEXT,
			epoch: runtime.info.startedAt,
			resolve: async (threadId: unknown) => {
				if (typeof threadId !== "string" || threadId === "") throw new NodeError("bad_request", "Missing threadId");
				try {
					return (await runtime.thread(threadId)).conversation;
				} catch (error) {
					if (error instanceof NodeError && error.code === "not_found") return null;
					throw error;
				}
			},
		}) as { connect(): ReaderConnection; stats(): ReturnType<typeof readerStats> };
		readers.set(runtime, service);
	}
	return service;
}

/** Reader service counters (open handles, exports): tests and the L4 memory run read them. */
export function readerStats(runtime: NodeRuntime): { opened: number; closed: number; exports: number; handles: number; maxRecordBytes: number } {
	return readerService(runtime).stats();
}

export class Connection {
	readonly #send: (frame: NodeFrame) => void;
	readonly #runtime: NodeRuntime;
	readonly #subs = new Map<number, { source?: TopicSource; stop?: () => void; closed: boolean }>();
	#reader?: ReaderConnection;

	constructor(runtime: NodeRuntime, send: (frame: NodeFrame) => void) {
		this.#runtime = runtime;
		this.#send = send;
		send({ t: "hello", protocol: PROTOCOL, node: runtime.info });
	}

	receive(frame: ClientFrame): void {
		switch (frame.t) {
			case "ping":
				this.#send({ t: "pong" });
				return;
			case "req":
				void this.#request(frame.id, frame.op, (frame.args ?? {}) as Record<string, unknown>);
				return;
			case "sub":
				void this.#subscribe(frame.sid, frame.topic);
				return;
			case "unsub":
				this.#unsubscribe(frame.sid);
				return;
		}
	}

	async #request(id: number, op: string, args: Record<string, unknown>): Promise<void> {
		const name = op.startsWith("reader.") ? op.slice(7) : "";
		const pluginOp = this.#runtime.plugins.find((plugin) => plugin.ops?.[op as NodeOpName])?.ops?.[op as NodeOpName] as OpHandler | undefined;
		const handler = READER_OPS.has(name) ? () => this.#readerConnection()[name as ReaderOp](args) : (pluginOp ?? ops.get(op));
		try {
			if (!handler) throw new NodeError("unsupported", `This node does not serve ${op}`);
			const value = await handler(args, this.#runtime);
			this.#send({ t: "res", id, ok: true, value });
		} catch (error) {
			// The reader wire's errors carry their wire code (bad_request, not_found, expired_handle, ...).
			const wire = (error as { code?: unknown }).code;
			const code = error instanceof NodeError ? error.code : typeof wire === "string" ? wire : ((error as { name?: string }).name ?? "error");
			this.#send({ t: "res", id, ok: false, error: { code, message: (error as Error).message ?? String(error) } });
		}
	}

	async #subscribe(sid: number, topic: Topic): Promise<void> {
		const entry: { source?: TopicSource; stop?: () => void; closed: boolean } = { closed: false };
		this.#subs.set(sid, entry);
		try {
			const handler = topic.kind === "reader" ? () => this.#watch(sid, topic.handle) : topics.get(topic.kind);
			if (!handler) throw new NodeError("unsupported", `This node does not serve the ${topic.kind} topic`);
			const source = await handler(topic, this.#runtime);
			if (entry.closed) {
				source.dispose?.();
				return;
			}
			entry.source = source;
			let previous = source.value;
			this.#send({ t: "snap", sid, value: previous });
			let n = 0;
			entry.stop = source.subscribe((value) => {
				if (entry.closed) return;
				const ops = diffRevisions(previous, value);
				previous = value;
				if (ops.length > 0) this.#send({ t: "ops", sid, n: ++n, ops });
			});
		} catch (error) {
			this.#subs.delete(sid);
			this.#send({ t: "end", sid, reason: (error as Error).message ?? String(error) });
		}
	}

	#unsubscribe(sid: number): void {
		const entry = this.#subs.get(sid);
		if (!entry) return;
		entry.closed = true;
		entry.stop?.();
		entry.source?.dispose?.();
		this.#subs.delete(sid);
	}

	#readerConnection(): ReaderConnection {
		return (this.#reader ??= readerService(this.#runtime).connect());
	}

	/**
	 * The reader watch of one handle as a topic: the snapshot is null, and every watch frame replaces the value. The
	 * wire's end (handle closed, connection lost) ends the subscription.
	 */
	async #watch(sid: number, handle: unknown): Promise<TopicSource> {
		if (typeof handle !== "string") throw new NodeError("bad_request", "Missing handle");
		let current: JsonValue = null;
		const listeners = new Set<(value: JsonValue) => void>();
		const watch = await this.#readerConnection().watch(
			{ handle },
			(frame: JsonValue) => {
				current = frame;
				for (const listener of listeners) listener(current);
			},
			(reason: string) => {
				const entry = this.#subs.get(sid);
				if (!entry || entry.closed) return;
				this.#unsubscribe(sid);
				this.#send({ t: "end", sid, reason });
			},
		);
		return {
			get value() {
				return current;
			},
			subscribe(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			dispose: () => watch.stop(),
		};
	}

	close(): void {
		for (const sid of [...this.#subs.keys()]) this.#unsubscribe(sid);
		// Every reader handle of this connection closes with it, with its watch and export.
		void this.#reader?.disconnect();
	}
}
