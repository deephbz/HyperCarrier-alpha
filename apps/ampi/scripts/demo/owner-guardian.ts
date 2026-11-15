// Disposable demo lifetime only. Stop its respawn sources before its sandbox resident.
// The parent pipe has one writer in pi-demo. Other children never inherit it.
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { controlRequest } from "../../src/arc/service/connection.ts";
import { ownerAlive, processIdentity } from "../process-owner.cjs";

const [hubIdentity, parentIdentity, runnerIdentity, agentDir] = process.argv.slice(2);
const pid = JSON.parse(hubIdentity).pid;
const store = resolve(join(agentDir, "ampi-arc"));
const processEnv = { ...process.env, LC_ALL: "C" };
let pipeEnded = false, waitingHub = false, normalClose = false, input = "";
process.stdin.on("data", chunk => {
 input += chunk;
 if (input.includes("closed\n") || input.includes("failed\n")) {
  normalClose = input.includes("closed\n"); waitingHub = true; pipeEnded = true;
 }
});
process.stdin.on("end", () => { pipeEnded = true; }).resume();
const ownerExists = () => ownerAlive(parentIdentity) && (!runnerIdentity || ownerAlive(runnerIdentity));
const residents = new Map<number, string>();
const lockPath = join(store, "service.lock");
function lockHolders(pid?: number): number[] {
 try {
  return execFileSync("lsof", [...(pid ? ["-a", "-p", String(pid)] : []), "-t", "--", lockPath], { encoding: "utf8", timeout: 1000, env: processEnv, stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\s+/).map(Number).filter(pid => pid > 1);
 } catch { return []; }
}
function rememberLockHolders() {
 for (const pid of lockHolders()) {
  const identity = processIdentity(pid);
  if (!identity) continue;
  try {
   const command = execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 1000, env: processEnv });
   if (command.includes(store) && ownerAlive(identity)) residents.set(pid, identity);
  } catch { /* The holder ended during observation. */ }
 }
}
async function rememberResident() {
 if (process.env.DEMO_GUARDIAN_HOLD && existsSync(process.env.DEMO_GUARDIAN_HOLD)) return;
 try {
  const status = await controlRequest(store, { op: "status", refreshAuth: false }, 250);
  const identity = processIdentity(status.pid);
  if (identity) residents.set(status.pid, identity);
 } catch { /* Keep the last answering generation if its socket later stops answering. */ }
}
function signalResidents() {
 for (const [pid, identity] of residents) {
  if (!ownerAlive(identity) || !lockHolders(pid).includes(pid)) continue;
  try {
   const command = execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 1000, env: processEnv });
   if (command.includes(store) && ownerAlive(identity)) process.kill(pid, "SIGKILL");
  } catch { /* The checked holder ended. */ }
 }
}
function sourceMembers() {
 const rows = execFileSync("ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 1000, env: processEnv });
 return rows.trim().split("\n").map(row => row.trim().split(/\s+/))
  .filter(([, group, state]) => Number(group) === pid && !/^[ZXx]/.test(state) && !(process.platform === "darwin" && state.includes("E")))
  .map(([member]) => ({ pid: Number(member), identity: processIdentity(Number(member)) }));
}
process.stdout.write("ready\n");
// A 1 s cadence bounds owner detection without polling a whole environment table.
while (!pipeEnded && ownerAlive(hubIdentity) && ownerExists()) {
 await rememberResident();
 await delay(1000);
}
// Successful normal close already stopped everything the demo owns. Do not
// add another source of stop authority; only reap this guardian and its helpers.
if (normalClose) process.kill(-process.pid, "SIGKILL");
// Capture generations before signalling. ps start-time resolution limits reuse detection.
const members = sourceMembers();
const signalSources = (signal: NodeJS.Signals) => {
 // pi-demo refuses owner-bound startup unless it leads this private group.
 if (!waitingHub && ownerAlive(hubIdentity)) { try { process.kill(-pid, signal); } catch {} }
 for (const member of members) if ((!waitingHub || member.pid !== pid) && member.identity && ownerAlive(member.identity)) { try { process.kill(member.pid, signal); } catch {} }
};
const sourcesAlive = () => (!waitingHub && ownerAlive(hubIdentity)) || members.some(member => (!waitingHub || member.pid !== pid) && ownerAlive(member.identity));
signalSources("SIGTERM");
const deadline = Date.now() + 6000;
while (sourcesAlive() && Date.now() < deadline) {
 // Include maintenance children spawned by graceful close after the first signal.
 for (const member of sourceMembers()) if (!members.some(known => known.identity === member.identity)) members.push(member);
 await delay(250);
}
signalSources("SIGKILL");
const killedBy = Date.now() + 1000;
while (sourcesAlive() && Date.now() < killedBy) await delay(50);
// The startup guardian reaps a resident that never passed readiness. No new
// starts can come from the sources above. Refresh for a late readiness reply.
await rememberResident();
// Readiness can be lost between R and the first relay/status observation.
// Only this exclusive fresh store's open lock path supplies fallback authority.
rememberLockHolders();
if ([...residents.values()].some(identity => ownerAlive(identity))) {
 await controlRequest(store, { op: "stop" }, 500).catch(() => {});
 const stoppedBy = Date.now() + 2000;
 while ([...residents.values()].some(identity => ownerAlive(identity)) && Date.now() < stoppedBy) await delay(50);
 signalResidents();
}
// Skip native exit teardown, which the incident showed can block indefinitely.
// This private group also contains any synchronous ps/lsof helper descendants.
process.kill(-process.pid, "SIGKILL");
