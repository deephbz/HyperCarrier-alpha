// One resident authority per Host user and Pi agent directory. This local control
// socket is not the remote-agent protocol; that carrier relays committed results.
import { createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { serviceAddress, controlRequest } from "./connection.ts";
export { serviceAddress, controlRequest } from "./connection.ts";
import { createBuilder, type BuildKind, type BuilderState, type RequestOptions, type Store } from "../core/index.ts";
import { inheritedLock, type ServiceLock } from "./lock.ts";
import { durableJson, readJson, STORE_SCHEMA } from "./store.ts";
import { compare, validStamp, type Stamp } from "./engine.ts";
import { serviceSettings, sessionDirectory } from "./settings.ts";
import { piSource, canonicalSessionRef } from "./source.ts";
import { piModel } from "./model.ts";
import { automaticSchedule, type ScheduleState } from "./schedule.ts";
import { serviceStatus } from "./status.ts";
import { hostAdmission } from "./admission.ts";

export type ControlCommand = { op: "hello" | "status" | "snapshot" | "request" | "dismiss" | "offer" | "stop"; stamp?: Stamp; refreshAuth?: boolean; knownRevisions?: Record<string, number>; sessionRef?: string; requestId?: string; kind?: BuildKind; requester?: string; options?: RequestOptions; dropId?: string; toPosition?: number };
export async function startService(options: { agentDir: string; host: string; serviceVersion: string; releaseLine?: string | null; buildOrder: number; extensionPath: string; pollMs?: number; ready?(status: unknown): void; exit?(): void }) {
 const lock: ServiceLock = inheritedLock(), incarnation = randomUUID();
 const stamp: Stamp = { id: options.serviceVersion, order: options.buildOrder, line: options.releaseLine ?? null };
 const store: Store = { load: () => readJson(join(lock.store, "builder.json")) as BuilderState | undefined, save: value => durableJson(lock, "builder.json", value) };
 let sessionsDir = join(options.agentDir, "sessions");
 try { sessionsDir = sessionDirectory(options.agentDir); } catch { /* status reports invalid settings */ }
 const source = piSource({ sessionsDir, storeDir: lock.store });
 let signIn: import("../core/index.ts").ModelFailure | undefined;
 const model = piModel({ agentDir: options.agentDir, extensionPath: options.extensionPath, checked: result => { signIn = result; } });
 let draining = false, drainCause: "update" | "stop" = "stop", lastHello = Date.now(), fault: string | undefined;
 let checking: Promise<void> | undefined;
 const admitter = hostAdmission(options.host, () => serviceSettings(options.agentDir).concurrency, store.load());
 const builder = createBuilder({ source, model, store, engineVersion: options.serviceVersion, settings: () => serviceSettings(options.agentDir), admission: {
  acquire: kind => draining || fault ? Promise.resolve({ kind: "wait" as const, facts: { reason: "unavailable" as const, running: admitter.running(), limit: 0, scope: options.host } }) : admitter.acquire(kind),
  release: (permit, outcome) => admitter.release(permit, outcome),
 } });
 const scheduler = automaticSchedule({ builder, state: (readJson(join(lock.store, "schedule.json")) ?? {}) as ScheduleState,
  save: state => durableJson(lock, "schedule.json", state) });
 const active = new Set<Promise<void>>();
 function wake() {
  if (draining || fault) return;
  const run = builder.run().catch(e => { fault = (e as Error).message; }).finally(() => active.delete(run));
  active.add(run);
 }
 function status() {
  let settings: ReturnType<typeof serviceSettings> | undefined, invalid: { message: string; settingsPath?: string; settingsKey?: string } | undefined;
  try { settings = serviceSettings(options.agentDir); } catch (e) { invalid = e as typeof invalid; }
  return serviceStatus(options.host, { incarnation, serviceVersion: options.serviceVersion, releaseLine: options.releaseLine ?? null, buildOrder: options.buildOrder, stamp, receiptSchema: 1, serviceLogPath: join(lock.store, "service.log"), storeSchema: STORE_SCHEMA, bundleSchema: STORE_SCHEMA, running: true, pid: process.pid,
   state: draining ? drainCause === "update" ? "updating" : "stopping" : fault ? "fault" : invalid ? "invalid-settings" : signIn ? signIn.code === "sign-in" ? "no-sign-in" : signIn.code === "settings" ? "invalid-settings" : "cannot-start" : "running",
   ...(fault || invalid || signIn ? { detail: fault ?? invalid?.message ?? signIn?.message } : {}),
   ...(invalid ? { settingsPath: invalid.settingsPath, settingsKey: invalid.settingsKey } : signIn ? { prerequisite: signIn.prerequisite, authPath: signIn.authPath, settingsPath: signIn.settingsPath, settingsKey: signIn.settingsKey } : {}),
   model: settings?.model, runningBuilds: admitter.running(), limit: settings?.concurrency });
 }
 function checkSignIn() {
  return checking ??= (async () => {
   try { await model.preflight(serviceSettings(options.agentDir).model); }
   catch { /* Status carries typed invalid-settings facts. */ }
  })().finally(() => { checking = undefined; });
 }
 let scanning = false, idleHours = 24;
 async function tick() {
  if (draining) return;
  let settings;
  try { settings = serviceSettings(options.agentDir); idleHours = settings.serviceIdleHours; } catch { /* retain the last valid idle bound */ }
  if (Date.now() - lastHello >= idleHours * 3_600_000) { await stop(); return; }
  if (!settings) return;
  if (!scanning) {
   scanning = true;
   try {
    for (const snapshot of await source.scan()) scheduler.observe(snapshot, settings.auto && !draining);
    await scheduler.tick(settings.auto && !draining);
    if (settings.auto && !draining) for (const status of builder.status()) {
     if (status.state === "failed" && status.nextAt && Date.parse(status.nextAt) <= Date.now()) await builder.request(status.sessionRef, `retry:${status.buildId}:${status.nextAt}`, "incremental", "source");
    }
   } catch { if (fault) return; /* Source scans retry without advancing their durable trigger. */ }
   finally { scanning = false; }
  }
  wake();
 }
 const sockets = new Set<Socket>();
 let interval: ReturnType<typeof setInterval> | undefined;
 async function stop() {
  if (draining) return;
  draining = true; if (interval) clearInterval(interval);
  await Promise.allSettled([...active]);
  await new Promise<void>(resolve => setImmediate(resolve));
  const closed = new Promise<void>(resolve => server.close(() => resolve()));
  for (const socket of sockets) if (!socket.writableEnded) socket.destroy();
  await closed;
  rmSync(serviceAddress(lock.store), { force: true });
  options.exit?.();
 }
 const mismatch = () => ({ ...status(), state: "error", outcome: "refused", code: "build-mismatch", detail: `This AmPi is older than ${options.host}. Update it.` });
 async function handle(command: ControlCommand): Promise<unknown> {
  if (command.op === "status") { if (command.refreshAuth !== false) await checkSignIn(); return status(); }
  if (command.op === "hello") {
   if (!validStamp(command.stamp) || compare(command.stamp, stamp) !== "same") return mismatch();
   if (!draining) lastHello = Date.now();
   return status();
  }
  if (!["offer", "stop"].includes(command.op) && (!validStamp(command.stamp) || compare(command.stamp, stamp) !== "same")) return mismatch();
  if (command.op === "snapshot") {
   let auto = false; try { auto = serviceSettings(options.agentDir).auto; } catch {}
   const statuses = builder.status().map(value => { if (!auto && value.state === "failed") { const { nextAt, ...rest } = value; return rest; } return value; });
   return { ...status(), receipts: builder.receipts(command.knownRevisions), statuses, scheduled: auto ? scheduler.pending() : [] };
  }
  if (command.op === "offer") {
   if (!validStamp(command.stamp)) return mismatch();
   if (compare(command.stamp, stamp) !== "newer") return mismatch();
   drainCause = "update"; void stop(); return status();
  }
  if (command.op === "stop") {
   // Reply before draining this connection. No new admission starts after stop().
   drainCause = "stop"; void stop(); return status();
  }
  const session = canonicalSessionRef(command.sessionRef ?? "");
  if (!fault && (command.op === "request" || command.op === "dismiss")) {
   const prior = builder.replay(command.op === "dismiss"
    ? { sessionRef: session, requestId: command.requestId ?? "", kind: "dismiss", dropId: command.dropId ?? "", toPosition: command.toPosition! }
    : { sessionRef: session, requestId: command.requestId ?? "", kind: command.kind!, requester: command.requester ?? "", options: command.options });
   if (prior) return prior;
  }
  if (draining || fault) return { outcome: "refused", code: "service", transient: true, detail: "Arc service is draining or fenced" };
  if (command.op === "dismiss") return builder.dismiss(session, command.requestId ?? "", command.dropId ?? "", command.toPosition!);
  if (command.op === "request") {
   const result = await builder.request(session, command.requestId ?? "", command.kind!, command.requester ?? "", command.options); wake(); return result;
  }
  throw new Error("Unknown Arc service command");
 }
 // Only the lifetime owner can remove a stale socket and bind its replacement.
 lock.assertHeld(); rmSync(serviceAddress(lock.store), { force: true });
 const server = createServer(socket => {
  sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
  socket.setTimeout(30_000, () => socket.destroy());
  let buffer = "", handled = false;
  socket.on("data", data => {
   if (handled) return; buffer += data;
   if (buffer.length > 1024 * 1024) { socket.destroy(); return; }
   const at = buffer.indexOf("\n"); if (at < 0) return; handled = true;
   Promise.resolve().then(() => handle(JSON.parse(buffer.slice(0, at)))).then(result => socket.end(JSON.stringify(result) + "\n"), e => socket.end(JSON.stringify({ error: (e as Error).message }) + "\n"));
  });
 });
 await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(serviceAddress(lock.store), () => { chmodSync(serviceAddress(lock.store), 0o600); resolve(); }); });
 process.once("SIGTERM", () => { void stop(); }); process.once("SIGINT", () => { void stop(); });
 interval = setInterval(() => { void tick().catch(e => { fault = (e as Error).message; }); }, options.pollMs ?? 2000);
 options.ready?.(status()); void tick();
 return { stop, status, builder };
}
