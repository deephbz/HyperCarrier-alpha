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
import type { ClientFrame, NodeFrame, ThreadSummary, Topic } from "../shared/protocol.ts";
import { SESSION_SCOPE_MS } from "../shared/session-scope.ts";
import type { UiEntry, UiThreadView } from "../node/projection.ts";
import { ask } from "./ask.ts";
import { complete, instant, nowUs, span, spanAsync, tracing } from "../trace.ts";
import { PI_VIEWS } from "./views/index.ts";
import type { PiView, PiViewContext, PiViewSession, PiViewTopic } from "./views/types.ts";
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
	control?: { live: boolean; idle: boolean; compacting: boolean; pending?: { steer: number; followUp: number }; submissions?: ControlSubmission[] } | null;
};
/**
 * One input the Session control admitted into Pi's queue, as the control reports it (P7: admission is not delivery).
 * `returned`: it left the queue undelivered and Pi's editor draft holds it (abort, dequeue). `dropped`: it left
 * undelivered and the draft does not hold it. Delivered ones carry no text: the Session file has it.
 */
type ControlSubmission = { submission: string; deliverAs: "steer" | "followUp"; state: "queued" | "delivered" | "returned" | "dropped"; at: number; entryId?: string; text?: string; truncated?: boolean };
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
type TeamMember = { pane: string; session: string; team: string; member: string; role: string };

/** Copy metadata and compact derived values. Transcript bodies never stay here. */
type Copy = {
 path: string; file: string; offset: number; session?: ReaderSession; closedAt?: number;
 revision: number; data?: Derived; updatedAt: number; cost: number; model?: string;
	contextTokens?: number;
	/** Percent of the latest assistant prompt read from cache, as hc-hud and Pi's footer compute it. */
	cacheHit?: number; preview?: string; lastKnownLive?: boolean; generation: number;
	refreshing?: Promise<void>; deriving?: boolean; refreshAgain?: boolean; urgent?: boolean; leases: number;
	/** Copy file mtime at load; orders the cold backlog newest first. */ copiedAt?: number; eviction?: Promise<void>; evictionCancelled?: boolean; readError?: string; sourceMissing?: boolean;
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
function ackResult(ack: Record<string, unknown>): { via: unknown; evidence: unknown; entryId?: string; submission?: string; submissions?: ControlSubmission[] } {
	return defined({
		via: ack.via,
		evidence: ack.evidence,
		entryId: typeof ack.entryId === "string" ? ack.entryId : undefined,
		submission: typeof ack.submission === "string" ? ack.submission : undefined,
		submissions: Array.isArray(ack.submissions) ? (ack.submissions as ControlSubmission[]) : undefined,
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
	#layout: Layout = { workspaces: [] };
	#teams = new Map<string, TeamMember>();
	/** The latest teams frame as the remote agent sent it (status, codes, and whatever Pi Team Bright read it carries). */
	#teamsFrame?: Record<string, unknown>;
	#limits?: ModelLimits;
	#child?: ChildProcess;
	#stopped = true;
	#timer?: ReturnType<typeof setTimeout>;
	#attempts = 0;
	#nextCmd = 1;
	#pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	/** Live subscriptions by sid: the topic, its last value, and how many ops frames were sent. */
	#subs = new Map<number, { topic: Topic; previous: unknown; n: number; at?: number }>();
	/** A Host-wide view recomputes at most this often; changes in between coalesce into one publish. */
	static ANY_VIEW_MS = 500;
	#anyTimer?: ReturnType<typeof setTimeout>;
	#anyDeferred = new Set<string>();
	#saveTimer?: ReturnType<typeof setTimeout>;
	#publishScheduled = false;
	#dirty = new Set<string>();
	/** Queued submissions by ID, until delivered or dismissed; the full text when this hub sent it. */
	#queued = new Map<string, QueuedInput>();
	#panes?: RemotePane[];
	#starting = new Map<string, Starting>();
	/** thread.create in flight by requestId. */
	#creates = new Map<string, Promise<unknown>>();
	#views = new Map<string, PiView>(PI_VIEWS.map((v) => [v.name, v]));
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
		invalidate: (view) => {
			this.#forcedViews.add(view);
			this.#schedulePublish();
		},
	};

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
			await spanAsync("working-set-ready", "startup", () => this.#store.ready);
			await spanAsync("load-index", "startup", () => this.#loadIndex());
			this.#initialized = true;
			instant("host-loaded", { copies: this.#copies.size });
		})();
		void this.#loaded.then(() => {
			if (this.#stopped) return;
			this.#sweep = setInterval(() => void this.#evictExpired(), 60_000);
			this.#sweep.unref();
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
				void this.#request(frame.id, frame.op, (frame.args ?? {}) as Record<string, unknown>);
				return true;
		}
		return false;
	}

	#emitFrame(frame: NodeFrame | { t: "pong" }): void {
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
		clearTimeout(this.#saveTimer);
		this.#saveTimer = setTimeout(() => { void this.#writeIndex().catch((error) => this.#set({ error: (error as Error).message })); }, 300);
	}

	#writeIndex(): Promise<void> {
		clearTimeout(this.#saveTimer);
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
   this.#dirty.add(copy.path); await this.#writeIndex(); this.#markAll();
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
					this.#fromAgent(JSON.parse(line));
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
		this.#saveIndex();
		this.#markAll();
		if (!this.#stopped) this.#timer = setTimeout(() => this.#connect(), Math.min(30_000, 500 * 2 ** Math.min(this.#attempts, 6)));
	}

	#command(cmd: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
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

	// biome-ignore lint: agent frames are loosely typed JSON
	#fromAgent(msg: any): void {
		if (this.#stopped) return;
		switch (msg.t) {
			case "hello": {
				instant("agent-hello");
				this.#attempts = 0;
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
				const buf = Buffer.from(msg.data as string);
				appendFileSync(copy.file, buf);
				copy.offset += buf.length;
				this.#saveIndex();
				void this.#refresh(copy, true);
				return;
			}
			case "agents":
				this.#agents = msg.agents ?? [];
				if (msg.layout) this.#layout = msg.layout;
				// Without a pane list (Herdr unavailable) absence proves nothing.
				this.#panes = Array.isArray(msg.panes) ? msg.panes : undefined;
				this.#livenessKnown = Boolean(this.#panes);
				for (const copy of this.#copies.values()) {
					if (this.#livenessKnown || this.#isLive(copy)) copy.lastKnownLive = this.#isLive(copy);
					if (copy.refreshing && this.#isLive(copy)) this.#promote(copy);
					this.#store.live(this.#source(copy), this.#isLive(copy));
				}
				this.#saveIndex();
				this.#reconcileStarting();
				this.#reconcileQueued();
				this.#markAll();
				void this.#evictExpired();
				return;
			case "teams":
				this.#teams = new Map((msg.members ?? []).map((m: TeamMember) => [m.pane, m]));
				this.#teamsFrame = msg;
				this.#markAll();
				return;
			case "limits":
				this.#limits = { windows: msg.windows ?? {}, budget: msg.budget ?? null };
				this.#markAll();
				return;
			case "ack": {
				const pending = this.#pending.get(msg.id);
				if (!pending) return;
				this.#pending.delete(msg.id);
				clearTimeout(pending.timer);
				if (msg.ok) pending.resolve(msg);
				else {
					const error = typeof msg.error === "object" && msg.error ? msg.error : { code: "refused", message: String(msg.error ?? "The Host refused the action") };
					pending.reject(Object.assign(new Error(String(error.message)), { code: String(error.code ?? "refused"), ...(typeof msg.pane === "string" ? { pane: msg.pane } : {}) }));
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
		this.#schedulePublish();
	}

	// ---- projections ----

	#agentFor(path: string): RemoteAgent | undefined {
		return this.#agents.find((a) => a.session === path);
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
   revision: copy.revision, bytes: copy.offset, sourceVersion: data.version, data, readError: copy.readError,
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
		const agent = this.#agentFor(copy.path);
		// Closed Sessions remain recent for one retention window. Unknown/source-loss copies stay visible.
		const recent = !copy.updatedAt || Date.now() - Math.max(copy.updatedAt, copy.closedAt ?? 0) < this.#recentMs();
		if (this.#livenessKnown && !copy.readError && !copy.data?.invalidLines && !agent && !recent && !this.#isOpen(copy) && !copy.lastKnownLive && !copy.sourceMissing) return undefined;
		const member = agent?.pane ? this.#teams.get(agent.pane) : undefined;
		const team = member && member.session === copy.path ? member : undefined;
		const control = agent?.control?.live ? agent.control : undefined;
		const busy = control ? !control.idle : agent?.status === "working" || agent?.status === "blocked";
		// A blocked pane waits on its owner (a question or a permission): that is attention, not activity.
		const blocked = agent?.status === "blocked";
		// An open tool call at the tail while the Session runs means it is running tools, whatever the pane shows.
		const activity: ThreadSummary["activity"] = control?.compacting ? "compacting" : blocked ? "idle" : busy ? (copy.data?.openCalls ? "tools" : "streaming") : "idle";
		const title = session.title || agent?.title || agent?.name || basename(session.cwd ?? "") || session.session.slice(0, 8);
		const workspace = this.#layout.workspaces.find((w) => w.id === agent?.workspace);
		const tab = workspace?.tabs.find((t) => t.id === agent?.tab);
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
			queued: (control?.pending?.steer ?? 0) + (control?.pending?.followUp ?? 0),
			...(blocked ? { attention: [{ source: "Herdr", reason: "needs input" }] } : {}),
			costUsd: copy.cost,
			...(copy.readError ? { lastError: copy.readError } : {}),
			...(copy.contextTokens ? { contextTokens: copy.contextTokens } : {}),
			...modelLimits(copy.model, this.#limits),
			...(copy.cacheHit !== undefined ? { cacheHit: copy.cacheHit } : {}),
			...(copy.preview ? { preview: copy.preview } : {}),
			ref: session.ref,
			...(agent?.pane ? { location: defined({ workspace: agent.workspace, workspaceLabel: workspace?.label, tab: agent.tab, tabLabel: tab?.label, pane: agent.pane }) } : {}),
			// Live means a pane or a control socket runs it; a recent file alone is not.
			live: Boolean(agent?.pane || agent?.control?.live),
			control: Boolean(control),
		} as ThreadSummary;
	}

	#threadsValue(): unknown {
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

	#threadValue(threadId: string): UiThreadView | undefined {
		const copy = this.#copyByThread(threadId);
		if (!copy) {
			const s = this.#starting.get(threadId);
			const agent = this.#controlAgent(threadId);
			if (!s && !agent) {
				const expired = this.#store.expired(threadId);
				if (!expired) return undefined;
				return { conversationId: threadId, hiddenBefore: false, entries: [], live: {}, inbox: {}, agent: { readError: `Copy outside retained scope: ${expired}. Use K5 tools for older history` }, usage: {} };
			}
			return { conversationId: threadId, hiddenBefore: false, entries: [], live: {} as never, inbox: { items: this.#queuedItems(threadId) } as never, agent: { cwd: s?.cwd ?? agent?.cwd ?? "" } as never, usage: { costUsd: 0 } as never };
		}
		const summary = this.#summary(copy);
		const busy = summary ? summary.activity !== "idle" : false;
		const page = copy.data ? this.#store.tail(this.#source(copy), copy.data, this.#isLive(copy)) : { entries: [], more: false };
		return {
			conversationId: threadId,
			sourceVersion: copy.data?.version,
			hiddenBefore: page.more,
			entries: page.entries,
			live: (busy ? { run: { activity: summary?.activity } } : {}) as never,
			inbox: { items: this.#queuedItems(threadId) } as never,
			agent: { cwd: summary?.cwd ?? "", asOf: copy.data?.asOf ?? null, readError: copy.readError ?? null, ...(copy.model ? { model: copy.model } : {}) } as never,
			usage: { costUsd: copy.cost } as never,
		};
	}

	/** The composer's queue: each undelivered submission with its outcome so far, oldest first. */
	#queuedItems(threadId: string): unknown[] {
		return [...this.#queued.values()]
			.filter((q) => q.threadId === threadId && !q.dismissed)
			.sort((a, b) => a.at - b.at)
			.map((q) => defined({ id: q.submission, mode: q.deliverAs, content: q.text, state: q.state, truncated: q.truncated }));
	}

	#value(topic: Topic): unknown {
  return this.#store.snapshot(() => this.#snapshotValue(topic));
 }

 #snapshotValue(topic: Topic): unknown {
		if (topic.kind === "view") {
			const view = this.#views.get(topic.view);
			if (!view) return undefined;
			// One failing view must not stop the others: its subscribers get an error value, and the next change retries.
			try {
				return view.value(this.#viewContext, topic as PiViewTopic);
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
		let value: unknown;
		try { value = span("snapshot", "ws", () => this.#value(topic), tracing ? { topic: topic.kind, view: topic.kind === "view" ? topic.view : undefined } : undefined); }
		catch (error) { this.#emitFrame({ t: "end", sid, reason: (error as Error).message }); return; }
		if (value === undefined) {
			this.#emitFrame({ t: "end", sid, reason: "Unknown Session on this Host" });
			return;
		}
		this.#subs.set(sid, { topic, previous: value, n: 0 });
		this.#emitFrame({ t: "snap", sid, value: value as never });
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
		setImmediate(() => {
			this.#publishScheduled = false;
			if (this.#stopped || !this.#initialized) return;
			const start = tracing ? nowUs() : 0;
			const dirty = this.#dirty;
			this.#dirty = new Set();
			const dirtyThreads = new Set([...dirty].map((path) => this.#copies.get(path)).filter(Boolean).map((c) => this.#threadId(c!)));
			this.#notifyChanged(dirty);
			const forced = this.#forcedViews;
			this.#forcedViews = new Set();
			for (const [sid, sub] of this.#subs) {
				if (sub.topic.kind === "thread" && !dirtyThreads.has(sub.topic.threadId)) continue;
				if (sub.topic.kind === "view" && !forced.has(sub.topic.view)) {
					// "thread" without a threadId (e.g. every Team) recomputes like "any".
					const scope = sub.topic.threadId ? (this.#views.get(sub.topic.view)?.scope ?? "thread") : "any";
					if (scope === "any" ? dirty.size === 0 : !dirtyThreads.has(sub.topic.threadId as string)) continue;
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
				const value = this.#value(sub.topic);
				if (value === undefined) continue;
				const ops = diffRevisions(sub.previous as never, value as never);
				sub.previous = value;
				if (ops.length > 0) this.#emitFrame({ t: "ops", sid, n: ++sub.n, ops });
			}
			if (tracing) complete("publish", "ws", start, { dirty: dirty.size, subs: this.#subs.size });
		});
	}

	// ---- operations ----

	async #request(id: number, op: string, args: Record<string, unknown>): Promise<void> {
		try {
			const value = await spanAsync("op", "ws", () => this.#op(op, args), tracing ? { op: op.slice(0, 40) } : undefined);
			if (this.#stopped) return;
			this.#emitFrame({ t: "res", id, ok: true, value: value as never });
		} catch (error) {
			if (this.#stopped) return;
			const { code = "error", pane } = error as { code?: string; pane?: string };
			this.#emitFrame({ t: "res", id, ok: false, error: { code, message: (error as Error).message, ...(pane ? { pane } : {}) } });
		}
	}

	async #op(op: string, args: Record<string, unknown>): Promise<unknown> {
		await this.#loaded;
		if (typeof args.threadId === "string") await this.#waitForEviction(args.threadId);
		if (this.#stopped || !this.#initialized) throw new Error("Host stopped");
		const viewOp = /^view\.(.+)\.([^.]+)$/.exec(op);
		if (viewOp) {
			const run = (this.#views.get(viewOp[1]!) ?? this.#views.get(viewOp[1]!.replaceAll("-", ".")))?.ops?.[viewOp[2]!];
			if (!run) throw Object.assign(new Error(`${op} is not available`), { code: "unsupported" });
			return run(this.#viewContext, args);
		}
		switch (op) {
			case "thread.submit": {
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
			}
			case "thread.abort": {
				const { path, agent } = this.#target(String(args.threadId));
				const ack = await this.#command({ t: "abort", session: path, pane: agent.pane }, 20_000);
				const result = ackResult(ack);
				if (result.submissions) {
					this.#noteSubmissions(String(args.threadId), result.submissions);
					this.#markAll();
				}
				return result;
			}
			case "thread.withdraw": {
				// Pi takes back queued input only all at once (abort or dequeue); here the owner clears a settled outcome.
				const q = this.#queued.get(String(args.submissionId));
				if (!q || q.threadId !== String(args.threadId)) return { withdrawn: false };
				if (q.state === "queued")
					throw Object.assign(new Error("Pi cannot take back one queued message. Stop returns all of them to Pi's input box."), { code: "unsupported" });
				q.dismissed = true;
				this.#markAll();
				return { withdrawn: true };
			}
			case "thread.create": {
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
			}
			case "thread.resume": {
				const requestId = String(args.requestId ?? "").toLowerCase();
				const running = this.#creates.get(requestId);
				if (running) return running;
				const resumed = this.#resume({ ...args, requestId });
				if (UUID.test(requestId)) {
					this.#creates.set(requestId, resumed);
					void resumed.catch(() => {}).finally(() => this.#creates.delete(requestId));
				}
				return resumed;
			}
			case "thread.close": {
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
				const ack = await this.#command({ t: "close", session: path, pane: agent.pane, lastPane: args.lastPane === true }, 45_000);
				if (copy) {
					copy.closedAt = Date.now();
					this.#saveIndex();
					this.#dirty.add(copy.path);
					this.#schedulePublish();
				} else this.#markAll();
				return ackResult(ack);
			}
			case "sessions.search": {
    return this.#store.snapshot(() => {
     let notIndexed = 0, stale = 0;
     for (const copy of this.#copies.values()) { this.#adoptHead(copy); if (!copy.data) notIndexed++; else if (copy.readError || copy.offset !== copy.data.bytes) stale++; }
     const value = this.#store.search(String(args.query ?? ""));
     return { ...value, coverage: { ...value.coverage!, notIndexed, stale }, hostStatus: this.state.status };
    });
   }
			case "thread.find": {
				const copy = this.#copyByThread(String(args.threadId));
				if (!copy?.data) throw new Error("Session is not indexed yet");
				const release = this.#viewContext.lease(copy.session!.id);
				try { return await this.#store.find(this.#source(copy), String(args.query ?? ""), copy.data.version); }
				finally { release(); }
			}
			case "thread.history": {
				const copy = this.#copyByThread(String(args.threadId));
				if (!copy && this.#controlAgent(String(args.threadId))) return { entries: [], more: false };
				if (!copy) throw Object.assign(new Error("Unknown Session on this Host"), { code: "not_found" });
				return this.#store.page(copy.path, { limit: Number(args.limit ?? 200), before: typeof args.before === "string" ? args.before : undefined,
     around: typeof args.around === "string" ? args.around : undefined, version: typeof args.version === "string" ? args.version : undefined });
   }
   case "thread.entry": {
    const copy = this.#copyByThread(String(args.threadId));
    if (!copy) throw new Error("Session unavailable");
    return this.#store.entry(this.#source(copy), String(args.entry), Number(args.offset ?? 0), typeof args.version === "string" ? args.version : undefined);
   }
			case "prompts.list":
				return { prompts: [], skills: [] };
			case "models.list":
				return [];
			default:
				throw Object.assign(new Error(`${op} is not available for Pi Sessions yet`), { code: "unsupported" });
		}
	}

	/**
	 * Asks Herdr for a new Pi agent whose Session id is the requestId, so the thread id is known before Herdr runs
	 * anything. Answers at the spawn ack: until Pi writes the Session file, a placeholder makes the thread navigable.
	 */
	async #create(args: Record<string, unknown>): Promise<unknown> {
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
		if (!bound && !this.#starting.has(threadId)) {
			this.#starting.set(threadId, { threadId, sessionId: requestId, name: String(ack.name ?? name), cwd, pane, createdAt: Date.now(), seen: false });
			this.#saveIndex();
			this.#reconcileStarting();
			this.#markAll();
		}
		return defined({
			threadId,
			pane,
			evidence: ack.evidence as string | undefined,
			submitted: ack.submitted as unknown,
			warning: ack.warning as string | undefined,
			...(bound ? {} : { pending: true }),
		});
	}

	/** Resumes a Session that no pane runs: Herdr starts `pi --session <its file>` in a new pane. */
	async #resume(args: Record<string, unknown>): Promise<unknown> {
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
		return defined({ threadId, pane: String(ack.pane), evidence: ack.evidence as string | undefined, warning: ack.warning as string | undefined });
	}

	#placement(value: unknown, cwd: string): Record<string, unknown> {
		const place = (value ?? {}) as { beside?: unknown; direction?: unknown; workspace?: unknown; label?: unknown };
		if (typeof place.beside === "string") {
			const { agent } = this.#target(place.beside);
			if (!agent.pane) throw Object.assign(new Error("That Session is not in a pane"), { code: "not_in_pane" });
			return { beside: agent.pane, direction: place.direction === "down" ? "down" : "right" };
		}
		if (place.workspace === "new") return { label: typeof place.label === "string" && place.label ? place.label : basename(cwd) || cwd };
		throw Object.assign(new Error('place must be { beside, direction } or { workspace: "new" }'), { code: "invalid" });
	}

	/** One spawn on the Host. Herdr may take up to 30 s to start Pi, after the split and rename; never retried here. */
	async #spawn(cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
		try {
			return await this.#command(cmd, 60_000);
		} catch (error) {
			const { code, pane } = error as { code?: string; pane?: string };
			if (!pane) throw error;
			throw Object.assign(new Error(`Herdr made pane ${pane} but did not start Pi in it (${(error as Error).message}); the pane is left open in Herdr`), { code, pane });
		}
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
