// Arc is a disposable, cited reading aid for one Session. It owns no work or execution state.
export type Cite = { id: string; quote: string };
export type Claim = { text: string; cites: Cite[] };
export type Bullet = Claim & { children?: Bullet[] };
export type ChapterSummary = { scope: Claim; bullets: Bullet[] };
export type AnswerChapter = { firstId: string; label: string; closed: boolean; summary: ChapterSummary };
export const STATES = { request: ["open", "in progress", "blocked", "done", "dropped"], rule: ["in force", "lifted"], decision: ["confirm", "accepted", "reversed"], confusion: ["open", "resolved"] } as const;
export type AnswerPoint = { id?: string; kind: keyof typeof STATES; state: string; by: "owner" | "agent"; waits?: "owner" | "agent"; title: string; text: string; cites: Cite[] };
export type ArcAnswer = { goal: Claim; now: Claim; chapters: AnswerChapter[]; points: AnswerPoint[] };
export type Chapter = AnswerChapter & { n: number; firstAt: string; lastId: string; lastAt: string; tokens: number; cost: number };
export type Point = AnswerPoint & { id: string; chapter: number; firstAt: string; stateAt: string; needsYou: boolean };
export type BuildRecord = { trigger: "stop" | "owner" | "manual" | "rebuild"; startedAt: string; endedAt: string; state: "done" | "failed"; calls: number; windows: number; model: string; usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number | null }; repairs: string[]; newChapters?: number[]; timing?: { queueMs: number; evidenceMs: number; modelMs: number; storeMs: number }; callUsage?: { usage: BuildRecord["usage"] | null; ms: number; failed: boolean }[]; error?: { code: "model" | "answer" | "source" | "settings" | "internal" | "busy"; message: string } };
// `kept` lists "goal", "now" and point IDs that a Build could not update; they keep their previous version until updated.
export type ArcReceipt = { v: 1; session: string; asOf: string; asOfCount: number; fingerprint: string; builtAt: string; model: string; promptVersion: string; tier: "b"; selector: string; goal: Claim; now: Claim; chapters: Chapter[]; points: Point[]; nextPointId: number; builds: BuildRecord[]; kept?: string[] };
export type UsageSeries = { bucketMs: number; start: number; end: number; buckets: [number, number, number][]; priced: boolean };
// The whole job of a running Build: Rarebit positions this window reads (1-based), its part of the estimated parts,
// and its answer try. `reason` is why the previous try was rejected. `parts` is an estimate and never below `part`.
export type ArcWork = { from: number; to: number; total: number; part: number; parts: number; attempt: number; attempts: number; reason?: string; startedAt: string };
export type ArcValue = { receipt?: ArcReceipt; sourceCount?: number; stale: number; branchChanged: boolean; status: { state: "idle" | "queued" | "building" | "failed"; nextAt?: string; progress?: string; work?: ArcWork; error?: BuildRecord["error"] }; series?: UsageSeries; lastStopAt?: string };
export function needsYou(p: AnswerPoint): boolean {
 return p.kind === "decision" ? p.state === "confirm" : p.waits === "owner" && (p.kind === "request" && (p.state === "open" || p.state === "in progress" || p.state === "blocked") || p.kind === "confusion" && p.state === "open");
}
