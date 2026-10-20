import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHUNKER_VERSION, EXCERPT_VERSION, type Chunk } from "./cos-arc-chunks.ts";
import { LABEL_SYSTEM, SYNTH_SYSTEM, labelPrompt, synthPrompt, normalizeLabel, normalizeProjects, text, fields, oneOf, type Label, type Project } from "./cos-arc-model.ts";
import { timeline, type TimelineSession } from "./cos-timeline.ts";
import { CONTEXT_SYSTEM, NEEDS_YOU_KINDS, contextPrompt, emptyTree, normalizeContext, rawTreeCount, treeCount, type ArcContext, type ContextSupport, type NeedsYouKind, type TreeCount } from "./cos-arc-context.ts";
import { askCandidates } from "./cos-arc-asks.ts";
import { AUTO_BUILD_MIN_MESSAGES, arcFloor } from "./cos-arc-rules.ts";
import { InvalidReply, reply, retryNote, type ArcPurpose, type SynthesisReply } from "./cos-arc-reply.ts";
export { json } from "./cos-arc-reply.ts";
import { trackBuild } from "../derive-queue.ts";
import { ModelNotFound } from "../../hub/helper-models.ts";
import type { RarebitItem } from "./rarebit.ts";
import type { AskUsage } from "../ask.ts";
import { sourceStatus, type SourceStatus, type PiView, type PiViewContext, type PiViewSession } from "./types.ts";

/** `relabel`: a receipt of other chunk rules labelled this chunk id; that label is hidden until a Build relabels it. */
export type ArcChunk = Chunk & { labelCurrent: boolean; label: Label | null; relabel?: boolean };
type Card = { name: string; chunks: number; resumeEntryId: string; inferred: { summary: string; status: string } | null };
type Transition = { chunk: string; from: string | null; to: string | null; kind: string; why: string | null; source: string };
/**
 * Why a Build failed. `model`: no usable model, or the model runner or provider failed (ask codes model_not_found,
 * registry_unreadable, no_model, model_error, timeout, no_result, busy). `answer`: the model answered without usable JSON or labels. `source`: the Session's derived data changed
 * or was unreadable while the Build read its snapshot. `internal`: anything else.
 */
export type ArcErrorCode = "model" | "answer" | "source" | "internal";
/** A failed Build: `purpose` and `model` name the call whose reply stayed invalid after its retry; `at` is when it failed. */
/**
 * `preflight`: the Build failed its model check before any call. `hint`, for a model name that names no model, says
 * where to change the name and what to try; it replaces the generic next action.
 */
export type ArcFailure = { message: string; code: ArcErrorCode; purpose?: ArcPurpose; model?: string | null; preflight?: true; hint?: string; available?: string[]; at: string };
/** `chunks` in the start snapshot and `toLabel`, those without a reusable label, show the incremental cost. */
/** `empty`: a done Build below the floor (arcFloor) whose tree was empty; it wrote no receipt or head. */
type Job = { state: string; done: number; total: number; chunks: number; toLabel: number; waitingFor: string | null; lastError: ArcFailure | null; trigger: ArcTrigger; empty?: true };
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
	/** Why an automatic Build rebuilt the stored Arc on view ("rebuilt: the stored Arc was empty"); absent otherwise. */
	cause?: string;
	/**
	 * The Rarebit count when the Build was requested, before any wait for loading, so it never covers a message the Build
	 * did not see. An answer failure's count gates the next automatic Build. Absent in older records.
	 */
	asOf?: number; error?: string; errorCode?: ArcErrorCode;
	/** The call and model whose reply stayed invalid (ArcFailure), so the failure reads the same after a hub restart. */
	errorPurpose?: ArcPurpose; errorModel?: string | null;
	/** The last tier-2 answer of the Build: its counts as the model wrote them, and as kept after the citation filter. */
	tree?: { raw: TreeCount; kept: TreeCount };
	/** Chunk labels taken from the previous receipt by chunk hash; absent in older records. */
	reusedLabels?: number;
	/** Label calls repeated once for the chunks a first answer missed or failed; absent in older records. */
	retries?: number;
	/** Chunks still without a label after the retry; the Build kept the other labels and the tier-2 tree. */
	unlabelledChunks?: number;
	/** The code of the first label failure behind `unlabelledChunks`. */
	labelErrorCode?: ArcErrorCode;
	/** The exact provider/id each call purpose used, as checked before the first call; absent in older records and
	 * when the check failed. */
	models?: BuildModels;
	/** The model name the check found no model for; the Build made no call. */
	missingModel?: string;
	/** Calls and summed price per call purpose; absent in older records. */
	usageByPurpose?: Record<keyof BuildModels, { calls: number; cost: number | null }> };
/** One key per Arc call purpose, as in the receipt's `models`. Labels and context use arcLabels; synthesis uses arcSynthesis. */
type BuildModels = { labels: string; synthesis: string; context: string };
const PURPOSE_KEY: Record<ArcPurpose, keyof BuildModels> = { label: "labels", synthesis: "synthesis", context: "context" };
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
	 * `coveredAt`: the time of the newest message the tree covers, when known. `formatChanged`: another tier-2 prompt
	 * (CONTEXT_VERSION) built the tree, so its titles follow older rules until the next Build; currency is unchanged.
	 * `unknown`: a receipt without a tree, so what it covers is unknown.
	 */
	contextStatus: { newMessages: number; branchChanged: boolean; coveredAt?: number | null; formatChanged?: boolean; unknown?: boolean };
	/** Chunks that need labels because the receipt used other chunk rules (CHUNKER_VERSION); null when the rules match. */
	relabelChunks?: number | null;
	/** When the pending automatic Build is due (epoch ms); null when no qualifying stop waits for one. */
	nextAutoAt: number | null;
	job: Job | null; builds: ArcBuildRun[]; notice: string;
};
/**
 * `labelVersion` (LABEL_VERSION) is absent in older receipts; their labels still render but are never reused.
 * `chunkerVersion` (CHUNKER_VERSION) names the chunk rules; absent before ampi-arc-chunker/4. A label shows by chunk id
 * only under the same chunk rules. `excerptVersion` (EXCERPT_VERSION) names the label excerpt rules of that Build.
 */
type Receipt = { version: 3 | 4; labelVersion?: string; chunkerVersion?: string; excerptVersion?: string; sourceVersion: string; builtAt: string; labels: Record<string, Label & { hash: string }>; headline: string; projects: Project[]; transitions: Transition[];
	/** The last answering model; `models` records each purpose apart (absent before ingest-partial-build). */
	model: string | null; models?: { labels: string | null; synthesis: string | null; context: string | null }; context?: ArcContext };
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
		st = { ...(receipt?.version === 3 || receipt?.version === 4 ? { receipt } : {}) };
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

/** Names what a label means: the label instructions, the label prompt shape, and the chunking rules. */
/** Changes with the tier-2 prompt; a tree built under another version keeps older titles until the next Build. */
export const CONTEXT_VERSION = createHash("sha256").update(CONTEXT_SYSTEM).update(contextPrompt([], {}, new Map(), { candidates: [], owners: new Map() })).digest("hex").slice(0, 16);
export const LABEL_VERSION = createHash("sha256").update(LABEL_SYSTEM).update(labelPrompt([], new Map())).update(CHUNKER_VERSION).digest("hex").slice(0, 16);

/**
 * The previous receipt's reusable labels by chunk hash. The hash covers a chunk's entry IDs and excerpt, so a label
 * follows its content when a compaction or branch change renumbers chunk IDs. A receipt with another label version
 * reuses nothing.
 */
function labelsByHash(receipt: Receipt | undefined) {
	return new Map(receipt?.labelVersion === LABEL_VERSION ? Object.values(receipt.labels).map((l) => [l.hash, l]) : []);
}

const MODEL_CODES = new Set(["model_not_found", "registry_unreadable", "no_model", "model_error", "timeout", "no_result", "busy"]);
const failure = (code: ArcErrorCode, message: string) => Object.assign(new Error(message), { code });
function errorCode(e: unknown): ArcErrorCode {
	const code = (e as { code?: string })?.code;
	return code === "answer" || code === "source" || code === "model" ? code : code && MODEL_CODES.has(code) ? "model" : "internal";
}

/** Entry IDs a context leaf may cite: Rarebit message lines of this build's evidence. */
const citable = (evidence: Map<string, string>) => [...evidence.values()].flatMap((text) => [...text.matchAll(/^\[([^\]]+)\] (?:USER|AGENT):/gm)].map((m) => m[1]!));


/** The one currency rule (Rarebit messages): the tree and the synthesis are current when no message is newer and the branch is the same. */
function contextStatus(s: PiViewSession, context: ArcContext | undefined, built = false) {
	if (!context) return { newMessages: 0, branchChanged: false, coveredAt: null, formatChanged: false, unknown: built };
	const coveredAt = context.asOfEntryId ? s.entryTimes([context.asOfEntryId]).get(context.asOfEntryId) ?? null : null;
	return { ...staleness(s, context.asOfRarebitCount, context.rarebitFingerprint), coveredAt, formatChanged: context.format !== CONTEXT_VERSION };
}

/** The owner-facing failure of a tier-2 answer that kept nothing, even after its retry. */
export const EMPTY_ANSWER = `The Arc answer was empty: it listed no work threads, open asks, progress, decisions or blockers, even after one retry, in a Session at or above the ${AUTO_BUILD_MIN_MESSAGES}-message floor.`;
/** An empty tree below the floor: the Build ends done with nothing to summarize. It is no invalid reply, so no retry. */
class NothingYet extends Error {}

/**
 * Model calls one Build keeps in flight. The hub's ask runner refuses a fourth call with `busy` (src/pi/ask.ts), so a
 * higher bound would only add retries.
 */
export const ARC_ASK_CONCURRENCY = 3;
const LABEL_BATCH = 6;

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

/** ctx.ask, waiting out `busy` when another feature holds the hub's shared model slots (about 16 s at most). */
async function askWhenFree(ctx: PiViewContext, req: Parameters<PiViewContext["ask"]>[0]) {
	for (let wait = 250; ; wait *= 2) {
		try { return await ctx.ask(req); }
		catch (e) { if ((e as { code?: string }).code !== "busy" || wait > 8000) throw e; await new Promise((r) => setTimeout(r, wait)); }
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
 * Starts one combined Build (tier-1 labels and synthesis, then the tier-2 tree) for a Session. Trigger-agnostic:
 * the explicit Build op calls it today; an automatic trigger may call it unchanged. A running Build is reused.
 * The Build works on a snapshot taken at its start and always commits a receipt for that snapshot. Messages that
 * arrive meanwhile make the head stale, and the next Build covers them. Labels whose chunk hash is unchanged since
 * the previous receipt are reused, so a Build labels only new or changed chunks.
 */
export function buildArc(ctx: PiViewContext, s: PiViewSession, args: { model?: unknown } = {}, { limit = ARC_ASK_CONCURRENCY, trigger = "manual", cause }: { limit?: number; trigger?: ArcTrigger; cause?: string } = {}): { started: true } {
	const st = state(ctx, s);
	if (st.job?.state === "running") return { started: true };
	if (!s.data.arc.chunks.length) throw new Error("There are no chunks to label yet.");
	const job: Job = { state: "running", done: 0, total: 0, chunks: s.data.arc.chunks.length, toLabel: 0, waitingFor: null, lastError: null, trigger };
	const release = ctx.lease(s.threadId);
	st.job = job; st.building = s.data.rarebit.count; ctx.invalidate("cos.arc");
	const startedAt = new Date().toISOString();
	// autoBuild records its own start time.
	if (trigger === "manual") started(ctx, s.threadId, arcClock.now());
	let retries = 0, unlabelled = 0, reused = 0, afterEntryId: string | null = null, labelErrorCode: ArcErrorCode | null = null, counted: ArcBuildRun["tree"];
	const spent = { calls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null } as AskUsage, model: null as string | null,
		byPurpose: { labels: { calls: 0, cost: null }, synthesis: { calls: 0, cost: null }, context: { calls: 0, cost: null } } as NonNullable<ArcBuildRun["usageByPurpose"]> };
	let models: BuildModels | undefined;
	// Every model call of this Build goes through `asked`, so the Build log carries its usage.
	const asked = async (purpose: ArcPurpose, req: Parameters<PiViewContext["ask"]>[0]) => {
		const answer = await askWhenFree(ctx, req);
		const mine = spent.byPurpose[PURPOSE_KEY[purpose]];
		spent.calls++; mine.calls++; spent.model = answer.model ?? spent.model;
		const u = answer.usage, total = spent.usage;
		if (u) {
			total.input += u.input; total.output += u.output; total.cacheRead += u.cacheRead; total.cacheWrite += u.cacheWrite;
			if (u.cost !== null) { total.cost = (total.cost ?? 0) + u.cost; mine.cost = (mine.cost ?? 0) + u.cost; }
		}
		return answer;
	};
	// Every Arc call goes through `valid`: an invalid reply is asked once more with the reason, then fails the call.
	// `accept` turns the parsed reply into what the Build stores; it throws InvalidReply when a purpose's rule fails.
	const valid = async <R, T = R>(purpose: ArcPurpose, req: Parameters<PiViewContext["ask"]>[0], accept?: (r: R) => T) => {
		// Without `accept` the reply is stored as parsed, so T is R.
		const parsed = (text: string): T => { const r = reply(purpose, text); return accept ? accept(r as R) : r as T; };
		let answer = await asked(purpose, req);
		try { return { answer, reply: parsed(answer.text) }; }
		catch (e) {
			if (!(e instanceof InvalidReply)) throw e;
			retries++; job.total++; ctx.invalidate("cos.arc");
			answer = await asked(purpose, { ...req, system: req.system + retryNote(e) });
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
			job.waitingFor = "Checking Pi’s models…"; ctx.invalidate("cos.arc");
			// Both resolve together. The labels failure is reported first, as labels run first; its message also names a
			// failed synthesis model, so one Build shows every key to fix.
			const resolved = await Promise.allSettled([ctx.model("arcLabels", override), ctx.model("arcSynthesis", override)]);
			const failed = resolved.flatMap((r) => (r.status === "rejected" ? [r.reason as Error] : []));
			if (failed[0]) throw Object.assign(failed[1] ? ModelNotFound.merge(failed[0], failed[1]) : failed[0], { preflight: true });
			const [labelModel, synthModel] = resolved.map((r) => (r as PromiseFulfilledResult<string>).value) as [string, string];
			job.waitingFor = null;
			models = { labels: labelModel, synthesis: synthModel, context: labelModel };
			const labelReq = { purpose: "arcLabels" as const, model: labelModel, resolved: true }, synthReq = { purpose: "arcSynthesis" as const, model: synthModel, resolved: true };
			const prior = labelsByHash(st.receipt), labels: Receipt["labels"] = {}, fresh: Chunk[] = [];
			for (const c of chunks) { const l = prior.get(c.hash); if (l) labels[c.id] = l; else fresh.push(c); }
			reused = chunks.length - fresh.length;
			const batches = Array.from({ length: Math.ceil(fresh.length / LABEL_BATCH) }, (_, i) => fresh.slice(i * LABEL_BATCH, (i + 1) * LABEL_BATCH));
			Object.assign(job, { chunks: chunks.length, toLabel: fresh.length, total: batches.length + 2 }); ctx.invalidate("cos.arc");
			// One label call for `batch`: the labels it returned and the chunks it missed. A failed call misses them all.
			type Labelled = { model: string | null; labels: [string, Label & { hash: string }][]; missed: Chunk[]; error: Error | null };
			const label = async (batch: Chunk[]): Promise<Labelled> => {
				let answer: Awaited<ReturnType<typeof asked>>, raw: { chunks: unknown[] };
				try { ({ answer, reply: raw } = await valid<{ chunks: unknown[] }>("label", { system: LABEL_SYSTEM, prompt: labelPrompt(batch, evidence), ...labelReq })); }
				catch (e) { return { model: e instanceof InvalidReply ? e.model : null, labels: [], missed: batch, error: e as Error }; }
				// The model answered: whatever is wrong with the answer is an `answer` failure.
				try {
					const out: [string, Label & { hash: string }][] = [], missed: Chunk[] = [];
					for (const c of batch) {
						const l = normalizeLabel(raw.chunks.find((x) => fields(x).chunk === c.id), evidence.get(c.id) ?? "");
						if (l.project && l.topic) out.push([c.id, { hash: c.hash, ...l }]); else missed.push(c);
					}
					return { model: answer.model ?? null, labels: out, missed, error: missed.length ? failure("answer", `The model omitted labels for ${missed.map((c) => c.id).join(", ")}.`) : null };
				} catch (e) {
					return { model: answer.model ?? null, labels: [], missed: batch, error: errorCode(e) === "answer" ? e as Error : failure("answer", `The model’s label answer was unusable: ${(e as Error).message}`) };
				}
			};
			// Label batches run concurrently; each result lands in batch order, so the receipt matches a sequential Build.
			// A batch repeats once for only its missed chunks; chunks still missed stay unlabelled and the Build goes on.
			// An invalid reply was already asked twice, so it does not repeat.
			const answers = await bounded(batches, limit, async (batch) => {
				let a = await label(batch);
				if (a.missed.length && !(a.error instanceof InvalidReply)) {
					retries++; job.total++; ctx.invalidate("cos.arc");
					const again = await label(a.missed);
					a = { model: again.model ?? a.model, labels: [...a.labels, ...again.labels], missed: again.missed, error: again.error };
					a.labels.sort((x, y) => batch.findIndex((c) => c.id === x[0]) - batch.findIndex((c) => c.id === y[0]));
					job.done++;
				}
				job.done++; ctx.invalidate("cos.arc");
				return a;
			});
			for (const c of chunks) { const l = answers.flatMap((a) => a.labels).find(([id]) => id === c.id)?.[1]; if (l) labels[c.id] = l; }
			unlabelled = answers.reduce((n, a) => n + a.missed.length, 0);
			const labelError = answers.find((a) => a.error)?.error;
			if (fresh.length && unlabelled === fresh.length) throw labelError ?? failure("answer", "The model returned no labels.");
			if (unlabelled) labelErrorCode = labelError ? errorCode(labelError) : "answer";
			const model = answers.reduce<string | null>((m, a) => a.model ?? m, null);
			const lastEvidence = citable(evidence).at(-1) ?? null;
			// The tier-2 reply is normalized here, once; the Build sets builtAt and model after the call. The kept tree must
			// not be empty (emptyTree), so an empty answer is invalid and never replaces the last good Arc. Below the floor
			// an empty answer is expected: the Build ends quietly.
			const tree = (raw: unknown) => {
				const t = normalizeContext(raw, chunks, evidence, snap.ref, snap.times, "", null, snap.rarebitCount, snap.fingerprint, lastEvidence, snap.support);
				counted = { raw: rawTreeCount(raw), kept: treeCount(t) };
				if (emptyTree(t) && arcFloor(snap.rarebitCount)) throw new NothingYet();
				if (emptyTree(t)) throw new InvalidReply("context", "no work thread, open ask or unassigned item with a citation and a verbatim quote from the evidence", EMPTY_ANSWER);
				return t;
			};
			// Synthesis and the tier-2 tree both read the labels and nothing else from each other.
			type Call = { call: ArcPurpose; purpose: "arcLabels" | "arcSynthesis"; model: string; resolved: boolean; system: string; prompt: string; accept?: (r: unknown) => unknown };
			const [synthesis, contextual] = await bounded<Call, { answer: Awaited<ReturnType<typeof asked>>; reply: unknown }>([
				{ call: "synthesis", system: SYNTH_SYSTEM, prompt: synthPrompt(chunks, labels, snap.cwd), ...synthReq },
				{ call: "context", system: CONTEXT_SYSTEM, prompt: contextPrompt(chunks, labels, evidence, snap.support), ...labelReq, accept: tree },
			], limit, async ({ call, accept, ...req }) => { const r = await valid<unknown>(call, req, accept); job.done++; ctx.invalidate("cos.arc"); return r; });
			const synth = synthesis!.answer, synthRaw = synthesis!.reply as SynthesisReply, contextAnswer = contextual!.answer;
			const ids = new Set(chunks.map((c) => c.id)), builtAt = new Date().toISOString();
			const context = { ...contextual!.reply as ArcContext, builtAt, model: contextAnswer.model ?? null, format: CONTEXT_VERSION };
			const receipt: Receipt = { version: 4, labelVersion: LABEL_VERSION, chunkerVersion: CHUNKER_VERSION, excerptVersion: EXCERPT_VERSION, sourceVersion, builtAt, labels, headline: text(synthRaw.headline, 180), model: contextAnswer.model ?? synth.model ?? model,
				models: { labels: model, synthesis: synth.model ?? null, context: contextAnswer.model ?? null },
				projects: normalizeProjects(synthRaw.projects, ids),
				transitions: synthRaw.transitions.slice(0, 80).map(fields).flatMap((t) => typeof t.chunk === "string" && ids.has(t.chunk) ? [{ chunk: t.chunk, from: text(t.from, 90), to: text(t.to, 90), kind: oneOf(["pivot", "new_project", "return", "subtopic", "digression"], t.kind, "pivot"), why: text(t.why, 180), source: "synthesis" }] : []), context };
			const file = pathFor(ctx, s.threadId); writeFileSync(`${file}.tmp`, JSON.stringify(receipt), { mode: 0o600 }); renameSync(`${file}.tmp`, file);
			writeHead(ctx, s.threadId, headOf(receipt as Receipt & { context: ArcContext }));
			st.receipt = receipt; job.state = "done";
		} catch (e) {
			job.waitingFor = null;
			if (e instanceof NothingYet) { job.state = "done"; job.empty = true; }
			else {
				job.state = "error";
				const failed = e instanceof InvalidReply ? { purpose: e.purpose, model: e.model } : e instanceof ModelNotFound ? { purpose: e.purpose === "arcSynthesis" ? "synthesis" as const : "label" as const, model: e.model } : {};
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
					...(retries ? { retries } : {}), ...(unlabelled && job.state === "done" ? { unlabelledChunks: unlabelled, ...(labelErrorCode ? { labelErrorCode } : {}) } : {}), ...(reused ? { reusedLabels: reused } : {}),
					...(models ? { models } : {}), usageByPurpose: spent.byPurpose });
			} catch {}
			ctx.invalidate("cos.arc"); if (trigger === "auto") ctx.invalidate("rarebit");
			if (pendings.get(ctx)?.has(s.threadId)) schedule(ctx, s.threadId);
		}
	});
	return { started: true };
}

/** Minimum time between automatic Builds of one Session (D16). */
export const AUTO_BUILD_INTERVAL_MS = 10 * 60_000;
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
	p.due = lastBuild(ctx, threadId) + AUTO_BUILD_INTERVAL_MS; map.set(threadId, p);
	return p;
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
 * The last Build, when it failed on its answer (code `answer`). The same input gets the same answer, so neither
 * automatic path repeats it; only newer messages or Build arc do. Transient codes (`source`, `model`, `internal`)
 * keep the 10 min path.
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
 * Returns whether a Build started.
 */
export function autoBuild(ctx: PiViewContext, s: PiViewSession, now = arcClock.now()): boolean {
	const t = s.summary;
	if (!s.data.arc.chunks.length) return false;
	// Below the floor nothing builds automatically, an upgrade included; Build arc still can.
	if (arcFloor(s.data.rarebit.count)) { pendings.get(ctx)?.delete(s.threadId); return false; }
	const running = states.get(ctx)?.get(s.threadId)?.job?.state === "running";
	// An upgrade the Arc view asked for needs neither a live Session nor new messages.
	const upgrade = pendings.get(ctx)?.get(s.threadId)?.upgrade ? outdated(state(ctx, s).receipt) : null;
	if (!upgrade) {
		if (!t?.live) return false;
		// A failed Build writes no head. An answer failure covers its own input, so only messages after its start build
		// automatically again; a transient failure and a record from before `asOf` fall back to the head.
		const failedAt = answerFailure(ctx, s.threadId)?.asOf;
		const covered = running ? states.get(ctx)!.get(s.threadId)!.building ?? 0 : failedAt ?? readHead(ctx, s.threadId)?.n ?? -1;
		if (s.data.rarebit.count <= covered) { if (!running) pendings.get(ctx)?.delete(s.threadId); return false; }
		// Not a stop now: a pending flag waits for the next idle change or its timer.
		if (t.activity !== "idle" || t.queued > 0 || !s.data.timeline.stopped) return false;
	}
	if (running) { pend(ctx, s.threadId); return false; }
	if (now < lastBuild(ctx, s.threadId) + AUTO_BUILD_INTERVAL_MS) { schedule(ctx, s.threadId); return false; }
	pendings.get(ctx)?.delete(s.threadId);
	started(ctx, s.threadId, now);
	buildArc(ctx, s, {}, { trigger: "auto", ...(upgrade ? { cause: upgrade } : {}) });
	return true;
}

/**
 * Why a receipt needs one rebuild, as the Build record names it: other chunk rules, another tier-2 title format, or a
 * stored empty tree. Null for a receipt that needs none.
 */
function outdated(receipt: Receipt | undefined): string | null {
	if (!receipt) return null;
	if (receipt.chunkerVersion !== CHUNKER_VERSION) return "rebuilt: chunk rules changed";
	if (receipt.context && emptyTree(receipt.context)) return "rebuilt: the stored Arc was empty";
	if (receipt.context && receipt.context.format !== CONTEXT_VERSION) return "rebuilt: the tree format changed";
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

export const cosArc: PiView<"cos.arc"> = {
	name: "cos.arc",
	evict(ctx, id) { states.get(ctx)?.delete(id); pendings.get(ctx)?.delete(id); heads.get(ctx)?.delete(id); logs.get(ctx)?.delete(id); },
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
		const inputChars = SYNTH_SYSTEM.length + CONTEXT_SYSTEM.length + chunks.length * 300 + Math.ceil((chunks.length - labelled) / LABEL_BATCH) * LABEL_SYSTEM.length + s.data.arc.inputChars;
		return { source: sourceStatus(s), threadId: s.threadId, title: s.summary?.title ?? s.threadId, ref: s.ref, chunks, cards: [...projects.values()], transitions: receipt?.transitions.filter((t) => chunks.some((c) => c.id === t.chunk)) ?? [],
			// An empty tree is no valid Arc, so its headline does not show either.
			synthesis: receipt && !(context && emptyTree(context)) ? { headline: receipt.headline, model: receipt.models ? receipt.models.synthesis : receipt.model, builtAt: receipt.builtAt ?? null } : null,
			keptAt: context && !emptyTree(context) ? receipt!.builtAt : null,
			coverage: { labelledChunks: labelled, unmappedChunks: chunks.length - labelled, synthesisCurrent: Boolean(context) && status.newMessages === 0 && !status.branchChanged, excludedEntries: s.data.arc.excludedEntries },
			buildEstimate: { calls: chunks.length ? Math.ceil((chunks.length - labelled) / LABEL_BATCH) + 2 : 0, inputTokens: Math.ceil(inputChars / 4), truncatedChunks: s.data.arc.shortenedChunks,
				lastInputTokens: lastDone ? lastDone.usage.input + lastDone.usage.cacheRead + lastDone.usage.cacheWrite : null, lastCost: lastDone?.usage.cost ?? null },
			context: floor && context && !context.threads.length ? null : context ?? null, floor, contextStatus: status, relabelChunks: receipt && !sameRules ? chunks.length - labelled : null, nextAutoAt: pendings.get(ctx)?.get(s.threadId)?.due ?? null, job: st.job ? { ...st.job } : null, builds: buildLog(ctx, s.threadId).slice(-10),
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
