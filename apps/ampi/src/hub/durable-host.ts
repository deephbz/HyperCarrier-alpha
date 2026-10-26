// The hub's link to one durable node (node-design.md, "Runtime shape"). It wraps the node's HostLink and composes
// reader-builder's DurableViews into the Pi-shaped wire, so the web reads a durable host as it reads a Pi Host:
//
//   browser ─► hub ─► DurableHost ─┬─ view.*, sessions.search, thread.find/history/entry ─► DurableViews (hub copy)
//                                  ├─ thread topic = DurableViews.threadValue + the node's live and inbox
//                                  ├─ threads topic = node rows + DurableViews.summaryFields + view summarize fields
//                                  ├─ Team frame = the node's team topic (durable-team authority) of each lead row
//                                  └─ every other op and topic ─► HostLink ─► node, unchanged
//
// Handle lifetime: a thread keeps a node reader handle only while a browser subscribes to its thread topic (a
// DurableViews hold). Every other thread syncs once per change of its node row and closes its handle at once.

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { applyImmutable, diffRevisions } from "@earendil-works/chord/delta";
// @ts-ignore: shared reader is plain ESM.
import { exportDurableRecords, responseWriter, sessionIdOf } from "../../../trace-analytics/src/sources/durable.mjs";
import { DurableViews, type DurableReaderNode } from "../durable/reader-side.ts";
import { ask } from "../pi/ask.ts";
import { piModelRegistry } from "../pi/model-registry.ts";
import { PI_VIEWS } from "../pi/views/index.ts";
import type { PiRecordedMember, PiTeamsFrame, PiTeamTask } from "../pi/views/types.ts";
import { resolveHelperModel } from "./helper-models.ts";
import { type ClientFrame, type NodeFrame, THREAD_FIELDS, type ThreadSummary, type Topic } from "../shared/protocol.ts";
import { type HostConfig, HostLink, type HostState, linkKey } from "./hosts.ts";

type Row = ThreadSummary & Record<string, unknown>;
type ThreadsValue = { threads: Record<string, Row> } & Record<string, unknown>;
/** A browser subscription this link answers itself or composes; `node` is the node's value of a forwarded topic. */
type Composed = { sid: number; topic: Topic; n: number; sent?: unknown; node?: unknown; release?: () => void };

/** The fields a threads row takes from the reader: spend follows the one spend rule, and `ref` names the citation. */
const READER_FIELDS = ["costUsd", "spend", "spendLabel", "ref"] as const;
/** Reader fields a node row keeps when it has them. */
const FALLBACK_FIELDS = ["model", "contextTokens", "cacheHit", "preview"] as const;
/**
 * The longest one reader request (open, entries, fence, raw, cancel, close) waits for the node. A node that stays
 * connected but never answers fails the request with code `timeout`; the reader then closes its handle.
 */
export const READER_CALL_DEADLINE_MS = 30_000;
/**
 * Request IDs of `reader.open` come from their own range, below every other ID this link sends. A late open
 * answer, after its deadline or abort, then names its op by its ID alone: the link closes the handle it names
 * and keeps no record of dropped requests.
 */
const OPEN_IDS = -(2 ** 40);
const isOpenId = (id: number) => id <= OPEN_IDS;
/** Runs `expire` after `ms`; returns the cancel. Tests pass a fake clock. */
export type Deadline = (ms: number, expire: () => void) => () => void;
const realDeadline: Deadline = (ms, expire) => { const timer = setTimeout(expire, ms); timer.unref(); return () => clearTimeout(timer); };

const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const codeError = (code: string, message: string) => Object.assign(new Error(message), { code });

export class DurableHost extends EventEmitter {
	readonly config: HostConfig;
	readonly views: DurableViews;
	readonly #link: HostLink;
	/** Ids and sids this link sends for itself are negative; the hub's are positive. */
	#next = -1;
	#calls = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	/** The next `reader.open` request ID (OPEN_IDS). */
	#nextOpen = OPEN_IDS;
	#deadline: Deadline;
	#watches = new Map<number, { value: unknown; onFrame(frame: unknown): void; onEnd(reason: string): void }>();
	#subs = new Map<number, Composed>();
	/** The node's threads value from this link's own subscription: it drives tracking and the row merge. */
	#rows: Record<string, Row> = {};
	/** The node's whole `threads` value; ops patch it, since they also reach `layout`. */
	#rowsValue?: ThreadsValue;
	#rowsSid?: number;
	/** The node's `team` topic value (src/plugins/team-view.ts) of each lead row, by Team ID (the lead's thread ID). */
	#teams = new Map<string, { sid: number; value: unknown; ended?: string }>();
	/** Unheld syncs run one at a time, so a reconnect that syncs every thread opens one node handle at a time. */
	#queue: string[] = [];
	#draining = false;
	#node: DurableReaderNode;

	constructor(config: HostConfig, options: { deadline?: Deadline } = {}) {
		super();
		this.config = config;
		this.#deadline = options.deadline ?? realDeadline;
		this.#link = new HostLink(config);
		const home = config.home ?? process.env.AMPI_HOME ?? join(homedir(), ".ampi");
		const node = (this.#node = this.#readerNode());
		this.views = new DurableViews({
			host: config.id,
			cacheDir: join(home, "durable-cache", digest(config.id).slice(0, 16)),
			node: () => node,
			nodeSummary: (threadId) => this.#rows[threadId],
			teamsFrame: () => this.#teamsFrame(),
			hostStatus: () => this.state.status,
			// Helper models are hub state: Arc Builds and asks call the same hub path as a Pi Host (node-design.md, R2).
			ask: (req) => ask(req, config.askCommand),
			model: (purpose, override) => resolveHelperModel(purpose, override, config.askCommand?.length ? undefined : piModelRegistry),
			rawExportUrl: (threadId) => `/raw/pi-durable:${threadId}?host=${encodeURIComponent(linkKey(config))}`,
		});
		this.views.on("changed", (change: { threadId?: string }) => this.#recompose(change.threadId));
		this.#link.on("state", (state: HostState) => this.emit("state", state));
		this.#link.on("frame", (frame: NodeFrame) => this.#fromNode(frame));
		this.#link.on("connected", () => {
			this.#reset();
			this.#rowsSid = this.#next--;
			this.#link.send({ t: "sub", sid: this.#rowsSid, topic: { kind: "threads" } });
			this.emit("connected");
		});
		this.#link.on("disconnected", () => {
			this.#reset();
			this.emit("disconnected");
		});
	}

	get state(): HostState {
		return this.#link.state;
	}

	start(): void {
		this.#link.start();
	}

	reconnect(): void {
		this.#link.reconnect();
	}

	async stop(): Promise<void> {
		this.#reset();
		await this.#link.stop();
		await this.views.close();
	}

	/**
	 * A hub frame for the node. Reader ops and view topics are answered here; the rest goes to the node. A thread ID in
	 * its citation form (`pi-durable:<id>`) names the same thread as the bare ID.
	 */
	send(frame: ClientFrame): boolean {
		frame = bareThreadId(frame);
		if (frame.t === "req") {
			const local = (this.views.ops as Record<string, ((args: never) => Promise<unknown>) | undefined>)[frame.op];
			if (local) {
				void local((frame.args ?? {}) as never).then(
					(value) => this.emit("frame", { t: "res", id: frame.id, ok: true, value }),
					(error: Error & { code?: string }) => this.emit("frame", { t: "res", id: frame.id, ok: false, error: { code: error.code ?? "error", message: error.message } }),
				);
				return true;
			}
			if (this.#link.send(frame)) return true;
			this.emit("frame", { t: "res", id: frame.id, ok: false, error: { code: "host_unavailable", message: `Host ${this.config.id} is ${this.state.status}` } });
			return true;
		}
		if (frame.t === "sub") {
			this.#drop(frame.sid);
			const sub: Composed = { sid: frame.sid, topic: frame.topic, n: 0 };
			if (frame.topic.kind === "view") {
				this.#subs.set(frame.sid, sub);
				this.#publish(sub);
				return true;
			}
			if (frame.topic.kind === "thread") {
				const threadId = frame.topic.threadId;
				this.#subs.set(frame.sid, sub);
				void this.views.track(threadId).catch(() => {});
				sub.release = this.views.hold(threadId);
				// The entries come from the hub copy, so the node sends only the fields the copy lacks. Without a copy
				// (an ID the reader cannot parse) the node's full value is the thread value.
				if (this.views.has(threadId)) return this.#link.send({ ...frame, topic: { ...frame.topic, fields: [...THREAD_FIELDS] } });
			} else if (frame.topic.kind === "threads") this.#subs.set(frame.sid, sub);
			return this.#link.send(frame);
		}
		if (frame.t === "unsub") {
			const forwarded = this.#subs.get(frame.sid)?.topic.kind !== "view";
			this.#drop(frame.sid);
			return forwarded ? this.#link.send(frame) : true;
		}
		return this.#link.send(frame);
	}

	/**
	 * The thread's durable records as JSONL, streamed from the node a page at a time over the reader wire. A slow
	 * client holds each write until the response drains. A client that closes the response ends the export, and the
	 * export closes its node handle. A failure after the first byte destroys the response.
	 */
	async rawExport(threadId: string, res: ServerResponse): Promise<void> {
		const write = responseWriter(res);
		try {
			await exportDurableRecords({ node: this.#node, threadId, host: this.config.id, maxEntryBytes: RAW_ENTRY_BYTES, write, signal: write.signal,
				start: ({ version }: { version: string | null }) => res.writeHead(200, {
					"content-type": "application/x-ndjson",
					"content-disposition": `attachment; filename="pi-durable_${threadId.replace(/[^A-Za-z0-9._-]/g, "_")}.jsonl"`,
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
					"x-hypercarrier-source-version": version ?? "",
				}) });
			res.end();
		} catch (error) {
			if (res.headersSent) { res.destroy(error as Error); return; }
			const code = (error as { code?: string }).code;
			res.writeHead(code === "not_found" ? 404 : 503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
			res.end(JSON.stringify({ error: { code: code ?? "unavailable", message: (error as Error).message } }));
		}
	}

	/** One connection of the node's reader wire, over this link: ops are requests, the watch is a `reader` topic. */
	#readerNode(): DurableReaderNode {
		const call = (op: string) => (args: unknown, options?: { signal?: AbortSignal }) => this.#call(`reader.${op}`, args, options?.signal, READER_CALL_DEADLINE_MS);
		return {
			open: call("open"),
			entries: call("entries"),
			fence: call("fence"),
			raw: call("raw"),
			cancel: call("cancel"),
			close: call("close"),
			watch: async ({ handle }: { handle: string }, onFrame: (frame: unknown) => void, onEnd: (reason: string) => void) => {
				const sid = this.#next--;
				this.#watches.set(sid, { value: null, onFrame, onEnd });
				if (!this.#link.send({ t: "sub", sid, topic: { kind: "reader", handle } })) {
					this.#watches.delete(sid);
					throw codeError("unavailable", `Host ${this.config.id} is ${this.state.status}`);
				}
				return {
					stop: () => {
						if (this.#watches.delete(sid)) this.#link.send({ t: "unsub", sid });
					},
				};
			},
		};
	}

	/**
	 * One request to the node. An abort of `signal`, or `deadlineMs` without an answer, drops it at once with code
	 * `aborted` or `timeout`: a late answer finds no call.
	 */
	#call(op: string, args: unknown, signal?: AbortSignal, deadlineMs?: number): Promise<unknown> {
		const id = op === "reader.open" ? this.#nextOpen-- : this.#next--;
		return new Promise((resolve, reject) => {
			if (signal?.aborted) return reject(codeError("aborted", `${op} was aborted`));
			let cancel: (() => void) | undefined;
			const settle = () => { signal?.removeEventListener("abort", aborted); cancel?.(); };
			// Abort and deadline end the same way: the call goes, with its listener and its deadline.
			const drop = (code: string, message: string) => {
				if (!this.#calls.delete(id)) return;
				settle();
				reject(codeError(code, message));
			};
			const aborted = () => drop("aborted", `${op} was aborted`);
			signal?.addEventListener("abort", aborted, { once: true });
			if (deadlineMs !== undefined) cancel = this.#deadline(deadlineMs, () => drop("timeout", `Host ${this.config.id} did not answer ${op} within ${deadlineMs / 1000} s`));
			this.#calls.set(id, { resolve: (value) => { settle(); resolve(value); }, reject: (error) => { settle(); reject(error); } });
			if (!this.#link.send({ t: "req", id, op, args })) {
				this.#calls.delete(id);
				settle();
				reject(codeError("unavailable", `Host ${this.config.id} is ${this.state.status}`));
			}
		});
	}

	#fromNode(frame: NodeFrame): void {
		if (frame.t === "res" && frame.id < 0) {
			const call = this.#calls.get(frame.id);
			this.#calls.delete(frame.id);
			// An open that answers after it was dropped opened a handle nobody holds: close it.
			if (!call && isOpenId(frame.id) && frame.ok) void this.#call("reader.close", { handle: (frame.value as { handle: string }).handle }, undefined, READER_CALL_DEADLINE_MS).catch(() => {});
			if (frame.ok) call?.resolve(frame.value);
			else call?.reject(codeError(frame.error.code, frame.error.message));
			return;
		}
		if ((frame.t === "snap" || frame.t === "ops" || frame.t === "end") && frame.sid < 0) {
			if (frame.sid === this.#rowsSid) return this.#fromRows(frame);
			const team = [...this.#teams.values()].find((t) => t.sid === frame.sid);
			if (team) {
				// An ended subscription keeps no Team value: the Team shows unavailable until #followTeams resubscribes.
				if (frame.t === "end") { team.value = undefined; team.ended = frame.reason; }
				else team.value = frame.t === "snap" ? frame.value : applyImmutable(team.value, frame.ops as never);
				return this.#recompose();
			}
			const watch = this.#watches.get(frame.sid);
			if (!watch) return;
			if (frame.t === "end") {
				this.#watches.delete(frame.sid);
				watch.onEnd(frame.reason);
				return;
			}
			// The snapshot can already hold a frame (the watch fired before the node subscribed); ops patch the snapshot.
			watch.value = frame.t === "snap" ? frame.value : applyImmutable(watch.value, frame.ops as never);
			if (watch.value !== null) watch.onFrame(watch.value);
			return;
		}
		if (frame.t !== "snap" && frame.t !== "ops" && frame.t !== "end") return void this.emit("frame", frame);
		const sub = this.#subs.get(frame.sid);
		if (!sub || frame.t === "end") {
			if (sub) this.#drop(sub.sid);
			this.emit("frame", frame);
			return;
		}
		sub.node = frame.t === "snap" ? frame.value : applyImmutable(sub.node, frame.ops as never);
		this.#publish(sub);
	}

	/** The node's rows: a new thread is tracked, and a changed row of an unheld thread queues one sync. */
	#fromRows(frame: Extract<NodeFrame, { t: "snap" | "ops" | "end" }>): void {
		if (frame.t === "end") return;
		const value = (frame.t === "snap" ? frame.value : applyImmutable(this.#rowsValue, frame.ops as never)) as ThreadsValue;
		const before = this.#rows;
		this.#rowsValue = value;
		this.#rows = value?.threads ?? {};
		for (const [threadId, row] of Object.entries(this.#rows)) {
			if (!this.views.threads().includes(threadId)) this.#enqueue(threadId);
			else if (JSON.stringify(row) !== JSON.stringify(before[threadId])) this.#enqueue(threadId);
		}
		this.#followTeams();
		this.#recompose();
	}

	/** One node `team` subscription per lead row: the Team authority, not the transcript, names its Tasks. */
	#followTeams(): void {
		const leads = new Set(Object.values(this.#rows).flatMap((row) => row.team?.role === "lead" ? [row.team.teamId] : []));
		for (const [teamId, team] of this.#teams) if (!leads.has(teamId)) { this.#teams.delete(teamId); this.#link.send({ t: "unsub", sid: team.sid }); }
		for (const teamId of leads) {
			// The node dropped an ended subscription itself: the next rows change subscribes again, with no unsub.
			if (this.#teams.has(teamId) && this.#teams.get(teamId)?.ended === undefined) continue;
			const sid = this.#next--;
			this.#teams.set(teamId, { sid, value: undefined });
			this.#link.send({ t: "sub", sid, topic: { kind: "team", teamId } });
		}
	}

	/** The Pi-shaped Team frame (views/types.ts PiTeamsFrame) from the node's Team values; none before a lead row. */
	#teamsFrame(): PiTeamsFrame | undefined {
		if (!this.#teams.size) return undefined;
		const recorded: PiRecordedMember[] = [], tasks: NonNullable<PiTeamsFrame["tasks"]> = {}, messages: NonNullable<PiTeamsFrame["messages"]> = {};
		for (const [teamId, { value, ended }] of this.#teams) {
			// An ended Team keeps its lead, the Team ID's thread, and shows its Tasks unavailable: no stale Tasks.
			if (ended !== undefined) {
				recorded.push({ team: teamId, member: "lead", role: "lead", session: sessionIdOf(teamId) });
				tasks[teamId] = { availability: "unavailable", issues: ["task_authority_unavailable"], tasks: [] };
				messages[teamId] = { availability: "unavailable", reason: "Team message source disconnected. Reconnect the Host or check the Team authority." };
				continue;
			}
			const view = value as TeamTopicValue | undefined;
			if (!view?.team) continue;
			messages[teamId] = view.messages ?? { availability: "unavailable", reason: "Messages unavailable: this durable node does not publish message records." };
			recorded.push({ team: teamId, member: "lead", role: "lead", session: sessionIdOf(view.leadThreadId) });
			// A Worker joins once the reader holds its thread; before that the panel would show a live Worker as not running.
			for (const w of view.workers) if (w.membership.active && this.views.context.session(w.threadId)) recorded.push({ team: teamId, member: w.name, role: "worker", session: sessionIdOf(w.threadId) });
			tasks[teamId] = { availability: "available", issues: [], tasks: view.tasks.map((t): PiTeamTask => ({
				id: t.key, title: t.title, status: t.derived, ...(t.assignee ? { owner: t.assignee } : {}), deps: t.needs ?? [], ready: t.derived === "ready" })) };
		}
		const teams = [...this.#teams.values()];
		const status = teams.some((t) => t.ended !== undefined) ? "unavailable" : teams.every((t) => t.value !== undefined) ? "available" : "loading";
		return { t: "teams", status, recorded, tasks, messages };
	}

	#enqueue(threadId: string): void {
		if (!this.#queue.includes(threadId)) this.#queue.push(threadId);
		if (this.#draining) return;
		this.#draining = true;
		void (async () => {
			try {
				for (let next = this.#queue.shift(); next !== undefined; next = this.#queue.shift()) {
					// track() registers a new thread and syncs it; a known thread just syncs (coalesced in DurableViews).
					await this.views.track(next).catch(() => {});
				}
			} finally {
				this.#draining = false;
			}
		})();
	}

	/** The value a composed subscription shows now. */
	#value(sub: Composed): unknown {
		const topic = sub.topic;
		if (topic.kind === "view") return this.views.value(topic) ?? { error: { code: "view_failed", message: `No ${topic.view} view on this host` } };
		if (topic.kind === "thread") {
			const node = sub.node as { live?: unknown; inbox?: unknown } | undefined;
			const reader = this.views.threadValue(topic.threadId);
			return reader ? { ...reader, live: node?.live ?? {}, inbox: node?.inbox ?? {} } : node;
		}
		const node = sub.node as ThreadsValue | undefined;
		if (!node?.threads) return node;
		const threads: Record<string, Row> = {};
		for (const [threadId, row] of Object.entries(node.threads)) {
			const fields = this.views.summaryFields(threadId) as Record<string, unknown> | undefined;
			const merged: Record<string, unknown> = { ...row };
			for (const key of READER_FIELDS) if (fields?.[key] !== undefined) merged[key] = fields[key];
			for (const key of FALLBACK_FIELDS) if (merged[key] === undefined && fields?.[key] !== undefined) merged[key] = fields[key];
			// Each view's row fields (for example the Arc Build's `arc.asks`), as a Pi Host adds them to its rows.
			const session = this.views.context.session(threadId);
			if (session) for (const view of PI_VIEWS) if (view.summarize) Object.assign(merged, view.summarize(this.views.context, session));
			threads[threadId] = merged as Row;
		}
		return { ...node, threads };
	}

	#publish(sub: Composed): void {
		if (sub.topic.kind !== "view" && sub.node === undefined) return;
		const value = this.#value(sub);
		if (sub.sent === undefined) {
			sub.sent = value;
			this.emit("frame", { t: "snap", sid: sub.sid, value });
			return;
		}
		const ops = diffRevisions(sub.sent as never, value as never);
		sub.sent = value;
		if (ops.length > 0) this.emit("frame", { t: "ops", sid: sub.sid, n: ++sub.n, ops });
	}

	/** Republish what a reader change can reach: views, the changed thread's topic, and every threads list. */
	#recompose(threadId?: string): void {
		for (const sub of this.#subs.values()) {
			const topic = sub.topic;
			if (topic.kind === "thread" && threadId !== undefined && topic.threadId !== threadId) continue;
			this.#publish(sub);
		}
	}

	#drop(sid: number): void {
		const sub = this.#subs.get(sid);
		if (!sub) return;
		this.#subs.delete(sid);
		sub.release?.();
	}

	/** A connection change ends every subscription and call of the old connection; the hub resubscribes. */
	#reset(): void {
		for (const sid of [...this.#subs.keys()]) this.#drop(sid);
		for (const call of this.#calls.values()) call.reject(codeError("unavailable", `Host ${this.config.id} disconnected`));
		this.#calls.clear();
		const watches = [...this.#watches.values()];
		this.#watches.clear();
		for (const watch of watches) watch.onEnd("disconnected");
		this.#rowsSid = undefined;
		this.#rowsValue = undefined;
		this.#teams.clear();
	}
}

/** The fields of the node's `team` topic value (src/plugins/team-view.ts) that the Team frame reads. */
type TeamTopicValue = {
	messages?: import("../shared/team-messages.ts").TeamMessages;
	team: { name: string } | null;
	leadThreadId: string;
	tasks: { key: string; title: string; derived: string; assignee?: string; needs?: string[] }[];
	workers: { name: string; threadId: string; membership: { active: boolean } }[];
};

const CITED = "pi-durable:";
/** The raw export reads oversized records up to the node's export bound (durable-wire.mjs LIMITS.exportBytes). */
const RAW_ENTRY_BYTES = 64 << 20;

function bareThreadId(frame: ClientFrame): ClientFrame {
	if (frame.t === "req") {
		const args = frame.args as { threadId?: unknown } | undefined;
		if (typeof args?.threadId === "string" && args.threadId.startsWith(CITED)) return { ...frame, args: { ...args, threadId: args.threadId.slice(CITED.length) } };
	} else if (frame.t === "sub" && frame.topic.kind === "thread" && frame.topic.threadId.startsWith(CITED)) {
		return { ...frame, topic: { ...frame.topic, threadId: frame.topic.threadId.slice(CITED.length) } };
	}
	return frame;
}
