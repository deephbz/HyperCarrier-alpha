// Pi views project ready content-keyed materializations. The ingestion worker owns
// full scans through the shared Session reader and published Rarebit selector.
// Window and range reads are explicit; a window never stands in for a full branch.

import type { ThreadSummary } from "../../shared/protocol.ts";
import type { UiEntry } from "../../node/projection.ts";
import type { Derived } from "../working-set-types.ts";
import type { RarebitValue } from "./rarebit.ts";

/** One reader entry, as the trace-analytics transcript reader returns it (pi-backend.md §3). */
export type PiReaderEntry = {
	ref: string;
	id: string;
	parent: string | null;
	t: number | null;
	/** Original prose length for chunk boundaries after text is bounded. */
	bodyChars?: number;
	kind: string;
	name?: string;
	role?: string;
	model?: string;
	provider?: string;
	usage?: { input?: number | null; output?: number | null; cacheRead?: number | null; cacheWrite?: number | null; cost?: number | { total?: number | null } | null } | null;
	blocks?: { type: string; text?: string; id?: string; name?: string; args?: unknown; mimeType?: string }[];
	result?: { callId: string; isError: boolean; text: string };
	customType?: string;
	summary?: string;
	text?: string;
	/** The assistant turn's native stop reason (`stop`, `toolUse`, `error`, ...), and its error text. */
	stop?: string;
	error?: string;
};

export type PiViewSession = {
	/** `pi:<sessionId>`, the GUI's thread ID. */
	threadId: string;
	/** `<host>/pi:<sessionId>`. */
	ref: string;
	/** The Session file's path on its Host. */
	path: string;
	/** The local append-only copy of that file (whole lines only). Read it only through a published reader. */
	copyFile: string;
	/** Process-local notification counter. Persistent validity uses sourceVersion. */
	revision: number;
	sourceVersion: string;
	readError?: string;
	data: Derived;
	/** Bytes of the Session file absorbed into the copy so far. */
	bytes: number;
	/** The sidebar's summary, when the Session is listed. */
	summary?: ThreadSummary;
	/** Bounded UI window. Whole-Session computations use data, never this window. */
	window(): UiEntry[];
	/** One page of Rarebit items before `before`; texts cut at 8 KiB unless `fullText`. */
	rarebits(before?: string, fullText?: boolean): RarebitValue;
	rarebitSnapshot(maxChars: number): { context: string; evidenceHash: string; count: number; included: number; omittedChars: number; entry?: string };
	arcEvidence(ids: string[]): Map<string, string>;
	nearest(at: number): string | undefined;
	/** Entry timestamps (ms) by ID; null when the entry has none or is unknown. */
	entryTimes(ids: string[]): Map<string, number | null>;
};

export type SourceStatus = { version: string; asOf: number; state: "ready" | "stale" | "unavailable" };
export function sourceStatus(s: PiViewSession): SourceStatus {
 return { version: s.sourceVersion, asOf: s.data.asOf, state: s.readError || s.data.invalidLines ? "unavailable" : s.bytes === s.data.bytes ? "ready" : "stale" };
}

export type PiTeamMember = { pane: string; session: string; team: string; member: string; role: string };

export type PiViewContext = {
	/** The Host ID (SSH alias, or the hub machine's hostname). */
	host: string;
	/** A private, rebuildable directory for this view on this Host (created on first use). */
	stateDir(view: string): string;
	sessions(): PiViewSession[];
	session(threadId: string): PiViewSession | undefined;
	/** Pi Team Bright membership joined to live Herdr panes and Session files. */
	teams(): PiTeamMember[];
	/** Runs `read` inside one store read transaction, so every Session read in it sees the same derived data. */
	snapshot<T>(read: () => T): T;
	/** Pin a copy for an in-flight operation; always release in finally. */
	lease(threadId: string): () => void;
	/** The latest raw teams frame from the remote agent (`status`, `codes`, and any published Team read it carries), or
	 * undefined before the first one. Distinguishes "Pi Team Bright unavailable" from "no Teams". */
	teamsFrame(): Record<string, unknown> | undefined;
	/** Send one command to the Host's remote agent (pi-backend.md §2); resolves with its ack, rejects with `code`. */
	command(cmd: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>;
	/**
	 * One isolated model call on the hub (`src/pi/ask.ts`): no Session, tools, or extensions; the hub's Pi credentials.
	 * Only on an explicit owner action (D16). Rejects with `code`: no_model, no_result, model_error, timeout, busy.
	 */
	ask(req: { system: string; prompt: string; model?: string; timeoutMs?: number }): Promise<{ text: string; model?: string; usage?: { input?: number; output?: number; cost?: number | null } }>;
	/** Ask the host to recompute this view's subscriptions (for state that changed outside Session bytes). */
	invalidate(view: string): void;
};

/** A topic for a view: `{ kind: "view", view: "<name>", ...params }`. `threadId`, when present, scopes recomputation. */
export type PiViewTopic = { kind: "view"; view: string; threadId?: string; [param: string]: unknown };

export type PiView = {
	name: string;
	/** Release per-Session state when its disk copy leaves the retained scope. */
	evict?(ctx: PiViewContext, threadId: string): void;
	/**
	 * The published value for one subscription, or undefined for "no such thing" (the subscription ends). If it throws,
	 * subscribers get `{ error: { code: "view_failed", message } }` and the next change retries; the client shows it.
	 */
	value(ctx: PiViewContext, topic: PiViewTopic): unknown;
	/** Requests `view.<name>.<op>`. */
	ops?: Record<string, (ctx: PiViewContext, args: Record<string, unknown>) => Promise<unknown>>;
	/**
	 * Which changes recompute a subscription: "thread" (default) changes to the topic's own `threadId`; "any" every
	 * change on the Host (timeline-like views; memoize per Session and keep the value compact, since it is diffed whole).
	 * A topic without `threadId` recomputes as "any". Herdr layout and teams frames count as a change to every Session.
	 * State that changes outside these (a finished model call) calls `ctx.invalidate(view)`.
	 */
	scope?: "thread" | "any";
	/**
	 * Compact fields this view adds to a Session's thread-index row (ThreadSummary). Runs on every threads publish, so
	 * it reads only small persisted heads: no tree, transcript, or model call.
	 */
	summarize?(ctx: PiViewContext, session: PiViewSession): Partial<ThreadSummary> | undefined;
	/** Sessions whose copy or liveness changed since the last publish. May start background work; must not block. */
	changed?(ctx: PiViewContext, sessions: PiViewSession[]): void;
};
