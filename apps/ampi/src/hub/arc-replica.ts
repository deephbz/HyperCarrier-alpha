// The hub owns a read copy and an outbox. Only Host evidence can accept a
// command or advance a receipt. First use removes the obsolete v2 read store.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ArcCommand, ArcFrame, ArcResult, ArcScheduled } from "../arc/link.ts";
import { compare, type Stamp } from "../arc/service/engine.ts";
import type { ArcReceipt, ArcRequest, ArcService, ArcValue, BuildStatus, DismissResult, RequestOutcome } from "../shared/arc.ts";
import { replacementText, serviceStatus, serviceText, type ServiceStatus } from "../arc/service/status.ts";

type StoredCommand = { command: ArcCommand; result?: ArcResult | { outcome: "not-sent" }; pending: boolean };
type ReceiptHead = { revision: number; sessionRef: string; asOfCount: number; selector: string; tier: string; fingerprint: string; needsYou: number; oldestAt?: string; builds: number };
type Disk = { v2Removed?: true; receipts: Record<string, ReceiptHead>; commands: Record<string, StoredCommand>; latest: Record<string, string> };
const key = (id: string) => createHash("sha256").update(id).digest("hex");
type ReplicaOptions = { dir: string; host: string; requester: string; send(command: ArcCommand): boolean; changed(): void; timeoutMs?: number };
export class ArcReplica {
 private options: ReplicaOptions;
 private disk: Disk;
 private committed = "";
 private storeFault?: string;
 private receipts = new Map<string, ArcReceipt>();
 private service?: ServiceStatus;
 private lastStamp: Stamp | null = null;
 private removedV2 = false;
 private statuses = new Map<string, BuildStatus>();
 private scheduled = new Map<string, ArcScheduled>();
 private generation?: string;
 private seq = 0;
 private compatible = false;
 private reachable = false;
 private since = new Date().toISOString();
 private fresh = false;
 private serviceWait = new Set<string>();
 private inflight = new Map<string, ReturnType<typeof setTimeout>>();
 private waiting = new Map<string, Set<(result: ArcResult | { outcome: "unknown" } | { outcome: "not-sent" }) => void>>();
 constructor(options: ReplicaOptions) {
  this.options = options;
  mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  try { this.disk = JSON.parse(readFileSync(join(options.dir, "replica.json"), "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; this.disk = { receipts: {}, commands: {}, latest: {} }; }
  this.committed = JSON.stringify(this.disk);
  if (!this.disk.v2Removed) {
   rmSync(join(dirname(options.dir), "views", "arc"), { recursive: true, force: true });
   this.disk.v2Removed = true; this.save(); this.removedV2 = true;
  }
 }
 private save() {
  const target = join(this.options.dir, "replica.json"), temp = target + "." + randomUUID() + ".tmp";
  const serialized = JSON.stringify(this.disk);
  try {
   const fd = openSync(temp, "wx", 0o600);
   try { writeFileSync(fd, serialized); fsyncSync(fd); } finally { closeSync(fd); }
   renameSync(temp, target);
   const dir = openSync(this.options.dir, "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
   this.committed = serialized;
  } catch (error) {
   this.disk = JSON.parse(this.committed); this.storeFault = "Arc read copy could not be saved. Check the hub cache and restart this hub.";
   this.compatible = this.fresh = false; this.options.changed(); throw error;
  }
 }
 get stamp(): Stamp | null { return this.reachable ? this.lastStamp : null; }
 private canSubmit() { return this.compatible && this.reachable && this.service?.running === true && !["stopped", "fault", "busy", "error", "cannot-start", "unreachable", "updating", "stopping"].includes(this.service.state); }
 queue() { return { pending: [...this.statuses.values()].filter(s => ["queued", "waiting", "building"].includes(s.state)).length + this.scheduled.size, done: Object.values(this.disk.receipts).reduce((n, r) => n + r.builds, 0) }; }
 known() { return Object.fromEntries(Object.values(this.disk.receipts).map(r => [r.sessionRef, r.revision])); }
 head(session: string) { return this.disk.receipts[key(session)]; }
 private receiptPath(head: ReceiptHead) { return join(this.options.dir, `${key(head.sessionRef)}-${head.revision}.json`); }
 receipt(session: string): ArcReceipt | undefined {
  const head = this.head(session); if (!head) return;
  let receipt = this.receipts.get(session);
  if (!receipt) receipt = JSON.parse(readFileSync(this.receiptPath(head), "utf8")) as ArcReceipt;
  this.receipts.delete(session); this.receipts.set(session, receipt);
  while (this.receipts.size > 32) this.receipts.delete(this.receipts.keys().next().value!);
  return receipt;
 }
 disconnect() {
  if (this.reachable) this.since = new Date().toISOString();
  this.reachable = this.fresh = this.compatible = false; this.generation = undefined; this.serviceWait.clear();
  for (const [id, timer] of this.inflight) { clearTimeout(timer); this.finish(id, { outcome: "unknown" }); }
  this.inflight.clear(); this.options.changed();
 }
 linkError(detail: string) { this.lastStamp = null; this.reachable = true; this.fresh = this.compatible = false; this.service = serviceStatus(this.options.host, { state: "error", detail }); this.options.changed(); }
 receive(frame: ArcFrame) {
  if (this.storeFault) return;
  try { this.apply(frame); }
  catch (error) {
   this.storeFault ??= "Arc read copy could not be saved. Check the hub cache and restart this hub.";
   this.compatible = this.fresh = false; this.options.changed(); throw error;
  }
 }
 private apply(frame: ArcFrame) {
  if (frame.t === "arc.hello") {
   if (this.generation !== frame.generation) this.seq = 0;
   this.generation = frame.generation; this.service = frame.service;
   this.lastStamp = frame.service.running === true ? frame.service.stamp ?? null : null;
   const order = compare(frame.expected, frame.stamp);
   this.reachable = true; this.compatible = order === "same" && frame.service.outcome !== "refused";
   this.fresh = false;
   if (order !== "same") this.service = { ...frame.service, state: "error", code: "build-mismatch", detail: order === "older" ? `This AmPi is older than ${this.options.host}. Update it.` : replacementText(this.options.host, frame.service.detail ?? "the older service is still running", frame.service.serviceLogPath) };
   this.options.changed();
   if (this.compatible) this.resend();
  } else if (frame.t === "arc.receipt") {
   if (!this.compatible || frame.revision <= (this.disk.receipts[key(frame.sessionRef)]?.revision ?? 0)) return;
   const r = frame.receipt, points = r.points.filter(p => p.needsYou), oldestAt = points.map(p => p.firstAt).filter(Boolean).sort()[0];
   const prior = this.head(frame.sessionRef), head: ReceiptHead = { revision: frame.revision, sessionRef: frame.sessionRef, asOfCount: r.asOfCount, selector: r.selector, tier: r.tier, fingerprint: r.fingerprint, needsYou: points.length, ...(oldestAt ? { oldestAt } : {}), builds: r.builds.length };
   // Receipt bytes reach disk before the head can publish or enter reconnect coordinates.
   const path = this.receiptPath(head), temp = path + "." + randomUUID() + ".tmp", fd = openSync(temp, "wx", 0o600);
   try { writeFileSync(fd, JSON.stringify(r)); fsyncSync(fd); } finally { closeSync(fd); }
   renameSync(temp, path);
   this.disk.receipts[key(frame.sessionRef)] = head; this.save(); this.receipts.delete(frame.sessionRef);
   if (prior) rmSync(this.receiptPath(prior), { force: true }); this.options.changed();
  } else if (frame.t === "arc.status") {
   if (frame.generation !== this.generation || frame.seq <= this.seq) return;
   const prior = [this.lastStamp, this.service, this.fresh, this.statuses, this.scheduled];
   this.seq = frame.seq; this.lastStamp = frame.service.running === true ? frame.service.stamp ?? null : null;
   if (this.compatible) this.service = frame.service;
   this.fresh = this.compatible && frame.service.running === true && !["error", "busy"].includes(frame.service.state);
   if (this.fresh) { this.statuses = new Map(frame.statuses.map(s => [s.sessionRef, s])); this.scheduled = new Map(frame.scheduled.map(s => [s.sessionRef, s])); }
   if (!isDeepStrictEqual(prior, [this.lastStamp, this.service, this.fresh, this.statuses, this.scheduled])) this.options.changed();
   if (this.compatible) this.resend();
  } else {
   const stored = this.disk.commands[key(frame.requestId)];
   if (!stored || !stored.pending) return; // Terminal Host acceptance never regresses.
   const transient = frame.result.outcome === "refused" && frame.result.transient;
   if (transient) this.serviceWait.add(frame.requestId); else this.serviceWait.delete(frame.requestId);
   const result = transient ? { outcome: "unknown" as const } : frame.result;
   if (result.outcome !== "unknown") { stored.result = result; stored.pending = false; this.save(); }
   this.finish(frame.requestId, result); this.options.changed();
  }
 }
 private finish(id: string, result: ArcResult | { outcome: "unknown" } | { outcome: "not-sent" }) {
  clearTimeout(this.inflight.get(id)); this.inflight.delete(id);
  for (const resolve of this.waiting.get(id) ?? []) resolve(result);
  this.waiting.delete(id);
 }
 private resend() { for (const stored of Object.values(this.disk.commands)) if (stored.pending) this.send(stored); }
 private send(stored: StoredCommand) {
  const id = stored.command.requestId;
  if (this.inflight.has(id) || !this.compatible || !this.reachable || this.service?.running !== true) return;
  const timer = setTimeout(() => { this.finish(id, { outcome: "unknown" }); this.options.changed(); }, this.options.timeoutMs ?? 10_000);
  timer.unref(); this.inflight.set(id, timer);
  if (!this.options.send(stored.command)) { clearTimeout(timer); this.inflight.delete(id); this.finish(id, { outcome: "unknown" }); }
 }
 private submit(command: ArcCommand): Promise<ArcResult | { outcome: "unknown" } | { outcome: "not-sent" }> {
  const id = command.requestId, existing = this.disk.commands[key(id)];
  if (existing && JSON.stringify(existing.command) !== JSON.stringify(command)) return Promise.resolve({ outcome: "refused", code: "id-conflict" });
  if (existing?.result) return Promise.resolve(existing.result);
  const refusal = !this.canSubmit() ? { outcome: "refused" as const, code: "service" as const, detail: this.storeFault ?? this.service?.detail ?? "The Arc service cannot accept commands now." } : undefined;
  if (this.storeFault) return Promise.resolve(refusal!);
  const stored = existing ?? { command, pending: !refusal, ...(refusal ? { result: refusal } : {}) };
  this.disk.commands[key(id)] = stored;
  if (command.kind !== "dismiss") this.disk.latest[key(command.sessionRef)] = id;
  this.save(); this.options.changed();
  if (stored.result) return Promise.resolve(stored.result);
  const result = new Promise<ArcResult | { outcome: "unknown" } | { outcome: "not-sent" }>(resolve => {
   const listeners = this.waiting.get(id) ?? new Set(); listeners.add(resolve); this.waiting.set(id, listeners);
  });
  if (!this.reachable || !this.compatible || this.service?.running !== true) this.finish(id, { outcome: "unknown" }); else this.send(stored);
  return result;
 }
 async build(sessionRef: string, requestId: string = randomUUID(), rebuild = false): Promise<RequestOutcome> {
  const result = await this.submit({ t: "arc.request", requestId, sessionRef, kind: rebuild ? "rebuild" : "manual", requester: this.options.requester });
  if (result.outcome === "unknown") return { ...result, requestId, ...(this.serviceWait.has(requestId) ? { waitFor: "service" as const } : {}) };
  if (result.outcome === "dismissed") return { outcome: "refused", code: "id-conflict" };
  return result;
 }
 async dismiss(sessionRef: string, dropId: string, toPosition: number): Promise<DismissResult> {
  const result = await this.submit({ t: "arc.request", requestId: randomUUID(), sessionRef, kind: "dismiss", dropId, toPosition });
  return result.outcome === "dismissed" || result.outcome === "refused" ? result : { outcome: "refused", code: "source", detail: result.outcome === "not-sent" ? "The Host is not reachable. The warning was not dismissed." : "Dismissal status unknown. AmPi sends it again when the Host reconnects." };
 }
 value(sessionRef: string): Pick<ArcValue, "receipt" | "status" | "request" | "services" | "builderHost" | "canDismiss" | "statusStale" | "v2Removed"> {
  const receipt = this.receipt(sessionRef), raw = this.statuses.get(sessionRef), scheduled = this.scheduled.get(sessionRef);
  const { wait, ...rest } = raw ?? { state: scheduled ? "queued" as const : "idle" as const, wait: undefined };
  const status: ArcValue["status"] = { ...rest, ...(raw?.record?.error ? { error: raw.record.error } : {}), ...(wait ? { wait: { reason: wait.reason, running: wait.running, limit: wait.limit, scope: wait.scope, ...(wait.byHost ? { byHost: Object.entries(wait.byHost).map(([host, running]) => ({ host, running })) } : {}) } } : {}) };
  if (scheduled && (!raw || raw.state === "idle")) { status.state = "queued"; status.nextAt = scheduled.nextAt; }
  const id = this.disk.latest[key(sessionRef)], command = id ? this.disk.commands[key(id)] : undefined;
  const request = command ? { ...(command.result ?? { outcome: "unknown", ...(this.serviceWait.has(id) ? { waitFor: "service" } : {}) }), requestId: id } as ArcRequest : undefined;
  return { ...(receipt ? { receipt: { ...receipt, session: `${this.options.host}/${sessionRef}` } } : {}), status, ...(request ? { request } : {}), services: [this.serviceValue()], builderHost: this.options.host, canDismiss: this.canSubmit(), ...(!receipt && this.removedV2 ? { v2Removed: true } : {}), statusStale: !this.fresh };
 }
 private serviceValue(): ArcService {
  if (this.storeFault) return { host: this.options.host, state: "error", text: this.storeFault };
  const host = this.options.host, s = this.service ?? serviceStatus(host, { state: "unreachable" });
  const facts = { host, ...(s.serviceVersion ? { version: s.serviceVersion } : {}) };
  if (!this.reachable) return { ...facts, state: "unreachable", since: this.since, text: serviceText(serviceStatus(host, { state: "unreachable" })) };
  return { ...facts, state: s.state, text: serviceText({ ...s, host }), ...(s.state === "no-sign-in" ? { model: s.model ?? "", path: s.authPath ?? "" } : s.state === "invalid-settings" ? { path: s.settingsPath ?? "", key: s.settingsKey ?? "" } : s.state === "cannot-start" ? { prerequisite: s.prerequisite ?? "" } : s.state === "unreachable" ? { since: this.since } : {}) } as ArcService;
 }
}
