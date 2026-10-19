import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHUNKER_VERSION, type Chunk } from "./cos-arc-chunks.ts";
import { LABEL_SYSTEM, SYNTH_SYSTEM, labelPrompt, synthPrompt, normalizeLabel, normalizeProjects, text, type Label, type Project } from "./cos-arc-model.ts";
import { cosTimeline, type TimelineSession, type TimelineValue } from "./cos-timeline.ts";
import { CONTEXT_SYSTEM, NEEDS_YOU_KINDS, contextPrompt, normalizeContext, type ArcContext, type ContextSupport, type NeedsYouKind } from "./cos-arc-context.ts";
import { askCandidates } from "./cos-arc-asks.ts";
import type { RarebitItem } from "./rarebit.ts";
import { sourceStatus, type SourceStatus, type PiView, type PiViewContext, type PiViewSession } from "./types.ts";

export type ArcChunk = Chunk & { labelCurrent: boolean; label: Label | null };
type Card = { name: string; chunks: number; resumeEntryId: string; inferred: { summary: string; status: string } | null };
type Transition = { chunk: string; from: string | null; to: string | null; kind: string; why: string | null; source: string };
/**
 * Why a Build failed. `model`: the model runner or provider failed (ask codes no_model, model_error, timeout, no_result,
 * busy). `answer`: the model answered without usable JSON or labels. `source`: the Session's derived data changed
 * or was unreadable while the Build read its snapshot. `internal`: anything else.
 */
export type ArcErrorCode = "model" | "answer" | "source" | "internal";
/** `chunks` in the start snapshot and `toLabel`, those without a reusable label, show the incremental cost. */
type Job = { state: string; done: number; total: number; chunks: number; toLabel: number; waitingFor: string | null; lastError: { message: string; code: ArcErrorCode } | null; trigger: ArcTrigger };
/** Who started a Build: the owner (the Build op) or an agent stop (`autoBuild`, D16). */
export type ArcTrigger = "manual" | "auto";
/** One finished Build as the hub ran it, kept per Session (newest last) so automatic model spend stays visible. */
export type ArcBuildRun = { trigger: ArcTrigger; startedAt: string; endedAt: string; state: "done" | "error"; calls: number; model: string | null;
	/** Summed over the calls that reported usage; `cost` is null when no call reported a price. */
	usage: { input: number; output: number; cost: number | null };
	/** The agent stop the Build followed: the Session's newest stop mark when it started. */
	afterEntryId: string | null; error?: string; errorCode?: ArcErrorCode;
	/** Chunk labels taken from the previous receipt by chunk hash; absent in older records. */
	reusedLabels?: number;
	/** Label calls repeated once for the chunks a first answer missed or failed; absent in older records. */
	retries?: number;
	/** Chunks still without a label after the retry; the Build kept the other labels and the tier-2 tree. */
	unlabelledChunks?: number;
	/** The code of the first label failure behind `unlabelledChunks`. */
	labelErrorCode?: ArcErrorCode };
export type ArcValue = {
	source: SourceStatus;
	threadId: string; title: string; ref: string; chunks: ArcChunk[]; cards: Card[]; transitions: Transition[];
	synthesis: { headline: string; model: string | null; builtAt: string | null } | null;
	coverage: { labelledChunks: number; synthesisCurrent: boolean; unmappedChunks: number; excludedEntries: number };
	/** Synthesis and the tree reread the whole Session, so input tokens fall little when labels are reused. */
	buildEstimate: { calls: number; inputTokens: number; truncatedChunks: number; lastInputTokens: number | null };
	context: ArcContext | null;
	/**
	 * `coveredAt`: the time of the newest message the tree covers, when known. `formatChanged`: another tier-2 prompt
	 * (CONTEXT_VERSION) built the tree, so its titles follow older rules until the next Build; currency is unchanged.
	 */
	contextStatus: { newMessages: number; branchChanged: boolean; coveredAt?: number | null; formatChanged?: boolean };
	job: Job | null; builds: ArcBuildRun[]; notice: string;
};
/** `labelVersion` (LABEL_VERSION) is absent in older receipts; their labels still render but are never reused. */
type Receipt = { version: 3 | 4; labelVersion?: string; sourceVersion: string; builtAt: string; labels: Record<string, Label & { hash: string }>; headline: string; projects: Project[]; transitions: Transition[]; model: string | null; context?: ArcContext };
/**
 * The persisted receipt head (<=200 bytes): enough for a list or Overview to show tier-2 availability, open asks
 * per kind, and staleness without loading any tree. `open` and `old` (oldest ask time in whole minutes since the
 * epoch, 0 when unknown) follow NEEDS_YOU_KINDS order; `fp` is a fingerprint prefix; `fin: 1`, present only when
 * true, means every thread is done and nothing is open; `ov`, present only when non-zero, counts overtaken asks. Staleness needs only `n` and `fp`; v2 drops v1's `sv`
 * (source version), which no reader used. A v1 head still reads, with unknown ask ages and not finished.
 */
type Head = { v: 1 | 2; sv?: string; at: string; n: number; fp: string; open: number[]; old?: number[]; fin?: 1; ov?: number };
/** The head as projected for one Session's current Rarebit selection. */
export type ArcHead = { built: boolean; builtAt: string | null; open: Record<NeedsYouKind, number>; oldest: Record<NeedsYouKind, number | null>; overtaken: number; finished: boolean; newMessages: number; branchChanged: boolean };
export type ArcListValue = { sessions: (Omit<TimelineSession, "entries" | "buckets" | "marks"> & { head: ArcHead })[] };
/**
 * `pending`: an agent stop with newer messages than the running Build's start (`building`, a Rarebit count) landed
 * during it; one automatic Build follows (autoBuild).
 */
type State = { receipt?: Receipt; job?: Job; building?: number; pending?: boolean };
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
	return { v: 2, at: c.builtAt, n: c.asOfRarebitCount, fp: c.rarebitFingerprint.slice(0, 16), open: asks.map((a) => a.length),
		// normalizeContext sorts each kind oldest ask first.
		old: asks.map((a) => Math.floor((a[0]?.citations[0]?.at ?? 0) / 60_000)), ...(fin ? { fin: 1 } : {}), ...(c.overtaken?.length ? { ov: c.overtaken.length } : {}) } as Head;
}

function readHead(ctx: PiViewContext, threadId: string): Head | null {
	let map = heads.get(ctx); if (!map) heads.set(ctx, map = new Map());
	if (!map.has(threadId)) {
		let head: Head | null = null;
		try { const raw = JSON.parse(readFileSync(headPathFor(ctx, threadId), "utf8")); if (raw?.v === 1 || raw?.v === 2) head = raw; } catch {}
		map.set(threadId, head);
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
	if (!head) return { built: false, builtAt: null, open, oldest, overtaken: 0, finished: false, newMessages: 0, branchChanged: false };
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
		if (st.receipt?.context && readHead(ctx, s.threadId)?.v !== 2) writeHead(ctx, s.threadId, headOf(st.receipt as Receipt & { context: ArcContext }));
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
		if (page.sourceVersion !== s.sourceVersion) throw failure("source", "The Session changed while Build arc read it.");
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

const MODEL_CODES = new Set(["no_model", "model_error", "timeout", "no_result", "busy"]);
const failure = (code: ArcErrorCode, message: string) => Object.assign(new Error(message), { code });
function errorCode(e: unknown): ArcErrorCode {
	const code = (e as { code?: string })?.code;
	return code === "answer" || code === "source" || code === "model" ? code : code && MODEL_CODES.has(code) ? "model" : "internal";
}

/** Entry IDs a context leaf may cite: Rarebit message lines of this build's evidence. */
const citable = (evidence: Map<string, string>) => [...evidence.values()].flatMap((text) => [...text.matchAll(/^\[([^\]]+)\] (?:USER|AGENT):/gm)].map((m) => m[1]!));

/**
 * The first JSON object in a model answer. Fences and text around it are ignored, and a second object that some
 * models append is dropped, so only an answer without any complete object fails.
 */
export function json(source: string): any {
	const start = source.indexOf("{");
	if (start >= 0) {
		let depth = 0, quoted = false, escaped = false;
		for (let i = start; i < source.length; i++) {
			const ch = source[i];
			if (quoted) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') quoted = false; continue; }
			if (ch === '"') quoted = true;
			else if (ch === "{") depth++;
			else if (ch === "}" && --depth === 0) {
				try { return JSON.parse(source.slice(start, i + 1)); } catch { break; }
			}
		}
	}
	throw failure("answer", "The model did not return an Arc JSON object. Try Build arc again with a JSON-capable model.");
}

/** The one currency rule (Rarebit messages): the tree and the synthesis are current when no message is newer and the branch is the same. */
function contextStatus(s: PiViewSession, context: ArcContext | undefined) {
	if (!context) return { newMessages: 0, branchChanged: false, coveredAt: null, formatChanged: false };
	const coveredAt = context.asOfEntryId ? s.entryTimes([context.asOfEntryId]).get(context.asOfEntryId) ?? null : null;
	return { ...staleness(s, context.asOfRarebitCount, context.rarebitFingerprint), coveredAt, formatChanged: context.format !== CONTEXT_VERSION };
}

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
	const { chunks } = s.data.arc, evidence = s.arcEvidence(chunks.map((c) => c.id)), items = allRarebits(s);
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
export function buildArc(ctx: PiViewContext, s: PiViewSession, args: { model?: unknown } = {}, { limit = ARC_ASK_CONCURRENCY, trigger = "manual" }: { limit?: number; trigger?: ArcTrigger } = {}) {
	const st = state(ctx, s);
	if (st.job?.state === "running") return { started: true };
	if (!s.data.arc.chunks.length) throw new Error("There are no chunks to label yet.");
	const job: Job = { state: "running", done: 0, total: 0, chunks: s.data.arc.chunks.length, toLabel: 0, waitingFor: null, lastError: null, trigger };
	const release = ctx.lease(s.threadId);
	st.job = job; st.building = s.data.rarebit.count; ctx.invalidate("cos.arc");
	const startedAt = new Date().toISOString();
	// autoBuild records its own start time.
	if (trigger === "manual") started(ctx, s.threadId, arcClock.now());
	let retries = 0, unlabelled = 0, reused = 0, afterEntryId: string | null = null, labelErrorCode: ArcErrorCode | null = null;
	const spent = { calls: 0, input: 0, output: 0, cost: null as number | null, model: null as string | null };
	// Every model call of this Build goes through `asked`, so the Build log carries its usage.
	const asked = async (req: Parameters<PiViewContext["ask"]>[0]) => {
		const answer = await askWhenFree(ctx, req);
		spent.calls++; spent.input += answer.usage?.input ?? 0; spent.output += answer.usage?.output ?? 0; spent.model = answer.model ?? spent.model;
		if (typeof answer.usage?.cost === "number") spent.cost = (spent.cost ?? 0) + answer.usage.cost;
		return answer;
	};
	void (async () => {
		try {
			// The snapshot is one store read before the first await. A store that moved past `s` gets one fresh read.
			let snap: Snapshot;
			try { snap = ctx.snapshot(() => snapshot(s)); }
			catch {
				try { snap = ctx.snapshot(() => snapshot(ctx.session(s.threadId) ?? s)); }
				catch (e) { throw errorCode(e) === "source" ? e : failure("source", (e as Error).message); }
			}
			const { chunks, evidence, sourceVersion } = snap;
			afterEntryId = snap.afterEntryId;
			const model0 = typeof args.model === "string" && args.model ? { model: args.model } : {};
			const prior = labelsByHash(st.receipt), labels: Receipt["labels"] = {}, fresh: Chunk[] = [];
			for (const c of chunks) { const l = prior.get(c.hash); if (l) labels[c.id] = l; else fresh.push(c); }
			reused = chunks.length - fresh.length;
			const batches = Array.from({ length: Math.ceil(fresh.length / LABEL_BATCH) }, (_, i) => fresh.slice(i * LABEL_BATCH, (i + 1) * LABEL_BATCH));
			Object.assign(job, { chunks: chunks.length, toLabel: fresh.length, total: batches.length + 2 }); ctx.invalidate("cos.arc");
			// One label call for `batch`: the labels it returned and the chunks it missed. A failed call misses them all.
			type Labelled = { model: string | null; labels: [string, Label & { hash: string }][]; missed: Chunk[]; error: Error | null };
			const label = async (batch: Chunk[]): Promise<Labelled> => {
				try {
					const answer = await asked({ system: LABEL_SYSTEM, prompt: labelPrompt(batch, evidence), ...model0 });
					const raw = json(answer.text), out: [string, Label & { hash: string }][] = [], missed: Chunk[] = [];
					for (const c of batch) {
						const l = normalizeLabel(Array.isArray(raw.chunks) ? raw.chunks.find((x: any) => x.chunk === c.id) : undefined, evidence.get(c.id) ?? "");
						if (l.project && l.topic) out.push([c.id, { hash: c.hash, ...l }]); else missed.push(c);
					}
					return { model: answer.model ?? null, labels: out, missed, error: missed.length ? failure("answer", `The model omitted labels for ${missed.map((c) => c.id).join(", ")}.`) : null };
				} catch (e) {
					return { model: null, labels: [], missed: batch, error: e as Error };
				}
			};
			// Label batches run concurrently; each result lands in batch order, so the receipt matches a sequential Build.
			// A batch repeats once for only its missed chunks; chunks still missed stay unlabelled and the Build goes on.
			const answers = await bounded(batches, limit, async (batch) => {
				let a = await label(batch);
				if (a.missed.length) {
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
			if (unlabelled) labelErrorCode = errorCode(labelError);
			const model = answers.reduce<string | null>((m, a) => a.model ?? m, null);
			// Synthesis and the tier-2 tree both read the labels and nothing else from each other.
			const [synth, contextAnswer] = await bounded([
				{ system: SYNTH_SYSTEM, prompt: synthPrompt(chunks, labels, snap.cwd) },
				{ system: CONTEXT_SYSTEM, prompt: contextPrompt(chunks, labels, evidence, snap.support) },
			], limit, async (req) => { const answer = await asked({ ...req, ...model0 }); json(answer.text); job.done++; ctx.invalidate("cos.arc"); return answer; });
			const synthRaw = json(synth!.text), ids = new Set(chunks.map((c) => c.id));
			const rawContext = json(contextAnswer!.text), builtAt = new Date().toISOString();
			const lastEvidence = citable(evidence).at(-1) ?? null;
			const context = { ...normalizeContext(rawContext, chunks, evidence, snap.ref, snap.times, builtAt, contextAnswer!.model ?? null, snap.rarebitCount, snap.fingerprint, lastEvidence, snap.support), format: CONTEXT_VERSION };
			const receipt: Receipt = { version: 4, labelVersion: LABEL_VERSION, sourceVersion, builtAt, labels, headline: text(synthRaw.headline, 180), model: contextAnswer!.model ?? synth!.model ?? model,
				projects: normalizeProjects(synthRaw.projects, ids),
				transitions: (Array.isArray(synthRaw.transitions) ? synthRaw.transitions : []).slice(0, 80).filter((t: any) => ids.has(t.chunk)).map((t: any) => ({ chunk: t.chunk, from: text(t.from, 90), to: text(t.to, 90), kind: ["pivot", "new_project", "return", "subtopic", "digression"].includes(t.kind) ? t.kind : "pivot", why: text(t.why, 180), source: "synthesis" })), context };
			const file = pathFor(ctx, s.threadId); writeFileSync(`${file}.tmp`, JSON.stringify(receipt), { mode: 0o600 }); renameSync(`${file}.tmp`, file);
			writeHead(ctx, s.threadId, headOf(receipt as Receipt & { context: ArcContext }));
			st.receipt = receipt; job.state = "done";
		} catch (e) { job.state = "error"; job.lastError = { message: (e as Error).message, code: errorCode(e) }; }
		finally {
			release();
			try {
				appendBuild(ctx, s.threadId, { trigger, startedAt, endedAt: new Date().toISOString(), state: job.state === "done" ? "done" : "error", calls: spent.calls, model: spent.model,
					usage: { input: spent.input, output: spent.output, cost: spent.cost }, afterEntryId, ...(job.lastError ? { error: job.lastError.message, errorCode: job.lastError.code } : {}),
					...(retries ? { retries } : {}), ...(unlabelled && job.state === "done" ? { unlabelledChunks: unlabelled, ...(labelErrorCode ? { labelErrorCode } : {}) } : {}), ...(reused ? { reusedLabels: reused } : {}) });
			} catch {}
			ctx.invalidate("cos.arc"); if (trigger === "auto") ctx.invalidate("rarebit");
			if (st.pending) followUp(ctx, s.threadId);
		}
	})();
	return { started: true };
}

/** Minimum time between automatic Builds of one Session (D16). */
export const AUTO_BUILD_INTERVAL_MS = 10 * 60_000;
/** Time and the follow-up timer of the automatic trigger; tests replace them. */
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
 * The automatic trigger (D16, owner option A). After an agent stop in a live, idle Session with new Rarebit messages
 * since the last Build, start one Build through buildArc, at most once per AUTO_BUILD_INTERVAL_MS per Session. Every
 * Build counts toward the limit, whatever its trigger or result. A stop during a running Build sets one pending flag;
 * one automatic Build follows when that Build ends and the limit allows. A Session no pane or control socket runs never
 * builds automatically. Returns whether a Build started.
 */
export function autoBuild(ctx: PiViewContext, s: PiViewSession, now = arcClock.now()): boolean {
	const t = s.summary;
	if (!t?.live || t.activity !== "idle" || t.queued > 0 || !s.data.timeline.stopped || !s.data.arc.chunks.length) return false;
	const st = states.get(ctx)?.get(s.threadId);
	if (st?.job?.state === "running") { if (s.data.rarebit.count > (st.building ?? 0)) st.pending = true; return false; }
	const head = readHead(ctx, s.threadId);
	if (head && s.data.rarebit.count <= head.n) return false;
	if (now - lastBuild(ctx, s.threadId) < AUTO_BUILD_INTERVAL_MS) return false;
	started(ctx, s.threadId, now);
	buildArc(ctx, s, {}, { trigger: "auto" });
	return true;
}

/** Clears the pending flag and runs autoBuild once the limit allows; autoBuild checks the Session again then. */
function followUp(ctx: PiViewContext, threadId: string) {
	const st = states.get(ctx)?.get(threadId);
	if (st) st.pending = false;
	arcClock.later(() => {
		const s = ctx.session(threadId);
		if (s) try { autoBuild(ctx, s); } catch (error) { console.error(`cos.arc: automatic Build of ${s.ref} failed to start:`, error); }
	}, Math.max(0, lastBuild(ctx, threadId) + AUTO_BUILD_INTERVAL_MS - arcClock.now()));
}

export const cosArc: PiView = {
	name: "cos.arc",
	evict(ctx, id) { states.get(ctx)?.delete(id); heads.get(ctx)?.delete(id); logs.get(ctx)?.delete(id); },
	changed(ctx, sessions) {
		for (const s of sessions) try { autoBuild(ctx, s); } catch (error) { console.error(`cos.arc: automatic Build of ${s.ref} failed to start:`, error); }
	},
	summarize(ctx, s) {
		const head = readHead(ctx, s.threadId);
		if (!head) return undefined;
		const h = arcHead(s, head);
		return { arc: { builtAt: h.builtAt!, stale: h.newMessages > 0 || h.branchChanged, newMessages: h.newMessages, finished: h.finished,
			asks: NEEDS_YOU_KINDS.filter((k) => h.open[k] > 0).map((kind) => ({ kind, n: h.open[kind], since: h.oldest[kind] })), ...(h.overtaken ? { overtaken: h.overtaken } : {}) } };
	},
	value(ctx, topic) {
		if (!topic.threadId) {
			const timeline = cosTimeline.value(ctx, { kind: "view", view: "cos.timeline" }) as TimelineValue;
			// A built Session stays listed so its open asks remain visible even when it is short.
			return { sessions: timeline.sessions.flatMap(({ entries, buckets, marks, ...row }) => {
				const s = ctx.session(row.threadId), head = s ? readHead(ctx, row.threadId) : null;
				if (!s || !(head || row.entryCount >= 200 || row.end - row.start >= 20 * 3600_000)) return [];
				return [{ ...row, head: arcHead(s, head) }];
			}) } satisfies ArcListValue;
		}
		const s = ctx.session(topic.threadId);
		if (!s) return { missing: true, notice: "This Session is not in the Host's local copies. Open it from the sidebar or reconnect the Host." };
		const st = state(ctx, s), receipt = st.receipt, context = receipt?.context;
		const status = contextStatus(s, context);
		const byHash = labelsByHash(receipt);
		const chunks = s.data.arc.chunks.map((c) => { const reusable = byHash.get(c.hash), label = reusable ?? receipt?.labels[c.id]; return { ...c, label: label ?? null, labelCurrent: Boolean(reusable) }; });
		const projects = new Map<string, Card>();
		for (const c of chunks) if (c.label) {
			const inferred = receipt?.projects.find((p) => [p.name, ...p.aliases].some((name) => name.toLowerCase() === c.label!.project.toLowerCase())) ?? null;
			const name = inferred?.name ?? c.label.project;
			const p = projects.get(name) ?? { name, chunks: 0, resumeEntryId: c.lastOwnerEntryId ?? c.lastEntryId, inferred };
			p.chunks++; p.resumeEntryId = c.lastOwnerEntryId ?? c.lastEntryId; projects.set(p.name, p);
		}
		const labelled = chunks.filter((c) => c.labelCurrent).length;
		const inputChars = SYNTH_SYSTEM.length + CONTEXT_SYSTEM.length + chunks.length * 300 + Math.ceil((chunks.length - labelled) / LABEL_BATCH) * LABEL_SYSTEM.length + s.data.arc.inputChars;
		return { source: sourceStatus(s), threadId: s.threadId, title: s.summary?.title ?? s.threadId, ref: s.ref, chunks, cards: [...projects.values()], transitions: receipt?.transitions.filter((t) => chunks.some((c) => c.id === t.chunk)) ?? [],
			synthesis: receipt ? { headline: receipt.headline, model: receipt.model, builtAt: receipt.builtAt ?? null } : null,
			coverage: { labelledChunks: labelled, unmappedChunks: chunks.length - labelled, synthesisCurrent: Boolean(context) && status.newMessages === 0 && !status.branchChanged, excludedEntries: s.data.arc.excludedEntries },
			buildEstimate: { calls: chunks.length ? Math.ceil((chunks.length - labelled) / LABEL_BATCH) + 2 : 0, inputTokens: Math.ceil(inputChars / 4), truncatedChunks: s.data.arc.shortenedChunks,
				lastInputTokens: buildLog(ctx, s.threadId).findLast((b) => b.state === "done")?.usage.input || null },
			context: context ?? null, contextStatus: status, job: st.job ? { ...st.job } : null, builds: buildLog(ctx, s.threadId).slice(-10),
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
