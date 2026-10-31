import "./bound.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { applyImmutable } from "@earendil-works/chord/delta";
import { Hub } from "../src/hub/hub.ts";
import { PiHost } from "../src/pi/host.ts";
import { repairReplicaTail } from "../src/pi/replica-file.ts";
import { WorkingSet, workingSetUsage } from "../src/pi/working-set.ts";
import { fixture as herdrFixture } from "./pi-fixtures.ts";
import { openWorkingSet } from "../src/pi/working-set-db.ts";

/**
 * A temporary cache directory and the one cleanup that removes it. A test passes each Host stop or store close to
 * `own`; the cleanup awaits them in order, then removes the directory, so no writer outlives it.
 */
function fixture(t: { after(fn: () => unknown): void }) {
 const dir = mkdtempSync(join(tmpdir(), "ampi-startup-"));
 const closes: (() => unknown)[] = [];
 t.after(async () => {
  try { for (const close of closes) await close(); }
  finally { rmSync(dir, { recursive: true, force: true }); }
 });
 const config = { id: "fixture", label: "fixture", kind: "pi-local" as const, remoteNode: "/usr/bin/false", cacheDir: join(dir, "cache") };
 return { dir, config, own: (close: () => unknown) => { closes.push(close); } };
}

test("startup: constructing a Pi Host performs no cache I/O", async (t) => {
 const { config } = fixture(t);
 const host = new PiHost(config);
 assert.equal(existsSync(config.cacheDir), false);
 await host.stop();
 assert.equal(existsSync(config.cacheDir), false);
});

test("startup: health and page answer while metadata waits; unsubscribe and replacement cancel pending snapshots", async (t) => {
 const { config, own } = fixture(t);
 const webDist = join(import.meta.dirname, "..", "web", "dist");
 const indexPath = join(webDist, "index.html");
 mkdirSync(webDist, { recursive: true });
 let createdIndex = false;
 try {
  writeFileSync(indexPath, "<!doctype html><title>AmPi test page</title>\n", { flag: "wx" });
  createdIndex = true;
 } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
 }
 if (createdIndex) t.after(() => rmSync(indexPath, { force: true }));
 const hub = new Hub({ hosts: [config] }, { token: "c".repeat(64) });
 const host = hub.link(config.id) as PiHost;
 mkdirSync(host.cacheDir, { recursive: true });
 const index = join(host.cacheDir, "index.json");
 execFileSync("mkfifo", [index]);
 const frames: any[] = [];
 host.on("frame", frame => frames.push(frame));
 const port = await hub.listen(0);
 own(() => hub.close());
 host.send({ t: "sub", sid: 1, topic: { kind: "threads" } });
 host.send({ t: "unsub", sid: 1 });
 host.send({ t: "sub", sid: 2, topic: { kind: "threads" } });
 host.send({ t: "sub", sid: 2, topic: { kind: "node" } });
 try {
  for (const path of ["/api/health", "/"]) {
   const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2000) });
   assert.equal(response.status, 200); await response.arrayBuffer();
  }
  assert.equal(frames.some(f => f.t === "snap"), false);
 } finally { await writeFile(index, "{}"); }
 const until = Date.now() + 5000;
 while (!frames.some(f => f.sid === 2 && f.t === "snap") && Date.now() < until) await new Promise(r => setTimeout(r, 10));
 assert.equal(frames.some(f => f.sid === 1), false);
 assert.equal(frames.filter(f => f.sid === 2 && f.t === "snap").length, 1);
 assert.equal(frames.find(f => f.sid === 2 && f.t === "snap")?.value.backend, "pi");
 await hub.close();
});

test("startup: stop waits for metadata and preserves copies without late snapshots", async (t) => {
 const { config } = fixture(t);
 const host = new PiHost(config);
 mkdirSync(host.cacheDir, { recursive: true });
 const file = join(host.cacheDir, "copy.jsonl"), index = join(host.cacheDir, "index.json");
 writeFileSync(file, "{}\npartial");
 execFileSync("mkfifo", [index]);
 const frames: unknown[] = []; host.on("frame", f => frames.push(f));
 host.start(); host.send({ t: "sub", sid: 1, topic: { kind: "threads" } });
 const stopping = host.stop();
 await writeFile(index, JSON.stringify({ "/synthetic/session": { file: "copy.jsonl", offset: 999, lastKnownLive: true } }));
 await stopping;
 const saved = JSON.parse(readFileSync(index, "utf8"));
 assert.equal(saved["/synthetic/session"].offset, 3);
 assert.equal(saved["/synthetic/session"].lastKnownLive, true);
 assert.equal(readFileSync(file, "utf8"), "{}\n");
 assert.deepEqual(frames, []);
});

test("startup: invalid metadata ends pending reads and stop preserves the evidence", async (t) => {
 const { config } = fixture(t); const host = new PiHost(config);
 mkdirSync(host.cacheDir, { recursive: true });
 const index = join(host.cacheDir, "index.json"); writeFileSync(index, "{");
 host.start(); const received = once(host, "frame");
 host.send({ t: "sub", sid: 1, topic: { kind: "threads" } });
 const [frame] = await received;
 assert.equal(frame.t, "end"); assert.match(frame.reason, /Host cache unavailable/);
 await assert.rejects(host.stop(), SyntaxError);
 assert.equal(readFileSync(index, "utf8"), "{");
});

test("startup: stop after invalid metadata resolves only when the derive Worker can no longer write the Host cache", async (t) => {
 const { dir, config } = fixture(t);
 // Another owner's derive waits on a held write lock, so the Host's init stays queued behind it.
 const ownerDir = join(dir, "owner"), file = join(ownerDir, "copy.jsonl");
 mkdirSync(ownerDir);
 writeFileSync(file, JSON.stringify({ type: "session", id: "owner", timestamp: new Date().toISOString(), cwd: "/synthetic" }) + "\n");
 const source = { host: "owner", cacheDir: ownerDir, path: "/synthetic/owner", file };
 const owner = new WorkingSet("owner", ownerDir);
 try {
  // The store's first backfill step also writes, so it runs before the lock.
  await owner.refresh({ ...source, path: "/synthetic/warm" });
  const held = openWorkingSet(ownerDir); held.exec("BEGIN IMMEDIATE");
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const derived = owner.refresh(source, started).catch(() => null);
  await running;
  const host = new PiHost(config);
  // Saved heads make the store readable without the Worker, so stop can begin while init waits.
  openWorkingSet(host.cacheDir).close();
  writeFileSync(join(host.cacheDir, "index.json"), "{");
  host.start();
  const stopping = assert.rejects(host.stop(), SyntaxError);
  setTimeout(() => { held.exec("ROLLBACK"); held.close(); }, 300);
  await stopping;
  rmSync(host.cacheDir, { recursive: true });
  await derived;
  // Jobs run in rank order, so this derive passes every init queued before it.
  await owner.refresh(source);
  assert.equal(existsSync(host.cacheDir), false, "the Worker wrote the Host cache after stop resolved");
 } finally { await owner.close(); }
});

test("startup: tail repair crosses chunk boundaries and handles empty or incomplete replicas", async (t) => {
 const { dir } = fixture(t); const file = join(dir, "copy.jsonl");
 for (const [input, expected] of [["{}\n" + "x".repeat(150000), "{}\n"], ["x".repeat(150000), ""], ["", ""], ["{}\n", "{}\n"]]) {
  writeFileSync(file, input!); assert.equal(await repairReplicaTail(file), Buffer.byteLength(expected!));
  assert.equal(readFileSync(file, "utf8"), expected);
 }
});

test("startup: queued copies do not poll heads; a started copy publishes its commit before the result notice", async (t) => {
 const { config, own } = fixture(t), host = new PiHost(config);
 own(async () => { for (const job of jobs) job.done.resolve(null); await host.stop(); });
 mkdirSync(host.cacheDir, { recursive: true });
 const index: Record<string, unknown> = {};
 for (let i = 0; i < 12; i++) {
  const file = `copy${i}.jsonl`;
  writeFileSync(join(host.cacheDir, file), JSON.stringify({ type: "session", id: `queued${i}`, cwd: "/synthetic" }) + "\n");
  index[`/synthetic/${i}`] = { file, offset: 0 };
 }
 writeFileSync(join(host.cacheDir, "index.json"), JSON.stringify(index));
 const original = WorkingSet.prototype.refresh;
 const jobs: { store: WorkingSet; source: Parameters<WorkingSet["refresh"]>[0]; start?: () => void; done: { promise: Promise<any>; resolve: (data: any) => void } }[] = [];
 let resolveBacklog!: () => void;
 const backlog = new Promise<void>(resolve => { resolveBacklog = resolve; });
 t.mock.method(WorkingSet.prototype, "refresh", function(this: WorkingSet, source: Parameters<WorkingSet["refresh"]>[0], start?: () => void) {
  let resolve!: (data: any) => void; const promise = new Promise<any>(r => { resolve = r; });
  const done = { promise, resolve }; jobs.push({ store: this, source, start, done });
  if (jobs.length === 12) resolveBacklog();
  return done.promise;
 });
 const reads = t.mock.method(WorkingSet.prototype, "load");
 const frames: any[] = []; host.on("frame", f => frames.push(f));
 const waitFrame = (sid: number) => new Promise<void>((resolve, reject) => {
  const onFrame = (frame: any) => {
   if (frame.sid !== sid) return;
   clearTimeout(timer); host.off("frame", onFrame); resolve();
  };
  const timer = setTimeout(() => { host.off("frame", onFrame); reject(new Error(`timed out waiting for snapshot ${sid}`)); }, 30_000);
  host.on("frame", onFrame);
 });
 const within = <T>(promise: Promise<T>, what: string) => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 30_000);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
 });
 host.start();
 await within(backlog, "all queued refresh jobs");
 reads.mock.resetCalls();
 const firstFrame = waitFrame(1);
 host.send({ t: "sub", sid: 1, topic: { kind: "threads" } });
 await firstFrame;
 assert.equal(reads.mock.callCount(), 0, "queued copies cannot have new committed heads");
 const job = jobs.find(j => j.source.path === "/synthetic/0")!;
 let resolveStarted!: () => void;
 const started = new Promise<void>(resolve => { resolveStarted = resolve; });
 const refreshing = original.call(job.store, job.source, () => { job.start?.(); resolveStarted(); });
 await within(started, "the selected worker job to start");
 const data = await within(refreshing, "the selected worker job to commit");
 reads.mock.resetCalls();
 const secondFrame = waitFrame(2);
 host.send({ t: "sub", sid: 2, topic: { kind: "threads" } });
 await secondFrame;
 // Every snapshot or publish in this window may re-read the started copy's head; the count depends on timing.
 const polled = new Set(reads.mock.calls.map(c => c.arguments[0]));
 assert.deepEqual([...polled], ["/synthetic/0"], "only the started copy can advance");
 assert.ok(frames.find(f => f.sid === 2)?.value.threads["pi:queued0"], "the committed DB head is visible while the result is held");
 job.done.resolve(data);
});

test("startup: warm Timeline and Overview read committed heads without transcript windows", async (t) => {
 const { config } = fixture(t); const host = new PiHost(config);
 mkdirSync(host.cacheDir, { recursive: true });
 const file = join(host.cacheDir, "copy.jsonl"), path = "/synthetic/session";
 writeFileSync(file, JSON.stringify({ type: "session", id: "warm", timestamp: new Date().toISOString(), cwd: "/synthetic" }) + "\n" + JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "warm evidence" } }) + "\n");
 const store = new WorkingSet(config.id, host.cacheDir);
 await store.refresh({ host: config.id, cacheDir: host.cacheDir, path, file }); store.close();
 writeFileSync(join(host.cacheDir, "index.json"), JSON.stringify({ [path]: { file: "copy.jsonl", offset: 0 } }));
 const before = workingSetUsage();
 host.start();
 for (const [sid, topic] of [[1, { kind: "view", view: "cos.timeline" }], [2, { kind: "threads" }]] as const) {
  const received = once(host, "frame"); host.send({ t: "sub", sid, topic });
  const [frame] = await received; assert.equal(frame.t, "snap");
  if (sid === 1) assert.equal(frame.value.sessions[0].entryCount, 1);
  else assert.ok(JSON.stringify(frame.value).includes("pi:warm"));
 }
 assert.deepEqual(workingSetUsage(), before);
 await host.stop();
});

test("startup: the first threads snapshot reads saved heads while the derive Worker still initializes", async (t) => {
 const { config } = fixture(t); const host = new PiHost(config);
 mkdirSync(host.cacheDir, { recursive: true });
 const file = join(host.cacheDir, "copy.jsonl"), path = "/synthetic/session";
 writeFileSync(file, JSON.stringify({ type: "session", id: "cold", timestamp: new Date().toISOString(), cwd: "/synthetic" }) + "\n" + JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "cold restart" }], timestamp: Date.now() } }) + "\n");
 const store = new WorkingSet(config.id, host.cacheDir);
 await store.refresh({ host: config.id, cacheDir: host.cacheDir, path, file }); store.close();
 writeFileSync(join(host.cacheDir, "index.json"), JSON.stringify({ [path]: { file: "copy.jsonl", offset: 0 } }));
 // A held write lock keeps Worker init (openWorkingSet) waiting, as a slow Worker start does under load; reads pass.
 const lock = new DatabaseSync(join(host.cacheDir, "working-set.sqlite")); lock.exec("BEGIN IMMEDIATE");
 const frames: any[] = []; host.on("frame", f => frames.push(f));
 try {
  host.start(); host.send({ t: "sub", sid: 1, topic: { kind: "threads" } });
  const until = Date.now() + 2000;
  while (!frames.some(f => f.sid === 1) && Date.now() < until) await new Promise(r => setTimeout(r, 10));
  const snap = frames.find(f => f.sid === 1);
  assert.equal(snap?.t, "snap", "no threads snapshot while the derive Worker initializes");
  assert.ok(JSON.stringify(snap.value).includes("pi:cold"));
  assert.equal(snap.value.indexing, true, "a list from saved heads says the working set has not initialized");
  assert.equal(snap.value.updating, true, "a warm restart says the startup refresh still runs");
 } finally { lock.exec("ROLLBACK"); lock.close(); }
 const value = await until(frames, 1, (v) => !v.indexing && !v.updating);
 assert.ok(value.threads["pi:cold"], "the refreshed list keeps the saved row");
 await host.stop();
});

test("startup: a working set without a saved database answers index reads before the derive Worker", async (t) => {
 const { config, own } = fixture(t);
 mkdirSync(config.cacheDir, { recursive: true });
 const store = new WorkingSet(config.id, config.cacheDir);
 own(() => store.close());
 // Worker init needs a Worker message, which cannot arrive before this immediate; `readable` must not wait for it.
 assert.equal(await Promise.race([store.readable.then(() => "readable"), new Promise(r => setImmediate(() => r("waited")))]), "readable");
 assert.equal(store.load("/synthetic/none"), undefined);
 assert.equal(store.snapshot(() => 7), 7);
 await store.ready;
 assert.equal(store.load("/synthetic/none"), undefined);
});

/** Folds one subscription's snap and ops frames; resolves with the first value that satisfies `done`. */
async function until(frames: any[], sid: number, done: (value: any) => boolean, ms = 10_000): Promise<any> {
 const end = Date.now() + ms;
 for (;;) {
  let value: any;
  for (const f of frames.filter(f => f.sid === sid)) {
   if (f.t === "snap") value = f.value; else if (f.t === "ops") value = applyImmutable(value, f.ops);
   else if (f.t === "end") throw new Error(`subscription ended: ${f.reason}`);
   if (value !== undefined && done(value)) return value;
  }
  if (Date.now() > end) throw new Error(`timed out; last value ${JSON.stringify(value)}`);
  await new Promise(r => setTimeout(r, 10));
 }
}

test("startup: saved rows say listing until the first agents list, which places them in the same update", async (t) => {
 const f = herdrFixture();
 // Every Herdr call but the probe waits for the gate, so the agents list arrives only when the test opens it. The
 // probe answers at once: a probe timeout (3 s) would make the agent fall back to a real Herdr on PATH.
 const gate = join(f.dir, "gate"), herdr = join(f.dir, "gated-herdr");
 writeFileSync(herdr, `#!/bin/sh\n[ "$1" = --version ] || while [ ! -e '${gate}' ]; do sleep 0.02; done\nexec '${join(f.dir, "herdr")}' "$@"\n`); chmodSync(herdr, 0o755);
 const config = { id: "fixture", label: "fixture", kind: "pi-local" as const, cacheDir: join(f.dir, "cache"),
  agentConfig: { agentDir: f.agentDir, pollMs: 30, discoverMs: 300, teamsMs: 0 },
  env: { HOME: f.dir, HERDR_BIN: herdr, FAKE_HERDR_STATE: join(f.dir, "state.json"), FAKE_HERDR_LOG: join(f.dir, "calls.jsonl") } };
 const host = new PiHost(config);
 mkdirSync(host.cacheDir, { recursive: true });
 const copy = join(host.cacheDir, "a.jsonl");
 writeFileSync(copy, readFileSync(f.sessionA));
 const store = new WorkingSet(config.id, host.cacheDir);
 await store.refresh({ host: config.id, cacheDir: host.cacheDir, path: f.sessionA, file: copy }); store.close();
 writeFileSync(join(host.cacheDir, "index.json"), JSON.stringify({ [f.sessionA]: { file: "a.jsonl", offset: statSync(copy).size } }));
 const frames: any[] = []; host.on("frame", fr => frames.push(fr));
 host.start(); t.after(async () => { await host.stop(); rmSync(f.dir, { recursive: true, force: true }); });
 host.send({ t: "sub", sid: 1, topic: { kind: "threads" } });
 const first = await until(frames, 1, () => true);
 assert.equal(first.listing, true, "no agents list yet");
 assert.equal(first.threads["pi:sess-a"]?.location, undefined);
 await new Promise(r => setTimeout(r, 300));
 assert.ok(!frames.some(fr => fr.sid === 1 && fr.t === "ops" && JSON.stringify(fr.ops).includes("listing")), "listing holds while the agents list waits");
 writeFileSync(gate, "");
 const listed = await until(frames, 1, (v) => !v.listing);
 assert.equal(listed.threads["pi:sess-a"]?.location?.pane, "w1:p2", "the update that ends listing places the row");
 assert.equal(listed.threads["pi:sess-a"]?.live, true);
 // A reconnect: listing returns, and the saved row stays listed (not live) until the next agents list.
 const seen = frames.length;
 // -P scopes pgrep to this test process's own children: the Host agent it spawned, never another process's agent.
 for (const pid of execFileSync("pgrep", ["-P", String(process.pid), "-f", "Buffer.from"], { encoding: "utf8" }).trim().split("\n")) process.kill(Number(pid), "SIGKILL");
 const relisting = await until(frames, 1, (v) => v.listing && frames.length > seen);
 assert.ok(relisting.threads["pi:sess-a"], "a reconnect keeps saved rows listed");
 assert.notEqual(relisting.threads["pi:sess-a"].live, true);
 const back = await until(frames, 1, (v) => !v.listing && v.threads["pi:sess-a"]?.live === true);
 assert.equal(back.threads["pi:sess-a"].location?.pane, "w1:p2");
});

test("startup: a fresh cache lists nothing with indexing while init waits, and a failed init ends served and later lists", async (t) => {
 const { config, own } = fixture(t); const host = new PiHost(config);
 mkdirSync(host.cacheDir, { recursive: true });
 // A WAL database with no tables has nothing saved to read. The held write lock keeps Worker init waiting until
 // BUSY_MS (5 s) fails it.
 const lock = new DatabaseSync(join(host.cacheDir, "working-set.sqlite")); lock.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE");
 own(() => { try { lock.exec("ROLLBACK"); } catch {} lock.close(); });
 const frames: any[] = []; host.on("frame", f => frames.push(f));
 // A threads subscription sent in the same tick the Host reports the failure.
 host.on("state", (s) => { if (s.status === "disconnected") host.send({ t: "sub", sid: 4, topic: { kind: "threads" } }); });
 host.start(); own(() => host.stop().catch(() => {}));
 host.send({ t: "sub", sid: 1, topic: { kind: "threads" } });
 // A view waits for init, so it is still preparing when init fails.
 host.send({ t: "sub", sid: 3, topic: { kind: "view", view: "cos.timeline" } });
 const first = await until(frames, 1, () => true, 2000).catch((error) => assert.fail(`no list before init failed: ${error.message}`));
 assert.deepEqual(first.threads, {});
 assert.equal(first.indexing, true, "an empty list before init proves no absence");
 const ended = async (sid: number) => {
  const end = Date.now() + 15_000;
  while (!frames.some(f => f.sid === sid && f.t === "end") && Date.now() < end) await new Promise(r => setTimeout(r, 20));
  assert.match(frames.find(f => f.sid === sid && f.t === "end")?.reason ?? "", /^Host cache unavailable: .+\. Restart the hub; if it repeats, check the hub log/, `sid ${sid} ends with the next step`);
 };
 await ended(1);
 host.send({ t: "sub", sid: 2, topic: { kind: "threads" } });
 for (const sid of [2, 3, 4]) await ended(sid);
 await new Promise(r => setTimeout(r, 100));
 for (const sid of [1, 2, 3, 4]) assert.equal(frames.filter(f => f.sid === sid && f.t === "end").length, 1, `sid ${sid} ends once`);
 for (const sid of [2, 3, 4]) assert.equal(frames.some(f => f.sid === sid && f.t === "snap"), false, `no value for sid ${sid} after a failed init`);
 assert.match(host.state.error ?? "", /^Host cache unavailable: /);
 assert.match(host.state.hint ?? "", /Restart the hub/, "the hint names the next step");
 assert.equal(host.state.cacheFailed, true);
 assert.equal(host.state.errorClass, "reachability", "a lock that another process holds can clear");
});

test("startup: updating clears at UPDATING_MAX_MS when the startup refresh does not settle, and the log says which", async (t) => {
 const { config } = fixture(t); const host = new PiHost(config);
 mkdirSync(host.cacheDir, { recursive: true });
 const file = join(host.cacheDir, "copy.jsonl"), path = "/synthetic/session";
 writeFileSync(file, JSON.stringify({ type: "session", id: "slow", timestamp: new Date().toISOString(), cwd: "/synthetic" }) + "\n");
 const store = new WorkingSet(config.id, host.cacheDir);
 await store.refresh({ host: config.id, cacheDir: host.cacheDir, path, file }); store.close();
 writeFileSync(join(host.cacheDir, "index.json"), JSON.stringify({ [path]: { file: "copy.jsonl", offset: 0 } }));
 t.mock.method(WorkingSet.prototype, "refresh", () => new Promise(() => {}));
 const log = t.mock.method(console, "log", () => {});
 const bound = PiHost.UPDATING_MAX_MS; PiHost.UPDATING_MAX_MS = 300; t.after(() => { PiHost.UPDATING_MAX_MS = bound; });
 const frames: any[] = []; host.on("frame", f => frames.push(f));
 host.start();
 try {
  host.send({ t: "sub", sid: 1, topic: { kind: "threads" } });
  assert.equal((await until(frames, 1, () => true)).updating, true, "the first list says the refresh has not settled");
  await until(frames, 1, (v) => !v.updating, 10_000);
  // The log measures from init with the timer itself, so it holds under load too.
  const line = log.mock.calls.map(c => String(c.arguments[0])).find(l => l.includes("Updating cleared"));
  const [, ms] = line?.match(/Updating cleared after (\d+) ms: the bound passed while the startup refresh still runs/) ?? [];
  assert.ok(Number(ms) >= 300, `updating holds until the bound: ${line}`);
 } finally { await host.stop(); }
});

test("startup: a failed index write shows as cache health, apart from the link, and the next good write clears it", async (t) => {
 const { config, own } = fixture(t);
 const host = new PiHost(config);
 own(() => host.stop().catch(() => {}));
 // A directory where the write puts its temporary file: every index write fails until it goes.
 const blocker = join(host.cacheDir, "index.json.tmp");
 mkdirSync(blocker, { recursive: true });
 const states: { status: string; indexError?: string; error?: string }[] = []; host.on("state", s => states.push(s));
 host.start();
 const until = async (done: () => boolean) => { const by = Date.now() + 10_000; while (!done()) { if (Date.now() > by) throw new Error(`timed out: ${JSON.stringify(host.state)}`); await new Promise(r => setTimeout(r, 20)); } };
 await until(() => host.state.indexError !== undefined);
 assert.match(host.state.indexError ?? "", /EISDIR|EEXIST|directory/i);
 assert.ok(!states.some(s => /EISDIR|directory/i.test(s.error ?? "")), "an index write failure never becomes a link error");
 rmSync(blocker, { recursive: true });
 await until(() => host.state.indexError === undefined);
 assert.ok(existsSync(join(host.cacheDir, "index.json")), "the next write succeeds and clears the warning");
});
