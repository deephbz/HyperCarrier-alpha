// A hub link starts or updates the service, polls committed state and forwards
// durable commands. The service owns construction.
import { randomUUID } from "node:crypto";
import type { ArcCommand, ArcFrame, ArcScheduled } from "../link.ts";
import { compare, type Stamp } from "./engine.ts";
import type { ReceiptRevision } from "../core/types.ts";
import type { BuildStatus } from "../../shared/arc.ts";
import type { ControlCommand } from "./runtime.ts";
import { serviceError, type ServiceStatus } from "./status.ts";
export function serviceRelay(options: {
 host: string; known: Record<string, number>; emit(frame: ArcFrame): void;
 stamp: Stamp;
 ensure(): Promise<ServiceStatus>; control(command: ControlCommand): Promise<any>; pollMs?: number;
}) {
 let closed = false, polling = false, generation = "", seq = 0;
 const fallbackGeneration = randomUUID(), known = { ...options.known };
 let timer: ReturnType<typeof setInterval> | undefined;
 let activePoll: Promise<void> | undefined;
 function hello(service: ServiceStatus) {
  const next = typeof service.incarnation === "string" ? service.incarnation : fallbackGeneration;
  if (generation === next) return;
  generation = next; seq = 0;
  options.emit({ t: "arc.hello", stamp: service.stamp ?? options.stamp, generation, service, expected: options.stamp });
 }
 function poll(): Promise<void> {
  if (closed || polling) return activePoll ?? Promise.resolve();
  return activePoll = refresh();
 }
 async function refresh() {
  if (closed || polling) return;
  polling = true;
  try {
   let service: ServiceStatus;
   service = await options.ensure();
   if (closed) return;
   if (service.running && service.outcome !== "refused") service = await options.control({ op: "hello", stamp: options.stamp });
   if (closed) return;
   hello(service);
   let statuses: BuildStatus[] = [], scheduled: ArcScheduled[] = [];
   if (service.running && service.outcome !== "refused" && service.stamp && compare(options.stamp, service.stamp) === "same") {
    const snapshot = await options.control({ op: "snapshot", stamp: options.stamp, knownRevisions: known });
    if (closed) return;
    const { receipts, statuses: _statuses, scheduled: _scheduled, ...facts } = snapshot;
    service = facts; hello(service);
    statuses = snapshot.statuses; scheduled = snapshot.scheduled;
    for (const receipt of snapshot.receipts as ReceiptRevision[]) {
     if (receipt.revision <= (known[receipt.sessionRef] ?? 0)) continue;
     options.emit({ t: "arc.receipt", ...receipt }); known[receipt.sessionRef] = receipt.revision;
    }
   }
   if (!closed) options.emit({ t: "arc.status", generation, seq: ++seq, service, statuses, scheduled });
  } catch (error) {
   if (!closed) { const service = serviceError(options.host, error); hello(service); options.emit({ t: "arc.status", generation, seq: ++seq, service, statuses: [], scheduled: [] }); }
  } finally { polling = false; }
 }
 async function command(command: ArcCommand) {
  if (closed) return;
  try {
   const reply = await options.control(command.kind === "dismiss"
    ? { op: "dismiss", stamp: options.stamp, sessionRef: command.sessionRef, requestId: command.requestId, dropId: command.dropId, toPosition: command.toPosition }
    : { op: "request", stamp: options.stamp, sessionRef: command.sessionRef, requestId: command.requestId, kind: command.kind, requester: command.requester });
   // A replacement can win between the last status and this command.
   // Lifecycle refusals and failed control replies cannot settle its durable ID.
   const result = reply?.code === "build-mismatch" ? { outcome: "refused" as const, code: "service" as const, transient: true as const, detail: reply.detail } : reply;
   if (!result || !["accepted", "dismissed", "refused"].includes(result.outcome)) throw new Error("Arc command outcome is unknown");
   if (!closed) options.emit({ t: "arc.ack", requestId: command.requestId, result });
  } catch { if (!closed) options.emit({ t: "arc.ack", requestId: command.requestId, result: { outcome: "unknown" } }); }
  void poll();
 }
 void poll(); timer = setInterval(() => void poll(), options.pollMs ?? 1000); timer.unref();
 return { command, poll, async close() { closed = true; clearInterval(timer); await activePoll; } };
}
