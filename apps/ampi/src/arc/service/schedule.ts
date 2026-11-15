// Automatic source triggers retain the shipped Rarebit gate, debounce and
// per-Session cadence. The Builder owns admission, failure backoff and manual work.
import type { Builder, SourceSnapshot } from "../core/index.ts";
export const ARC_FLOOR = 4, DEBOUNCE_MS = 20_000, AUTO_INTERVAL_MS = 300_000;
type Trigger = { fingerprint: string; trigger: "owner" | "stop"; at: number };
export type ScheduleState = Record<string, { seen?: string; cursor?: string; lastAuto?: number; pending?: Trigger }>;
export function automaticSchedule(options: { builder: Builder; state: ScheduleState; save(state: ScheduleState): void; now?: () => number }) {
 const { builder, state, save } = options, now = options.now ?? Date.now;
 Object.setPrototypeOf(state, null);
 return {
  observe(snapshot: SourceSnapshot, enabled: boolean) {
   const trigger = snapshot.items.findLast(item => item.owner || item.kind === "stop");
   if (!trigger) return;
   const prior = state[snapshot.session] ??= {};
   if (prior.seen === trigger.id) return;
   prior.seen = trigger.id;
   if (enabled && snapshot.items.length >= ARC_FLOOR && prior.cursor !== snapshot.fingerprint) {
    prior.pending = { fingerprint: snapshot.fingerprint, trigger: trigger.owner ? "owner" : "stop", at: Math.max(now() + DEBOUNCE_MS, (prior.lastAuto ?? -Infinity) + AUTO_INTERVAL_MS) };
   }
   save(state);
  },
  async tick(enabled: boolean) {
   const statuses = new Map(builder.status().map(s => [s.sessionRef, s]));
   const receipts = new Map(builder.receipts().map(r => [r.sessionRef, r.receipt]));
   for (const [session, schedule] of Object.entries(state)) {
    if (!schedule.pending) continue;
    if (!enabled) { delete schedule.pending; save(state); continue; }
    const status = statuses.get(session);
    if (status?.state === "idle" && receipts.get(session)?.fingerprint === schedule.pending.fingerprint) {
     schedule.cursor = schedule.pending.fingerprint; delete schedule.pending; save(state); continue;
    }
    if (["building", "queued", "waiting"].includes(status?.state ?? "")) continue;
    if (now() < Math.max(schedule.pending.at, Date.parse(status?.nextAt ?? "") || 0)) continue;
    const pending = schedule.pending;
    const result = await builder.request(session, `auto:${session}:${pending.fingerprint}`, "incremental", "source", { trigger: pending.trigger });
    if (result.outcome === "accepted" || result.code === "paused") {
     schedule.cursor = pending.fingerprint;
     if (result.outcome === "accepted") schedule.lastAuto = now();
     // A newer observation during the source read keeps its own obligation.
     if (schedule.pending === pending) delete schedule.pending;
     save(state);
    }
   }
  },
  pending() { return Object.entries(state).flatMap(([sessionRef, value]) => value.pending ? [{ sessionRef, nextAt: new Date(value.pending.at).toISOString(), trigger: value.pending.trigger }] : []); },
 };
}
