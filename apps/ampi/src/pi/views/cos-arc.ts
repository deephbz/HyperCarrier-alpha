import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHUNKER_VERSION, EXCERPT_VERSION, type Chunk } from "./cos-arc-chunks.ts";
import { LABEL_FORMAT, STEP2_FORMAT, type Label, type Project, type Transition } from "./cos-arc-format.ts";
import { LABEL_SYSTEM, STEP2_SYSTEM, labelPrompt, step2Prompt, step2System } from "./cos-arc-prompts.ts";
import { timeline, type TimelineSession } from "./cos-timeline.ts";
import { NEEDS_YOU_KINDS, emptyTree, type ArcContext, type ContextSupport, type NeedsYouKind, type TreeCount } from "./cos-arc-context.ts";
import { askCandidates } from "./cos-arc-asks.ts";
import { WARM_CACHE_GAP_MS, arcFloor } from "./cos-arc-rules.ts";
import { InvalidReply, errorCode, failure, reply, retryNote, type ArcErrorCode, type ArcPurpose, type Call } from "./cos-arc-reply.ts";
import { LABEL_BATCH, labelChunks, type StoredLabel } from "./cos-arc-step1.ts";
import { EMPTY_ANSWER, NothingYet, writeArc } from "./cos-arc-step2.ts";
export { json, type ArcErrorCode } from "./cos-arc-reply.ts";
export { EMPTY_ANSWER };
import { trackBuild, trackRoleWait } from "../derive-queue.ts";
import { ModelNotFound, arcEvidence, type ArcEvidence } from "../../hub/helper-models.ts";
import type { RarebitItem } from "./rarebit.ts";
import type { AskUsage } from "../ask.ts";
import { sourceStatus, type SourceStatus, type PiView, type PiViewContext, type PiViewSession } from "./types.ts";

/** `relabel`: a receipt of other chunk rules labelled this chunk id; that label is hidden until a Build relabels it. */
export type ArcChunk = Chunk & { labelCurrent: boolean; label: Label | null; relabel?: boolean };
type Card = { name: string; chunks: number; resumeEntryId: string; inferred: { summary: string; status: string; full?: { summary?: string } } | null };
/** The call a failure names: a step purpose, or "context", the separate tier-2 call of records before receipt v5. */
export type RecordedPurpose = ArcPurpose | "context";
/** A failed Build: `purpose` and `model` name the call whose reply stayed invalid after its retry; `at` is when it failed. */
/**
 * `preflight`: the Build failed its model check before any call. `hint`, for a model name that names no model, says
 * where to change the name and what to try; it replaces the generic next action.
 */
export type ArcFailure = { message: string; code: ArcErrorCode; purpose?: RecordedPurpose; model?: string | null; preflight?: true; hint?: string; available?: string[]; at: string };
/** `chunks` in the start snapshot and `toLabel`, those without a reusable label, show the incremental cost. */
/**
 * `empty`: a done Build below the floor (arcFloor) whose tree was empty; it wrote no receipt or head. `step` names the
 * running step: `labels` (step 1, `labelled` of `toLabel` chunks settled) or `arc` (step 2); absent while waiting.
 * `done` and `total` count model calls.
 */
type Job = { state: string; done: number; total: number; chunks: number; toLabel: number; labelled?: number; step?: "labels" | "arc"; waitingFor: string | null; lastError: ArcFailure | null; trigger: ArcTrigger; empty?: true };
/** Who started a Build: the owner (the Build op) or an agent stop (`autoBuild`, D16). */
export type ArcTrigger = "manual" | "auto";
/** One finished Build as the hub ran it, kept per Session (newest last) so automatic model spend stays visible. */
export type ArcBuildRun = { trigger: ArcTrigger; startedAt: string; endedAt: string; state: "done" | "error"; calls: number; model: string | null;
	/** Summed over the calls that reported usage; `cost` is null when no call reported a price. */
	usage: AskUsage;
	/** The agent stop the Build followed: the Session's newest stop mark when it started. */
	afterEntryId: string | null;
	/** A done Build below the floor (arcFloor) whose answer was empty: nothing to summarize yet, no receipt or head. */
	empty?: true;
	/** `labels` when hub.json arcEvidence sent step 2 only owner turns per chunk; absent for the full evidence. */
	arcEvidence?: "labels";
	/** `long` when step 2 asked for the 1 h prompt cache (synthesisCache); absent for Pi's 5-min default. */
	cache?: "long";
	/** Why an automatic Build rebuilt the stored Arc on view ("rebuilt: the stored Arc was empty"); absent otherwise. */
	cause?: string;
	/**
	 * The Rarebit count when the Build was requested, before any wait for loading, so it never covers a message the Build
	 * did not see. An answer failure's count gates the next automatic Build. Absent in older records.
	 */
	asOf?: number; error?: string; errorCode?: ArcErrorCode;
	/** The call and model whose reply stayed invalid (ArcFailure), so the failure reads the same after a hub restart. */
	errorPurpose?: RecordedPurpose; errorModel?: string | null;
	/** The last tier-2 answer of the Build: its counts as the model wrote them, and as kept after the citation filter. */
	tree?: { raw: TreeCount; kept: TreeCount };
	/** Chunk labels taken from the previous receipt by chunk hash; absent in older records. */
	reusedLabels?: number;
	/** Label calls repeated once for the chunks a first answer missed or failed; absent in older records. */
	retries?: number;
	/**
	 * Chunks still without a label after the retry. Since receipt v5 such a Build fails before step 2; in older
	 * records it ended done with a gap.
	 */
	unlabelledChunks?: number;
	/** The code of the first label failure behind `unlabelledChunks`. */
	labelErrorCode?: ArcErrorCode;
	/** Chunks the Build asked labels for: those the last complete receipt lacked. */
	freshChunks?: number;
	/** The chunks of a partial label failure, by id and hash, for the stuck rule (stuckOn). */
	failedChunks?: { id: string; hash: string }[];
	/** LABEL_VERSION of the Build; an answer-stuck Session unlocks when it changes. */
	labelVersion?: string;
	/** Wall time per step in ms; absent in older records and for a step that did not run. */
	ms?: { labels?: number; arc?: number };
	/** The exact provider/id each call purpose used, as checked before the first call; absent in older records and
	 * when the check failed. */
	models?: BuildModels;
	/** The model name the check found no model for; the Build made no call. */
	missingModel?: string;
	/** Calls, summed price and prompt tokens per call purpose; absent in older records, tokens absent before the step-2
	 * cache. Records before receipt v5 add `context`. */
	usageByPurpose?: Record<keyof BuildModels, PurposeUsage> & { context?: PurposeUsage } };
export type PurposeUsage = { calls: number; cost: number | null } & Partial<Pick<AskUsage, "input" | "cacheRead" | "cacheWrite" | "cacheWrite1h">>;
/**
 * One key per Arc step, as in the receipt's `models`: step 1 uses arcLabels, step 2 arcSynthesis. Records before
 * receipt v5 add `context`, which ran on arcLabels.
 */
type BuildModels = { labels: string; synthesis: string; context?: string };
const PURPOSE_KEY: Record<ArcPurpose, "labels" | "synthesis"> = { label: "labels", synthesis: "synthesis" };
export type ArcValue = {
	source: SourceStatus;
	threadId: string; title: string; ref: string; chunks: ArcChunk[]; cards: Card[]; transitions: Transition[];
	synthesis: { headline: string; model: string | null; builtAt: string | null } | null;
	/** When the shown Arc was built: a receipt with a synthesis and a non-empty tree (emptyTree); otherwise null. */
	keptAt: string | null;
	coverage: { labelledChunks: number; synthesisCurrent: boolean; unmappedChunks: number; excludedEntries: number };
	/** Synthesis and the tree reread the whole Session, so input tokens fall little when labels are reused. */
	buildEstimate: { calls: number; inputTokens: number; truncatedChunks: number;
		/** Prompt tokens of the last finished Build, cached or not: the figure `inputTokens` estimates. */
		lastInputTokens: number | null; lastCost: number | null };
	/** Below the floor a stored tree without work threads is not drawn. */
	context: ArcContext | null;
	/** The automatic floor while the Session is below it (arcFloor); null at or above it. */
	floor: { min: number; messages: number } | null;
	/**
	 * `coveredAt`: the time of the newest message the tree covers, when known. `formatChanged`: another step-2 prompt
	 * (STEP2_VERSION) built the tree, so its titles follow older rules until the next Build; currency is unchanged.
	 * `unknown`: a receipt without a tree, so what it covers is unknown.
	 */
	contextStatus: { newMessages: number; branchChanged: boolean; coveredAt?: number | null; formatChanged?: boolean; unknown?: boolean };
	/** Chunks that need labels because the receipt used other chunk rules (CHUNKER_VERSION); null when the rules match. */
	relabelChunks?: number | null;
	/** When the pending automatic Build is due (epoch ms); null when no qualifying stop waits for one. */
	nextAutoAt: number | null;
	/** Automatic Builds that run or wait before this Session's (autoQueue); null when it is not queued. */
	queuedAhead?: number | null;
	/** The consecutive failed Builds that delay the next automatic Build (autoDue), with the last code; null after a success. */
	backoff?: { failures: number; code: ArcErrorCode | null } | null;
	/**
	 * Chunks that failed to label in the last 2 Builds (stuckOn), so automatic Builds wait; `until` names what unlocks
	 * them: new messages, or a label rule change or a successful Build arc. Null when not stuck.
	 */
	stuck?: { chunks: string[]; until: "messages" | "build" } | null;
	/** Why automatic Builds are off for this Session: "worker" for a Pi Team Bright Worker, which builds only on Build arc. */
	autoOff?: "worker" | null;
	job: Job | null; builds: ArcBuildRun[]; notice: string;
};
/**
 * `labelVersion` (LABEL_VERSION) is absent in older receipts; their labels still render but are never reused.
 * `chunkerVersion` (CHUNKER_VERSION) names the chunk rules; absent before ampi-arc-chunker/4. A label shows by chunk id
 * only under the same chunk rules. `excerptVersion` (EXCERPT_VERSION) names the label excerpt rules of that Build.
 */
type Receipt = { version: 3 | 4 | 5; labelVersion?: string; chunkerVersion?: string; excerptVersion?: string;
	/** STEP2_VERSION of the step-2 call (v5); absent in older receipts, whose tree came from a separate context call. */
	step2Version?: string; sourceVersion: string; builtAt: string; labels: Record<string, StoredLabel>; headline: string; projects: Project[]; transitions: Transition[];
	/**
	 * The step-2 model since v5; before, the last answering model. `models` records each step apart (absent before
	 * ingest-partial-build; `context` only before v5).
	 */
	model: string | null; models?: { labels: string | null; synthesis: string | null; context?: string | null }; context?: ArcContext };
/**
 * The persisted receipt head (<=200 bytes): enough for a list or Overview to show tier-2 availability, open asks
 * per kind, and staleness without loading any tree. `open` and `old` (oldest ask time in whole minutes since the
 * epoch, 0 when unknown) follow NEEDS_YOU_KINDS order; `fp` is a fingerprint prefix; `fin: 1`, present only when
 * true, means every thread is done and nothing is open; `ov`, present only when non-zero, counts overtaken asks. Staleness needs only `n` and `fp`; v2 drops v1's `sv`
 * (source version), which no reader used. v3 adds `e: 1`, present only when the tree is empty (emptyTree): such a
 * Session is not built. readHead rewrites an older head from its receipt once.
 */
type Head = { v: 1 | 2 | 3; sv?: string; at: string; n: number; fp: string; open: number[]; old?: number[]; fin?: 1; ov?: number; e?: 1 };
/** The head as projected for one Session's current Rarebit selection. */
export type ArcHead = { built: boolean; builtAt: string | null; open: Record<NeedsYouKind, number>; oldest: Record<NeedsYouKind, number | null>; overtaken: number; finished: boolean; newMessages: number; branchChanged: boolean };
export type ArcListValue = { sessions: (Omit<TimelineSession, "entries" | "buckets" | "marks"> & { head: ArcHead })[] };
/** `building`: the Rarebit count the running Build started from. */
type State = { receipt?: Receipt; job?: Job; building?: number };
const states = new WeakMap<PiViewContext, Map<string, State>>();
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const pathFor = (ctx: PiViewContext, id: string) => join(ctx.stateDir("cos.arc"), `${digest(id)}.json`);
const headPathFor = (ctx: PiViewContext, id: string) => join(ctx.stateDir("cos.arc"), `${digest(id)}.head.json`);
const heads = new WeakMap<PiViewContext, Map<string, Head | null>>();
const logPathFor = (ctx: PiViewContext, id: string) => join(ctx.stateDir("cos.arc"), `${digest(id)}.builds.json`);
const logs = new WeakMap<PiViewContext, Map<string, ArcBuildRun[]>>();
const BUILD_LOG = 30;

/** The Session's Build log, oldest first; read once from disk, then kept in memory. */
export function buildLog(ctx: PiViewContext, threadId: string): ArcBuildRun[] {
	let map = logs.get(ctx); if (!map) logs.set(ctx, map = new Map());
	let log = map.get(threadId);
	if (!log) {
		try { const raw = JSON.parse(readFileSync(logPathFor(ctx, threadId), "utf8")); log = Array.isArray(raw) ? raw : []; } catch { log = []; }
		// Records written before cache tracking lack cacheRead and cacheWrite; they read as 0.
		log = log.map((b) => ({ ...b, usage: { ...b.usage, cacheRead: b.usage.cacheRead ?? 0, cacheWrite: b.usage.cacheWrite ?? 0 } }));
		map.set(threadId, log);
	}
	return log;
}

function appendBuild(ctx: PiViewContext, threadId: string, build: ArcBuildRun) {
	const log = [...buildLog(ctx, threadId), build].slice(-BUILD_LOG);
	const file = logPathFor(ctx, threadId);
	writeFileSync(`${file}.tmp`, JSON.stringify(log), { mode: 0o600 }); renameSync(`${file}.tmp`, file);
	logs.get(ctx)!.set(threadId, log);
}

export function headOf(receipt: Receipt & { context: ArcContext }): Head {
	const c = receipt.context;
	const asks = NEEDS_YOU_KINDS.map((k) => c.needsYou.filter((l) => l.kind === k));
	const fin = c.threads.length > 0 && !c.needsYou.length && c.threads.every((t) => t.state === "done");
	return { v: 3, at: c.builtAt, n: c.asOfRarebitCount, fp: c.rarebitFingerprint.slice(0, 16), open: asks.map((a) => a.length),
		// normalizeContext sorts each kind oldest ask first.
		old: asks.map((a) => Math.floor((a[0]?.citations[0]?.at ?? 0) / 60_000)), ...(fin ? { fin: 1 } : {}), ...(c.overtaken?.length ? { ov: c.overtaken.length } : {}), ...(emptyTree(c) ? { e: 1 } : {}) } as Head;
}

function readHead(ctx: PiViewContext, threadId: string): Head | null {
	let map = heads.get(ctx); if (!map) heads.set(ctx, map = new Map());
	if (!map.has(threadId)) {
		let head: Head | null = null;
		try { const raw = JSON.parse(readFileSync(headPathFor(ctx, threadId), "utf8")); if (raw?.v === 1 || raw?.v === 2 || raw?.v === 3) head = raw; } catch {}
		map.set(threadId, head);
		// An older head cannot say whether its tree is empty; its receipt can.
		if (head && head.v !== 3) try {
			const receipt = JSON.parse(readFileSync(pathFor(ctx, threadId), "utf8")) as Receipt;
			if (receipt?.context) writeHead(ctx, threadId, headOf(receipt as Receipt & { context: ArcContext }));
		} catch {}
	}
	return map.get(threadId)!;
}

function writeHead(ctx: PiViewContext, threadId: string, head: Head) {
	const file = headPathFor(ctx, threadId);
	writeFileSync(`${file}.tmp`, JSON.stringify(head), { mode: 0o600 }); renameSync(`${file}.tmp`, file);
	let map = heads.get(ctx); if (!map) heads.set(ctx, map = new Map());
	map.set(threadId, head);
}

/** Staleness is deterministic: Rarebit messages added since the build, or a changed selection at the same count. */
function staleness(s: PiViewSession, asOf: number, fp: string) {
	const newMessages = Math.max(0, s.data.rarebit.count - asOf);
	return { newMessages, branchChanged: newMessages === 0 && !s.data.rarebit.fingerprint.startsWith(fp) };
}

export function arcHead(s: PiViewSession, head: Head | null): ArcHead {
	const open = Object.fromEntries(NEEDS_YOU_KINDS.map((k, i) => [k, head?.open[i] ?? 0])) as Record<NeedsYouKind, number>;
	const oldest = Object.fromEntries(NEEDS_YOU_KINDS.map((k, i) => [k, head?.old?.[i] ? head.old[i]! * 60_000 : null])) as Record<NeedsYouKind, number | null>;
	if (!head || head.e) return { built: false, builtAt: null, open, oldest, overtaken: 0, finished: false, newMessages: 0, branchChanged: false };
	return { built: true, builtAt: head.at, open, oldest, overtaken: head.ov ?? 0, finished: head.fin === 1, ...staleness(s, head.n, head.fp) };
}

function state(ctx: PiViewContext, s: PiViewSession) {
	let map = states.get(ctx); if (!map) states.set(ctx, map = new Map());
	let st = map.get(s.threadId);
	if (!st) {
		const file = pathFor(ctx, s.threadId);
		let receipt: Receipt | undefined;
		try { receipt = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined; } catch {}
		st = { ...(receipt?.version === 3 || receipt?.version === 4 || receipt?.version === 5 ? { receipt } : {}) };
		if (st.receipt?.context && readHead(ctx, s.threadId)?.v !== 3) writeHead(ctx, s.threadId, headOf(st.receipt as Receipt & { context: ArcContext }));
		map.set(s.threadId, st);
	}
	map.delete(s.threadId); map.set(s.threadId, st);
	for (const [id, old] of map) if (map.size > 20 && old.job?.state !== "running") map.delete(id);
	return st;
}

/**
 * Every Rarebit item of the active branch at full length, oldest first, for ask candidates and quote checks. Every
 * page must come from the Session version `s` describes.
 */
function allRarebits(s: PiViewSession): RarebitItem[] {
	const pages: RarebitItem[][] = [];
	for (let before: string | undefined; ;) {
		const page = s.rarebits(before, true);
		if (page.sourceVersion !== s.sourceVersion) throw failure("source", `A Rarebit page has version ${page.sourceVersion}; the snapshot has ${s.sourceVersion}.`);
		pages.unshift(page.items);
		if (!page.more || !page.items.length) return pages.flat();
		before = page.items[0]!.id;
	}
}

/** Names what a label means: the label instructions, the label prompt shape, the chunking rules and the label format. */
export const LABEL_VERSION = createHash("sha256").update(LABEL_SYSTEM).update(labelPrompt([], new Map())).update(CHUNKER_VERSION).update(LABEL_FORMAT).digest("hex").slice(0, 16);
/** Names what step 2 writes: its instructions, its data shape and its format. An Arc of another version rebuilds once. */
export const STEP2_VERSION = createHash("sha256").update(step2System([], {}, new Map(), { candidates: [], owners: new Map() })).update(step2Prompt([], {}, new Map(), { candidates: [], owners: new Map() }, "")).update(STEP2_FORMAT).digest("hex").slice(0, 16);

/**
 * The previous receipt's reusable labels by chunk hash. The hash covers a chunk's entry IDs and excerpt, so a label
 * follows its content when a compaction or branch change renumbers chunk IDs. A receipt with another label version
 * reuses nothing.
 */
function labelsByHash(receipt: Receipt | undefined) {
	return new Map(receipt?.labelVersion === LABEL_VERSION ? Object.values(receipt.labels).map((l) => [l.hash, l]) : []);
}


/** Entry IDs a context leaf may cite: Rarebit message lines of this build's evidence. */
const citable = (evidence: Map<string, string>) => [...evidence.values()].flatMap((text) => [...text.matchAll(/^\[([^\]]+)\] (?:USER|AGENT):/gm)].map((m) => m[1]!));


/** The one currency rule (Rarebit messages): the tree and the synthesis are current when no message is newer and the branch is the same. */
function contextStatus(s: PiViewSession, context: ArcContext | undefined, built = false) {
	if (!context) return { newMessages: 0, branchChanged: false, coveredAt: null, formatChanged: false, unknown: built };
	const coveredAt = context.asOfEntryId ? s.entryTimes([context.asOfEntryId]).get(context.asOfEntryId) ?? null : null;
	return { ...staleness(s, context.asOfRarebitCount, context.rarebitFingerprint), coveredAt, formatChanged: context.format !== STEP2_VERSION };
}

/**
 * Model calls one Build keeps in flight. The hub's ask runner refuses a fourth call with `busy` (src/pi/ask.ts), so a
 * higher bound would only add retries.
 */
export const ARC_ASK_CONCURRENCY = 3;

/**
 * Runs `fn` over `items` with at most `limit` calls in flight; results keep item order whatever the completion order.
 * The first failure stops new starts; the call settles only after in-flight calls finish, so a cancelled Build leaves
 * no model call running, and it rejects with that first failure.
 */
export async function bounded<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0, failure: { error: unknown } | undefined;
	const worker = async () => {
		while (!failure && next < items.length) {
			const i = next++;
			try { out[i] = await fn(items[i]!, i); } catch (error) { failure ??= { error }; }
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
	if (failure) throw failure.error;
	return out;
}

/**
 * How long one model call of a Build waits out `busy` (ARC_BUSY_WAIT): a manual Build about 15 s, an automatic one
 * 120 s. An automatic Build so holds its queue turn for at most calls x (ask timeout 120 s + 120 s) = calls x 240 s,
 * about 24 min for 5 label calls and 1 synthesis call. Tests shorten it.
 */
export const ARC_BUSY_WAIT = { manualMs: 15_000, autoMs: 120_000 };
/** ctx.ask, waiting out `busy` for up to `patienceMs` when another feature holds the hub's shared model slots. */
async function askWhenFree(ctx: PiViewContext, req: Parameters<PiViewContext["ask"]>[0], patienceMs: number) {
	const deadline = Date.now() + patienceMs;
	for (let wait = 250; ; wait = Math.min(wait * 2, 8000)) {
		try { return await ctx.ask(req); }
		catch (e) { if ((e as { code?: string }).code !== "busy" || Date.now() + wait > deadline) throw e; await new Promise((r) => setTimeout(r, wait)); }
	}
}

/**
 * Everything one Build reads from its Session, taken at its start in one store read (ctx.snapshot). The Build never
 * reads the live Session after it.
 */
type Snapshot = { sourceVersion: string; chunks: Chunk[]; evidence: Map<string, string>; support: ContextSupport; times: Map<string, number | null>;
	rarebitCount: number; fingerprint: string; ref: string; cwd: string; afterEntryId: string | null };
function snapshot(s: PiViewSession): Snapshot {
	const { chunks } = s.data.arc, items = allRarebits(s);
	let evidence: Map<string, string>;
	try { evidence = s.arcEvidence(chunks.map((c) => c.id)); }
	catch (e) { throw failure("source", `Chunk evidence moved past snapshot version ${s.sourceVersion}: ${(e as Error).message}`); }
	return { sourceVersion: s.sourceVersion, chunks, evidence, support: { texts: new Map(items.map((i) => [i.id, i.text])), ...askCandidates(items) },
		times: s.entryTimes(citable(evidence)), rarebitCount: s.data.rarebit.count, fingerprint: s.data.rarebit.fingerprint, ref: s.ref,
		cwd: s.summary?.cwd ?? "", afterEntryId: s.data.timeline.marks.findLast((m) => m[2] === "stop")?.[1] ?? null };
}

/**
 * Starts one Build for a Session: step 1 labels chunks (cos-arc-step1.ts), then step 2 writes tier 1 and the tier-2
 * tree in one call (cos-arc-step2.ts). A chunk still unlabelled after its retry fails the Build before step 2, so a
 * stored Arc always reads every chunk. Trigger-agnostic:
 * the explicit Build op calls it today; an automatic trigger may call it unchanged. A running Build is reused.
 * The Build works on a snapshot taken at its start and always commits a receipt for that snapshot. Messages that
 * arrive meanwhile make the head stale, and the next Build covers them. Labels whose chunk hash is unchanged since
 * the previous receipt are reused, so a Build labels only new or changed chunks.
 */
export function buildArc(ctx: PiViewContext, s: PiViewSession, args: { model?: unknown } = {}, { limit: given, trigger = "manual", cause }: { limit?: number; trigger?: ArcTrigger; cause?: string } = {}): { started: true } {
	const st = state(ctx, s);
	if (st.job?.state === "running") return { started: true };
	// An automatic Build keeps one slot free; a manual Build takes what the running automatic Build leaves.
	const limit = given ?? (trigger === "auto" ? AUTO_ASK_LIMIT : Math.max(1, ARC_ASK_CONCURRENCY - (autoQueue.current ? AUTO_ASK_LIMIT : 0)));
	if (!s.data.arc.chunks.length) throw new Error("There are no chunks to label yet.");
	const job: Job = { state: "running", done: 0, total: 0, chunks: s.data.arc.chunks.length, toLabel: 0, waitingFor: null, lastError: null, trigger };
	const release = ctx.lease(s.threadId);
	st.job = job; st.building = s.data.rarebit.count; ctx.invalidate("cos.arc");
	const startedAt = new Date().toISOString();
	const cache = synthesisCache(trigger, Boolean(s.summary?.live), cause, buildLog(ctx, s.threadId).at(-1), arcClock.now());
	// autoBuild records its own start time.
	if (trigger === "manual") started(ctx, s.threadId, arcClock.now());
	let retries = 0, unlabelled = 0, reused = 0, fresh = 0, afterEntryId: string | null = null, labelErrorCode: ArcErrorCode | null = null, counted: ArcBuildRun["tree"], failedChunks: { id: string; hash: string }[] = [];
	const ms: NonNullable<ArcBuildRun["ms"]> = {};
	const spent = { calls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null } as AskUsage, model: null as string | null,
		byPurpose: { labels: { calls: 0, cost: null, input: 0, cacheRead: 0, cacheWrite: 0 }, synthesis: { calls: 0, cost: null, input: 0, cacheRead: 0, cacheWrite: 0 } } as NonNullable<ArcBuildRun["usageByPurpose"]> };
	let models: BuildModels | undefined, evidenceMode: ArcEvidence = "full";
	// Every model call of this Build goes through `asked`, so the Build log carries its usage.
	const asked = async (purpose: ArcPurpose, req: Parameters<PiViewContext["ask"]>[0]) => {
		const answer = await askWhenFree(ctx, req, trigger === "auto" ? ARC_BUSY_WAIT.autoMs : ARC_BUSY_WAIT.manualMs);
		const mine = spent.byPurpose[PURPOSE_KEY[purpose]];
		spent.calls++; mine.calls++; spent.model = answer.model ?? spent.model;
		const u = answer.usage, total = spent.usage;
		if (u) {
			total.input += u.input; total.output += u.output; total.cacheRead += u.cacheRead; total.cacheWrite += u.cacheWrite;
			mine.input = (mine.input ?? 0) + u.input; mine.cacheRead = (mine.cacheRead ?? 0) + u.cacheRead; mine.cacheWrite = (mine.cacheWrite ?? 0) + u.cacheWrite;
			if (u.cacheWrite1h) { total.cacheWrite1h = (total.cacheWrite1h ?? 0) + u.cacheWrite1h; mine.cacheWrite1h = (mine.cacheWrite1h ?? 0) + u.cacheWrite1h; }
			if (u.cost !== null) { total.cost = (total.cost ?? 0) + u.cost; mine.cost = (mine.cost ?? 0) + u.cost; }
		}
		return answer;
	};
	// Every Arc call goes through `valid`: an invalid reply is asked once more with the reason, then fails the call.
	const valid: Call = async <R, T = R>(purpose: ArcPurpose, req: Parameters<Call>[1], accept?: (r: R) => T) => {
		// Without `accept` the reply is stored as parsed, so T is R.
		const parsed = (text: string): T => { const r = reply(purpose, text); return accept ? accept(r as R) : r as T; };
		let answer = await asked(purpose, req);
		try { return { answer, reply: parsed(answer.text) }; }
		catch (e) {
			if (!(e instanceof InvalidReply)) throw e;
			retries++; job.total++; ctx.invalidate("cos.arc");
			// The note goes in the message: the system text stays the one the prompt cache holds.
			answer = await asked(purpose, { ...req, prompt: req.prompt + retryNote(e) });
			try { return { answer, reply: parsed(answer.text) }; }
			catch (again) { if (again instanceof InvalidReply) again.model = answer.model ?? null; throw again; }
		}
	};
	// trackBuild counts the job in /api/health until its finally block settles.
	// st.building is the Rarebit count at the request, before any wait for loading; the head comes from the whole snapshot.
	void trackBuild(async () => {
		try {
			// A Session copy that lags its file is partial: a Build on it would label part of the Session and read
			// done. Wait for the hub to read the whole file, within INGEST.waitMs.
			const deadline = Date.now() + INGEST.waitMs;
			for (let cur = ctx.session(s.threadId) ?? s; sourceStatus(cur).state === "stale"; cur = ctx.session(s.threadId) ?? s) {
				const loaded = loadedText(cur.data.bytes, cur.sourceBytes ?? cur.bytes);
				if (Date.now() >= deadline) throw failure("source", `Loaded ${loaded} of the Session in ${duration(INGEST.waitMs)}`);
				const waiting = `Waiting for this Session to finish loading: loaded ${loaded}. Build starts when loading finishes; it stops after ${duration(INGEST.waitMs)}.`;
				if (job.waitingFor !== waiting) { job.waitingFor = waiting; ctx.invalidate("cos.arc"); }
				await new Promise((r) => setTimeout(r, INGEST.pollMs));
			}
			if (job.waitingFor) { job.waitingFor = null; ctx.invalidate("cos.arc"); }
			// The snapshot is one store read before the first await. The Session is read inside it, so its head and
			// every page come from one store version; a read that still mixes versions gets one fresh read.
			const read = () => ctx.snapshot(() => snapshot(ctx.session(s.threadId) ?? s));
			let snap: Snapshot;
			try { snap = read(); }
			catch {
				try { snap = read(); }
				catch (e) { throw errorCode(e) === "source" ? e : failure("source", (e as Error).message); }
			}
			const { chunks, evidence, sourceVersion } = snap;
			afterEntryId = snap.afterEntryId;
			// Both models resolve before the first call, so a missing model fails the Build at no cost. An owner override
			// replaces both.
			const override = typeof args.model === "string" && args.model ? args.model : undefined;
			try { evidenceMode = arcEvidence(); }
			catch (e) { throw Object.assign(failure("model", (e as Error).message), { preflight: true }); }
			job.waitingFor = "Checking Pi’s models…"; ctx.invalidate("cos.arc");
			// Both resolve together. The labels failure is reported first, as labels run first; its message also names a
			// failed synthesis model, so one Build shows every key to fix.
			const resolved = await Promise.allSettled([ctx.model("arcLabels", override), ctx.model("arcSynthesis", override)]);
			const failed = resolved.flatMap((r) => (r.status === "rejected" ? [r.reason as Error] : []));
			if (failed[0]) throw Object.assign(failed[1] ? ModelNotFound.merge(failed[0], failed[1]) : failed[0], { preflight: true });
			const [labelModel, synthModel] = resolved.map((r) => (r as PromiseFulfilledResult<string>).value) as [string, string];
			job.waitingFor = null;
			models = { labels: labelModel, synthesis: synthModel };
			const labelReq = { purpose: "arcLabels" as const, model: labelModel, resolved: true as const }, synthReq = { purpose: "arcSynthesis" as const, model: synthModel, resolved: true as const, ...(cache ? { cache } : {}) };
			const prior = labelsByHash(st.receipt), labels: Receipt["labels"] = {}, toLabel: Chunk[] = [];
			for (const c of chunks) { const l = prior.get(c.hash); if (l) labels[c.id] = l; else toLabel.push(c); }
			reused = chunks.length - toLabel.length; fresh = toLabel.length;
			Object.assign(job, { chunks: chunks.length, toLabel: fresh, labelled: 0, step: "labels", total: Math.ceil(fresh / LABEL_BATCH) + 1 }); ctx.invalidate("cos.arc");
			// Step 1. Label batches run concurrently; labels keep chunk order, so the receipt matches a sequential Build.
			let t = Date.now();
			const step1 = await labelChunks(toLabel, evidence, { call: valid, req: labelReq, limit, bounded,
				retried: () => { retries++; job.total++; ctx.invalidate("cos.arc"); },
				settled: (n) => { job.labelled! += n; job.done = spent.calls; ctx.invalidate("cos.arc"); } });
			ms.labels = Date.now() - t;
			Object.assign(labels, step1.labels);
			unlabelled = step1.missed.length;
			if (unlabelled) {
				// A partial Arc would read done with chunks it never read; the last complete Arc stays instead.
				labelErrorCode = step1.error ? errorCode(step1.error) : "answer";
				const reason = step1.error?.message ?? "The model returned no labels.";
				if (unlabelled === fresh) throw step1.error ?? failure("answer", reason);
				failedChunks = step1.missed.map((c) => ({ id: c.id, hash: c.hash }));
				throw Object.assign(failure(labelErrorCode, `${unlabelled} of ${chunks.length} chunks failed to label: ${reason}`), { purpose: "label" as const, model: step1.model ?? labelModel });
			}
			// Step 2.
			job.step = "arc"; job.done = spent.calls; ctx.invalidate("cos.arc");
			t = Date.now();
			const arc = await writeArc({ chunks, labels, evidence, support: snap.support, cwd: snap.cwd, ref: snap.ref, times: snap.times, rarebitCount: snap.rarebitCount,
				fingerprint: snap.fingerprint, asOfEntryId: citable(evidence).at(-1) ?? null, belowFloor: Boolean(arcFloor(snap.rarebitCount)), evidenceMode },
				{ call: valid, req: synthReq, counted: (c) => { counted = c; } });
			ms.arc = Date.now() - t; job.done = spent.calls;
			const builtAt = new Date().toISOString();
			const receipt: Receipt = { version: 5, labelVersion: LABEL_VERSION, step2Version: STEP2_VERSION, chunkerVersion: CHUNKER_VERSION, excerptVersion: EXCERPT_VERSION, sourceVersion, builtAt, labels,
				...arc.tier1, model: arc.model, models: { labels: step1.model, synthesis: arc.model },
				context: { ...arc.context, builtAt, model: arc.model, format: STEP2_VERSION } };
			const file = pathFor(ctx, s.threadId); writeFileSync(`${file}.tmp`, JSON.stringify(receipt), { mode: 0o600 }); renameSync(`${file}.tmp`, file);
			writeHead(ctx, s.threadId, headOf(receipt as Receipt & { context: ArcContext }));
			st.receipt = receipt; job.state = "done"; quiet.delete(s.threadId);
		} catch (e) {
			job.waitingFor = null;
			if (e instanceof NothingYet) { job.state = "done"; job.empty = true; }
			else {
				job.state = "error";
				const named = e as { purpose?: ArcPurpose; model?: string | null };
				const failed = e instanceof InvalidReply || named.purpose === "label" ? { purpose: named.purpose, model: named.model ?? null } : e instanceof ModelNotFound ? { purpose: e.purpose === "arcSynthesis" ? "synthesis" as const : "label" as const, model: e.model } : {};
				const said = e instanceof ModelNotFound ? { message: e.summary, hint: e.hint, ...(e.available ? { available: e.available } : {}) } : { message: (e as Error).message };
				job.lastError = { ...said, code: errorCode(e), ...failed, ...((e as { preflight?: true }).preflight ? { preflight: true as const } : {}), at: new Date().toISOString() };
			}
		}
		finally {
			release();
			try {
				appendBuild(ctx, s.threadId, { trigger, startedAt, endedAt: new Date().toISOString(), state: job.state === "done" ? "done" : "error", ...(job.empty ? { empty: true } : {}), calls: spent.calls, model: spent.model,
					usage: spent.usage, afterEntryId, asOf: st.building, ...(cause ? { cause } : {}), ...(job.lastError ? { error: [job.lastError.message, job.lastError.hint].filter(Boolean).join(" "), errorCode: job.lastError.code } : {}),
					...(job.lastError?.preflight && job.lastError.model ? { missingModel: job.lastError.model } : {}),
					...(job.lastError?.purpose ? { errorPurpose: job.lastError.purpose, errorModel: job.lastError.model ?? null } : {}), ...(counted ? { tree: counted } : {}),
					...(retries ? { retries } : {}), ...(unlabelled ? { unlabelledChunks: unlabelled, ...(labelErrorCode ? { labelErrorCode } : {}) } : {}), ...(failedChunks.length ? { failedChunks } : {}), ...(reused ? { reusedLabels: reused } : {}),
					...(models ? { freshChunks: fresh, labelVersion: LABEL_VERSION } : {}), ...(Object.keys(ms).length ? { ms } : {}),
					...(models ? { models } : {}), ...(evidenceMode === "labels" ? { arcEvidence: evidenceMode } : {}), ...(cache ? { cache } : {}), usageByPurpose: spent.byPurpose });
			} catch {}
			ctx.invalidate("cos.arc"); if (trigger === "auto") ctx.invalidate("rarebit");
			if (pendings.get(ctx)?.has(s.threadId)) schedule(ctx, s.threadId);
			if (trigger === "auto") autoDone(ctx, s.threadId);
		}
	});
	return { started: true };
}

/** Minimum time between automatic Builds of one Session (D16). */
export const AUTO_BUILD_INTERVAL_MS = 10 * 60_000;
/**
 * The prompt cache step 2 asks for. An automatic Build of a live Session that starts within WARM_CACHE_GAP_MS of the
 * last Build's end is likely followed by another within the hour, so it asks for the 1 h cache: the write costs 2x
 * input, and each read 0.05x. Every other Build keeps Pi's 5-min default, because no next Build is in sight: a manual
 * Build, an upgrade, a Session that is not live, the first Build, or one after a longer gap. Pi 1.3.0 offers the CLI
 * no way to send no cache mark at all.
 */
export function synthesisCache(trigger: ArcTrigger, live: boolean, cause: string | undefined, last: ArcBuildRun | undefined, now: number): "long" | undefined {
	const ended = Date.parse(last?.endedAt ?? "");
	return trigger === "auto" && live && !cause && now - ended <= WARM_CACHE_GAP_MS ? "long" : undefined;
}

/** Time and the follow-up timer of the automatic trigger; tests replace them. */
/** How long a Build waits for the hub to finish loading its Session, and how often it checks. */
export const INGEST = { waitMs: 120_000, pollMs: 250 };
/** "79% (42 of 52 MB)": both sizes in the unit of the total, all floored so a partial load never reads whole. */
function loadedText(done: number, total: number): string {
	const [unit, div] = total >= 1e6 ? ["MB", 1e6] : total >= 1e3 ? ["KB", 1e3] : ["B", 1];
	return `${total ? Math.floor((done / total) * 100) : 100}% (${Math.floor(done / div)} of ${Math.floor(total / div)} ${unit})`;
}
const duration = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);
export const arcClock = { now: () => Date.now(), later: (run: () => void, ms: number) => { setTimeout(run, ms).unref?.(); } };
const lastStart = new WeakMap<PiViewContext, Map<string, number>>();
function started(ctx: PiViewContext, threadId: string, at: number) {
	let map = lastStart.get(ctx); if (!map) lastStart.set(ctx, map = new Map());
	map.set(threadId, Math.max(map.get(threadId) ?? 0, at));
}
/** When the last Build of either trigger started; after a hub restart the Build log supplies it. */
const lastBuild = (ctx: PiViewContext, threadId: string) =>
	lastStart.get(ctx)?.get(threadId) ?? (Date.parse(buildLog(ctx, threadId).at(-1)?.startedAt ?? "") || 0);

/**
 * A qualifying stop the 10 min bound or a running Build refused: `due` is when its Build may start; `timer` is set.
 * `upgrade`: the Arc view opened a Session whose receipt has old chunk or title rules (outdated).
 */
type Pending = { due: number; timer: boolean; upgrade?: boolean };
const pendings = new WeakMap<PiViewContext, Map<string, Pending>>();
function pend(ctx: PiViewContext, threadId: string): Pending {
	let map = pendings.get(ctx); if (!map) pendings.set(ctx, map = new Map());
	const p = map.get(threadId) ?? { due: 0, timer: false };
	p.due = autoDue(ctx, threadId).due; map.set(threadId, p);
	return p;
}

/** Model calls an automatic Build keeps in flight: one slot of the hub's 3 stays free for Build arc and side asks. */
const AUTO_ASK_LIMIT = ARC_ASK_CONCURRENCY - 1;
/** The longest failure backoff of one Session. */
const AUTO_BACKOFF_CAP_MS = 120 * 60_000;

/** A fixed 0-60 s offset per Session on each backoff due time, so Sessions that failed together do not retry together. */
export function autoJitterMs(threadId: string): number {
	let h = 2166136261;
	for (let i = 0; i < threadId.length; i++) h = Math.imul(h ^ threadId.charCodeAt(i), 16777619);
	return (h >>> 0) % 60_001;
}

const warnedResets = new Set<string>();
/**
 * The reset time a quota message names, as in "resets 4:20am (Asia/Hong_Kong)": the first such wall time in that zone
 * after `after`. A reset text with no parsable time or zone gives null and logs its text once; no zone is guessed.
 */
export function quotaReset(message: string, after: number): number | null {
	if (!/\bresets?\b/i.test(message)) return null;
	const m = /\bresets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([^)]+)\)/i.exec(message);
	const hour = m ? (Number(m[1]) % 12) + (m[3]?.toLowerCase() === "pm" ? 12 : m[3] ? 0 : Math.floor(Number(m[1]) / 12) * 12) : NaN, minute = Number(m?.[2] ?? 0);
	let parts: Intl.DateTimeFormat | null = null;
	try { if (m && hour < 24 && minute < 60) parts = new Intl.DateTimeFormat("en-US", { timeZone: m[4]!.trim(), hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }); }
	catch {}
	if (!parts) {
		if (!warnedResets.has(message)) { if (warnedResets.size >= 100) warnedResets.clear(); warnedResets.add(message); console.warn(`cos.arc: quota reset time not understood; automatic Builds use the plain backoff: ${message}`); }
		return null;
	}
	// The zone's offset at t: its wall time read as UTC, minus t.
	const offset = (t: number) => { const p = Object.fromEntries(parts!.formatToParts(t).map((x) => [x.type, Number(x.value)])); return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(t / 1000) * 1000; };
	const wall = new Date(after + offset(after));
	for (let day = 0; day < 3; day++) {
		const local = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + day, hour, minute);
		const at = local - offset(local - offset(local));
		if (at > after) return at;
	}
	return null;
}

/**
 * When the next automatic Build of a Session may start, from the Build log, so it holds after a hub restart. After a
 * success: the last start + AUTO_BUILD_INTERVAL_MS. After k consecutive failed Builds of either trigger: the last start
 * + 10·2^(k-1) min (at most 120 min) + the Session's jitter, and no earlier than a quota reset the last error names.
 */
function autoDue(ctx: PiViewContext, threadId: string): { due: number; backoff: NonNullable<ArcValue["backoff"]> | null } {
	const log = buildLog(ctx, threadId), last = log.at(-1);
	let k = 0;
	while (k < log.length && log[log.length - 1 - k]!.state === "error") k++;
	if (!k) return { due: lastBuild(ctx, threadId) + AUTO_BUILD_INTERVAL_MS, backoff: null };
	const due = lastBuild(ctx, threadId) + Math.min(AUTO_BACKOFF_CAP_MS, AUTO_BUILD_INTERVAL_MS * 2 ** (k - 1)) + autoJitterMs(threadId);
	const reset = last!.error ? quotaReset(last!.error, Date.parse(last!.endedAt ?? last!.startedAt) || 0) : null;
	return { due: Math.max(due, reset ?? 0), backoff: { failures: k, code: last!.errorCode ?? null } };
}

/**
 * The automatic Builds of the whole hub run one at a time, like ask.ts's shared `running` count: `current` runs, and
 * `waiting` holds the Sessions that qualified meanwhile, first in first out; viewing a Session moves it to the head.
 * Each waiting Build takes its snapshot when it leaves the queue, so it reads the messages that arrived while it
 * waited. The queue is not persisted: after a restart the pending Builds re-derive from the Build log.
 */
const autoQueue = { current: null as { ctx: PiViewContext; threadId: string } | null, waiting: [] as { ctx: PiViewContext; threadId: string }[] };
const queuedAt = (ctx: PiViewContext, threadId: string) => autoQueue.waiting.findIndex((q) => q.ctx === ctx && q.threadId === threadId);
function unqueue(ctx: PiViewContext, threadId: string) {
	const i = queuedAt(ctx, threadId);
	if (i >= 0) autoQueue.waiting.splice(i, 1);
}
/** The running automatic Build ended, by success, failure or timeout: the next waiting Session that still qualifies starts. */
function autoDone(ctx: PiViewContext, threadId: string) {
	if (autoQueue.current?.ctx !== ctx || autoQueue.current.threadId !== threadId) return;
	autoQueue.current = null;
	while (!autoQueue.current && autoQueue.waiting.length) {
		// A Session or Host that went away meanwhile is skipped.
		const next = autoQueue.waiting.shift()!;
		try { const s = next.ctx.session(next.threadId); if (s) autoBuild(next.ctx, s); }
		catch (error) { console.error(`cos.arc: automatic Build of ${next.threadId} failed to start:`, error); }
	}
}
/** One timer per Session at the pending Build's due time; it runs autoBuild, which keeps the flag until a Build starts. */
function schedule(ctx: PiViewContext, threadId: string) {
	const p = pend(ctx, threadId);
	if (p.timer) return;
	p.timer = true;
	arcClock.later(() => {
		p.timer = false;
		const s = ctx.session(threadId);
		if (s) try { autoBuild(ctx, s); } catch (error) { console.error(`cos.arc: automatic Build of ${s.ref} failed to start:`, error); }
	}, Math.max(0, p.due - arcClock.now()));
}

/**
 * The last Build, when it failed on its answer (code `answer`). The same input gets the same answer, so the upgrade
 * path does not repeat it; only newer messages or Build arc do. Other codes upgrade through autoBuild and its backoff.
 */
function answerFailure(ctx: PiViewContext, threadId: string): ArcBuildRun | undefined {
	const last = buildLog(ctx, threadId).at(-1);
	return last?.state === "error" && last.errorCode === "answer" ? last : undefined;
}

/**
 * The automatic trigger (D16, owner option A). Every qualifying stop (a live, idle, stopped Session with chunks and
 * Rarebit messages newer than the last Build) gets a Build at the earliest time the bound allows: at most one Build
 * per AUTO_BUILD_INTERVAL_MS per Session, whatever its trigger or result. A stop the bound or a running Build refuses
 * sets one pending flag per Session and one timer at the due time. The flag clears only when a Build starts here, or
 * when a Build already covers every message. A Session no pane or control socket runs never builds automatically.
 * A Pi Team Bright Worker Session never builds automatically; before the first teams frame a stop waits for its role.
 * Failures back off (autoDue), and one automatic Build runs hub-wide at a time (autoQueue).
 * Returns whether a Build started.
 */
export function autoBuild(ctx: PiViewContext, s: PiViewSession, now = arcClock.now()): boolean {
	const why = autoStart(ctx, s, now);
	if (why === true) return true;
	if (why === WORKER) return false;
	// The safety net: a live Session with messages past its head and no Build start for over 4 h logs why, once per
	// last Build start. A successful Build or an evict clears its entry, so `quiet` holds at most one per Session.
	const last = lastBuild(ctx, s.threadId), hours = Math.floor((now - last) / 3600_000);
	if (last && hours >= 4 && s.summary?.live && s.data.rarebit.count > (readHead(ctx, s.threadId)?.n ?? -1) && quiet.get(s.threadId) !== last) {
		quiet.set(s.threadId, last);
		console.warn(`cos.arc: ${s.ref} has newer messages and no Build started for ${hours} h: ${why}`);
	}
	return false;
}
const quiet = new Map<string, number>();

/** One automatic trigger decision: true when a Build started or a reason why not. */
function autoStart(ctx: PiViewContext, s: PiViewSession, now: number): true | string {
	const t = s.summary;
	if (t?.team?.role === "worker") { pendings.get(ctx)?.delete(s.threadId); unqueue(ctx, s.threadId); roleWaits.get(ctx)?.delete(s.threadId); return WORKER; }
	if (!s.data.arc.chunks.length) return "no chunks";
	if (roleWait(ctx, s.threadId, now)) return "waiting for the Session's team role";
	// Below the floor nothing builds automatically, an upgrade included; Build arc still can.
	if (arcFloor(s.data.rarebit.count)) { pendings.get(ctx)?.delete(s.threadId); return "below the message floor"; }
	// The same chunks failed twice: another automatic Build would fail on them again.
	if (stuckOn(ctx, s)) { pendings.get(ctx)?.delete(s.threadId); return "stuck on chunks that failed twice"; }
	const running = states.get(ctx)?.get(s.threadId)?.job?.state === "running";
	// An upgrade the Arc view asked for needs neither a live Session nor new messages.
	const upgrade = pendings.get(ctx)?.get(s.threadId)?.upgrade ? outdated(state(ctx, s).receipt) : null;
	if (!upgrade) {
		if (!t?.live) return "not live";
		// A failed Build writes no head, and it covers its own input: only messages after its start build automatically
		// again. One exception: after a single model failure (busy slot, quota, model error, timeout) the same input
		// builds once more after its backoff. A record from before `asOf` falls back to the head.
		const failedAt = failedInput(ctx, s.threadId);
		const covered = running ? states.get(ctx)!.get(s.threadId)!.building ?? 0 : failedAt ?? readHead(ctx, s.threadId)?.n ?? -1;
		if (s.data.rarebit.count <= covered) { if (!running) { pendings.get(ctx)?.delete(s.threadId); unqueue(ctx, s.threadId); } return "the last failed Build read the same messages"; }
		// Not a stop now: a pending flag waits for the next idle change or its timer.
		if (t.activity !== "idle" || t.queued > 0 || !s.data.timeline.stopped) return "not at a stop";
	}
	if (running) { pend(ctx, s.threadId); return "a Build is running"; }
	const { due, backoff } = autoDue(ctx, s.threadId);
	if (now < due) { unqueue(ctx, s.threadId); schedule(ctx, s.threadId); return backoff ? `waiting out the backoff after ${backoff.failures} failed Builds` : "inside the 10 min bound"; }
	const cur = autoQueue.current;
	if (cur && !(cur.ctx === ctx && cur.threadId === s.threadId)) {
		pend(ctx, s.threadId);
		if (queuedAt(ctx, s.threadId) < 0) autoQueue.waiting.push({ ctx, threadId: s.threadId });
		return "queued behind another automatic Build";
	}
	pendings.get(ctx)?.delete(s.threadId); unqueue(ctx, s.threadId);
	started(ctx, s.threadId, now);
	autoQueue.current = { ctx, threadId: s.threadId };
	try { buildArc(ctx, s, {}, { trigger: "auto", ...(upgrade ? { cause: upgrade } : {}) }); }
	catch (e) { autoQueue.current = null; throw e; }
	return true;
}

/**
 * A failure the same input may not repeat: code `model` (a busy slot, a quota or rate limit, a model error, a
 * timeout). A record from before error codes counts when its message names the slot cap or a limit.
 */
const transient = (r: ArcBuildRun) => r.errorCode === "model" || (!r.errorCode && /already running|limit|resets/i.test(r.error ?? ""));
/** The Rarebit count the last failed Build read, unless it is the first transient failure after a success. */
function failedInput(ctx: PiViewContext, threadId: string): number | undefined {
	const log = buildLog(ctx, threadId), last = log.at(-1);
	if (last?.state !== "error") return undefined;
	if (transient(last) && log.at(-2)?.state !== "error") return undefined;
	return last.asOf;
}

/**
 * The stuck rule: the last 2 Builds failed to label the same chunks, and the Session still has them. A transient
 * failure unlocks with new messages. The same input gets the same answer, so an `answer` failure unlocks only when
 * LABEL_VERSION changes or a Build succeeds. Null when automatic Builds may run.
 */
function stuckOn(ctx: PiViewContext, s: PiViewSession): NonNullable<ArcValue["stuck"]> | null {
	const [a, b] = buildLog(ctx, s.threadId).slice(-2);
	if (!a?.failedChunks?.length || !b?.failedChunks?.length) return null;
	const key = (r: ArcBuildRun) => r.failedChunks!.map((c) => c.hash).sort().join(" ");
	if (key(a) !== key(b)) return null;
	const byHash = new Map(s.data.arc.chunks.map((c) => [c.hash, c.id]));
	const chunks = b.failedChunks.flatMap((c) => byHash.get(c.hash) ?? []);
	if (!chunks.length) return null;
	if (b.labelErrorCode === "answer") return b.labelVersion === LABEL_VERSION ? { chunks, until: "build" } : null;
	return s.data.rarebit.count > (b.asOf ?? 0) ? null : { chunks, until: "messages" };
}

/**
 * Why a receipt needs one rebuild, as the Build record names it: other chunk rules, a stored empty tree, or another
 * label or step-2 version. Null for a receipt that needs none.
 */
function outdated(receipt: Receipt | undefined): string | null {
	if (!receipt) return null;
	if (receipt.chunkerVersion !== CHUNKER_VERSION) return "rebuilt: chunk rules changed";
	if (receipt.context && emptyTree(receipt.context)) return "rebuilt: the stored Arc was empty";
	if (receipt.labelVersion !== LABEL_VERSION || receipt.step2Version !== STEP2_VERSION) return "rebuilt: the Arc format changed";
	return null;
}

/**
 * The Arc view opened a Session with an outdated receipt: one Build through the pending path and the 10 min bound.
 * Only a viewed Session asks; a running Build or a pending flag already covers it. A Build whose answer failed after
 * the receipt does not run again here, because the same input gets the same answer; Build arc retries it. A transient
 * failure (`source`, `model`) keeps the 10 min path. A Session below the floor (arcFloor) waits for it.
 */
function upgradeOnView(ctx: PiViewContext, s: PiViewSession) {
	if (!s.data.arc.chunks.length || arcFloor(s.data.rarebit.count) || pendings.get(ctx)?.get(s.threadId)?.upgrade) return;
	const failed = answerFailure(ctx, s.threadId), receipt = state(ctx, s).receipt;
	// ISO times compare as strings; a receipt without builtAt compares false, so its upgrade still runs.
	if (failed && receipt && failed.startedAt > receipt.builtAt) return;
	pend(ctx, s.threadId).upgrade = true;
	autoBuild(ctx, s);
}

/** Pi Team Bright Worker Sessions build only on Build arc (owner rule, 2026-10-20); leaders and other Sessions keep automatic Builds. */
const WORKER = "a Worker Session builds only on Build arc";
/** How long a stop waits for the first teams frame before its Session counts as having no team role. */
const ROLE_WAIT_MS = 30_000;
const ROLE_RECHECK_MS = 5_000;
const roleWaits = new WeakMap<PiViewContext, Map<string, { since: number; timer: boolean }>>();

/**
 * Before the first teams frame a Session's role is unknown, so a Worker could look like a normal Session. A stop then
 * waits and re-checks every 5 s. After 30 s the role counts as absent and automatic Builds proceed, so a Host whose
 * Teams read never answers keeps them. Returns whether the stop waits.
 */
function roleWait(ctx: PiViewContext, threadId: string, now: number): boolean {
	let map = roleWaits.get(ctx);
	if (ctx.rolesKnown?.() !== false) { map?.delete(threadId); return false; }
	if (!map) roleWaits.set(ctx, map = new Map());
	const w = map.get(threadId) ?? { since: now, timer: false };
	map.set(threadId, w);
	if (now - w.since >= ROLE_WAIT_MS) return false;
	if (!w.timer) {
		w.timer = true;
		// The wait may hold back a hub-start Build, so /api/health counts it in `roleWaits` until its re-check has run: a
		// harness that waits for hub-start Builds waits for this one too. A re-check that builds or still waits counts the
		// Build or its own wait before this one settles. `builds` stays Builds: a wait that ends without one starts none.
		void trackRoleWait(() => new Promise<void>((done) => arcClock.later(() => {
			w.timer = false;
			const s = ctx.session(threadId);
			try { if (s) autoBuild(ctx, s); } catch (error) { console.error(`cos.arc: automatic Build of ${s?.ref} failed to start:`, error); } finally { done(); }
		}, Math.min(ROLE_RECHECK_MS, w.since + ROLE_WAIT_MS - now))));
	}
	return true;
}

export const cosArc: PiView<"cos.arc"> = {
	name: "cos.arc",
	evict(ctx, id) { states.get(ctx)?.delete(id); pendings.get(ctx)?.delete(id); unqueue(ctx, id); roleWaits.get(ctx)?.delete(id); quiet.delete(id); heads.get(ctx)?.delete(id); logs.get(ctx)?.delete(id); },
	changed(ctx, sessions) {
		for (const s of sessions) try { autoBuild(ctx, s); } catch (error) { console.error(`cos.arc: automatic Build of ${s.ref} failed to start:`, error); }
	},
	summarize(ctx, s) {
		const head = readHead(ctx, s.threadId);
		if (!head || head.e) return undefined;
		const h = arcHead(s, head);
		return { arc: { builtAt: h.builtAt!, stale: h.newMessages > 0 || h.branchChanged, newMessages: h.newMessages, finished: h.finished,
			asks: NEEDS_YOU_KINDS.filter((k) => h.open[k] > 0).map((kind) => ({ kind, n: h.open[kind], since: h.oldest[kind] })), ...(h.overtaken ? { overtaken: h.overtaken } : {}) } };
	},
	value(ctx, topic) {
		if (!topic.threadId) {
			// A built Session stays listed so its open asks remain visible even when it is short.
			return { sessions: timeline(ctx).sessions.flatMap(({ entries, buckets, marks, ...row }) => {
				const s = ctx.session(row.threadId), head = s ? readHead(ctx, row.threadId) : null;
				if (!s || !((head && !head.e) || row.entryCount >= 200 || row.end - row.start >= 20 * 3600_000)) return [];
				return [{ ...row, head: arcHead(s, head) }];
			}) } satisfies ArcListValue;
		}
		const s = ctx.session(topic.threadId);
		if (!s) return { missing: true, notice: "This Session is not in the Host's local copies. Open it from the sidebar or reconnect the Host." };
		const st = state(ctx, s), receipt = st.receipt, context = receipt?.context, floor = arcFloor(s.data.rarebit.count);
		if (outdated(receipt) && st.job?.state !== "running") upgradeOnView(ctx, s);
		// The viewed Session builds next among the waiting automatic Builds.
		const queued = queuedAt(ctx, s.threadId);
		if (queued > 0) autoQueue.waiting.unshift(...autoQueue.waiting.splice(queued, 1));
		const status = contextStatus(s, context, Boolean(receipt));
		const byHash = labelsByHash(receipt), sameRules = receipt?.chunkerVersion === CHUNKER_VERSION;
		// A label follows its chunk by hash; by chunk id only under the same chunk rules, as a stale label.
		const chunks = s.data.arc.chunks.map((c) => {
			const reusable = byHash.get(c.hash), byId = receipt?.labels[c.id], label = reusable ?? (sameRules ? byId : undefined);
			return { ...c, label: label ?? null, labelCurrent: Boolean(reusable), ...(!label && byId ? { relabel: true } : {}) };
		});
		const projects = new Map<string, Card>();
		for (const c of chunks) if (c.label) {
			const inferred = receipt?.projects.find((p) => [p.name, ...p.aliases].some((name) => name.toLowerCase() === c.label!.project.toLowerCase())) ?? null;
			const name = inferred?.name ?? c.label.project;
			const p = projects.get(name) ?? { name, chunks: 0, resumeEntryId: c.lastOwnerEntryId ?? c.lastEntryId, inferred };
			p.chunks++; p.resumeEntryId = c.lastOwnerEntryId ?? c.lastEntryId; projects.set(p.name, p);
		}
		const labelled = chunks.filter((c) => c.labelCurrent).length, lastDone = buildLog(ctx, s.threadId).findLast((b) => b.state === "done");
		const inputChars = STEP2_SYSTEM.length + chunks.length * 300 + Math.ceil((chunks.length - labelled) / LABEL_BATCH) * LABEL_SYSTEM.length + s.data.arc.inputChars;
		return { source: sourceStatus(s), threadId: s.threadId, title: s.summary?.title ?? s.threadId, ref: s.ref, chunks, cards: [...projects.values()], transitions: receipt?.transitions.filter((t) => chunks.some((c) => c.id === t.chunk)) ?? [],
			// An empty tree is no valid Arc, so its headline does not show either.
			synthesis: receipt && !(context && emptyTree(context)) ? { headline: receipt.headline, model: receipt.models ? receipt.models.synthesis : receipt.model, builtAt: receipt.builtAt ?? null } : null,
			keptAt: context && !emptyTree(context) ? receipt!.builtAt : null,
			coverage: { labelledChunks: labelled, unmappedChunks: chunks.length - labelled, synthesisCurrent: Boolean(context) && status.newMessages === 0 && !status.branchChanged, excludedEntries: s.data.arc.excludedEntries },
			buildEstimate: { calls: chunks.length ? Math.ceil((chunks.length - labelled) / LABEL_BATCH) + 1 : 0, inputTokens: Math.ceil(inputChars / 4), truncatedChunks: s.data.arc.shortenedChunks,
				lastInputTokens: lastDone ? lastDone.usage.input + lastDone.usage.cacheRead + lastDone.usage.cacheWrite : null, lastCost: lastDone?.usage.cost ?? null },
			context: floor && context && !context.threads.length ? null : context ?? null, floor, contextStatus: status, relabelChunks: receipt && !sameRules ? chunks.length - labelled : null, nextAutoAt: pendings.get(ctx)?.get(s.threadId)?.due ?? null, queuedAhead: queuedAt(ctx, s.threadId) >= 0 ? queuedAt(ctx, s.threadId) + (autoQueue.current ? 1 : 0) : null, backoff: autoDue(ctx, s.threadId).backoff, stuck: stuckOn(ctx, s), autoOff: s.summary?.team?.role === "worker" ? "worker" : null, job: st.job ? { ...st.job } : null, builds: buildLog(ctx, s.threadId).slice(-10),
			notice: receipt ? "Arc labels and context are assessments, not Task or Project authority. Build arc updates this Session from the hub's local copy."
				: "Deterministic chunks only; model labels and context appear only after Build arc. No tools or Session writes." } satisfies ArcValue;
	},
	ops: {
		async build(ctx, args) {
			const s = ctx.session(String(args.threadId ?? "")); if (!s) throw new Error("Unknown Session on this Host");
			return buildArc(ctx, s, args);
		},
	},
};
