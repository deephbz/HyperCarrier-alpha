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
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { diffRevisions } from "@earendil-works/chord/delta";
import type { HostState } from "../hub/hosts.ts";
import type { ActionAck, ClientFrame, CommandAck, SlashCommands, ControlSubmission, HostOps, OpHandlers, OpName, OpRequest, OpResult, Ops, Placement, PiHostFrame, PiThreadView, PiTopicValue, SubmittedPrompt, ThreadCreated, ThreadResumed, ThreadsState, ThreadSummary, Topic } from "../shared/protocol.ts";
import { SESSION_SCOPE_MS } from "../shared/session-scope.ts";
import { ask } from "./ask.ts";
import { resolveHelperModel } from "../hub/helper-models.ts";
import { piModelRegistry } from "./model-registry.ts";
import { complete, instant, nowUs, span, spanAsync, tracing } from "../trace.ts";
import { watched } from "../loop-watch.ts";
import { PI_VIEWS, viewOps } from "./views/index.ts";
import type { HostedView, PiTeamMember, PiTeamsFrame, PiViewContext, PiViewSession } from "./views/types.ts";
import type { WorkingSet } from "./working-set.ts";
import type { Derived, Source as CopySource } from "./working-set-types.ts";

export type PiHostConfig = {
	/** The owner's SSH config alias for this Host, or the hub machine's own alias. It is the Host's identity. */
	id: string;
	label: string;
	kind: "pi-local" | "pi-ssh";
	/** SSH destination; defaults to `id` (the alias). */
	target?: string;
	sshArgs?: string[];
	herdrSession?: string;
	/** Node on the Host. Default `node`. */
	remoteNode?: string;
	/** Root of local copies. Default `~/.ampi/pi-cache`. */
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
type ReaderSession = { id: string; session: string; ref: string; cwd?: string | null; started?: number | null; updated?: number | null; title?: string | null };
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
	/** `commands`: the control serves typed slash commands. */
	control?: { live: boolean; idle: boolean; compacting: boolean; commands?: boolean; pending?: { steer: number; followUp: number }; submissions?: ControlSubmission[] } | null;
};
/**
 * This hub's record of one queued submission. `unknown`: the live control no longer reports it (Pi restarted or
 * switched Session). `dismissed`: the owner cleared it from the composer.
 */
type QueuedInput = { threadId: string; submission: string; deliverAs: string; state: ControlSubmission["state"] | "unknown"; at: number; text: string; truncated?: boolean; dismissed?: boolean };
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
	via?: string; evidence?: string; entryId?: string; submission?: string; submissions?: ControlSubmission[]; submitted?: SubmittedPrompt; warning?: string;
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
/** One undelivered submission as the composer shows it. */
type QueuedItem = { id: string; mode: string; content: string; state: QueuedInput["state"]; truncated?: boolean };
/** Old browser tabs request these names; each maps to its registry op. */
const LEGACY_OPS: Partial<Record<string, OpName>> = { "view.cos-arc.build": "view.cos.arc.build" };

/** Copy metadata and compact derived values. Transcript bodies never stay here. */
type Copy = {
 path: string; file: string; offset: number; session?: ReaderSession; closedAt?: number;
	/** Whole-line length of the Session file at the agent's last read; absent from an agent that does not report it. */ sourceBytes?: number;
 revision: number; data?: Derived; updatedAt: number; cost: number; model?: string;
	contextTokens?: number;
	/** Percent of the latest assistant prompt read from cache, as hc-hud and Pi's footer compute it. */
	cacheHit?: number; preview?: string; lastKnownLive?: boolean; generation: number;
	refreshing?: Promise<void>; deriving?: boolean; refreshAgain?: boolean; urgent?: boolean; leases: number;
	/** Copy file mtime at load; orders the cold backlog newest first. */ copiedAt?: number; eviction?: Promise<void>; evictionCancelled?: boolean; readError?: string; sourceMissing?: boolean;
	/** The copy's host inputs (#hostInputs) at its last publish; a frame that leaves them equal marks nothing. */ hostKey?: string;
	/** Liveness last given to the working set's transcript window. */ windowLive?: boolean;
};

export const THREAD_WINDOW = 400;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_SCRIPT = fileURLToPath(new URL("./remote-agent.cjs", import.meta.url));

/** Reads the first stdin line `{ cfg, code }`, then runs the agent with the rest of stdin as its command stream. */
const BOOTSTRAP = Buffer.from(
	`let b=Buffer.alloc(0);const h=(d)=>{b=Buffer.concat([b,d]);const i=b.indexOf(10);if(i<0)return;process.stdin.off("data",h);process.stdin.pause();const m=JSON.parse(b.subarray(0,i).toString());process.env.HCM_CFG=m.cfg;if(i+1<b.length)process.stdin.unshift(b.subarray(i+1));eval(Buffer.from(m.code,"base64").toString());process.stdin.resume();};process.stdin.on("data",h);`,
).toString("base64");

/** Replicated values are JSON: chord's diff cannot carry `undefined`, so drop such keys. */
function defined<T extends Record<string, unknown>>(value: T): T {
	for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
	return value;
}

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
		submissions: Array.isArray(ack.submissions) ? ack.submissions : undefined,
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
 * A Session model's context window and working budget, resolved as hc-auto-compact resolves its budget: a
 * per-model `budget_tokens`, else the global one, else the window, clamped to the window. Without Auto Compact
 * settings there is no working budget. A Session's `/auto-compact budget` override is not read.
 */
export function modelLimits(model: string | undefined, limits: ModelLimits | undefined): { contextWindow?: number; workingBudget?: number } {
	const window = model ? limits?.windows[model] : undefined;
	if (!window) return {};
	if (!limits?.budget) return { contextWindow: window };
	const configured = limits.budget.models?.[model!] ?? limits.budget.tokens ?? window;
	return { contextWindow: window, workingBudget: Math.min(configured, window) };
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
	/** A Host-wide view recomputes at most this often; changes in between coalesce into one publish. */
	static ANY_VIEW_MS = 500;
	#anyTimer?: ReturnType<typeof setTimeout>;
	#anyDeferred = new Set<string>();
	#saveTimer?: ReturnType<typeof setTimeout>;
	#publishScheduled = false;
	#dirty = new Set<string>();
	/** Host-wide inputs (layout, panes, Teams, unfiled Sessions) changed: the threads topic and Host-wide views recompute. */
	#hostChanged = false;
	#hostWideKey?: string;
	/** The threads topic recomputes at least this often; a difference found then is a host input #hostInputs missed. */
	static AUDIT_MS = 60_000;
	#audit?: ReturnType<typeof setInterval>;
	#auditDue = false;
	/** The clock that #hostInputs' `recent` reads, set when #markHostChanges runs, so a publish never sees a later edge. */
	#inputsAt = 0;
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

	constructor(config: PiHostConfig) {
		super();
		this.config = config;
		this.#viewContext.host = config.id;
		this.cacheDir = join(config.cacheDir ?? join(process.env.AMPI_HOME ?? join(homedir(), ".ampi"), "pi-cache"), digest(config.id).slice(0, 16));
		this.state = { id: config.id, label: config.label, kind: config.kind, ...(config.target ? { target: config.target } : {}), status: "connecting", attempts: 0 };
	}

	// ---- link surface shared with HostLink ----

	start(): void {
		if (this.#loaded || this.#stopping) return;
		this.#stopped = false;
		this.#loaded = (async () => {
			await yieldLoop();
			const { WorkingSet } = await spanAsync("import-working-set", "startup", () => import("./working-set.ts"));
			await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
			this.#store = new WorkingSet(this.config.id, this.cacheDir);
			// The index loads from saved heads while the derive Worker starts; every later step waits for both.
			const ready = spanAsync("working-set-ready", "startup", () => this.#store.ready);
			void ready.catch(() => {});
			await this.#store.readable;
			await spanAsync("load-index", "startup", () => this.#loadIndex());
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
			span("refresh-all", "startup", () => {
				const backlog = [...this.#copies.values()].sort((a, b) => (b.copiedAt ?? 0) - (a.copiedAt ?? 0));
				for (const copy of backlog) void this.#refresh(copy, this.#isLive(copy));
			}, { copies: this.#copies.size });
		}).catch((error) => { if (!this.#stopped) this.#set({ status: "disconnected", error: (error as Error).message }); });
	}

	stop(): Promise<void> {
		if (this.#stopping) return this.#stopping;
		this.#stopped = true;
		clearInterval(this.#sweep);
		clearInterval(this.#audit);
		clearTimeout(this.#anyTimer);
		clearTimeout(this.#saveTimer);
		clearTimeout(this.#timer);
		this.#preparing.clear();
		this.#subs.clear();
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
			} finally { this.#store?.close(); }
		})();
	}

	reconnect(): void {
		clearTimeout(this.#timer);
		this.#attempts = 0;
		this.#child?.kill();
		if (this.state.status !== "connected") void this.#loaded?.then(() => this.#connect()).catch((error) => { if (!this.#stopped) this.#set({ error: (error as Error).message }); });
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
				this.#subs.delete(frame.sid);
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

	#set(change: Partial<HostState>): void {
		this.state = { ...this.state, ...change };
		for (const key of Object.keys(change) as (keyof HostState)[]) if (change[key] === undefined) delete this.state[key];
		this.emit("state", this.state);
	}

	// ---- local copies ----

	#indexFile(): string {
		return join(this.cacheDir, "index.json");
	}

	async #loadIndex(): Promise<void> {
  let index: Record<string, { file: string; offset: number; closedAt?: number; lastKnownLive?: boolean }> = {};
  try { index = JSON.parse(await readFile(this.#indexFile(), "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const [path, meta] of Object.entries(index)) {
   const file = join(this.cacheDir, basename(meta.file));
   let end: number;
   let copiedAt: number;
   try { end = await repairReplicaTail(file); copiedAt = (await stat(file)).mtimeMs; }
   catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
   const copy = this.#newCopy(path, file, end);
   copy.copiedAt = copiedAt;
   copy.closedAt = meta.closedAt; copy.lastKnownLive = meta.lastKnownLive;
   const saved = this.#store.load(path); if (saved) this.#applyDerived(copy, saved);
   await yieldLoop();
  }
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
		this.#saveTimer = setTimeout(() => { void this.#writeIndex().catch((error) => this.#set({ error: (error as Error).message })); }, 300);
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
		});
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
  copy.data = data; copy.session = data.session; copy.updatedAt = data.session.updated ?? 0;
  copy.cost = data.cost; copy.model = data.model; copy.contextTokens = data.contextTokens; copy.cacheHit = data.cacheHit; copy.preview = data.preview;
  this.#byThread.set(data.session.id, copy);
 }

 // SQLite commit is the publication authority. The worker message can arrive
 // after a subscriber reads that commit; never roll a published copy backwards.
 #adoptHead(copy: Copy): void {
  if (!copy.refreshing || !copy.deriving) return;
  const data = this.#store.load(copy.path);
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
    this.#store.snapshot(() => {
     this.#adoptHead(copy);
     if (this.#isLive(copy) && copy.data) this.#store.tail(this.#source(copy), copy.data, true);
    });
    if (copy.session && this.#starting.has(copy.session.id)) this.#reconcileStarting();
    this.#dirty.add(copy.path); this.#schedulePublish();
   } catch (error) {
    copy.readError = (error as Error).message;
    if (!this.#stopped) { this.#dirty.add(copy.path); this.#schedulePublish(); }
   }
   finally {
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

 #isOpen(copy: Copy): boolean {
  return [...this.#subs.values()].some(({ topic }) => (topic.kind === "thread" || topic.kind === "view") && topic.threadId === copy.session?.id);
 }

 async #evictExpired(): Promise<void> {
  if (this.#stopped) return;
  for (const copy of this.#copies.values()) {
   const activity = Math.max(copy.updatedAt, copy.closedAt ?? 0);
   if (!activity || !copy.data || copy.readError || copy.data.invalidLines || copy.data.bytes !== copy.offset || !this.#livenessKnown || this.state.status !== "connected" && copy.lastKnownLive ||
       this.#isLive(copy) || this.#isOpen(copy) || copy.leases || copy.refreshing || copy.eviction ||
       Date.now() - activity < this.#recentMs()) continue;
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
   const changed = () => copy.offset !== bytes || copy.generation !== generation || this.#isOpen(copy) || this.#isLive(copy) || copy.leases || copy.refreshing;
   const ack = await this.#command({ t: "forget", path: copy.path, bytes }, 10_000);
   if (this.#stopped || copy.evictionCancelled || changed()) return;
   removed = await this.#store.forget(this.#source(copy), ack.watermark);
   if (!removed || this.#stopped) return;
   // The source may disappear while the Worker waits behind derivation jobs.
   await this.#command({ t: "forget", path: copy.path, bytes, watermark: ack.watermark }, 10_000);
   if (this.#stopped) return;
   if (changed()) { await this.#refresh(copy); return; }
   this.#copies.delete(copy.path);
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
		this.#set({ status: "connecting", attempts: ++this.#attempts });
		instant("agent-spawn", { attempt: this.#attempts, kind: this.config.kind });
		const offsets = Object.fromEntries([...this.#copies].map(([path, c]) => [path, c.offset]));
		const cfg = Buffer.from(JSON.stringify({ offsets, forgotten: this.#store.forgotten(), tailBytes: 0, herdrSession: this.config.herdrSession ?? "default", recentMs: this.#recentMs(), ...this.config.agentConfig })).toString("base64");
		const code = readFileSync(AGENT_SCRIPT).toString("base64");
		const node = this.config.remoteNode ?? "node";
		// The command line stays small and fixed: the agent and its config (offsets grow with every copy) arrive as
		// stdin's first line, under the argument-length limit and out of the Host's process list.
		const remoteCmd = `exec ${node} -e "eval(Buffer.from('${BOOTSTRAP}','base64').toString())"`;
		const child =
			this.config.kind === "pi-local"
				? spawn("sh", ["-c", remoteCmd], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...this.config.env } })
				: spawn(
						"ssh",
						[
							"-T",
							"-C",
							"-o",
							"BatchMode=yes",
							"-o",
							"ConnectTimeout=10",
							"-o",
							"ServerAliveInterval=15",
							"-o",
							"ServerAliveCountMax=3",
							...(this.config.sshArgs ?? []),
							"--",
							this.config.target ?? this.config.id,
							`sh -lc ${JSON.stringify(remoteCmd)}`,
						],
						{ stdio: ["pipe", "pipe", "pipe"] },
					);
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
		let buffer = "";
		child.stdout!.setEncoding("utf8");
		child.stdout!.on("data", (data: string) => {
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
			if (tracing) complete("agent-frames", "ipc", start, { bytes: data.length, frames });
		});
		child.on("error", (error) => this.#closed(child, error.message));
		child.on("close", (code, signal) => this.#closed(child, `agent exited (${code ?? signal})${stderr ? `: ${stderr.trim().split("\n").pop()}` : ""}${stdinError}`));
	}

	#closed(child: ChildProcess, reason: string): void {
		if (child !== this.#child) return;
		this.#child = undefined;
		this.#set({ status: "disconnected", error: reason });
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
		if (!this.#stopped) this.#timer = setTimeout(() => this.#connect(), Math.min(30_000, 500 * 2 ** Math.min(this.#attempts, 6)));
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
					status: "connected",
					connectedAt: Date.now(),
					error: undefined,
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
				});
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
			if (typeof r?.submission !== "string") continue;
			const known = this.#queued.get(r.submission);
			if (r.state === "delivered") {
				this.#queued.delete(r.submission);
				continue;
			}
			// Keep this hub's full text over the control's clipped copy.
			const text = known && !known.truncated ? known.text : String(r.text ?? known?.text ?? "");
			const truncated = known && !known.truncated ? undefined : r.truncated || undefined;
			this.#queued.set(r.submission, defined({ threadId, submission: r.submission, deliverAs: r.deliverAs, state: r.state, at: r.at, text, truncated, dismissed: known?.dismissed }));
		}
	}

	#reconcileQueued(): void {
		for (const agent of this.#agents) {
			const threadId = this.#copies.get(agent.session)?.session?.id;
			if (!threadId || !agent.control?.live || !Array.isArray(agent.control.submissions)) continue;
			const reported = agent.control.submissions;
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
	 */
	#markHostChanges(): void {
		this.#inputsAt = Date.now();
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
		const member = agent?.pane ? this.#teams.get(agent.pane) : undefined;
		const workspace = this.#layout.workspaces.find((w) => w.id === agent?.workspace);
		const tab = workspace?.tabs.find((t) => t.id === agent?.tab);
		const threadId = copy.session?.id;
		return {
			// Closed Sessions remain recent for one retention window; crossing its edge hides an unlisted row.
			recent: !copy.updatedAt || this.#inputsAt - Math.max(copy.updatedAt, copy.closedAt ?? 0) < this.#recentMs(),
			agent: agent && { pane: agent.pane, workspace: agent.workspace, workspaceLabel: workspace?.label, tab: agent.tab, tabLabel: tab?.label, title: agent.title, name: agent.name, cwd: agent.cwd, status: agent.status, live: Boolean(agent.pane || agent.control?.live) },
			control: control && { idle: control.idle, compacting: control.compacting, steer: control.pending?.steer ?? 0, followUp: control.pending?.followUp ?? 0 },
			team: member && member.session === copy.path ? { team: member.team, role: member.role, member: member.member } : undefined,
			limits: modelLimits(copy.model, this.#limits),
			livenessKnown: this.#livenessKnown,
			lastKnownLive: copy.lastKnownLive,
			queued: threadId ? this.#queuedItems(threadId) : [],
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
   rarebits: (before, fullText) => this.#store.rarebits(copy.path, copy.revision, before, fullText),
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
		const { recent, agent, control, team, limits, livenessKnown, lastKnownLive } = this.#hostInputs(copy);
		// Unknown/source-loss copies stay visible.
		if (livenessKnown && !copy.readError && !copy.data?.invalidLines && !agent && !recent && !this.#isOpen(copy) && !lastKnownLive && !copy.sourceMissing) return undefined;
		const busy = control ? !control.idle : agent?.status === "working" || agent?.status === "blocked";
		// A blocked pane waits on its owner (a question or a permission): that is attention, not activity.
		const blocked = agent?.status === "blocked";
		// An open tool call at the tail while the Session runs means it is running tools, whatever the pane shows.
		const activity: ThreadSummary["activity"] = control?.compacting ? "compacting" : blocked ? "idle" : busy ? (copy.data?.openCalls ? "tools" : "streaming") : "idle";
		const title = session.title || agent?.title || agent?.name || basename(session.cwd ?? "") || session.session.slice(0, 8);
		return {
			id: session.id,
			title,
			cwd: session.cwd ?? agent?.cwd ?? "",
			createdAt: session.started ?? copy.updatedAt,
			updatedAt: copy.updatedAt,
			kind: team && team.role !== "lead" ? "worker" : "thread",
			...(team ? { team: { teamId: team.team, role: team.role === "lead" || team.role === "leader" ? "lead" : "worker", worker: team.member } } : {}),
			...(copy.model ? { model: copy.model } : {}),
			activity,
			queued: (control?.steer ?? 0) + (control?.followUp ?? 0),
			...(blocked ? { attention: [{ source: "Herdr", reason: "needs input" }] } : {}),
			costUsd: copy.cost,
			...(copy.readError ? { lastError: copy.readError } : {}),
			...(copy.contextTokens ? { contextTokens: copy.contextTokens } : {}),
			...limits,
			...(copy.cacheHit !== undefined ? { cacheHit: copy.cacheHit } : {}),
			...(copy.preview ? { preview: copy.preview } : {}),
			ref: session.ref,
			...(agent?.pane ? { location: defined({ workspace: agent.workspace, workspaceLabel: agent.workspaceLabel, tab: agent.tab, tabLabel: agent.tabLabel, pane: agent.pane }) } : {}),
			// Live means a pane or a control socket runs it; a recent file alone is not.
			live: Boolean(agent?.live),
			control: Boolean(control),
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
		return { threads, layout, backend: "pi" };
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
		const page = copy.data ? this.#store.tail(this.#source(copy), copy.data, this.#isLive(copy)) : { entries: [], more: false };
		return {
			conversationId: threadId,
			sourceVersion: copy.data?.version,
			hiddenBefore: page.more,
			entries: page.entries,
			live: busy ? { run: summary ? { activity: summary.activity } : {} } : {},
			inbox: { items: this.#queuedItems(threadId) },
			agent: { cwd: summary?.cwd ?? "", asOf: copy.data?.asOf ?? null, readError: copy.readError ?? null, ...(copy.model ? { model: copy.model } : {}) },
			usage: { costUsd: copy.cost },
		};
	}

	/** The composer's queue: each undelivered submission with its outcome so far, oldest first. */
	#queuedItems(threadId: string): QueuedItem[] {
		return [...this.#queued.values()]
			.filter((q) => q.threadId === threadId && !q.dismissed)
			.sort((a, b) => a.at - b.at)
			.map((q): QueuedItem => defined({ id: q.submission, mode: q.deliverAs, content: q.text, state: q.state, truncated: q.truncated }));
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
		this.#subs.delete(sid);
		this.#preparing.set(sid, token);
		try {
			await this.#loaded;
			if ((topic.kind === "thread" || topic.kind === "view") && topic.threadId) await this.#waitForEviction(topic.threadId);
		}
		catch (error) {
			if (!this.#stopped && this.#preparing.get(sid) === token) this.#emitFrame({ t: "end", sid, reason: "Host cache unavailable: " + (error as Error).message });
		}
		if (this.#stopped || this.#preparing.get(sid) !== token) return;
		this.#preparing.delete(sid);
		if (!this.#initialized) return;
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
			this.#subs.set(sid, { topic, previous: undefined, n: 0, pending });
			this.#emitFrame({ t: "pending", sid, reason: pending });
			return;
		}
		this.#subs.set(sid, { topic, previous: value, n: 0 });
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

	#schedulePublish(): void {
		if (this.#publishScheduled) return;
		this.#publishScheduled = true;
		setImmediate(() => watched(() => `publish on ${this.config.id} (${this.#subs.size} subscriptions)`, () => {
			this.#publishScheduled = false;
			if (this.#stopped || !this.#initialized) return;
			const start = tracing ? nowUs() : 0;
			const dirty = this.#dirty;
			this.#dirty = new Set();
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
				if (Array.isArray(args.images) && args.images.length) throw Object.assign(new Error("Images cannot be sent to a Pi Session from here yet"), { code: "unsupported" });
				const text = String(args.content ?? "");
				if (!text.trim()) throw Object.assign(new Error("Empty message"), { code: "invalid" });
				const deliverAs = args.whenBusy === "steer" ? "steer" : "followUp";
				// A live control socket proves delivery; prefer it over typing into a pane this hub made.
				const filed = this.#copyByThread(String(args.threadId)) || this.#controlAgent(String(args.threadId));
				const starting = filed ? undefined : this.#starting.get(String(args.threadId));
				if (starting) {
					// No Session file yet: type into the pane this hub asked Herdr for; the Host checks its spawn ledger.
					const ack = await this.#command({ t: "submit", pane: starting.pane, expectSession: starting.sessionId, text, deliverAs }, 20_000);
					return ackResult(ack);
				}
				const { path, agent } = this.#target(String(args.threadId));
				const ack = await this.#command({ t: "submit", session: path, pane: agent.pane, text, deliverAs }, agent.control?.live ? 130_000 : 20_000);
				const result = ackResult(ack);
				if (result.submission) {
					// A status frame may have reported it first, with a clipped text and a later state.
					const seen = this.#queued.get(result.submission);
					if (seen) Object.assign(seen, { text, truncated: undefined });
					else this.#queued.set(result.submission, { threadId: String(args.threadId), submission: result.submission, deliverAs, state: "queued", at: Date.now(), text });
					this.#markAll();
				}
				return result;
			},
			"thread.commands": async (args) => {
				const ack = await this.#slash(String(args.threadId), { t: "commands" }, 10_000);
				if (!ack.value) throw Object.assign(new Error("The control sent no command list"), { code: "control_error" });
				return ack.value;
			},
			"thread.command": async (args) => {
				// The composer decides a draft is a command; the hub routes it by name and never sends it as text.
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
     let notIndexed = 0, stale = 0;
     for (const copy of this.#copies.values()) { this.#adoptHead(copy); if (!copy.data) notIndexed++; else if (copy.readError || copy.offset !== copy.data.bytes) stale++; }
     const value = this.#store.search(String(args.query ?? ""));
     return { ...value, coverage: { ...value.coverage!, notIndexed, stale }, hostStatus: this.state.status };
    });
   },
			"thread.find": async (args) => {
				const copy = this.#copyByThread(String(args.threadId));
				if (!copy?.data) throw new Error("Session is not indexed yet");
				const release = this.#viewContext.lease(copy.session!.id);
				try { return await this.#store.find(this.#source(copy), String(args.query ?? ""), copy.data.version); }
				finally { release(); }
			},
			"thread.history": async (args) => {
				const copy = this.#copyByThread(String(args.threadId));
				if (!copy && this.#controlAgent(String(args.threadId))) return { entries: [], more: false };
				if (!copy) throw Object.assign(new Error("Unknown Session on this Host"), { code: "not_found" });
				return this.#store.page(copy.path, { limit: Number(args.limit ?? 200), before: typeof args.before === "string" ? args.before : undefined,
     around: typeof args.around === "string" ? args.around : undefined, version: typeof args.version === "string" ? args.version : undefined });
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

	/**
	 * A slash-command frame to the Session's live control. Refuses at once when any tier lacks the ops.
	 * No control comes first: the composer then types the draft into the pane, whatever the agent's version.
	 */
	#slash(threadId: string, cmd: Record<string, unknown>, timeoutMs: number): Promise<AgentAck> {
		const { path, agent } = this.#target(threadId);
		const unsupported = (message: string) => Promise.reject(Object.assign(new Error(message), { code: "commands_unsupported" }));
		if (!agent.control?.live) return Promise.reject(Object.assign(new Error("This Session has no live control socket, so AmPi cannot run slash commands; use the Pi pane"), { code: "no_control" }));
		if (!this.#controlOps.has(String(cmd.t))) return unsupported(`The AmPi agent on ${this.config.label} is too old for slash commands; it updates when AmPi reconnects to the Host`);
		if (!agent.control.commands) return unsupported("This Pi's control is too old for slash commands: update pi-hc-control and /reload in the Pi pane");
		return this.#command({ ...cmd, session: path }, timeoutMs);
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
