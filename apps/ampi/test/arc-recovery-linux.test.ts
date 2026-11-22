import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchLocked } from "../src/arc/service/lock.ts";
import { storeIncarnation } from "../src/arc/service/store.ts";
import { recoverOwner, probeRecoveryLock } from "../src/arc/service/recovery.ts";
import { inspectLinuxRecovery, pinRecoveryTarget } from "../src/arc/service/recovery-linux.ts";

async function holder(t: any, duplicate = false, unreadable = false) {
 const root = mkdtempSync(join(tmpdir(), "arc-kernel-")), agent = join(root, "agent"), store = join(agent, "ampi-arc");
 mkdirSync(store, { recursive: true });
 const script = join(store, `launch-${randomUUID()}.mjs`);
 writeFileSync(script, "console.log('ready');setInterval(()=>{},1000);");
 const operation = JSON.stringify({ op: "ensure", host: "synthetic", agentDir: agent, storeIncarnation: storeIncarnation(store, true) });
 let env = process.env;
 if (unreadable) {
  const source = join(root, "private-process.c"), library = join(root, "private-process.so");
  writeFileSync(source, '#include <sys/prctl.h>\n#include <unistd.h>\n__attribute__((constructor)) static void private_process(void) { if (prctl(PR_SET_DUMPABLE, 0) != 0) _exit(72); }\n');
  const compiled = spawnSync("cc", ["-shared", "-fPIC", "-o", library, source], { encoding: "utf8", timeout: 5000 });
  if (compiled.status !== 0) rmSync(root, { force: true, recursive: true });
  assert.equal(compiled.status, 0, compiled.stderr); env = { ...process.env, LD_PRELOAD: library };
 }
 const wrapper = String.raw`use Fcntl qw(F_GETFD F_SETFD FD_CLOEXEC);open(my $dup,'<&',$ENV{AMPI_ARC_LOCK_FD}) or die $!;my $fd=fileno($dup);fcntl($dup,F_SETFD,fcntl($dup,F_GETFD,0)&~FD_CLOEXEC);$^F=$fd;exec @ARGV;die $!;`;
 const child = duplicate ? launchLocked(store, ["-e", wrapper, process.execPath, script, "_locked", operation], { stdio: ["ignore", "pipe", "ignore"] }, "perl") : launchLocked(store, [script, "_locked", operation], { stdio: ["ignore", "pipe", "ignore"], env });
 const closed = once(child, "close");
 t.after(async () => { child.kill("SIGKILL"); await closed; rmSync(root, { force: true, recursive: true }); });
 await once(child.stdout!, "data");
 return { root, store, child, closed };
}
for (const duplicate of [false, true]) test(`Arc kernel proof counts a process once (duplicate FD=${duplicate})`, { skip: process.platform !== "linux" }, async t => {
 const f = await holder(t, duplicate), inspected = await inspectLinuxRecovery(f.store);
 assert.equal(inspected.kind, "found", JSON.stringify(inspected));
 if (inspected.kind !== "found") return;
 assert.equal(inspected.candidate.pid, f.child.pid);
 const pinned = await pinRecoveryTarget(inspected.candidate, f.store);
 assert.ok(pinned && pinned !== "gone", "supported Linux must bind its pidfd");
 try {
  assert.equal((await pinned.inspect()).kind, "found"); assert.equal(await pinned.ended(), false, "signal 0 confirms the live pinned child");
  if (duplicate) process.kill(f.child.pid!, "SIGSTOP");
  assert.deepEqual(await pinned.signal("SIGTERM"), { sent: true });
  if (duplicate) {
   assert.equal(await pinned.ended(), false, "a frozen child retains the same pinned handle after TERM");
   assert.deepEqual(await pinned.signal("SIGKILL"), { sent: true });
  }
  await f.closed; assert.equal(await pinned.ended(), true);
  assert.deepEqual(await pinned.signal("SIGKILL"), { sent: false, errno: "ESRCH" });
 } finally { await pinned.close(); }
 assert.equal(await pinRecoveryTarget(inspected.candidate, f.store), "gone", "an exited owned child is never retargeted");
});

test("Arc kernel proof refuses an inaccessible owned Arc target", { skip: process.platform !== "linux" }, async t => {
 const f = await holder(t, false, true);
 assert.equal(await probeRecoveryLock(f.store), "held");
 const result = await recoverOwner(f.store, "synthetic", 0, 0);
 assert.equal(result.kind, "refused", JSON.stringify(result));
 if (result.kind === "refused") assert.match(result.detail, /No signal sent/);
 process.kill(f.child.pid!, 0); assert.equal(await probeRecoveryLock(f.store), "held");
});

test("Arc kernel proof ignores a plain opener without a flock", { skip: process.platform !== "linux" }, async t => {
 const f = await holder(t);
 const opener = spawn(process.execPath, ["-e", "require('node:fs').openSync(process.argv[1],'r+');console.log('ready');setInterval(()=>{},1000)", join(f.store, "service.lock")], { stdio: ["ignore", "pipe", "ignore"] });
 const closed = once(opener, "close"); t.after(async () => { opener.kill("SIGKILL"); await closed; }); await once(opener.stdout!, "data");
 const inspected = await inspectLinuxRecovery(f.store);
 assert.equal(inspected.kind, "found", JSON.stringify(inspected)); if (inspected.kind === "found") assert.equal(inspected.candidate.pid, f.child.pid);
});

test("Arc kernel proof retains an unrelated non-dumpable process as visibility evidence", { skip: process.platform !== "linux" || process.arch !== "x64" }, async t => {
 const f = await holder(t);
 const decoy = spawn("perl", ["-e", 'syscall(157,4,0,0,0,0)==0 or die "prctl failed";$|=1;print "ready\\n";sleep 60;'], { stdio: ["ignore", "pipe", "ignore"] });
 const closed = once(decoy, "close"); t.after(async () => { decoy.kill("SIGKILL"); await closed; }); await once(decoy.stdout!, "data");
 const inspected = await inspectLinuxRecovery(f.store);
 assert.equal(inspected.kind, "found", JSON.stringify(inspected));
 assert.ok(inspected.visibility?.inaccessibleProcesses.some(p => p.pid === decoy.pid && p.failures.some(f => f.errno === "EACCES" || f.errno === "EPERM")));
 if (inspected.kind === "found") assert.equal(inspected.candidate.pid, f.child.pid);
});

for (const hidden of [false, true]) test(`Arc kernel proof handles an inherited non-Arc holder (hidden=${hidden})`, { skip: process.platform !== "linux" || process.arch !== "x64" }, async t => {
 const root = mkdtempSync(join(tmpdir(), "arc-kernel-shared-")), agent = join(root, "agent"), store = join(agent, "ampi-arc");
 mkdirSync(store, { recursive: true });
 const script = join(store, `launch-${randomUUID()}.mjs`);
 writeFileSync(script, "console.log(process.pid);setInterval(()=>{},1000);");
 const operation = JSON.stringify({ op: "ensure", host: "synthetic", agentDir: agent, storeIncarnation: storeIncarnation(store, true) });
 const wrapper = String.raw`$|=1;my($node,$script,$operation)=@ARGV;my $a=fork();if(!$a){exec $node,$script,'_locked',$operation;die $!;}my $b=fork();if(!$b){${hidden ? 'syscall(157,4,0,0,0,0)==0 or die "prctl failed";print "$$\\n";sleep 60;exit;' : "exec $node,'-e','console.log(process.pid);setInterval(()=>{},1000)';die $!;"}}open(my $lock,'<&='.$ENV{AMPI_ARC_LOCK_FD}) or die $!;close($lock);waitpid($a,0);waitpid($b,0);`;
 const child = launchLocked(store, ["-e", wrapper, process.execPath, script, operation], { stdio: ["ignore", "pipe", "ignore"] }, "perl");
 const closed = once(child, "close"), pids: number[] = []; let text = "";
 t.after(async () => { for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} } await closed; rmSync(root, { recursive: true, force: true }); });
 await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("both inherited holders did not start")), 3000);
  child.stdout!.on("data", bytes => { text += bytes; while (text.includes("\n")) { const at = text.indexOf("\n"); pids.push(Number(text.slice(0, at))); text = text.slice(at + 1); } if (pids.length === 2) { clearTimeout(timer); resolve(); } });
 });
 const inspected = await inspectLinuxRecovery(store);
 if (!hidden) {
  assert.equal(inspected.kind, "refused"); if (inspected.kind === "refused") assert.match(inspected.reason, /2 processes share the kernel flock/);
 } else {
  assert.equal(inspected.kind, "found", JSON.stringify(inspected));
  const result = await recoverOwner(store, "synthetic", 1000, 1000);
  assert.equal(result.kind, "terminated", JSON.stringify(result));
  if (result.kind !== "terminated") return;
  assert.deepEqual(result.signals, ["SIGTERM"]);
  assert.equal(await probeRecoveryLock(store), "held", "target termination does not prove lock release");
  const retainer = pids.find(pid => pid !== result.pid)!; process.kill(retainer, 0);
  assert.ok(result.visibility?.inaccessibleProcesses.some(p => p.pid === retainer));
  assert.equal((await recoverOwner(store, "synthetic", 0, 0)).kind, "refused", "no second target is selected");
  process.kill(retainer, 0);
 }
});
