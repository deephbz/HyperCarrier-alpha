// Timeline renders ingestion-time aggregates. Exact navigation is an indexed query;
// Host-wide subscriptions carry at most 64 citation hints per Session.
import { sourceStatus, type SourceStatus, type PiView, type PiViewContext } from "./types.ts";

export const BUCKET_MS = 15 * 60_000;
export type TimelineSession = {
 source: SourceStatus;
 threadId: string; ref: string; title: string; cwd: string; team?: string; role?: string;
 start: number; end: number; live: boolean; waiting: boolean; blocked: boolean;
 /** Rarebit messages, the count the Arc floor (arcFloor) reads. */
 messages: number;
 marks: [number, string, "stop" | "error"][]; buckets: [number, number, number][];
 /** Whether any entry reported a price; the buckets count history entries (spend.ts HISTORY_COVERS). */
 priced: boolean;
 entries: [number, string][]; entryCount: number; omittedHints: number; omittedMarks: number;
};
export type TimelineValue = { bucketMs: number; sessions: TimelineSession[]; unreadable?: { threadId: string; ref: string; title: string; message: string }[] };
export const entryTime = (t: unknown): number => typeof t === "number" ? t : typeof t === "string" ? Date.parse(t) : NaN;

export const cosTimeline: PiView<"cos.timeline"> = {
 name: "cos.timeline", scope: "any",
 value: timeline,
 ops: { async locate(ctx, args) {
  const s = ctx.session(String(args.threadId));
  if (!s) throw new Error("Session is outside the retained scope; use the Session reader for older history");
  return { entry: s.nearest(Number(args.at)), ref: s.ref };
 } },
};

/** Every Session in the Host's retained scope, as ingestion-time aggregates. */
export function timeline(ctx: PiViewContext): TimelineValue {
 const unreadable: NonNullable<TimelineValue["unreadable"]> = [];
 const sessions = ctx.sessions().flatMap((s): TimelineSession[] => {
  if (s.data.invalidLines) {
   unreadable.push({ threadId: s.threadId, ref: s.ref, title: s.summary?.title ?? s.threadId, message: "The local Session copy contains unreadable lines" });
   return [];
  }
  const summary = s.summary, { stopped, ...data } = s.data.timeline;
  const blocked = Boolean(summary?.attention?.some((a) => a.source === "Herdr" && a.reason === "needs input"));
  return [{ source: sourceStatus(s), threadId: s.threadId, ref: s.ref, title: summary?.title ?? s.threadId, cwd: summary?.cwd ?? "", live: Boolean(summary?.live), blocked, messages: s.data.rarebit.count,
   waiting: blocked || (stopped && Boolean(summary?.live) && (summary?.activity ?? "idle") === "idle"),
   ...(summary?.team ? { team: summary.team.teamId, role: summary.team.role } : {}), ...data }];
 });
 return { bucketMs: BUCKET_MS, sessions, ...(unreadable.length ? { unreadable } : {}) };
}
