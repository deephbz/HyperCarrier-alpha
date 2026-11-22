// Automatic triggers retain the Rarebit gate, debounce and per-Session cadence.
// Exact source evidence governs admission; repair deferrals create no Build state.
import { createHash } from "node:crypto";
import type { Builder, SourcePort, SourceSnapshot } from "../core/index.ts";
export const ARC_FLOOR = 4, DEBOUNCE_MS = 20_000, AUTO_INTERVAL_MS = 300_000;
type Trigger = { fingerprint: string; trigger: "owner" | "stop"; at: number; retryKey?: string };
export type ScheduleState = Record<string, { seen?: string; cursor?: string; lastAuto?: number; pending?: Trigger; assuranceRetryAt?: number; retryCursor?: string }>;
export function automaticSchedule(options: { builder: Builder; source: Pick<SourcePort, "snapshot">; state: ScheduleState; save(state: ScheduleState): void; now?: () => number }) {
 const { builder, source, state, save } = options, now = options.now ?? Date.now;
 Object.setPrototypeOf(state, null);
 const witnessId = (proof: string) => createHash("sha256").update(proof).digest("hex");
 async function admit(session: string, schedule: ScheduleState[string]) {
  const pending = schedule.pending!;
  for (let attempt = 0; attempt < 2; attempt++) {
   let snapshot: SourceSnapshot;
   try { snapshot = await source.snapshot(session, { deferRepair: true }); }
   catch (error) {
    if ((error as { code?: string }).code === "source-repair-pending") return;
    continue;
   }
    const trigger = snapshot.items.findLast(item => item.owner || item.kind === "stop");
    const covered = builder.status().find(status => status.sessionRef === session)?.state === "idle"
     && builder.receipts().some(value => value.sessionRef === session && value.receipt.fingerprint === snapshot.fingerprint && value.receipt.selector === snapshot.selector);
    if (!trigger || snapshot.items.length < ARC_FLOOR || covered || !pending.retryKey && schedule.cursor === snapshot.fingerprint) {
     if (schedule.pending === pending) delete schedule.pending;
     if (covered) schedule.cursor = snapshot.fingerprint;
     if (pending.retryKey) schedule.retryCursor = pending.retryKey;
     delete schedule.assuranceRetryAt; save(state); return;
    }
    if (!snapshot.prefixWitness) continue;
    const basis = pending.retryKey ?? `auto:${session}:${snapshot.fingerprint}`;
    const result = await builder.request(session, `${basis}:${witnessId(snapshot.prefixWitness)}`, "incremental", "source", { trigger: trigger.owner ? "owner" : "stop", expectedPrefix: snapshot.prefixWitness });
    if (result.outcome === "accepted" || result.code === "paused") {
     schedule.cursor = snapshot.fingerprint;
     if (result.outcome === "accepted") schedule.lastAuto = now();
     if (pending.retryKey) schedule.retryCursor = pending.retryKey;
     if (schedule.pending === pending) delete schedule.pending;
     delete schedule.assuranceRetryAt; save(state); return;
    }
    if (result.code !== "source" || result.transient) return;
  }
  // Observations can update the target but cannot move this assurance deadline.
  schedule.assuranceRetryAt = now() + DEBOUNCE_MS;
  if (schedule.pending) schedule.pending.at = Math.max(schedule.assuranceRetryAt, (schedule.lastAuto ?? -Infinity) + AUTO_INTERVAL_MS);
  save(state);
 }
 return {
  observe(snapshot: SourceSnapshot, enabled: boolean) {
   const trigger = snapshot.items.findLast(item => item.owner || item.kind === "stop");
   if (!trigger) return;
   const prior = state[snapshot.session] ??= {};
   if (prior.seen === trigger.id) return;
   prior.seen = trigger.id;
   if (enabled && snapshot.items.length >= ARC_FLOOR && prior.cursor !== snapshot.fingerprint) {
    prior.pending = { fingerprint: snapshot.fingerprint, trigger: trigger.owner ? "owner" : "stop",
     at: prior.assuranceRetryAt !== undefined ? prior.pending?.at ?? prior.assuranceRetryAt : Math.max(now() + DEBOUNCE_MS, (prior.lastAuto ?? -Infinity) + AUTO_INTERVAL_MS),
     ...(prior.pending?.retryKey ? { retryKey: prior.pending.retryKey } : {}) };
   }
   save(state);
  },
  async tick(enabled: boolean, retryFailures = false) {
   const statuses = new Map(builder.status().map(s => [s.sessionRef, s]));
   const receipts = new Map(builder.receipts().map(r => [r.sessionRef, r.receipt]));
   if (enabled && retryFailures) for (const status of statuses.values()) {
    if (status.state !== "failed" || !status.nextAt || Date.parse(status.nextAt) > now()) continue;
    const schedule = state[status.sessionRef] ??= {}, retryKey = `retry:${status.buildId}:${status.nextAt}`;
    if (!schedule.pending && schedule.retryCursor !== retryKey) {
     schedule.pending = { fingerprint: "", trigger: "stop", at: Date.parse(status.nextAt), retryKey }; save(state);
    }
   }
   for (const [session, schedule] of Object.entries(state)) {
    if (!schedule.pending) continue;
    if (!enabled) { delete schedule.pending; delete schedule.assuranceRetryAt; save(state); continue; }
    const status = statuses.get(session);
    // A published receipt already covers the observed source, so the obligation ends before its debounce.
    if (!schedule.pending.retryKey && status?.state === "idle" && receipts.get(session)?.fingerprint === schedule.pending.fingerprint) {
     schedule.cursor = schedule.pending.fingerprint; delete schedule.pending; delete schedule.assuranceRetryAt; save(state); continue;
    }
    if (["building", "queued", "waiting"].includes(status?.state ?? "")) continue;
    if (now() < Math.max(schedule.pending.at, schedule.assuranceRetryAt ?? 0, Date.parse(status?.nextAt ?? "") || 0)) continue;
    await admit(session, schedule);
   }
  },
  pending() { return Object.entries(state).flatMap(([sessionRef, value]) => value.pending ? [{ sessionRef, nextAt: new Date(Math.max(value.pending.at, value.assuranceRetryAt ?? 0)).toISOString(), trigger: value.pending.trigger }] : []); },
 };
}
