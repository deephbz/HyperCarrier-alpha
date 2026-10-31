// PiHost: the hub's link to one Host that runs Pi coding-agent Sessions (D15 stage 1, docs/pi-backend.md).
// It speaks the same frames as a node link, but serves them here, on the desktop, from local copies: the remote agent
// only ships Session bytes, Herdr layout and status, and carries actions. Reads never cross SSH; writes go to the
// named Host only. Transcripts are parsed by the Session reader (trace-analytics), never by this file.

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { repairReplicaTail } from "./replica-file.ts";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { diffRevisions } from "@earendil-works/chord/delta";
import { type HostBase, type HostState, type LinkStatus, negotiating, withStatus } from "../hub/hosts.ts";
import type { ActionAck, ClientFrame, CommandAck, SlashCommands, ControlSubmission, Every, HostOps, PiQueuedItem, OpHandlers, OpName, OpRequest, OpResult, Ops, Placement, PiHostFrame, PiThreadView, PiTopicValue, SubmittedPrompt, ThreadCreated, ThreadResumed, ThreadsState, ThreadSummary, Topic } from "../shared/protocol.ts";
import { INDEXING, NOT_FOUND, STALE_VERSION, type ImageLimits } from "../shared/protocol.ts";
import { admitImages, rejectionLine } from "../shared/image-admission.ts";
// @ts-ignore: pi-hc-control is plain ESM.
import { IMAGE_LIMITS as CONTROL_IMAGE_LIMITS } from "@hypercarrier/pi-hc-control/control";
import { historySpend, spendLabel, unreadSpend } from "../shared/spend.ts";
import { SESSION_SCOPE_MS } from "../shared/session-scope.ts";
import { agentModules } from "./agent-modules.ts";
import { ask } from "./ask.ts";
import { resolveHelperModel } from "../hub/helper-models.ts";
import { piModelRegistry } from "./model-registry.ts";
import { complete, instant, nowUs, span, spanAsync, tracing } from "../trace.ts";
import { watched } from "../loop-watch.ts";
import { PI_VIEWS, viewOps } from "./views/index.ts";
import type { HostedView, PiTeamMember, PiTeamsFrame, PiViewContext, PiViewSession } from "./views/types.ts";
import type { WorkingSet } from "./working-set.ts";
import type { Derived, SessionIdentity, Source as CopySource } from "./working-set-types.ts";
import { identityOf } from "./session-identity.ts";

export type PiHostConfig = {
	/** The owner's SSH config alias for this Host, or the hub machine's own alias. It is the Host's identity. */
	id: string;
	label: string;
	kind: "pi-local" | "pi-ssh";
	/** SSH destination; defaults to `id` (the alias). */
	target?: string;
	sshArgs?: string[];
	herdrSession?: string;
	/**
	 * Node on a remote Host, run by its login shell. Default `node`. A local Host runs the hub's own Node
	 * (`process.execPath`) without a shell; `remoteNode` there replaces that executable (tests).
	 */
	remoteNode?: string;
	/** Root of local copies. The hub sets it to `pi-cache` in its home when hub.json leaves it out. */
	cacheDir?: string;
	/** Extra config for the remote agent (tests: fake herdr, agent dir). */
	agentConfig?: Record<string, unknown>;
	/** Environment for a local agent (tests). */
	env?: Record<string, string>;
	/** List Sessions whose copies changed within this window even when no pane runs them. Default 96 hours. */
	recentMs?: number;
	/** Replaces Pi for views' model calls (ask.ts): argv that reads the prompt on stdin and prints the answer. */
	askCommand?: string[];
};

export { projectEntry } from "./projection.ts";
type RemoteAgent = {
	session: string;
	sessionId?: string;
	pane: string | null;
	workspace?: string;
	tab?: string;
	name?: string;
	title?: string;
	cwd?: string;
	status?: string;
	focused?: boolean;
	bytes?: number;
	/** When a control descriptor alone names the Session: the endpoint's start, so a file-less Session has a stable age. */
	startedAt?: number;
	/**
	 * `commands`: the control serves typed slash commands. `images`: its submit carries images. `submissions` are raw
	 * wire records; controlSubmission reads them.
	 */
	control?: { live: boolean; idle: boolean; compacting: boolean; commands?: boolean; images?: boolean; pending?: { steer: number; followUp: number }; submissions?: unknown[] } | null;
};
/**
 * This hub's record of one queued submission. `unknown`: the live control no longer reports it (Pi restarted or
 * switched Session). `dismissed`: the owner cleared it from the composer.
 */
type QueuedInput = { threadId: string; submission: string; deliverAs: string; state: ControlSubmission["state"] | "unknown"; at: number; text: string; truncated?: boolean; images?: number; dismissed?: boolean };
/** One Herdr pane as listed, with or without a Session file. */
type RemotePane = { pane: string; workspace?: string; tab?: string; name?: string | null; status?: string | null };
/**
 * A create from this hub whose Session has no copy yet: Pi writes the file only with the first message, so until then
 * the thread is listed from what the hub asked for.
 */
type Starting = { threadId: string; sessionId: string; name: string; cwd: string; pane: string; createdAt: number; seen: boolean };
type Layout = { workspaces: { id: string; label?: string; tabs: { id: string; label?: string; panes: string[] }[] }[] };
type TeamMember = PiTeamMember;
/** A command's acknowledgement from the remote agent; `ok: false` carries the refusal. */
type AgentAck = {
	t: "ack"; id: number; ok: boolean; error?: string | { code?: string; message?: string; matches?: unknown[] }; pane?: string; name?: string;
	via?: string; evidence?: string; entryId?: string; submission?: string; submissions?: unknown[]; submitted?: SubmittedPrompt; warning?: string;
	watermark?: { size: number; mtimeMs: number };
	/** Slash commands: the `commands` list, or one command's outcome. */
	value?: SlashCommands; disposition?: CommandAck["disposition"]; notice?: string; effect?: CommandAck["effect"];
};
/** Frames from the remote agent (pi-backend.md §2), one JSON object per stdout line. */
type AgentMessage =
	| { t: "hello"; host?: string; pid?: number; controlOps?: string[] }
	| { t: "beat" }
	| { t: "reset"; path: string; offset: number }
	| { t: "chunk"; path: string; offset: number; data: string; size?: number }
	| { t: "agents"; agents?: RemoteAgent[]; layout?: Layout; panes?: RemotePane[] }
	| PiTeamsFrame
	| { t: "limits"; windows?: Record<string, number>; budget?: ModelLimits["budget"] }
	| AgentAck;
/** Old browser tabs request these names; each maps to its registry op. */
const LEGACY_OPS: Partial<Record<string, OpName>> = { "view.cos-arc.build": "view.cos.arc.build" };

/** Copy metadata and compact derived values. Transcript bodies never stay here. */
type Copy = {
 path: string; file: string; offset: number; session?: SessionIdentity; closedAt?: number;
	/** Whole-line length of the Session file at the agent's last read; absent from an agent that does not report it. */ sourceBytes?: number;
 revision: number; data?: Derived; updatedAt: number; cost: number; priced?: boolean; model?: string;
	contextTokens?: number; budgetOverride?: number;
	/** Percent of the latest assistant prompt read from cache, as hc-hud and Pi's footer compute it. */
	cacheHit?: number; preview?: string; lastKnownLive?: boolean; generation: number;
	/** When its last open thread or view closed. Memory only: after a hub restart the browser's resubscribe marks the row. */ lastOpenAt?: number;
	refreshing?: Promise<void>; deriving?: boolean; refreshAgain?: boolean; urgent?: boolean; leases: number;
	/** Copy file mtime at load; orders the cold backlog newest first. */ copiedAt?: number;
	/** Loaded without a head of this build's derivation, and its first derive has not settled: the row lists by identity only. */ updating?: boolean;
	eviction?: Promise<void>; evictionCancelled?: boolean; readError?: string; sourceMissing?: boolean;
	/** Reads stay behind the derive Worker after a reopen (a cache fault); `staleRetry` and `staleDelay` back off refused publish reads. */
	cacheFault?: boolean; staleRetry?: ReturnType<typeof setTimeout>; staleDelay?: number;
	/** The copy's host inputs (#hostInputs) at its last publish; a frame that leaves them equal marks nothing. */ hostKey?: string;
	/** Liveness last given to the working set's transcript window. */ windowLive?: boolean;
};

export const THREAD_WINDOW = 400;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_SCRIPT = fileURLToPath(new URL("./remote-agent.cjs", import.meta.url));
/** What a Pi control with `images: 1` takes in one message (pi-hc-control owns the values). */
const IMAGE_LIMITS: ImageLimits = CONTROL_IMAGE_LIMITS;

/** Reads the first stdin line `{ cfg, code }`, then runs the agent with the rest of stdin as its command stream. */
export const BOOTSTRAP = Buffer.from(
	`let b=Buffer.alloc(0);const h=(d)=>{b=Buffer.concat([b,d]);const i=b.indexOf(10);if(i<0)return;process.stdin.off("data",h);process.stdin.pause();const m=JSON.parse(b.subarray(0,i).toString());process.env.HCM_CFG=m.cfg;if(i+1<b.length)process.stdin.unshift(b.subarray(i+1));eval(Buffer.from(m.code,"base64").toString());process.stdin.resume();};process.stdin.on("data",h);`,
).toString("base64");

/**
 * The agent's launch command. A local Host runs the hub's own Node directly, so a login shell's version manager
 * cannot pick another Node and a path with spaces needs no quoting. A remote Host runs `remoteNode` (default `node`)
 * through SSH and its login shell. Both read `{ cfg, code }` from stdin's first line (BOOTSTRAP).
 */
export function agentLaunch(config: PiHostConfig): { command: string; args: string[] } {
	const bootstrap = `eval(Buffer.from('${BOOTSTRAP}','base64').toString())`;
	if (config.kind === "pi-local") return { command: config.remoteNode ?? process.execPath, args: ["-e", bootstrap] };
	const remoteCmd = `exec ${config.remoteNode ?? "node"} -e "${bootstrap}"`;
	const options = ["-T", "-C", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];
	return { command: "ssh", args: [...options, ...(config.sshArgs ?? []), "--", config.target ?? config.id, `sh -lc ${JSON.stringify(remoteCmd)}`] };
}

/** Replicated values are JSON: chord's diff cannot carry `undefined`, so drop such keys. */
function defined<T extends Record<string, unknown>>(value: T): T {
	for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
	return value;
}

/**
 * The one reader of a control's submission record (pi-hc-control status and abort, relayed by the remote agent). The
 * status, submit and abort paths all read records through it, so each field reaches the hub on every path.
 */
function controlSubmission(raw: unknown): ControlSubmission | undefined {
	const r = raw as Record<string, unknown> | null;
	if (typeof r?.submission !== "string") return undefined;
	const record: Every<ControlSubmission> = {
		submission: r.submission,
		deliverAs: r.deliverAs === "steer" ? "steer" : "followUp",
		state: r.state as ControlSubmission["state"],
		at: Number(r.at),
		entryId: typeof r.entryId === "string" ? r.entryId : undefined,
		text: typeof r.text === "string" ? r.text : undefined,
		truncated: r.truncated === true || undefined,
		images: typeof r.images === "number" && r.images > 0 ? r.images : undefined,
	};
	return defined(record) as ControlSubmission;
}
const controlSubmissions = (raw: unknown[]): ControlSubmission[] => raw.map(controlSubmission).filter((r) => r !== undefined);

/**
 * An action's reply: how it was delivered, its evidence, the Session entry it made when the Host names one, the
 * queued submission it made, and, for abort, what became of each queued submission.
 */
function ackResult(ack: AgentAck): ActionAck {
	return defined({
		via: ack.via,
		evidence: ack.evidence,
		entryId: typeof ack.entryId === "string" ? ack.entryId : undefined,
		submission: typeof ack.submission === "string" ? ack.submission : undefined,
		submissions: Array.isArray(ack.submissions) ? controlSubmissions(ack.submissions) : undefined,
	});
}

/** A copy of `layout` with `pane` in its tab (added when missing). */
function withPane(layout: Layout, workspace: string, tab: string, pane: string): Layout {
	const has = layout.workspaces.some((w) => w.id === workspace && w.tabs.some((t) => t.id === tab && t.panes.includes(pane)));
	if (has) return layout;
	const known = layout.workspaces.some((w) => w.id === workspace);
	const workspaces = layout.workspaces.map((w) => {
		if (w.id !== workspace) return w;
		const knownTab = w.tabs.some((t) => t.id === tab);
		return { ...w, tabs: knownTab ? w.tabs.map((t) => (t.id === tab ? { ...t, panes: [...t.panes, pane] } : t)) : [...w.tabs, { id: tab, panes: [pane] }] };
	});
	return { workspaces: known ? workspaces : [...workspaces, { id: workspace, tabs: [{ id: tab, panes: [pane] }] }] };
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** The Host's model limits, as the remote agent's `limits` frame carries them. Keys are `provider/model`. */
export type ModelLimits = { windows: Record<string, number>; budget: { tokens?: number; models?: Record<string, number> } | null };

/**
 * A Session model's context window and working budget, resolved as hc-auto-compact resolves its budget: the
 * Session branch's `/auto-compact budget` override, else a per-model `budget_tokens`, else the global one, else the
 * window, clamped to the window. Without an override or Auto Compact settings there is no working budget.
 */
export function modelLimits(model: string | undefined, limits: ModelLimits | undefined, override?: number): { contextWindow?: number; workingBudget?: number } {
	const window = model ? limits?.windows[model] : undefined;
	if (!window) return {};
	if (!limits?.budget && !override) return { contextWindow: window };
	const configured = override ?? limits?.budget?.models?.[model!] ?? limits?.budget?.tokens ?? window;
	return { contextWindow: window, workingBudget: Math.min(configured, window) };
}
/** Copy file reads in flight at once while the index loads (#loadIndex): the reads are I/O-bound and small. */
const LOAD_READS = 8;

function piSpendFields(copy: { cost: number; priced?: boolean }): Pick<ThreadSummary, "spend" | "spendLabel"> {
 const spend = historySpend(copy.priced === false ? null : copy.cost);
 return { spend, spendLabel: spendLabel(spend) };
}

type Source = { value: unknown; listeners: Set<(value: unknown) => void> };

export class PiHost extends EventEmitter {
	readonly config: PiHostConfig;
	state: HostState;
	readonly cacheDir: string;
	#copies = new Map<string, Copy>();
	#store!: WorkingSet;
	#loaded?: Promise<void>;
	#initialized = false;
	/** Saved heads and the index are loaded; the derive Worker may still be starting. */
	#indexed?: Promise<void>;
	#listable = false;
	/** The startup refresh of every saved copy has not settled, and UPDATING_MAX_MS has not passed. */
	#refreshing = true;
	/** Copies loaded without a current head (Copy.updating), and how many of them have settled; HostBase.upgrade. */
	#upgrade = { updated: 0, total: 0 };
	/** Set when working-set init failed: the end reason for every list, served or later. */
	#failure?: string;
	#stopping?: Promise<void>;
	#writes: Promise<void> = Promise.resolve();
	#preparing = new Map<number, object>();
	#sweep?: ReturnType<typeof setInterval>;
	#livenessKnown = false;
	#byThread = new Map<string, Copy>();
	#agents: RemoteAgent[] = [];
	#agentsByPath = new Map<string, RemoteAgent>();
	/** True once the Host sent a full agents list on this connection: only then does absence from it mean "missing". */
	#listed = false;
	#layout: Layout = { workspaces: [] };
	#teams = new Map<string, TeamMember>();
	/** The latest teams frame as the remote agent sent it (status, codes, and whatever Pi Team Bright read it carries). */
	#teamsFrame?: PiTeamsFrame;
	#limits?: ModelLimits;
	#child?: ChildProcess;
	#stopped = true;
	#timer?: ReturnType<typeof setTimeout>;
	#attempts = 0;
	#nextCmd = 1;
	/** Frame ops the connected remote agent serves beyond the base set; an older agent sends none. */
	#controlOps = new Set<string>();
	#pending = new Map<number, { resolve: (value: AgentAck) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	/** Live subscriptions by sid: the topic, its last value, and how many ops frames were sent. */
	#subs = new Map<number, { topic: Topic; previous: PiTopicValue | undefined; n: number; at?: number; pending?: string }>();
	/** Open thread and view subscriptions per threadId; they keep a cold Session listed (#held). */
	#openCount = new Map<string, number>();
	/** A cold Session stays listed this long after its last view closes, so leaving it does not pull its row from under the pointer. */
	static OPEN_GRACE_MS = 5 * 60_000;
	/** A Host-wide view recomputes at most this often; changes in between coalesce into one publish. */
	static ANY_VIEW_MS = 500;
	/** The longest `updating` lasts after init; a slow backlog refresh must not leave the header "Updating…" forever. */
	static UPDATING_MAX_MS = 60_000;
	#anyTimer?: ReturnType<typeof setTimeout>;
	#anyDeferred = new Set<string>();
	/** A publish read refused by its version check retries after this delay, doubling up to the maximum until the copy's next commit. */
	static STALE_RETRY_MS = 250;
	static STALE_RETRY_MAX_MS = 30_000;
	/** The hub log gets the first stale read of each kind and every Nth after it; /api/health keeps the counts. */
	static STALE_LOG_EVERY = 100;
	#saveTimer?: ReturnType<typeof setTimeout>;
	#publishScheduled = false;
	#dirty = new Set<string>();
	/** Host-wide inputs (layout, panes, Teams, unfiled Sessions) changed: the threads topic and Host-wide views recompute. */
	#hostChanged = false;
	#hostWideKey?: string;
	/** The threads topic recomputes at least this often; a difference found then is a host input #hostInputs missed. */
	static AUDIT_MS = 60_000;
	/** The agent beats every 5 s. A link silent this long is dead, even when its process never exits. */
	static SILENT_MS = 30_000;
	static SILENT_TICK_MS = 5_000;
	#audit?: ReturnType<typeof setInterval>;
	#auditDue = false;
	/** The clock that #hostInputs' `recent` reads, set when #markHostChanges runs, so a publish never sees a later edge. */
	#inputsAt = 0;
	/** The retention window and open grace that rows and eviction read, taken with #inputsAt; a change after a mark reaches rows at the next mark. */
	#inputsWindow = 0;
	#inputsGrace = 0;
	/** Audit differences found since start: inputs that change marking missed (reported in /api/health). */
	missedInputs = 0;
	/** Queued submissions by ID, until delivered or dismissed; the full text when this hub sent it. */
	#queued = new Map<string, QueuedInput>();
	#panes?: RemotePane[];
	#starting = new Map<string, Starting>();
	/** thread.create in flight by requestId. */
	#creates = new Map<string, Promise<ThreadCreated>>();
	#views = new Map<string, HostedView>(PI_VIEWS.map((v) => [v.name, v]));
	#forcedViews = new Set<string>();
	/** What views may see of this Host (views/types.ts). */
	#viewContext: PiViewContext = {
		host: "", // set in the constructor, once the config exists
		stateDir: (view) => {
			const dir = join(this.cacheDir, "views", view);
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			return dir;
		},
		sessions: () => [...this.#copies.values()].map((c) => this.#viewSession(c)).filter((s): s is PiViewSession => Boolean(s)),
		session: (threadId) => {
			const copy = this.#copyByThread(threadId);
			return copy ? this.#viewSession(copy) : undefined;
		},
		snapshot: (read) => this.#store.snapshot(read),
		lease: (threadId) => { const c = this.#copyByThread(threadId); if (!c) return () => {}; c.leases++; return () => { c.leases--; }; },
		teams: () => [...this.#teams.values()],
		teamsFrame: () => this.#teamsFrame,
		rolesKnown: () => Boolean(this.#teamsFrame) || this.config.agentConfig?.teams === false,
		command: (cmd, timeoutMs) => this.#command(cmd, timeoutMs),
		ask: (req) => ask(req, this.config.askCommand),
		model: (purpose, override) => resolveHelperModel(purpose, override, this.config.askCommand?.length ? undefined : piModelRegistry),
		invalidate: (view) => {
			this.#forcedViews.add(view);
			// The threads rows carry each view's summarize fields.
			if (this.#views.get(view)?.summarize) this.#hostChanged = true;
			this.#schedulePublish();
		},
	};
	/** Every op this Host serves, keyed by request name; `OpHandlers` makes it agree with `Ops`. */
	#ops: OpHandlers = { ...this.#hostOps(), ...viewOps(this.#viewContext) };

	constructor(config: PiHostConfig & { cacheDir: string }) {
		super();
		this.config = config;
		this.#viewContext.host = config.id;
		this.cacheDir = join(config.cacheDir, digest(config.id).slice(0, 16));
		this.state = {
			id: config.id,
			label: config.label,
			kind: config.kind,
			...(config.target ? { target: config.target } : {}),
			attempts: 0,
			status: "connecting",
			phase: "transport",
			since: Date.now(),
			hint: "Reading this Host's local copies; the agent starts next.",
		};
	}

	// ---- link surface shared with HostLink ----

	start(): void {
		if (this.#loaded || this.#stopping) return;
		this.#stopped = false;
		let ready!: Promise<void>;
		this.#indexed = (async () => {
			await yieldLoop();
			const { WorkingSet } = await spanAsync("import-working-set", "startup", () => import("./working-set.ts"));
			await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
			this.#store = new WorkingSet(this.config.id, this.cacheDir);
			// The index loads from saved heads while the derive Worker starts. The threads and node snapshots need only
			// the index; every other step waits for both.
			ready = spanAsync("working-set-ready", "startup", () => this.#store.ready);
			void ready.catch(() => {});
			await this.#store.readable;
			await spanAsync("load-index", "startup", () => this.#loadIndex());
			this.#listable = true;
		})();
		this.#loaded = (async () => {
			await this.#indexed;
			await ready;
			this.#initialized = true;
			instant("host-loaded", { copies: this.#copies.size });
		})();
		void this.#loaded.then(() => {
			if (this.#stopped) return;
			this.#sweep = setInterval(() => void this.#evictExpired(), 60_000);
			this.#sweep.unref();
			// The audit first re-reads host inputs at a new #inputsAt: a retention edge crossed since the last frame is a
			// change, not a missed input.
			this.#audit = setInterval(() => { this.#auditDue = true; this.#markHostChanges(); this.#schedulePublish(); }, PiHost.AUDIT_MS);
			this.#audit.unref();
			this.#connect();
			const started = Date.now();
			span("refresh-all", "startup", () => {
				const backlog = [...this.#copies.values()].sort((a, b) => (b.copiedAt ?? 0) - (a.copiedAt ?? 0));
				// A Session open in a browser before this pass re-derives with the live ones, ahead of the cold backlog.
				void Promise.allSettled(backlog.map((copy) => this.#refresh(copy, this.#isLive(copy) || this.#held(copy)))).then(() => this.#updated("refresh", started));
			}, { copies: this.#copies.size });
			// Node's timer clock counts whole ms, so a timer can fire 1 ms before the bound by Date.now(); re-arm for the rest.
			const bound = () => {
				const rest = started + PiHost.UPDATING_MAX_MS - Date.now();
				if (rest > 0) setTimeout(bound, rest).unref();
				else this.#updated("bound", started);
			};
			setTimeout(bound, PiHost.UPDATING_MAX_MS).unref();
		}).catch((error) => {
			if (this.#stopped) return;
			// A list served from the index, or one still preparing, would never update after a failed init: end it, and
			// every later one, with the reason and the next step.
			if (!this.#initialized) {
				console.error(`pi host ${this.config.id}: working-set init failed:`, error);
				this.#failure = this.#unavailable((error as Error).message);
				for (const sid of [...this.#subs.keys(), ...this.#preparing.keys()]) this.#emitFrame({ t: "end", sid, reason: this.#failure });
				this.#subs.clear();
				this.#preparing.clear();
			}
			this.#set(this.#failure ? { cacheFailed: true } : {}, { status: "disconnected", since: Date.now(), error: `Host cache unavailable: ${(error as Error).message}.`, errorClass: "reachability", hint: this.#cacheHint() });
		});
	}

	/** Clears `updating` once: when the startup refresh settles, or at the bound while it still runs. */
	#updated(by: "refresh" | "bound", started: number): void {
		if (this.#stopped || !this.#refreshing) return;
		this.#refreshing = false;
		const what = by === "refresh" ? "the startup refresh settled" : "the bound passed while the startup refresh still runs";
		console.log(`pi host ${this.config.id}: Updating cleared after ${Date.now() - started} ms: ${what}`);
		instant("host-updated", { by });
		this.#markAll();
	}

	#unavailable(message: string): string {
		return `Host cache unavailable: ${message}. ${this.#cacheHint()}`;
	}

	#cacheHint(): string {
		return `Restart the hub; if it repeats, check the hub log and the cache at ${this.cacheDir}.`;
	}

	stop(): Promise<void> {
		if (this.#stopping) return this.#stopping;
		this.#stopped = true;
		clearInterval(this.#sweep);
		clearInterval(this.#audit);
		clearTimeout(this.#anyTimer);
		for (const copy of this.#copies.values()) clearTimeout(copy.staleRetry);
		clearTimeout(this.#saveTimer);
		clearTimeout(this.#timer);
		this.#preparing.clear();
		for (const sid of [...this.#subs.keys()]) this.#dropSub(sid);
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Host stopped"));
		}
		this.#pending.clear();
		this.#child?.kill();
		this.#child = undefined;
		return this.#stopping = (async () => {
			try {
				await this.#loaded;
				if (this.#initialized) await this.#writeIndex();
			} finally { await this.#store?.close(); }
		})();
	}

	reconnect(): void {
		clearTimeout(this.#timer);
		this.#attempts = 0;
		this.#child?.kill();
		if (this.state.status !== "connected") void this.#loaded?.then(() => this.#connect()).catch((error) => { if (!this.#stopped) this.#set({}, { status: "disconnected", since: Date.now(), error: `Host cache unavailable: ${(error as Error).message}.`, errorClass: "reachability", hint: this.#cacheHint() }); });
	}

	/** Frames from the hub, as a node would receive them. Answers are emitted as `frame` events. */
	send(frame: ClientFrame): boolean {
		switch (frame.t) {
			case "ping":
				this.#emitFrame({ t: "pong" });
				return true;
			case "sub":
				void this.#subscribe(frame.sid, frame.topic);
				return true;
			case "unsub":
				this.#preparing.delete(frame.sid);
				this.#dropSub(frame.sid);
				void this.#evictExpired();
				return true;
			case "req":
				void this.#request(frame.id, { op: LEGACY_OPS[frame.op] ?? frame.op, args: frame.args ?? {} });
				return true;
		}
		return false;
	}

	#emitFrame(frame: PiHostFrame): void {
		this.emit("frame", frame);
	}

	/** Changes base fields and, with `status`, the status; one state event either way. */
	#set(change: Partial<HostBase>, status?: LinkStatus): void {
		const next: Record<string, unknown> = { ...(status ? withStatus(this.state, status) : this.state), ...change };
		for (const key of Object.keys(change)) if (change[key as keyof HostBase] === undefined) delete next[key];
		this.state = next as HostState;
		this.emit("state", this.state);
	}

	// ---- local copies ----

	#indexFile(): string {
		return join(this.cacheDir, "index.json");
	}

	async #loadIndex(): Promise<void> {
  let index: Record<string, { file: string; offset: number; closedAt?: number; lastKnownLive?: boolean }> = {};
  try { index = JSON.parse(await readFile(this.#indexFile(), "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // Each copy's file reads overlap with others (LOAD_READS at a time); the copies register in index order.
  const readCopy = async (path: string, file: string) => {
   let end: number, copiedAt: number;
   try { end = await repairReplicaTail(file); copiedAt = (await stat(file)).mtimeMs; }
   catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
   // A head of another derivation reads as missing (WorkingSet.load). The header still lists the Session.
   const saved = this.#store.load(path);
   const identity = saved ? undefined : await identityOf(this.config.id, file, copiedAt).catch(() => undefined);
   return { end, copiedAt, saved, identity };
  };
  const entries = Object.entries(index), loaded: Promise<void>[] = [];
  const reads = new Array<Awaited<ReturnType<typeof readCopy>>>(entries.length);
  let next = 0;
  for (let n = 0; n < Math.min(LOAD_READS, entries.length); n++) loaded.push((async () => {
   for (let i = next++; i < entries.length; i = next++) reads[i] = await readCopy(entries[i]![0], join(this.cacheDir, basename(entries[i]![1].file)));
  })());
  await Promise.all(loaded);
  for (const [i, [path, meta]] of entries.entries()) {
   const read = reads[i];
   if (!read) continue;
   const copy = this.#newCopy(path, join(this.cacheDir, basename(meta.file)), read.end);
   copy.copiedAt = read.copiedAt;
   copy.closedAt = meta.closedAt; copy.lastKnownLive = meta.lastKnownLive;
   if (read.saved) { this.#applyDerived(copy, read.saved); continue; }
   // A copy without a Pi header does not list, but it counts in the progress until its derive settles.
   copy.updating = true; this.#upgrade.total++;
   if (read.identity) {
    copy.session = read.identity; copy.updatedAt = read.identity.updated ?? read.copiedAt;
    this.#byThread.set(read.identity.id, copy);
   }
  }
  this.#publishUpgrade();
  try { for (const s of JSON.parse(await readFile(this.#startingFile(), "utf8")) as Starting[]) if (s?.threadId && s.pane) this.#starting.set(s.threadId, s); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
 }

	#startingFile(): string {
		return join(this.cacheDir, "starting.json");
	}

	#saveIndex(): void {
		if (this.#stopped) return;
		// Keep a pending write: discovery saves every pass, and a restarted timer would never fire while passes come
		// faster than the delay. The write takes its snapshot when it runs, so it includes later changes.
		if (this.#saveTimer) return;
		// #writeIndex reports a failure as indexError; the hub log keeps the stack.
		this.#saveTimer = setTimeout(() => { void this.#writeIndex().catch((error) => console.error(`pi host ${this.config.id}: index write failed:`, error)); }, 300);
	}

	#writeIndex(): Promise<void> {
		clearTimeout(this.#saveTimer);
		this.#saveTimer = undefined;
		const index = [...this.#copies].map(([path, c]) => [path, { file: basename(c.file), offset: c.offset, lastKnownLive: c.lastKnownLive, ...(c.closedAt ? { closedAt: c.closedAt } : {}) }] as const);
		const starting = JSON.stringify([...this.#starting.values()]);
		const write = this.#writes.catch(() => {}).then(async () => {
			const parts: string[] = [];
			let since = performance.now();
			for (const [path, meta] of index) {
				parts.push(JSON.stringify(path) + ":" + JSON.stringify(meta));
				if (performance.now() - since >= 10) { await yieldLoop(); since = performance.now(); }
			}
			for (const [file, data] of [[this.#indexFile(), "{" + parts.join(",") + "}"], [this.#startingFile(), starting]]) {
				await writeFile(file + ".tmp", data, { mode: 0o600 });
				await rename(file + ".tmp", file);
			}
		}).then(
			() => { if (this.state.indexError) this.#set({ indexError: undefined }); },
			(error: unknown) => {
				// A persistent failure repeats every discovery pass; only a new reason is a state change.
				if (this.state.indexError !== (error as Error).message) this.#set({ indexError: (error as Error).message });
				throw error;
			},
		);
		this.#writes = write;
		return write;
	}

	#newCopy(path: string, file: string, offset: number): Copy {
		const copy: Copy = { path, file, offset, revision: 0, generation: 0, leases: 0, updatedAt: 0, cost: 0 };
		this.#copies.set(path, copy);
		return copy;
	}

	#copy(path: string): Copy {
		return this.#copies.get(path) ?? this.#newCopy(path, join(this.cacheDir, `${digest(path).slice(0, 32)}.jsonl`), 0);
	}

	#source(copy: Copy): CopySource { return { host: this.config.id, cacheDir: this.cacheDir, path: copy.path, file: copy.file }; }

 #applyDerived(copy: Copy, data: Derived): void {
  if (copy.session && copy.session.id !== data.session.id) this.#byThread.delete(copy.session.id);
  const { title: _title, ...identity } = data.session;
  copy.data = data; copy.session = identity; copy.updatedAt = data.session.updated ?? 0;
  this.#settleUpgrade(copy);
  copy.cost = data.cost; copy.priced = data.priced; copy.model = data.model; copy.budgetOverride = data.budgetOverride; copy.contextTokens = data.contextTokens; copy.cacheHit = data.cacheHit; copy.preview = data.preview;
  this.#byThread.set(data.session.id, copy);
 }

 /** Ends a copy's identity-only listing: its first derive committed a head, or settled without one. */
 #settleUpgrade(copy: Copy): void {
  if (!copy.updating) return;
  copy.updating = undefined; this.#upgrade.updated++;
 }

 // `committed` is the result of this copy's derive job (derive-worker.ts
 // materialize): the head it committed, or the saved head it kept. Only that job
 // writes this head, and a forget deletes it only at the version the hub read, so
 // a different read means a stale read connection. The check runs before the
 // snapshot reads anything (WorkingSet.reopen). The hub reopens once; the read after
 // that only checks the repair. Still behind: a cache fault until the next commit.
 // A head of another derivation reads as none (WorkingSet.load), so only a commit of this build's head can match.
 #checkRead(copy: Copy, committed: Derived): boolean {
  const read = this.#store.load(copy.path)?.version;
  let behind = false;
  if (read !== committed.version) {
   this.#store.reopen();
   this.#staleRead("reopened", `${copy.path} read ${read ?? "none"}, the worker committed ${committed.version}; reopened the read connection`);
   const again = this.#store.load(copy.path)?.version;
   behind = again !== committed.version;
   if (behind) this.#staleRead("behind", `${copy.path} still read ${again ?? "none"} after the reopen; adopted the worker's head`);
  }
  if (behind) copy.readError = "Cache read behind the derive Worker after a reopen; the next change checks again. Restart the hub if this lasts";
  this.#cacheFault(copy, behind);
  return behind;
 }

 // The Host warning counts the faulted copies that #copies still holds.
 #cacheFault(copy: Copy, fault: boolean): void {
  if (fault === Boolean(copy.cacheFault)) return;
  copy.cacheFault = fault || undefined;
  const n = [...this.#copies.values()].filter((c) => c.cacheFault).length;
  this.#set({ cacheFault: n ? `${n} Session ${n === 1 ? "copy reads" : "copies read"} behind the derive Worker after a reopen` : undefined });
 }

 // SQLite commit is the publication authority. The worker message can arrive
 // after a subscriber reads that commit; never roll a published copy backwards.
 // `committed`: the job's result, when #checkRead found the read connection behind it.
 #adoptHead(copy: Copy, committed?: Derived): void {
  if (!copy.refreshing || !copy.deriving) return;
  const data = committed ?? this.#store.load(copy.path);
  if (data && data.version !== copy.data?.version) {
   this.#applyDerived(copy, data); copy.revision++; this.#store.invalidate(this.#source(copy));
   // Adoption can happen inside any computation, an audit included, before the worker message arrives: mark it here.
   this.#dirty.add(copy.path); this.#schedulePublish();
  }
 }

 // One queued/running job per copy. A burst sets one trailing refresh bit;
 // the next worker scan reads all complete bytes that arrived in that burst.
 // Urgent jobs (new bytes, a live pane) run ahead of the cold backlog.
 #refresh(copy: Copy, urgent = false): Promise<void> {
  if (copy.refreshing) {
   copy.refreshAgain = true;
   if (urgent) this.#promote(copy);
   return copy.refreshing;
  }
  const generation = copy.generation;
  copy.urgent = urgent;
  copy.refreshing = (async () => {
   try {
    const data = await this.#store.refresh(this.#source(copy), () => { copy.deriving = true; }, urgent);
    if (!data || copy.generation !== generation || this.#copies.get(copy.path) !== copy || this.#stopped) return;
    copy.readError = undefined;
    // A commit restarts the refused-read backoff: the copy publishes now.
    clearTimeout(copy.staleRetry); copy.staleRetry = copy.staleDelay = undefined;
    const behind = this.#checkRead(copy, data);
    this.#store.snapshot(() => {
     this.#adoptHead(copy, behind ? data : undefined);
     try { if (this.#isLive(copy) && copy.data) this.#store.tail(this.#source(copy), copy.data, true); }
     catch (error) { if (!this.#refused(copy, error, `warm-up of ${copy.path}`)) throw error; }
    });
    if (copy.session && this.#starting.has(copy.session.id)) this.#reconcileStarting();
    this.#dirty.add(copy.path); this.#schedulePublish();
   } catch (error) {
    copy.readError = (error as Error).message;
    if (!this.#stopped) { this.#dirty.add(copy.path); this.#schedulePublish(); }
   }
   finally {
    // A failed or empty derive also ends the updating mark: the row keeps its identity and shows the error.
    if (!copy.refreshAgain) this.#settleUpgrade(copy);
    const again = copy.refreshAgain, urgent = copy.urgent;
    copy.refreshing = undefined; copy.deriving = false; copy.refreshAgain = false; copy.urgent = false;
    if (again && !this.#stopped) void this.#refresh(copy, urgent);
   }
  })();
  return copy.refreshing;
 }

 #promote(copy: Copy): void {
  if (copy.urgent) return;
  copy.urgent = true;
  if (copy.refreshing && !copy.deriving) this.#store.urgent(this.#source(copy));
 }

 #isLive(copy: Copy): boolean {
  const a = this.#agentFor(copy.path);
  return Boolean(a?.pane || a?.control?.live);
 }

 #openThread(topic: Topic): string | undefined {
  return (topic.kind === "thread" || topic.kind === "view") && topic.threadId ? String(topic.threadId) : undefined;
 }

 /** Adds a subscription; opening a view marks its Session's copy only when that changes whether the copy is held. */
 #addSub(sid: number, sub: { topic: Topic; previous: PiTopicValue | undefined; n: number; pending?: string }): void {
  const id = this.#openThread(sub.topic), copy = id ? this.#byThread.get(id) : undefined, held = copy && this.#held(copy);
  this.#subs.set(sid, sub);
  if (id) this.#openCount.set(id, (this.#openCount.get(id) ?? 0) + 1);
  // Opening an updating Session moves its re-derive ahead of the cold backlog.
  if (copy?.updating) this.#promote(copy);
  if (copy && this.#held(copy) !== held) { this.#dirty.add(copy.path); this.#schedulePublish(); }
 }

 /** The one way a subscription ends. Closing a Session's last view starts its grace (OPEN_GRACE_MS). */
 #dropSub(sid: number): void {
  const sub = this.#subs.get(sid);
  if (!sub) return;
  const id = this.#openThread(sub.topic), copy = id ? this.#byThread.get(id) : undefined, held = copy && this.#held(copy);
  this.#subs.delete(sid);
  if (!id) return;
  const left = (this.#openCount.get(id) ?? 1) - 1;
  if (left > 0) this.#openCount.set(id, left);
  else this.#openCount.delete(id);
  if (!copy) return;
  if (!left) copy.lastOpenAt = Date.now();
  if (this.#held(copy) !== held) { this.#dirty.add(copy.path); this.#schedulePublish(); }
 }

 /**
  * An open view, or one closed within OPEN_GRACE_MS, holds a Session: its row stays listed and its copy is not evicted.
  * The grace is measured on the marking clock (#inputsAt), so it ends at the first mark (a discovery frame or the audit)
  * after Date.now() passes it; that frame also runs #evictExpired. Before the next mark the difference can be negative, which reads as held.
  */
 #held(copy: Copy): boolean {
  const id = copy.session?.id;
  return Boolean(id && this.#openCount.get(id)) || (copy.lastOpenAt !== undefined && this.#inputsAt - copy.lastOpenAt < this.#inputsGrace);
 }

 /** Expiry reads the marking clock (#inputsAt, #inputsWindow), so a copy is evictable exactly when its row is no longer recent. */
 async #evictExpired(): Promise<void> {
  if (this.#stopped) return;
  for (const copy of this.#copies.values()) {
   const activity = Math.max(copy.updatedAt, copy.closedAt ?? 0);
   if (!activity || !copy.data || copy.readError || copy.data.invalidLines || copy.data.bytes !== copy.offset || !this.#livenessKnown || this.state.status !== "connected" && copy.lastKnownLive ||
       this.#isLive(copy) || this.#held(copy) || copy.leases || copy.refreshing || copy.eviction ||
       this.#inputsAt - activity < this.#inputsWindow) continue;
   if (this.state.status !== "connected") continue;
   copy.evictionCancelled = false;
   copy.eviction = this.#evict(copy).finally(() => { copy.eviction = undefined; });
   await copy.eviction;
  }
 }

 async #evict(copy: Copy): Promise<void> {
  let removed = false;
  try {
   const bytes = copy.offset, generation = copy.generation;
   const changed = () => copy.offset !== bytes || copy.generation !== generation || this.#held(copy) || this.#isLive(copy) || copy.leases || copy.refreshing;
   const ack = await this.#command({ t: "forget", path: copy.path, bytes }, 10_000);
   if (this.#stopped || copy.evictionCancelled || changed()) return;
   removed = await this.#store.forget(this.#source(copy), ack.watermark);
   if (!removed || this.#stopped) return;
   // The source may disappear while the Worker waits behind derivation jobs.
   await this.#command({ t: "forget", path: copy.path, bytes, watermark: ack.watermark }, 10_000);
   if (this.#stopped) return;
   if (changed()) { await this.#refresh(copy); return; }
   this.#copies.delete(copy.path);
   clearTimeout(copy.staleRetry); this.#cacheFault(copy, false);
   if (copy.session) {
    this.#byThread.delete(copy.session.id);
    for (const view of this.#views.values()) view.evict?.(this.#viewContext, copy.session.id);
   }
   for (const suffix of ["", ".index.sqlite", ".index.sqlite-wal", ".index.sqlite-shm"]) rmSync(copy.file + suffix, { force: true });
   // The threads list and Host-wide views lose the copy; no other Session changed.
   this.#hostChanged = true; await this.#writeIndex(); this.#schedulePublish();
  } catch (error) {
   if (this.#stopped) return;
   if (removed) await this.#refresh(copy);
   if ((error as { code?: string }).code === "source_missing") {
    copy.sourceMissing = true; copy.readError = "Original source is unavailable. This copy is retained for recovery";
    this.#dirty.add(copy.path); this.#schedulePublish();
   }
  }
 }

 async #waitForEviction(threadId: string): Promise<void> {
  const copy = this.#copyByThread(threadId);
  if (!copy?.eviction) return;
  copy.evictionCancelled = true;
  this.#store.cancelForget(this.#source(copy));
  await copy.eviction;
 }

	// ---- transport ----

	#connect(): void {
		if (this.#stopped) return;
		const ssh = this.config.kind === "pi-ssh" ? (this.config.target ?? this.config.id) : undefined;
		this.#set({ attempts: ++this.#attempts }, negotiating(this.state, "transport", ssh ? `Starting the Pi agent over ssh on ${ssh}.` : "Starting the Pi agent."));
		instant("agent-spawn", { attempt: this.#attempts, kind: this.config.kind });
		const offsets = Object.fromEntries([...this.#copies].map(([path, c]) => [path, c.offset]));
		const cfg = Buffer.from(JSON.stringify({ offsets, forgotten: this.#store.forgotten(), tailBytes: 0, herdrSession: this.config.herdrSession ?? "default", recentMs: this.#recentMs(), ...agentModules(), ...this.config.agentConfig })).toString("base64");
		const code = readFileSync(AGENT_SCRIPT).toString("base64");
		// The command line stays small and fixed: the agent and its config (offsets grow with every copy) arrive as
		// stdin's first line, under the argument-length limit and out of the Host's process list.
		const launch = agentLaunch(this.config);
		const child =
			this.config.kind === "pi-local"
				? spawn(launch.command, launch.args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...this.config.env } })
				: spawn(launch.command, launch.args, { stdio: ["pipe", "pipe", "pipe"] });
		this.#child = child;
		// A failed command write leaves the link half-open: frames still arrive, but commands vanish until they time
		// out. End the link, so pending commands answer now and the reconnect starts.
		let stdinError = "";
		child.stdin!.on("error", (error: NodeJS.ErrnoException) => {
			stdinError ||= `; hub stdin ${error.code ?? error.message}`;
			child.kill();
		});
		child.stdin!.write(`${JSON.stringify({ cfg, code })}\n`);
		let stderr = "";
		child.stderr!.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-2000);
		});
		// Only `close` starts the reconnect, and some dead links never close: an agent stuck inside process.exit, a
		// stopped process, a stalled SSH pipe. A link with no frame for SILENT_MS is killed, so its close follows.
		// Before the hello the clock runs from the spawn: bytes without a hello do not extend it.
		// A hub that was itself suspended (the Mac slept) restarts the clock instead of blaming the agent.
		let heard = Date.now();
		let ticked = heard;
		let silence: { error: string; hint: string } | undefined;
		const watchdog = setInterval(() => {
			const now = Date.now();
			if (now - ticked > 3 * PiHost.SILENT_TICK_MS) heard = now;
			ticked = now;
			if (now - heard <= PiHost.SILENT_MS) return;
			clearInterval(watchdog);
			const seconds = Math.round((now - heard) / 1000);
			silence =
				this.state.status === "connected"
					? { error: `No frame from the Pi agent for ${seconds} s; the hub stopped it.`, hint: "The Host or its connection stalled. The hub reconnects." }
					: {
							error: `The Pi agent sent no hello in ${seconds} s; the hub stopped it.`,
							hint: ssh ? `The link to ${ssh} or the Host may be stalled. Run \`ssh ${ssh}\` in a terminal to check; the hub retries.` : "The agent may be stuck; the hub retries. If this repeats, check the hub log.",
						};
			console.error(`pi host ${this.config.id}: agent ${child.pid} sent no frame for ${now - heard} ms; killing it to reconnect`);
			child.kill("SIGKILL");
		}, PiHost.SILENT_TICK_MS);
		watchdog.unref();
		let buffer = "";
		child.stdout!.setEncoding("utf8");
		child.stdout!.on("data", (data: string) => {
			if (this.state.status === "connecting" && this.state.phase === "transport")
				this.#set({}, negotiating(this.state, "hello", "The Pi agent runs; waiting for its hello."));
			const start = tracing ? nowUs() : 0;
			let frames = 0;
			buffer += data;
			let i: number;
			while ((i = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, i);
				buffer = buffer.slice(i + 1);
				if (!line) continue;
				frames++;
				try {
					const msg = JSON.parse(line);
					watched(() => `agent frame ${msg.t} on ${this.config.id}`, () => this.#fromAgent(msg));
				} catch {}
			}
			if (this.state.status === "connected") heard = Date.now();
			if (tracing) complete("agent-frames", "ipc", start, { bytes: data.length, frames });
		});
		child.on("error", (error) => {
			clearInterval(watchdog);
			this.#closed(child, error.message, ssh ? "Check that ssh is installed and on the hub's PATH." : "Check the hub log; the hub retries.");
		});
		child.on("close", (code, signal) => {
			clearInterval(watchdog);
			if (silence) return this.#closed(child, silence.error, silence.hint);
			const said = `${stderr ? `: ${stderr.trim().split("\n").pop()}` : ""}${stdinError}`;
			if (this.state.status === "connected") return this.#closed(child, `The Pi agent exited (${code ?? signal})${said}.`, "The hub reconnects.");
			this.#closed(
				child,
				`The Pi agent exited before its hello (${code ?? signal})${said}.`,
				ssh ? `Run \`ssh ${ssh}\` in a terminal: it must log in without a prompt, and the Host needs Node.js.` : "Check the hub log; the hub retries.",
			);
		});
	}

	#closed(child: ChildProcess, reason: string, hint: string): void {
		if (child !== this.#child) return;
		this.#child = undefined;
		const delay = Math.min(30_000, 500 * 2 ** Math.min(this.#attempts, 6));
		const now = Date.now();
		this.#set({}, { status: "disconnected", since: now, error: reason, errorClass: "reachability", hint, ...(this.#stopped ? {} : { retryAt: now + delay }) });
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(Object.assign(new Error("Host disconnected; the outcome of this action is unknown"), { code: "host_disconnected" }));
		}
		this.#pending.clear();
		// Retain last-known-live pins without presenting them as current liveness.
		for (const copy of this.#copies.values()) if (this.#isLive(copy)) copy.lastKnownLive = true;
		this.#agents = [];
		this.#agentsByPath = new Map();
		this.#listed = false;
		this.#saveIndex();
		this.#markAll();
		if (!this.#stopped) this.#timer = setTimeout(() => this.#connect(), delay);
	}

	#command(cmd: Record<string, unknown>, timeoutMs: number): Promise<AgentAck> {
		const child = this.#child;
		if (!child?.stdin?.writable || this.state.status !== "connected") return Promise.reject(Object.assign(new Error(`${this.config.label} is not connected`), { code: "host_unavailable" }));
		const id = this.#nextCmd++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(Object.assign(new Error("No acknowledgement from the Host; the outcome is unknown"), { code: "timeout" }));
			}, timeoutMs);
			this.#pending.set(id, { resolve, reject, timer });
			child.stdin!.write(`${JSON.stringify({ ...cmd, id })}\n`);
		});
	}

	#fromAgent(msg: AgentMessage): void {
		if (this.#stopped) return;
		switch (msg.t) {
			case "hello": {
				instant("agent-hello");
				this.#attempts = 0;
				this.#controlOps = new Set(Array.isArray(msg.controlOps) ? msg.controlOps.map(String) : []);
				this.#set({
					attempts: 0,
					node: {
						nodeId: this.config.id,
						hostname: String(msg.host ?? ""),
						platform: "pi",
						user: "",
						home: "",
						version: "pi-backend/1",
						build: "",
						pid: Number(msg.pid ?? 0),
						startedAt: Date.now(),
						storage: this.cacheDir,
					},
				}, { status: "connected", connectedAt: Date.now() });
				// No `connected` event: subscriptions here never depended on the Host, so the hub has nothing to resubscribe.
				this.#markAll();
				return;
			}
			case "beat":
				this.#set({ lastSeen: Date.now() });
				return;
			case "reset": {
				const copy = this.#copy(msg.path);
				writeFileSync(copy.file, "");
				copy.offset = msg.offset;
				copy.sourceBytes = undefined;
				copy.generation++;
    copy.readError = "Source replaced; indexing the current copy";
				this.#store.invalidate(this.#source(copy));
				this.#saveIndex();
				this.#dirty.add(copy.path);
				this.#schedulePublish();
				return;
			}
			case "chunk": {
				const copy = this.#copy(msg.path);
				if (msg.offset !== copy.offset) return; // a stale duplicate after a reconnect
				const buf = Buffer.from(msg.data);
				appendFileSync(copy.file, buf);
				copy.offset += buf.length;
				copy.sourceBytes = msg.size;
				this.#saveIndex();
				void this.#refresh(copy, true);
				return;
			}
			case "agents": {
				this.#agents = msg.agents ?? [];
				// The first agent listed for a path wins, as a scan of the list would find it.
				this.#agentsByPath = new Map();
				for (const a of this.#agents) if (!this.#agentsByPath.has(a.session)) this.#agentsByPath.set(a.session, a);
				this.#listed = true;
				if (msg.layout) this.#layout = msg.layout;
				// Without a pane list (Herdr unavailable) absence proves nothing.
				this.#panes = Array.isArray(msg.panes) ? msg.panes : undefined;
				this.#livenessKnown = Boolean(this.#panes);
				let saved = false;
				for (const copy of this.#copies.values()) {
					const live = this.#isLive(copy);
					if ((this.#livenessKnown || live) && copy.lastKnownLive !== live) { copy.lastKnownLive = live; saved = true; }
					if (copy.refreshing && live) this.#promote(copy);
					if (copy.windowLive !== live) { copy.windowLive = live; this.#store.live(this.#source(copy), live); }
				}
				if (saved) this.#saveIndex();
				this.#reconcileStarting();
				this.#reconcileQueued();
				this.#markHostChanges();
				void this.#evictExpired();
				return;
			}
			case "teams":
				this.#teams = new Map((msg.members ?? []).map((m) => [m.pane, m]));
				this.#teamsFrame = msg;
				this.#markHostChanges();
				return;
			case "limits":
				this.#limits = { windows: msg.windows ?? {}, budget: msg.budget ?? null };
				this.#markHostChanges();
				return;
			case "ack": {
				const pending = this.#pending.get(msg.id);
				if (!pending) return;
				this.#pending.delete(msg.id);
				clearTimeout(pending.timer);
				if (msg.ok) pending.resolve(msg);
				else {
					const error = typeof msg.error === "object" && msg.error ? msg.error : { code: "refused", message: String(msg.error ?? "The Host refused the action") };
					pending.reject(
						Object.assign(new Error(String(error.message)), {
							code: String(error.code ?? "refused"),
							...(typeof msg.pane === "string" ? { pane: msg.pane } : {}),
							...(Array.isArray(error.matches) ? { matches: error.matches.map(String) } : {}),
						}),
					);
				}
				return;
			}
		}
	}

	/** Drops a placeholder once its Session's copy exists, or once its pane, after being listed, leaves Herdr. */
	#reconcileStarting(): void {
		let changed = false;
		for (const s of this.#starting.values()) {
			const listed = this.#panes?.some((p) => p.pane === s.pane);
			if (this.#byThread.has(s.threadId) || (this.#panes && !listed && s.seen)) {
				this.#starting.delete(s.threadId);
				changed = true;
			} else if (listed && !s.seen) {
				s.seen = true;
				changed = true;
			}
		}
		if (changed) {
			this.#saveIndex();
			this.#markAll();
		}
	}

	/** Takes each submission outcome a control reports; one it stopped reporting has an unknown outcome. */
	#noteSubmissions(threadId: string, reported: ControlSubmission[]): void {
		for (const r of reported) {
			const known = this.#queued.get(r.submission);
			if (r.state === "delivered") {
				this.#queued.delete(r.submission);
				continue;
			}
			// Keep this hub's full text over the control's clipped copy.
			const text = known && !known.truncated ? known.text : String(r.text ?? known?.text ?? "");
			const truncated = known && !known.truncated ? undefined : r.truncated || undefined;
			this.#queued.set(r.submission, defined({ threadId, submission: r.submission, deliverAs: r.deliverAs, state: r.state, at: r.at, text, truncated, images: r.images || known?.images, dismissed: known?.dismissed }));
		}
	}

	#reconcileQueued(): void {
		for (const agent of this.#agents) {
			const threadId = this.#copies.get(agent.session)?.session?.id;
			if (!threadId || !agent.control?.live || !Array.isArray(agent.control.submissions)) continue;
			const reported = controlSubmissions(agent.control.submissions);
			this.#noteSubmissions(threadId, reported);
			const listed = new Set(reported.map((r) => r.submission));
			for (const q of this.#queued.values())
				if (q.threadId === threadId && !listed.has(q.submission) && q.state !== "unknown") {
					if (q.dismissed) this.#queued.delete(q.submission);
					else q.state = "unknown";
				}
		}
	}

	#markAll(): void {
		for (const path of this.#copies.keys()) this.#dirty.add(path);
		this.#hostChanged = true;
		this.#schedulePublish();
	}

	/**
	 * After a host-level frame (agents, teams, limits): marks only the copies whose host inputs changed, and the
	 * host-wide values when theirs changed. An identical frame publishes nothing.
	 * Rule: every clock or config value a row reads comes from a value this mark wrote, so a publish never sees a later one.
	 */
	#markHostChanges(): void {
		this.#inputsAt = Date.now();
		this.#inputsWindow = this.#recentMs();
		this.#inputsGrace = PiHost.OPEN_GRACE_MS;
		for (const copy of this.#copies.values()) {
			const key = JSON.stringify(this.#hostInputs(copy));
			if (key === copy.hostKey) continue;
			copy.hostKey = key;
			this.#dirty.add(copy.path);
		}
		const unfiled = this.#agents.filter((a) => a.control?.live && a.sessionId).map(({ bytes: _, ...a }) => a);
		// Pane placement only: a pane's status reaches the threads list through its copy's #hostInputs.
		const panes = this.#panes?.map((p) => [p.pane, p.workspace, p.tab]) ?? null;
		const wide = JSON.stringify([this.#layout, panes, this.#teamsFrame ?? null, [...this.#starting.values()], unfiled]);
		if (wide !== this.#hostWideKey) {
			this.#hostWideKey = wide;
			this.#hostChanged = true;
		}
		if (this.#dirty.size || this.#hostChanged) this.#schedulePublish();
	}

	// ---- projections ----

	#agentFor(path: string): RemoteAgent | undefined {
		return this.#agentsByPath.get(path);
	}

	/**
	 * Everything a Session's projections read from host-level frames: its pane agent, control state, Team membership,
	 * layout labels, model limits, liveness and queued submissions. #summary and #threadValue read host state only
	 * through this, so equal inputs give equal Session values (views/types.ts PiViewSession).
	 */
	#hostInputs(copy: Copy) {
		const agent = this.#agentFor(copy.path);
		const control = agent?.control?.live ? agent.control : undefined;
		const live = agent?.pane ? this.#teams.get(agent.pane) : undefined;
		// Team membership outlives the pane: a closed member keeps its recorded Membership, as on a durable Host
		// (src/durable/reader-side.ts). A Session recorded in more than one Team stays unlabeled.
		const recorded = this.#teamsFrame?.recorded?.filter((m) => m.session === copy.path) ?? [];
		const member = live && live.session === copy.path ? live : new Set(recorded.map((m) => m.team)).size === 1
			? recorded.find((m) => m.role === "lead" || m.role === "leader") ?? recorded[0] : undefined;
		const workspace = this.#layout.workspaces.find((w) => w.id === agent?.workspace);
		const tab = workspace?.tabs.find((t) => t.id === agent?.tab);
		const threadId = copy.session?.id;
		return {
			// Closed Sessions remain recent for one retention window; crossing its edge hides an unlisted row.
			recent: !copy.updatedAt || this.#inputsAt - Math.max(copy.updatedAt, copy.closedAt ?? 0) < this.#inputsWindow,
			agent: agent && { pane: agent.pane, workspace: agent.workspace, workspaceLabel: workspace?.label, tab: agent.tab, tabLabel: tab?.label, title: agent.title, name: agent.name, cwd: agent.cwd, status: agent.status, live: Boolean(agent.pane || agent.control?.live) },
			control: control && { idle: control.idle, compacting: control.compacting, steer: control.pending?.steer ?? 0, followUp: control.pending?.followUp ?? 0, images: Boolean(this.#imageLimits(control)) },
			team: member && { team: member.team, role: member.role, member: member.member },
			limits: modelLimits(copy.model, this.#limits, copy.budgetOverride),
			livenessKnown: this.#livenessKnown,
			lastKnownLive: copy.lastKnownLive,
			queued: threadId ? this.#queuedItems(threadId) : [],
			open: this.#held(copy),
		};
	}

	#threadId(copy: Copy): string | undefined {
		return copy.session?.id;
	}

	#viewSession(copy: Copy): PiViewSession | undefined {
  this.#adoptHead(copy);
  const id = copy.session?.id, data = copy.data;
  if (!id || !data) return undefined;
  return {
   threadId: id, ref: `${this.config.id}/${id}`, path: copy.path, copyFile: copy.file,
   revision: copy.revision, bytes: copy.offset, sourceBytes: copy.sourceBytes, sourceVersion: data.version, data, readError: copy.readError,
   summary: this.#summary(copy),
   window: () => this.#store.tail(this.#source(copy), data, this.#isLive(copy)).entries,
   rarebits: (before, fullText, around) => {
    const value = this.#store.rarebits(copy.path, copy.revision, before, fullText, around);
    // Like thread.history: an entry missing while the copy still indexes may sit in bytes not read yet.
    return value.around?.found === "missing" && (copy.refreshing || copy.refreshAgain) ? { ...value, around: { ...value.around, found: "indexing" } } : value;
   },
   rarebitSnapshot: (maxChars) => this.#store.rarebitSnapshot(copy.path, maxChars),
   arcEvidence: (ids) => this.#store.arcEvidence(copy.path, ids, data.version),
   nearest: (at) => this.#store.nearest(copy.path, at),
   entryTimes: (ids) => this.#store.entryTimes(copy.path, ids),
  };
 }

	#copyByThread(threadId: string): Copy | undefined {
		return this.#byThread.get(threadId);
	}

	#recentMs(): number {
		return this.config.recentMs ?? SESSION_SCOPE_MS;
	}

	#summary(copy: Copy): ThreadSummary | undefined {
  this.#adoptHead(copy);
		const session = copy.session;
		if (!session) return undefined;
		const { recent, agent, control, team, limits, livenessKnown, lastKnownLive, open } = this.#hostInputs(copy);
		// Unknown/source-loss copies stay visible.
		if (livenessKnown && !copy.readError && !copy.data?.invalidLines && !agent && !recent && !open && !lastKnownLive && !copy.sourceMissing) return undefined;
		const busy = control ? !control.idle : agent?.status === "working" || agent?.status === "blocked";
		// A blocked pane waits on its owner (a question or a permission): that is attention, not activity.
		const blocked = agent?.status === "blocked";
		// An open tool call at the tail while the Session runs means it is running tools, whatever the pane shows.
		const activity: ThreadSummary["activity"] = control?.compacting ? "compacting" : blocked ? "idle" : busy ? (copy.data?.openCalls ? "tools" : "streaming") : "idle";
		// The row of a copy without a current head (Copy.updating) has identity and host inputs only. The derived fields
		// (title, cost and spend, model and limits, context, cache hit, preview) stay absent: they would be the previous build's.
		// A live or open Session also hides its model, context, and limits (they come from the head, not the pane or the
		// control socket). That window is short: live and open Sessions re-derive first (refresh-all urgent).
		// The spend counts no class (unreadSpend), so a sum over the row reads as partial.
		const updating = copy.updating;
		// Pi ids are UUIDv7: the head encodes the start time, so the random tail tells apart Sessions started together.
		const title = updating ? [basename(session.cwd ?? ""), agent?.name, session.session.slice(-8)].filter(Boolean).join(" · ")
			: copy.data?.session.title || agent?.title || agent?.name || basename(session.cwd ?? "") || session.session.slice(0, 8);
		const derived = !updating;
		return {
			id: session.id,
			title,
			cwd: session.cwd ?? agent?.cwd ?? "",
			createdAt: session.started ?? copy.updatedAt,
			updatedAt: copy.updatedAt,
			kind: team && team.role !== "lead" ? "worker" : "thread",
			...(team ? { team: { teamId: team.team, role: team.role === "lead" || team.role === "leader" ? "lead" : "worker", worker: team.member } } : {}),
			...(derived && copy.model ? { model: copy.model } : {}),
			activity,
			queued: (control?.steer ?? 0) + (control?.followUp ?? 0),
			...(blocked ? { attention: [{ source: "Herdr", reason: "needs input" }] } : {}),
			costUsd: derived ? copy.cost : 0,
			...(derived ? piSpendFields(copy) : { spend: unreadSpend() }),
			...(copy.readError ? { lastError: copy.readError } : {}),
			...(derived && copy.contextTokens ? { contextTokens: copy.contextTokens } : {}),
			...(derived ? limits : {}),
			...(derived && copy.cacheHit !== undefined ? { cacheHit: copy.cacheHit } : {}),
			...(derived && copy.preview ? { preview: copy.preview } : {}),
			...(updating ? { updating: true } : {}),
			ref: session.ref,
			...(agent?.pane ? { location: defined({ workspace: agent.workspace, workspaceLabel: agent.workspaceLabel, tab: agent.tab, tabLabel: agent.tabLabel, pane: agent.pane }) } : {}),
			// Live means a pane or a control socket runs it; a recent file alone is not.
			live: Boolean(agent?.live),
			control: Boolean(control),
			...(control && this.#imageLimits(control) ? { images: this.#imageLimits(control) } : {}),
		} as ThreadSummary;
	}

	#threadsValue(): ThreadsState {
		const threads: Record<string, ThreadSummary> = {};
		for (const copy of this.#copies.values()) {
			const session = copy.data ? this.#viewSession(copy) : undefined;
			let summary = session ? session.summary : this.#summary(copy);
			if (!summary) continue;
			if (session) for (const view of this.#views.values()) if (view.summarize) summary = { ...summary, ...view.summarize(this.#viewContext, session) };
			threads[summary.id] = summary;
		}
		let layout = this.#layout;
		const unfiled = [...this.#starting.keys(), ...this.#agents.flatMap((a) => (a.control?.live && a.sessionId ? [`pi:${a.sessionId}`] : []))];
		for (const threadId of unfiled) {
			if (threads[threadId]) continue;
			const s = this.#starting.get(threadId);
			const agent = this.#controlAgent(threadId);
			const pane = agent?.pane ?? s?.pane;
			const where = pane ? (this.#panes?.find((p) => p.pane === pane) ?? (agent?.pane ? { pane, workspace: agent.workspace, tab: agent.tab } : undefined)) : undefined;
			threads[threadId] = this.#unfiledSummary(threadId, s, agent, where);
			// Herdr's layout lists only panes with a Session file; place the new pane in its tab.
			if (pane && where?.workspace && where.tab) layout = withPane(layout, where.workspace, where.tab, pane);
		}
		// What this list does not know yet (ThreadsState): saved state only, no liveness, an unfinished refresh.
		const state: ThreadsState = { threads, layout, backend: "pi" };
		if (!this.#initialized) state.indexing = true;
		if (!this.#listed) state.listing = true;
		if (this.#refreshing) state.updating = true;
		return state;
	}

	/** A Session listed before Pi writes its file: from this hub's spawn ledger, a live control descriptor, or both. */
	#unfiledSummary(threadId: string, s: Starting | undefined, agent: RemoteAgent | undefined, where: RemotePane | undefined): ThreadSummary {
		const workspace = this.#layout.workspaces.find((w) => w.id === where?.workspace);
		const tab = workspace?.tabs.find((t) => t.id === where?.tab);
		const control = agent?.control?.live ? agent.control : undefined;
		const createdAt = s?.createdAt ?? agent?.startedAt ?? 0;
		const cwd = s?.cwd ?? agent?.cwd ?? "";
		return {
			id: threadId,
			title: s?.name || agent?.title || agent?.name || basename(cwd) || threadId.slice(3, 11),
			cwd,
			createdAt,
			updatedAt: createdAt,
			kind: "thread",
			activity: control?.compacting ? "compacting" : control && !control.idle ? "streaming" : "idle",
			queued: (control?.pending?.steer ?? 0) + (control?.pending?.followUp ?? 0),
			costUsd: 0,
			preview: s ? "New agent: waiting for its first message" : "Live Session: waiting for its first message",
			ref: `${this.config.id}/${threadId}`,
			...(where ? { location: defined({ workspace: where.workspace, workspaceLabel: workspace?.label, tab: where.tab, tabLabel: tab?.label, pane: where.pane }) } : {}),
			live: true,
			control: Boolean(control),
			...(control && this.#imageLimits(control) ? { images: this.#imageLimits(control) } : {}),
		} as ThreadSummary;
	}

	/**
	 * The live control endpoint of a Session that has no copy yet. Its descriptor's sessionId is the identity (P4);
	 * the copy, once Pi writes the file, takes over under the same thread id.
	 */
	#controlAgent(threadId: string): RemoteAgent | undefined {
		if (this.#byThread.has(threadId)) return undefined;
		return this.#agents.find((a) => a.control?.live && a.sessionId && `pi:${a.sessionId}` === threadId);
	}

	/** Counts a stale read in host state (/api/health, the Host's cache-health note) and logs the first and every Nth. */
	#staleRead(kind: keyof NonNullable<HostState["staleReads"]>, detail: string): void {
		const reads = { reopened: 0, behind: 0, refused: 0, ...this.state.staleReads };
		reads[kind]++;
		this.#set({ staleReads: reads });
		if (kind === "behind" || reads[kind] % PiHost.STALE_LOG_EVERY === 1) console.error(`pi host ${this.config.id}: stale read (${kind} ${reads[kind]}): ${detail}`);
	}

	/**
	 * A publish read refused by its version check: count it, keep the subscriber's last value, and publish the copy
	 * again later. Each retry of the copy doubles its delay, up to STALE_RETRY_MAX_MS; its next commit resets it.
	 */
	#refused(copy: Copy | undefined, error: unknown, what: string): boolean {
		if ((error as { code?: string }).code !== STALE_VERSION) return false;
		this.#staleRead("refused", `${what}: ${(error as Error).message}`);
		if (copy && !copy.staleRetry) {
			copy.staleDelay = copy.staleDelay ? Math.min(PiHost.STALE_RETRY_MAX_MS, copy.staleDelay * 2) : PiHost.STALE_RETRY_MS;
			copy.staleRetry = setTimeout(() => {
				copy.staleRetry = undefined;
				this.#dirty.add(copy.path);
				this.#schedulePublish();
			}, copy.staleDelay);
			copy.staleRetry.unref?.();
		}
		return true;
	}

	#threadValue(threadId: string): PiThreadView | undefined {
		const copy = this.#copyByThread(threadId);
		if (!copy) {
			const s = this.#starting.get(threadId);
			const agent = this.#controlAgent(threadId);
			if (!s && !agent) {
				const expired = this.#store.expired(threadId);
				if (!expired) return undefined;
				return { conversationId: threadId, hiddenBefore: false, entries: [], live: {}, inbox: {}, agent: { readError: `Copy outside retained scope: ${expired}. Use K5 tools for older history` }, usage: {} };
			}
			return { conversationId: threadId, hiddenBefore: false, entries: [], live: {}, inbox: { items: this.#queuedItems(threadId) }, agent: { cwd: s?.cwd ?? agent?.cwd ?? "" }, usage: { costUsd: 0 } };
		}
		const summary = this.#summary(copy);
		const busy = summary ? summary.activity !== "idle" : false;
		let page: { entries: PiThreadView["entries"]; more: boolean };
		try { page = copy.data ? this.#store.tail(this.#source(copy), copy.data, this.#isLive(copy)) : { entries: [], more: false }; }
		catch (error) { if (this.#refused(copy, error, `thread ${threadId}`)) return undefined; throw error; }
		return {
			conversationId: threadId,
			sourceVersion: copy.data?.version,
			hiddenBefore: page.more,
			entries: page.entries,
			live: busy ? { run: summary ? { activity: summary.activity } : {} } : {},
			inbox: { items: this.#queuedItems(threadId) },
			agent: { cwd: summary?.cwd ?? "", asOf: copy.data?.asOf ?? null, readError: copy.readError ?? null, ...(copy.model ? { model: copy.model } : {}) },
			usage: copy.updating ? {} : { costUsd: copy.cost },
			...(copy.updating ? { updating: true } : {}),
		};
	}

	/** The composer's queue: each undelivered submission with its outcome so far, oldest first. */
	#queuedItems(threadId: string): PiQueuedItem[] {
		return [...this.#queued.values()]
			.filter((q) => q.threadId === threadId && !q.dismissed)
			.sort((a, b) => a.at - b.at)
			.map((q) => {
				const item: Every<PiQueuedItem> = { id: q.submission, mode: q.deliverAs, content: q.text, state: q.state, truncated: q.truncated, images: q.images };
				return defined(item) as PiQueuedItem;
			});
	}

	#value(topic: Topic): PiTopicValue | undefined {
  return this.#store.snapshot(() => this.#snapshotValue(topic));
 }

 #snapshotValue(topic: Topic): PiTopicValue | undefined {
		if (topic.kind === "view") {
			const view = this.#views.get(topic.view);
			if (!view) return undefined;
			// One failing view must not stop the others: its subscribers get an error value, and the next change retries.
			try {
				return view.value(this.#viewContext, topic);
			} catch (error) {
				if (topic.threadId && this.#refused(this.#copyByThread(topic.threadId), error, `view ${view.name} of ${topic.threadId}`)) return undefined;
				console.error(`pi host ${this.config.id}: view ${view.name} failed:`, error);
				return { error: { code: "view_failed", message: `The ${view.name} view failed: ${(error as Error).message}` } };
			}
		}
		if (topic.kind === "threads") return this.#threadsValue();
		if (topic.kind === "thread") return this.#threadValue(topic.threadId);
		if (topic.kind === "node") return { backend: "pi", host: this.config.id };
		return undefined;
	}

	async #subscribe(sid: number, topic: Topic): Promise<void> {
		const token = {};
		this.#dropSub(sid);
		this.#preparing.set(sid, token);
		const indexOnly = topic.kind === "threads" || topic.kind === "node";
		try {
			await (indexOnly ? this.#indexed : this.#loaded);
			if ((topic.kind === "thread" || topic.kind === "view") && topic.threadId) await this.#waitForEviction(topic.threadId);
		}
		catch (error) {
			if (!this.#stopped && this.#preparing.get(sid) === token) {
				this.#preparing.delete(sid);
				this.#emitFrame({ t: "end", sid, reason: this.#failure ?? this.#unavailable((error as Error).message) });
			}
			return;
		}
		if (this.#stopped || this.#preparing.get(sid) !== token) return;
		this.#preparing.delete(sid);
		// Never a silent return: a subscription that cannot be served ends with the reason.
		if (this.#failure || !(indexOnly ? this.#listable : this.#initialized)) {
			this.#emitFrame({ t: "end", sid, reason: this.#failure ?? this.state.error ?? "Host cache unavailable" });
			return;
		}
		if (!["threads", "thread", "node", "view"].includes(topic.kind) || (topic.kind === "view" && !this.#views.has(topic.view))) {
			this.#emitFrame({ t: "end", sid, reason: `${topic.kind} is not available for Pi Sessions yet` });
			return;
		}
		let value: PiTopicValue | undefined;
		try { value = span("snapshot", "ws", () => this.#value(topic), tracing ? { topic: topic.kind, view: topic.kind === "view" ? topic.view : undefined } : undefined); }
		catch (error) { this.#emitFrame({ t: "end", sid, reason: (error as Error).message }); return; }
		// A Session the Host does not list yet keeps its subscription: the publish that lists it sends the snapshot.
		if (value === undefined) {
			const pending = this.#pendingReason(topic);
			this.#addSub(sid, { topic, previous: undefined, n: 0, pending });
			this.#emitFrame({ t: "pending", sid, reason: pending });
			return;
		}
		this.#addSub(sid, { topic, previous: value, n: 0 });
		this.#emitFrame({ t: "snap", sid, value });
	}

	/**
	 * Why a subscription has no value yet. Before the first agents list of a connection, absence proves nothing;
	 * after it, an id no agent reports is missing. Both stay subscribed: the Session can still appear.
	 */
	#pendingReason(topic: Topic): string {
		const threadId = "threadId" in topic ? topic.threadId : undefined;
		if (!this.#listed) return "Looking for this Session on the Host…";
		if (threadId && this.#agents.some((a) => a.sessionId && `pi:${a.sessionId}` === threadId)) return "Reading this Session from the Host…";
		return "Unknown Session on this Host";
	}

	/** Tells views which Sessions changed; one failing view does not stop the others or the publish. */
	#notifyChanged(dirty: Set<string>): void {
		const views = [...this.#views.values()].filter((v) => v.changed);
		if (!views.length || !dirty.size) return;
		const sessions = [...dirty].map((path) => this.#copies.get(path)).flatMap((c) => (c ? [this.#viewSession(c)] : [])).filter((s): s is PiViewSession => Boolean(s));
		for (const view of views) try { view.changed!(this.#viewContext, sessions); } catch (error) { console.error(`pi host ${this.config.id}: view ${view.name} change hook failed:`, error); }
	}

	/** One Host state event per publish at most, however many copies settled since the last one. */
	#publishUpgrade(): void {
		const { updated, total } = this.#upgrade;
		const upgrade = updated < total ? { updated, total } : undefined;
		if (upgrade?.updated === this.state.upgrade?.updated && upgrade?.total === this.state.upgrade?.total) return;
		this.#set({ upgrade });
	}

	#schedulePublish(): void {
		if (this.#publishScheduled) return;
		this.#publishScheduled = true;
		setImmediate(() => watched(() => `publish on ${this.config.id} (${this.#subs.size} subscriptions)`, () => {
			this.#publishScheduled = false;
			if (this.#stopped || !this.#initialized) return;
			const start = tracing ? nowUs() : 0;
			const dirty = this.#dirty;
			this.#dirty = new Set();
			this.#publishUpgrade();
			const changed = dirty.size > 0 || this.#hostChanged, audit = this.#auditDue && !changed;
			this.#hostChanged = false;
			// An audit due during a change waits for the next quiet publish.
			if (this.#auditDue && changed) setImmediate(() => this.#schedulePublish());
			else this.#auditDue = false;
			// Copy data also feeds host inputs (`recent` reads updatedAt, `limits` the model). Record what this publish
			// reads, so the next frame does not mark the copy again for a change already published. Only a publish
			// records: views read #summary at other times, and a key recorded before a frame's marking would hide it.
			for (const path of dirty) { const copy = this.#copies.get(path); if (copy) copy.hostKey = JSON.stringify(this.#hostInputs(copy)); }
			const dirtyThreads = new Set([...dirty].map((path) => this.#copies.get(path)).filter(Boolean).map((c) => this.#threadId(c!)));
			this.#notifyChanged(dirty);
			const forced = this.#forcedViews;
			this.#forcedViews = new Set();
			for (const [sid, sub] of this.#subs) {
				if (sub.pending) {
					// Every publish rechecks a pending subscription: the change that lists its Session may touch no copy it knows.
					const value = this.#value(sub.topic);
					if (value === undefined) {
						const reason = this.#pendingReason(sub.topic);
						if (reason !== sub.pending) this.#emitFrame({ t: "pending", sid, reason });
						sub.pending = reason;
						continue;
					}
					sub.pending = undefined;
					sub.previous = value;
					sub.n = 0;
					this.#emitFrame({ t: "snap", sid, value });
					continue;
				}
				// A quiet topic has no marked input; the audit recomputes it anyway to catch an input marking missed.
				const quiet = sub.topic.kind === "threads" ? !changed : sub.topic.kind === "thread" ? !dirtyThreads.has(sub.topic.threadId) : false;
				if (quiet && !audit) continue;
				if (sub.topic.kind === "view" && !forced.has(sub.topic.view)) {
					// "thread" without a threadId (e.g. every Team) recomputes like "any".
					const scope = sub.topic.threadId ? (this.#views.get(sub.topic.view)?.scope ?? "thread") : "any";
					if (scope === "any" ? !changed : !dirtyThreads.has(sub.topic.threadId as string)) continue;
					// Host-wide values cover every Session; a live Session appending many times a second must not
					// recompute and diff them each time. Defer to the end of the window instead.
					if (scope === "any" && sub.at !== undefined && Date.now() - sub.at < PiHost.ANY_VIEW_MS) {
						this.#anyDeferred.add(sub.topic.view);
						this.#anyTimer ??= setTimeout(() => {
							this.#anyTimer = undefined;
							for (const view of this.#anyDeferred) this.#forcedViews.add(view);
							this.#anyDeferred.clear();
							this.#schedulePublish();
						}, PiHost.ANY_VIEW_MS - (Date.now() - sub.at));
						this.#anyTimer.unref?.();
						continue;
					}
					if (scope === "any") sub.at = Date.now();
				}
				const value = watched(() => `topic ${sub.topic.kind === "view" ? sub.topic.view : sub.topic.kind}`, () => this.#value(sub.topic));
				if (value === undefined) continue;
				// No value sent yet: the first one goes as a snapshot.
				if (sub.previous === undefined) { sub.previous = value; this.#emitFrame({ t: "snap", sid, value }); continue; }
				const ops = diffRevisions(sub.previous, value);
				sub.previous = value;
				// A change marked during this publish (data adopted while computing) is explained; the next publish carries it.
				const explained = sub.topic.kind === "thread" ? this.#dirty.has(this.#byThread.get(sub.topic.threadId)?.path ?? "") : this.#dirty.size > 0 || this.#hostChanged;
				if (audit && quiet && ops.length && !explained) {
					this.missedInputs++;
					const what = sub.topic.kind === "thread" ? `thread ${sub.topic.threadId}` : "threads";
					console.error(`pi host ${this.config.id}: ${what}: refresh found ${ops.length} changed values; hostKey missed an input (first: ${(ops[0]![1] as unknown[]).join(" ")})`);
				}
				if (ops.length > 0) this.#emitFrame({ t: "ops", sid, n: ++sub.n, ops });
			}
			if (tracing) complete("publish", "ws", start, { dirty: dirty.size, subs: this.#subs.size });
		}));
	}

	// ---- operations ----

	async #request(id: number, request: { op: string; args: unknown }): Promise<void> {
		try {
			const value = await spanAsync("op", "ws", () => this.#op(request), tracing ? { op: request.op.slice(0, 40) } : undefined);
			if (this.#stopped) return;
			this.#emitFrame({ t: "res", id, ok: true, value });
		} catch (error) {
			if (this.#stopped) return;
			const { code = "error", pane, matches } = error as { code?: string; pane?: string; matches?: string[] };
			this.#emitFrame({ t: "res", id, ok: false, error: { code, message: (error as Error).message, ...(pane ? { pane } : {}), ...(matches ? { matches } : {}) } });
		}
	}

	/** Runs a request through the op table; a name the table lacks is refused as `unsupported`. */
	async #op(request: { op: string; args: unknown }): Promise<OpResult> {
		await this.#loaded;
		const threadId = threadOf(request.args);
		if (threadId) await this.#waitForEviction(threadId);
		if (this.#stopped || !this.#initialized) throw new Error("Host stopped");
		if (!isOpRequest(this.#ops, request)) {
			const message = request.op.startsWith("view.") ? `${request.op} is not available` : `${request.op} is not available for Pi Sessions yet`;
			throw Object.assign(new Error(message), { code: "unsupported" });
		}
		return this.#run(request.op, request.args);
	}

	#run<K extends OpName>(op: K, args: Ops[K]["args"]): Promise<OpResult<K>> {
		return this.#ops[op](args);
	}

	/** The op names this Host serves: the registry test compares them with `Ops`. */
	opNames(): string[] {
		return Object.keys(this.#ops);
	}

	/** The Host's own ops (`HostOps`). Arguments are the sender's JSON: each handler checks what it reads. */
	#hostOps(): OpHandlers<keyof HostOps> {
		return {
			"thread.submit": async (args) => {
				const images = Array.isArray(args.images) ? args.images.map((i: { data?: unknown; mimeType?: unknown }) => ({ data: String(i?.data ?? ""), mimeType: String(i?.mimeType ?? "") })) : [];
				const text = String(args.content ?? "");
				if (!text.trim() && !images.length) throw Object.assign(new Error("Empty message"), { code: "invalid" });
				// Pi runs plain slash text as a command. A page built before `asText` sends a command it could not type
				// this way, so slash text goes as a message only when the owner chose it, before any route is chosen.
				// `unsupported`: the code older pages already show as a final refusal (composer-outcomes FINAL_REFUSAL).
				if (!images.length && text.trim().startsWith("/") && args.asText !== true)
					throw Object.assign(new Error("This page is older than the hub. Reload it."), { code: "unsupported" });
				const deliverAs = args.whenBusy === "steer" ? "steer" : "followUp";
				// A live control socket proves delivery; prefer it over typing into a pane this hub made.
				const filed = this.#copyByThread(String(args.threadId)) || this.#controlAgent(String(args.threadId));
				const starting = filed ? undefined : this.#starting.get(String(args.threadId));
				if (images.length) {
					// A Session with no file yet has only its pane, and keys cannot carry an image.
					const { path, agent } = starting ? { path: "", agent: {} as RemoteAgent } : this.#target(String(args.threadId));
					const ack = await this.#command({ t: "submit", session: path, text, deliverAs, images: this.#imagesFor(agent, images) }, 130_000);
					return this.#noteSubmission(String(args.threadId), deliverAs, text, ackResult(ack));
				}
				if (starting) {
					// No Session file yet: type into the pane this hub asked Herdr for; the Host checks its spawn ledger.
					const ack = await this.#command({ t: "submit", pane: starting.pane, expectSession: starting.sessionId, text, deliverAs }, 20_000);
					return ackResult(ack);
				}
				const { path, agent } = this.#target(String(args.threadId));
				const ack = await this.#command({ t: "submit", session: path, pane: agent.pane, text, deliverAs }, agent.control?.live ? 130_000 : 20_000);
				return this.#noteSubmission(String(args.threadId), deliverAs, text, ackResult(ack));
			},
			"thread.commands": async (args) => {
				const ack = await this.#slash(String(args.threadId), { t: "commands" }, 10_000);
				if (!ack.value) throw Object.assign(new Error("The control sent no command list"), { code: "control_error" });
				return ack.value;
			},
			"thread.command": async (args) => {
				// The composer decides a draft is a command; the Host routes it by name and never sends it as a message.
				const name = String(args.name ?? "");
				const deliverAs = args.whenBusy === "steer" ? "steer" : undefined;
				const cmd = defined({
					t: "command",
					name,
					args: typeof args.args === "string" ? args.args : undefined,
					key: typeof args.key === "string" ? args.key : undefined,
					abort: args.abort === true ? true : undefined,
					deliverAs,
				});
				// 130 s: a skill or template waits on compaction and delivery holds as submit does.
				const ack = await this.#slash(String(args.threadId), cmd, 130_000);
				if (!ack.disposition) throw Object.assign(new Error("The control sent no disposition; the outcome is unknown"), { code: "control_unconfirmed" });
				const result: CommandAck = defined({
					via: ack.via,
					disposition: ack.disposition,
					notice: typeof ack.notice === "string" ? ack.notice : undefined,
					effect: ack.effect && typeof ack.effect === "object" ? ack.effect : undefined,
					evidence: ack.evidence,
					entryId: typeof ack.entryId === "string" ? ack.entryId : undefined,
					submission: typeof ack.submission === "string" ? ack.submission : undefined,
				});
				if (result.submission && !this.#queued.has(result.submission)) {
					const text = `/${name}${typeof args.args === "string" && args.args ? ` ${args.args}` : ""}`;
					this.#queued.set(result.submission, { threadId: String(args.threadId), submission: result.submission, deliverAs: deliverAs ?? "followUp", state: "queued", at: Date.now(), text });
					this.#markAll();
				}
				return result;
			},
			"thread.abort": async (args) => {
				const { path, agent } = this.#target(String(args.threadId));
				const ack = await this.#command({ t: "abort", session: path, pane: agent.pane }, 20_000);
				const result = ackResult(ack);
				if (result.submissions) {
					this.#noteSubmissions(String(args.threadId), result.submissions);
					this.#markAll();
				}
				return result;
			},
			"thread.withdraw": async (args) => {
				// Pi takes back queued input only all at once (abort or dequeue); here the owner clears a settled outcome.
				const q = this.#queued.get(String(args.submissionId));
				if (!q || q.threadId !== String(args.threadId)) return { withdrawn: false };
				if (q.state === "queued")
					throw Object.assign(new Error("Pi cannot take back one queued message. Stop returns all of them to Pi's input box."), { code: "unsupported" });
				q.dismissed = true;
				this.#markAll();
				return { withdrawn: true };
			},
			"thread.create": async (args) => {
				// One in-flight create per requestId here; the Host's spawn ledger answers repeats after that.
				const requestId = String(args.requestId ?? "").toLowerCase();
				const running = this.#creates.get(requestId);
				if (running) return running;
				const created = this.#create({ ...args, requestId });
				if (UUID.test(requestId)) {
					this.#creates.set(requestId, created);
					void created.catch(() => {}).finally(() => this.#creates.delete(requestId));
				}
				return created;
			},
			"thread.resume": async (args) => {
				const requestId = String(args.requestId ?? "").toLowerCase();
				const running = this.#creates.get(requestId);
				if (running) return running;
				const resumed = this.#resume({ ...args, requestId });
				if (UUID.test(requestId)) {
					this.#creates.set(requestId, resumed);
					void resumed.catch(() => {}).finally(() => this.#creates.delete(requestId));
				}
				return resumed;
			},
			"thread.close": async (args) => {
				const starting = this.#starting.get(String(args.threadId));
				if (starting) {
					const ack = await this.#command({ t: "close", pane: starting.pane, expectSession: starting.sessionId, lastPane: args.lastPane === true }, 45_000);
					this.#starting.delete(starting.threadId);
					this.#saveIndex();
					this.#markAll();
					return ackResult(ack);
				}
				const { path, copy, agent } = this.#target(String(args.threadId));
				if (!agent.pane) throw Object.assign(new Error("This Session is not in a pane"), { code: "not_in_pane" });
				// Mark the close first: discovery can report the closed pane before the ack, and an old Session must
				// stay in its retention window then. A failed close only keeps the copy one window longer.
				if (copy) {
					copy.closedAt = Date.now();
					this.#saveIndex();
				}
				const ack = await this.#command({ t: "close", session: path, pane: agent.pane, lastPane: args.lastPane === true }, 45_000);
				if (copy) {
					this.#dirty.add(copy.path);
					this.#schedulePublish();
				} else this.#markAll();
				return ackResult(ack);
			},
			"sessions.search": async (args) => {
    return this.#store.snapshot(() => {
     let notIndexed = 0, stale = 0, updating = 0;
     for (const copy of this.#copies.values()) {
      this.#adoptHead(copy);
      if (copy.updating) updating++; else if (!copy.data) notIndexed++; else if (copy.readError || copy.offset !== copy.data.bytes) stale++;
     }
     const value = this.#store.search(String(args.query ?? ""));
     return { ...value, coverage: { ...value.coverage!, notIndexed, stale, ...(updating ? { updating } : {}) }, hostStatus: this.state.status };
    });
   },
			"thread.outline": async (args) => {
				const copy = this.#copyByThread(String(args.threadId));
				if (!copy) throw new Error("Session unavailable");
				return this.#store.outline(copy.path);
			},
			"thread.find": async (args) => {
				const copy = this.#copyByThread(String(args.threadId));
				if (!copy?.data) {
					// The thread topic stays pending for the same Session and announces the index; an evicted copy never returns.
					const expired = this.#store.expired(String(args.threadId));
					if (expired) throw Object.assign(new Error(`Copy outside retained scope: ${expired}`), { code: NOT_FOUND });
					return { indexing: true };
				}
				const release = this.#viewContext.lease(copy.session!.id);
				try { return await this.#store.find(this.#source(copy), String(args.query ?? ""), copy.data.version, { ...(typeof args.from === "string" ? { from: args.from } : {}), ...(args.tail === true ? { tail: true } : {}) }); }
				finally { release(); }
			},
			"thread.history": async (args) => {
				const copy = this.#copyByThread(String(args.threadId));
				if (!copy && this.#controlAgent(String(args.threadId))) return { entries: [], more: false };
				if (!copy) throw Object.assign(new Error("Unknown Session on this Host"), { code: "not_found" });
				try {
					return this.#store.page(copy.path, { limit: Number(args.limit ?? 200), before: typeof args.before === "string" ? args.before : undefined,
						around: typeof args.around === "string" ? args.around : undefined, version: typeof args.version === "string" ? args.version : undefined });
				} catch (error) {
					// An entry missing while the copy still indexes may sit in bytes not read yet; only an idle index proves it off-branch.
					if ((error as { code?: string }).code === NOT_FOUND && (copy.refreshing || copy.refreshAgain || !copy.data)) throw Object.assign(new Error("This Session is still indexing; the entry is not indexed yet"), { code: INDEXING });
					throw error;
				}
   },
   "thread.entry": async (args) => {
    const copy = this.#copyByThread(String(args.threadId));
    if (!copy) throw new Error("Session unavailable");
    return this.#store.entry(this.#source(copy), String(args.entry), Number(args.offset ?? 0), typeof args.version === "string" ? args.version : undefined);
   },
			"prompts.list": async () => ({ prompts: [], skills: [] }),
			"models.list": async () => [],
		};
	}

	/**
	 * Asks Herdr for a new Pi agent whose Session id is the requestId, so the thread id is known before Herdr runs
	 * anything. Answers at the spawn ack: until Pi writes the Session file, a placeholder makes the thread navigable.
	 */
	async #create(args: HostOps["thread.create"]["args"]): Promise<ThreadCreated> {
		const requestId = typeof args.requestId === "string" ? args.requestId.toLowerCase() : "";
		if (!UUID.test(requestId)) throw Object.assign(new Error("requestId must be a UUID"), { code: "invalid" });
		const cwd = typeof args.cwd === "string" ? args.cwd : "";
		if (!cwd) throw Object.assign(new Error("A working directory is required"), { code: "invalid" });
		const name = typeof args.name === "string" && args.name ? args.name : `pi-${requestId.slice(0, 8)}`;
		const prompt = typeof args.prompt === "string" && args.prompt.trim() ? args.prompt : undefined;
		const ack = await this.#spawn(defined({ t: "spawn", requestId, sessionId: requestId, cwd, name, prompt, ...this.#placement(args.place, cwd) }));
		const pane = String(ack.pane);
		const threadId = `pi:${requestId}`;
		const bound = this.#byThread.has(threadId);
		const pending: { pending?: true } = bound ? {} : { pending: true };
		if (!bound && !this.#starting.has(threadId)) {
			this.#starting.set(threadId, { threadId, sessionId: requestId, name: String(ack.name ?? name), cwd, pane, createdAt: Date.now(), seen: false });
			this.#saveIndex();
			this.#reconcileStarting();
			this.#markAll();
		}
		return defined({
			threadId,
			pane,
			evidence: ack.evidence,
			submitted: ack.submitted,
			warning: ack.warning,
			...pending,
		});
	}

	/** Resumes a Session that no pane runs: Herdr starts `pi --session <its file>` in a new pane. */
	async #resume(args: HostOps["thread.resume"]["args"]): Promise<ThreadResumed> {
		const requestId = String(args.requestId ?? "");
		if (!UUID.test(requestId)) throw Object.assign(new Error("requestId must be a UUID"), { code: "invalid" });
		const threadId = String(args.threadId);
		const copy = this.#copyByThread(threadId);
		if (!copy && this.#controlAgent(threadId)) throw Object.assign(new Error("This Session is already running"), { code: "already_running" });
		if (!copy?.session) throw Object.assign(new Error("Unknown Session on this Host"), { code: "not_found" });
		const agent = this.#agentFor(copy.path);
		// Two Pi processes on one Session file would interleave its entries.
		if (agent?.pane || agent?.control?.live) throw Object.assign(new Error("This Session is already running"), { code: "already_running" });
		const cwd = typeof args.cwd === "string" && args.cwd ? args.cwd : copy.session.cwd || agent?.cwd || "";
		if (!cwd) throw Object.assign(new Error("The Session has no working directory; give one"), { code: "invalid" });
		const name = typeof args.name === "string" && args.name ? args.name : `pi-${copy.session.session.slice(0, 8)}`;
		const ack = await this.#spawn({ t: "spawn", requestId, resume: copy.path, cwd, name, ...this.#placement(args.place, cwd) });
		return defined({ threadId, pane: String(ack.pane), evidence: ack.evidence, warning: ack.warning });
	}

	#placement(place: Placement | undefined, cwd: string): { beside: string; direction: "right" | "down" } | { label: string } {
		if (place && "beside" in place && typeof place.beside === "string") {
			const { agent } = this.#target(place.beside);
			if (!agent.pane) throw Object.assign(new Error("That Session is not in a pane"), { code: "not_in_pane" });
			return { beside: agent.pane, direction: place.direction === "down" ? "down" : "right" };
		}
		if (place && "workspace" in place && place.workspace === "new") return { label: typeof place.label === "string" && place.label ? place.label : basename(cwd) || cwd };
		throw Object.assign(new Error('place must be { beside, direction } or { workspace: "new" }'), { code: "invalid" });
	}

	/** One spawn on the Host. Herdr may take up to 30 s to start Pi, after the split and rename; never retried here. */
	async #spawn(cmd: Record<string, unknown>): Promise<AgentAck> {
		try {
			return await this.#command(cmd, 60_000);
		} catch (error) {
			const { code, pane } = error as { code?: string; pane?: string };
			if (!pane) throw error;
			throw Object.assign(new Error(`Herdr made pane ${pane} but did not start Pi in it (${(error as Error).message}); the pane is left open in Herdr`), { code, pane });
		}
	}

	/** Tracks a queued submission the control admitted. A status frame may have reported it first, with a clipped text and a later state. */
	#noteSubmission<R extends { submission?: string }>(threadId: string, deliverAs: "steer" | "followUp", text: string, result: R): R {
		if (!result.submission) return result;
		const seen = this.#queued.get(result.submission);
		if (seen) Object.assign(seen, { text, truncated: undefined });
		else this.#queued.set(result.submission, { threadId, submission: result.submission, deliverAs, state: "queued", at: Date.now(), text });
		this.#markAll();
		return result;
	}

	/**
	 * Images reach Pi only through a live control that takes them (pi-hc-control `status.images`): keys cannot type
	 * an image, and an older tier would drop it and send the text alone. Refuses at once with the tier to update.
	 */
	/**
	 * The Session's image capability: the control's `images: 1` names pi-hc-control's IMAGE_LIMITS, and the Host's
	 * agent must forward images. The same checks as #imagesFor, so the Composer offers images only where a send can succeed.
	 */
	#imageLimits(control: { images?: boolean }): ImageLimits | undefined {
		return control.images && this.#controlOps.has("submit.images") ? IMAGE_LIMITS : undefined;
	}

	#imagesFor<I extends { data: string; mimeType: string }>(agent: RemoteAgent, images: I[]): I[] {
		const refuse = (code: string, message: string) => Object.assign(new Error(message), { code });
		if (!agent.control?.live) throw refuse("no_control", "This Session has no live control socket, so AmPi cannot send images; paste them in the Pi pane");
		if (!this.#controlOps.has("submit.images")) throw refuse("images_unsupported", `The AmPi agent on ${this.config.label} is too old to send images; it updates when AmPi reconnects to the Host`);
		if (!agent.control.images) throw refuse("images_unsupported", "This Pi's control is too old for images: update pi-hc-control and /reload in the Pi pane");
		// The Composer's own admission, as defense: a client that skipped it still gets the reason.
		const line = rejectionLine(admitImages([], images.map((image, i) => ({ name: `image ${i + 1}`, type: image.mimeType, base64: image.data.length })), IMAGE_LIMITS).rejected);
		if (line) throw refuse("too_large", line);
		return images;
	}

	/**
	 * A slash-command frame to the remote agent. Refuses at once when any tier it knows of lacks the ops. The list
	 * needs a live control. A command goes to the agent with the pane whatever this Host last saw of the control:
	 * the agent checks the control again when it sends, and with none types the command into the pane.
	 */
	#slash(threadId: string, cmd: Record<string, unknown>, timeoutMs: number): Promise<AgentAck> {
		const { path, agent } = this.#target(threadId);
		const unsupported = (message: string) => Promise.reject(Object.assign(new Error(message), { code: "commands_unsupported" }));
		if (!this.#controlOps.has(String(cmd.t))) return unsupported(`The AmPi agent on ${this.config.label} is too old for slash commands; it updates when AmPi reconnects to the Host`);
		if (agent.control?.live && !agent.control.commands) return unsupported("This Pi's control is too old for slash commands: update pi-hc-control and /reload in the Pi pane");
		if (cmd.t === "command" && !agent.control?.live && !this.#controlOps.has("command.keys")) return unsupported(`The AmPi agent on ${this.config.label} is too old to type slash commands into the Pi pane; it updates when AmPi reconnects to the Host`);
		if (cmd.t === "commands" && !agent.control?.live) return Promise.reject(Object.assign(new Error("This Session has no live control socket, so AmPi cannot list slash commands; Enter types a command into the Pi pane"), { code: "no_control" }));
		return this.#command({ ...cmd, session: path, pane: agent.pane }, timeoutMs);
	}

	/** The Session file path and its running agent; a Session without a copy is a target only through its live control endpoint. */
	#target(threadId: string): { path: string; copy?: Copy; agent: RemoteAgent } {
		const copy = this.#copyByThread(threadId);
		const agent = copy ? this.#agentFor(copy.path) : this.#controlAgent(threadId);
		if (!copy && !agent) throw Object.assign(new Error("Unknown Session on this Host"), { code: "not_found" });
		if (!agent || (!agent.pane && !agent.control?.live)) throw Object.assign(new Error("This Session is not running in a pane on its Host"), { code: "not_running" });
		return { path: copy?.path ?? agent.session, copy, agent };
	}
}

/** The `threadId` a request names, if any. */
function threadOf(args: unknown): string | undefined {
	return typeof args === "object" && args !== null && "threadId" in args && typeof args.threadId === "string" ? args.threadId : undefined;
}

/** Narrows a wire request to an op the table serves. Its arguments stay the sender's JSON. */
function isOpRequest(ops: OpHandlers, request: { op: string; args: unknown }): request is OpRequest {
	return Object.hasOwn(ops, request.op);
}
