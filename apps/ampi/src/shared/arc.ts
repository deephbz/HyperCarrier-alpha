// Arc is a disposable, cited reading aid for one Session. It owns no work or execution state.
export type Cite = { id: string; quote: string };
export type Claim = { text: string; cites: Cite[] };
export type Bullet = Claim & { children?: Bullet[] };
export type ChapterSummary = { scope: Claim; bullets: Bullet[] };
export type AnswerChapter = { firstId: string; label: string; closed: boolean; summary: ChapterSummary };
export const STATES = { request: ["open", "in progress", "blocked", "done", "dropped"], rule: ["in force", "lifted"], decision: ["confirm", "accepted", "reversed"], confusion: ["open", "resolved"] } as const;
export type AnswerPoint = { id?: string; kind: keyof typeof STATES; state: string; by: "owner" | "agent"; waits?: "owner" | "agent"; title: string; text: string; cites: Cite[] };
export type ArcAnswer = { goal: Claim; now: Claim; chapters: AnswerChapter[]; points: AnswerPoint[] };
export type Chapter = AnswerChapter & { n: number; firstAt: string | null; lastId: string; lastAt: string | null; tokens: number; cost: number };
export type Point = AnswerPoint & { id: string; chapter: number; firstAt: string; stateAt: string; needsYou: boolean };
export type PointDrop = { id: string; title: string; reason: string; kind: keyof typeof STATES | "unknown"; needsYou: boolean; retryable?: boolean; from: string; to: string; fromPosition: number; toPosition: number };
export type BuildRecord = { buildId?: string; requester?: string; possibleRepeatCost?: boolean; retryOf?: string; engineChanges?: { from: string; to: string; afterCount: number }[]; windowCheckpoints?: { asOf: string; count: number; sourceVersion: string; engineVersion: string; promptVersion: string; model: string; usage: BuildRecord["usage"] }[]; reason?: string; drops?: PointDrop[]; rejectedAttempts?: { window: number; attempt: number; reason: string; drops: PointDrop[] }[]; trigger: "stop" | "owner" | "manual" | "rebuild"; startedAt: string; endedAt: string; state: "done" | "failed"; calls: number; windows: number; model: string; usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number | null }; repairs: string[]; newChapters?: number[]; timing?: { queueMs: number; evidenceMs: number; modelMs: number; storeMs: number }; callUsage?: { usage: BuildRecord["usage"] | null; ms: number; failed: boolean }[]; error?: { code: "model" | "model-mismatch" | "sign-in" | "quota" | "answer" | "source" | "settings" | "internal"; message: string } };
// `kept` lists "goal", "now" and point IDs that a Build could not update; they keep their previous version until updated.
export type ArcReceipt = { v: 1; session: string; asOf: string; asOfCount: number; fingerprint: string; builtAt: string; model: string; promptVersion: string; tier: "b"; selector: string; goal: Claim; now: Claim; chapters: Chapter[]; points: Point[]; nextPointId: number; builds: BuildRecord[]; kept?: string[]; drops?: PointDrop[]; dismissedDrops?: { id: string; toPosition: number }[] };
export type UsageSeries = { bucketMs: number; start: number; end: number; buckets: [number, number, number][]; priced: boolean };
// The whole job of a running Build: Rarebit positions this window reads (1-based), its part of the estimated parts,
// and its answer try. `reason` is why the previous try was rejected. `parts` is an estimate and never below `part`.
export type ArcWork = { from: number; to: number; total: number; part: number; parts: number; attempt: number; attempts: number; reason?: string; startedAt: string };
export type WaitFacts = { reason: "capacity" | "unavailable"; running: number; limit: number; scope: string; byHost?: Record<string, number> };
export type BuildStatus = { sessionRef: string; buildId: string; state: "queued" | "waiting" | "building" | "idle" | "uncertain" | "failed"; startedAt?: string; nextAt?: string; waitingSince?: string; progress?: string; work?: ArcWork; wait?: WaitFacts; pause?: "uncertain-call"; waitCause?: "capacity" | "admission-unavailable" | "source-unavailable" | "survivor"; detail?: string; elapsedMs?: number; observedAt?: string; record?: BuildRecord };
export type Refusal = { outcome: "refused"; code: "paused" | "settings" | "source" | "id-conflict" | "invalid" | "service"; transient?: true; detail?: string };
export type RequestResult = { outcome: "accepted"; buildId: string } | Refusal;
export type DismissResult = { outcome: "dismissed"; revision: number } | Refusal;
// Transport owns unknown acceptance and must resend the same request ID and payload.
export type RequestOutcome = RequestResult | { outcome: "unknown"; requestId: string; waitFor?: "service" } | { outcome: "not-sent"; detail?: string };
export type ArcService = { host: string; text?: string; version?: string } & (
 | { state: "running" | "updating" | "stopped" | "stopping" | "fault" | "busy" | "error" | "not-configured" }
 | { state: "cannot-start"; prerequisite: string }
 | { state: "no-sign-in"; model: string; path: string }
 | { state: "invalid-settings"; path: string; key: string }
 | { state: "unreachable"; since: string }
);
// Status facts come from the Builder. Receipt reads never require a live Host.
// The browser starts elapsed interpolation when it receives a status snapshot.
// Request facts describe owner presses only; automatic triggers use status.
export type ArcRequest = RequestOutcome & { requestId: string };
export type ArcWait = Omit<NonNullable<BuildStatus["wait"]>, "byHost"> & { byHost?: { host: string; running: NonNullable<NonNullable<BuildStatus["wait"]>["byHost"]>[string] }[] };
export type ArcValue = { receipt?: ArcReceipt; sourceCount?: number; stale: number; branchChanged: boolean; status: Partial<Omit<BuildStatus, "state" | "wait">> & { state: BuildStatus["state"]; wait?: ArcWait; error?: BuildRecord["error"] }; request?: ArcRequest; canDismiss?: boolean; v2Removed?: boolean; services?: ArcService[]; builderHost?: string; statusStale?: boolean; series?: UsageSeries; lastStopAt?: string };
export function needsYou(p: AnswerPoint): boolean {
 return p.kind === "decision" ? p.state === "confirm" : p.waits === "owner" && (p.kind === "request" && (p.state === "open" || p.state === "in progress" || p.state === "blocked") || p.kind === "confusion" && p.state === "open");
}
