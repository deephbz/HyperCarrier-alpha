import "./bound.ts";
// Systems review milestone 1, risks 3 to 7 at the hub (docs/durable/review-milestone-1-systems.md): a sync streams pages
// to the disk copy, one hub owns a cache, a damaged copy shows rebuilding and rebuilds exactly, a close during an open
// leaves no handle, and an HTTP abort ends a raw export whose node read never answers. The shared reader's own tests
// are in trace-analytics test/durable-hardening.test.mjs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, truncateSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { DurableViews, REBUILDING } from "../src/durable/reader-side.ts";
import { claimCacheDir } from "../src/durable/cache-owner.ts";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { runDaemon } from "../src/node/daemon.ts";
import { readerStats } from "../src/node/server.ts";
import { Hub } from "../src/hub/hub.ts";
import { Browser, tempHome } from "./helpers.ts";
// @ts-ignore: plain ESM test fixtures over a real pi-durable 1.4.0 store.
import { ask, openFixtureStore } from "../../trace-analytics/test/fixtures/durable-store.mjs";
// @ts-ignore: the real reader service behind a JSON round-trip, as on the wire.
import { serviceNode } from "../../trace-analytics/test/fixtures/durable-node.mjs";
// @ts-ignore: shared reader is plain ESM.
import { durableCopyFiles } from "../../trace-analytics/src/sources/durable-copy.mjs";

const HOST = "demo";
const deferred = <T = void>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise((r) => setImmediate(r));

async function store(t: any, questions = 3) {
 const dir = mkdtempSync(join(tmpdir(), "ampi-durable-hardening-"));
 const { harness, root } = await openFixtureStore(join(dir, "store.sqlite"));
 for (let i = 0; i < questions; i++) await ask(root, `question ${i}`);
 const node = serviceNode(harness);
 const views: DurableViews[] = [];
 t.after(async () => { for (const v of views) await v.close(); await node.harness.close(context); rmSync(dir, { recursive: true, force: true }); });
 const open = (wire: unknown = node) => { const v = new DurableViews({ host: HOST, cacheDir: join(dir, "cache"), node: () => wire as never }); views.push(v); return v; };
 return { dir, node, root, open, views, threadId: `tree-a.${root.id}` };
}
const metaLines = (file: string) => { try { return JSON.parse(readFileSync(durableCopyFiles(file).meta, "utf8")).lines as number; } catch { return 0; } };

test("risk 3: a cold sync commits each wire page to the disk copy before it fetches the next", async (t) => {
 const s = await store(t);
 let file = "";
 const seen: number[] = [];
 // Pages of two records: every fetch after the first finds the previous page already committed.
 const wire = { ...s.node, entries: (args: any, ...rest: unknown[]) => { if (file) seen.push(metaLines(file)); return s.node.entries({ ...args, limit: 2 }, ...rest); } };
 const views = s.open(wire);
 file = join(views.cacheDir, `${createHash("sha256").update(s.threadId).digest("hex").slice(0, 32)}.jsonl`);
 await views.track(s.threadId);
 const count = views.context.session(s.threadId)!.data.count;
 assert.ok(count > 4, `the store has ${count} entries`);
 assert.equal(seen[0], 0);
 for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= 2 * i, `fetch ${i} saw ${seen[i]} committed lines`);
 assert.equal(metaLines(file), count);
});

const HOLDER = fileURLToPath(new URL("./fixtures/hold-durable-cache.ts", import.meta.url));
test("risk 4: a second hub on the same cache fails with a single-owner error; a killed owner leaves no stale lock", async (t) => {
 const s = await store(t, 1);
 const cacheDir = join(s.dir, "cache");
 const child = spawn(process.execPath, [HOLDER, cacheDir], { stdio: ["ignore", "pipe", "inherit"] });
 t.after(() => { child.kill("SIGKILL"); });
 await new Promise<void>((resolve, reject) => {
  child.stdout.on("data", (d) => { if (String(d).includes("held")) resolve(); });
  child.once("exit", (code) => reject(new Error(`holder exited ${code}`)));
 });
 assert.throws(() => s.open(), (e: any) => e.code === "cache_owned" && e.message.includes(`pid ${child.pid}`) && e.message.includes("One hub serves one AMPI home"));
 child.kill("SIGKILL");
 await new Promise((r) => child.once("exit", r));
 const views = s.open();
 await views.track(s.threadId);
 assert.ok(views.threadValue(s.threadId)!.entries.length > 0);
 // In one process too: the open owner refuses a second DurableViews until it closes.
 assert.throws(() => s.open(), (e: any) => e.code === "cache_owned");
 await views.close();
 s.open();
});

test("risk 4: an owner that its caller no longer references keeps the cache until release", async () => {
 const dir = mkdtempSync(join(tmpdir(), "ampi-owner-gc-"));
 try {
  claimCacheDir(dir);
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  gc(); await new Promise((r) => setTimeout(r, 20)); gc();
  assert.throws(() => claimCacheDir(dir), (e: any) => e.code === "cache_owned");
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("risk 5: a copy that lost any file shows rebuilding, then rebuilds exactly from the node", { timeout: 10_000 }, async (t) => {
 const s = await store(t);
 const views = s.open();
 await views.track(s.threadId);
 const exact = JSON.stringify(views.threadValue(s.threadId)!.entries);
 const file = views.context.session(s.threadId)!.copyFile!;
 const damage: Record<string, () => void> = {
  "data deleted": () => rmSync(durableCopyFiles(file).data), "index deleted": () => rmSync(durableCopyFiles(file).index),
  "meta deleted": () => rmSync(durableCopyFiles(file).meta), "data short": () => truncateSync(durableCopyFiles(file).data, 3),
 };
 for (const [name, hurt] of Object.entries(damage)) {
  hurt();
  const errors: unknown[] = [];
  const on = (e: { threadId?: string }) => { if (e.threadId === s.threadId) errors.push(views.threadValue(s.threadId)!.agent.readError); };
  views.on("changed", on);
  await views.sync(s.threadId);
  while (views.threadValue(s.threadId)!.agent.readError !== null || !views.context.session(s.threadId)) { await views.sync(s.threadId); await turn(); }
  views.off("changed", on);
  assert.equal(errors[0], REBUILDING, `${name}: the thread says it is rebuilding first`);
  assert.equal(JSON.stringify(views.threadValue(s.threadId)!.entries), exact, `${name}: the rebuilt history is exact`);
  assert.equal(views.cost(s.threadId)!.entries, views.context.session(s.threadId)!.data.count);
 }
 // A held reader that loses its data file meanwhile rebuilds on its next append.
 const release = views.hold(s.threadId);
 await views.sync(s.threadId);
 rmSync(durableCopyFiles(file).data);
 const errors: unknown[] = [];
 const on = (e: { threadId?: string }) => { if (e.threadId === s.threadId) errors.push(views.threadValue(s.threadId)!.agent.readError); };
 views.on("changed", on);
 await ask(s.root, "after the damage");
 while (!errors.includes(REBUILDING) || views.threadValue(s.threadId)!.agent.readError !== null) await views.sync(s.threadId);
 views.off("changed", on);
 const ids = views.threadValue(s.threadId)!.entries.map((e: any) => e.id);
 assert.ok(ids.length > JSON.parse(exact).length, "the rebuilt copy holds the new turn");
 release();
});

test("risk 6: closing views or untracking during an in-flight open leaves no node handle and no change", async (t) => {
 for (const end of ["close", "untrack"] as const) {
  const s = await store(t, 1);
  const gate = deferred();
  let opening = false;
  const wire = { ...s.node, open: async (args: unknown) => { opening = true; await gate.promise; return s.node.open(args); } };
  const views = s.open(wire);
  const tracked = views.track(s.threadId);
  while (!opening) await turn();
  let changes = 0;
  views.on("changed", () => { changes++; });
  const ending = end === "close" ? views.close() : views.untrack(s.threadId);
  const after = changes;
  gate.resolve();
  await tracked; await ending;
  for (let i = 0; i < 5; i++) await turn();
  assert.equal(s.node.service.stats().handles, 0, `${end}: no node handle survives`);
  assert.equal(changes, after, `${end}: nothing changes after the reader closed`);
 }
});

test("risk 7: an HTTP abort while the node holds a raw export's fence ends the export and closes its handle", async (t) => {
 const home = tempHome(), token = "f".repeat(64);
 const daemon = await runDaemon({ home });
 const hub = new Hub({ hosts: [{ id: "devbox", label: "devbox", kind: "local", home }] }, { token });
 const port = await hub.listen(0);
 const b = await Browser.open(port, undefined, `ampi_k_${port}=${token}`);
 t.after(async () => { b.ws.terminate(); await hub.close(); await daemon.stop(); });
 await b.when(() => b.hosts.some((h: any) => h.id === "devbox" && h.status === "connected"), 5000, "durable host");
 // The hub's own reader never opens, so the only node handle is the export's.
 const link = [...hub.links.values()].find((l) => l.config.id === "devbox" && "views" in l) as any;
 link.views.sync = async () => {};
 const { threadId } = await b.req("devbox", "thread.create", { requestId: "raw", cwd: tempHome(), model: { provider: "ampi-sim", modelId: "sim-1" }, prompt: "Hello", place: { workspace: "new", label: "main" } });
 await b.until<any>(b.sub("devbox", { kind: "threads" }), (v) => v.threads[threadId]?.activity === "idle");
 while (readerStats(daemon.runtime).handles) await turn();

 // The export's handle answers its fence only when the test says so; its watch stop marks the handle closed.
 const fenced = deferred(), answer = deferred(), stopped = deferred();
 const runtime = daemon.runtime as any, thread = runtime.thread.bind(runtime);
 const rawExport = link.rawExport.bind(link);
 let stall = false;
 link.rawExport = (...args: unknown[]) => { stall = true; return rawExport(...args); };
 runtime.thread = async (id: string) => {
  if (!stall) return thread(id);
  stall = false;
  const found = await thread(id);
  const c = found.conversation;
  const conversation = new Proxy(c, { get: (target, key) => {
   if (key === "entries") return (q: any, ...rest: unknown[]) => q.order === "descending" ? (fenced.resolve(), answer.promise.then(() => target.entries(q, ...rest))) : target.entries(q, ...rest);
   if (key === "watch") return async (...args: unknown[]) => { const w = await target.watch(...args); return new Proxy(w, { get: (wt, wk) => wk === "stop" ? async () => { await wt.stop(); stopped.resolve(); } : typeof wt[wk] === "function" ? wt[wk].bind(wt) : wt[wk] }); };
   const v = target[key]; return typeof v === "function" ? v.bind(target) : v;
  } });
  return { ...found, conversation };
 };
 const req = get({ host: "127.0.0.1", port, path: `/raw/pi-durable:${threadId}?host=${encodeURIComponent("devbox#durable")}`, headers: { cookie: `ampi_k_${port}=${token}` } });
 req.on("error", () => {});
 await fenced.promise;
 assert.equal(readerStats(daemon.runtime).handles, 1, "the export holds one node handle");
 req.destroy();
 const bound = new Promise<string>((r) => setTimeout(() => r("hung"), 1000).unref());
 assert.equal(await Promise.race([stopped.promise.then(() => "closed"), bound]), "closed", "the handle closes without the fence answer");
 assert.equal(readerStats(daemon.runtime).handles, 0);
 answer.resolve();
 await turn();
 assert.deepEqual(b.gaps, []);
});
