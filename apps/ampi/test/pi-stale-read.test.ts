import "./bound.ts";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Tracing wraps every statement (trace.ts) and reads AMPI_TRACE once, at load: set it before any module that opens a database.
const traceDir = mkdtempSync(join(tmpdir(), "ampi-stale-read-trace-"));
process.env.AMPI_TRACE = traceDir;
const { WorkingSet, workingSetActivity } = await import("../src/pi/working-set.ts");
const { assistant, setup, user, TOKEN } = await import("./pi-host-fixtures.ts");

const idle = async () => {
 const end = Date.now() + 5000;
 while (workingSetActivity().pending && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

test("stale read: with tracing on, a Rarebit page that stops early pins nothing, and a deliberate pin costs exactly one counted reopen (failure: an unreset traced cursor hid new messages)", async (t) => {
 t.after(() => rmSync(traceDir, { recursive: true, force: true }));
 // Capture the hub's working set, so the test can read and pin its read connection.
 const stores: InstanceType<typeof WorkingSet>[] = [], refresh = WorkingSet.prototype.refresh;
 WorkingSet.prototype.refresh = function (...args) { if (!stores.includes(this)) stores.push(this); return refresh.apply(this, args); };
 t.after(() => { WorkingSet.prototype.refresh = refresh; });
 const { f, hub, browser } = await setup(t);
 const health = async () => (await (await fetch(`http://127.0.0.1:${hub.port}/api/health`, { headers: { cookie: `ampi_k_${hub.port}=${TOKEN}` } })).json()).hosts[0].staleReads;
 // A passive checkpoint copies every WAL frame back only when no reader pins an older snapshot: the WAL stays bounded.
 const checkpointed = () => {
  const db = new DatabaseSync(join(f.dir, "cache", "working-set.sqlite"));
  try { const r = db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get()!; return r.checkpointed === r.log; } finally { db.close(); }
 };
 const thread = browser.sub("devbox", { kind: "thread", threadId: "pi:sess-a" });
 await browser.until<any>(thread, (v) => v.entries?.length === 3);
 // More than one Rarebit page: the page query stops its cursor at 400 items.
 let lines = "", parent = "r1";
 for (let i = 0; i < 420; i++) { lines += user(`p${i}`, parent, 10 + i, `prompt ${i}`); parent = `p${i}`; }
 appendFileSync(f.sessionA, lines);
 const rarebit = browser.sub("devbox", { kind: "view", view: "rarebit", threadId: "pi:sess-a" });
 await browser.until<any>(rarebit, (v) => v.items?.length === 400 && v.more, 10_000);
 await idle();
 appendFileSync(f.sessionA, assistant("a2", parent, 500, "incoming after the rarebit page"));
 let after = await browser.until<any>(thread, (v) => JSON.stringify(v.entries ?? []).includes("incoming after the rarebit page"), 5000);
 await idle();
 assert.equal(await health(), undefined, "a normal run reopens nothing");
 assert.ok(checkpointed(), "no reader pins the WAL after a Rarebit page");

 // A deliberate pin: a cursor abandoned after one row keeps its statement active, traced or raw.
 const [store] = stores;
 assert.ok(store, "the hub's working set refreshed");
 const held = store.db.prepare("SELECT id FROM entries").iterate();
 held.next(); // Closing its connection, by the reopen or at teardown, finalizes it.
 appendFileSync(f.sessionA, assistant("a3", "a2", 501, "incoming after the pin"));
 after = await browser.until<any>(thread, (v) => JSON.stringify(v.entries ?? []).includes("incoming after the pin"), 5000);
 await idle();
 assert.deepEqual(await health(), { reopened: 1, behind: 0, refused: 0 }, "one stale read, repaired by one reopen");
 const outline = await browser.req("devbox", "thread.outline", { threadId: "pi:sess-a" });
 assert.equal(outline.version, after.sourceVersion, "the outline reads the published version");
 const found = await browser.req("devbox", "thread.find", { threadId: "pi:sess-a", query: "incoming" });
 assert.ok(found.hits?.length, "Find answers on the published copy: " + JSON.stringify(found));
 assert.ok(found.hits.every((h: any) => h.version === after.sourceVersion), "Find hits carry the published version");
 assert.ok(checkpointed(), "the reopen released the pinned WAL snapshot");
});

test("stale read: a read connection that a reopen cannot fix is a cache fault: one behind count, backed-off refused retries, a Host warning, and the next commit clears it", async (t) => {
 const stores: InstanceType<typeof WorkingSet>[] = [], refresh = WorkingSet.prototype.refresh, reopen = WorkingSet.prototype.reopen;
 WorkingSet.prototype.refresh = function (...args) { if (!stores.includes(this)) stores.push(this); return refresh.apply(this, args); };
 // A reopen that repairs nothing: the self-check after it must report a fault, and publication must not spin or crash.
 WorkingSet.prototype.reopen = () => {};
 t.after(() => { WorkingSet.prototype.refresh = refresh; WorkingSet.prototype.reopen = reopen; });
 const { f, hub, browser } = await setup(t);
 const host = async () => (await (await fetch(`http://127.0.0.1:${hub.port}/api/health`, { headers: { cookie: `ampi_k_${hub.port}=${TOKEN}` } })).json()).hosts[0];
 const thread = browser.sub("devbox", { kind: "thread", threadId: "pi:sess-a" }), threads = browser.sub("devbox", { kind: "threads" });
 await browser.until<any>(thread, (v) => v.entries?.length === 3);
 await idle();
 const [store] = stores;
 const held = store!.db.prepare("SELECT id FROM entries").iterate();
 held.next();
 appendFileSync(f.sessionA, assistant("a2", "r1", 4, "incoming behind the pin"));
 // The refused page read keeps the thread's last value; the Session row and the Host carry the fault.
 const row = await browser.until<any>(threads, (v) => /Cache read behind/.test(v.threads?.["pi:sess-a"]?.lastError ?? ""), 5000);
 assert.ok(row);
 assert.equal(JSON.stringify((browser.values.get(thread) as any)?.entries ?? []).includes("incoming behind the pin"), false, "the refused read keeps the last published entries");
 const first = await host();
 assert.equal(first.staleReads.behind, 1, "the self-check after the reopen reports once: " + JSON.stringify(first.staleReads));
 assert.match(first.cacheFault ?? "", /1 Session copy reads behind the derive Worker/, "the Host shows the cache fault");
 // Retries back off from 250 ms: about log2(window / 250 ms) of them in the window, not one per publish.
 await new Promise((r) => setTimeout(r, 2000));
 const later = (await host()).staleReads;
 assert.ok(later.refused >= 2 && later.refused <= 6, "refused retries are bounded by the backoff: " + JSON.stringify(later));
 assert.equal(later.behind, 1, "no reopen without a commit");
 // The next commit checks again; the pin is gone, so the check is clean and the fault clears.
 held.return?.();
 appendFileSync(f.sessionA, assistant("a3", "a2", 5, "incoming after the fault"));
 const after = await browser.until<any>(thread, (v) => JSON.stringify(v.entries ?? []).includes("incoming after the fault"), 5000);
 assert.equal(after.agent.readError, null, "a clean check clears the copy's cache fault");
 await browser.until<any>(threads, (v) => v.threads?.["pi:sess-a"] && !v.threads["pi:sess-a"].lastError, 5000);
 assert.ok(JSON.stringify(after.entries).includes("incoming behind the pin"));
 const cleared = await host();
 assert.equal(cleared.cacheFault, undefined, "the Host warning clears with the last faulted copy");
 assert.equal(cleared.staleReads.behind, 1);
});
