import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { Hub } from "../src/hub/hub.ts";
import { PiHost } from "../src/pi/host.ts";
import { repairReplicaTail } from "../src/pi/replica-file.ts";
import { WorkingSet, workingSetUsage } from "../src/pi/working-set.ts";

function fixture(t: { after(fn: () => unknown): void }) {
 const dir = mkdtempSync(join(tmpdir(), "ampi-startup-"));
 t.after(() => rmSync(dir, { recursive: true, force: true }));
 const config = { id: "fixture", label: "fixture", kind: "pi-local" as const, remoteNode: "/usr/bin/false", cacheDir: join(dir, "cache") };
 return { dir, config };
}

test("startup: constructing a Pi Host performs no cache I/O", async (t) => {
 const { config } = fixture(t);
 const host = new PiHost(config);
 assert.equal(existsSync(config.cacheDir), false);
 await host.stop();
 assert.equal(existsSync(config.cacheDir), false);
});

test("startup: health and page answer while metadata waits; unsubscribe and replacement cancel pending snapshots", async (t) => {
 const { config } = fixture(t);
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
 const hub = new Hub({ hosts: [config], backend: "pi" }, { token: "c".repeat(64) });
 const host = hub.links.get(config.id) as PiHost;
 mkdirSync(host.cacheDir, { recursive: true });
 const index = join(host.cacheDir, "index.json");
 execFileSync("mkfifo", [index]);
 const frames: any[] = [];
 host.on("frame", frame => frames.push(frame));
 const port = await hub.listen(0);
 t.after(() => hub.close());
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

test("startup: tail repair crosses chunk boundaries and handles empty or incomplete replicas", async (t) => {
 const { dir } = fixture(t); const file = join(dir, "copy.jsonl");
 for (const [input, expected] of [["{}\n" + "x".repeat(150000), "{}\n"], ["x".repeat(150000), ""], ["", ""], ["{}\n", "{}\n"]]) {
  writeFileSync(file, input!); assert.equal(await repairReplicaTail(file), Buffer.byteLength(expected!));
  assert.equal(readFileSync(file, "utf8"), expected);
 }
});

test("startup: queued copies do not poll heads; a started copy publishes its commit before the result notice", async (t) => {
 const { config } = fixture({ after(fn) { t.after(async () => { for (const job of jobs) job.done.resolve(null); await host.stop(); fn(); }); } }), host = new PiHost(config);
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
