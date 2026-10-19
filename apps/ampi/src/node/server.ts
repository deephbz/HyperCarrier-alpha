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
import { type ClientFrame, type NodeFrame, PROTOCOL, type Topic } from "../shared/protocol.ts";
import { loadPrompts, loadSkills } from "./core-extension.ts";
import { projectEntry, projectView } from "./projection.ts";
import { expandHome, NodeError, type NodeRuntime } from "./runtime.ts";

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

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Magic bytes per accepted type: the label must match the bytes, or providers reject the image on every turn. */
const IMAGE_MAGIC: Record<string, (b: Buffer) => boolean> = {
	"image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
	"image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
	"image/gif": (b) => b.subarray(0, 4).toString("latin1") === "GIF8",
	"image/webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};

function imagesOf(value: unknown): { type: "image"; data: string; mimeType: string }[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 8) throw new NodeError("bad_request", "images must be a list of at most 8 images");
	return value.map((image: { data?: unknown; mimeType?: unknown }) => {
		if (typeof image?.data !== "string" || typeof image.mimeType !== "string" || !IMAGE_MAGIC[image.mimeType])
			throw new NodeError("bad_request", "each image needs base64 data and a png, jpeg, gif, or webp mimeType");
		if (image.data.length * 0.75 > MAX_IMAGE_BYTES * 1.01) throw new NodeError("bad_request", "an image is larger than 5 MB");
		const bytes = /^[A-Za-z0-9+/]*={0,2}$/.test(image.data) ? Buffer.from(image.data, "base64") : Buffer.alloc(0);
		if (bytes.length === 0 || !IMAGE_MAGIC[image.mimeType]!(bytes)) throw new NodeError("bad_request", `the image data is not a valid ${image.mimeType.slice(6)} file`);
		if (bytes.length > MAX_IMAGE_BYTES) throw new NodeError("bad_request", "an image is larger than 5 MB");
		return { type: "image", data: image.data, mimeType: image.mimeType };
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

ops.set("node.info", async (_args, runtime) => runtime.info);
/** Restart this node (for example onto a newer build): durable work resumes; the hub reconnects through the bridge. */
ops.set("node.restart", async () => {
	if (process.env.AMPI_NODE_PROCESS !== "1") throw new NodeError("bad_request", "Only a standalone `ampi node` can restart itself.");
	setTimeout(() => process.kill(process.pid, "SIGTERM"), 100);
	return { restarting: true };
});
ops.set("models.list", async (_args, runtime) => runtime.listModels());
ops.set("accounts.list", async (_args, runtime) => runtime.accounts.providers());
ops.set("accounts.login", async (args, runtime) => runtime.accounts.start(str(args, "providerId"), args.type === "oauth" ? "oauth" : "api_key"));
ops.set("accounts.answer", async (args, runtime) => {
	runtime.accounts.answer(str(args, "loginId"), str(args, "promptId"), typeof args.value === "string" ? args.value : "");
	return {};
});
ops.set("accounts.cancel", async (args, runtime) => {
	runtime.accounts.cancel(str(args, "loginId"));
	return {};
});
ops.set("accounts.logout", async (args, runtime) => {
	await runtime.accounts.logout(str(args, "providerId"));
	return {};
});
ops.set("thread.create", async (args, runtime) =>
	runtime.createThread({
		cwd: args.cwd as string | undefined,
		model: args.model as { provider: string; modelId: string } | undefined,
		thinkingLevel: args.thinkingLevel as string | undefined,
		title: args.title as string | undefined,
		prompt: args.prompt as string | undefined,
		requestId: args.requestId as string | undefined,
	}),
);
ops.set("thread.submit", async (args, runtime) => {
	const { conversation } = await runtime.thread(str(args, "threadId"));
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
	const submission = await conversation.submit(
		{
			type: "input",
			content,
			whenBusy,
			...(typeof args.requestId === "string" ? { requestId: args.requestId } : {}),
		},
		BACKGROUND_CONTEXT,
	);
	return { submissionId: String(submission.id) };
});
ops.set("thread.withdraw", async (args, runtime) => {
	const { store } = await runtime.thread(str(args, "threadId"));
	const submission = await store.harness.submission(Number(str(args, "submissionId")) as never, BACKGROUND_CONTEXT);
	if (submission) await submission.abort(BACKGROUND_CONTEXT);
	return { withdrawn: submission !== undefined };
});
ops.set("thread.abort", async (args, runtime) => {
	const { conversation } = await runtime.thread(str(args, "threadId"));
	await conversation.abort(BACKGROUND_CONTEXT);
	return {};
});
ops.set("thread.compact", async (args, runtime) => {
	const { conversation } = await runtime.thread(str(args, "threadId"));
	const taskId = await conversation.compact(args.instructions as string | undefined, BACKGROUND_CONTEXT);
	return { taskId: String(taskId) };
});
ops.set("thread.configure", async (args, runtime) => {
	const { conversation } = await runtime.thread(str(args, "threadId"));
	const change: Record<string, unknown> = {};
	if (args.model) change.model = args.model;
	if (args.thinkingLevel !== undefined) change.thinkingLevel = args.thinkingLevel;
	if (typeof args.cwd === "string") change.cwd = expandHome(args.cwd);
	await conversation.configure(change, BACKGROUND_CONTEXT);
	return {};
});
ops.set("thread.rename", async (args, runtime) => {
	await runtime.updateMeta(str(args, "threadId"), { title: String(args.title ?? "") });
	return {};
});
ops.set("thread.archive", async (args, runtime) => {
	await runtime.updateMeta(str(args, "threadId"), { archived: args.archived !== false });
	return {};
});
ops.set("thread.fork", async (args, runtime) => {
	const { store, conversation } = await runtime.thread(str(args, "threadId"));
	const fork = await conversation.fork(Number(str(args, "entryId")) as EntryId, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
	runtime.refresh(store, String(fork.id));
	return { threadId: store.threadKey(fork.id) };
});
ops.set("thread.history", async (args, runtime) => {
	const { conversation } = await runtime.thread(str(args, "threadId"));
	const before = Number(str(args, "before"));
	const limit = Math.min(Number(args.limit ?? 200), 500);
	const page = await conversation.entries({ maxEntryId: (before - 1) as EntryId }, limit, undefined, BACKGROUND_CONTEXT);
	const items = [...(page.items as readonly EntryRecord[])].reverse().map(projectEntry);
	return { entries: items, more: page.next !== undefined };
});
// Image bytes stay out of the transcript projection; the UI fetches them for one entry on demand.
ops.set("thread.images", async (args, runtime) => {
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
ops.set("git.changes", async (args) => {
	const cwd = expandHome(typeof args.cwd === "string" && args.cwd ? args.cwd : homedir());
	let root: string;
	try {
		root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
	} catch {
		return { repo: false } as JsonValue;
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
	} as JsonValue;
});

// The owner's pi prompt templates and skills for a working directory, offered as composer commands.
ops.set("prompts.list", async (args) => {
	const cwd = expandHome(typeof args.cwd === "string" && args.cwd ? args.cwd : homedir());
	return {
		prompts: loadPrompts(cwd).map(({ name, description, body }) => ({ name, description, body })),
		skills: loadSkills(cwd).map(({ name, description, path }) => ({ name, description, path })),
	} as unknown as JsonValue;
});
ops.set("fs.dirs", async (args) => {
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

ops.set("term.open", async (args, runtime) =>
	runtime.terminals.open({
		cwd: typeof args.cwd === "string" ? args.cwd : undefined,
		cols: Number(args.cols) || undefined,
		rows: Number(args.rows) || undefined,
		title: typeof args.title === "string" ? args.title : undefined,
	}),
);
ops.set("term.input", async (args, runtime) => {
	runtime.terminals.input(str(args, "termId"), str(args, "data"));
	return {};
});
ops.set("term.resize", async (args, runtime) => {
	runtime.terminals.resize(str(args, "termId"), Number(args.cols), Number(args.rows));
	return {};
});
ops.set("term.close", async (args, runtime) => {
	runtime.terminals.close(str(args, "termId"));
	return {};
});
topics.set("terms", async (_topic, runtime) => runtime.terminals.listSource());
topics.set("login", async (topic, runtime) => runtime.accounts.source((topic as { loginId: string }).loginId));
topics.set("term", async (topic, runtime) => {
	if (topic.kind !== "term") throw new NodeError("bad_request", "term topic");
	return runtime.terminals.source(topic.termId);
});
topics.set("threads", async (_topic, runtime) => fromState(runtime.threads, (value) => value as unknown as JsonValue));
topics.set("node", async (_topic, runtime) => ({ value: runtime.info as unknown as JsonValue, subscribe: () => () => {} }));
topics.set("thread", async (topic, runtime) => {
	if (topic.kind !== "thread") throw new NodeError("bad_request", "thread topic");
	const { conversation } = await runtime.thread(topic.threadId);
	const state = await conversation.viewState(BACKGROUND_CONTEXT);
	return fromState(state, (view) => projectView(view) as unknown as JsonValue);
});

export class Connection {
	readonly #send: (frame: NodeFrame) => void;
	readonly #runtime: NodeRuntime;
	readonly #subs = new Map<number, { source?: TopicSource; stop?: () => void; closed: boolean }>();

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
		const handler = ops.get(op);
		try {
			if (!handler) throw new NodeError("unknown_op", `Unknown operation ${op}`);
			const value = await handler(args, this.#runtime);
			this.#send({ t: "res", id, ok: true, value });
		} catch (error) {
			const code = error instanceof NodeError ? error.code : ((error as { name?: string }).name ?? "error");
			this.#send({ t: "res", id, ok: false, error: { code, message: (error as Error).message ?? String(error) } });
		}
	}

	async #subscribe(sid: number, topic: Topic): Promise<void> {
		const entry: { source?: TopicSource; stop?: () => void; closed: boolean } = { closed: false };
		this.#subs.set(sid, entry);
		try {
			const handler = topics.get(topic.kind);
			if (!handler) throw new NodeError("unknown_topic", `Unknown topic ${topic.kind}`);
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

	close(): void {
		for (const sid of [...this.#subs.keys()]) this.#unsubscribe(sid);
	}
}
