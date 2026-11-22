import "./bound.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPiCall } from "../src/pi/isolated-call.ts";
import { piModel } from "../src/arc/service/model.ts";
import { inspectProcess } from "../src/arc/service/process.ts";
import { automaticSchedule, type ScheduleState } from "../src/arc/service/schedule.ts";
import { createBuilder, fingerprint, type BuilderState, type SourceSnapshot } from "../src/arc/core/index.ts";
import { piSource } from "../src/arc/service/source.ts";
import * as verificationModule from "../src/arc/service/source-verification.ts";
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

test("Arc scheduling: two incompatible admissions persist a fixed cooldown across appends and restart", async () => {
 let time = 0, saved: ScheduleState = {}, attempts = 0, reads = 0, repair = false, mismatch = true, store: BuilderState | undefined;
 const items = Array.from({ length: 4 }, (_, n) => ({ id: `u${n}`, owner: true, kind: "user" as const, text: `Synthetic ${n}`, t: null }));
 const snapshot = (): SourceSnapshot => ({ session: "pi:scheduled", items: structuredClone(items), entries: [], selector: "test", sourceVersion: "v" + reads, prefixWitness: "p" + reads, fingerprint: fingerprint(items) });
 const source = { snapshot: async (_ref: string, condition?: any) => {
  assert.equal(condition?.deferRepair, true);
  if (repair) throw Object.assign(new Error("Repair pending"), { code: "source-repair-pending" });
  reads++;
  if (condition?.expectedPrefix) { attempts++; if (mismatch) throw Object.assign(new Error("Changed prefix"), { code: "source-prefix" }); }
  return snapshot();
 }, check: async () => ({ kind: "same-prefix" as const }) };
 const builder = createBuilder({ source, store: { load: () => store, save: value => { store = structuredClone(value); } }, settings: () => ({ model: "fixture/model", retries: 0 }),
  admission: { acquire: async () => { throw new Error("No paid call expected"); }, release: async () => {} }, model: { reconcile: async () => "gone", call: async () => { throw new Error("No paid call expected"); } } });
 const make = () => automaticSchedule({ builder, source, state: structuredClone(saved), save: (value: ScheduleState) => { saved = structuredClone(value); }, now: () => time } as any);
 let schedule = make(); schedule.observe(snapshot(), true); time = 20000;
 await schedule.tick(true); assert.equal(attempts, 2); assert.equal(Object.keys(store!.jobs).length, 0);
 assert.equal((saved["pi:scheduled"] as any).assuranceRetryAt, 40000);
 for (time = 22000; time < 40000; time += 2000) {
  items.push({ id: `u${items.length}`, owner: true, kind: "user", text: "New synthetic evidence", t: null });
  schedule.observe(snapshot(), true); schedule = make(); await schedule.tick(true);
  assert.equal(attempts, 2); assert.equal(schedule.pending()[0]!.nextAt, new Date(40000).toISOString());
 }
 repair = true; await schedule.tick(true);
 assert.equal(attempts, 2); assert.equal((saved["pi:scheduled"] as any).assuranceRetryAt, 40000, "deferral consumes no assurance attempt or new cooldown");
 repair = false; mismatch = false; await schedule.tick(true);
 assert.equal(attempts, 3); assert.equal(Object.keys(store!.jobs).length, 1); assert.equal(schedule.pending().length, 0);
});

test("Arc scheduling: failure retries retain their obligation through repair without advancing backoff", async () => {
 let repair = true, reads = 0, requests = 0, saved: ScheduleState = {};
 const nextAt = new Date(1000).toISOString(), items = Array.from({ length: 4 }, (_, n) => ({ id: `u${n}`, owner: true, kind: "user" as const, text: "Synthetic", t: null }));
 const scheduler = automaticSchedule({ state: {}, save: state => { saved = structuredClone(state); }, now: () => 2000,
  source: { snapshot: async (_ref: string, condition?: any) => {
   assert.equal(condition?.deferRepair, true);
   if (repair) throw Object.assign(new Error("Repair pending"), { code: "source-repair-pending" });
   reads++; return { session: "pi:retry", items, entries: [], selector: "fixture", sourceVersion: "v", prefixWitness: "proof", fingerprint: fingerprint(items) };
  } },
  builder: { status: () => [{ sessionRef: "pi:retry", buildId: "failed-build", state: "failed", nextAt }], receipts: () => [], request: async (_ref: string, id: string, _kind: string, _requester: string, options: any) => {
   assert.ok(id.startsWith(`retry:failed-build:${nextAt}:`)); assert.equal(options.expectedPrefix, "proof"); requests++; return { outcome: "accepted", buildId: "retry-build" };
  } } as any });
 await scheduler.tick(true, true); await scheduler.tick(true, true);
 assert.equal(reads, 0); assert.equal(requests, 0); assert.ok(saved["pi:retry"]!.pending);
 assert.equal(saved["pi:retry"]!.assuranceRetryAt, undefined); assert.equal(saved["pi:retry"]!.pending!.at, 1000);
 repair = false; await scheduler.tick(true, true);
 assert.equal(reads, 1); assert.equal(requests, 1); assert.equal(saved["pi:retry"]!.pending, undefined);
});

test("Arc scheduling: authoritative eligibility can revoke a cheap trigger before admission", async () => {
 const items = Array.from({ length: 4 }, (_, n) => ({ id: `u${n}`, owner: true, kind: "user" as const, text: "Synthetic", t: null }));
 const observed: SourceSnapshot = { session: "pi:revoke", items, entries: [], selector: "fixture", sourceVersion: "v", prefixWitness: "p", fingerprint: fingerprint(items) };
 let requests = 0;
 const scheduler = automaticSchedule({ state: {}, save: () => {}, now: () => 20000,
  source: { snapshot: async () => ({ ...observed, items: items.slice(0, 3) }) },
  builder: { status: () => [], receipts: () => [], request: async () => { requests++; return { outcome: "accepted", buildId: "bad" }; } } as any } as any);
 scheduler.observe(observed, true);
 // Observe uses a twenty-second debounce; this clock advances independently below.
 const saved: ScheduleState = { "pi:revoke": { seen: "u3", pending: { fingerprint: observed.fingerprint, trigger: "owner", at: 0 } } };
 const due = automaticSchedule({ state: saved, save: () => {}, now: () => 20000, source: { snapshot: async () => ({ ...observed, items: items.slice(0, 3) }) }, builder: { status: () => [], receipts: () => [], request: async () => { requests++; return { outcome: "accepted", buildId: "bad" }; } } as any } as any);
 await due.tick(true); assert.equal(requests, 0); assert.equal(due.pending().length, 0);
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
 const make = () => automaticSchedule({ builder, source: { snapshot: async () => ({ ...structuredClone(source), prefixWitness: source.sourceVersion }) }, state: schedules, save: state => { schedules = structuredClone(state); }, now: () => time });
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

test("Arc source: a warm append decodes only its suffix and equals a fresh full replay", async t => {
 const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const sessionsDir = join(dir, "sessions"); mkdirSync(sessionsDir);
 const file = join(sessionsDir, "append.jsonl"), at = "2026-01-01T00:00:00.000Z";
 const row = (n: number) => ({ type: "message", id: `entry-${n}`, parentId: n ? `entry-${n-1}` : null, timestamp: at, arcAppendFixture: true,
  message: { role: n % 20 ? "toolResult" : "user", content: `Synthetic evidence ${n} ` + "x".repeat(512) } });
 writeFileSync(file, [JSON.stringify({ type: "session", version: 3, id: "append-session", timestamp: at, cwd: "/synthetic/project" }), ...Array.from({ length: 2000 }, (_, n) => JSON.stringify(row(n)))].join("\n") + "\n");
 const source = piSource({ sessionsDir, storeDir: join(dir, "store") });
 await source.scan(); appendFileSync(file, JSON.stringify(row(2000)) + "\n");
 const parse = JSON.parse, decoded: string[] = [], nodeWrites: unknown[] = [], branchWrites: unknown[] = [];
 const prepare = DatabaseSync.prototype.prepare;
 DatabaseSync.prototype.prepare = function(sql: string) {
  const statement = prepare.call(this, sql), run = statement.run;
  if (/INSERT(?: OR REPLACE)? INTO (nodes|branch) /.test(sql)) statement.run = function(...args: any[]) {
   if (sql.includes("INTO nodes")) nodeWrites.push(args[0]); else branchWrites.push(args[1]);
   return Reflect.apply(run, this, args);
  };
  return statement;
 };
 JSON.parse = (...args: Parameters<typeof JSON.parse>) => { const value = parse(...args); if (value?.arcAppendFixture) decoded.push(value.id); return value; };
 let appended;
 try { [appended] = await source.scan(); } finally { JSON.parse = parse; DatabaseSync.prototype.prepare = prepare; }
 assert.deepEqual(nodeWrites, ["entry-2000"], "only the new native entry writes a node row");
 assert.deepEqual(branchWrites, ["entry-2000"], "old active-branch rows are not rewritten");
 assert.deepEqual(decoded, ["entry-2000", "entry-2000"], "only the appended row is decoded by ingestion and suffix projection");
 assert.ok(appended);
 const full = piSource({ sessionsDir, storeDir: join(dir, "oracle") });
 const oracle = await full.snapshot("pi:append-session");
 // Witnesses carry index identity; compare the published history and content key.
 assert.deepEqual({ ...appended, prefixWitness: undefined }, { ...oracle, prefixWitness: undefined });
 appended.items[0]!.text = "Caller mutation";
 assert.deepEqual((await source.snapshot("pi:append-session")).items, oracle.items);
});

test("Arc source: projection eviction stays bounded and logs a near-term replay", async t => {
 const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const sessionsDir = join(dir, "sessions"); mkdirSync(sessionsDir); const logs: string[] = [];
 for (let n = 0; n < 17; n++) {
  const id = String(n).padStart(2, "0");
  writeFileSync(join(sessionsDir, id + ".jsonl"), [JSON.stringify({ type: "session", version: 3, id: "cache-" + id }), JSON.stringify({ type: "message", id, parentId: null, cacheFixture: true, message: { role: "user", content: "Synthetic evidence " + id } })].join("\n") + "\n");
 }
 const source = piSource({ sessionsDir, storeDir: join(dir, "store"), log: message => logs.push(message) }); await source.scan();
 const parse = JSON.parse, decoded: string[] = [];
 JSON.parse = (...args: Parameters<typeof JSON.parse>) => { const value = parse(...args); if (value?.cacheFixture) decoded.push(value.id); return value; };
 try {
  await source.snapshot("pi:cache-16"); assert.deepEqual(decoded, [], "a retained projection needs no native decode");
  const restored = await source.snapshot("pi:cache-00"); assert.deepEqual(decoded, ["00"], "the seventeenth projection evicts the oldest one");
  assert.equal(restored.items[0]!.text, "Synthetic evidence 00");
  assert.ok(logs.some(line => line.includes("cache churn") && line.includes("pi:cache-00")));
 } finally { JSON.parse = parse; await source.close(); }
});

test("Arc source: index loss preserves source checks for unchanged bytes", async t => {
 const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const sessionsDir = join(dir, "sessions"), storeDir = join(dir, "store"); mkdirSync(sessionsDir);
 writeFileSync(join(sessionsDir, "source.jsonl"), [JSON.stringify({ type: "session", version: 3, id: "index-loss" }), JSON.stringify({ type: "message", id: "a", parentId: null, message: { role: "user", content: "Synthetic evidence" } })].join("\n") + "\n");
 const source = piSource({ sessionsDir, storeDir });
 const snapshot = await source.snapshot("pi:index-loss");
 rmSync(join(storeDir, "indexes"), { recursive: true });
 assert.deepEqual(await source.check(snapshot), { kind: "same-prefix" });
 assert.deepEqual((await source.snapshot(snapshot.session, { expectedPrefix: snapshot.prefixWitness })).items, snapshot.items);
 await source.close();
});

test("Arc source: opaque prefix conditions admit pure appends and refuse an interior rewrite", async t => {
 const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const sessionsDir = join(dir, "sessions"); mkdirSync(sessionsDir);
 const file = join(sessionsDir, "condition.jsonl");
 const rows = [{ type: "session", version: 3, id: "condition-session" }, ...Array.from({ length: 500 }, (_, n) => ({ type: "message", id: `u${n}`, parentId: n ? `u${n-1}` : null, message: { role: "user", content: "Synthetic evidence " + n + "x".repeat(200) } }))];
 const write = () => writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n"); write();
 const source = piSource({ sessionsDir, storeDir: join(dir, "store") });
 const initial = await source.snapshot("pi:condition-session"); assert.ok(initial.prefixWitness);
 appendFileSync(file, JSON.stringify({ type: "message", id: "next", parentId: "u499", message: { role: "user", content: "Synthetic append" } }) + "\n");
 const appended = await source.snapshot(initial.session, { expectedPrefix: initial.prefixWitness });
 assert.equal(appended.items.length, initial.items.length + 1);
 assert.equal((await source.check(initial)).kind, "same-prefix");
 const changed = rows[100] as { message: { content: string } }; changed.message.content = changed.message.content.replace("evidence", "redacted"); write();
 await assert.rejects(source.snapshot(initial.session, { expectedPrefix: initial.prefixWitness }), /prefix/i);
 assert.equal((await source.check(initial)).kind, "history-changed");
});

test("Arc source: a failed repair-completion save keeps pending state and restart quota", async t => {
 const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const sessionsDir = join(dir, "sessions"); mkdirSync(sessionsDir);
 const file = join(sessionsDir, "repair.jsonl");
 writeFileSync(file, [JSON.stringify({ type: "session", version: 3, id: "repair-save" }), JSON.stringify({ type: "message", id: "a", parentId: null, message: { role: "user", content: "Synthetic evidence" } })].join("\n") + "\n");
 let saved: any, fail = false, time = 0;
 const options = { sessionsDir, storeDir: join(dir, "store"), now: () => time,
  verificationSettings: () => ({ bytesPerMinute: 65536, intervalMs: 1000 }),
  verification: { load: () => saved, save: (state: any) => {
   if (fail && Object.values(state.sources).some((fact: any) => fact.repairPending === false)) throw new Error("Completion save failed");
   saved = structuredClone(state);
  } } };
 let source = piSource(options); await source.scan(); await source.close();
 (Object.values(saved.sources)[0] as any).repairPending = true; fail = true;
 source = piSource(options); await source.scan();
 assert.equal(await source.verifyStep(), false);
 assert.equal((Object.values(saved.sources)[0] as any).repairPending, true);
 const read = fs.readSync; let bytes = 0;
 (fs as any).readSync = (...args: any[]) => { const n = (read as any)(...args); bytes += n; return n; }; syncBuiltinESMExports();
 try {
  assert.deepEqual(await source.scan(), [], "failed persistence cannot let a scan publish a repair");
  assert.equal(await source.verifyStep(), false, "failed-save work is not runnable now");
  assert.equal(bytes, 0, "a failed save cannot clear pending repair in memory and bypass its quota");
 } finally { fs.readSync = read; syncBuiltinESMExports(); }
 await source.close(); fail = false; source = piSource(options); await source.scan();
 const before = saved.charges.reduce((sum: number, charge: any) => sum + charge.bytes, 0); assert.ok(before > 0);
 time = 60001; await source.verifyStep(); assert.equal((Object.values(saved.sources)[0] as any).repairPending, false);
 await source.close();
});

test("Arc verification driver yields to status, manual work and stop between bounded quanta", async () => {
 const events: string[] = []; let authority = true;
 const pump = (verificationModule as any).verificationPump({ active: () => authority, step: async () => { events.push("quantum"); return true; } });
 const run = pump.run(); assert.equal(pump.run(), run, "one driver owns background work");
 setImmediate(() => { events.push("status", "manual", "stop"); authority = false; });
 await run;
 assert.deepEqual(events, ["quantum", "status", "manual", "stop"]);
 let calls = 0;
 const exhausted = (verificationModule as any).verificationPump({ active: () => true, step: async () => { calls++; return false; } });
 await exhausted.run(); assert.equal(calls, 1, "quota exhaustion terminates the loop");
 const bounded = (verificationModule as any).verificationPump({ active: () => true, step: async () => { calls++; return true; } });
 calls = 0; await bounded.run(); assert.equal(calls, 64, "a tick has a fixed quantum bound");
});

test("Arc source: a missing oldest source yields to a healthy dirty peer without resetting its age", async t => {
 const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const sessionsDir = join(dir, "sessions"); mkdirSync(sessionsDir);
 const row = (id: string, parentId: string | null) => JSON.stringify({ type: "message", id, parentId, message: { role: "user", content: "Synthetic evidence" } }) + "\n";
 const old = join(sessionsDir, "old.jsonl"), fresh = join(sessionsDir, "fresh.jsonl");
 const create = (path: string, id: string) => writeFileSync(path, JSON.stringify({ type: "session", version: 3, id }) + "\n" + row("a", null));
 let time = 100, saved: any; create(old, "old");
 const source = piSource({ sessionsDir, storeDir: join(dir, "store"), now: () => time, verification: { load: () => saved, save: s => { saved = structuredClone(s); } } });
 await source.scan(); time = 200; create(fresh, "fresh"); await source.scan();
 time = 300; appendFileSync(old, row("b", "a")); appendFileSync(fresh, row("b", "a")); await source.scan(); rmSync(old);
 const fact = (ref: string): any => Object.values(saved.sources).find((value: any) => value.sessionRef === ref);
 time = 60001; await source.verifyStep(); time = 120002; await source.verifyStep();
 assert.equal(fact("pi:old").verifiedAt, 100, "failure cannot advance exact-verification age");
 assert.equal(fact("pi:fresh").verifiedAt, time, "a healthy peer gets the next window");
 await source.close();
});

test("Arc source: automatic admission joins the mismatch quantum but cannot preempt its newly pending repair", async t => {
 const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const sessionsDir = join(dir, "sessions"); mkdirSync(sessionsDir);
 const file = join(sessionsDir, "race.jsonl"), rows: any[] = [{ type: "session", version: 3, id: "repair-race" }, ...Array.from({ length: 1000 }, (_, n) => ({ type: "message", id: `u${n}`, parentId: n ? `u${n-1}` : null, message: { role: "user", content: "Synthetic evidence " + n + "x".repeat(250) } }))];
 const write = () => writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n"); write();
 let saved: any; const source = piSource({ sessionsDir, storeDir: join(dir, "store"), verification: { load: () => saved, save: state => { saved = structuredClone(state); } } });
 await source.scan(); rows[101].message.content = rows[101].message.content.replace("evidence", "redacted");
 rows.push({ type: "message", id: "next", parentId: "u999", message: { role: "user", content: "Synthetic append" } }); write(); await source.scan();
 const end = fs.statSync(file).size, read = fs.readSync; let admission: Promise<SourceSnapshot> | undefined, laterBytes = 0;
 (fs as any).readSync = (...args: any[]) => {
  const n = Reflect.apply(read, fs, args); if (admission) laterBytes += n;
  if (!admission && Number(args[4]) + n === end) { admission = source.snapshot("pi:repair-race", { deferRepair: true }); void admission.catch(() => {}); }
  return n;
 }; syncBuiltinESMExports();
 try {
  for (let n = 0; n < 100 && !admission; n++) await source.verifyStep();
  assert.ok(admission, "admission races the final proof quantum");
  await assert.rejects(admission, (error: any) => error.code === "source-repair-pending");
  assert.equal(laterBytes, 0, "automatic admission cannot replay after the joined proof marks repair pending");
  assert.equal((Object.values(saved.sources)[0] as any).repairPending, true);
 } finally { fs.readSync = read; syncBuiltinESMExports(); await source.close(); }
});

test("Arc source: repair deferral does no native I/O; explicit snapshots preempt and clear repair", async t => {
 const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const sessionsDir = join(dir, "sessions"); mkdirSync(sessionsDir);
 writeFileSync(join(sessionsDir, "repair.jsonl"), [JSON.stringify({ type: "session", version: 3, id: "repair-session" }), JSON.stringify({ type: "message", id: "u", parentId: null, message: { role: "user", content: "Synthetic evidence" } })].join("\n") + "\n");
 let saved: any; const options = { sessionsDir, storeDir: join(dir, "store"), verification: { load: () => saved, save: (s: unknown) => { saved = structuredClone(s); } } };
 let source = piSource(options); await source.scan(); await source.close();
 (Object.values(saved.sources)[0] as any).repairPending = true;
 source = piSource(options); const read = fs.readSync; let bytes = 0;
 (fs as any).readSync = (...args: any[]) => { const n = (read as any)(...args); bytes += n; return n; }; syncBuiltinESMExports();
 try {
  await assert.rejects(source.snapshot("pi:repair-session", { deferRepair: true } as any), (e: any) => e.code === "source-repair-pending");
  assert.equal(bytes, 0); assert.equal((Object.values(saved.sources)[0] as any).repairPending, true);
  assert.equal((await source.snapshot("pi:repair-session")).items.length, 1);
  assert.ok(bytes > 0); assert.equal((Object.values(saved.sources)[0] as any).repairPending, false);
 } finally { fs.readSync = read; syncBuiltinESMExports(); await source.close(); }
});

test("Arc source: periodic repair charges every native read, survives restart, and suppresses ordinary replay", async t => {
 const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const sessionsDir = join(dir, "sessions"); mkdirSync(sessionsDir);
 const file = join(sessionsDir, "periodic.jsonl");
 const rows: any[] = [{ type: "session", version: 3, id: "periodic-session" }, ...Array.from({ length: 1000 }, (_, n) => ({ type: "message", id: `u${n}`, parentId: n ? `u${n-1}` : null, message: { role: "user", content: "Synthetic evidence " + n + "x".repeat(250) } }))];
 const write = () => writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n"); write();
 let time = 0, saved: any; const logs: { message: string; repair: boolean }[] = [];
 const options = { sessionsDir, storeDir: join(dir, "store"), now: () => time,
  log: (message: string) => logs.push({ message, repair: Object.values(saved?.sources ?? {}).some((fact: any) => fact.repairPending) }),
  verification: { load: () => structuredClone(saved), save: (state: unknown) => { saved = structuredClone(state); } },
  verificationSettings: () => ({ bytesPerMinute: 32768, intervalMs: 1000 }) };
 let source = piSource(options); await source.scan();
 const originalVersion = Object.values(saved.sources)[0] as any;
 rows[101].message.content = rows[101].message.content.replace("evidence", "redacted");
 rows.push({ type: "message", id: "next", parentId: "u999", message: { role: "user", content: "Synthetic append" } }); write();
 await source.scan();
 const read = fs.readSync; let bytes = 0, sawRepair = false, restarted = false, complete = false;
 (fs as any).readSync = (...args: any[]) => { const n = (read as any)(...args); bytes += n; return n; }; syncBuiltinESMExports();
 try {
  for (let n = 0; n < 120; n++) {
   time += 60001; bytes = 0;
   await source.verifyStep();
   assert.ok(bytes <= 32768, `periodic native reads exceeded the quota: ${bytes}`);
   let fact = Object.values(saved.sources)[0] as any;
   if (fact.repairPending) {
    sawRepair = true;
    if (!restarted) { await source.close(); source = piSource(options); restarted = true; }
    bytes = 0; assert.deepEqual(await source.scan(), []);
    assert.equal(bytes, 0, "ordinary scans cannot bypass a periodic repair budget after restart");
   }
   fact = Object.values(saved.sources)[0] as any;
   if (sawRepair && !fact.repairPending) { complete = true; break; }
  }
 } finally { fs.readSync = read; syncBuiltinESMExports(); await source.close(); }
 assert.equal(complete, true); assert.equal(restarted, true);
 assert.ok(logs.some(line => line.repair && line.message.includes("verification overdue")), "an overdue pending repair remains visible in the service log");
 assert.notEqual((Object.values(saved.sources)[0] as any).verifiedVersion, originalVersion.verifiedVersion);
 const repaired = await piSource(options).snapshot("pi:periodic-session");
 const oracle = await piSource({ sessionsDir, storeDir: join(dir, "oracle") }).snapshot("pi:periodic-session");
 assert.deepEqual({ ...repaired, prefixWitness: undefined }, { ...oracle, prefixWitness: undefined });
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
