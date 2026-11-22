import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, symlinkSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, createReadStream, realpathSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnection, createServer } from "node:net";
// @ts-expect-error Build script runs as native ESM.
import { buildArcService } from "../scripts/build-arc-service.mjs";
import { launchLocked, LOCK_BUSY } from "../src/arc/service/lock.ts";
import { serviceText, serviceStatus } from "../src/arc/service/status.ts";
import { storeIncarnation } from "../src/arc/service/store.ts";
import type { Socket } from "node:net";
import { controlRequest as rawControlRequest, serviceAddress } from "../src/arc/service/runtime.ts";
import type { ControlCommand } from "../src/arc/service/runtime.ts";
import { pathToFileURL } from "node:url";
export const controlRequest = (store: string, command: ControlCommand, timeout?: number) => rawControlRequest(store, { stamp: JSON.parse(readFileSync(join(store, "control.json"), "utf8")).selected, ...command }, timeout);
import { maintainHost, maintenanceLaunch, parseArcArgs } from "../src/arc/service/client.ts";
import { piSource } from "../src/arc/service/source.ts";
import { fingerprint, storeAnswer } from "../src/arc/core/construct.ts";

export async function fixture(t: any, virtualTime = false) {
 const dir = mkdtempSync(join(tmpdir(), "arc-runtime-")), agent = join(dir, "agent"), bundle = join(dir, "service.mjs");
 mkdirSync(agent); const built = await buildArcService(bundle, { buildOrder: 100, releaseLine: "stable" });
 assert.equal(built.sourceReader, true);
 const original = readFileSync(bundle, "utf8");
 const { version: version2 } = await buildArcService(join(dir, "next.mjs"), { buildOrder: 200, releaseLine: "stable" });
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

export async function until(check: () => Promise<boolean> | boolean, message: string) {
 const end = Date.now() + 10000;
 while (!await check()) { if (Date.now() >= end) throw new Error(message); await new Promise(r => setTimeout(r, 30)); }
}
export function managerClock(f: { dir: string }) {
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
export function blockingModel(f: Awaited<ReturnType<typeof fixture>>, loss = false) {
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
export const request = (id: string) => ({ op: "request" as const, sessionRef: "pi:fixture-session", requestId: id, kind: "manual" as const, requester: "synthetic" });
