import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPiCall } from "../src/pi/isolated-call.ts";
import { piModel } from "../src/arc/service/model.ts";
import { inspectProcess } from "../src/arc/service/process.ts";
import { automaticSchedule, type ScheduleState } from "../src/arc/service/schedule.ts";
import { createBuilder, fingerprint, type BuilderState, type SourceSnapshot } from "../src/arc/core/index.ts";
import { piSource } from "../src/arc/service/source.ts";
import type { ModelInput } from "../src/arc/core/index.ts";

function scratch() { return mkdtempSync(join(tmpdir(), "arc-adapters-")); }
const input: ModelInput = { system: "Synthetic system", prompt: "Synthetic prompt", model: "fixture/model", resolved: true, timeoutMs: 1000, maxOutputTokens: 100 };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function waitFile(path: string) {
 const end = Date.now() + 3000;
 while (!existsSync(path) || readFileSync(path, "utf8").length === 0) { if (Date.now() > end) throw new Error("Synthetic process did not become ready"); await new Promise(r => setTimeout(r, 10)); }
}

test("Arc model fixture readiness waits for marker contents", async t => {
 const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const marker = join(dir, "pid"); writeFileSync(marker, "");
 let ready = false; const waiting = waitFile(marker).then(() => { ready = true; });
 await new Promise(resolve => setImmediate(resolve)); assert.equal(ready, false);
 writeFileSync(marker, "4242"); await waiting;
});

test("Arc model: the real runner writes no prompt before the durable startup barrier", async t => {
 const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const ready = join(dir, "ready"), bytes = join(dir, "bytes"), barrier = deferred(), started = deferred();
 const code = `const fs=require('node:fs'); fs.writeFileSync(process.argv[1],'ready'); process.stdin.on('data',b=>fs.appendFileSync(process.argv[2],b)); process.stdin.on('end',()=>console.log('answer'));`;
 const call = runPiCall(input, [process.execPath, "-e", code, ready, bytes], { started: async () => { started.resolve(); await barrier.promise; } });
 await started.promise; await waitFile(ready); assert.equal(existsSync(bytes), false);
 barrier.resolve(); assert.equal((await call).text, "answer"); assert.equal(readFileSync(bytes, "utf8"), input.prompt);
});

test("Arc model: cancellation reaps the child and settles its startup barrier before returning", async t => {
 const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const controller = new AbortController(), barrier = deferred(), started = deferred(), ready = join(dir, "ready");
 let pid = 0, exited = false, finished = false;
 const call = runPiCall(input, [process.execPath, "-e", `require('node:fs').writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000);`, ready], { signal: controller.signal, started: async child => { pid = child; started.resolve(); await barrier.promise; }, exited: () => { exited = true; } });
 const rejected = assert.rejects(call, e => (e as {code: string; dispatched: boolean}).code === "cancelled" && (e as {dispatched: boolean}).dispatched === false).then(() => { finished = true; });
 await started.promise; await waitFile(ready); controller.abort();
 await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(finished, false, "startup cannot write after cancellation returns");
 barrier.resolve(); await rejected; assert.equal(exited, true);
 assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("Arc auth: cancellation reaps a hanging auth child before preflight returns", async t => {
 const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const bin = join(dir, "pi"), pidFile = join(dir, "pid"), controller = new AbortController();
 writeFileSync(bin, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`); chmodSync(bin, 0o755);
 const model = piModel({ agentDir: dir, extensionPath: join(dir, "limit.ts"), env: { PI_BIN: bin } });
 const preflight = model.preflight(input.model, controller.signal); await waitFile(pidFile);
 const pid = Number(readFileSync(pidFile, "utf8")); assert.ok(Number.isInteger(pid) && pid > 0); controller.abort();
 assert.equal((await preflight)?.kind, "failed");
 assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

function fakePi(dir: string, auth = true) {
 const bin = join(dir, "pi"), bytes = join(dir, "bytes"), receipt = join(dir, "receipt");
 writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'auth') { console.log('{"status":"${auth ? "ready" : "not_ready"}"}'); process.exit(${auth ? 0 : 1}); }
process.stdin.on('data', b => {
 if (!fs.existsSync(${JSON.stringify(receipt)})) fs.writeFileSync(${JSON.stringify(join(dir, "breach"))},'prompt before record');
 fs.appendFileSync(${JSON.stringify(bytes)},b);
});
process.stdin.on('end',()=>console.log(JSON.stringify({type:'message_end',message:{role:'assistant',provider:'fixture',model:'model',stopReason:'stop',content:[{type:'text',text:'answer'}],usage:{input:2,output:3,cost:{total:0.01}}}})));
`);
 chmodSync(bin, 0o755);
 return { bin, bytes, receipt, port: piModel({ agentDir: join(dir, "agent"), extensionPath: join(dir, "limit.ts"), env: { PI_BIN: bin } }) };
}

test("Arc model: a failed durable PID record kills the unadmitted child with zero prompt bytes", async t => {
 const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const f = fakePi(dir); let pid = 0, exited = 0;
 const result = await f.port.call(input, input.model, { id: "slot" }, {
  callId: "call", started: identity => { pid = identity.pid; assert.ok(identity.startedAt); throw new Error("Synthetic flush failure"); }, exited: () => { exited++; },
 });
 assert.equal(result.kind, "failed"); assert.ok(pid > 0); assert.equal(exited, 1);
 assert.equal(existsSync(f.bytes), false); assert.equal((await inspectProcess(pid)).kind, "gone");
});

test("Arc model: Host sign-in refuses before spawn and a recorded child returns measured usage", async t => {
 const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const missing = fakePi(dir, false); let started = 0;
 const context = { callId: "call", started: () => { started++; }, exited: () => {} };
 const refusal = await missing.port.call(input, input.model, { id: "slot" }, context);
 assert.equal(refusal.kind, "failed"); assert.equal(started, 0); assert.equal(existsSync(missing.bytes), false);
 if (refusal.kind === "failed") { assert.equal(refusal.code, "sign-in"); assert.match(refusal.message, /auth.json/); }
 const f = fakePi(dir);
 const result = await f.port.call(input, input.model, { id: "slot" }, { ...context, started: identity => { writeFileSync(f.receipt, JSON.stringify(identity)); } });
 assert.equal(result.kind, "answer");
 if (result.kind === "answer") assert.equal(result.answer.usage!.cost, .01);
 assert.equal(existsSync(join(dir, "breach")), false); assert.equal(readFileSync(f.bytes, "utf8"), input.prompt);
 const nonexistent = piModel({ agentDir: dir, extensionPath: "unused", env: { PI_BIN: join(dir, "missing") } });
 assert.equal((await nonexistent.call(input, input.model, { id: "slot" }, context)).kind, "failed");
});

test("Arc model: wrong-model and unmeasured errors pause; measured errors retain exact usage", async t => {
 const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
 for (const mismatch of [false, true]) for (const cost of [undefined, null, .02]) {
  const f = fakePi(dir);
  const message = { role: "assistant", provider: "fixture", model: mismatch ? "other" : "model", stopReason: mismatch ? "stop" : "error", errorMessage: "Synthetic refusal", resetAt: 1900000000000, content: [{ type: "text", text: "answer" }], ...(cost === undefined ? {} : { usage: { input: 4, output: 2, cost: cost === null ? {} : { total: cost } } }) };
  writeFileSync(f.bin, `#!${process.execPath}\nif(process.argv[2]==='auth'){console.log('{"status":"ready"}');process.exit(0);}process.stdin.resume();process.stdin.on('end',()=>console.log(${JSON.stringify(JSON.stringify({ type: "message_end", message }))}));\n`);
  const result = await f.port.call(input, input.model, { id: "slot" }, { callId: "call", started: () => {}, exited: () => {} });
  assert.equal(result.kind, mismatch || cost === undefined ? "measured-unknown" : "failed");
  if (result.kind === "measured-unknown") assert.equal(result.code, mismatch ? "model-mismatch" : undefined);
  if (result.kind === "failed") { assert.equal(result.code, "quota"); assert.equal(result.retryAt, new Date(1900000000000).toISOString()); }
  assert.equal(result.usage?.cost, cost);
 }
});

test("Arc model: a parent crash closes real Pi stdin with zero prompt events", { timeout: 15000 }, async t => {
 const dist = process.env.AMPI_PI_DIST;
 if (!dist) { t.skip("Set AMPI_PI_DIST to run the real Pi empty-EOF proof"); return; }
 const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const pidFile = join(dir, "pid"), events = join(dir, "events"), errors = join(dir, "errors"), parentFile = join(dir, "parent.mjs");
 const args = [join(dist, "cli.js"), "--mode", "json", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--offline"];
 writeFileSync(parentFile, `import {spawn} from 'node:child_process';import {openSync,writeFileSync} from 'node:fs';const child=spawn(process.execPath,${JSON.stringify(args)},{cwd:${JSON.stringify(dir)},env:{HOME:${JSON.stringify(dir)},PATH:process.env.PATH,PI_CODING_AGENT_DIR:${JSON.stringify(join(dir, "agent"))},PI_OFFLINE:'1'},stdio:['pipe',openSync(${JSON.stringify(events)},'w'),openSync(${JSON.stringify(errors)},'w')]});child.once('spawn',()=>writeFileSync(${JSON.stringify(pidFile)},String(child.pid)));setInterval(()=>{},1000);`);
 const parent = spawn(process.execPath, [parentFile], { stdio: "ignore" }); t.after(() => parent.kill("SIGKILL"));
 await waitFile(pidFile); const pid = Number(readFileSync(pidFile, "utf8"));
 t.after(() => { try { process.kill(pid, "SIGKILL"); } catch {} });
 parent.kill("SIGKILL");
 const end = Date.now() + 10000;
 while ((await inspectProcess(pid)).kind !== "gone") { if (Date.now() > end) throw new Error("Pi did not exit on empty stdin EOF"); await new Promise(r => setTimeout(r, 50)); }
 const output = readFileSync(events, "utf8");
 assert.doesNotMatch(output, /"type":"(?:agent_start|turn_start|message_start|message_end)"/);
 assert.doesNotMatch(readFileSync(errors, "utf8"), /EPIPE|SyntaxError|Cannot find module/);
});

test("Arc auth: typed status follows the auth protocol, not arbitrary process exit codes", async t => {
 const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const f = fakePi(dir);
 for (const [code, status, expected] of [[0, "ready", undefined], [1, "not_ready", "sign-in"], [2, "invalid", "settings"], [1, undefined, "model"], [2, undefined, "model"], [9, "invalid", "model"], [0, "nonsense", "model"]] as const) {
  writeFileSync(f.bin, `#!${process.execPath}\nconsole.log(${JSON.stringify(status ? JSON.stringify({ status }) : "unknown auth command")});process.exit(${code});\n`);
  const result = await f.port.preflight("fixture/model");
  assert.equal(result?.code, expected, String([code, status]));
  if (expected === "sign-in") assert.equal(result?.authPath, join(dir, "agent", "auth.json"));
  if (expected === "settings") { assert.equal(result?.settingsPath, join(dir, "agent", "settings.json")); assert.equal(result?.settingsKey, "ampi_arc.model"); }
  if (expected === "model") assert.equal(result?.prerequisite, "pi-auth-check");
 }
});

test("Arc scheduling: burst appends pay once after debounce, respect cadence and cancel when disabled", async () => {
 let time = 0, paid = 0, store: BuilderState | undefined, schedules: ScheduleState = {};
 const source: SourceSnapshot = { session: "pi:synthetic", sourceVersion: "0", selector: "fixture", fingerprint: "", items: [], entries: [] };
 const builder = createBuilder({ now: () => new Date(time).toISOString(), store: { load: () => store, save: value => { store = value; } }, source: { snapshot: async () => structuredClone(source), check: async () => ({ kind: "same-prefix" }) },
  settings: () => ({ model: "fixture/model", retries: 0 }), admission: { acquire: async () => ({ kind: "permit", permit: { id: "slot" } }), release: async () => {} },
  model: { reconcile: async () => "gone", call: async input => {
   paid++; const data = JSON.parse(input.prompt), item = data.rarebits.at(-1), claim = { text: "Review work.", cites: [{ id: item.id, quote: item.text }] };
   return { kind: "answer", answer: { text: JSON.stringify({ goal: claim, now: claim, chapters: [{ firstId: data.rarebits[0].id, label: "Review work", closed: true, summary: { scope: claim, bullets: [] } }], points: [] }), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: .01 } } };
  } },
 });
 const make = () => automaticSchedule({ builder, state: schedules, save: state => { schedules = structuredClone(state); }, now: () => time });
 let scheduler = make();
 const append = (kind: "user" | "compaction" = "user", enabled = true) => {
  source.items.push({ id: String(source.items.length), kind, owner: kind === "user", text: "Synthetic evidence " + source.items.length, t: new Date(time).toISOString() });
  source.fingerprint = fingerprint(source.items); source.sourceVersion = source.fingerprint; scheduler.observe(source, enabled);
 };
 const tick = async (at: number, enabled = true) => { time = at; await scheduler.tick(enabled); await builder.run(); };
 append(); append(); append(); await tick(30000); assert.equal(paid, 0);
 append(); await tick(49000); assert.equal(paid, 0);
 append(); await tick(68000); assert.equal(paid, 0);
 append("compaction"); await tick(69000); assert.equal(paid, 1, "non-trigger appends do not reset debounce");
 append(); await tick(100000); append(); await tick(368999); assert.equal(paid, 1);
 scheduler = make(); await tick(369000); assert.equal(paid, 2, "cadence survives service restart");
 append(); await tick(700000, false); assert.equal(paid, 2); assert.equal(scheduler.pending().length, 0);
 append("user", false); await tick(800000); assert.equal(paid, 2);
 await builder.request(source.session, "manual", "manual", "owner"); await builder.run(); assert.equal(paid, 3, "manual work bypasses automatic policy");
});

test("Arc source: published selection and usage stay on the original branch; interior mutation invalidates a snapshot", async t => {
 const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const sessionsDir = join(dir, "sessions"); mkdirSync(sessionsDir);
 const file = join(sessionsDir, "fixture.jsonl");
 const at = "2026-01-01T00:00:00.000Z";
 const rows: Record<string, unknown>[] = [{ type: "session", version: 3, id: "fixture-session", timestamp: at, cwd: "/synthetic/project" }];
 for (let n = 0; n < 20; n++) rows.push({ type: "message", id: `u${n}`, parentId: n ? `u${n-1}` : null, timestamp: at, message: { role: "user", content: `Synthetic owner evidence ${n}.` } });
 rows.push({ type: "message", id: "injected", parentId: "u19", timestamp: at, message: { role: "user", content: "# Rarebit Recall\nInjected synthetic context" } });
 rows.push({ type: "message", id: "answer", parentId: "injected", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "Synthetic completed answer." }], stopReason: "stop", usage: { input: 2, output: 3, cacheRead: 5, cacheWrite: 7, cost: { total: .01 } } } });
 const write = () => writeFileSync(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n"); write();
 const source = piSource({ sessionsDir, storeDir: join(dir, "store") });
 const initial = await source.scan(); assert.equal(initial.length, 1);
 const snap = await source.snapshot("client-alias/pi:fixture-session");
 assert.equal(snap.session, "pi:fixture-session"); assert.equal(snap.items.some(i => i.id === "injected"), false);
 assert.equal(snap.items.find(i => i.id === "u0")!.owner, true);
 assert.deepEqual(snap.entries.find(e => e.id === "answer"), { id: "answer", at, tokens: 17, cost: .01 });
 assert.equal((await source.check(snap)).kind, "same-prefix");
 rows.push({ type: "message", id: "later", parentId: "answer", timestamp: at, message: { role: "user", content: "Later synthetic evidence." } }); write();
 assert.equal((await source.check(snap)).kind, "same-prefix");
 const changed = rows[11]!.message as { content: string }; changed.content = changed.content.replace("owner", "other"); write();
 assert.equal((await source.check(snap)).kind, "history-changed");
 const [a,b] = await Promise.all([source.snapshot(snap.session), source.snapshot(snap.session)]); assert.equal(a.sourceVersion, b.sourceVersion);
 rmSync(file); assert.equal((await source.check(snap)).kind, "unavailable");
});
