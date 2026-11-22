// Only explicit stop enters recovery. Kernel ownership and a pinned process
// handle govern Linux signals. macOS refuses actuation from open-file evidence
// unless the owner passes --force-unverified; one TERM/KILL loop serves both.
import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { controlRequest } from "./connection.ts";
import { storeIncarnation } from "./store.ts";
import { inspectLinuxRecovery, pinRecoveryTarget, sameRecoveryCandidate, type LinuxInspection, type RecoveryCandidate, type BoundRecoveryTarget, type SignalReceipt, type RecoveryVisibility } from "./recovery-linux.ts";
const exec = promisify(execFile);
const PROBE = String.raw`use Fcntl qw(:flock :DEFAULT); sysopen(my $lock,$ARGV[0],O_RDWR) or exit(74); flock($lock,LOCK_EX|LOCK_NB) or exit(73); close($lock);`;
export async function probeRecoveryLock(store: string): Promise<"free" | "held" | "unknown"> {
 try {
  const path = join(store, "service.lock"), before = statSync(path);
  let result: "free" | "held";
  try { await exec("perl", ["-e", PROBE, path], { timeout: 2000 }); result = "free"; }
  catch (error) { if ((error as { code?: unknown }).code !== 73) return "unknown"; result = "held"; }
  const after = statSync(path);
  return before.isFile() && before.ino === after.ino && before.dev === after.dev ? result : "unknown";
 } catch { return "unknown"; }
}
// macOS evidence: lsof lists the openers of the lock inode; ps gives the owner,
// start second and command. Open-file evidence never proves flock ownership,
// so only an explicit `--force-unverified` stop signals from it.
type MacProcess = { uid: number; zombie: boolean; start: string; command: string };
async function macProcess(pid: number): Promise<MacProcess | undefined> {
 try {
  const { stdout } = await exec("/bin/ps", ["-p", String(pid), "-o", "uid=", "-o", "stat=", "-o", "lstart=", "-o", "command="], { timeout: 2000, env: { ...process.env, LC_ALL: "C" } });
  const row = stdout.trim().match(/^(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/);
  if (!row) throw new Error("Unreadable process row");
  return { uid: Number(row[1]), zombie: row[2]!.startsWith("Z"), start: row[3]!.split(/\s+/).join(" "), command: row[4]! };
 } catch (error) { if ((error as { code?: unknown }).code === 1) return undefined; throw error; }
}
export type MacHolder = { kind: "found"; candidate: RecoveryCandidate } | { kind: "refused"; reason: string; pid?: number; pids?: number[] };
export async function inspectMacHolder(store: string): Promise<MacHolder> {
 const changed = (pid?: number): MacHolder => ({ kind: "refused", reason: "the process or store changed", ...(pid ? { pid } : {}) });
 try {
  const canonical = realpathSync(store), path = join(canonical, "service.lock"), before = statSync(path);
  const { stdout } = await exec("/usr/sbin/lsof", ["-nP", "-F0pufn", "--", path], { timeout: 2000, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
  const pids = [...stdout.matchAll(/(?:^|\0|\n)p(\d+)\0/g)].map(match => Number(match[1]));
  if (!pids.length || new Set(pids).size !== pids.length) return { kind: "refused", reason: "the lock file openers are ambiguous" };
  const matches: RecoveryCandidate[] = [];
  for (const pid of pids) {
   const proc = await macProcess(pid);
   if (!proc) return changed(pid);
   const row = proc.command.match(/^(\S+)\s+(\S+)\s+_locked\s+(\{.*\})$/);
   if (!row || basename(row[1]!) !== "node" || !/^launch-[0-9a-f-]{36}\.mjs$/.test(basename(row[2]!))) continue;
   if (proc.uid !== process.getuid?.()) return { kind: "refused", reason: "runs as another user", pid };
   const operation = JSON.parse(row[3]!);
   if (typeof operation.agentDir !== "string" || realpathSync(dirname(row[2]!)) !== canonical || realpathSync(resolve(operation.agentDir, "ampi-arc")) !== canonical) return { kind: "refused", reason: "serves a different store", pid };
   if (operation.op !== "ensure" || operation.storeIncarnation !== storeIncarnation(canonical)) return changed(pid);
   matches.push({ pid, generation: proc.start, argv: [proc.command], lockKey: "open", fd: "lsof", incarnation: operation.storeIncarnation, dev: before.dev, ino: before.ino });
  }
  const after = statSync(path);
  if (before.dev !== after.dev || before.ino !== after.ino) return changed();
  if (!matches.length) return { kind: "refused", reason: "no Arc service process matches the held lock" };
  if (matches.length > 1) return { kind: "refused", reason: `${matches.length} processes match the Arc service`, pids: matches.map(match => match.pid) };
  if (pids.length !== 1) return { kind: "refused", reason: "another process has the lock file open", pid: matches[0]!.pid };
  return { kind: "found", candidate: matches[0]! };
 } catch { return { kind: "refused", reason: "process evidence is unavailable" }; }
}
// A hub ensure opens the lock file for a moment before its flock fails, so a
// second opener can be transient. Poll that refusal briefly before reporting it.
const transientMac = new Set(["another process has the lock file open", "the lock file openers are ambiguous"]);
export async function settleMacHolder(inspect: () => Promise<MacHolder>, wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)), polls = 3, pollMs = 100): Promise<MacHolder> {
 let holder = await inspect();
 for (let poll = 0; poll < polls && holder.kind === "refused" && transientMac.has(holder.reason); poll++) { await wait(pollMs); holder = await inspect(); }
 return holder;
}
export type MacInspection = { kind: "free" } | { kind: "responsive"; live: unknown } | { kind: "refused"; detail: string };
export async function inspectMacRecovery(store: string, host: string): Promise<MacInspection> {
 const refuse = (detail: string): MacInspection => ({ kind: "refused", detail });
 const later = `No signal sent. If the next Build still reports busy, restart the machine ${host}.`;
 const lock = await probeRecoveryLock(store);
 if (lock === "free") return { kind: "free" };
 if (lock !== "held") return refuse(`Refused: Arc lock ownership could not be verified. ${later}`);
 try { return { kind: "responsive", live: await controlRequest(store, { op: "status", refreshAuth: false }, 250) }; } catch { /* Inspection does not replace the final socket check. */ }
 const holder = await settleMacHolder(() => inspectMacHolder(store));
 try { return { kind: "responsive", live: await controlRequest(store, { op: "status", refreshAuth: false }, 250) }; } catch { /* No signal follows even when the socket remains silent. */ }
 if (holder.kind === "found") return refuse(`Refused on macOS: pid ${holder.candidate.pid} matches the Arc service for ${store} and has its lock file open, but macOS cannot prove that it holds the lock. No signal sent. To stop it anyway, run \`ampi arc stop --host ${host} --force-unverified\`.`);
 if (holder.reason === "runs as another user" || holder.reason === "serves a different store") return refuse(`Refused: pid ${holder.pid} has the lock file open but ${holder.reason}. AmPi signals only its own Arc service. ${later}`);
 if (holder.reason === "no Arc service process matches the held lock") return refuse(`Refused: the Arc lock is held, but no Arc service process matches it. ${later}`);
 if (holder.pids) return refuse(`Refused: ${holder.pids.length} processes match the Arc service for ${store} (pids ${holder.pids.join(", ")}). No signal sent. Stop the hubs on ${host}, then run this again.`);
 if (transientMac.has(holder.reason)) return refuse(`Refused: another process has the Arc lock file open. No signal sent. Stop the hubs on ${host}, then run this again.`);
 return refuse(`Refused: Arc lock ownership could not be verified. ${later}`);
}
/** macOS has no process handle: the start second and full command bind the PID between rechecks. */
async function pinMacTarget(candidate: RecoveryCandidate, store: string): Promise<BoundRecoveryTarget | "gone" | undefined> {
 const same = async () => { const proc = await macProcess(candidate.pid); return Boolean(proc && !proc.zombie && proc.start === candidate.generation && proc.command === candidate.argv[0]); };
 try { if (!await same()) return "gone"; } catch { return undefined; }
 return {
  inspect: async () => { const holder = await settleMacHolder(() => inspectMacHolder(store)); return holder.kind === "found" && holder.candidate.pid !== candidate.pid ? { kind: "refused", reason: "the process or store changed", pid: candidate.pid } : holder; },
  signal: async signal => { try { process.kill(candidate.pid, signal); return { sent: true }; } catch (error) { return { sent: false, errno: String((error as { code?: unknown }).code ?? "unknown") }; } },
  ended: async () => !await same(),
  close: async () => {},
 };
}

export type RecoveryPorts = {
 probe(): Promise<"free" | "held" | "unknown">;
 inspect(): Promise<LinuxInspection>;
 responsive(): Promise<unknown>;
 pin(candidate: RecoveryCandidate): Promise<BoundRecoveryTarget | "gone" | undefined>;
 wait(ms: number): Promise<void>;
};
export type OwnerRecovery = ({ kind: "free" } | { kind: "responsive"; live: unknown } | { kind: "refused"; detail: string } | { kind: "terminated"; pid: number; signals: ("SIGTERM" | "SIGKILL")[] }) & { visibility?: RecoveryVisibility };
function sharedPorts(store: string): Pick<RecoveryPorts, "probe" | "responsive" | "wait"> {
 return { probe: () => probeRecoveryLock(store), wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
  responsive: async () => { try { return await controlRequest(store, { op: "status", refreshAuth: false }, 250); } catch { return undefined; } } };
}
export const linuxRecoveryPorts = (store: string): RecoveryPorts => ({ ...sharedPorts(store), inspect: () => inspectLinuxRecovery(store), pin: candidate => pinRecoveryTarget(candidate, store) });
/** Only `ampi arc stop --force-unverified` selects these ports. */
export const macUnverifiedPorts = (store: string): RecoveryPorts => ({ ...sharedPorts(store), inspect: () => settleMacHolder(() => inspectMacHolder(store)), pin: candidate => pinMacTarget(candidate, store) });
export async function recoverOwner(store: string, host: string, termMs: number, killMs: number, ports: RecoveryPorts = linuxRecoveryPorts(store)): Promise<OwnerRecovery> {
 const signals: ("SIGTERM" | "SIGKILL")[] = [];
 const gaps = new Map<number, RecoveryVisibility["inaccessibleProcesses"][number]>();
 function observe(inspection: LinuxInspection) {
  for (const gap of inspection.visibility?.inaccessibleProcesses ?? []) {
   const combined = gaps.get(gap.pid) ?? { pid: gap.pid, failures: [] };
   for (const failure of gap.failures) if (!combined.failures.some(f => f.stage === failure.stage && f.errno === failure.errno)) combined.failures.push(failure);
   gaps.set(gap.pid, combined);
  }
  return inspection;
 }
 const evidence = () => gaps.size ? { visibility: { inaccessibleProcesses: [...gaps.values()] } } : {};
 const refuse = (detail: string): OwnerRecovery => ({ kind: "refused", detail, ...evidence() });
 // The next step names the lightest manual action: the pid, then the machine.
 const later = (pid?: number) => `If the next Build still reports busy, ${pid ? `end pid ${pid} or ` : ""}restart the machine ${host}.`;
 const noSignal = (reason: string, next = later()) => refuse(`Refused: ${reason}. No signal sent. ${next}`);
 const unverified = (reason: string, pid?: number) => noSignal(`AmPi could not verify ${pid ? `pid ${pid}` : "the Arc lock"} (${reason})`, transientMac.has(reason) ? `Stop the hubs on ${host}, then run this again.` : later(pid));
 const lock = await ports.probe();
 if (lock === "free") return { kind: "free" };
 if (lock !== "held") return noSignal("Arc lock ownership could not be verified");
 const live = await ports.responsive(); if (live) return { kind: "responsive", live };
 const inspection = observe(await ports.inspect());
 if (inspection.kind !== "found") {
  if (inspection.reason === "no Arc service process matches the held lock") return noSignal("the Arc lock is held, but no Arc service process matches it");
  if (["runs as another user", "serves a different store"].includes(inspection.reason)) return noSignal(`${inspection.pid ? `pid ${inspection.pid} ` : ""}${inspection.reason}`);
  return unverified(inspection.reason, inspection.pid);
 }
 const candidate = inspection.candidate, pinned = await ports.pin(candidate);
 if (pinned === "gone") return { kind: "free", ...evidence() };
 if (!pinned) return unverified("a bound process handle is unavailable", candidate.pid);
 const target: BoundRecoveryTarget = pinned;
 const terminated = (): OwnerRecovery => ({ kind: "terminated", pid: candidate.pid, signals, ...evidence() });
 const risk = "A Build that the signals interrupted may have charged a model call. Another Arc service may also have started a Build and charged one.";
 const sentLine = () => `Sent ${signals.join(" and ")}${signals.length === 1 ? " only" : ""}.`;
 const changed = () => signals.length ? refuse(`Recovery halted: pid ${candidate.pid} changed before the next signal.\n${sentLine()} AmPi cannot confirm that the old Arc service stopped.\n${risk}\nRun ampi arc stop --host ${host} again.`) : unverified("process identity changed before the next signal", candidate.pid);
 async function waitEnded(ms: number) {
  const end = Date.now() + ms;
  while (true) { if (await target.ended()) return true; if (Date.now() >= end) return false; await ports.wait(Math.min(50, end - Date.now())); }
 }
 try {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
   if (signals.length && await target.ended()) return terminated();
   const held = await ports.probe();
   if (held !== "held") return signals.length ? changed() : held === "free" ? { kind: "free", ...evidence() } : noSignal("Arc lock ownership could not be verified");
   const response = await ports.responsive();
   if (response) {
    if (!signals.length) return noSignal("an Arc service now answers; recovery will not signal it");
    const successor = typeof response === "object" && "pid" in response && Number.isInteger(response.pid) && response.pid !== candidate.pid;
    return refuse(`Recovery halted: ${successor ? "a new" : "the"} Arc service on ${host} now answers.\n${sentLine()} AmPi sent no further signal. ${successor ? "The new service" : "The service"} is running.\n${risk}\nCheck your model provider's usage page.`);
   }
   const current = observe(await target.inspect());
   if (await target.ended()) return signals.length ? terminated() : { kind: "free", ...evidence() };
   if (current.kind !== "found") return signals.length ? changed() : unverified(current.reason, current.pid ?? candidate.pid);
   if (!sameRecoveryCandidate(candidate, current.candidate)) return changed();
   let sent: SignalReceipt;
   try { sent = await target.signal(signal); }
   catch { return refuse(`Recovery halted: ${signal} was attempted for pid ${candidate.pid}, but its result is unknown.\n${signals.length ? sentLine() : "No earlier signal was sent."}\n${risk}\nRun ampi arc stop --host ${host} again.`); }
   if (!sent.sent) {
    if (sent.errno === "ESRCH" || await target.ended()) return signals.length ? terminated() : { kind: "free", ...evidence() };
    if (!signals.length) return noSignal(`${signal} failed for pid ${candidate.pid} (${sent.errno})`);
    const retained = observe(await target.inspect());
    if (retained.kind !== "found" || !sameRecoveryCandidate(candidate, retained.candidate) || await ports.probe() !== "held") return changed();
    return refuse(`Recovery halted: AmPi could not send SIGKILL to pid ${candidate.pid} (${sent.errno}).\nSent SIGTERM only. The Arc service is not stopped, and it still holds the lock.\n${risk}\nRestart the machine ${host}.`);
   }
   signals.push(signal);
   if (await waitEnded(signal === "SIGTERM" ? termMs : killMs)) return terminated();
  }
  const final = observe(await target.inspect());
  if (final.kind !== "found" || !sameRecoveryCandidate(candidate, final.candidate)) return changed();
  return refuse(`Recovery halted: pid ${candidate.pid} still holds the lock.\nSent SIGTERM and SIGKILL. The Arc service is not stopped.\n${risk}\nRestart the machine ${host}.`);
 } catch {
  return signals.length ? refuse(`Recovery halted: process evidence became unavailable.\n${sentLine()} AmPi cannot confirm that the old Arc service stopped.\n${risk}\nRun ampi arc stop --host ${host} again.`) : unverified("process evidence became unavailable", candidate.pid);
 } finally { await target.close(); }
}
