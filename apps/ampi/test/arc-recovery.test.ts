import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { serviceStatus, serviceText, type RecoveryResult } from "../src/arc/service/status.ts";
import { recoverOwner, settleMacHolder, type MacHolder, type RecoveryPorts } from "../src/arc/service/recovery.ts";
import { kernelFlocks, inspectLinuxRecovery, type RecoveryInspectionIO, type RecoveryCandidate } from "../src/arc/service/recovery-linux.ts";

import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { storeIncarnation } from "../src/arc/service/store.ts";

function syntheticInventory(t: any) {
 const root = mkdtempSync(join(tmpdir(), "arc-inventory-")), store = join(root, "ampi-arc"); mkdirSync(store);
 t.after(() => rmSync(root, { force: true, recursive: true }));
 const incarnation = storeIncarnation(store, true), canonical = realpathSync(store), uid = process.getuid?.() ?? 0;
 const record = "1: FLOCK ADVISORY WRITE 4000 00:08:100 0 EOF\n";
 const operation = JSON.stringify({ op: "ensure", agentDir: realpathSync(root), storeIncarnation: incarnation });
 const files = new Map([
  ["/proc/locks", record], ["/proc/4123/fdinfo/3", "lock:\t" + record],
  ["/proc/4123/status", `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\n`],
  ["/proc/4123/cmdline", ["node", join(canonical, `launch-${randomUUID()}.mjs`), "_locked", operation, ""].join("\0")],
  ["/proc/4123/stat", "4123 (node) " + ["S", ...Array(18).fill("0"), "42"].join(" ")], ["/proc/sys/kernel/random/boot_id", "boot"]
 ]);
 const fail = (code: string) => { throw Object.assign(new Error(code), { code }); };
 const io: RecoveryInspectionIO = {
  readFile: async path => files.get(path) ?? fail("ENOENT"),
  stat: async () => ({ uid, dev: 8, ino: 100, isFile: () => true }),
  readdir: async path => path === "/proc" ? ["4123", "5000"] : path === "/proc/4123/fdinfo" ? ["3"] : [],
  readlink: async path => path.endsWith("/exe") ? "/synthetic/node" : "pid:[1]"
 };
 return { store, io, files, fail };
}

test("Arc inventory refuses a different fdinfo tuple despite matching fd stat", async t => {
 const f = syntheticInventory(t), wrong = "1: FLOCK ADVISORY WRITE 4000 00:08:101 0 EOF\n";
 f.files.set("/proc/locks", wrong); f.files.set("/proc/4123/fdinfo/3", "lock:\t" + wrong);
 assert.equal((await inspectLinuxRecovery(f.store, undefined, f.io)).kind, "refused");
});
test("Arc inventory binds Linux extended device numbers", async t => {
 const f = syntheticInventory(t), major = 0x1234n, minor = 0x56789n;
 const dev = Number((major & 0xfffn) << 8n | (major & ~0xfffn) << 32n | minor & 0xffn | (minor & ~0xffn) << 12n);
 const stat = f.io.stat; f.io.stat = async path => ({ ...await stat(path), dev });
 const record = "1: FLOCK ADVISORY WRITE 4000 1234:56789:100 0 EOF\n";
 f.files.set("/proc/locks", record); f.files.set("/proc/4123/fdinfo/3", "lock:\t" + record);
 assert.equal((await inspectLinuxRecovery(f.store, undefined, f.io)).kind, "found");
});
for (const failure of ["locks", "enumeration", "malformed", "candidate-other-fd"]) test(`Arc inventory refuses incomplete required proof (${failure})`, async t => {
 const f = syntheticInventory(t), list = f.io.readdir, read = f.io.readFile;
 if (failure === "locks") f.io.readFile = async (path, encoding) => path === "/proc/locks" ? f.fail("EACCES") : read(path, encoding);
 if (failure === "enumeration") f.io.readdir = async path => path === "/proc" ? f.fail("EPERM") : list(path);
 if (failure === "malformed") f.files.set("/proc/4123/fdinfo/3", "lock: malformed FLOCK record");
 if (failure === "candidate-other-fd") {
  f.io.readdir = async path => path === "/proc/4123/fdinfo" ? ["3", "4"] : list(path);
  f.io.readFile = async (path, encoding) => path === "/proc/4123/fdinfo/4" ? f.fail("EACCES") : read(path, encoding);
 }
 assert.equal((await inspectLinuxRecovery(f.store, undefined, f.io)).kind, "refused");
});

for (const errno of ["EACCES", "EPERM"]) test(`Arc inventory retains unrelated ${errno} visibility evidence`, async t => {
 const f = syntheticInventory(t), list = f.io.readdir;
 f.io.readdir = async path => path === "/proc/5000/fdinfo" ? f.fail(errno) : list(path);
 const result = await inspectLinuxRecovery(f.store, undefined, f.io);
 assert.equal(result.kind, "found", JSON.stringify(result));
 assert.deepEqual((result as any).visibility, { inaccessibleProcesses: [{ pid: 5000, failures: [{ stage: "fdinfo-directory", errno }] }] });
});
for (const stage of ["fdinfo-directory", "fdinfo-record"]) test(`Arc inventory never relaxes target ${stage} permission`, async t => {
 const f = syntheticInventory(t), list = f.io.readdir, read = f.io.readFile;
 if (stage === "fdinfo-directory") f.io.readdir = async path => path === "/proc/4123/fdinfo" ? f.fail("EACCES") : list(path);
 else f.io.readFile = async (path, encoding) => path === "/proc/4123/fdinfo/3" ? f.fail("EPERM") : read(path, encoding);
 assert.equal((await inspectLinuxRecovery(f.store, undefined, f.io)).kind, "refused");
});

test("Arc inventory counts an inaccessible process once across descriptor failures", async t => {
 const f = syntheticInventory(t), list = f.io.readdir, stat = f.io.stat;
 f.io.readdir = async path => path === "/proc/5000/fdinfo" ? ["3", "4"] : list(path);
 f.io.stat = async path => path.startsWith("/proc/5000/fd/") ? f.fail("EACCES") : stat(path);
 const result = await inspectLinuxRecovery(f.store, undefined, f.io);
 assert.equal(result.kind, "found");
 assert.deepEqual((result as any).visibility, { inaccessibleProcesses: [{ pid: 5000, failures: [{ stage: "descriptor-stat", errno: "EACCES" }] }] });
});

const candidate: RecoveryCandidate = { pid: 4123, generation: "linux:boot:42", argv: ["node", "/synthetic/launch.mjs", "_locked", "{}"], lockKey: "FLOCK ADVISORY WRITE 4000 00:08:100 0 EOF", fd: "3", incarnation: "synthetic", dev: 8, ino: 100 };
function recoveryPorts() {
 const events: string[] = []; let dead = false, checks = 0;
 const ports: RecoveryPorts = {
  probe: async () => { events.push("probe"); return "held"; },
  inspect: async () => { events.push("inspect"); checks++; return { kind: "found", candidate }; },
  responsive: async () => undefined,
  pin: async () => ({ inspect: () => ports.inspect(), signal: async signal => { events.push(signal); if (signal === "SIGKILL") dead = true; return { sent: true }; }, ended: async () => dead, close: async () => { events.push("close"); } }),
  wait: async () => {},
 };
 return { ports, events, checks: () => checks };
}
test("Arc recovery passes a numeric PID to the Perl syscall boundary", () => {
 const source = readFileSync(new URL("../src/arc/service/recovery-linux.ts", import.meta.url), "utf8");
 const helper = source.match(/const PIDFD = String.raw`([\s\S]*?)`;/)?.[1]; assert.ok(helper);
 // Observe the actual helper's argument before any OS syscall can run.
 const probe = String.raw`use B; BEGIN { *CORE::GLOBAL::syscall = sub { my $pid=$_[1]; print((B::svref_2object(\$pid)->FLAGS & B::SVf_IOK()) ? "integer" : "string-pointer"); exit 0; }; }`;
 const result = spawnSync("perl", ["-e", probe + helper, "4123"], { encoding: "utf8" });
 assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, "integer");
});

test("Arc recovery uses descriptor flock evidence despite an exited guardian PID", () => {
 assert.deepEqual(kernelFlocks("lock:\t1: FLOCK  ADVISORY  WRITE 4000 00:08:100 0 EOF\n"), kernelFlocks("73: FLOCK ADVISORY WRITE 4000 00:08:100 0 EOF\n"));
 assert.deepEqual(kernelFlocks("73: POSIX ADVISORY WRITE 4000 00:08:100 0 EOF\n"), []);
 assert.deepEqual(kernelFlocks("73: -> FLOCK ADVISORY WRITE 4000 00:08:100 0 EOF\n"), []);
});
for (const reason of ["kernel flock evidence is malformed", "kernel flock evidence is incomplete", "kernel flock evidence is ambiguous", "the process or store changed", "kernel ownership evidence is unavailable", "the process namespace is ambiguous"]) test(`Arc recovery explains unverified evidence (${reason})`, async () => {
 const f = recoveryPorts(); f.ports.inspect = async () => ({ kind: "refused", pid: 4123, reason });
 const result = await recoverOwner("/synthetic", "devbox", 0, 0, f.ports);
 assert.equal(result.kind, "refused");
 if (result.kind === "refused") assert.equal(result.detail, `Refused: AmPi could not verify pid 4123 (${reason}). No signal sent. If the next Build still reports busy, end pid 4123 or restart the machine devbox.`);
 assert.ok(!f.events.includes("SIGTERM"));
});
test("Arc recovery names the hubs when another process keeps the lock file open", async () => {
 const f = recoveryPorts(); f.ports.inspect = async () => ({ kind: "refused", pid: 4123, reason: "another process has the lock file open" });
 const result = await recoverOwner("/synthetic", "devbox", 0, 0, f.ports);
 assert.equal(result.kind, "refused");
 if (result.kind === "refused") assert.equal(result.detail, "Refused: AmPi could not verify pid 4123 (another process has the lock file open). No signal sent. Stop the hubs on devbox, then run this again.");
 assert.ok(!f.events.includes("SIGTERM"));
});
test("Arc macOS inspection outlasts a transient lock-file opener", async () => {
 const found: MacHolder = { kind: "found", candidate: { pid: 4123 } as RecoveryCandidate };
 const busy: MacHolder = { kind: "refused", reason: "another process has the lock file open", pid: 4123 };
 const waits: number[] = [];
 const run = (sequence: MacHolder[]) => { let index = 0; return settleMacHolder(async () => sequence[Math.min(index++, sequence.length - 1)]!, async ms => { waits.push(ms); }); };
 assert.equal(await run([busy, busy, found]), found);
 assert.deepEqual(waits, [100, 100]);
 waits.length = 0; assert.equal(await run([busy]), busy);
 assert.deepEqual(waits, [100, 100, 100], "three polls over about 300 ms, then refuse");
 waits.length = 0; const foreign: MacHolder = { kind: "refused", reason: "runs as another user", pid: 4123 };
 assert.equal(await run([foreign, found]), foreign);
 assert.deepEqual(waits, [], "a persistent refusal is not retried");
});
for (const reason of ["runs as another user", "serves a different store"]) test(`Arc recovery preserves its foreign-target refusal (${reason})`, async () => {
 const f = recoveryPorts(); f.ports.inspect = async () => ({ kind: "refused", pid: 4123, reason });
 const result = await recoverOwner("/synthetic", "devbox", 0, 0, f.ports);
 assert.equal(result.kind, "refused");
 if (result.kind === "refused") assert.equal(result.detail, `Refused: pid 4123 ${reason}. No signal sent. If the next Build still reports busy, restart the machine devbox.`);
});

test("Arc recovery never discovers or signals after a free lock probe", async () => {
 const f = recoveryPorts(); f.ports.probe = async () => "free";
 assert.equal((await recoverOwner("/synthetic", "devbox", 0, 0, f.ports)).kind, "free"); assert.deepEqual(f.events, []);
});
test("Arc recovery refuses actuation without a pinned handle", async () => {
 const f = recoveryPorts(); f.ports.pin = async () => undefined;
 assert.equal((await recoverOwner("/synthetic", "devbox", 0, 0, f.ports)).kind, "refused"); assert.ok(!f.events.includes("SIGTERM"));
});
test("Arc recovery rechecks ownership before both signals and closes its pinned handle", async () => {
 const f = recoveryPorts(), result = await recoverOwner("/synthetic", "devbox", 0, 0, f.ports);
 assert.equal(result.kind, "terminated"); assert.equal(f.checks(), 3);
 assert.deepEqual(f.events.filter(e => e.startsWith("SIG")), ["SIGTERM", "SIGKILL"]); assert.equal(f.events.at(-1), "close");
});
test("Arc recovery keeps incomplete visibility in its signal result", async () => {
 const f = recoveryPorts(), visibility = { inaccessibleProcesses: [{ pid: 5000, failures: [{ stage: "fdinfo-directory", errno: "EACCES" as const }] }] };
 f.ports.inspect = async () => ({ kind: "found", candidate, visibility });
 const result = await recoverOwner("/synthetic", "devbox", 0, 0, f.ports);
 assert.equal(result.kind, "terminated"); assert.deepEqual(result.visibility, visibility);
 assert.deepEqual(f.events.filter(e => e.startsWith("SIG")), ["SIGTERM", "SIGKILL"]);
});

test("Arc recovery never retargets a changed process after TERM", async () => {
 const f = recoveryPorts(); let reads = 0;
 f.ports.inspect = async () => ({ kind: "found", candidate: ++reads < 3 ? candidate : { ...candidate, generation: "linux:boot:43" } });
 const result = await recoverOwner("/synthetic", "devbox", 0, 0, f.ports);
 assert.equal(result.kind, "refused"); assert.deepEqual(f.events.filter(e => e.startsWith("SIG")), ["SIGTERM"]);
 if (result.kind === "refused") assert.equal(result.detail, "Recovery halted: pid 4123 changed before the next signal.\nSent SIGTERM only. AmPi cannot confirm that the old Arc service stopped.\nA Build that the signals interrupted may have charged a model call. Another Arc service may also have started a Build and charged one.\nRun ampi arc stop --host devbox again.");
});
test("Arc recovery protects a fresh responsive successor before KILL", async () => {
 const f = recoveryPorts(); let checks = 0;
 f.ports.responsive = async () => ++checks < 3 ? undefined : { pid: 5000, state: "running" };
 const result = await recoverOwner("/synthetic", "devbox", 0, 0, f.ports);
 assert.equal(result.kind, "refused"); assert.deepEqual(f.events.filter(e => e.startsWith("SIG")), ["SIGTERM"]);
 if (result.kind === "refused") assert.equal(result.detail, "Recovery halted: a new Arc service on devbox now answers.\nSent SIGTERM only. AmPi sent no further signal. The new service is running.\nA Build that the signals interrupted may have charged a model call. Another Arc service may also have started a Build and charged one.\nCheck your model provider's usage page.");
});
for (const reason of ["unreadable fdinfo", "observed descriptor close/reuse", "observed unlock/relock"]) test(`Arc recovery refuses ${reason} after pinning`, async () => {
 const f = recoveryPorts(); let reads = 0;
 f.ports.inspect = async () => ++reads === 1 ? { kind: "found", candidate } : { kind: "refused", reason };
 assert.equal((await recoverOwner("/synthetic", "devbox", 0, 0, f.ports)).kind, "refused");
 assert.ok(!f.events.includes("SIGTERM")); assert.equal(f.events.at(-1), "close");
});
test("Arc recovery treats ESRCH at pin as gone and never retargets", async () => {
 const f = recoveryPorts(); f.ports.pin = async () => "gone";
 assert.equal((await recoverOwner("/synthetic", "devbox", 0, 0, f.ports)).kind, "free"); assert.ok(!f.events.includes("SIGTERM")); assert.equal(f.checks(), 1);
});
test("Arc recovery rejects PID reuse discovered after pin", async () => {
 const f = recoveryPorts(); let reads = 0;
 f.ports.inspect = async () => ({ kind: "found", candidate: ++reads === 1 ? candidate : { ...candidate, generation: "linux:boot:99" } });
 assert.equal((await recoverOwner("/synthetic", "devbox", 0, 0, f.ports)).kind, "refused"); assert.ok(!f.events.includes("SIGTERM"));
});

test("Arc recovery reports a failed KILL without claiming termination", async () => {
 const f = recoveryPorts(); f.ports.pin = async () => ({ inspect: () => f.ports.inspect(), signal: async signal => { f.events.push(signal); return signal === "SIGTERM" ? { sent: true } : { sent: false, errno: "EPERM" }; }, ended: async () => false, close: async () => {} });
 const result = await recoverOwner("/synthetic", "devbox", 0, 0, f.ports);
 assert.equal(result.kind, "refused"); if (result.kind === "refused") assert.equal(result.detail, "Recovery halted: AmPi could not send SIGKILL to pid 4123 (EPERM).\nSent SIGTERM only. The Arc service is not stopped, and it still holds the lock.\nA Build that the signals interrupted may have charged a model call. Another Arc service may also have started a Build and charged one.\nRestart the machine devbox.");
});

test("Arc recovery reports a retained lock after both signals", async () => {
 const f = recoveryPorts(); f.ports.pin = async () => ({ inspect: () => f.ports.inspect(), signal: async signal => { f.events.push(signal); return { sent: true }; }, ended: async () => false, close: async () => {} });
 const result = await recoverOwner("/synthetic", "devbox", 0, 0, f.ports);
 assert.equal(result.kind, "refused");
 if (result.kind === "refused") assert.equal(result.detail, "Recovery halted: pid 4123 still holds the lock.\nSent SIGTERM and SIGKILL. The Arc service is not stopped.\nA Build that the signals interrupted may have charged a model call. Another Arc service may also have started a Build and charged one.\nRestart the machine devbox.");
});
test("Arc recovery does not claim a stop when a signal receipt is lost", async () => {
 const f = recoveryPorts(); f.ports.pin = async () => ({ inspect: () => f.ports.inspect(), signal: async () => { throw new Error("lost receipt"); }, ended: async () => false, close: async () => {} });
 const result = await recoverOwner("/synthetic", "devbox", 0, 0, f.ports);
 assert.equal(result.kind, "refused");
 if (result.kind === "refused") assert.equal(result.detail, "Recovery halted: SIGTERM was attempted for pid 4123, but its result is unknown.\nNo earlier signal was sent.\nA Build that the signals interrupted may have charged a model call. Another Arc service may also have started a Build and charged one.\nRun ampi arc stop --host devbox again.");
});

for (const signals of [["SIGTERM"], ["SIGTERM", "SIGKILL"]] as const) test(`Arc forced result states the acquisition gap (${signals.join("+")})`, () => {
 const recovery: RecoveryResult = { pid: 4123, signals, oldHolderEnded: true, cancellation: "confirmed", interveningDispatch: "unknown" };
 const text = serviceText(serviceStatus("devbox", { state: "stopped", running: false, kind: "forced-recovery", recovery }));
 assert.equal(text, `Arc service on devbox did not answer, so AmPi stopped it.\nSent ${signals.join(" and ")} to pid 4123. The process ended, and AmPi took the lock and cancelled the queued Builds.\nA Build that the signals interrupted may have charged a model call. Before AmPi took the lock, another Arc service may also have started a Build and charged one.\nCheck your model provider's usage page. A linked hub starts Arc again within seconds.`);
 assert.equal(text.split("\n").length, 4);
 assert.equal(text.match(/Check |Run |Restart |Repair /g)?.length, 1);
});

for (const cancellation of ["confirmed", "unconfirmed"] as const) test(`Arc forced result names unverified macOS evidence (${cancellation})`, () => {
 const recovery: RecoveryResult = cancellation === "confirmed"
  ? { pid: 4123, signals: ["SIGTERM"], oldHolderEnded: true, cancellation, interveningDispatch: "unknown", evidence: "unverified" }
  : { pid: 4123, signals: ["SIGTERM"], oldHolderEnded: true, cancellation, interveningDispatch: "unknown", evidence: "unverified", reason: "lock acquisition was not confirmed", action: "Run ampi arc stop --host devbox again" };
 const text = serviceText(serviceStatus("devbox", { state: cancellation === "confirmed" ? "stopped" : "busy", running: cancellation !== "confirmed", kind: "forced-recovery", recovery }));
 assert.equal(text.split("\n")[2], "macOS could not prove that pid 4123 held the lock. You chose to stop it anyway.");
 assert.equal(text.split("\n").length, 5);
 assert.equal(text.match(/Check |Run |Restart |Repair /g)?.length, 1);
});

for (const [reason, action] of [
 ["the lock remains held", "Run ampi arc stop --host devbox again"],
 ["The stop record changed during cancellation", "Run ampi arc stop --host devbox again"],
 ["the store is read-only", "Repair /synthetic: the store is read-only; then run ampi arc stop --host devbox again"],
]) test(`Arc incomplete recovery states its limits: ${reason}`, () => {
 const recovery: RecoveryResult = { pid: 4123, signals: ["SIGTERM", "SIGKILL"], oldHolderEnded: true, cancellation: "unconfirmed", interveningDispatch: "unknown", reason, action };
 const text = serviceText(serviceStatus("devbox", { state: "fault", running: true, kind: "forced-recovery", recovery }));
 assert.equal(text, `Arc recovery on devbox is not complete: ${reason.replace(/^The /, "the ")}.\nSent SIGTERM and SIGKILL to pid 4123. The process ended, but AmPi could not confirm that queued Builds are cancelled.\nA Build that the signals interrupted may have charged a model call. Another Arc service may also have started a Build and charged one.\n${action}.`);
 assert.doesNotMatch(text, /stopped/);
 assert.equal(text.split("\n").length, 4);
});
