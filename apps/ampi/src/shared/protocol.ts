// ampi/1: the wire protocol between an AmPi node (owner of one pi-durable Harness on one host), the hub, and
// render-only clients. Frames are JSON objects, one per line on byte streams (unix socket, SSH stdio) and one per
// message on WebSockets. The node is the only authority; clients send requests and apply view deltas.

import type { Op } from "@earendil-works/chord/delta";
import type { HostState } from "../hub/hosts.ts";
import type { ModelChoice } from "../node/models.ts";
import type { SearchResult } from "../pi/search.ts";
import type { ArcListValue, ArcValue } from "../pi/views/cos-arc.ts";
import type { TimelineValue } from "../pi/views/cos-timeline.ts";
import type { RarebitRecap, RarebitSide, RarebitValue } from "../pi/views/rarebit.ts";
import type { TeamValue } from "../pi/views/team.ts";

export const PROTOCOL = "ampi/1";

/**
 * Request from a client. `id` is unique per connection; the response echoes it. On the wire `op` is any string: the
 * receiver declares what it serves (`Ops`, `NodeOps`, `HubOps`) and refuses the rest with `unsupported`.
 */
export type RequestFrame = { t: "req"; id: number; op: string; args?: unknown };
export type ResponseFrame<V = unknown> =
	| { t: "res"; id: number; ok: true; value?: V }
	| { t: "res"; id: number; ok: false; error: { code: string; message: string; pane?: string; matches?: string[] } };

/** Open a subscription to a topic; the node answers with one `snap` and then `ops` frames until `unsub`. */
export type SubscribeFrame = { t: "sub"; sid: number; topic: Topic };
export type UnsubscribeFrame = { t: "unsub"; sid: number };
export type SnapshotFrame<V = unknown> = { t: "snap"; sid: number; value: V };
/** `n` counts ops frames since the snapshot (1, 2, …); a gap means the replica diverged and must resubscribe. */
export type OpsFrame = { t: "ops"; sid: number; n: number; ops: readonly Op[] };
/** Final: the node closed the subscription; no frame follows for this `sid`. */
export type SubscriptionEndFrame = { t: "end"; sid: number; reason: string };
/**
 * Not final: the topic has no value yet (a Session the Host does not list). The subscription stays open, and a `snap`
 * follows when the value appears. `reason` says what the reader sees meanwhile.
 */
export type SubscriptionPendingFrame = { t: "pending"; sid: number; reason: string };

/** Sent by the node first on every connection. */
export type HelloFrame = { t: "hello"; protocol: string; node: NodeInfo };

export type Topic =
	| { kind: "threads" }
	| { kind: "thread"; threadId: string }
	| { kind: "team"; teamId: string }
	| { kind: "rarebit"; threadId: string }
	| { kind: "terms" }
	| { kind: "term"; termId: string }
	| { kind: "login"; loginId: string }
	| { kind: "node" }
	/** A hub-side view of a Pi Host (src/pi/views): `view` names it; `threadId` scopes it to one Session. */
	| ViewTopic;

export type ClientFrame = RequestFrame | SubscribeFrame | UnsubscribeFrame | { t: "ping" };
/** What a host link emits, with its op results `R` and topic values `V`. */
export type HostFrame<R = unknown, V = unknown> =
	| HelloFrame
	| ResponseFrame<R>
	| SnapshotFrame<V>
	| OpsFrame
	| SubscriptionEndFrame
	| SubscriptionPendingFrame
	| { t: "pong" };
/** The frozen node backend's frames: outside the typed contract (docs/wire-boundary.md). */
export type NodeFrame = HostFrame;
/** A Pi Host's frames: every value is a declared op result or topic value. */
export type PiHostFrame = HostFrame<OpResult, PiTopicValue>;

export type NodeInfo = {
	/** Stable per storage: survives restarts. */
	nodeId: string;
	hostname: string;
	platform: string;
	user: string;
	home: string;
	version: string;
	/** Source fingerprint; differs from the hub's when the host runs an older or newer build. */
	build: string;
	pid: number;
	startedAt: number;
	storage: string;
};

/** Execution activity of a thread, derived from committed pi.live and pi.inbox (P5: one axis only). */
export type Activity = "idle" | "thinking" | "streaming" | "tools" | "retrying" | "compacting" | "waiting";

/** One row of the thread index, as clients see it. */
export type ThreadSummary = {
	id: string;
	title: string;
	cwd: string;
	createdAt: number;
	updatedAt: number;
	kind: "thread" | "worker" | "subagent" | "fork";
	parentId?: string;
	/** Team this thread leads or works for, when any. */
	team?: { teamId: string; role: "lead" | "worker"; worker?: string };
	archived?: boolean;
	model?: string;
	activity: Activity;
	queued: number;
	/** Last generation failure that ended a run; cleared by the next successful answer. */
	lastError?: string;
	/** Rarebit Summary status projection (C4), node Sessions only; undefined means unknown. */
	rarebit?: { status: string; reason?: string; asOf: number; fresh: boolean };
	/**
	 * Pi backend: the tier-2 Arc context head (C4, D16); undefined means not built. `asks` lists open Needs-you asks
	 * per kind with the oldest ask time (ms, null when unknown); `finished` means every tier-2 thread is done and
	 * nothing is open. An Assessment, never runtime, Task, or Project truth.
	 */
	arc?: { builtAt: string; stale: boolean; newMessages: number; finished: boolean; asks: { kind: "decision" | "approval" | "input" | "blocker"; n: number; since: number | null }[]; overtaken?: number };
	/** Positive evidence from other authorities that the owner is needed (for example a blocked or failed Task). */
	attention?: { source: string; reason: string }[];
	costUsd: number;
	contextTokens?: number;
	contextWindow?: number;
	workingBudget?: number;
	/** Pi backend: percent of the latest assistant prompt read from cache. */
	cacheHit?: number;
	/** The newest user/assistant prose, at most 160 characters, for the sidebar. */
	preview?: string;
	/** Pi backend: Host-qualified citation of the Session (`<host>/pi:<id>`). */
	ref?: string;
	/** Pi backend: where Herdr shows this Session. Auxiliary layout, not identity. */
	location?: { workspace?: string; workspaceLabel?: string; tab?: string; tabLabel?: string; pane?: string };
	/** Pi backend: a pane or the control extension runs this Session now. */
	live?: boolean;
	/** Pi backend: actions go through the control extension (admission evidence), not keys. */
	control?: boolean;
};

/** Herdr's workspace → tab → pane order on a Pi Host. */
export type HerdrLayout = { workspaces: { id: string; label?: string; tabs: { id: string; label?: string; panes: string[] }[] }[] };

/** A Pi Session's thread id: `pi:` and the Session id. The threads map declares its keys with it. */
export type PiThreadId = `pi:${string}`;
export const isPiThreadId = (id: string): id is PiThreadId => id.startsWith("pi:");
/**
 * What a Pi Host's list does not know yet. `indexing`: the working set has not initialized, so the list holds saved
 * state only and an empty list proves no absence. `listing`: no agents list since the Host connected, so no row has
 * liveness or a pane yet. `updating`: the startup refresh of saved copies still runs.
 */
export type ThreadsState = { threads: { [id: PiThreadId]: ThreadSummary }; layout?: HerdrLayout; backend?: "pi"; indexing?: true; listing?: true; updating?: true };

// ---- Pi entry shapes (docs/wire-boundary.md, design 4 and 5) ----
// The projection (src/pi/projection.ts) and the versioned index rows are their only constructors. They carry no
// model, usage, cost or other native field: billing stays in the hub.

/**
 * A tool call's arguments as the transcript shows them: one flat shape for every tool. `summary` is the call's one
 * line. The whole preview serializes within one bound (boundToolArgs); past it the summary and as many targets as
 * fit remain, `omitted` names every cut, and the block sets `argsClipped`.
 */
export type ToolArgsPreview = {
	summary: string;
	command?: string;
	path?: string;
	paths?: string[];
	edits?: { oldText: string; newText: string }[];
	content?: string;
	text?: string;
	/** What the bound cut: a count of dropped paths or edits, or `true` for a shortened or dropped field. */
	omitted?: ToolArgsOmitted;
};
export type ToolArgsOmitted = { summary?: true; path?: true; command?: true; paths?: number; edits?: number; content?: true; text?: true };
export type PiBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string; clipped?: boolean }
	| { type: "tool"; callId: string; name: string; args: ToolArgsPreview; argsClipped?: boolean }
	| { type: "image"; mimeType: string };
/** Who injected a message into the Session. `other` is any extension this list does not know. */
export type InjectedKind = "intercom" | "alert" | "direct-message" | "team-update" | "auto-compact" | "other";
/**
 * One message an extension injected into the Session, as its row shows it (rule 2): `label` is the kind badge,
 * `text` the first message's body. A delivery of several messages lists each in `parts`.
 */
export type InjectedMessage = { kind: InjectedKind; label: string; sender?: string; text: string; parts?: { from?: string; text: string }[] };
/** A card the preview shortened at its own bound; the card offers the source entry of `clippedBytes` UTF-8 bytes. */
export type PiClipped = { clipped?: boolean; clippedBytes?: number };
export type PiEntry = { bodyAvailable?: boolean } & (
	| { id: string; kind: "user"; ts?: number; text: string; images: number }
	| { id: string; kind: "assistant"; ts?: number; blocks: PiBlock[]; stop?: string; error?: string }
	| ({ id: string; kind: "tool-result"; ts?: number; callId: string; name: string; isError: boolean; text: string; truncated: boolean } & PiClipped)
	| ({ id: string; kind: "compaction"; summary: string; reason?: string; ts?: number } & PiClipped)
	| { id: string; kind: "reset"; handoff?: string; ts?: number }
	| { id: string; kind: "system"; changed: string[] }
	| ({ id: string; kind: "custom"; entryKind: string; ts?: number; message: InjectedMessage } & PiClipped)
);
/** One undelivered submission as the composer shows it. */
export type PiQueuedItem = { id: string; mode: string; content: string; state: ControlSubmission["state"] | "unknown"; truncated?: boolean };
/** A Pi Session's thread topic. `live.run` is present while the Session runs a turn. */
export type PiThreadView = {
	/** Content key for bounded Pi pages and body reads. */
	sourceVersion?: string;
	conversationId: string;
	/** Entries before the window that this view does not carry. */
	hiddenBefore: boolean;
	entries: PiEntry[];
	live: { run?: { activity?: Activity } };
	inbox: { items?: PiQueuedItem[] };
	/** `model`: the Session's latest model, as the threads list shows it. */
	agent: { cwd?: string; asOf?: number | null; readError?: string | null; model?: string };
	usage: { costUsd?: number };
};

// ---- The hub → browser contract (docs/wire-boundary.md) ----
// One registry declares every op and topic a Pi Host, its views and the hub serve, with their arguments and values.
// PiHost, PiView and the web client are typed by it; the hub relays frames unchanged.

/** One op's arguments and result. */
export type OpSpec<A, R> = { args: A; result: R };
/** A result that carries nothing. */
export type Done = Record<string, never>;
/** No parameters or no ops: an empty object type that adds no keys to an intersection or mapped type. */
// biome-ignore lint: `{}` is the empty set of keys here
export type None = {};

/**
 * One input the Session control admitted into Pi's queue, as the control reports it (P7: admission is not delivery).
 * `returned`: it left the queue undelivered and Pi's editor draft holds it (abort, dequeue). `dropped`: it left
 * undelivered and the draft does not hold it. Delivered ones carry no text: the Session file has it.
 */
export type ControlSubmission = { submission: string; deliverAs: "steer" | "followUp"; state: "queued" | "delivered" | "returned" | "dropped"; at: number; entryId?: string; text?: string; truncated?: boolean };
/**
 * An action's reply: how it was delivered, its evidence, the Session entry it made when the Host names one, the
 * queued submission it made, and, for abort, what became of each queued submission.
 */
export type ActionAck = { via?: string; evidence?: string; entryId?: string; submission?: string; submissions?: ControlSubmission[] };
/**
 * A Pi Session's slash commands, from its live control (packages/pi-hc-control README, Slash commands).
 * `supported: false`: a TUI-only built-in that runs only in the Pi pane.
 */
export type SlashCommand = { name: string; description?: string; argsHint?: string; source: "builtin" | "extension" | "prompt" | "skill"; supported: boolean };
export type SlashCommands = { commands: SlashCommand[]; models: { ref: string; name?: string }[]; model: string | null; thinkingLevels: string[]; thinking?: string };
/**
 * A slash command's outcome. `handled`: a typed call returned and no user entry exists. `started`/`queued`: a skill or
 * template became a message, as for submit. `dispatched`: Pi has the extension command; its result shows in the pane.
 * `effect` is advisory: the model card reads the Session file.
 */
export type CommandAck = {
	via?: string;
	disposition: "handled" | "started" | "queued" | "dispatched";
	notice?: string;
	/** `/thinking`: `thinking` is the level Pi applied after clamping, `requested` the level asked for. */
	effect?: { model?: string; thinking?: string; requested?: string; changed?: boolean; name?: string };
	evidence?: string;
	entryId?: string;
	submission?: string;
};
/** Where Herdr puts a new pane: beside a running Session's pane, or in a new workspace. */
export type Placement = { beside: string; direction?: "right" | "down" } | { workspace: "new"; label?: string };
/** What became of a create's first prompt: typed into the pane, or the reason it was not. */
export type SubmittedPrompt = { via?: string; evidence?: string; error?: { code: string; message: string } };
/** `pending`: Pi has not written the Session file yet; the thread is listed from the create. */
export type ThreadCreated = { threadId: string; pane: string; evidence?: string; submitted?: SubmittedPrompt; warning?: string; pending?: true };
export type ThreadResumed = { threadId: string; pane: string; evidence?: string; warning?: string };
export type HistoryPage = { entries: PiEntry[]; more: boolean; version?: string };
/** One page of an entry's projected text; `next` is the offset of the following page. */
export type EntryPage = { text: string; next: number; more: boolean; version: string };
export type FleetSearchResult = SearchResult & { hostStatus: HostState["status"] };
export type PromptList = { prompts: { name: string; description: string; body: string }[]; skills: { name: string; description: string; path: string }[] };

/** Ops a Pi Host serves itself (src/pi/host.ts). */
export type HostOps = {
	"thread.submit": OpSpec<{ threadId: string; content: string; whenBusy?: "steer" | "followUp"; requestId?: string; images?: { data: string; mimeType: string }[] }, ActionAck>;
	"thread.abort": OpSpec<{ threadId: string }, ActionAck>;
	"thread.withdraw": OpSpec<{ threadId: string; submissionId: string }, { withdrawn: boolean }>;
	"thread.commands": OpSpec<{ threadId: string }, SlashCommands>;
	/** `key` makes a retry return the first reply; `abort` lets /compact stop a running turn. */
	"thread.command": OpSpec<{ threadId: string; name: string; args?: string; key?: string; abort?: boolean; whenBusy?: "steer" | "followUp" }, CommandAck>;
	"thread.create": OpSpec<{ requestId: string; cwd: string; place: Placement; name?: string; prompt?: string }, ThreadCreated>;
	"thread.resume": OpSpec<{ requestId: string; threadId: string; place: Placement; cwd?: string; name?: string }, ThreadResumed>;
	"thread.close": OpSpec<{ threadId: string; lastPane?: boolean }, ActionAck>;
	"sessions.search": OpSpec<{ query: string }, FleetSearchResult>;
	"thread.find": OpSpec<{ threadId: string; query: string }, SearchResult>;
	"thread.history": OpSpec<{ threadId: string; limit?: number; before?: string; around?: string; version?: string }, HistoryPage>;
	"thread.entry": OpSpec<{ threadId: string; entry: string; offset?: number; version?: string }, EntryPage>;
	"prompts.list": OpSpec<{ cwd?: string }, PromptList>;
	"models.list": OpSpec<Done, ModelChoice[]>;
};

export type RarebitAskArgs = { threadId: string; sideId?: string; question?: string; model?: string; end?: boolean };
/** `{}` after `end`; otherwise the side conversation with its newest turn answered or failed. */
export type RarebitAskResult = { side: RarebitSide } | Done;
/** The Arc a Session has not got: it is outside the Host's local copies. */
export type ArcMissing = { missing: true; notice: string };

/**
 * Views a Pi Host serves (src/pi/views), keyed by view name: the topic's parameters, the published value, and the
 * ops, requested as `view.<name>.<op>`.
 */
export type ViewTopics = {
	rarebit: {
		params: { threadId: string; before?: string };
		value: RarebitValue;
		ops: {
			ask: OpSpec<RarebitAskArgs, RarebitAskResult>;
			/** `cachedOnly` answers from the cache, or null, and never starts a model call. */
			recap: OpSpec<{ threadId: string; model?: string; cachedOnly?: boolean }, RarebitRecap | null>;
		};
	};
	team: { params: { threadId?: string }; value: TeamValue; ops: None };
	"cos.timeline": { params: None; value: TimelineValue; ops: { locate: OpSpec<{ threadId: string; at: number }, { entry?: string; ref: string }> } };
	/** Without `threadId`, the Host's list of Sessions with Arc heads. */
	"cos.arc": { params: { threadId?: string }; value: ArcValue | ArcListValue | ArcMissing; ops: { build: OpSpec<{ threadId: string; model?: string }, { started: true }> } };
};
export type ViewName = keyof ViewTopics;
/** A topic of one view; the default is the union over every view. */
export type ViewTopic<N extends ViewName = ViewName> = { [K in N]: { kind: "view"; view: K; threadId?: string } & ViewTopics[K]["params"] }[N];
/** What a view's subscribers get when its value throws; the next change retries. */
export type ViewFailure = { error: { code: "view_failed"; message: string } };
export type ViewValue<N extends ViewName = ViewName> = { [K in N]: ViewTopics[K]["value"] | ViewFailure }[N];

type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends (i: infer I) => void ? I : never;
type Flat<T> = { [K in keyof T]: T[K] };
/** Every view op under its request name, `view.<name>.<op>`. */
export type ViewOps = Flat<UnionToIntersection<{ [N in ViewName]: { [O in keyof ViewTopics[N]["ops"] & string as `view.${N}.${O}`]: ViewTopics[N]["ops"][O] } }[ViewName]>>;

/** Every op a Pi Host serves. */
export type Ops = Flat<HostOps & ViewOps>;
export type OpName = keyof Ops;
export type OpResult<K extends OpName = OpName> = { [P in K]: Ops[P]["result"] }[K];
/** One handler per op: what PiHost dispatches. A missing or extra op, or a wrong result, fails to compile. */
export type OpHandlers<K extends OpName = OpName> = { [P in K]: (args: Ops[P]["args"]) => Promise<Ops[P]["result"]> };
/** A request for one op, its name correlated with its arguments. */
export type OpRequest<K extends OpName = OpName> = { [P in K]: { op: P; args: Ops[P]["args"] } }[K];

/** Topic values a Pi Host publishes besides its views. */
export type PiTopicValues = { threads: ThreadsState; thread: PiThreadView; node: { backend: "pi"; host: string } };
export type PiTopicValue = PiTopicValues[keyof PiTopicValues] | ViewValue;

/**
 * The frozen pi-durable node backend (src/node/server.ts) declares no wire types: it is outside rule 1 until its
 * revival adopts this contract (docs/wire-boundary.md). The browser reads its values as it always has.
 */
// biome-ignore lint: the frozen node backend has no declared wire types
export type NodeUntyped = any;
/** Topics only the node backend serves. */
export type NodeTopicValues = { terms: NodeUntyped; term: NodeUntyped; team: NodeUntyped; login: NodeUntyped; rarebit: NodeUntyped };
/** Ops only the node backend serves, and node arguments of ops both serve (results stay the Pi Host's). */
export type NodeOps = {
	"thread.create": OpSpec<{ requestId: string; cwd: string; model?: { provider: string; modelId: string }; prompt?: string }, { threadId: string }>;
	"thread.compact": OpSpec<{ threadId: string }, NodeUntyped>;
	"thread.configure": OpSpec<{ threadId: string; model?: { provider: string; modelId: string }; thinkingLevel?: string }, NodeUntyped>;
	"thread.rename": OpSpec<{ threadId: string; title: string }, NodeUntyped>;
	"thread.fork": OpSpec<{ threadId: string; entryId: string }, { threadId: string }>;
	"thread.images": OpSpec<{ threadId: string; entryId: string; index: number }, { image?: { data: string; mimeType: string } }>;
	"compact.records": OpSpec<{ threadId: string }, { records: NodeUntyped[] }>;
	"rarebit.summarize": OpSpec<{ threadId: string }, NodeUntyped>;
	"git.changes": OpSpec<{ cwd?: string }, NodeUntyped>;
	"fs.dirs": OpSpec<{ path: string; hidden?: boolean }, { path: string; parent: string; dirs: string[] }>;
	"node.restart": OpSpec<Done, NodeUntyped>;
	"accounts.list": OpSpec<Done, NodeUntyped[]>;
	"accounts.login": OpSpec<{ providerId: string; type: string }, { id: string }>;
	"accounts.answer": OpSpec<{ loginId: string; promptId: string; value: string }, NodeUntyped>;
	"accounts.cancel": OpSpec<{ loginId: string }, NodeUntyped>;
	"accounts.logout": OpSpec<{ providerId: string }, NodeUntyped>;
	"term.open": OpSpec<{ cwd?: string; cols?: number; rows?: number; title?: string }, { id: string }>;
	"term.input": OpSpec<{ termId: string; data: string }, NodeUntyped>;
	"term.resize": OpSpec<{ termId: string; cols: number; rows: number }, NodeUntyped>;
	"term.close": OpSpec<{ termId: string }, NodeUntyped>;
};

/** What the browser may request of a host: the Pi Host's ops and the node backend's, merged by name. */
export type ClientOps = {
	[K in OpName | keyof NodeOps]: K extends OpName
		? OpSpec<Ops[K]["args"] | (K extends keyof NodeOps ? NodeOps[K]["args"] : never), Ops[K]["result"]>
		: K extends keyof NodeOps ? NodeOps[K] : never;
};
/** The value the browser gets for a topic. */
export type TopicValue<T extends Topic> = T extends { kind: "view"; view: infer N extends ViewName }
	? ViewValue<N>
	: T extends { kind: infer K extends keyof PiTopicValues } ? PiTopicValues[K]
	: T extends { kind: infer K extends keyof NodeTopicValues } ? NodeTopicValues[K]
	: never;

/** Ops the hub serves itself (src/hub/hub.ts), on its own `hub` channel. */
export type HubOps = {
	"hosts.add": OpSpec<{ target: string; label?: string }, { id: string }>;
	"hosts.remove": OpSpec<{ id: string }, Done>;
	"hosts.reconnect": OpSpec<{ id: string }, Done>;
};
/** The hub's broadcast of every host link's state, after any change. */
export type HostsFrame = { t: "hosts"; hosts: HostState[] };
