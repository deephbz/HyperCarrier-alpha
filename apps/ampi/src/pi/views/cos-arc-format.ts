// The Arc's output format: the answer shapes the prompts state, the field limits, and the normalizers that narrow
// untrusted model JSON. Prompts (cos-arc-prompts.ts) embed the shapes; the tier-2 tree's normalizer lives in
// cos-arc-context.ts. A change here changes LABEL_FORMAT or STEP2_FORMAT, so its step rebuilds.

/** Names the label shape, limits and normalizer; part of LABEL_VERSION. */
export const LABEL_FORMAT = "ampi-arc-label-format/2";
/** Names the step-2 shape, limits and normalizers (tier 1 here, tier 2 in cos-arc-context.ts); part of STEP2_VERSION. */
export const STEP2_FORMAT = "ampi-arc-step2-format/1";

/** A raw slice, for short names that never show a cut. */
export const text = (v: unknown, max: number) => typeof v === "string" ? v.trim().slice(0, max) : "";
// Model answers are untrusted JSON: readers narrow every field through these.
/** An object's fields; anything else reads as no fields. */
export const fields = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : {});
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const oneOf = <T extends string>(choices: readonly T[], v: unknown, fallback: T): T => choices.find((c) => c === v) ?? fallback;
const strings = (v: unknown, keep: (id: string) => boolean) => list(v).filter((id): id is string => typeof id === "string" && keep(id));

/**
 * The one cut rule for shown model text: at most `max` characters, cut at the last word boundary past half of `max`,
 * trailing punctuation dropped and "…" added. `full` keeps the longer text (at most 400 characters) for a hover or
 * an expand.
 */
export function title(raw: string, max: number): { text: string; full?: string } {
	const t = raw.replace(/\s+/g, " ").trim();
	if (t.length <= max) return { text: t };
	const cut = t.slice(0, max - 1), space = cut.lastIndexOf(" ");
	return { text: `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.\u2013\u2014-]+$/, "")}…`, full: t.slice(0, 400) };
}
/** `field` of `raw` cut by `title`; its full text goes to `full[name]` when cut. */
function cutField<K extends string>(raw: unknown, max: number, name: K, full: Partial<Record<K, string>>): string {
	const t = title(typeof raw === "string" ? raw : "", max);
	if (t.full) full[name] = t.full;
	return t.text;
}

/** `full` keeps a cut topic; absent when nothing was cut. */
export type Label = { project: string; topic: string; subproject: string | null; mode: string; ideas: { text: string; evidence: string[] }[]; work: { text: string; evidence: string[] }[]; outcome: string | null; full?: { topic?: string } };
/** `full` keeps a cut summary or lastState; absent when nothing was cut. */
export type Project = { name: string; aliases: string[]; summary: string; status: string; lastState: string; full?: { summary?: string; lastState?: string } };
export type Transition = { chunk: string; from: string | null; to: string | null; kind: string; why: string | null; source: string };
/** Tier 1: the whole-Session map step 2 writes beside the tier-2 tree. */
export type Tier1 = { headline: string; projects: Project[]; transitions: Transition[] };

export const LABEL_MODES = ["building", "debugging", "researching", "planning", "reviewing", "discussing", "operating"] as const;
export const TRANSITION_KINDS = ["pivot", "new_project", "return", "subtopic", "digression"] as const;
export const PROJECT_STATUSES = ["active", "paused", "done", "abandoned"] as const;

/** The label answer shape, stated in the label prompt. */
export const LABEL_SHAPE = { chunks: [{ chunk: "<chunk id>", project: "string", subproject: "string|null", topic: "string", mode: "building|debugging|researching|planning|reviewing|discussing|operating|other", ideas: [{ text: "string", evidence: ["ref"] }], work: [{ text: "string", evidence: ["ref"] }], outcome: "string|null" }] };
const LEAF_SHAPE = { text: "string", citations: ["entry-id"], quote: "verbatim words from a cited message" };
/** The step-2 answer shape: tier 1 (headline, projects, transitions) and tier 2 (asks, threads, unassigned). */
export const STEP2_SHAPE = {
	headline: "string <= 160 chars",
	projects: [{ name: "string", aliases: ["label project names merged here"], summary: "string <= 200", status: "active|paused|done|abandoned|unknown", lastState: "string <= 200" }],
	transitions: [{ chunk: "c12", kind: "pivot|new_project|return|subtopic|digression", from: "string", to: "string", why: "string <= 160" }],
	asks: [{ candidates: ["q1"], text: "string", kind: "decision|approval|input|blocker", answeredBy: "entry-id|null" }],
	threads: [{ label: "string", state: "active|paused|done|unclear", progress: [LEAF_SHAPE], decisions: [LEAF_SHAPE], blockers: [LEAF_SHAPE] }],
	unassigned: { progress: [LEAF_SHAPE], decisions: [LEAF_SHAPE], blockers: [LEAF_SHAPE] },
};

export function normalizeLabel(raw: unknown, evidence: string): Label {
	const refs = new Set([...evidence.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]!));
	const items = (v: unknown) => list(v).slice(0, 3).map(fields).map((r) => ({ text: text(r.text, 200), evidence: strings(r.evidence, (id) => refs.has(id)).slice(0, 3) })).filter((r) => r.text && r.evidence.length);
	const f = fields(raw), full: Label["full"] = {};
	const topic = cutField(f.topic, 90, "topic", full);
	return { project: text(f.project, 48), topic, subproject: text(f.subproject, 48) || null, mode: oneOf(LABEL_MODES, f.mode, "other"),
		ideas: items(f.ideas), work: items(f.work), outcome: text(f.outcome, 160) || null, ...(full.topic ? { full } : {}) };
}

export function normalizeProjects(raw: unknown, _ids: Set<string>): Project[] {
	const seen = new Set<string>();
	return list(raw).slice(0, 24).map(fields).flatMap((p) => {
		const name = text(p.name, 48); if (!name || seen.has(name.toLowerCase())) return []; seen.add(name.toLowerCase());
		const full: NonNullable<Project["full"]> = {};
		const summary = cutField(p.summary, 220, "summary", full), lastState = cutField(p.lastState, 240, "lastState", full);
		return [{ name, aliases: list(p.aliases).map((a) => text(a, 48)).filter(Boolean).slice(0, 16), summary, status: oneOf(PROJECT_STATUSES, p.status, "unknown"), lastState, ...(Object.keys(full).length ? { full } : {}) }];
	});
}

/** Tier 1 of a step-2 answer whose shape `reply` already checked: transitions cite only this Build's chunk ids. */
export function normalizeTier1(raw: { headline: string; projects: unknown[]; transitions: unknown[] }, ids: Set<string>): Tier1 {
	return { headline: text(raw.headline, 180), projects: normalizeProjects(raw.projects, ids),
		transitions: raw.transitions.slice(0, 80).map(fields).flatMap((t) => typeof t.chunk === "string" && ids.has(t.chunk) ? [{ chunk: t.chunk, from: text(t.from, 90), to: text(t.to, 90), kind: oneOf(TRANSITION_KINDS, t.kind, "pivot"), why: text(t.why, 180), source: "synthesis" }] : []) };
}
