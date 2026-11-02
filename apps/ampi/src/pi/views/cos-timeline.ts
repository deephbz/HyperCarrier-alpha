// Timeline renders ingestion-time aggregates. Exact navigation is an indexed query;
// Host-wide subscriptions carry at most 64 citation hints per Session.
import type { TimelineSession, TimelineValue } from "../../shared/timeline.ts";
import { sourceStatus, type PiView, type PiViewContext } from "./types.ts";

const BUCKET_MS = 15 * 60_000;

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
