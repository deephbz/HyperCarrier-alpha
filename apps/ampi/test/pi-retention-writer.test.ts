import "./bound.ts";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { test } from "node:test";
import { Hub } from "../src/hub/hub.ts";
import { WorkingSet } from "../src/pi/working-set.ts";
import type { Source } from "../src/pi/working-set-types.ts";
import { Browser } from "./helpers.ts";
import { fixture, replaceFile } from "./pi-fixtures.ts";
const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const line = (o: unknown) => JSON.stringify(o) + "\n";
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const header = (id: string, timestamp?: string) => line({ type: "session", id, timestamp, cwd: "/synthetic" });
const message = (id: string, parentId: string | null, text: string, timestamp?: string) => line({ type: "message", id, parentId, timestamp, message: { role: "user", content: text } });

test("retention writer: cold fill with retention deletes keeps the hub main-loop block <=50 ms and removes search hits after ack", async (t) => {
 const load = loadavg(); if (load[0]! >= 20) { t.skip("measure only below load 20"); return; }
 const dir = mkdtempSync(join(tmpdir(), "ampi-retention-fill-"));
 const sources: Source[] = [];
 for (let s = 0; s < 24; s++) {
  const source = { host: "fixture", cacheDir: dir, path: `/synthetic/${s}.jsonl`, file: join(dir, `${s}.jsonl`) };
  writeFileSync(source.file, header(`session-${s}`, "2026-01-01T00:00:00Z") + Array.from({ length: 600 }, (_, i) => message(`e${i}`, i ? `e${i-1}` : null, `retentionneedle ${i === 0 ? `unique${s}` : "filler"} ` + "x".repeat(512), "2026-01-01T00:00:01Z")).join(""));
  sources.push(source);
 }
 const store = new WorkingSet("fixture", dir);
 t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
 await store.ready;
 assert.throws(() => store.db.exec("BEGIN IMMEDIATE"), /readonly|read-only/);
 const delay = monitorEventLoopDelay({ resolution: 1 }); delay.enable();
 let previous = performance.now(), drift = 0, derived = 0, firstRetirement: number | undefined;
 const timer = setInterval(() => { const now = performance.now(); drift = Math.max(drift, now - previous - 5); previous = now; }, 5);
 try {
  await pause(10);
  await Promise.all(sources.map(async (source, i) => {
   await store.refresh(source); derived++;
   assert.ok(store.search(`unique${i}`).hits.length > 0);
   assert.equal(await store.forget(source), true);
   firstRetirement ??= derived;
   assert.equal(store.load(source.path), undefined);
   assert.equal(store.search(`unique${i}`).hits.length, 0, "forget ack follows search removal");
  }));
  await pause(10);
 } finally { clearInterval(timer); delay.disable(); }
 t.diagnostic(JSON.stringify({ load, maxLoopMs: delay.max / 1e6, maxDriftMs: drift, firstRetirement }));
 assert.ok(firstRetirement! < sources.length, "retention must run between derives, before the cold backlog completes");
 // A CI shard runs other files on the same cores, and their CPU use delays this loop too: there, 250 ms still catches a
 // writer that blocks the loop for a whole backlog.
 const budget = process.env.CI ? 250 : 50;
 assert.ok(Math.max(delay.max / 1e6, drift) <= budget, `main loop blocked ${Math.max(delay.max / 1e6, drift).toFixed(1)} ms (budget ${budget} ms)`);
});

test("retention writer: opening cancels a forget job that has not started", async (t) => {
 const dir = mkdtempSync(join(tmpdir(), "ampi-retention-cancel-"));
 const store = new WorkingSet("fixture", dir);
 t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
 const source = (name: string): Source => ({ host: "fixture", cacheDir: dir, path: `/synthetic/${name}`, file: join(dir, `${name}.jsonl`) });
 const target = source("target"), filling = source("filling");
 writeFileSync(target.file, header("target") + message("e0", null, "keepneedle"));
 writeFileSync(filling.file, header("filling") + Array.from({ length: 4000 }, (_, i) => message(`e${i}`, i ? `e${i-1}` : null, "filling " + "x".repeat(256))).join(""));
 await store.refresh(target);
 const fill = store.refresh(filling);
 await pause(20);
 const forgetting = store.forget(target); store.cancelForget(target);
 assert.equal(await forgetting, false); await fill;
 assert.ok(store.load(target.path)); assert.equal(store.search("keepneedle").hits.length, 1);
});

async function hostFixture(t: { after(fn: () => unknown): void }) {
 const f = fixture(); const old = "2026-01-01T00:00:00Z";
 writeFileSync(f.sessionA, header("sess-a", old) + message("e0", null, "retention evidence", old));
 writeFileSync(f.sessionB, header("sess-b", old) + message("e0", null, "live evidence", old));
 const hub = new Hub({ hosts: [{ id: "fixture", label: "fixture", kind: "pi-local", cacheDir: join(f.dir, "cache"), agentConfig: { agentDir: f.agentDir, pollMs: 30, discoverMs: 150, teams: false }, env: { HOME: f.dir, HERDR_BIN: join(f.dir, "herdr"), FAKE_HERDR_STATE: join(f.dir, "state.json"), FAKE_HERDR_LOG: join(f.dir, "calls.jsonl") } }] }, { token: "c".repeat(64) });
 const port = await hub.listen(0); const browser = await Browser.open(port, undefined, `ampi_k_${port}=${"c".repeat(64)}`);
 t.after(async () => { browser.ws.close(); await hub.close(); rmSync(f.dir, { recursive: true, force: true }); });
 const threads = browser.sub("fixture", { kind: "threads" });
 await browser.until<any>(threads, v => v.threads["pi:sess-a"]?.live && v.threads["pi:sess-b"]?.live);
 return { f, hub, browser, threads, closeA: () => f.setState({ ...f.state, agents: f.state.agents.filter((a: any) => a.agent_session?.value !== f.sessionA) }) };
}

test("retention A: unknown liveness, unknown freshness, live and recent Sessions never send forget", async (t) => {
 const dir = mkdtempSync(join(tmpdir(), "ampi-retention-policy-"));
 const script = join(dir, "source"), state = join(dir, "state.json"), log = join(dir, "commands.jsonl");
 const old = "2026-01-01T00:00:00Z", now = new Date().toISOString();
 const frames = [ { t: "hello", host: "fixture" }, ...[["old", old], ["unknown", undefined], ["recent", now]].map(([id, at]) => ({ t: "chunk", path: `/synthetic/${id}`, offset: 0, data: header(id!, at) + message("e0", null, "policy", at) })) ];
 // The source polls this file every 10 ms; replaceFile keeps each read whole.
 replaceFile(state, JSON.stringify({ t: "agents", agents: [] }));
 writeFileSync(script, `#!${process.execPath}\nconst fs=require('fs');const out=x=>console.log(JSON.stringify(x));for(const f of ${JSON.stringify(frames)})out(f);let last='';setInterval(()=>{const s=fs.readFileSync(${JSON.stringify(state)},'utf8');if(s!==last){last=s;const f=JSON.parse(s);if(f.exit)process.exit(0);out(f)}},10);let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const f=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(f.t==='forget'){fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(f)+'\\n');out({t:'ack',id:f.id,ok:false,error:{code:'source_unknown',message:'fixture refused'}})}}});\n`);
 chmodSync(script, 0o755);
 const hub = new Hub({ hosts: [{ id: "fixture", label: "fixture", kind: "pi-local", cacheDir: join(dir, "cache"), remoteNode: script }] }, { token: "c".repeat(64) });
 const port = await hub.listen(0), browser = await Browser.open(port, undefined, `ampi_k_${port}=${"c".repeat(64)}`);
 t.after(async () => { browser.ws.close(); await hub.close(); rmSync(dir, { recursive: true, force: true }); });
 const sid = browser.sub("fixture", { kind: "threads" });
 await browser.until<any>(sid, v => Object.keys(v.threads).length === 3);
 browser.ws.send(JSON.stringify({ t: "unsub", sid: 999 })); await pause(50);
 assert.equal(existsSync(log), false, "unknown liveness cannot authorize forget");
 replaceFile(state, JSON.stringify({ t: "agents", panes: [{ pane: "p1" }], agents: [{ session: "/synthetic/old", pane: "p1" }] }));
 await browser.until<any>(sid, v => v.threads["pi:old"]?.live); await pause(50);
 assert.equal(existsSync(log), false, "live, recent and unknown-age copies remain");
 replaceFile(state, JSON.stringify({ exit: true }));
 await browser.when(() => browser.hosts[0]?.status === "disconnected");
 browser.ws.send(JSON.stringify({ t: "unsub", sid: 998 })); await pause(50);
 assert.equal(existsSync(log), false, "disconnected last-known-live copy remains");
});

test("retention B: source loss after Worker ack keeps the only replica and rebuilds its searchable evidence", async (t) => {
 const { f, browser, threads, closeA } = await hostFixture(t);
 const original = WorkingSet.prototype.forget;
 t.mock.method(WorkingSet.prototype, "forget", async function(this: WorkingSet, source: Source, watermark?: unknown) {
  const removed = await original.call(this, source, watermark);
  if (source.path === f.sessionA && removed) rmSync(f.sessionA);
  return removed;
 });
 closeA();
 await browser.until<any>(threads, v => /retained for recovery/.test(v.threads["pi:sess-a"]?.lastError ?? ""));
 const sid = browser.sub("fixture", { kind: "thread", threadId: "pi:sess-a" });
 const value = await browser.until<any>(sid, v => v.entries?.length === 1);
 assert.equal(value.entries[0].text, "retention evidence");
 const found = await browser.req("fixture", "sessions.search", { query: "retention" });
 assert.ok(found.hits.some((h: any) => h.threadId === "pi:sess-a"));
});

test("retention C, D15 reader-only: an open during started eviction waits for ack then gets the K5 tombstone without a half-read copy", async (t) => {
 const { f, browser, closeA } = await hostFixture(t);
 const committed = gate(), release = gate();
 const original = WorkingSet.prototype.forget;
 t.mock.method(WorkingSet.prototype, "forget", async function(this: WorkingSet, source: Source, watermark?: unknown) {
  const removed = await original.call(this, source, watermark);
  if (source.path === f.sessionA && removed) { committed.resolve(); await release.promise; }
  return removed;
 });
 closeA(); await committed.promise;
 const sid = browser.sub("fixture", { kind: "thread", threadId: "pi:sess-a" });
 try { await pause(50); assert.equal(browser.values.has(sid), false, "the open remains loading until ack"); }
 finally { release.resolve(); }
 const value = await browser.until<any>(sid, v => /outside retained scope/.test(v.agent?.readError ?? ""));
 assert.deepEqual(value.entries, []); assert.match(value.agent.readError, /K5/); assert.deepEqual(browser.gaps, []);
});
