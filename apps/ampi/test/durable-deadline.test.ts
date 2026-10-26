import "./bound.ts";
// A node that stays connected but never answers a reader request: the request fails with code `timeout` after
// READER_CALL_DEADLINE_MS, the reader closes its handle, and the thread shows one error (reader-design.md, "Hub copy").
// The deadline runs on a fake clock; a controllable stall on the node holds open, fence or page.
import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import { test } from "node:test";
import { DurableHost, READER_CALL_DEADLINE_MS, type Deadline } from "../src/hub/durable-host.ts";
import { runDaemon } from "../src/node/daemon.ts";
import { ops, readerStats } from "../src/node/server.ts";
import { tempHome } from "./helpers.ts";

const turn = () => new Promise((r) => setImmediate(r));
// The bound is wall time: a turn budget ran out before the node's SQLite and IPC work on a hosted Linux runner.
const until = async (ok: () => boolean, what: string) => { const end = Date.now() + 10_000; while (Date.now() < end) { if (ok()) return; await turn(); } assert.fail(`never: ${what}`); };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
type Stall = "open" | "fence" | "page";

async function setup(t: any) {
 const home = tempHome();
 const daemon = await runDaemon({ home });
 // The fake clock: deadlines wait here until the test expires them.
 const pending = new Set<{ ms: number; expire(): void }>();
 const deadline: Deadline = (ms, expire) => { const d = { ms, expire }; pending.add(d); return () => { pending.delete(d); }; };
 const expire = () => { for (const d of [...pending]) { pending.delete(d); assert.equal(d.ms, READER_CALL_DEADLINE_MS); d.expire(); } };
 const host = new DurableHost({ id: "devbox", label: "devbox", kind: "local", home }, { deadline });
 t.after(async () => { await host.stop(); await daemon.stop(); });
 host.start();
 await until(() => host.state.status === "connected", "connected");
 const { threadId } = await ops.get("thread.create")!({ requestId: "dl", cwd: tempHome(), model: { provider: "ampi-sim", modelId: "sim-1" }, prompt: "Hello", place: { workspace: "new", label: "main" } }, daemon.runtime) as { threadId: string };
 await until(() => Boolean(host.views.threadValue(threadId)?.entries.some((e: any) => e.kind === "assistant")), "first sync");
 const stats = () => readerStats(daemon.runtime);
 await until(() => stats().handles === 0, "unheld sync closed");

 // Every conversation the node resolves from here on can hold one request until the test lets it go.
 let stall: Stall | undefined;
 const entered = deferred(), answer = deferred();
 const hold = <T>(kind: Stall, go: () => Promise<T>): Promise<T> => {
  if (stall !== kind) return go();
  stall = undefined; entered.resolve();
  return answer.promise.then(go);
 };
 const runtime = daemon.runtime as any, thread = runtime.thread.bind(runtime);
 runtime.thread = (id: string) => hold("open", async () => {
  const found = await thread(id), c = found.conversation;
  const conversation = new Proxy(c, { get: (target, key) => {
   if (key === "entries") return (q: any, ...rest: unknown[]) => hold(q.order === "descending" ? "fence" : "page", () => target.entries(q, ...rest));
   const v = target[key]; return typeof v === "function" ? v.bind(target) : v;
  } });
  return { ...found, conversation };
 });
 const errors: unknown[] = [];
 host.views.on("changed", (e: { threadId?: string }) => { if (e.threadId === threadId) errors.push(host.views.threadValue(threadId)!.agent.readError); });
 const arm = (kind: Stall) => { stall = kind; };
 return { host, threadId, stats, expire, arm, runtime, entered: entered.promise, answer: answer.resolve, errors, pending };
}

for (const kind of ["open", "fence"] as const) {
 test(`a stalled ${kind} of an unheld sync times out, leaves no handle and one error, and ignores the late answer`, async (t) => {
  const s = await setup(t);
  const opened = s.stats().opened;
  s.arm(kind);
  const sync = s.host.views.sync(s.threadId);
  await s.entered;
  assert.ok(s.pending.size > 0, "the stalled request has a deadline");
  s.expire();
  await sync;
  const op = kind === "open" ? "reader.open" : "reader.fence";
  assert.match(String(s.host.views.threadValue(s.threadId)!.agent.readError), new RegExp(`did not answer ${op} within ${READER_CALL_DEADLINE_MS / 1000} s`));
  assert.equal(s.errors.filter((e) => e !== null).length, 1, "one visible error");
  await until(() => s.stats().handles === 0, "the handle closed");
  // The late answer: an open still names a handle, which the hub closes; the thread keeps its one error.
  s.answer();
  await until(() => s.stats().opened === opened + 1 && s.stats().handles === 0, "late answer settled");
  for (let i = 0; i < 20; i++) await turn();
  assert.equal(s.stats().handles, 0);
  assert.equal(s.errors.filter((e) => e !== null).length, 1);
  assert.match(String(s.host.views.threadValue(s.threadId)!.agent.readError), /did not answer/);
  // The next node change retries and clears the error.
  await s.host.views.sync(s.threadId);
  assert.equal(s.host.views.threadValue(s.threadId)!.agent.readError, null);
  await until(() => s.stats().handles === 0, "the retry closed its handle");
 });
}

test("a stalled page of a held sync times out, closes the held handle, and does not retry until the next change", async (t) => {
 const s = await setup(t);
 // A new reader reads a page from its checkpoint to verify the boundary, so the held sync reaches a page.
 s.arm("page");
 const release = s.host.views.hold(s.threadId);
 t.after(release);
 await s.entered;
 assert.equal(s.stats().handles, 1, "the held reader holds its handle");
 const opened = s.stats().opened;
 s.expire();
 await until(() => s.host.views.threadValue(s.threadId)!.agent.readError !== null, "the error shows");
 assert.match(String(s.host.views.threadValue(s.threadId)!.agent.readError), /did not answer reader.entries/);
 await until(() => s.stats().handles === 0, "the held handle closed");
 s.answer();
 for (let i = 0; i < 50; i++) await turn();
 assert.equal(s.stats().opened, opened, "no retry before the next change");
 assert.equal(s.pending.size, 0, "no request waits on the node");
 assert.equal(s.errors.filter((e) => e !== null).length, 1, "one visible error");
 // The next change retries: the held thread reopens its handle and clears the error.
 await s.host.views.sync(s.threadId);
 assert.equal(s.host.views.threadValue(s.threadId)!.agent.readError, null);
 assert.equal(s.stats().handles, 1);
});

// Above the 256 IDs the link once remembered: a late open closes its handle however many came before it.
const MANY = 300;
test("many expired opens, released on the same connection, return node handles and exports to baseline", { timeout: 10_000 }, async (t) => {
 const s = await setup(t);
 const base = s.stats();
 // Every open waits at one gate; each sync leaves one expired open on the link.
 const gate = deferred(), thread = s.runtime.thread;
 let waiting = 0;
 s.runtime.thread = async (id: string) => { waiting++; await gate.promise; return thread(id); };
 for (let i = 0; i < MANY; i++) {
  const sync = s.host.views.sync(s.threadId);
  await until(() => s.pending.size > 0 && waiting === i + 1, "the open waits on the node");
  s.expire();
  await sync;
 }
 assert.equal(s.host.state.status, "connected");
 gate.resolve();
 await until(() => s.stats().opened === base.opened + MANY && s.stats().handles === base.handles, "every late open closed");
 assert.equal(s.stats().exports, base.exports);
 assert.equal(s.stats().closed, base.closed + MANY);
 assert.equal(s.host.state.status, "connected", "the same connection");
});

/** A raw export into a response that only records: enough of ServerResponse for responseWriter. */
const response = () => Object.assign(new EventEmitter(), { destroyed: false, writableFinished: false, headersSent: false,
 write: () => true, writeHead(this: any) { this.headersSent = true; return this; }, end() {}, destroy() {} });

test("an aborted request clears its deadline; a timed-out request removes its abort listener", async (t) => {
 const s = await setup(t);
 // Abort: the client closes during the stalled fence; the fence's deadline goes with the call.
 s.arm("fence");
 const res = response();
 const exporting = s.host.rawExport(s.threadId, res as never);
 await s.entered;
 assert.equal(s.pending.size, 1, "the fence waits with a deadline");
 res.emit("close");
 await exporting;
 // Only the export's own close waits on the node now, and it answers: no deadline stays behind.
 await until(() => s.pending.size === 0, "the abort cleared the fence's deadline");
 s.answer();
 await until(() => s.stats().handles === 0, "the export's handle closed");

 // Timeout: the fence expires; the export's signal keeps no listener of the dropped call.
 const signals: AbortSignal[] = [];
 const add = AbortSignal.prototype.addEventListener;
 AbortSignal.prototype.addEventListener = function (this: AbortSignal, ...args: any[]) { if (!signals.includes(this)) signals.push(this); return (add as any).apply(this, args); } as never;
 t.after(() => { AbortSignal.prototype.addEventListener = add; });
 const gate = deferred(), fenced = deferred(), entries = s.runtime.thread;
 s.runtime.thread = async (id: string) => {
  const found = await entries(id);
  return { ...found, conversation: new Proxy(found.conversation, { get: (c, k) => k === "entries" ? (q: any, ...r: unknown[]) => q.order === "descending" ? (fenced.resolve(), gate.promise).then(() => c.entries(q, ...r)) : c.entries(q, ...r) : typeof c[k] === "function" ? c[k].bind(c) : c[k] }) };
 };
 const second = s.host.rawExport(s.threadId, response() as never);
 await fenced.promise;
 assert.equal(s.pending.size, 1, "only the fence waits");
 s.expire();
 await second;
 AbortSignal.prototype.addEventListener = add;
 assert.ok(signals.length > 0);
 for (const signal of signals) assert.equal(getEventListeners(signal, "abort").length, 0, "no abort listener outlives its call");
 gate.resolve();
 await until(() => s.stats().handles === 0, "the second export's handle closed");
});
