// Pi views project ready content-keyed materializations. The ingestion worker owns
// full scans through the shared Session reader and published Rarebit selector.
// Window and range reads are explicit; a window never stands in for a full branch.

import type { OpSpec, PiTopicValue, ThreadSummary, ViewName, ViewTopic, ViewTopics } from "../../shared/protocol.ts";
import type { PiEntry } from "../../shared/protocol.ts";
import type { Derived } from "../working-set-types.ts";
import type { AskRequest, AskResult } from "../ask.ts";
import type { RarebitValue } from "./rarebit.ts";
import type { ModelPurpose } from "../../hub/helper-models.ts";
import type { TeamMessages } from "../../shared/team-messages.ts";

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
	/** Whole-line length of the Session file at its Host's last read, when the Host reports it. A copy with fewer bytes is still loading. */
	sourceBytes?: number;
	/** The sidebar's summary, when the Session is listed. */
	summary?: ThreadSummary;
	/** Bounded UI window. Whole-Session computations use data, never this window. */
	window(): PiEntry[];
	/** One page of Rarebit items before `before`; texts cut at 8 KiB unless `fullText`. */
	rarebits(before?: string, fullText?: boolean, around?: string): RarebitValue;
	rarebitSnapshot(maxChars: number): { context: string; evidenceHash: string; count: number; included: number; omittedChars: number; entry?: string };
	arcEvidence(ids: string[]): Map<string, string>;
	nearest(at: number): string | undefined;
	/** Entry timestamps (ms) by ID; null when the entry has none or is unknown. */
	entryTimes(ids: string[]): Map<string, number | null>;
};

export type SourceStatus = { version: string; asOf: number; state: "ready" | "stale" | "unavailable" };
export function sourceStatus(s: PiViewSession): SourceStatus {
 return { version: s.sourceVersion, asOf: s.data.asOf, state: s.readError || s.data.invalidLines ? "unavailable" : s.bytes === s.data.bytes && (s.sourceBytes === undefined || s.bytes >= s.sourceBytes) ? "ready" : "stale" };
}

export type PiTeamMember = { pane: string; session: string; team: string; member: string; role: string };
export type PiTeamTask = { id: string; title: string; status: string; owner?: string; deps: string[]; ready: boolean; updatedAt?: string };
/** A member as Pi Team Bright recorded it, with or without a live pane. */
export type PiRecordedMember = { team: string; member: string; role: string; session?: string; pane?: string };
/**
 * The remote agent's teams frame (pi-backend.md §2): Pi Team Bright's status and issue codes, members joined to live
 * panes, recorded members, and each Team's Task read by Team name.
 */
export type PiTeamsFrame = {
	t: "teams";
	status?: string;
	codes?: string[];
	members?: PiTeamMember[];
	recorded?: PiRecordedMember[];
	tasks?: Record<string, { availability: string; tasks: PiTeamTask[]; issues: string[] }>;
	messages?: Record<string, TeamMessages>;
};

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
	teamsFrame(): PiTeamsFrame | undefined;
	/** Whether Session team roles are read: after the first teams frame, or always when Teams are off. Absent: read. */
	rolesKnown?(): boolean;
	/** Send one command to the Host's remote agent (pi-backend.md §2); resolves with its ack, rejects with `code`. */
	command(cmd: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>;
	/**
	 * One isolated model call on the hub (`src/pi/ask.ts`): no Session, tools, or extensions; the hub's Pi credentials.
	 * Only on an explicit owner action (D16). `purpose` picks the hub's helper model; `model` is only an owner override.
	 * The answer names the model that answered. Rejects with `code`: no_model, no_result, model_error, timeout, busy.
	 */
	ask(req: AskRequest & { purpose: ModelPurpose }): Promise<AskResult>;
	/** The exact `provider/id` that `ask` would use for `purpose` and `override`; rejects like `ask` with `no_model`. A
	 * Build checks its models with it before its first call, so a missing model costs nothing. */
	model(purpose: ModelPurpose, override?: string): Promise<string>;
	/** Ask the host to recompute this view's subscriptions (for state that changed outside Session bytes). */
	invalidate(view: string): void;
};

type ViewOp<S> = S extends OpSpec<infer A, infer R> ? (ctx: PiViewContext, args: A) => Promise<R> : never;

/** A view as declared: its topic, value and ops are the ones `ViewTopics` (protocol.ts) declares for its name. */
export type PiView<N extends ViewName> = {
	name: N;
	/** Release per-Session state when its disk copy leaves the retained scope. */
	evict?(ctx: PiViewContext, threadId: string): void;
	/**
	 * The published value for one subscription, or undefined for "no such thing" (the subscription ends). If it throws,
	 * subscribers get `{ error: { code: "view_failed", message } }` and the next change retries; the client shows it.
	 */
	value(ctx: PiViewContext, topic: ViewTopic<N>): ViewTopics[N]["value"] | undefined;
	/** Requests `view.<name>.<op>`; the Host dispatches them through `viewOps` (index.ts). */
	ops: { [O in keyof ViewTopics[N]["ops"]]: ViewOp<ViewTopics[N]["ops"][O]> };
	/**
	 * Which changes recompute a subscription: "thread" (default) changes to the topic's own `threadId`; "any" every
	 * change on the Host (timeline-like views; memoize per Session and keep the value compact, since it is diffed whole).
	 * A topic without `threadId` recomputes as "any". A per-Session view reads host state only through its
	 * PiViewSession and `ctx.teams()`. A Herdr, Teams or limits frame therefore marks only the Sessions whose host inputs
	 * changed (host.ts #hostInputs), and recomputes "any" views only when a Session or a host-wide value changed; an
	 * identical frame recomputes nothing. State that changes outside these (a finished model call) calls
	 * `ctx.invalidate(view)`.
	 */
	scope?: "thread" | "any";
	/**
	 * Compact fields this view adds to a Session's thread-index row (ThreadSummary). Runs on every threads publish, so
	 * it reads only small persisted heads: no tree, transcript, or model call.
	 */
	summarize?(ctx: PiViewContext, session: PiViewSession): Partial<ThreadSummary> | undefined;
	/** Sessions whose copy or host inputs changed since the last publish. May start background work; must not block. */
	changed?(ctx: PiViewContext, sessions: PiViewSession[]): void;
};

/** Every view, by name. */
export type PiViews = { [N in ViewName]: PiView<N> };

/**
 * A view as the Host runs it: looked up by the topic's `view` string. Views enter only through `PiViews`, so each is
 * checked against its declaration; ops never run through this type.
 */
export type HostedView = Omit<PiView<ViewName>, "name" | "value" | "ops"> & {
	name: string;
	value(ctx: PiViewContext, topic: ViewTopic): PiTopicValue | undefined;
};
