// ampi/1: the wire protocol between an AmPi node (owner of one pi-durable Harness on one host), the hub, and
// render-only clients. Frames are JSON objects, one per line on byte streams (unix socket, SSH stdio) and one per
// message on WebSockets. The node is the only authority; clients send requests and apply view deltas.

import type { JsonValue } from "@earendil-works/chord";
import type { Op } from "@earendil-works/chord/delta";
import type { HostState } from "../hub/hosts.ts";
import type { CompactRecord } from "@hypercarrier/auto-compact-durable";
import type { LoginState, ProviderStatus } from "../node/accounts.ts";
import type { ModelChoice } from "../node/models.ts";
import type { PromptAuditSnapshot } from "../plugins/prompt-audit.ts";
import type { UiEntry } from "../node/projection.ts";
import type { FindAsk, SearchResult } from "../pi/search.ts";
import type { Spend } from "./spend.ts";
import type { ArcListValue, ArcValue } from "../pi/views/cos-arc.ts";
import type { TimelineValue } from "../pi/views/cos-timeline.ts";
import type { RarebitSide, RarebitValue } from "../pi/views/rarebit.ts";
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

/** The thread topic fields a subscriber can ask for alone. */
export const THREAD_FIELDS = ["live", "inbox"] as const;
export type ThreadField = (typeof THREAD_FIELDS)[number];

export type Topic =
	| { kind: "threads" }
	/**
	 * `fields` limits the value to those fields, and the node then projects no entries. A hub that draws entries from
	 * its own copy asks for `live` and `inbox` only. A node that predates `fields` ignores it and sends the full value.
	 */
	| { kind: "thread"; threadId: string; fields?: ThreadField[] }
	| { kind: "team"; teamId: string }
	| { kind: "rarebit"; threadId: string }
	| { kind: "login"; loginId: string }
	| { kind: "node" }
	/** The reader watch of one handle this connection opened (`reader.open`): each frame is a WatchFrame. */
	| { kind: "reader"; handle: string }
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
/** A durable node's frames: every value is a declared node op result or topic value. */
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
	/** The node build the node booted with (shared/build.ts): a fingerprint of the node inputs, or `unknown`. */
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
	/** Rarebit Summary status projection (C4), node Sessions only; undefined means unknown. Legacy needs_attention is tolerated, but is not a Needs-you signal. */
	rarebit?: { status: string; reason?: string; asOf: number; fresh: boolean };
	/**
	 * Pi backend: the tier-2 Arc context head (C4, D16); undefined means not built. `asks` lists open Needs-you asks
	 * per kind with the oldest ask time (ms, null when unknown); `finished` means every tier-2 thread is done and
	 * nothing is open. An Assessment, never runtime, Task, or Project truth.
	 */
	arc?: { builtAt: string; stale: boolean; newMessages: number; finished: boolean; asks: { kind: "decision" | "approval" | "input" | "blocker"; n: number; since: number | null }[]; overtaken?: number };
	/** Live owner-attention signals. Legacy Team and Rarebit sources are tolerated but deprecated and ignored by Needs-you views. */
	attention?: { source: string; reason: string }[];
	costUsd: number;
	/** The cost figure with what it leaves out under the one spend rule (trace-analytics spend.mjs spendLabel). */
	spendLabel?: string;
	/** The figure behind `spendLabel` and the classes it counts, so a view can sum Sessions across backends. */
	spend?: Spend;
	contextTokens?: number;
	contextWindow?: number;
	workingBudget?: number;
	/** Pi backend: percent of the latest assistant prompt read from cache. */
	cacheHit?: number;
	/** The newest user/assistant prose, at most 160 characters, for the sidebar. */
	preview?: string;
	/** Pi backend: Host-qualified citation of the Session (`<host>/pi:<id>`). */
	ref?: string;
	/** Where the Session shows: a Herdr pane on a Pi Host, a tab (no pane) on a durable node. Layout, not identity. */
	location?: { workspace?: string; workspaceLabel?: string; tab?: string; tabLabel?: string; pane?: string };
	/** Pi backend: a pane or the control extension runs this Session now. Durable node: the thread is open (not closed). */
	live?: boolean;
	/** Actions go through typed control (the Pi control extension or the durable node) with admission evidence, not keys. */
	control?: boolean;
	/** The Session takes images in a message, under its carrier's limits. Absent: it takes none. */
	images?: ImageLimits;
	/**
	 * Durable node: the owner closed the thread (`by: "owner"`), or a thread that owns it (`lead` for a Team Worker,
	 * `owner thread` otherwise); it is read-only and has no Resume. A fork continues it.
	 */
	closed?: { at: number; by: string };
};

/**
 * A carrier's image limits for one message, in the units it checks (base64 characters as sent). The carrier owns
 * them and the Composer admits files only against them: Pi's from pi-hc-control `IMAGE_LIMITS`, the AmPi node's
 * from its submit check. A missing per-image or total limit means the carrier sets none.
 */
export type ImageLimits = { count: number; types: string[]; perImageBase64?: number; totalBase64?: number };

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
/** Invalid Pi settings a Host ignored, and the stamp of the settings files they come from: one notice per stamp. */
/** Invalid values a node ignored in its global Pi settings; `file` is that file's absolute path on the node. */
export type SettingsNotice = { stamp: string; errors: string[]; file: string };
export type ThreadsState = { threads: { [id: PiThreadId]: ThreadSummary }; layout?: HerdrLayout; backend?: "pi" | "durable"; indexing?: true; listing?: true; updating?: true; settingsNotice?: SettingsNotice };

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
	| ({ id: string; kind: "compaction"; summary: string; reason?: string; ts?: number; byTaskId?: string } & PiClipped)
	| { id: string; kind: "reset"; handoff?: string; ts?: number }
	| { id: string; kind: "system"; changed: string[] }
	// `rawExport`: the hub's URL for a body the hub copy holds only as a stub. The hub builds it, so the card links it
	// directly; model-authored markdown never carries it.
	| ({ id: string; kind: "custom"; entryKind: string; ts?: number; message: InjectedMessage; rawExport?: string } & PiClipped)
);
/** The outcome of `thread.editQueued`. */
export type EditQueuedResult = { edited: true } | { edited: false; reason: "taken" | "changed" | "unknown" };
/**
 * Who queued an input other than the owner, from the input's structured entry data, never from its text. A Team input
 * names its delivery kind (`notice` when an older producer did not record it), its author when the producer recorded
 * one, a one-line readable summary, and the exact Task ID a Task or stop names (absent when the ID is invalid or over
 * durable-team's limit). `interrupt` marks an Alert sent to interrupt the recipient's run. Absent: owner input, a Pi
 * Session (Pi records no origin), or an older node.
 */
export type QueueOrigin = { kind: "team"; delivery: "task" | "alert" | "stop" | "update" | "notice"; interrupt?: true; sender?: string; summary: string; taskId?: string };
/** Each field of `T`, optional ones included: a projection typed with it fails to compile when it leaves a field out. */
export type Every<T> = { [K in keyof Required<T>]: T[K] | undefined };
/** One undelivered submission as the composer shows it. `images`: how many images it carried; Pi returns text only, so a returned message loses them. */
export type PiQueuedItem = { id: string; mode: string; content: string; state: ControlSubmission["state"] | "unknown"; truncated?: boolean; images?: number; origin?: QueueOrigin };
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
	/** `models`: a durable thread's pi.usage model buckets, keyed `provider/modelId`, which its Info panel lists. A Pi Session has none. */
	usage: { costUsd?: number; models?: { [model: `${string}/${string}`]: UsageBucket } };
};

/** One pi.usage bucket: summed token counters and cost of the requests keyed by one model or tool. */
export type UsageBucket = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number; totalTokens?: number; cost?: { total?: number } };

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
export type ControlSubmission = { submission: string; deliverAs: "steer" | "followUp"; state: "queued" | "delivered" | "returned" | "dropped"; at: number; entryId?: string; text?: string; truncated?: boolean; images?: number; origin?: QueueOrigin };
/**
 * An action's reply: how it was delivered, its evidence, the Session entry it made when the Host names one, the
 * queued submission it made, and, for abort, what became of each queued submission.
 */
/**
 * A compaction Esc acted on. `outcome`: its task's final status (`aborted`, `completed`, `failed`), or `unknown` when
 * Esc's bounded wait ended first. `summary`, for a completed one: `placed`, `pending` (placed at the turn boundary),
 * `stale` (cut before the current context), or `none` (nothing to summarize).
 */
export type ControlCompaction = { taskId: string; reason: string; outcome: string; summary?: "placed" | "pending" | "stale" | "none" };
export type ActionAck = { via?: string; evidence?: string; entryId?: string; submission?: string; submissions?: ControlSubmission[]; compactions?: ControlCompaction[] };
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
	/** Read-only command output; the Composer keeps it outside model context. */
	body?: string;
	/** One-shot navigation hint, omitted when a keyed reply is replayed. */
	panel?: "team" | "rarebit";
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
/** `pane`: the Herdr pane of a Pi Session. `tab`: the tab a durable thread joined; a durable thread has no pane. */
export type ThreadCreated = { threadId: string; pane?: string; tab?: { id: string; label: string }; evidence?: string; submitted?: SubmittedPrompt; warning?: string; pending?: true };
export type ThreadResumed = { threadId: string; pane?: string; evidence?: string; warning?: string };
/** Compact navigation over the whole current branch. Ordinals are zero-based among projectable entries (non-null ui) on that branch. */
export type ThreadOutline = { version: string; totalEntries: number; users: { id: string; ordinal: number; firstLine: string }[]; truncated: boolean };

export type HistoryPage = { entries: PiEntry[]; more: boolean; version?: string };
/**
 * A read pinned to a `version` (`thread.history`, `thread.entry`) refuses with one of two codes:
 * - `stale_version`: the Session moved past that version. The read can succeed again at the newer version.
 * - `not_found`: the entry is not on the Session's current branch.
 * A `thread.history` miss while the Host still indexes the Session refuses with `indexing` instead: the entry may be in
 * bytes not indexed yet, so the read can succeed at a later version.
 */
export const STALE_VERSION = "stale_version";
export const NOT_FOUND = "not_found";
export const INDEXING = "indexing";
/** One page of an entry's projected text; `next` is the offset of the following page. */
export type EntryPage = { text: string; next: number; more: boolean; version: string };
export type FleetSearchResult = SearchResult & { hostStatus: HostState["status"] };
/**
 * `thread.find` before the Host has indexed the Session. The state is transient: the Host's next `thread` frame
 * that carries a `sourceVersion` announces the index, and the same request then succeeds.
 */
export type FindIndexing = { indexing: true };
export type FindReply = SearchResult | FindIndexing;
export type PromptList = { prompts: { name: string; description: string; body: string }[]; skills: { name: string; description: string; path: string }[] };

/** Ops a Pi Host serves itself (src/pi/host.ts). */
export type HostOps = {
	/**
	 * `asText: true` marks plain text that starts with `/` as the owner's choice to send it as a message (the composer's
	 * `//` escape or "Send as text"). The Host refuses an unmarked one with "This page is older than the hub. Reload it."
	 */
	"thread.submit": OpSpec<{ threadId: string; content: string; whenBusy?: "steer" | "followUp"; requestId?: string; images?: { data: string; mimeType: string }[]; asText?: true }, ActionAck>;
	"thread.abort": OpSpec<{ threadId: string }, ActionAck>;
	"thread.withdraw": OpSpec<{ threadId: string; submissionId: string }, { withdrawn: boolean }>;
	"thread.commands": OpSpec<{ threadId: string }, SlashCommands>;
	/** `key` makes a retry return the first reply; `abort` lets /compact stop a running turn. */
	"thread.command": OpSpec<{ threadId: string; name: string; args?: string; key?: string; abort?: boolean; whenBusy?: "steer" | "followUp" }, CommandAck>;
	"thread.create": OpSpec<{ requestId: string; cwd: string; place: Placement; name?: string; prompt?: string }, ThreadCreated>;
	"thread.resume": OpSpec<{ requestId: string; threadId: string; place: Placement; cwd?: string; name?: string }, ThreadResumed>;
	"thread.close": OpSpec<{ threadId: string; lastPane?: boolean }, ActionAck>;
	"sessions.search": OpSpec<{ query: string }, FleetSearchResult>;
	"thread.outline": OpSpec<{ threadId: string }, ThreadOutline>;
	/**
	 * `from` (an entry ID, the reader's place) centers the result's windows and the result echoes `anchored`; `tail`
	 * puts them at the branch's end. Without either they hold the first matches. A Session the Host has not indexed
	 * yet answers `FindIndexing`; a copy outside the retained scope refuses with `not_found`.
	 */
	/** Every Host passes the args to its store as the FindAsk whole, so each ask field reaches the window. */
	"thread.find": OpSpec<{ threadId: string; query: string } & FindAsk, FindReply>;
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
		/** `around` names a linked entry: the page holds its Rarebit item, and `before` in the value is the page's cursor. */
		params: { threadId: string; before?: string; around?: string };
		value: RarebitValue;
		ops: {
			ask: OpSpec<RarebitAskArgs, RarebitAskResult>;
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
 * Topics only the durable node serves. `team` and `rarebit` keep their native node shapes until the reader carries
 * them to the hub views (node-design.md, R4; ptb-design.md).
 */
// biome-ignore lint: the Team and Rarebit node topics move to hub views; their shapes are not declared here
export type NodeUntyped = any;
export type NodeTopicValues = { team: NodeUntyped; login: LoginState; rarebit: NodeUntyped; reader: ReaderWatchFrame | null };
export type ModelRef = { provider: string; modelId: string };
/** The node's native transcript page. The Pi-shaped `HistoryPage` replaces it with the reader (node-design.md step 8). */
export type NodeHistoryPage = { entries: UiEntry[]; more: boolean };
export type GitChanges =
	| { repo: false }
	| { repo: true; root: string; branch: string; files: { status: string; path: string }[]; patch: string; truncated: boolean };
/** The node's own state for diagnosis: every open store and its live tasks, as `harness.inspect()` reports them. */
/** Every store's live tasks; a store whose storage failed lists no tasks and names the failure in `unavailable`. */
export type NodeHealth = { stores: { id: string; tasks: { id: string; kind: string; conversation: string; state: string; reason?: string }[]; unavailable?: string; gaveUp?: true }[] };
export type CompactRecords = { records: CompactRecord[]; workingBudget: number | null; contextWindow: number | null };
/**
 * Every op the durable node serves (src/node/server.ts and its plugins), with its arguments and result. Ops a Pi Host
 * also serves keep the Pi Host's result, except `thread.history` (see NodeHistoryPage). The node refuses every other
 * name with `unsupported`.
 */
export type NodeOps = {
	"node.info": OpSpec<Done, NodeInfo>;
	"node.restart": OpSpec<Done, { restarting: true }>;
	"node.health": OpSpec<Done, NodeHealth>;
	/** The thread's effective system prompt and tools at an entry (default: now), as the audit renderer's snapshot. */
	"audit.snapshot": OpSpec<{ threadId: string; entryId?: string }, PromptAuditSnapshot>;
	/** Consistent copies under `backups/<storeId>/` through SQLite's backup API; every store when `storeId` is absent. */
	"node.backup": OpSpec<{ storeId?: string }, { store: string; path: string }[]>;
	/**
	 * Replaces the text of one queued steer or follow-up in place, if it still shows `expected` (its `inbox` content).
	 * Each answer proves one thing, and none sends anything. An answer comes from one of two sources: a receipt, kept
	 * from the commit that answered this `editId` first, or an observation of the item at this commit.
	 * - `edited` from a receipt: the item held `text` at that earlier commit. Its text may have changed since.
	 * - `edited` from an observation: the item holds `text` now, or its placed entry carries `text`.
	 * - `taken`: this edit never saved; the item had left the queue when it arrived.
	 * - `changed`: this edit never saved; the item showed neither `expected` nor `text`.
	 * - `unknown`: a retry (`retry: true`) without a receipt. Its first attempt may have saved and been overwritten.
	 * The node keeps the receipts of the newest 50 edits per thread; a retry gets its receipt unchanged.
	 */
	"thread.editQueued": OpSpec<{ threadId: string; submissionId: string; editId: string; expected: string; text: string; retry?: boolean }, EditQueuedResult>;
	/** One reopen attempt of a failed storage now; a store still in its backoff answers `reopening`. */
	"store.reopen": OpSpec<{ storeId: string }, { store: string; state: "open" | "reopening" | "unavailable"; error?: string }>;
	"models.list": OpSpec<Done, ModelChoice[]>;
	"prompts.list": OpSpec<{ cwd?: string }, PromptList>;
	"accounts.list": OpSpec<Done, ProviderStatus[]>;
	"accounts.login": OpSpec<{ providerId: string; type: string }, LoginState>;
	"accounts.answer": OpSpec<{ loginId: string; promptId: string; value: string }, Done>;
	"accounts.cancel": OpSpec<{ loginId: string }, Done>;
	"accounts.logout": OpSpec<{ providerId: string }, Done>;
	"thread.create": OpSpec<{ requestId: string; cwd: string; place?: Placement; name?: string; model?: ModelRef; thinkingLevel?: string; prompt?: string }, ThreadCreated>;
	"thread.submit": HostOps["thread.submit"];
	"thread.abort": HostOps["thread.abort"];
	"thread.withdraw": HostOps["thread.withdraw"];
	"thread.close": OpSpec<{ threadId: string }, ActionAck>;
	"thread.commands": HostOps["thread.commands"];
	"thread.command": HostOps["thread.command"];
	"thread.compact": OpSpec<{ threadId: string; instructions?: string }, { taskId: string }>;
	"thread.configure": OpSpec<{ threadId: string; model?: ModelRef; thinkingLevel?: string; cwd?: string }, Done>;
	"thread.rename": OpSpec<{ threadId: string; title: string }, Done>;
	"thread.archive": OpSpec<{ threadId: string; archived?: boolean }, Done>;
	"thread.fork": OpSpec<{ threadId: string; entryId: string }, { threadId: string }>;
	"thread.history": OpSpec<{ threadId: string; before: string; limit?: number }, NodeHistoryPage>;
	"thread.images": OpSpec<{ threadId: string; entryId: string; index: number }, { count: number; image?: { data: string; mimeType: string } }>;
	"compact.records": OpSpec<{ threadId: string }, CompactRecords>;
	"git.changes": OpSpec<{ cwd?: string }, GitChanges>;
	"fs.dirs": OpSpec<{ path: string; hidden?: boolean }, { path: string; parent: string; dirs: string[] }>;
	/**
	 * The reader wire (reader-design.md "Node read API"). A handle belongs to the connection that opened it and pins its
	 * conversation's watch in node memory until `reader.close` or disconnect.
	 */
	"reader.open": OpSpec<{ threadId: string }, { handle: string; epoch: number; frame: ReaderWatchFrame }>;
	"reader.entries": OpSpec<{ handle: string; order: "ascending" | "descending"; minEntryId?: number; maxEntryId?: number; limit: number }, { items: ReaderPageItem[]; more: boolean; last: number | null }>;
	"reader.fence": OpSpec<{ handle: string }, { upper: number | null; watchRevision: number }>;
	"reader.raw": OpSpec<{ handle: string; id: number; exportId?: string; offset: number }, { exportId: string; offset: number; encoding: "base64"; data: string; bytes: number; sha256: string; done: boolean }>;
	"reader.cancel": OpSpec<{ handle: string; exportId: string }, Done>;
	"reader.close": OpSpec<{ handle: string }, Done>;
};
export type NodeOpName = keyof NodeOps;
/** One reader page item: a whole pi-durable record, or the size and digest of a record past the page's entry cap. */
export type ReaderPageItem =
	| { type: "entry"; record: { id: number; conversationId: number; kind: string } & Record<string, JsonValue> }
	| { type: "oversized"; id: number; conversationId: number; kind: string; bytes: number; sha256: string };
/** One bounded reader watch frame. `docs` are pi-durable documents, forwarded as the node stores them. */
export type ReaderWatchFrame = {
	epoch: number;
	watchRevision: number;
	conversation: Record<string, JsonValue> | null;
	active: { count: number; ranges: [number, number][]; complete: boolean };
	docs: Partial<Record<"pi.live" | "pi.inbox" | "pi.agent" | "pi.usage", JsonValue>>;
	clipped?: Record<string, { strings: number; bytes: number; items: number; stringBytes?: number; whole?: boolean }>;
	omittedDocs?: string[];
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
	"hosts.remove": OpSpec<{ id: string }, Done>;
	"hosts.reconnect": OpSpec<{ id: string }, Done>;
	/**
	 * The owner's intent for one Session by threadId: pinned or not. The hub applies it idempotently: a repeated
	 * intent keeps membership, the place and the host. `host`, the pin's first host hint, goes in only when the pin is
	 * created, and a new pin needs one; `pins.hint` moves it later. `title` is saved so the pin still reads when the
	 * Session is gone; a repeated pin with a new title renames in place. `intent: "owner"` marks an owner click; the hub
	 * creates a pin only with it, and refuses an unmarked create with "This page is older than the hub. Reload it."
	 */
	"pins.set": OpSpec<{ threadId: string; pinned: boolean; intent?: "owner"; host?: string; title?: string }, Done>;
	/**
	 * Moves an existing pin's host hint to the Host that now lists the Session. It never creates or removes a pin: only
	 * `pins.set`, an owner action, changes which Sessions are pinned. A hint for an unpinned Session does nothing.
	 */
	"pins.hint": OpSpec<{ host: string; threadId: string }, Done>;
};
/** The hub's broadcast of every host link's state, after any change. */
/** `config`: the hub.json this hub read at start, for the Host setup prompt. */
export type HostsFrame = { t: "hosts"; hosts: HostState[]; config?: string };
/** One pinned Session (src/hub/pins.ts): threadId is the key, `host` the Host that last listed it. */
export type Pin = { host: string; threadId: string; title: string };
/** The hub's pin list, sent on connect and to every browser after a change. */
export type PinsFrame = { t: "pins"; pins: Pin[] };
