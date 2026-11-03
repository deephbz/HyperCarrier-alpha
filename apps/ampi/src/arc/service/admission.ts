// Provisional Host-local capacity behind the core port. The owner still chooses
// whether the accepted shared limit moves to each Host.
import { randomUUID } from "node:crypto";
import type { Admission, BuilderState } from "../core/index.ts";
export function hostAdmission(host: string, limit: () => number, state?: BuilderState): Admission & { running(): number } {
 const held = new Set<string>();
 for (const job of Object.values(state?.jobs ?? {})) for (const call of [...job.calls, ...job.callHistory]) {
  if (call.execution && call.executionState !== "gone") held.add(call.permit.id);
 }
 return {
  running: () => held.size,
  async acquire() {
   const max = limit();
   if (!Number.isSafeInteger(max) || max < 1) return { kind: "wait", facts: { reason: "unavailable", running: held.size, limit: 0, scope: host } };
   if (held.size >= max) return { kind: "wait", facts: { reason: "capacity", running: held.size, limit: max, scope: host, byHost: { [host]: held.size } } };
   const id = randomUUID(); held.add(id); return { kind: "permit", permit: { id } };
  },
  async release(permit, outcome) { if (outcome === "settled") held.delete(permit.id); },
 };
}
