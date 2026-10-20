import type { Chunk } from "./cos-arc-chunks.ts";
import { fields, list, oneOf, title } from "./cos-arc-format.ts";
import { normalizeText, type AskCandidate } from "./cos-arc-asks.ts";

/** One cited Rarebit entry. `session` is the host-qualified Session ref (K5.I3), so a citation never resolves in another Session. */
export type Citation = { session: string; entryId: string; chunkHash: string; at: number | null };
/**
 * `text` is a short title (TITLE_LIMITS); `full` keeps the longer text it was cut from, shown on expand. `quote` is
 * verbatim text of a cited message that supports the leaf (absent in receipts built before quotes). `ask` marks an
 * owner ask from the Needs-you candidates. `closed` says why a closed ask closed, and `resolvedBy` cites the owner turn
 * that closed it (empty when that turn is outside the build evidence). Receipts built before `closed` mark an answered
 * ask only by a non-empty `resolvedBy`.
 */
export type ContextLeaf = { text: string; full?: string; citations: Citation[]; quote?: string; ask: boolean; kind: NeedsYouKind | null; resolvedBy: Citation[]; closed?: AskClosed };
/** An answered ask has an owner turn that answers it; an overtaken ask has a later owner turn that moved the Session on. */
export type AskClosed = "answered" | "overtaken";
/** What an open ask needs from the owner. The single authority for Needs you kinds (receipt head counts, Overview). */
export const NEEDS_YOU_KINDS = ["decision", "approval", "input", "blocker"] as const;
export type NeedsYouKind = (typeof NEEDS_YOU_KINDS)[number];
export const THREAD_STATES = ["active", "paused", "done", "unclear"] as const;
/** `label` names the object of the work (TITLE_LIMITS.thread) without its state; `full` keeps a longer label. */
export type ContextThread = {
	label: string;
	full?: string;
	state: (typeof THREAD_STATES)[number];
	progress: ContextLeaf[];
	decisions: ContextLeaf[];
	blockers: ContextLeaf[];
};
export type ArcContext = {
	asOfEntryId: string | null;
	asOfRarebitCount: number;
	rarebitFingerprint: string;
	/** Open asks, one per ask, grouped by kind and oldest first; never truncated. */
	needsYou: ContextLeaf[];
	/** Asks whose answering owner turn the model cited, newest first (at most ANSWERED_KEPT); absent in older receipts. */
	answered?: ContextLeaf[];
	/** Unanswered asks that a later owner turn moved past, newest first (at most ANSWERED_KEPT); absent in older receipts. */
	overtaken?: ContextLeaf[];
	threads: ContextThread[];
	unassigned: { progress: ContextLeaf[]; decisions: ContextLeaf[]; blockers: ContextLeaf[] };
	coverage: { evidenceEntries: number; citedEntries: number; omittedEntries: number };
	builtAt: string;
	model: string | null;
	/** STEP2_VERSION (cos-arc.ts; CONTEXT_VERSION before receipt v5) of the prompt that built this tree; absent in trees built before short titles. */
	format?: string;
};

/**
 * A tree with no work thread, no open ask and no unassigned leaf. Every Build has chunks, so a Build never stores
 * such a tree, and a stored one is not a valid Arc. The one rule for the Build, the receipt head and the view.
 */
export const emptyTree = (c: Pick<ArcContext, "threads" | "needsYou" | "unassigned">) =>
	!c.threads.length && !c.needsYou.length && !Object.values(c.unassigned).some((l) => l.length);

/** Threads, leaves (under threads and unassigned) and asks: of a raw context answer, or of a normalized tree. */
export type TreeCount = { threads: number; leaves: number; asks: number };
const LEAF_KINDS = ["progress", "decisions", "blockers"] as const;
export function rawTreeCount(answer: unknown): TreeCount {
	const raw = fields(answer), threads = list(raw.threads).map(fields), loose = fields(raw.unassigned);
	return { threads: threads.length, asks: list(raw.asks).length,
		leaves: [...threads, loose].reduce((n, t) => n + LEAF_KINDS.reduce((m, k) => m + list(t[k]).length, 0), 0) };
}
export function treeCount(c: ArcContext): TreeCount {
	return { threads: c.threads.length, asks: c.needsYou.length,
		leaves: [...c.threads, c.unassigned].reduce((n, t) => n + LEAF_KINDS.reduce((m, k) => m + t[k].length, 0), 0) };
}

/** Title lengths in characters: an ask is an imperative, a thread label names the work, a leaf is one line. */
export const TITLE_LIMITS = { ask: 60, thread: 40, leaf: 90 } as const;

const STATE_WORDS = "active|paused|done|unclear|in progress|completed|finished|blocked";
/** A thread label without a state the model wrote into it ("Done: X", "X (active)", "X — paused"); the state is a badge. */
export function threadLabel(raw: string): string {
	return raw.trim()
		.replace(new RegExp(`^(?:[\\[(](?:${STATE_WORDS})[\\])]\\s*[:\u2013\u2014|·-]?|(?:${STATE_WORDS})\\s*[:\u2013\u2014|·-])\\s*`, "i"), "")
		.replace(new RegExp(`\\s*(?:[\u2013\u2014|·:,-]\\s*|[\\[(])(?:${STATE_WORDS})[\\])]?\\s*$`, "i"), "")
		.trim();
}

/** A decision leaf starts with "Decided:"; "Decision:" and "Decided to" become that prefix. */
function decided(text: string): string {
	const rest = text.replace(/^(?:decided|decision)\b\s*(?:to\b|:)?\s*/i, "");
	return `Decided: ${rest}`;
}
export const ANSWERED_KEPT = 20;

/** What the tier-2 call needs besides chunks: full message texts for quote checks, Needs-you candidates and owner turns. */
export type ContextSupport = { texts: Map<string, string>; candidates: AskCandidate[]; owners: Map<string, number> };

/**
 * Keeps only leaves whose citations lie in this Session's exact build evidence and whose quote appears verbatim
 * (ignoring case, whitespace and emphasis) in a cited message. Needs you comes from the candidates alone: the model
 * groups them and may cite an answering owner turn after the latest statement; every other candidate stays open.
 * Needs you is never truncated.
 */
export function normalizeContext(answer: unknown, chunks: Chunk[], evidence: Map<string, string>, session: string, times: Map<string, number | null>, builtAt: string, model: string | null, asOfRarebitCount: number, rarebitFingerprint: string, asOfEntryId: string | null, support: ContextSupport): ArcContext {
	const raw = fields(answer);
	const refs = new Map<string, string>(), lines = new Map<string, string>();
	for (const chunk of chunks) {
		const source = evidence.get(chunk.id) ?? "";
		for (const match of source.matchAll(/^\[([^\]]+)\] (?:USER|AGENT): (.*)$/gm)) { refs.set(match[1]!, chunk.hash); lines.set(match[1]!, match[2]!); }
	}
	const cite = (value: unknown, max: number): Citation[] => (Array.isArray(value) ? [...new Set(value)] : [])
		.filter((id): id is string => typeof id === "string" && refs.has(id)).slice(0, max)
		.map((entryId) => ({ session, entryId, chunkHash: refs.get(entryId)!, at: times.get(entryId) ?? null }));
	// A quote supports a leaf when a cited message contains it; evidence lines stand in for texts the hub did not supply.
	const supported = (quote: string, citations: Citation[]) => {
		const q = normalizeText(quote.replace(/…$/, ""));
		return q.length >= 3 && citations.some((c) => normalizeText(support.texts.get(c.entryId) ?? lines.get(c.entryId) ?? "").includes(q));
	};
	const leaf = (value: unknown, decision: boolean): ContextLeaf | null => {
		const f = fields(value);
		const raw = typeof f.text === "string" ? f.text.trim() : "";
		const quote = typeof f.quote === "string" ? f.quote.trim().slice(0, 300) : "";
		const citations = cite(f.citations, 4);
		if (!raw || !citations.length || !supported(quote, citations)) return null;
		return { ...title(decision ? decided(raw) : raw, TITLE_LIMITS.leaf), citations, quote, ask: false, kind: null, resolvedBy: [] };
	};
	const leaves = (value: unknown, max: number, decision = false) => list(value).map((v) => leaf(v, decision)).filter((v): v is ContextLeaf => Boolean(v)).slice(0, max);
	const { needsYou, answered, overtaken } = asks(raw.asks, support, refs, cite);
	const threads: ContextThread[] = list(raw.threads).slice(0, 8).map(fields).flatMap((thread) => {
		const named = title(typeof thread.label === "string" ? threadLabel(thread.label) : "", TITLE_LIMITS.thread);
		if (!named.text) return [];
		return [{ label: named.text, ...(named.full ? { full: named.full } : {}), state: oneOf(THREAD_STATES, thread.state, "unclear"), progress: leaves(thread.progress, 3), decisions: leaves(thread.decisions, 3, true), blockers: leaves(thread.blockers, 3) }];
	});
	const loose = fields(raw.unassigned);
	const unassigned = { progress: leaves(loose.progress, 8), decisions: leaves(loose.decisions, 8, true), blockers: leaves(loose.blockers, 8) };
	// Keep owner decisions ahead of newer progress when the display folds overflow.
	threads.sort((a, b) => Number(b.decisions.length > 0) - Number(a.decisions.length > 0));
	const all = [...needsYou, ...answered, ...overtaken, ...threads.flatMap((t) => [...t.decisions, ...t.blockers, ...t.progress]), ...unassigned.progress, ...unassigned.decisions, ...unassigned.blockers];
	const citedEntries = new Set(all.flatMap((item) => [...item.citations, ...item.resolvedBy].map((citation) => citation.entryId))).size;
	const evidenceEntries = refs.size;
	return { asOfEntryId, asOfRarebitCount, rarebitFingerprint, needsYou, answered, overtaken, threads, unassigned,
		coverage: { evidenceEntries, citedEntries, omittedEntries: Math.max(0, evidenceEntries - citedEntries) }, builtAt, model };
}

/**
 * One leaf per ask. The model's groups claim candidates first come, first served; a candidate no group claims becomes
 * its own open ask. A leaf cites the latest statement among its candidates and quotes it. Only owner turns after that
 * statement can close the ask: it is answered when its `answeredBy` is one of them, otherwise overtaken by the first
 * of them. An agent restatement after those turns moves the latest statement, so the ask is open again. Open asks with
 * the same gist merge.
 */
function asks(value: unknown, support: ContextSupport, refs: Map<string, string>, cite: (value: unknown, max: number) => Citation[]) {
	const known = new Map(support.candidates.filter((c) => refs.has(c.entryId)).map((c) => [c.id, c]));
	const claimed = new Set<string>();
	const groups: { members: AskCandidate[]; text: string; kind: unknown; answeredBy: unknown }[] = [];
	for (const g of list(value).map(fields)) {
		const members = list(g.candidates).filter((id): id is string => typeof id === "string" && known.has(id) && !claimed.has(id)).map((id) => known.get(id)!);
		if (!members.length) continue;
		for (const m of members) claimed.add(m.id);
		groups.push({ members, text: typeof g.text === "string" ? g.text.trim() : "", kind: g.kind, answeredBy: g.answeredBy });
	}
	for (const c of known.values()) if (!claimed.has(c.id)) groups.push({ members: [c], text: "", kind: null, answeredBy: null });
	const owners = [...support.owners].sort((a, b) => a[1] - b[1]);
	const needsYou: ContextLeaf[] = [], gists = new Map<string, ContextLeaf>();
	const closed: Record<AskClosed, (ContextLeaf & { position: number })[]> = { answered: [], overtaken: [] };
	for (const g of groups) {
		const latest = g.members.reduce((a, b) => (b.position > a.position ? b : a));
		const answered = typeof g.answeredBy === "string" && (support.owners.get(g.answeredBy) ?? -1) > latest.position;
		const next = owners.find(([, at]) => at > latest.position)?.[0];
		const named = title(g.text || latest.text.replace(/[*_`]/g, "").replace(/^(\d+\.|-)\s+/, ""), TITLE_LIMITS.ask);
		const text = named.full ?? named.text;
		const l: ContextLeaf = { ...named, citations: cite([latest.entryId], 1), quote: latest.text.slice(0, 300), ask: true, kind: NEEDS_YOU_KINDS.includes(g.kind as NeedsYouKind) ? g.kind as NeedsYouKind : "decision", resolvedBy: [] };
		if (answered) { closed.answered.push({ ...l, closed: "answered", resolvedBy: cite([g.answeredBy], 1), position: latest.position }); continue; }
		if (next) { closed.overtaken.push({ ...l, closed: "overtaken", resolvedBy: cite([next], 1), position: latest.position }); continue; }
		const same = gists.get(normalizeText(text));
		if (same) { if ((l.citations[0]!.at ?? 0) > (same.citations[0]!.at ?? 0)) Object.assign(same, { citations: l.citations, quote: l.quote }); continue; }
		gists.set(normalizeText(text), l); needsYou.push(l);
	}
	// Group open asks by kind, oldest ask first; the citation dates the ask.
	const askAt = (l: ContextLeaf) => l.citations[0]?.at ?? Number.MAX_SAFE_INTEGER;
	needsYou.sort((a, b) => NEEDS_YOU_KINDS.indexOf(a.kind!) - NEEDS_YOU_KINDS.indexOf(b.kind!) || askAt(a) - askAt(b));
	const newest = (list: (ContextLeaf & { position: number })[]) => list.sort((a, b) => b.position - a.position).slice(0, ANSWERED_KEPT).map(({ position: _, ...l }) => l);
	return { needsYou, answered: newest(closed.answered), overtaken: newest(closed.overtaken) };
}
