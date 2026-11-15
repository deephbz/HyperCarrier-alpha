// Arc reads use the hub replica. The resident Host service alone constructs,
// schedules and dismisses. Transcript lag never hides a received receipt.
import type { ArcValue } from "../../shared/arc.ts";
import type { PiView, PiViewContext, PiViewSession } from "./types.ts";
export function arcValue(ctx: PiViewContext, session: PiViewSession): ArcValue {
 const value = ctx.arc?.value(session.threadId) ?? { status: { state: "idle" as const }, statusStale: true };
 const r = value.receipt, data = session.data;
 const sameSelection = !r || r.selector === data.rarebit.selector && r.tier === "b";
 // A remote receipt can lead the local source. Fewer copied items do not prove
 // a branch change, and an unreachable Host provides no newer-message count.
 const caughtUp = !r || data.rarebit.count >= r.asOfCount;
 const comparable = sameSelection && caughtUp && !value.statusStale;
 return { ...value, ...(comparable ? { sourceCount: data.rarebit.count } : {}),
  stale: comparable ? Math.max(0, data.rarebit.count - (r?.asOfCount ?? 0)) : 0,
  branchChanged: Boolean(r && caughtUp && (!sameSelection || r.asOfCount === data.rarebit.count && r.fingerprint !== data.rarebit.fingerprint)),
  lastStopAt: data.rarebit.lastStopAt,
  series: { bucketMs: 900_000, start: data.timeline.start, end: data.timeline.end, buckets: data.timeline.buckets, priced: data.timeline.priced },
 };
}
export const arcView: PiView<"arc"> = {
 name: "arc",
 value(ctx, topic) {
  const session = ctx.session(topic.threadId);
  if (session) return arcValue(ctx, session);
  const value = ctx.arc?.value(topic.threadId);
  return value?.receipt ? { ...value, stale: 0, branchChanged: false } : undefined;
 },
 summarize(ctx, session) {
  const head = ctx.arc?.head(session.threadId); if (!head) return undefined;
  const data = session.data.rarebit;
  return { arc: { needsYou: head.needsYou, ...(head.oldestAt ? { oldestAt: head.oldestAt } : {}), stale: Math.max(0, data.count - head.asOfCount) } };
 },
 ops: {
  async build(ctx, args) {
   return ctx.arc ? ctx.arc.build(args.threadId, args.requestId, args.rebuild) : { outcome: "not-sent" };
  },
  async dismiss(ctx, args) {
   return ctx.arc ? ctx.arc.dismiss(args.threadId, args.dropId, args.toPosition) : { outcome: "refused", code: "source", detail: "The Arc service is not connected. The warning was not dismissed." };
  },
 },
};
