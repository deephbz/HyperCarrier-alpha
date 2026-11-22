// Hub links offer engines. Selection is monotone under the service lifetime
// lock. A running service also checks order before it agrees to drain.
import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { serviceRelay } from "./relay.ts";
import type { ArcFrame } from "../link.ts";
import { compare, type Stamp } from "./engine.ts";
import { launchLocked, inheritedLock, LOCK_BUSY } from "./lock.ts";
import { controlStore, fenceStop, readStop, storeIncarnation, STORE_SCHEMA } from "./store.ts";
import { replacementText, serviceStatus, serviceError, type RecoveryResult } from "./status.ts";
import { controlRequest, startService as runtime } from "./runtime.ts";
import { inspectMacRecovery, macUnverifiedPorts, probeRecoveryLock, recoverOwner } from "./recovery.ts";
import type { RecoveryVisibility } from "./recovery-linux.ts";

declare const __ARC_VERSION__: string;
declare const __ARC_RELEASE_LINE__: "stable" | "durable" | null;
declare const __ARC_BUILD_ORDER__: number;
export const releaseLine = typeof __ARC_RELEASE_LINE__ === "undefined" ? null : __ARC_RELEASE_LINE__;
export const buildOrder = typeof __ARC_BUILD_ORDER__ === "undefined" ? 0 : __ARC_BUILD_ORDER__;
declare const __ARC_OUTPUT_LIMIT_SOURCE__: string;
export const serviceVersion = typeof __ARC_VERSION__ === "undefined" ? "development" : __ARC_VERSION__;
export const stamp: Stamp = { id: serviceVersion, order: buildOrder, line: releaseLine };
/** `forceUnverified` lets a macOS stop signal an owner that open-file evidence only matches; Linux always needs kernel proof. */
export type ManageOperation = { op: "ensure" | "stop" | "status"; host: string; agentDir?: string; timeoutMs?: number; forceUnverified?: boolean };
type LockedOperation = ManageOperation & { stopGeneration?: string | null; storeIncarnation?: string | null; forcedRecovery?: boolean };
function stopGeneration(store: string): string | null {
 const path = join(store, "stop.json");
 try {
  return readStop(store)?.generation ?? null;
 } catch (error) { throw new Error(`Cannot read Arc stop fence ${path}. Run ampi arc stop on this Host to replace this file, then retry.`, { cause: error }); }
}
export function relay(body: string, options: { host: string; agentDir: string; known: Record<string, number>; emit(frame: ArcFrame): void; pollMs?: number }) {
 return serviceRelay({ ...options, stamp,
  ensure: () => manage(body, { op: "ensure", host: options.host, agentDir: options.agentDir, timeoutMs: 5000 }),
  control: command => controlRequest(join(options.agentDir, "ampi-arc"), { ...command, stamp }),
 });
}
const agentDirectory = () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
function installFile(path: string, body: string) {
 if (existsSync(path)) { if (readFileSync(path, "utf8") !== body) throw new Error("Arc service version has different content"); return; }
 for (const dir of [dirname(dirname(path)), dirname(path)]) {
  try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
 }
 const temp = path + "." + randomUUID() + ".tmp";
 const fd = openSync(temp, "wx", 0o600);
 try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
 renameSync(temp, path);
 const dir = openSync(dirname(path), "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
}
function exitResident() {
 // Workaround for Node teardown hanging in uv__threadpool_cleanup. The runtime
 // has persisted state, closed its listener and released authority. SIGKILL
 // bypasses native exit hooks; its signal status is not a failed Arc stop.
 const terminate = () => process.kill(process.pid, "SIGKILL");
 const deadline = setTimeout(terminate, 100);
 let pending = 2;
 const flushed = () => { if (--pending === 0) { clearTimeout(deadline); terminate(); } };
 // stdout carries readiness; stderr is service.log. Flush only best-effort.
 for (const stream of [process.stdout, process.stderr]) {
  try { stream.write("", flushed); } catch { flushed(); }
 }
}
export async function startService(agentDir: string, host: string, ready: (value: unknown) => void) {
 const lock = inheritedLock(), extensionPath = join(lock.store, "versions", serviceVersion, "ask-limit.mjs");
 installFile(extensionPath, __ARC_OUTPUT_LIMIT_SOURCE__);
 return runtime({ agentDir, host, serviceVersion, releaseLine, buildOrder, extensionPath, ready, exit: exitResident });
}
async function lockedMain(operation: LockedOperation, body: string) {
 const agentDir = operation.agentDir ?? agentDirectory(), store = join(agentDir, "ampi-arc");
 const reply = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
 if (operation.op === "ensure" && (!operation.storeIncarnation || operation.storeIncarnation !== storeIncarnation(store))) {
  reply(serviceStatus(operation.host, { state: "stopped", running: false, pid: null, serviceLogPath: join(store, "service.log") })); return;
 }
 const lock = inheritedLock(), control = controlStore(lock);
 let selected = control.read().selected;
 // A stop fences every ensure admitted before it, including launchers that
 // have not acquired the lifetime lock and callers retrying LOCK_BUSY.
 let stop, fenceFault: Error & { recoveryUncertainty?: "unknown-prior-stop" } | undefined;
 try { stop = operation.op === "stop" ? fenceStop(lock, operation.forcedRecovery) : readStop(lock.store); }
 catch (error) { if (operation.op !== "stop") throw error; fenceFault = error as typeof fenceFault; }
 const pending = stop?.recovery;
 if (pending || fenceFault) {
  // The selected bundle may predate recovery. Current entry owns this no-work path.
  await runtime({ agentDir, host: operation.host, serviceVersion, releaseLine, buildOrder,
   extensionPath: join(lock.store, "versions", serviceVersion, "ask-limit.mjs"), maintenance: { generation: pending?.generation ?? null, uncertainty: stop?.uncertainty ?? fenceFault?.recoveryUncertainty, ...(fenceFault ? { fencePending: true, fault: fenceFault.message } : {}) }, ready: reply, exit: exitResident });
  return;
 }
 if (operation.op === "status" || operation.op === "stop" || operation.stopGeneration !== stopGeneration(lock.store)) {
  reply(serviceStatus(operation.host, { releaseLine: selected?.id === serviceVersion ? releaseLine : null,
   buildOrder: selected?.order ?? null, serviceVersion: selected?.id ?? null, stamp: selected,
   serviceLogPath: join(lock.store, "service.log"), running: false, pid: null,
   storeSchema: STORE_SCHEMA, bundleSchema: STORE_SCHEMA, state: "stopped" }));
  return;
 }
 if (selected && compare(stamp, selected) === "older") {
  reply(serviceStatus(operation.host, { state: "error", stamp: selected, outcome: "refused", code: "build-mismatch", detail: `This AmPi is older than ${operation.host}. Update it.` })); return;
 }
 if (!selected || compare(stamp, selected) === "newer") {
  installFile(join(lock.store, "versions", serviceVersion, "service.mjs"), body);
  selected = control.select(stamp);
 }
 // The engine and lifetime lock remain in the same process.
 const module = await import(pathToFileURL(join(lock.store, "versions", selected.id, "service.mjs")).href);
 await module.startService(agentDir, operation.host, reply);
}
type LaunchPhase = "unknown" | "lock" | "startup";
class LaunchDeadline extends Error {
 readonly phase: LaunchPhase;
 constructor(phase: LaunchPhase) { super("Arc service startup timed out"); this.phase = phase; }
}
function launch(staging: string, store: string, operation: LockedOperation): Promise<any> {
 return new Promise((resolve, reject) => {
  const log = openSync(join(store, "service.log"), "a", 0o600), logStart = fstatSync(log).size;
  let child;
  try { child = launchLocked(store, [staging, "_locked", JSON.stringify(operation)], { detached: true, stdio: ["ignore", "pipe", log, "pipe"], env: { ...process.env, AMPI_ARC_PARENT_FD: "3" } }); }
  finally { closeSync(log); }
  const parent = child.stdio[3] as Socket;
  // W enters lock acquisition; L starts the engine. Legacy guardians send neither.
  // These bytes do not accept readiness or extend the launch deadline.
  let phase: LaunchPhase = "unknown";
  parent.on("data", bytes => {
   for (const byte of bytes) {
    if (phase === "unknown" && byte === 87) phase = "lock";
    else if (phase === "lock" && byte === 76) phase = "startup";
   }
  });
  parent.on("error", () => {}); parent.resume();
  let output = "", ready = false, outcome: { result: any } | { error: unknown } | undefined;
  // Only readiness transfers the child to its independent resident lifetime.
  // Every other launch outcome completes after close has reaped the child.
  const reap = (value: NonNullable<typeof outcome>) => {
   if (ready || outcome) return;
   outcome = value; clearTimeout(timer);
   // The guardian handles group termination by killing and reaping Node.
   try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGKILL"); }
  };
  const timer = setTimeout(() => reap({ error: new LaunchDeadline(phase) }), operation.timeoutMs ?? 30_000);
  child.on("error", e => reap({ error: Object.assign(new Error(`Arc service launcher could not start: ${e.message}`), (e as NodeJS.ErrnoException).code === "ENOENT" ? { state: "cannot-start", prerequisite: "perl" } : { state: "error" }) }));
  child.stdout!.on("data", chunk => {
   output += chunk; const at = output.indexOf("\n"); if (at < 0 || ready || outcome) return;
   try {
    const result = JSON.parse(output.slice(0, at));
    if (result?.running !== true) { reap({ result }); return; }
    ready = true; clearTimeout(timer); parent.end("R"); child.stdout!.destroy(); child.unref(); resolve(result);
   } catch (error) { reap({ error }); }
  });
  child.on("close", code => {
   clearTimeout(timer); if (ready) return;
   if (outcome) { if ("error" in outcome) reject(outcome.error); else resolve(outcome.result); return; }
   if (code === LOCK_BUSY) { resolve({ lockBusy: true }); return; }
   let cause: string | undefined;
   try {
    const fd = openSync(join(store, "service.log"), "r");
    try { const size = fstatSync(fd).size, bytes = Buffer.alloc(Math.min(Math.max(0, size - logStart), 8192)); readSync(fd, bytes, 0, bytes.length, Math.max(logStart, size - bytes.length)); cause = bytes.toString().split("\n").reverse().find(line => /(?:Error|error):/.test(line)); }
    finally { closeSync(fd); }
   } catch {}
   reject(new Error(cause?.trim() ?? `Arc service launcher stopped before reporting readiness (exit ${code})`));
  });
 });
}
export async function manage(body: string, operation: ManageOperation): Promise<any> {
 if (!operation.host || !["ensure", "stop", "status"].includes(operation.op)) throw new Error("Invalid Arc maintenance command");
 const agentDir = operation.agentDir ?? agentDirectory(), store = join(agentDir, "ampi-arc");
 const budget = operation.timeoutMs ?? (operation.op === "stop" ? 20000 : 330_000);
 const deadline = Date.now() + budget, serviceLogPath = join(store, "service.log");
 const recoveryAt = Date.now() + Math.min(5000, budget / 4);
 let command: LockedOperation;
 try {
  if (operation.op === "ensure") mkdirSync(store, { recursive: true, mode: 0o700 });
  command = { ...operation, agentDir, ...(operation.op === "ensure" ? { storeIncarnation: storeIncarnation(store, true), stopGeneration: stopGeneration(store) } : {}) };
 } catch (error) { throw Object.assign(error as Error, { serviceLogPath }); }
 let staging: string | undefined, replacing = false, sawBusy = false, recovered = false, stopRequested = false, sawLive = false;
 let recoveryUncertainty: "unknown-prior-stop" | undefined, recoveryVisibility: RecoveryVisibility | undefined;
 let recovery: (Extract<Awaited<ReturnType<typeof recoverOwner>>, { kind: "terminated" }> & { unverified?: true }) | undefined, recoveryAttempted = false;
 const macRefuses = process.platform === "darwin" && !operation.forceUnverified;
 const canSignal = process.platform === "linux" || process.platform === "darwin" && operation.forceUnverified === true;
 function finish(result: any, acquired = false) {
  recoveryUncertainty ??= result.recoveryUncertainty;
  if (recoveryUncertainty) result = { ...result, recoveryUncertainty };
  if (recoveryVisibility) result = { ...result, recoveryVisibility };
  if (!recovery) return result;
  const confirmed = acquired && result.state === "stopped" && result.running === false;
  const facts: RecoveryResult = { pid: recovery.pid, signals: recovery.signals, oldHolderEnded: true, interveningDispatch: "unknown", ...(recovery.visibility ? { visibility: recovery.visibility } : {}), ...(recovery.unverified ? { evidence: "unverified" as const } : {}),
   ...(confirmed ? { cancellation: "confirmed" as const } : { cancellation: "unconfirmed" as const,
    reason: result.state === "fault" ? result.recoveryFault ?? result.detail ?? "queued-Build cancellation could not be persisted" : "lock acquisition was not confirmed",
    action: result.state === "fault" ? (result.recoveryAction ?? `Repair ${store}: ${result.detail}; then run ampi arc stop --host ${operation.host} again`).replace(/\.$/, "") : `Run ampi arc stop --host ${operation.host} again` }) };
  return { ...result, kind: "forced-recovery", recovery: facts };
 }
 const failedReplacement = (cause: string) => serviceStatus(operation.host, { state: "error", code: "replacement-failed", serviceLogPath, detail: replacementText(operation.host, cause, serviceLogPath) });
 const busy = () => replacing ? failedReplacement("timed out waiting for the service to drain and release its lock") : serviceStatus(operation.host, { state: "busy", kind: "busy", serviceLogPath, detail: "Arc service holds its lock but does not answer" });
 async function timedOut() {
  if (replacing) return busy();
  // A final bounded probe distinguishes a responsive drain from a silent owner.
  // Earlier replies cannot prove that the resident still answers.
  try { return finish(await controlRequest(store, { op: "status", refreshAuth: false }, 1000)); }
  catch {
   if (operation.op === "stop" && macRefuses) {
    const inspection = await inspectMacRecovery(store, operation.host);
    if (inspection.kind === "responsive") return inspection.live;
    if (inspection.kind === "refused") return serviceStatus(operation.host, { state: "busy", kind: "recovery-refused", serviceLogPath, detail: inspection.detail });
   }
   return finish(busy());
  }
 }
 try {
  while (true) {
   if (operation.op === "ensure" && command.storeIncarnation !== storeIncarnation(store)) return serviceStatus(operation.host, { state: "stopped", running: false, pid: null, serviceLogPath });
   let live: any;
   try { live = await controlRequest(store, { op: "status", refreshAuth: operation.op === "status" }, Math.max(1, Math.min(operation.op === "status" ? 20_000 : 1000, deadline - Date.now()))); } catch {}
   if (live) {
    recoveryUncertainty ??= live.recoveryUncertainty;
    sawLive = true;
    if (operation.op === "status") return live;
    if (operation.op === "ensure" && live.kind === "forced-recovery") {
     recovered = true;
     if (live.state === "fault") return live;
    } else if (operation.op === "ensure") {
     const order = compare(stamp, live.stamp);
     if (order === "same") return live;
     if (order === "older") return { ...live, state: "error", outcome: "refused", code: "build-mismatch", detail: `This AmPi is older than ${operation.host}. Update it.` };
     // The runtime repeats the comparison. A racing older offering cannot
     // drain an engine that another client has already installed.
     replacing = true;
     // Drain can remove the socket after status. The lifetime lock decides
     // whether this launcher can install; a lost offer reply is not failure.
     try { await controlRequest(store, { op: "offer", stamp }, Math.max(1, Math.min(1000, deadline - Date.now()))); } catch {}
    } else {
     if (stopRequested && live.kind === "forced-recovery" && live.state === "fault") return finish(live);
     stopRequested = true;
     // Stop can remove the socket after status. Only lifetime-lock acquisition
     // below proves completion; a lost control acknowledgement proves neither outcome.
     try {
      const stopping = await controlRequest(store, { op: "stop" }, Math.max(1, Math.min(1000, deadline - Date.now())));
      if (stopping.kind === "forced-recovery" && stopping.state === "fault") return finish(stopping);
     } catch {}
    }
   }
   if (Date.now() >= deadline) return timedOut();
   if (!staging) {
    if (operation.op !== "ensure") mkdirSync(store, { recursive: true, mode: 0o700 });
    staging = join(store, "launch-" + randomUUID() + ".mjs");
    writeFileSync(staging, body, { mode: 0o600, flag: "wx" });
   }
   const result = await launch(staging, store, { ...command, timeoutMs: Math.max(1, deadline - Date.now()) });
   recoveryUncertainty ??= result.recoveryUncertainty;
   if (result.kind === "forced-recovery") {
    recovered = true; stopRequested = true; command.forcedRecovery = false;
    if (result.state === "fault") return finish(result);
    continue;
   }
   if (!result.lockBusy) return finish(replacing && result.state === "error" ? failedReplacement(result.detail ?? "the replacement service could not start") : recovered ? { ...result, kind: "forced-recovery" } : operation.op === "stop" && result.state === "stopped" ? { ...result, kind: sawLive ? "orderly-stop" : "not-running" } : result, true);
   sawBusy = true;
   if (operation.op === "stop" && !live && macRefuses && Date.now() >= recoveryAt) {
    const inspection = await inspectMacRecovery(store, operation.host);
    if (inspection.kind === "refused" && await probeRecoveryLock(store) !== "free") return serviceStatus(operation.host, { state: "busy", kind: "recovery-refused", serviceLogPath, detail: inspection.detail });
   }
   if (operation.op === "stop" && !live && canSignal && !recoveryAttempted && Date.now() >= recoveryAt) {
    recoveryAttempted = true;
    const left = Math.max(0, deadline - Date.now()), unverified = process.platform === "darwin";
    const attempt = await recoverOwner(store, operation.host, Math.min(10000, left / 2), Math.min(2000, left / 4), ...(unverified ? [macUnverifiedPorts(store)] : []));
    recoveryVisibility = attempt.visibility;
    if (attempt.kind === "refused") return serviceStatus(operation.host, { state: "busy", kind: "recovery-refused", serviceLogPath, detail: attempt.detail, ...(attempt.visibility ? { recoveryVisibility: attempt.visibility } : {}) });
    if (attempt.kind === "terminated") {
     recovery = unverified ? { ...attempt, unverified: true } : attempt;
     command.forcedRecovery = true;
    }
   }
   if (Date.now() >= deadline) return timedOut();
   await new Promise(resolve => setTimeout(resolve, 100));
  }
 } catch (error) {
  if (operation.op === "ensure" && command.storeIncarnation !== storeIncarnation(store)) return serviceStatus(operation.host, { state: "stopped", running: false, pid: null, serviceLogPath });
  if (replacing && error instanceof LaunchDeadline && error.phase === "lock") return timedOut();
  if (replacing) return failedReplacement((error as Error).message);
  if (sawBusy && Date.now() >= deadline) return timedOut();
  if (recovery) return finish(serviceError(operation.host, error));
  throw Object.assign(error as Error, { serviceLogPath: join(store, "service.log") });
 }
 finally { if (staging) rmSync(staging, { force: true }); }
}
if (process.argv[2] === "_locked" && import.meta.url === pathToFileURL(realpathSync(process.argv[1]!)).href) {
 lockedMain(JSON.parse(process.argv[3]!), readFileSync(process.argv[1]!, "utf8")).catch(error => {
  const operation: LockedOperation = JSON.parse(process.argv[3]!), store = join(operation.agentDir ?? agentDirectory(), "ampi-arc");
  if (operation.op === "ensure" && operation.storeIncarnation !== storeIncarnation(store)) {
   process.stdout.write(JSON.stringify(serviceStatus(operation.host, { state: "stopped", running: false, pid: null, serviceLogPath: join(store, "service.log") })) + "\n"); return;
  }
  process.stdout.write(JSON.stringify(serviceError(operation.host, Object.assign(error, { serviceLogPath: join(store, "service.log") }))) + "\n"); process.exitCode = 1;
 });
}
