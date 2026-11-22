// Kernel flock evidence identifies an inherited descriptor, not necessarily
// the PID printed in /proc/locks. Only a pinned pidfd can actuate its process.
import { spawn } from "node:child_process";
import { readFile, readdir, stat, readlink, open, type FileHandle } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { getSystemErrorName } from "node:util";
import { storeIncarnation } from "./store.ts";
export type RecoveryCandidate = { pid: number; generation: string; argv: string[]; lockKey: string; fd: string; incarnation: string; dev: number; ino: number };
export type RecoveryVisibility = { inaccessibleProcesses: { pid: number; failures: { stage: string; errno: "EACCES" | "EPERM" }[] }[] };
export type LinuxInspection = ({ kind: "found"; candidate: RecoveryCandidate } | { kind: "refused"; reason: string; pid?: number }) & { visibility?: RecoveryVisibility };
function matchesLockTuple(record: string, dev: number, ino: number): boolean {
 const tuple = record.split(" ")[4]?.match(/^([0-9a-f]+):([0-9a-f]+):(\d+)$/i);
 if (!tuple) return false;
 const device = BigInt(dev);
 const major = (device >> 8n & 0xfffn) | (device >> 32n & 0xfffff000n);
 const minor = (device & 0xffn) | (device >> 12n & 0xffffff00n);
 return BigInt("0x" + tuple[1]) === major && BigInt("0x" + tuple[2]) === minor && BigInt(tuple[3]!) === BigInt(ino);
}
export function kernelFlocks(text: string): string[] {
 return text.split("\n").flatMap(line => {
  const match = line.match(/^(?:lock:\s*)?\d+:\s+(FLOCK\s+ADVISORY\s+WRITE\s+-?\d+\s+[0-9a-f]+:[0-9a-f]+:\d+\s+0\s+EOF)\s*$/i);
  return match ? [match[1]!.trim().split(/\s+/).join(" ")] : [];
 });
}
const vanished = (error: unknown) => ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "");
type ProcAnchor = { pid: number; path: string };
export type RecoveryInspectionIO = {
 readFile(path: string, encoding: "utf8"): Promise<string>;
 readdir(path: string): Promise<string[]>;
 stat(path: string): Promise<{ uid: number; dev: number; ino: number; isFile(): boolean }>;
 readlink(path: string): Promise<string>;
};
const inspectionIO: RecoveryInspectionIO = { readFile, readdir, stat, readlink };
async function procGeneration(proc: string, io = inspectionIO): Promise<string | undefined> {
 const { readFile } = io;
 const [record, boot] = await Promise.all([readFile(join(proc, "stat"), "utf8"), readFile("/proc/sys/kernel/random/boot_id", "utf8")]);
 const fields = record.slice(record.lastIndexOf(")") + 2).trim().split(/\s+/);
 if (["Z", "X"].includes(fields[0]!)) return;
 if (!/^\d+$/.test(fields[19] ?? "") || !boot.trim()) throw new Error("Invalid process generation");
 return `linux:${boot.trim()}:${fields[19]}`;
}
export async function inspectLinuxRecovery(store: string, anchor?: ProcAnchor, io = inspectionIO): Promise<LinuxInspection> {
 const { readFile, readdir, stat, readlink } = io;
 const gaps = new Map<number, RecoveryVisibility["inaccessibleProcesses"][number]>();
 const evidence = () => gaps.size ? { visibility: { inaccessibleProcesses: [...gaps.values()] } } : {};
 const refused = (reason: string, pid?: number): LinuxInspection => ({ kind: "refused", reason, ...(pid ? { pid } : {}), ...evidence() });
 function inaccessible(error: unknown, pid: number, stage: string): boolean {
  const errno = (error as NodeJS.ErrnoException).code;
  if (pid === anchor?.pid || errno !== "EACCES" && errno !== "EPERM") return false;
  const gap = gaps.get(pid) ?? { pid, failures: [] };
  if (!gap.failures.some(f => f.stage === stage && f.errno === errno)) gap.failures.push({ stage, errno });
  gaps.set(pid, gap); return true;
 }
 try {
  const canonical = realpathSync(store), expected = await stat(join(canonical, "service.lock")), incarnation = storeIncarnation(canonical);
  if (!expected.isFile() || !Number.isSafeInteger(expected.dev) || !Number.isSafeInteger(expected.ino) || !incarnation) return refused("store identity is unavailable");
  const lockText = await readFile("/proc/locks", "utf8");
  if (lockText.split("\n").some(line => /\bFLOCK\b/.test(line) && !line.includes("->") && !/^\d+:\s+FLOCK\s+ADVISORY\s+(?:READ|WRITE)\s+-?\d+\s+[0-9a-f]+:[0-9a-f]+:\d+\s+0\s+EOF\s*$/i.test(line))) return refused("kernel flock evidence is malformed");
  const locks = new Set(kernelFlocks(lockText)), holders = new Map<number, { fd: string; lockKey: string }>();
  const uid = process.getuid?.(); if (uid === undefined) return refused("the current user is unknown");
  for (const entry of await readdir("/proc")) {
   if (!/^\d+$/.test(entry)) continue;
   const pid = Number(entry), proc = anchor?.pid === pid ? anchor.path : `/proc/${pid}`;
   let stage = "process-stat";
   try {
    if ((await stat(proc)).uid !== uid) continue;
    stage = "fdinfo-directory";
    for (const fd of await readdir(join(proc, "fdinfo"))) {
     let descriptorStage = "descriptor-stat";
     try {
      const named = await stat(join(proc, "fd", fd));
      if (named.dev !== expected.dev || named.ino !== expected.ino) continue;
      descriptorStage = "fdinfo-record";
      const text = await readFile(join(proc, "fdinfo", fd), "utf8"), records = kernelFlocks(text);
      if (!records.length) {
       if (/^lock:/m.test(text)) return refused("kernel flock evidence is malformed", pid);
       continue;
      }
      if (records.length !== 1 || !locks.has(records[0]!) || !matchesLockTuple(records[0]!, expected.dev, expected.ino)) return refused("kernel flock evidence is incomplete", pid);
      descriptorStage = "descriptor-recheck";
      const again = await stat(join(proc, "fd", fd));
      descriptorStage = "fdinfo-recheck";
      const repeated = kernelFlocks(await readFile(join(proc, "fdinfo", fd), "utf8"));
      if (again.dev !== named.dev || again.ino !== named.ino || JSON.stringify(records) !== JSON.stringify(repeated)) return refused("the locked descriptor changed during inspection", pid);
      const old = holders.get(pid);
      if (old && old.lockKey !== records[0]) return refused("kernel flock evidence is ambiguous", pid);
      holders.set(pid, { fd, lockKey: records[0]! });
     } catch (error) { if (!vanished(error) && !inaccessible(error, pid, descriptorStage)) return refused(`descriptor inspection is incomplete (${descriptorStage}: ${(error as NodeJS.ErrnoException).code ?? "unknown"})`, pid); }
    }
   } catch (error) { if (!vanished(error) && !inaccessible(error, pid, stage)) return refused(`process inspection is incomplete (${stage}: ${(error as NodeJS.ErrnoException).code ?? "unknown"})`, pid); }
  }
  if (!holders.size) return refused("no Arc service process matches the held lock");
  if (holders.size !== 1) return refused(`${holders.size} processes share the kernel flock`);
  const [pid, descriptor] = [...holders][0]!, proc = anchor?.pid === pid ? anchor.path : `/proc/${pid}`;
  if (anchor && pid !== anchor.pid) return refused("the visible holder changed", pid);
  if (gaps.has(pid)) return refused("the visible holder's own proof is incomplete", pid);
  if (await readlink(join(proc, "ns/pid")) !== await readlink("/proc/self/ns/pid")) return refused("the process namespace is ambiguous", pid);
  const uids = (await readFile(join(proc, "status"), "utf8")).match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m);
  if (!uids || uids.slice(1).some(value => Number(value) !== uid)) return refused("runs as another user", pid);
  const argv = (await readFile(join(proc, "cmdline"), "utf8")).split("\0");
  if (argv.at(-1) === "") argv.pop();
  if (argv.length !== 4 || argv[2] !== "_locked" || basename(await readlink(join(proc, "exe"))) !== "node" || !/^launch-[0-9a-f-]{36}\.mjs$/.test(basename(argv[1]!))) return refused("no Arc service process matches the held lock", pid);
  const operation = JSON.parse(argv[3]!);
  if (typeof operation.agentDir !== "string" || realpathSync(dirname(argv[1]!)) !== canonical || realpathSync(resolve(operation.agentDir, "ampi-arc")) !== canonical) return refused("serves a different store", pid);
  if (operation.op !== "ensure" || operation.storeIncarnation !== incarnation) return refused("the store incarnation does not match", pid);
  const generation = await procGeneration(proc, io), after = await stat(join(canonical, "service.lock"));
  if (!generation || after.dev !== expected.dev || after.ino !== expected.ino || incarnation !== storeIncarnation(canonical) || !kernelFlocks(await readFile("/proc/locks", "utf8")).includes(descriptor.lockKey)) return refused("the process or store changed", pid);
  return { kind: "found", candidate: { pid, generation, argv, ...descriptor, incarnation, dev: expected.dev, ino: expected.ino }, ...evidence() };
 } catch { return refused("kernel ownership evidence is unavailable"); }
}
export function sameRecoveryCandidate(a: RecoveryCandidate, b: RecoveryCandidate): boolean {
 return a.pid === b.pid && a.generation === b.generation && a.lockKey === b.lockKey && a.incarnation === b.incarnation && a.dev === b.dev && a.ino === b.ino && JSON.stringify(a.argv) === JSON.stringify(b.argv);
}
const PIDFD = String.raw`
use strict; use warnings; $|=1;
my $pid=int(shift @ARGV);
my $fd=syscall(434,$pid,0); if($fd<0){if(int($!)==3){print "gone\n";exit(0);}die "pidfd_open unavailable\n";}
open(my $info,'<',"/proc/$$/fdinfo/$fd") or die "pidfd evidence unavailable\n";
my $text=do{local $/;<$info>}; close($info);
die "pidfd binding changed\n" unless $text =~ /^Pid:\s+$pid\s*$/m;
print "ready $$ $fd\n";
while(my $line=<STDIN>){chomp($line);last unless $line eq '0' || $line eq '15' || $line eq '9';my $result=syscall(424,$fd,int($line),0,0);print "$result ".int($!)."\n";}
`;
export type SignalReceipt = { sent: true } | { sent: false; errno: string };
export type BoundRecoveryTarget = { inspect(): Promise<LinuxInspection>; signal(signal: "SIGTERM" | "SIGKILL"): Promise<SignalReceipt>; ended(): Promise<boolean>; close(): Promise<void> };
export async function pinRecoveryTarget(candidate: RecoveryCandidate, store: string): Promise<BoundRecoveryTarget | "gone" | undefined> {
 if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) return;
 const child = spawn("perl", ["-e", PIDFD, String(candidate.pid)], { stdio: ["pipe", "pipe", "ignore"] });
 const ended = new Promise<void>(resolve => { child.once("close", () => resolve()); child.once("error", () => resolve()); });
 const reader = createInterface({ input: child.stdout }), lines = reader[Symbol.asyncIterator]();
 let directory: FileHandle | undefined, gone = false;
 async function line(): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
   return await Promise.race([lines.next().then(result => { if (result.done) throw new Error("pidfd helper ended"); return result.value; }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("pidfd helper timed out")), 2000); })]);
  } finally { if (timer) clearTimeout(timer); }
 }
 async function close() {
  child.stdin.end();
  const timer = setTimeout(() => { child.kill("SIGKILL"); }, 2000);
  try { await ended; } finally { clearTimeout(timer); reader.close(); await directory?.close(); }
 }
 child.stdin.on("error", () => {});
 try {
  const first = await line();
  if (first === "gone") { await close(); return "gone"; }
  const ready = first.match(/^ready (\d+) (\d+)$/);
  if (!ready || Number(ready[1]) !== child.pid) throw new Error("pidfd helper identity changed");
  const binding = await readFile(`/proc/${child.pid}/fdinfo/${ready[2]}`, "utf8");
  if (!new RegExp(`^Pid:\\s+${candidate.pid}\\s*$`, "m").test(binding)) throw new Error("pidfd target changed");
  async function live() {
   child.stdin.write("0\n"); const [result, errno] = (await line()).split(" ").map(Number);
   if (result === 0) return true;
   if (errno === 3) return false;
   throw new Error("pidfd liveness is unavailable");
  }
  if (!await live()) { gone = true; throw new Error("process ended before proc anchoring"); }
  directory = await open(`/proc/${candidate.pid}`, "r");
  const proc = `/proc/self/fd/${directory.fd}`, anchor = { pid: candidate.pid, path: proc };
  const generation = await procGeneration(proc);
  if (generation === undefined || !await live()) { gone = true; throw new Error("process ended during proc anchoring"); }
  if (generation !== candidate.generation) throw new Error("process generation changed");
  return {
   async inspect() {
    if (!await live()) return { kind: "refused", reason: "the pinned process ended" };
    const result = await inspectLinuxRecovery(store, anchor);
    if (!await live() || await procGeneration(proc) !== candidate.generation) return { kind: "refused", reason: "the pinned process ended" };
    return result;
   },
   async signal(signal) {
    child.stdin.write(signal === "SIGTERM" ? "15\n" : "9\n");
    const fields = (await line()).match(/^(-?\d+) (\d+)$/); if (!fields) throw new Error("Invalid pidfd signal receipt");
    if (fields[1] === "0") return { sent: true };
    const errno = Number(fields[2]); return { sent: false, errno: errno > 0 ? getSystemErrorName(-errno) : "unknown errno" };
   },
   async ended() {
    if (!await live()) return true;
    try { return await procGeneration(proc) === undefined; }
    catch (error) { if (vanished(error) && !await live()) return true; throw error; }
   },
   close,
  };
 } catch { await close(); return gone ? "gone" : undefined; }
}
