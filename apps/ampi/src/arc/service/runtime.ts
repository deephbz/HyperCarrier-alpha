// One resident authority per Host user and Pi agent directory. This local control
// socket is not the remote-agent protocol; that carrier relays committed results.
import { createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { serviceAddress, controlRequest } from "./connection.ts";
export { serviceAddress, controlRequest } from "./connection.ts";
import { createBuilder, type Builder, type BuildKind, type BuilderState, type RequestOptions, type Store } from "../core/index.ts";
import { inheritedLock, type ServiceLock } from "./lock.ts";
import { completeRecovery, durableJson, fenceStop, readJson, STORE_SCHEMA } from "./store.ts";
import { compare, validStamp, type Stamp } from "./engine.ts";
import { ignoredIdleHours, serviceSettings, sessionDirectory } from "./settings.ts";
import { piSource, canonicalSessionRef } from "./source.ts";
import { verificationPump } from "./source-verification.ts";
import { piModel } from "./model.ts";
import { automaticSchedule, type ScheduleState } from "./schedule.ts";
import { serviceStatus } from "./status.ts";
import { hostAdmission } from "./admission.ts";

export type ControlCommand = { op: "hello" | "status" | "snapshot" | "request" | "dismiss" | "offer" | "stop"; stamp?: Stamp; refreshAuth?: boolean; knownRevisions?: Record<string, number>; sessionRef?: string; requestId?: string; kind?: BuildKind; requester?: string; options?: RequestOptions; dropId?: string; toPosition?: number };
export async function startService(options: { agentDir: string; host: string; serviceVersion: string; releaseLine?: string | null; buildOrder: number; extensionPath: string; pollMs?: number; maintenance?: { generation: string | null; uncertainty?: "unknown-prior-stop"; fencePending?: boolean; fault?: string }; ready?(status: unknown): void; exit(): void }) {
 const lock: ServiceLock = inheritedLock(), incarnation = randomUUID();
 try {
  if (ignoredIdleHours(options.agentDir)) console.warn("Arc: ampi_arc.serviceIdleHours is ignored; the no-hub grace is five minutes.");
 } catch { /* Status reports invalid settings. */ }
 const stamp: Stamp = { id: options.serviceVersion, order: options.buildOrder, line: options.releaseLine ?? null };
 const store: Store = { load: () => readJson(join(lock.store, "builder.json")) as BuilderState | undefined, save: value => durableJson(lock, "builder.json", value) };
 let sessionsDir = join(options.agentDir, "sessions");
 try { sessionsDir = sessionDirectory(options.agentDir); } catch { /* status reports invalid settings */ }
 const source = piSource({ sessionsDir, storeDir: lock.store,
  verification: { load: () => readJson(join(lock.store, "source-verification.json")), save: state => durableJson(lock, "source-verification.json", state) },
  verificationSettings: () => { const settings = serviceSettings(options.agentDir); return { bytesPerMinute: settings.sourceVerifyBytesPerMinute, intervalMs: settings.sourceVerifyIntervalMs }; },
  log: message => console.warn(message),
 });
 let signIn: import("../core/index.ts").ModelFailure | undefined;
 const model = piModel({ agentDir: options.agentDir, extensionPath: options.extensionPath, checked: result => { signIn = result; } });
 let draining = Boolean(options.maintenance), drainCause: "update" | "stop" = "stop", lastHello = Date.now(), fault: string | undefined = options.maintenance?.fault;
 let checking: Promise<void> | undefined, cancellationPersisted = false;
 const authCancellation = new AbortController();
 let initial: BuilderState | undefined;
 try { initial = store.load(); } catch (error) { if (!options.maintenance) throw error; fault = (error as Error).message; }
 const admitter = hostAdmission(options.host, () => serviceSettings(options.agentDir).concurrency, initial);
 let builder: Builder | undefined;
 const initializeBuilder = () => createBuilder({ source, model, store, engineVersion: options.serviceVersion, settings: () => serviceSettings(options.agentDir), admission: {
  acquire: kind => draining || fault ? Promise.resolve({ kind: "wait" as const, facts: { reason: "unavailable" as const, running: admitter.running(), limit: 0, scope: options.host } }) : admitter.acquire(kind),
  release: (permit, outcome) => admitter.release(permit, outcome),
 } });
 try { if (!fault) builder = initializeBuilder(); } catch (error) { if (!options.maintenance) throw error; fault = (error as Error).message; }
 const scheduler = options.maintenance ? undefined : automaticSchedule({ builder: builder!, source, state: (readJson(join(lock.store, "schedule.json")) ?? {}) as ScheduleState,
  save: state => durableJson(lock, "schedule.json", state) });
 const active = new Set<Promise<void>>();
 function wake() {
  if (draining || fault || !builder) return;
  const run = builder.run().catch(e => { fault = (e as Error).message; }).finally(() => active.delete(run));
  active.add(run);
 }
 function status() {
  const recoveryAction = fault === "The stop record changed during cancellation" ? `Run ampi arc stop --host ${options.host} again.` : `Repair ${lock.store}: ${fault}; then run ampi arc stop --host ${options.host} again.`;
  let settings: ReturnType<typeof serviceSettings> | undefined, invalid: { message: string; settingsPath?: string; settingsKey?: string } | undefined;
  try { settings = serviceSettings(options.agentDir); } catch (e) { invalid = e as typeof invalid; }
  return serviceStatus(options.host, { incarnation, serviceVersion: options.serviceVersion, releaseLine: options.releaseLine ?? null, buildOrder: options.buildOrder, stamp, receiptSchema: 1, serviceLogPath: join(lock.store, "service.log"), storeSchema: STORE_SCHEMA, bundleSchema: STORE_SCHEMA, running: true, pid: process.pid,
   state: options.maintenance && fault ? "fault" : draining ? drainCause === "update" ? "updating" : "stopping" : fault ? "fault" : invalid ? "invalid-settings" : signIn ? signIn.code === "sign-in" ? "no-sign-in" : signIn.code === "settings" ? "invalid-settings" : "cannot-start" : "running",
   ...(fault || invalid || signIn ? { detail: options.maintenance && fault ? fault === "The stop record changed during cancellation" ? `${fault}. ${recoveryAction}` : `Arc recovery could not finish: ${fault}. ${recoveryAction}` : fault ?? invalid?.message ?? signIn?.message } : {}),
   ...(options.maintenance ? { kind: "forced-recovery", recoveryGeneration: options.maintenance.generation, recoveryUncertainty: options.maintenance.uncertainty, cancellationPersisted, ...(fault ? { recoveryFault: fault, recoveryAction } : {}) } : {}),
   ...(invalid ? { settingsPath: invalid.settingsPath, settingsKey: invalid.settingsKey } : signIn ? { prerequisite: signIn.prerequisite, authPath: signIn.authPath, settingsPath: signIn.settingsPath, settingsKey: signIn.settingsKey } : {}),
   model: settings?.model, runningBuilds: admitter.running(), limit: settings?.concurrency });
 }
 function checkSignIn() {
  return checking ??= (async () => {
   try { await model.preflight(serviceSettings(options.agentDir).model, authCancellation.signal); }
   catch { /* Status carries typed invalid-settings facts. */ }
  })().finally(() => { checking = undefined; });
 }
 const scanCancellation = new AbortController();
 let scanning: Promise<void> | undefined;
 const requests = new Set<Promise<unknown>>();
 function holdsLock() {
  try { lock.assertHeld(); return true; } catch { return false; }
 }
 function hasAuthority() { return holdsLock() && existsSync(serviceAddress(lock.store)); }
 const verifier = verificationPump({ active: () => !draining && !fault && !scanCancellation.signal.aborted && hasAuthority(), step: () => source.verifyStep(scanCancellation.signal) });
 async function tick() {
  if (!hasAuthority()) { await stop(true); return; }
  // A missing hub also bounds update drains with unfinished model calls.
  if (Date.now() - lastHello >= 5 * 60_000) { await stop(true, "No AmPi hub was connected for 5 minutes, so Arc cancelled this Build."); return; }
  if (draining || !builder || !scheduler) return;
  let settings;
  try { settings = serviceSettings(options.agentDir); } catch { /* Status reports invalid settings. */ }
  if (!settings) return;
  if (!scanning) {
   scanning = (async () => { try {
    const snapshots = await source.scan(scanCancellation.signal);
    if (draining) return;
    for (const snapshot of snapshots) scheduler!.observe(snapshot, settings.auto);
    await scheduler!.tick(settings.auto && !draining, true);
   } catch { if (fault) return; /* Source scans retry without advancing their durable trigger. */ }
   })().finally(() => { scanning = undefined; });
   await scanning;
  }
  wake();
  void verifier.run().catch(error => console.warn(`Arc source verification paused: ${(error as Error).message}`));
 }
 const sockets = new Set<Socket>();
 let interval: ReturnType<typeof setInterval> | undefined;
 let stopping: Promise<void> | undefined, cancellation: Promise<void> | undefined;
 function stop(cancelActive = false, reason?: string): Promise<void> {
  if (options.maintenance) cancelActive = true;
  if (!hasAuthority()) cancelActive = true;
  if (options.maintenance && fault && !stopping && hasAuthority()) {
   cancellation = undefined; cancellationPersisted = false;
   try {
    if (options.maintenance.fencePending) {
     const stop = fenceStop(lock, true);
     options.maintenance.generation = stop.generation;
     options.maintenance.uncertainty ??= stop.uncertainty;
     options.maintenance.fencePending = false;
    }
    builder = initializeBuilder(); fault = undefined;
   } catch (error) {
    options.maintenance.uncertainty ??= (error as { recoveryUncertainty?: "unknown-prior-stop" }).recoveryUncertainty;
    fault = (error as Error).message;
   }
  }
  if (cancelActive) { cancellation ??= builder?.cancel(reason) ?? Promise.reject(new Error(fault ?? "Arc Builder is unavailable")); void cancellation.catch(e => { fault = (e as Error).message; }); }
  if (stopping) return stopping;
  draining = true;
  scanCancellation.abort();
  // A later signal must take the native termination path, even if JS is stuck.
  process.off("SIGTERM", signalStop); process.off("SIGINT", signalStop);
  authCancellation.abort();
  return stopping = (async () => {
   await scanning;
   await Promise.allSettled([...requests]);
   await Promise.allSettled([...active]);
   await source.close();
   let shutdownError: unknown;
   try { await cancellation; cancellationPersisted = Boolean(options.maintenance); } catch (error) { shutdownError = error; }
   try { await checking; } catch (error) { shutdownError ??= error; }
   // Lost authority cannot retain a readable terminal record. A valid store
   // still requires successful persistence before its lifetime lock can go.
   if (shutdownError && hasAuthority()) throw shutdownError;
   if (options.maintenance && !shutdownError && hasAuthority()) completeRecovery(lock, options.maintenance.generation!);
   await new Promise<void>(resolve => setImmediate(resolve));
   if (interval) clearInterval(interval);
   for (const socket of sockets) if (!socket.writableEnded) socket.destroy();
   // server.close() also unlinks a Unix socket. A displaced resident must
   // leave its successor's socket untouched, including this implicit unlink.
   if (!holdsLock()) { lock.release(); options.exit(); return; }
   const closed = new Promise<void>(resolve => server.close(() => resolve()));
   await closed;
   if (holdsLock()) rmSync(serviceAddress(lock.store), { force: true });
   lock.release();
   options.exit();
  })().catch(error => {
   if (holdsLock()) { process.on("SIGTERM", signalStop); process.on("SIGINT", signalStop); stopping = undefined; }
   throw error;
  });
 }
 function signalStop() {
  void stop().catch(e => { fault = (e as Error).message; console.error(`Arc service stop failed: ${fault}`); });
 }
 const mismatch = () => ({ ...status(), state: "error", outcome: "refused", code: "build-mismatch", detail: `This AmPi is older than ${options.host}. Update it.` });
 async function handle(command: ControlCommand): Promise<unknown> {
  if (command.op === "status") { if (!draining && command.refreshAuth !== false) await checkSignIn(); return status(); }
  if (command.op === "hello") {
   if (!validStamp(command.stamp) || compare(command.stamp, stamp) !== "same") return mismatch();
   lastHello = Date.now();
   return status();
  }
  if (!["offer", "stop"].includes(command.op) && (!validStamp(command.stamp) || compare(command.stamp, stamp) !== "same")) return mismatch();
  if (command.op === "snapshot") {
   let auto = false; try { auto = serviceSettings(options.agentDir).auto; } catch {}
   const statuses = (builder?.status() ?? []).map(value => { if (!auto && value.state === "failed") { const { nextAt, ...rest } = value; return rest; } return value; });
   return { ...status(), receipts: builder?.receipts(command.knownRevisions) ?? [], statuses, scheduled: auto ? scheduler?.pending() ?? [] : [] };
  }
  if (command.op === "offer") {
   if (options.maintenance) return status();
   if (!validStamp(command.stamp)) return mismatch();
   if (compare(command.stamp, stamp) !== "newer") return mismatch();
   drainCause = "update"; void stop(); return status();
  }
  if (command.op === "stop") {
   // Reply before draining this connection. No new admission starts after stop().
   drainCause = "stop"; void stop(true).catch(e => { fault = (e as Error).message; }); return status();
  }
  const session = canonicalSessionRef(command.sessionRef ?? "");
  if (!builder) return { outcome: "refused", code: "service", transient: true, detail: status().detail };
  if (!fault && (command.op === "request" || command.op === "dismiss")) {
   const prior = builder.replay(command.op === "dismiss"
    ? { sessionRef: session, requestId: command.requestId ?? "", kind: "dismiss", dropId: command.dropId ?? "", toPosition: command.toPosition! }
    : { sessionRef: session, requestId: command.requestId ?? "", kind: command.kind!, requester: command.requester ?? "", options: command.options });
   if (prior) return prior;
  }
  if (draining || fault) return { outcome: "refused", code: "service", transient: true, detail: "Arc service is draining or fenced" };
  if (command.op === "dismiss") return builder.dismiss(session, command.requestId ?? "", command.dropId ?? "", command.toPosition!);
  if (command.op === "request") {
   const pending = builder.request(session, command.requestId ?? "", command.kind!, command.requester ?? "", command.options);
   requests.add(pending);
   try { const result = await pending; wake(); return result; }
   finally { requests.delete(pending); }
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
 process.on("SIGTERM", signalStop); process.on("SIGINT", signalStop);
 interval = setInterval(() => { void tick().catch(e => { fault = (e as Error).message; }); }, options.pollMs ?? 2000);
 if (options.maintenance && !fault) { drainCause = "stop"; void stop(true).catch(e => { fault = (e as Error).message; }); }
 options.ready?.(status()); if (!options.maintenance) void tick();
 return { stop, status, builder };
}
