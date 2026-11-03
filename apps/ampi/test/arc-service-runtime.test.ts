import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, symlinkSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, createReadStream } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnection, createServer } from "node:net";
// @ts-expect-error Build script runs as native ESM.
import { buildArcService } from "../scripts/build-arc-service.mjs";
import { launchLocked } from "../src/arc/service/lock.ts";
import { serviceText, serviceStatus } from "../src/arc/service/status.ts";
import { storeIncarnation } from "../src/arc/service/store.ts";
import type { Socket } from "node:net";
import { controlRequest as rawControlRequest, serviceAddress } from "../src/arc/service/runtime.ts";
import type { ControlCommand } from "../src/arc/service/runtime.ts";
import { pathToFileURL } from "node:url";
const controlRequest = (store: string, command: ControlCommand, timeout?: number) => rawControlRequest(store, { stamp: JSON.parse(readFileSync(join(store, "control.json"), "utf8")).selected, ...command }, timeout);
import { maintainHost, maintenanceLaunch, parseArcArgs } from "../src/arc/service/client.ts";
import { piSource } from "../src/arc/service/source.ts";
import { fingerprint, storeAnswer } from "../src/arc/core/construct.ts";

async function fixture(t: any, virtualTime = false) {
 const dir = mkdtempSync(join(tmpdir(), "arc-runtime-")), agent = join(dir, "agent"), bundle = join(dir, "service.mjs");
 mkdirSync(agent); const built = await buildArcService(bundle, { buildOrder: 100 });
 assert.equal(built.sourceReader, true);
 const original = readFileSync(bundle, "utf8");
 const { version: version2 } = await buildArcService(join(dir, "next.mjs"), { buildOrder: 200 });
 const pi = join(dir, "pi"); writeFileSync(pi, `#!${process.execPath}\nconsole.log('{"status":"ready"}');\n`); chmodSync(pi, 0o755);
 const settings = (extra = {}) => writeFileSync(join(agent, "settings.json"), JSON.stringify({ ampi_arc: { model: "fixture/model", auto: false, ...extra } })); settings();
 const runner = join(dir, "runner.mjs"); writeFileSync(runner, `import {readFileSync} from 'node:fs'; const file=process.argv[2]; const m=await import(file); console.log(JSON.stringify(await m.manage(readFileSync(file,'utf8'),JSON.parse(process.argv[3]))));`);
 const clockPath = join(dir, "clock.sock"), preload = join(dir, "clock.mjs");
 if (virtualTime) writeFileSync(preload, `
import { mock } from 'node:test';
import { createServer } from 'node:net';
import { isMainThread } from 'node:worker_threads';
import { rmSync } from 'node:fs';
if (isMainThread && process.argv[2] === '_locked' && JSON.parse(process.argv[3]).op === 'ensure') {
 rmSync(${JSON.stringify(clockPath)}, { force: true });
 mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
 let ticks = 0;
 const interval = globalThis.setInterval;
 globalThis.setInterval = (callback, ms, ...args) => interval(() => { ticks++; callback(...args); }, ms);
 const server = createServer(socket => {
  socket.once('data', data => {
   const before = Date.now(); mock.timers.tick(Number(data));
   socket.end(JSON.stringify({ elapsed: Date.now() - before, ticks }));
  });
 });
 await new Promise(resolve => server.listen(${JSON.stringify(clockPath)}, resolve));
}
`);
 async function advance(ms: number) {
  return new Promise<{ elapsed: number; ticks: number }>((resolve, reject) => {
   const socket = createConnection(clockPath); let body = "";
   socket.setTimeout(5000, () => socket.destroy(new Error("fixture clock did not reply")));
   socket.once("connect", () => socket.write(String(ms))); socket.on("data", data => body += data);
   socket.once("error", reject); socket.once("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
  });
 }
 const pids = new Set<number>(), managers = new Map<ReturnType<typeof spawn>, Promise<void>>();
 let tearingDown = false, closed: Promise<void> | undefined;
 async function manage(op: string, extra: any = {}, next = false, env = {}) {
  if (tearingDown) throw new Error("Arc fixture is closed");
  const result = await new Promise<any>((resolve, reject) => {
   const child = spawn(process.execPath, [runner, next ? join(dir, "next.mjs") : bundle, JSON.stringify({ op, host: "synthetic", agentDir: agent, timeoutMs: 10000, ...extra })], { cwd: dir, env: { HOME: dir, PATH: process.env.PATH, PI_BIN: pi, ...(virtualTime ? { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } : {}), ...env }, stdio: ["ignore", "pipe", "pipe"] });
   const ended = new Promise<void>(resolve => child.once("close", () => resolve()));
   managers.set(child, ended); void ended.then(() => managers.delete(child));
   let out = "", err = ""; const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("manager hung: " + err)); }, 15000);
   child.stdout.on("data", b => out += b); child.stderr.on("data", b => err += b); child.on("error", reject);
   child.on("close", code => { clearTimeout(timer); if (tearingDown) reject(new Error("Arc fixture is closed")); else if (code) reject(new Error(err + out)); else { try { resolve(JSON.parse(out)); } catch { reject(new Error(out + err)); } } });
  });
  if (result.pid) pids.add(result.pid); return result;
 }
 function close() {
  if (closed) return closed;
  tearingDown = true;
  return closed = (async () => {
   const active = [...managers];
   for (const [child] of active) child.kill("SIGKILL");
   await Promise.allSettled(active.map(([, ended]) => ended));
   for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
   await new Promise(r => setTimeout(r, 40)); rmSync(dir, { recursive: true, force: true });
  })();
 }
 t.after(close);
 return { dir, agent, bundle, close, stamp: { id: built.version, order: 100, line: "stable" }, store: join(agent, "ampi-arc"), manage, advance, settings, version: built.version, version2, body: original, pids };
}

async function until(check: () => Promise<boolean> | boolean, message: string) {
 const end = Date.now() + 10000;
 while (!await check()) { if (Date.now() >= end) throw new Error(message); await new Promise(r => setTimeout(r, 30)); }
}
function managerClock(f: { dir: string }) {
 const address = join(f.dir, "manager-clock.sock"), preload = join(f.dir, "manager-clock.mjs");
 writeFileSync(preload, `import {mock} from 'node:test'; import {createServer} from 'node:net';
if(process.argv.length===1 || process.argv[1]?.endsWith('/runner.mjs')){
 mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
 const server=createServer(socket=>socket.once('data',data=>{mock.timers.tick(Number(data));socket.end('advanced');server.unref();}));
 await new Promise(resolve=>server.listen(${JSON.stringify(address)},resolve));
}`);
 return { env: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }, async advance(ms: number) {
  const socket = createConnection(address); socket.resume(); await once(socket, "connect"); socket.end(String(ms)); await once(socket, "close");
 } };
}
function blockingModel(f: Awaited<ReturnType<typeof fixture>>, loss = false) {
 const sessions = join(f.agent, "sessions"); mkdirSync(sessions);
 const rows: any[] = [{ type: "session", version: 3, id: "fixture-session", timestamp: "2026-01-01T00:00:00Z", cwd: "/synthetic/project" }];
 for (let n = 0; n < 6; n++) rows.push({ type: "message", id: "u" + n, parentId: n ? "u" + (n - 1) : null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "Synthetic evidence " + n + "." } });
 writeFileSync(join(sessions, "session.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
 const calls = join(f.dir, "calls"), release = join(f.dir, "release"), pid = join(f.dir, "model-pid");
 writeFileSync(join(f.dir, "pi"), `#!${process.execPath}
const fs=require('node:fs');
if(process.argv[2]==='auth'){console.log('{"status":"ready"}');process.exit(0);}
let body='';process.stdin.on('data',b=>body+=b);process.stdin.on('end',()=>{
 fs.appendFileSync(${JSON.stringify(calls)},'call\\n');fs.writeFileSync(${JSON.stringify(pid)},String(process.pid));
 const timer=setInterval(()=>{
  if(!fs.existsSync(${JSON.stringify(release)}))return;clearInterval(timer);
  const data=JSON.parse(body.split('\\nAnswer rejected:')[0]),item=data.rarebits.at(-1),claim={text:'Review the work.',cites:[{id:item.id,quote:item.text}]};
  const answer={goal:claim,now:claim,chapters:[{firstId:data.rarebits[0].id,label:'Reviewing the work',closed:true,summary:{scope:claim,bullets:[]}}],points:${loss ? JSON.stringify([{kind:'request',state:'open',by:'owner',waits:'owner',title:'Review the work',text:'Review it.',cites:[{id:'missing',quote:'Missing evidence'}]}]) : '[]'}};
  console.log(JSON.stringify({type:'message_end',message:{role:'assistant',provider:'fixture',model:'model',stopReason:'stop',content:[{type:'text',text:JSON.stringify(answer)}],usage:{input:10,output:5,cost:{total:0.01}}}}));
 },20);
});
`);
 return { calls, release, pid };
}
const request = (id: string) => ({ op: "request" as const, sessionRef: "pi:fixture-session", requestId: id, kind: "manual" as const, requester: "synthetic" });

test("Arc fixture: teardown settles managers and refuses later launches", async t => {
 const f = await fixture(t), started = join(f.dir, "manager-pid");
 writeFileSync(join(f.dir, "runner.mjs"), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(started)}, String(process.pid)); setInterval(() => {}, 1000);`);
 const pending = assert.rejects(f.manage("ensure"), /Arc fixture is closed/);
 await until(() => existsSync(started), "manager did not start");
 const pid = Number(readFileSync(started, "utf8"));
 await f.close(); await pending;
 assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
 assert.equal(existsSync(f.dir), false);
 await assert.rejects(f.manage("status"), /Arc fixture is closed/);
 await f.close();
});

for (const phase of ["module-import", "socket-bind"]) test(`Arc manager SIGKILL closes an unready launcher's parent pipe (${phase})`, { timeout: 15000 }, async t => {
 const f = await fixture(t), entered = join(f.dir, "unready-pid");
 const mark = `startupFs.writeFileSync(${JSON.stringify(entered)}, String(process.pid));`;
 const hold = phase === "module-import" ? `${mark} await new Promise(() => setInterval(() => {}, 1000));`
  : `StartupServer.prototype.listen = function () { ${mark} setInterval(() => {}, 1000); return this; };`;
 writeFileSync(f.bundle, `import * as startupFs from 'node:fs';
 import { Server as StartupServer } from 'node:net';
 if (import.meta.url.includes('/versions/')) { ${hold} }\n` + f.body);
 const pending = assert.rejects(f.manage("ensure"), /Arc fixture is closed/);
 await until(() => existsSync(entered), "launcher did not enter startup");
 const pid = Number(readFileSync(entered, "utf8"));
 t.after(() => { try { process.kill(pid, "SIGKILL"); } catch {} });
 await f.close(); await pending;
 assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "fixture completion must leave no unready launcher");
});

test("Arc manager death during synchronous startup cannot leave teardown busy", { timeout: 15000 }, async t => {
 const f = await fixture(t), entered = join(f.dir, "blocked-pid"), managerPid = join(f.dir, "manager-pid");
 const runner = join(f.dir, "runner.mjs");
 writeFileSync(runner, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(managerPid)}, String(process.pid));\n` + readFileSync(runner, "utf8"));
 writeFileSync(f.bundle, `import {writeFileSync as markBlocked} from 'node:fs';
 if (import.meta.url.includes('/versions/')) {
  markBlocked(${JSON.stringify(entered)}, String(process.pid));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
 }\n` + f.body);
 const pending = assert.rejects(f.manage("ensure"));
 await until(() => existsSync(entered), "launcher did not enter synchronous startup");
 const pid = Number(readFileSync(entered, "utf8")); f.pids.add(pid);
 process.kill(Number(readFileSync(managerPid, "utf8")), "SIGKILL");
 await pending;
 const stopped = await f.manage("stop", { timeoutMs: 10_000 });
 assert.equal(stopped.state, "stopped", `product teardown must not remain busy: ${JSON.stringify(stopped)}`);
 assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "stopped must leave no blocked startup process");
});

for (const release of [false, true]) test(`Arc ready reply requires the manager release byte (release=${release})`, async t => {
 const f = await fixture(t);
 mkdirSync(f.store);
 const operation = { op: "ensure", host: "synthetic", agentDir: f.agent, storeIncarnation: storeIncarnation(f.store, true), stopGeneration: null };
 const child = launchLocked(f.store, [f.bundle, "_locked", JSON.stringify(operation)], {
  detached: true, stdio: ["ignore", "pipe", "ignore", "pipe"],
  env: { ...process.env, PI_BIN: join(f.dir, "pi"), AMPI_ARC_PARENT_FD: "3" },
 });
 const closed = once(child, "close");
 t.after(async () => { child.kill("SIGKILL"); await closed; });
 const parent = child.stdio[3] as Socket; parent.on("error", () => {}); parent.resume();
 const result = await new Promise<any>((resolve, reject) => {
  let body = "";
  child.stdout!.on("data", data => { body += data; if (body.includes("\n")) { try { resolve(JSON.parse(body.split("\n")[0]!)); } catch (e) { reject(e); } } });
  child.once("error", reject);
 });
 assert.equal(result.running, true);
 const disconnected = once(parent, "close");
 if (release) parent.end("R"); else parent.end();
 await disconnected;
 if (release) {
  process.kill(result.pid, 0);
  assert.equal((await f.manage("ensure")).pid, result.pid, "a released resident must survive the manager pipe");
  assert.equal((await f.manage("stop")).state, "stopped");
 } else {
  await closed;
  assert.throws(() => process.kill(result.pid, 0), { code: "ESRCH" }, "EOF after ready but before release must cancel startup");
  assert.equal((await f.manage("ensure")).running, true, "the next manager must be able to restart");
  assert.equal((await f.manage("stop")).state, "stopped");
 }
 await closed;
});

for (const enteredNode of [false, true]) test(`Arc startup timeout kills and reaps its unready launcher (enteredNode=${enteredNode})`, { timeout: 15000 }, async t => {
 const f = await fixture(t), entered = join(f.dir, "unready-pid"), guardian = join(f.dir, "guardian-pid");
 // Advance the unchanged 500 ms manager deadline only after the tested phase exists.
 const clock = managerClock(f);
 const seam = "my $fd = fileno($lock);";
 const guardianProbe = `open(my $probe, '>', '${guardian}') or die $!; print {$probe} $$; close($probe);\n`;
 const body = `import * as startupFs from 'node:fs';
 if (import.meta.url.includes('/versions/')) {
  startupFs.writeFileSync(${JSON.stringify(entered)}, String(process.pid));
  await new Promise(() => setInterval(() => {}, 1000));
 }\n` + f.body.replace(seam, () => guardianProbe + (enteredNode ? "" : "select(undef, undef, undef, 10);\n") + seam);
 const config = { id: "synthetic", label: "Synthetic", kind: "pi-local" as const, agentConfig: { agentDir: f.agent }, env: { HOME: f.dir, PI_BIN: join(f.dir, "pi"), ...clock.env } };
 const result = maintainHost(config, { op: "ensure", timeoutMs: 500 }, body);
 await until(() => existsSync(enteredNode ? entered : guardian), "launcher did not reach the tested phase");
 await clock.advance(500);
 const failed = await result; assert.equal(failed.state, "error"); assert.match(failed.detail!, /Arc service startup timed out/);
 assert.equal(existsSync(entered), enteredNode, "both pre-exec abort and entered Node must run deterministically");
 for (const pidFile of enteredNode ? [guardian, entered] : [guardian]) {
  const pid = Number(readFileSync(pidFile, "utf8")); assert.ok(pid > 0); f.pids.add(pid);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "a failed startup must reap the guardian and any entered Node before replying");
 }
});

test("Arc startup error kills and reaps its launcher before replying", { timeout: 15000 }, async t => {
 const f = await fixture(t), entered = join(f.dir, "failed-start-pid");
 const body = `import * as startupFs from 'node:fs';
 if (import.meta.url.includes('/versions/')) {
  startupFs.writeFileSync(${JSON.stringify(entered)}, String(process.pid));
  setInterval(() => {}, 1000);
  throw new Error('synthetic startup failure after resource acquisition');
 }\n` + f.body;
 const config = { id: "synthetic", label: "Synthetic", kind: "pi-local" as const, agentConfig: { agentDir: f.agent }, env: { HOME: f.dir, PI_BIN: join(f.dir, "pi") } };
 const result = await maintainHost(config, { op: "ensure", timeoutMs: 10000 }, body);
 assert.equal(result.state, "error");
 assert.match(result.detail!, /synthetic startup failure after resource acquisition/);
 const pid = Number(readFileSync(entered, "utf8")); f.pids.add(pid);
 assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "a startup error must reap its child before replying");
 const probe = launchLocked(f.store, ["-e", "process.exit(0)"], { stdio: "ignore" });
 const code = await new Promise<number | null>((resolve, reject) => { probe.once("exit", resolve); probe.once("error", reject); });
 assert.equal(code, 0, "a failed startup releases its lifetime lock");
});

test("Arc maintenance: stop fences an ensure held before lifetime-lock acquisition", async t => {
 const f = await fixture(t), bin = join(f.dir, "bin"), entered = join(f.dir, "entered"), release = join(f.dir, "release");
 mkdirSync(bin);
 assert.equal(spawnSync("mkfifo", [entered, release]).status, 0);
 const perl = spawnSync("which", ["perl"], { encoding: "utf8" }).stdout.trim();
 const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
 writeFileSync(join(bin, "perl"), `#!/bin/sh\ncase "$*" in *'"op":"ensure"'*) printf entered > ${quote(entered)}; read release < ${quote(release)} ;; esac\nexec ${quote(perl)} "$@"\n`);
 chmodSync(join(bin, "perl"), 0o755);
 const signal = createReadStream(entered), ready = once(signal, "data");
 t.after(() => signal.destroy());
 const pending = f.manage("ensure", {}, false, { PATH: bin + ":" + process.env.PATH });
 await ready;
 assert.equal((await f.manage("stop")).state, "stopped");
 writeFileSync(release, "release\n");
 const stale = await pending;
 assert.equal(stale.state, "stopped", "an ensure admitted before stop must not start a later resident");
 assert.equal(stale.running, false);
 const fresh = await f.manage("ensure");
 assert.equal(fresh.running, true, "a fresh ensure after stop can start normally");
 assert.equal((await f.manage("stop")).state, "stopped");
 assert.throws(() => process.kill(fresh.pid, 0), { code: "ESRCH" });
});

for (const recreate of [false, true]) test(`Arc maintenance: stop fences an admitted ensure across store deletion (recreate=${recreate})`, async t => {
 const f = await fixture(t), gate = join(f.dir, "admission.sock"), server = createServer();
 t.after(() => server.close());
 await new Promise<void>(resolve => server.listen(gate, resolve));
 const connected = once(server, "connection");
 const needle = "\tlet staging, replacing = false, sawBusy = false;";
 assert.equal(f.body.split(needle).length, 2, "the built manage admission seam is unique");
 const pause = `if (operation.op === 'ensure' && process.env.ADMISSION_GATE === '1') {
  const {createConnection} = await import('node:net');
  await new Promise((resolve,reject) => {
   const socket=createConnection(${JSON.stringify(gate)});
   socket.once('connect',()=>socket.write('admitted'));
   socket.once('end',resolve);socket.once('error',reject);
  });
 }\n`;
 writeFileSync(f.bundle, f.body.replace(needle, pause + needle));
 const pending = f.manage("ensure", {}, false, { ADMISSION_GATE: "1" });
 const [socket] = await connected;
 t.after(() => socket.destroy());
 await once(socket, "data");
 assert.equal((await f.manage("stop")).state, "stopped");
 rmSync(f.store, { recursive: true, force: true });
 if (recreate) assert.equal((await f.manage("ensure")).running, true, "a fresh ensure creates a new incarnation");
 socket.end();
 const stale = await pending;
 assert.equal(stale.state, "stopped", "an admitted ensure must not resurrect a deleted store");
 assert.equal(stale.running, false);
 assert.equal((await f.manage("ensure")).running, true, "a fresh ensure after deletion starts normally");
 assert.equal((await f.manage("stop")).state, "stopped");
});

for (const name of ["stop.json", "incarnation.json"]) test(`Arc maintenance: corrupt ${name} fails closed with a recovery path`, async t => {
 const f = await fixture(t);
 assert.equal((await f.manage("ensure")).running, true);
 await f.manage("stop");
 writeFileSync(join(f.store, name), "{");
 const config = { id: "synthetic", label: "Synthetic", kind: "pi-local" as const, agentConfig: { agentDir: f.agent }, env: { HOME: f.dir, PI_BIN: join(f.dir, "pi") } };
 const result = await maintainHost(config, { op: "ensure" }, f.body);
 assert.equal(result.state, "error");
 assert.ok(result.detail.includes(join(f.store, name)), result.detail);
 assert.match(result.detail, /retry|restart AmPi/);
 assert.equal(result.serviceLogPath, join(f.store, "service.log"));
});

for (const missing of ["store", "lock", "socket"]) test(`Arc resident exits when its ${missing} disappears`, { timeout: 5000 }, async t => {
 const f = await fixture(t), resident = await f.manage("ensure");
 rmSync(missing === "store" ? f.store : missing === "lock" ? join(f.store, "service.lock") : serviceAddress(f.store), { recursive: true, force: true });
 const deadline = performance.now() + 3000;
 while (true) {
  try { process.kill(resident.pid, 0); } catch { break; }
  assert.ok(performance.now() < deadline, `resident outlived its missing ${missing}`);
  await new Promise(resolve => setTimeout(resolve, 25));
 }
});

test("Arc maintenance: stopped means the prior lifetime-lock owner has exited", async t => {
 const f = await fixture(t), live = await f.manage("ensure");
 assert.equal(live.running, true);
 const stopped = await f.manage("stop");
 assert.equal(stopped.state, "stopped");
 assert.throws(() => process.kill(live.pid, 0), { code: "ESRCH" }, "socket closure alone does not prove the resident exited");
 const probe = launchLocked(f.store, ["-e", "process.exit(0)"], { stdio: "ignore" });
 const code = await new Promise<number | null>((resolve, reject) => { probe.once("exit", resolve); probe.once("error", reject); });
 assert.equal(code, 0, "the prior lifetime lock is free");
});

test("Arc maintenance: concurrent ensure and held-lock probes return plain coded results", { timeout: 20000 }, async t => {
 const f = await fixture(t);
 const replies = await Promise.all(Array.from({ length: 5 }, () => f.manage("ensure")));
 assert.ok(replies.some(r => r.running === true));
 assert.ok(replies.every(r => r.state === "running"), JSON.stringify(replies));
 const pids = replies.filter(r => r.pid).map(r => r.pid); assert.equal(new Set(pids).size, 1);
 await f.manage("stop");
 const holder = launchLocked(f.store, ["-e", "console.log('held');setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "pipe"] });
 t.after(() => holder.kill("SIGKILL")); await new Promise<void>((resolve, reject) => { holder.stdout!.once("data", () => resolve()); holder.once("error", reject); });
 const config = { id: "synthetic", label: "Synthetic", kind: "pi-local" as const, agentConfig: { agentDir: f.agent }, env: { HOME: f.dir, PI_BIN: join(f.dir, "pi") } };
 const waitingAt = Date.now();
 const busy = await maintainHost(config, { op: "ensure", timeoutMs: 350 }, f.body);
 assert.ok(Date.now() - waitingAt >= 350);
 assert.equal(busy.state, "busy"); assert.equal(busy.detail, "Arc service holds its lock but does not answer");
 assert.equal(serviceText(busy), "synthetic: Arc service holds its lock but does not answer. Run ampi arc status --host synthetic before retrying.");
 assert.doesNotMatch(JSON.stringify(busy), /data:text|base64|at manage/);
 const failed = await maintainHost(config, { op: "status" }, "export async function manage(){throw new Error('Synthetic maintenance failure')}");
 assert.equal(failed.state, "error"); assert.equal(failed.detail, "Synthetic maintenance failure");
 assert.equal(failed.serviceLogPath, join(f.store, "service.log"));
 assert.ok(serviceText(failed).includes(`Synthetic maintenance failure. Run ampi arc status --host synthetic; the log is ${join(f.store, "service.log")}`)); assert.doesNotMatch(JSON.stringify(failed), /data:text|base64|at manage/);
 const invalid = await maintainHost(config, { op: "status" }, "export async function manage(){return undefined}");
 assert.equal(invalid.state, "error");
 const missing = await maintainHost({ ...config, remoteNode: join(f.dir, "absent-node") }, { op: "status" }, f.body);
 assert.equal(missing.state, "cannot-start"); assert.equal(missing.prerequisite, "node");
 const keys = Object.keys(serviceStatus("synthetic"));
 for (const result of [busy, failed, invalid, missing]) for (const key of keys) assert.ok(Object.hasOwn(result, key), key);
});

test("Arc bundle: source-tree markers and test overrides stamp the release line", { timeout: 15000 }, async t => {
 const root = mkdtempSync(join(tmpdir(), "arc-line-")), app = join(root, "apps/ampi"), script = join(app, "scripts/build-arc-service.mjs");
 t.after(() => rmSync(root, { recursive: true, force: true }));
 mkdirSync(join(app, "scripts"), { recursive: true }); mkdirSync(join(root, "release/public"), { recursive: true });
 copyFileSync(join(import.meta.dirname, "../scripts/build-arc-service.mjs"), script);
 symlinkSync(join(import.meta.dirname, "../src"), join(app, "src"), "dir");
 symlinkSync(join(import.meta.dirname, "../../../node_modules"), join(app, "node_modules"), "dir");
 symlinkSync(join(import.meta.dirname, "../../trace-analytics"), join(root, "apps/trace-analytics"), "dir");
 const unstamped = spawnSync(process.execPath, [script, join(root, "unstamped.mjs")], { cwd: root, env: { HOME: root, PATH: process.env.PATH }, encoding: "utf8", timeout: 5000 });
 assert.notEqual(unstamped.status, 0, "A source export without Git metadata must supply its build order");
 assert.match(unstamped.stderr, /git log/);
 const run = (override?: string) => {
  const output = join(root, "built-" + Math.random() + ".mjs");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `const {buildArcService}=await import(${JSON.stringify(script)});console.log(JSON.stringify(await buildArcService(${JSON.stringify(output)}, {buildOrder:123})));`], { cwd: root, env: { HOME: root, PATH: process.env.PATH, ...(override === undefined ? {} : { AMPI_RELEASE_LINE: override }) }, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const facts = JSON.parse(result.stdout);
  assert.equal(facts.buildOrder, 123);
  const value = spawnSync(process.execPath, ["--input-type=module", "-e", `const m=await import(${JSON.stringify(output)});console.log(JSON.stringify(m.releaseLine));`], { cwd: root, encoding: "utf8", timeout: 5000 });
  assert.equal(value.status, 0, value.stderr); assert.equal(JSON.parse(value.stdout), facts.releaseLine); return facts;
 };
 assert.equal(run().releaseLine, "stable");
 writeFileSync(join(root, "release/public/export-manifest.durable.json"), "{}");
 assert.equal(run().releaseLine, "durable");
 assert.equal(run("stable").releaseLine, "stable");
 assert.equal(run("unknown").releaseLine, null);
});

test("Arc status: wording gives concrete actions and paths", () => {
 const facts = (state: import("../src/arc/service/status.ts").ServiceState, extra = {}) => serviceStatus("synthetic", { state, ...extra });
 assert.equal(serviceText(facts("stopped")), "synthetic: Arc service is stopped. A linked hub restarts it within seconds.");
 assert.equal(serviceText(facts("invalid-settings", { settingsPath: "/synthetic/settings.json", settingsKey: "$" })), "synthetic: /synthetic/settings.json is not valid JSON. Fix the file, then run ampi arc status --host synthetic.");
 assert.equal(serviceText(facts("cannot-start", { serviceLogPath: "/synthetic/agent/ampi-arc/service.log" })), "synthetic: Arc service cannot start: check /synthetic/agent/ampi-arc/service.log.");
 assert.equal(serviceText(facts("cannot-start", { prerequisite: "pi-auth-check" })), "synthetic: Arc service cannot start: this Pi has no pi auth check. Update Pi on synthetic.");
});

test("Arc status: typed settings, auth caching, version facts and stopping cause", { timeout: 40000 }, async t => {
 const f = await fixture(t, true), model = blockingModel(f), auth = join(f.dir, "auth-checks");
 const pi = join(f.dir, "pi");
 writeFileSync(pi, readFileSync(pi, "utf8").replace("if(process.argv[2]==='auth'){", `if(process.argv[2]==='auth'){fs.appendFileSync(${JSON.stringify(auth)},'check\\n');`));
 const first = await f.manage("ensure"); assert.equal(first.releaseLine, "stable"); assert.ok(first.buildOrder > 0);
 const schedule = join(f.store, "schedule.json");
 const seen = () => existsSync(schedule) && JSON.parse(readFileSync(schedule, "utf8"))["pi:fixture-session"]?.seen;
 await until(() => seen() === "u5", "initial source scan did not settle");
 const session = join(f.agent, "sessions", "session.jsonl");
 writeFileSync(session, readFileSync(session, "utf8") + JSON.stringify({ type: "message", id: "u6", parentId: "u5", message: { role: "user", content: "Synthetic idle scan witness." } }) + "\n");
 const clock = await f.advance(31000); assert.equal(clock.elapsed, 31000); assert.ok(clock.ticks > 0);
 // The new source observation proves that the production interval scanned after clock advancement.
 await until(() => seen() === "u6", "virtual interval did not scan the appended source");
 assert.equal(existsSync(auth), false, "idle polling must not refresh OAuth");
 await f.manage("status"); assert.equal(readFileSync(auth, "utf8"), "check\n");
 await controlRequest(f.store, { op: "snapshot" }); await f.manage("ensure"); assert.equal(readFileSync(auth, "utf8"), "check\n");
 f.settings({ retries: 9 }); const bad = await f.manage("status");
 assert.equal(bad.state, "invalid-settings"); assert.equal(bad.settingsPath, join(f.agent, "settings.json")); assert.equal(bad.settingsKey, "ampi_arc.retries"); assert.doesNotMatch(bad.detail, /ampi_arc: ampi_arc/);
 writeFileSync(join(f.agent, "settings.json"), JSON.stringify({ sessionDir: 3 })); const sessionBad = await f.manage("status");
 assert.equal(sessionBad.settingsKey, "sessionDir"); assert.equal(sessionBad.settingsPath, join(f.agent, "settings.json"));
 writeFileSync(join(f.agent, "settings.json"), "{"); const malformed = await f.manage("status");
 assert.equal(malformed.settingsKey, "$"); assert.equal(serviceText(malformed), `synthetic: ${join(f.agent, "settings.json")} is not valid JSON. Fix the file, then run ampi arc status --host synthetic.`);
 f.settings(); await controlRequest(f.store, request("drain")); await until(() => existsSync(model.pid), "model never received prompt");
 f.pids.add(Number(readFileSync(model.pid, "utf8"))); assert.equal(readFileSync(auth, "utf8"), "check\ncheck\n");
 assert.equal((await controlRequest(f.store, { op: "stop" })).state, "stopping", "stop was labelled update");
 const stopped = await f.manage("stop"); assert.equal(stopped.state, "stopped");
 assert.equal(serviceText(stopped), "synthetic: Arc service is stopped. A linked hub restarts it within seconds.");
});

test("Arc stop reaps current children and exits when the store disappears during cancellation", { timeout: 10000 }, async t => {
 const f = await fixture(t), model = blockingModel(f);
 const marker = "if (cancelActive) {";
 assert.ok(f.body.includes(marker));
 writeFileSync(f.bundle, f.body.replace(marker, marker + " rmSync(lock.store, { recursive: true, force: true });"));
 const resident = await f.manage("ensure"); await controlRequest(f.store, request("lost-authority"));
 await until(() => existsSync(model.pid), "model never received prompt");
 const child = Number(readFileSync(model.pid, "utf8")); f.pids.add(child);
 await f.manage("stop");
 const deadline = performance.now() + 3000;
 while (true) {
  try { process.kill(resident.pid, 0); } catch { break; }
  assert.ok(performance.now() < deadline, "resident outlived lost authority during cancellation");
  await new Promise(resolve => setTimeout(resolve, 25));
 }
 assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
});
test("Arc old resident leaves a successor socket after losing lock identity", { timeout: 5000 }, async t => {
 const f = await fixture(t), resident = await f.manage("ensure"), address = serviceAddress(f.store);
 rmSync(join(f.store, "service.lock")); writeFileSync(join(f.store, "service.lock"), "successor"); rmSync(address);
 const successor = createServer(socket => socket.on("data", () => socket.end('{"state":"successor"}\n')));
 await new Promise<void>(resolve => successor.listen(address, resolve)); t.after(() => successor.close());
 process.kill(resident.pid, "SIGTERM");
 const deadline = performance.now() + 3000;
 while (true) {
  try { process.kill(resident.pid, 0); } catch { break; }
  assert.ok(performance.now() < deadline, "old resident did not end"); await new Promise(resolve => setTimeout(resolve, 25));
 }
 assert.equal(existsSync(address), true, "old resident cannot unlink its successor socket");
 assert.equal((await rawControlRequest(f.store, { op: "status" })).state, "successor");
});
test("Arc stop retains its lock after a valid-store save failure, then exits after authority loss", async t => {
 const f = await fixture(t), model = blockingModel(f), marker = "function durableJson(lock, name, value) {";
 assert.ok(f.body.includes(marker));
 writeFileSync(f.bundle, f.body.replace(marker, marker + ` if(name==='builder.json' && Object.values(value.jobs??{}).some(job=>job.record.state==='cancelled')) throw new Error('synthetic terminal persistence failure');`));
 const resident = await f.manage("ensure"); await controlRequest(f.store, request("failed-terminal-save"));
 await until(() => existsSync(model.pid), "model never received prompt"); f.pids.add(Number(readFileSync(model.pid, "utf8")));
 assert.equal((await f.manage("stop", { timeoutMs: 500 })).state, "busy");
 process.kill(resident.pid, 0);
 assert.equal((await controlRequest(f.store, { op: "status", refreshAuth: false })).state, "stopping");
 process.kill(resident.pid, "SIGTERM"); await new Promise(resolve => setTimeout(resolve, 100));
 process.kill(resident.pid, 0);
 assert.match(readFileSync(join(f.store, "service.log"), "utf8"), /Arc service stop failed: synthetic terminal persistence failure/);
 rmSync(f.store, { recursive: true, force: true });
 const deadline = performance.now() + 3000;
 while (true) {
  try { process.kill(resident.pid, 0); } catch { break; }
  assert.ok(performance.now() < deadline, "failed-stop resident did not observe later authority loss");
  await new Promise(resolve => setTimeout(resolve, 25));
 }
});

test("Arc stop cancels hanging model I/O, persists cancellation before unlock, and permits an explicit later Build", { timeout: 25000 }, async t => {
 const f = await fixture(t), model = blockingModel(f);
 const pi = join(f.dir, "pi");
 writeFileSync(pi, readFileSync(pi, "utf8").replace("let body='';", "process.on('SIGTERM',()=>{});let body='';"));
 await f.manage("ensure");
 const accepted = await controlRequest(f.store, request("cancel-hanging"));
 await until(() => existsSync(model.pid), "model never received prompt");
 const pid = Number(readFileSync(model.pid, "utf8")); f.pids.add(pid);
 const started = performance.now();
 const stopped = await Promise.all([f.manage("stop"), f.manage("stop")]);
 assert.ok(stopped.every(result => result.state === "stopped"), JSON.stringify(stopped));
 const elapsed = performance.now() - started; t.diagnostic(`concurrent stop completed in ${elapsed.toFixed(1)} ms`);
 assert.ok(elapsed < 10000, "stop must retain its ten-second deadline");
 assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "stop must reap the model before unlock");
 const saved = JSON.parse(readFileSync(join(f.store, "builder.json"), "utf8")), job = saved.jobs[accepted.buildId];
 assert.equal(job.state, "cancelled"); assert.equal(job.record.state, "cancelled"); assert.ok(job.record.endedAt);
 assert.equal(job.record.usage.cost, null, "process exit cannot prove the interrupted call was free");
 assert.equal(saved.sessions["pi:fixture-session"].status.pause, "uncertain-call");
 writeFileSync(model.release, "release"); await f.manage("ensure");
 const retry = await controlRequest(f.store, request("after-cancel"));
 assert.equal(retry.outcome, "accepted"); assert.notEqual(retry.buildId, accepted.buildId);
 const retried = JSON.parse(readFileSync(join(f.store, "builder.json"), "utf8")).jobs[retry.buildId];
 assert.equal(retried.record.possibleRepeatCost, true); assert.equal(retried.record.retryOf, accepted.buildId);
 await until(async () => (await controlRequest(f.store, {op: "snapshot"})).statuses.some((s: any) => s.buildId === retry.buildId && s.state === "idle"), "later Build did not finish");
 assert.equal((await f.manage("stop")).state, "stopped");
});

test("Arc status: a failed store fences Builds and gives the restart action", { timeout: 15000 }, async t => {
 const f = await fixture(t); blockingModel(f); await f.manage("ensure");
 const state = join(f.store, "builder.json"), saved = readFileSync(state); rmSync(state); mkdirSync(state);
 await assert.rejects(() => controlRequest(f.store, request("failed-flush")));
 rmSync(state, { recursive: true }); writeFileSync(state, saved);
 await until(async () => (await f.manage("status")).state === "fault", "failed store did not fence the service");
 const status = await f.manage("status");
 assert.equal(serviceText(status), "synthetic: Arc service stopped Builds after an internal error. Run ampi arc stop --host synthetic to restart it; a linked hub starts it again within seconds.");
 assert.equal((await controlRequest(f.store, request("fenced"))).outcome, "refused");
 assert.equal(existsSync(join(f.dir, "calls")), false);
});

test("Arc bundle: newer links replace older engines; older links cannot read or restart them", { timeout: 30000 }, async t => {
 const f = await fixture(t);
 assert.equal((await f.manage("status")).running, false);
 const first = await f.manage("ensure"); assert.equal(first.serviceVersion, f.version);
 const newer = await f.manage("ensure", {}, true); assert.equal(newer.serviceVersion, f.version2); assert.notEqual(newer.pid, first.pid);
 const older = await f.manage("ensure"); assert.equal(older.outcome, "refused"); assert.equal(older.code, "build-mismatch");
 assert.equal(serviceText(older), "This AmPi is older than synthetic. Update it.");
 assert.equal((await controlRequest(f.store, { op: "hello" })).running, true);
 assert.equal((await controlRequest(f.store, { op: "snapshot", stamp: f.stamp })).code, "build-mismatch");
 await f.manage("stop");
 assert.equal((await f.manage("ensure")).outcome, "refused");
 const restarted = await f.manage("ensure", {}, true); assert.equal(restarted.serviceVersion, f.version2);
 assert.deepEqual(JSON.parse(readFileSync(join(f.store, "control.json"), "utf8")).selected, { id: f.version2, line: "stable", order: 200 });
});

test("Arc relays: a newer hub updates; older hub refuses; equal hubs share one service", { timeout: 20000 }, async t => {
 // After hooks run in registration order. Relays must finish their last poll
 // before the fixture kills the service, or a poll restarts it.
 const relays: any[] = [];
 t.after(() => Promise.all(relays.map(relay => relay.close())));
 const f = await fixture(t), nextPath = join(f.dir, "next.mjs");
 const [older, newer] = await Promise.all([import(pathToFileURL(f.bundle).href), import(pathToFileURL(nextPath).href)]);
 const frames: any[][] = [[], [], []];
 const link = (module: any, body: string, n: number) => {
  const relay = module.relay(body, { host: "synthetic", agentDir: f.agent, known: {}, pollMs: 50, emit: (frame: any) => { frames[n]!.push(frame); if (frame.service?.pid) f.pids.add(frame.service.pid); } });
  relays.push(relay); return relay;
 };
 // Relay startup uses this process's synthetic Pi path.
 const prior = process.env.PI_BIN; process.env.PI_BIN = join(f.dir, "pi"); t.after(() => { if (prior === undefined) delete process.env.PI_BIN; else process.env.PI_BIN = prior; });
 link(older, f.body, 0);
 await until(() => frames[0]!.some(f => f.t === "arc.status" && f.service.serviceVersion === older.serviceVersion), "first link did not start service");
 link(newer, readFileSync(nextPath, "utf8"), 1);
 await until(() => frames[1]!.some(f => f.t === "arc.status" && f.service.serviceVersion === newer.serviceVersion), "new link did not replace service");
 await until(() => frames[0]!.some(f => f.t === "arc.status" && f.service.code === "build-mismatch"), "older link did not refuse");
 assert.equal(serviceText(frames[0]!.findLast(f => f.t === "arc.status").service), "This AmPi is older than synthetic. Update it.");
 link(newer, readFileSync(nextPath, "utf8"), 2);
 await until(() => frames[2]!.some(f => f.t === "arc.status" && f.service.running), "equal link did not connect");
 const current = await f.manage("status"); assert.equal(current.serviceVersion, newer.serviceVersion);
 assert.equal(frames[1]!.findLast(f => f.t === "arc.status").service.pid, current.pid);
 assert.equal(frames[2]!.findLast(f => f.t === "arc.status").service.pid, current.pid);
 assert.equal((await rawControlRequest(f.store, { op: "request", stamp: older.stamp, sessionRef: "pi:s", requestId: "old", kind: "manual" })).code, "build-mismatch");
});

test("Arc bundle: idle cleanup ignores incompatible handshakes without a disable marker", { timeout: 15000 }, async t => {
 const f = await fixture(t); f.settings({ serviceIdleHours: .0005 });
 const s = await f.manage("ensure"); assert.equal(s.running, true);
 assert.equal((await controlRequest(f.store, { op: "hello", stamp: { ...f.stamp, id: "incompatible" } })).code, "build-mismatch");
 await new Promise(r => setTimeout(r, 2500));
 const stopped = await f.manage("status"); assert.equal(stopped.running, false);
});

test("Arc bundle: invalid settings and missing sign-in remain visible without paid calls", { timeout: 15000 }, async t => {
 const f = await fixture(t); f.settings({ concurrency: 0 });
 assert.equal((await f.manage("ensure")).state, "invalid-settings");
 f.settings(); writeFileSync(join(f.dir, "pi"), `#!${process.execPath}\nconsole.log('{"status":"not_ready"}'); process.exit(1);\n`);
 await f.manage("stop"); await f.manage("ensure");
 let s; const end = Date.now() + 5000;
 do { await new Promise(r => setTimeout(r, 100)); s = await f.manage("status"); } while (s.state === "running" && Date.now() < end);
 assert.equal(s.state, "no-sign-in", readFileSync(join(f.store, "service.log"), "utf8")); assert.match(s.detail, /auth.json/); assert.equal(s.authPath, join(f.agent, "auth.json"));
 assert.equal(serviceText(s), `synthetic: Arc service has no sign-in for fixture/model. Sign in using ${join(f.agent, "auth.json")}.`);
});

test("Arc maintenance: a failed launcher reports its cause and full log path", {timeout:15000}, async t => {
 const f = await fixture(t);
 const config = {id:"synthetic",label:"Synthetic",kind:"pi-local" as const,agentConfig:{agentDir:f.agent},env:{HOME:f.dir,PI_BIN:join(f.dir,"pi")}};
 const body = "if (process.argv[2] === '_locked') throw new Error('Synthetic launch failure');\n" + f.body;
 const failed = await maintainHost(config, {op:"ensure",timeoutMs:5000}, body);
 assert.equal(failed.state,"error"); assert.equal(failed.serviceLogPath,join(f.store,"service.log"));
 assert.match(failed.detail,/Synthetic launch failure/);
 assert.ok(serviceText(failed).includes(join(f.store,"service.log")));
});

test("Arc CLI: strict arguments and stdin transport work with a synthetic local Host", { timeout: 15000 }, async t => {
 assert.equal(parseArcArgs(["stop", "--host", "synthetic", "--json"]).host, "synthetic");
 assert.equal(parseArcArgs(["stop", "--all"]).all, true);
 for (const args of [["enable"], ["update"], ["stop"], ["status", "--all", "--host", "synthetic"], ["enable", "--generation", "NaN"], ["status", "--disable"], ["stop", "--generation", "1"], ["enable", "--host"], ["status", "--other"]]) assert.throws(() => parseArcArgs(args));
 const remote = maintenanceLaunch({ id: "synthetic", label: "Synthetic", kind: "pi-ssh", remoteNode: "/synthetic/Node's bin/node" });
 assert.equal(remote.command, "ssh"); assert.ok(remote.args.includes("BatchMode=yes")); assert.match(remote.args.at(-1)!, /input-type=module/);
 const f = await fixture(t);
 const config = { id: "synthetic", label: "Synthetic", kind: "pi-local" as const, agentConfig: { agentDir: f.agent }, env: { HOME: f.dir, PI_BIN: join(f.dir, "pi") } };
 const configPath = join(f.dir, "hub.json"); writeFileSync(configPath, JSON.stringify({ self: "synthetic", hosts: [config] }));
 const cli = spawnSync(process.execPath, [join(import.meta.dirname, "../bin/ampi.mjs"), "arc", "status", "--config", configPath, "--host", "synthetic", "--json"], { env: { HOME: f.dir, AMPI_HOME: f.dir, PATH: process.env.PATH }, encoding: "utf8", timeout: 10000 });
 assert.equal(cli.status, 0, cli.stderr); assert.deepEqual(JSON.parse(cli.stdout).map((s: any) => [s.host, s.running]), [["synthetic", false]]);
 const unknown = spawnSync(process.execPath, [join(import.meta.dirname, "../bin/ampi.mjs"), "arc", "status", "--config", configPath, "--host", "unknown"], { env: { HOME: f.dir, PATH: process.env.PATH }, encoding: "utf8", timeout: 10000 });
 assert.equal(unknown.status, 2); assert.match(unknown.stderr, /No Pi Host matches unknown. Hosts: synthetic/);
 const brokenConfig = join(f.dir, "broken.json"); writeFileSync(brokenConfig, "{");
 const badConfig = spawnSync(process.execPath, [join(import.meta.dirname, "../bin/ampi.mjs"), "arc", "status", "--config", brokenConfig], { env: { HOME: f.dir, PATH: process.env.PATH }, encoding: "utf8", timeout: 10000 });
 assert.equal(badConfig.status, 1);
 assert.equal((await maintainHost(config, { op: "status" }, f.body)).running, false);
 const started = await maintainHost(config, { op: "ensure" }, f.body); f.pids.add(started.pid); assert.equal(started.running, true);
 const stopped = await maintainHost(config, { op: "stop" }, f.body); assert.equal(stopped.running, false);
});

test("Arc bundle: original source builds without a hub, persists a receipt and deduplicates restart triggers", { timeout: 40000 }, async t => {
 const f = await fixture(t), sessions = join(f.agent, "sessions"); mkdirSync(sessions);
 const rows: any[] = [{ type: "session", version: 3, id: "fixture-session", timestamp: "2026-01-01T00:00:00Z", cwd: "/synthetic/project" }];
 for (let n = 0; n < 6; n++) rows.push({ type: "message", id: "u" + n, parentId: n ? "u" + (n - 1) : null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "Synthetic evidence " + n + "." } });
 writeFileSync(join(sessions, "session.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
 const calls = join(f.dir, "calls");
 writeFileSync(join(f.dir, "pi"), `#!${process.execPath}
const fs=require('node:fs');
if(process.argv[2]==='auth'){console.log('{"status":"ready"}');process.exit(0);}
let body='';process.stdin.on('data',b=>body+=b);process.stdin.on('end',()=>{
 const data=JSON.parse(body.split('\\nAnswer rejected:')[0]),item=data.rarebits.at(-1),claim={text:'Review the work.',cites:[{id:item.id,quote:item.text}]};
 fs.appendFileSync(${JSON.stringify(calls)},'call\\n');
 const answer={goal:claim,now:claim,chapters:[{firstId:data.rarebits[0].id,label:'Reviewing the work',closed:true,summary:{scope:claim,bullets:[]}}],points:[]};
 console.log(JSON.stringify({type:'message_end',message:{role:'assistant',provider:'fixture',model:'model',stopReason:'stop',content:[{type:'text',text:JSON.stringify(answer)}],usage:{input:10,output:5,cost:{total:0.01}}}}));
});
`);
 f.settings({ auto: true }); await f.manage("ensure");
 let snapshot; const end = Date.now() + 30000;
 do { await new Promise(r => setTimeout(r, 100)); snapshot = await controlRequest(f.store, { op: "snapshot" }); } while (!snapshot.receipts.length && Date.now() < end);
 assert.equal(snapshot.receipts.length, 1, JSON.stringify(snapshot));
 assert.equal(snapshot.receipts[0].receipt.builds[0].usage.cost, .01);
 assert.equal(readFileSync(calls, "utf8"), "call\n");
 const revision = snapshot.receipts[0].revision;
 await f.manage("stop"); await f.manage("ensure"); await new Promise(r => setTimeout(r, 2300));
 assert.equal(readFileSync(calls, "utf8"), "call\n");
 assert.equal((await controlRequest(f.store, { op: "snapshot" })).receipts[0].revision, revision);
});

test("Arc resident answers status and stop during a long open tail with settled-point history", { timeout: 20000 }, async t => {
 const f = await fixture(t), model = blockingModel(f), entered = join(f.dir, "prompt-preparation");
 const sessions = join(f.agent, "sessions"), file = join(sessions, "session.jsonl");
 const rows: any[] = [{ type: "session", version: 3, id: "fixture-session", timestamp: "2026-01-01T00:00:00Z", cwd: "/synthetic/project" }];
 for (let n = 0; n < 1808; n++) rows.push({ type: "message", id: `u${n}`, parentId: n ? `u${n - 1}` : null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: `Synthetic evidence ${n}. ` + "Long open chapter evidence. ".repeat(6) } });
 writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
 const snapshot = await piSource({ sessionsDir: sessions, storeDir: f.store }).snapshot("pi:fixture-session");
 const items = snapshot.items.slice(0, 1000), partial = { ...snapshot, items, entries: snapshot.entries.slice(0, snapshot.entries.findIndex(entry => entry.id === snapshot.items[1000]!.id)), fingerprint: fingerprint(items) };
 const claim = { text: "Review the evidence.", cites: [{ id: items[0]!.id, quote: "Synthetic evidence 0." }] };
 const chapter = { firstId: items[0]!.id, label: "Reviewed earlier evidence", closed: true, summary: { scope: claim, bullets: [] } };
 const receipt = storeAnswer({ goal: claim, now: claim, chapters: [chapter, { ...chapter, firstId: items[100]!.id, label: "Reviewing open evidence", closed: false }], points: Array.from({ length: 1200 }, () => ({ kind: "request" as const, state: "done" as const, by: "owner" as const, title: "Review the synthetic settled request history", text: "Done: reviewed the evidence.", cites: claim.cites })) }, partial, undefined, "2026-01-01T00:00:00Z", "fixture/model", []);
 mkdirSync(f.store, { recursive: true });
 writeFileSync(join(f.store, "builder.json"), JSON.stringify({ schema: 1, revision: 1, commands: {}, jobs: {}, sessions: { "pi:fixture-session": { receipt: { revision: 1, sessionRef: "pi:fixture-session", receipt } } } }));
 const marker = "function compactPrevious(previous) {";
 const start = f.body.indexOf(marker); assert.ok(start >= 0);
 const block = f.body.slice(start, f.body.indexOf("\n}", start) + 2);
 const traced = block.replace(marker, marker + ` const tracePreparation = previous?.points.length > 500, preparationStart = performance.now(); if(tracePreparation) { console.error('PREPARATION_DIAG '+JSON.stringify({phase:'compactPrevious-begin',at:Date.now()})); markPreparation(${JSON.stringify(entered)},'entered'); } try {`).replace(/\n}$/, `} finally { if(tracePreparation) console.error('PREPARATION_DIAG '+JSON.stringify({phase:'compactPrevious',ms:performance.now()-preparationStart})); }\n}`);
 let instrumented = f.body.replace(block, traced);
 for (const [begin, end, phase] of [
  ["let tail = source.items.slice", "const shortened = tailStart > 0;", "full-tail"],
  ["const positions = /* @__PURE__ */ new Map();", "const itemStart =", "entry-index"],
  ["const itemStart =", 'const prompt = prefix + serialized.join(",") + suffix;', "window-selection"]
 ]) {
  assert.ok(instrumented.includes(begin) && instrumented.includes(end), `missing ${phase} markers`);
  instrumented = instrumented.replace(begin, `const phaseStart${phase.replaceAll("-", "")} = performance.now(); ` + begin).replace(end, `console.error('PREPARATION_DIAG '+JSON.stringify({phase:${JSON.stringify(phase)},ms:performance.now()-phaseStart${phase.replaceAll("-", "")}})); ` + end);
 }
 const persist = "function durableJson(lock, name, value) {";
 assert.ok(instrumented.includes(persist));
 instrumented = instrumented.replace(persist, persist + " const persistenceStart = performance.now();").replace('rmSync(temporary, { force: true });', `console.error('PREPARATION_DIAG '+JSON.stringify({phase:'persistence',name,ms:performance.now()-persistenceStart})); rmSync(temporary, { force: true });`);
 const stopTrace = join(f.dir, "stop-phases");
 for (const [marker, addition] of [
  ["async function manage(body, operation) {", "if(operation.op==='stop') markStop('manager-enter');"],
  ["async function lockedMain(operation, body) {", "if(operation.op==='stop') markStop('lock-owner-enter');"],
  ["function stop(cancelActive = false) {", "if(cancelActive) markStop('resident-cancel-enter');"],
  ["await checking;", "markStop('resident-children-and-cancellation-durable');"]
 ]) {
  assert.ok(instrumented.includes(marker), `missing stop marker ${marker}`);
  instrumented = instrumented.replace(marker, marker + addition);
 }
 instrumented = instrumented.replaceAll("options.exit();", "markStop('resident-exit-called'); options.exit();");
 writeFileSync(f.bundle, `import {writeFileSync as markPreparation,appendFileSync as appendStop} from 'node:fs';\nfunction markStop(phase){appendStop(${JSON.stringify(stopTrace)},JSON.stringify({phase,at:Date.now()})+'\\n');}\n` + instrumented);
 await f.manage("ensure"); await controlRequest(f.store, request("long-history"));
 await until(() => existsSync(entered), "prompt preparation did not start");
 try {
  let start = performance.now();
  assert.equal((await controlRequest(f.store, {op: "status", refreshAuth: false}, 1000)).state, "running");
  t.diagnostic(`long-history status: ${(performance.now() - start).toFixed(1)} ms`);
  const stopAt = Date.now();
  start = performance.now(); assert.equal((await f.manage("stop")).state, "stopped");
  t.diagnostic(`long-history stop: ${(performance.now() - start).toFixed(1)} ms`);
  for (const line of readFileSync(stopTrace, "utf8").trim().split("\n")) { const phase = JSON.parse(line); t.diagnostic(`stop phase ${phase.phase}: +${phase.at - stopAt} ms`); }
 } finally {
  for (const line of readFileSync(join(f.store, "service.log"), "utf8").split("\n").filter(line => line.startsWith("PREPARATION_DIAG "))) t.diagnostic(line);
  if (existsSync(model.pid)) f.pids.add(Number(readFileSync(model.pid, "utf8")));
 }
});

for (const release of [false, true]) test(`Arc stop proves completion from the lifetime lock after a lost control reply (release=${release})`, async t => {
 const f = await fixture(t), marker = "stop(true).catch";
 assert.ok(f.body.includes(marker));
 writeFileSync(f.bundle, f.body.replace(marker, "for (const socket of sockets) socket.destroy(); " + (release ? marker : "Promise.resolve().catch")));
 await f.manage("ensure");
 const stopped = await f.manage("stop", { timeoutMs: release ? 10000 : 500 });
 assert.equal(stopped.state, release ? "stopped" : "busy", "a lost control acknowledgement cannot replace the lifetime-lock proof");
 if (!release) assert.equal((await f.manage("status")).running, true, "the held owner remains alive");
});

for (const held of [false, true]) test(`Arc stop tolerates socket loss after status and proves the lifetime lock (held=${held})`, async t => {
 const f = await fixture(t), ready = join(f.dir, "held-lock-ready");
 mkdirSync(f.store, { recursive: true });
 let owner: ReturnType<typeof launchLocked> | undefined;
 if (held) {
  owner = launchLocked(f.store, ["-e", "require('node:fs').writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000)", ready], { stdio: "ignore" });
  t.after(async () => { if (owner?.exitCode === null) { owner.kill("SIGKILL"); await once(owner, "close"); } });
  await until(() => existsSync(ready), "lifetime-lock owner did not start");
 }
 const socketPath = serviceAddress(f.store), server = createServer(socket => socket.once("data", () => {
  // The status was valid, but its endpoint disappears before the stop command.
  server.close();
  socket.end(JSON.stringify({ running: true, state: "running", stamp: f.stamp }) + "\n");
 }));
 t.after(() => { if (server.listening) server.close(); });
 await new Promise<void>(resolve => server.listen(socketPath, resolve));
 const result = await f.manage("stop", { timeoutMs: held ? 500 : 10000 });
 assert.equal(existsSync(socketPath), false);
 assert.equal(result.state, held ? "busy" : "stopped");
 if (held) assert.equal(owner!.exitCode, null, "an absent endpoint cannot prove that its lock owner exited");
});

test("Arc stop escalates an update drain and fences new commands from both clients", { timeout: 15000 }, async t => {
 const f = await fixture(t), model = blockingModel(f); await f.manage("ensure");
 const accepted = await controlRequest(f.store, request("before-drain"));
 await until(() => existsSync(model.pid), "model never received prompt"); f.pids.add(Number(readFileSync(model.pid, "utf8")));
 assert.equal((await controlRequest(f.store, { op: "offer", stamp: { id: f.version2, order: 200, line: "stable" } })).state, "updating");
 assert.deepEqual(await controlRequest(f.store, request("before-drain")), accepted);
 for (const requester of ["client-one", "client-two"]) {
  const result = await controlRequest(f.store, { ...request(requester), requester });
  assert.equal(result.outcome, "refused"); assert.equal(result.code, "service");
 }
 assert.equal((await f.manage("stop")).state, "stopped");
 assert.equal(JSON.parse(readFileSync(join(f.store, "builder.json"), "utf8")).jobs[accepted.buildId].record.state, "cancelled");
});

test("Arc bundle: update drains a recorded call, fences admission and retains the committed receipt", { timeout: 20000 }, async t => {
 const f = await fixture(t), model = blockingModel(f); await f.manage("ensure");
 const accepted = await controlRequest(f.store, request("first")); assert.equal(accepted.outcome, "accepted");
 await until(() => existsSync(model.pid), "model never received prompt"); f.pids.add(Number(readFileSync(model.pid, "utf8")));
 const updating = f.manage("ensure", {}, true);
 await until(async () => (await controlRequest(f.store, { op: "status" })).state === "updating", "update did not drain");
 assert.deepEqual(await controlRequest(f.store, request("first")), accepted);
 assert.deepEqual(await controlRequest(f.store, request("during-drain")), { outcome: "refused", code: "service", transient: true, detail: "Arc service is draining or fenced" });
 writeFileSync(model.release, "release"); const updated = await updating; assert.equal(updated.serviceVersion, f.version2, JSON.stringify(updated));
 const snapshot = await controlRequest(f.store, { op: "snapshot" }); assert.equal(snapshot.receipts.length, 1); assert.equal(snapshot.receipts[0].receipt.builds[0].usage.cost, .01);
 assert.equal(readFileSync(model.calls, "utf8"), "call\n");
});

test("Arc drain: accepted Dismiss replays without a new write; new Dismiss remains transient", { timeout: 20000 }, async t => {
 const f = await fixture(t), model = blockingModel(f, true); f.settings({ retries: 0 }); writeFileSync(model.release, "release");
 await f.manage("ensure"); await controlRequest(f.store, request("initial"));
 await until(async () => (await controlRequest(f.store, {op:"snapshot"})).receipts.length > 0, "initial receipt");
 const receipt = (await controlRequest(f.store, {op:"snapshot"})).receipts[0], drop = receipt.receipt.drops[0];
 const command = {op:"dismiss" as const, sessionRef:"pi:fixture-session", requestId:"accepted-dismiss", dropId:drop.id, toPosition:drop.toPosition};
 const original = await controlRequest(f.store, command); assert.equal(original.outcome, "dismissed");
 rmSync(model.release); rmSync(model.pid, {force:true});
 await controlRequest(f.store, {...request("held-rebuild"),kind:"rebuild"});
 await until(() => existsSync(model.pid), "held second call"); f.pids.add(Number(readFileSync(model.pid, "utf8")));
 const updating = f.manage("ensure", {}, true);
 await until(async () => (await controlRequest(f.store, {op:"status"})).state === "updating", "no drain");
 assert.deepEqual(await controlRequest(f.store, command), original);
 const newResult = await controlRequest(f.store, {...command,requestId:"new-dismiss"});
 assert.equal(newResult.code, "service"); assert.equal(newResult.transient, true);
 assert.equal(JSON.parse(readFileSync(join(f.store,"builder.json"),"utf8")).commands["new-dismiss"], undefined);
 writeFileSync(model.release,"release"); await updating;
 assert.deepEqual(await controlRequest(f.store, command), original);
 assert.equal(readFileSync(model.calls,"utf8"), "call\ncall\n");
});

test("Arc replacement: a drain timeout gives the Host update action", { timeout: 15000 }, async t => {
 const f = await fixture(t), model = blockingModel(f); await f.manage("ensure");
 await controlRequest(f.store, request("held-for-update"));
 await until(() => existsSync(model.pid), "model did not start"); f.pids.add(Number(readFileSync(model.pid, "utf8")));
 const clock = managerClock(f), observed = join(f.dir, "observed-lock-phase"), next = join(f.dir, "next.mjs");
 const original = readFileSync(next, "utf8"), seam = 'phase = "lock";';
 assert.equal(original.split(seam).length, 2);
 writeFileSync(next, original.replace(seam, `{ phase = "lock"; writeFileSync(${JSON.stringify(observed)}, "observed"); }`));
 const pending = f.manage("ensure", { timeoutMs: 150 }, true, clock.env);
 await until(() => existsSync(observed), "manager did not observe the guardian's lock phase");
 await clock.advance(150);
 const failed = await pending;
 assert.equal(failed.code, "replacement-failed");
 assert.equal(failed.serviceLogPath, join(f.store, "service.log"));
 assert.match(serviceText(failed), /synthetic: AmPi could not replace the older Arc service \(timed out waiting for the service to drain and release its lock\)/);
 assert.ok(serviceText(failed).endsWith(`Run ampi arc status --host synthetic; the log is ${join(f.store, "service.log")}.`));
 writeFileSync(model.release, "release");
});

for (const phase of ["lock", "startup", "legacy"] as const) test(`Arc replacement deadline preserves the observed guardian phase (${phase})`, { timeout: 15000 }, async t => {
 const f = await fixture(t), model = blockingModel(f), guardian = join(f.dir, "guardian-pid"), held = join(f.dir, "held-phase-pid");
 await f.manage("ensure");
 if (phase !== "startup") {
  await controlRequest(f.store, request("phase-held"));
  await until(() => existsSync(model.pid), "model did not start");
  f.pids.add(Number(readFileSync(model.pid, "utf8")));
 }
 const path = join(f.dir, "next.mjs"), original = readFileSync(path, "utf8");
 const lockSeam = "flock($lock, LOCK_EX | LOCK_NB) or exit(73);";
 const seam = phase === "startup" ? "  exec {$node} $node, @args;" : lockSeam;
 assert.equal(original.split(seam).length, 2);
 // Delay phase delivery, then hold the exact phase across the unchanged deadline.
 const record = (path: string) => `open(my $probe, '>', '${path}') or die $!; print {$probe} $$; close($probe);\n`;
 let body = original.replace("my ($store, $node, @args) = @ARGV;", "select(undef, undef, undef, 0.03);\nmy ($store, $node, @args) = @ARGV;")
  .replace(lockSeam, () => record(guardian) + lockSeam)
  .replace(seam, () => record(held) + "select(undef, undef, undef, 10);\n" + seam);
 if (phase === "legacy") body = body.replace('syswrite($parent, "W")', "1").replace('syswrite($parent, "L")', "1");
 writeFileSync(path, body);
 const failed = await f.manage("ensure", { timeoutMs: 150 }, true);
 assert.equal(failed.code, "replacement-failed");
 assert.match(failed.detail, phase === "lock" ? /timed out waiting for the service to drain and release its lock/ : /Arc service startup timed out/);
 for (const pidFile of [guardian, held]) {
  assert.ok(existsSync(pidFile), "launcher did not reach the held phase");
  const pid = Number(readFileSync(pidFile, "utf8")); assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "a deadline must reap the guardian and its child before replying");
 }
 writeFileSync(model.release, "release");
});

test("Arc bundle: a service crash retains survivor capacity and charge uncertainty until an explicit press", { timeout: 20000 }, async t => {
 const f = await fixture(t), model = blockingModel(f); const first = await f.manage("ensure");
 await controlRequest(f.store, request("before-crash"));
 await until(() => existsSync(model.pid), "model never received prompt"); const pid = Number(readFileSync(model.pid, "utf8")); f.pids.add(pid);
 process.kill(first.pid, "SIGKILL");
 await until(async () => { try { await controlRequest(f.store, { op: "status" }, 100); return false; } catch { return true; } }, "service survived SIGKILL");
 const restarted = await f.manage("ensure"); assert.equal(restarted.runningBuilds, 1);
 let snapshot = await controlRequest(f.store, { op: "snapshot" }); assert.equal(snapshot.statuses[0].pause, "uncertain-call");
 await controlRequest(f.store, request("after-crash"));
 await until(async () => (await controlRequest(f.store, { op: "snapshot" })).statuses[0].waitCause === "survivor", "survivor did not hold capacity");
 assert.equal(readFileSync(model.calls, "utf8"), "call\n");
 writeFileSync(model.release, "release");
 await until(async () => (await controlRequest(f.store, { op: "snapshot" })).receipts.length > 0, "explicit Build did not resume after survivor exit");
 snapshot = await controlRequest(f.store, { op: "snapshot" }); assert.equal(snapshot.runningBuilds, 0);
 assert.equal(snapshot.receipts[0].receipt.builds.at(-1).possibleRepeatCost, true);
 assert.equal(snapshot.receipts[0].receipt.builds[0].usage.cost, null);
 assert.equal(readFileSync(model.calls, "utf8"), "call\ncall\n");
});
