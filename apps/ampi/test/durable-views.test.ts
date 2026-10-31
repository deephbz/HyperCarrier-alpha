import "./bound.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { DurableViews } from "../src/durable/reader-side.ts";
// @ts-ignore: plain ESM test fixtures over a real pi-durable 1.4.0 store.
import { ask, buildFixture, buildTeam, openFixtureStore } from "../../trace-analytics/test/fixtures/durable-store.mjs";
// @ts-ignore: the real reader service behind a JSON round-trip, as on the wire.
import { serviceNode } from "../../trace-analytics/test/fixtures/durable-node.mjs";

const HOST = "demo";
const GOLDEN = new URL("./fixtures/durable-views-golden.json", import.meta.url);

/** The synthetic store: a root with tool use, custom entries, a compaction and a reset; a fork; an oversized entry; a Team Worker. */
async function synthetic(t: any) {
 const dir = mkdtempSync(join(tmpdir(), "ampi-durable-views-"));
 const { harness, root } = await openFixtureStore(join(dir, "store.sqlite"));
 const { fork } = await buildFixture(harness, root);
 const blob = await root.submit({ type: "write", entry: { kind: "fixture.blob", data: { blob: "x".repeat(300_000) } } }, context);
 await blob.wait(context);
 const worker = await buildTeam(harness, root);
 const node = serviceNode(harness);
 // Hooks run in order: every DurableViews closes (and its derive jobs end) before the store and directory go.
 const views: DurableViews[] = [];
 t.after(async () => {
  for (const v of views) await v.close();
  await node.harness.close(context); rmSync(dir, { recursive: true, force: true });
 });
 const key = (c: { id: number }) => `tree-a.${c.id}`;
 const open = (extra: Partial<ConstructorParameters<typeof DurableViews>[0]> = {}) => { const v = new DurableViews({ host: HOST, cacheDir: join(dir, "cache"), node: () => node as never, maxEntryBytes: 64 * 1024, ...extra }); views.push(v); return v; };
 return { dir, harness, node, root, fork, worker, open, threads: { root: key(root), fork: key(fork), worker: key(worker) } };
}
const changed = (views: DurableViews, threadId: string) => new Promise<void>((resolve) => {
 const on = (e: { threadId?: string }) => { if (e.threadId === threadId) { views.off("changed", on); resolve(); } };
 views.on("changed", on);
});

test("an old Summary row remains stored but does not enter the Rarebit panel or Arc evidence", async t => {
 const s = await synthetic(t);
 const views = s.open();
 await views.track(s.threads.root);
 const before = views.value({ kind: "view", view: "rarebit", threadId: s.threads.root } as never) as any;
 const entry = await s.root.commit((tx: any) => tx.appendEntry(s.root.id, { kind: "rarebit.summary", data: { summary: "LEGACY_SUMMARY_ONLY", sessionStatus: "needs_attention" } }), context);
 await views.sync(s.threads.root);
 const after = views.value({ kind: "view", view: "rarebit", threadId: s.threads.root } as never) as any;
 assert.equal(after.error, undefined);
 assert.deepEqual(after.items, before.items);
 assert.doesNotMatch(JSON.stringify(after), /LEGACY_SUMMARY_ONLY/);
 assert.doesNotMatch(JSON.stringify(views.context.session(s.threads.root)!.data.arc), /LEGACY_SUMMARY_ONLY/);
 const history = await s.root.entries({}, 20, undefined, context);
 assert.ok(history.items.some((item: any) => item.id === entry.id && item.data.summary === "LEGACY_SUMMARY_ONLY"));
});

test("durable views: thread value, summary, Find, search, history, entry, Rarebit, Arc, Team over a real store", async (t) => {
 const s = await synthetic(t);
 const views = s.open();
 globalThis.gc?.();
 const heap = process.memoryUsage().heapUsed;
 for (const id of Object.values(s.threads)) await views.track(id);
 globalThis.gc?.();
 // The L4/D21 budget input: copy disk bytes per thread, and hub heap held for all three.
 t.diagnostic(JSON.stringify({ heapDeltaBytes: process.memoryUsage().heapUsed - heap, gc: Boolean(globalThis.gc),
  threads: Object.fromEntries(Object.entries(s.threads).map(([k, id]) => [k, views.cost(id)])) }));

 // The thread topic's reader part has PiThreadView's shape (L1 Session frame deltas).
 const value = views.threadValue(s.threads.root)!;
 assert.deepEqual(Object.keys(value).sort(), ["agent", "conversationId", "entries", "hiddenBefore", "sourceVersion", "usage"]);
 assert.equal(value.agent.model, "fixture-sim/sim-1", "agent.model is the provider-qualified string");
 assert.equal(typeof value.agent.asOf, "number");
 assert.equal(value.agent.readError, null);
 assert.match(value.sourceVersion!, /pi-durable:demo:tree-a\./);
 // Info lists pi.usage by model, as the node's projection sent it; cost follows the spend rule.
 assert.deepEqual(Object.keys(value.usage), ["models", "costUsd"]);
 assert.deepEqual(Object.keys(value.usage.models!), ["fixture-sim/sim-1"]);
 assert.ok(value.entries.length > 5);
 assert.ok(!value.entries.some((e: any) => e.role === "system" || e.kind === "system"), "no system entry in entries");
 assert.ok(value.entries.every((e: any) => "bodyAvailable" in e || e.kind !== "tool"), "tool entries say whether a body is available");

 const fields = views.summaryFields(s.threads.root)!;
 assert.equal(typeof fields.spendLabel, "string");
 assert.equal(fields.ref, `${HOST}/pi-durable:${s.threads.root}`);
 assert.equal(fields.model, "fixture-sim/sim-1");

 // Find in one thread and search across threads cite by Host plus durable source.
 const found = await views.ops["thread.find"]({ threadId: s.threads.fork, query: "fork question" } as never) as any;
 assert.ok(found.hits.length >= 1);
 assert.equal(found.hits[0].threadId, s.threads.fork);
 assert.match(found.hits[0].ref, new RegExp(`^${HOST}/pi-durable:${s.threads.fork.replace(".", "\\.")}#`));
 const searched = await views.ops["sessions.search"]({ query: "report the build" } as never) as any;
 assert.ok(searched.hits.some((h: any) => h.threadId === s.threads.worker), JSON.stringify(searched.hits));
 // An untitled Session's hit title falls back to the hub thread ID, as a Pi hit's does; Host status comes from the Host.
 for (const hit of searched.hits) assert.equal(hit.title, hit.threadId, JSON.stringify(hit));
 assert.equal(searched.hostStatus, undefined, "no Host status without a Host");

 // History pages and full entries come from the copy; the oversized entry stays a stub.
 const history = await views.ops["thread.history"]({ threadId: s.threads.root, limit: 3 } as never) as any;
 assert.equal(history.entries.length, 3);
 const entry = await views.ops["thread.entry"]({ threadId: s.threads.root, entry: history.entries.at(-1).id } as never) as any;
 assert.equal(JSON.parse(entry.text).id, history.entries.at(-1).id);
 assert.ok(views.cost(s.threads.root)!.copyBytes < 64 * 1024, "the oversized record is not copied whole");

 // Rarebit and Arc read the working set; a fork's inherited span is excluded from its Arc evidence.
 const rarebit = views.value({ kind: "view", view: "rarebit", threadId: s.threads.root } as never) as any;
 assert.ok(!rarebit.error, JSON.stringify(rarebit.error));
 const forkData = views.context.session(s.threads.fork)!.data;
 assert.ok(forkData.arc.excludedEntries > 0, "inherited entries are excluded");

 // Team: ownership names the lead and its Worker until the node serves a Team frame.
 const team = views.value({ kind: "view", view: "team", threadId: s.threads.worker } as never) as any;
 assert.equal(team.teams.length, 1);
 assert.deepEqual(team.teams[0].members.map((m: any) => [m.role, m.threadId]).sort(), [["lead", s.threads.root], ["worker", s.threads.worker]]);
 assert.equal(views.summaryFields(s.threads.worker)!.team?.role, "worker");

 // An append reaches a held copy incrementally through the watch.
 const release = views.hold(s.threads.root);
 await views.sync(s.threads.root);
 const before = views.threadValue(s.threads.root)!.entries.length, grew = changed(views, s.threads.root);
 await ask(s.root, "one more question");
 await grew; await views.sync(s.threads.root);
 assert.ok(views.threadValue(s.threads.root)!.entries.length > before);
 release();
});

test("durable views: a restart reuses the copy, and a deleted copy rebuilds from the node", async (t) => {
 const s = await synthetic(t);
 let views = s.open();
 await views.track(s.threads.root);
 const first = views.threadValue(s.threads.root)!;
 await views.close();
 const served = s.node.served;
 views = s.open();
 await views.track(s.threads.root);
 assert.deepEqual(views.threadValue(s.threads.root)!.entries, first.entries);
 assert.ok(s.node.served - served <= 2, `a restart read ${s.node.served - served} records again`);
 await views.forget(s.threads.root);
 await views.track(s.threads.root);
 assert.deepEqual(views.threadValue(s.threads.root)!.entries.map((e: any) => e.id), first.entries.map((e: any) => e.id));
});

test("durable Find answers Indexing until the copy is read, and again while a lost copy rebuilds", async (t) => {
 const s = await synthetic(t);
 let views = s.open();
 const find = () => views.ops["thread.find"]({ threadId: s.threads.root, query: "check the build" } as never) as Promise<any>;
 await assert.rejects(find(), { code: "not_found" }, "an untracked thread is unknown, not indexing");
 let tracking = views.track(s.threads.root);
 assert.deepEqual(await find(), { indexing: true });
 assert.equal(views.threadValue(s.threads.root)!.sourceVersion, undefined, "no frame announces an index yet");
 await tracking;
 assert.ok(views.threadValue(s.threads.root)!.sourceVersion, "the next frame announces the index");
 assert.ok((await find()).hits.length >= 1);

 // A restart without the copy's meta keeps the derived head but must rebuild the copy.
 await views.close();
 for (const f of readdirSync(join(s.dir, "cache"))) if (f.endsWith(".meta.json")) rmSync(join(s.dir, "cache", f));
 views = s.open();
 tracking = views.track(s.threads.root);
 assert.deepEqual(await find(), { indexing: true });
 await tracking;
 assert.ok((await find()).hits.length >= 1);
});

/** Times, IDs and versions vary per run; the golden keeps structure and text. */
function normalized(views: DurableViews, threads: Record<string, string>) {
 const ids = new Map<string, string>();
 const name = (id: string) => { if (!ids.has(id)) ids.set(id, `#${ids.size}`); return ids.get(id)!; };
 const scrub = (x: unknown): unknown => {
  if (Array.isArray(x)) return x.map(scrub);
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k,
   /^(t|ts|at|asOf|started|updated|createdAt|updatedAt|start|end|ms|time)$/.test(k) && typeof v === "number" ? "<t>" :
   /^(id|parent|entry|tip|callId)$/.test(k) && typeof v === "string" ? name(v) :
   /version|Version|ref|fingerprint/.test(k) && typeof v === "string" ? "<v>" : scrub(v)]));
  return x;
 };
 return Object.fromEntries(Object.entries(threads).map(([label, id]) => {
  const session = views.context.session(id)!;
  const { timeline, rarebit, arc, version, bytes, asOf, session: _, ...summary } = session.data;
  return [label, scrub({ thread: views.threadValue(id), summary: { ...summary, ...views.summaryFields(id) },
   rarebit: rarebit.stats, arc: { chunks: arc.chunks.length, excludedEntries: arc.excludedEntries }, marks: timeline.marks.map((m) => m[2]) })];
 }));
}

test("durable views golden: the synthetic store's views stay identical", async (t) => {
 const s = await synthetic(t);
 const views = s.open();
 for (const id of Object.values(s.threads)) await views.track(id);
 const actual = normalized(views, s.threads);
 if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, JSON.stringify(actual, null, 1) + "\n");
 assert.deepEqual(actual, JSON.parse(readFileSync(GOLDEN, "utf8")));
});

test("durable views: fleet search reports the Host's status when the Host supplies it", async (t) => {
 const s = await synthetic(t);
 let status: "connected" | "disconnected" = "connected";
 const views = s.open({ hostStatus: () => status });
 await views.track(s.threads.worker);
 const search = () => views.ops["sessions.search"]({ query: "report the build" } as never) as Promise<any>;
 assert.equal((await search()).hostStatus, "connected");
 status = "disconnected";
 assert.equal((await search()).hostStatus, "disconnected", "read at each search");
});

test("durable views: a delivered interrupt Alert reads as a Team notice from its entry data, in the thread value and the full entry", async (t) => {
 const s = await synthetic(t);
 const data = { source: "team", deliveryId: "k1", epoch: "e1", delivery: "alert", sender: "reviewer", interrupt: true };
 const content = JSON.stringify({ kind: "alert", alert: { from: "reviewer", text: "Stop the gate run" }, interruption: { outcome: "interrupted", message: "The captured run was interrupted." } });
 await ask(s.worker, content, { whenBusy: "steer", requestId: "ptb:k1", entry: { kind: "team.notice", data } });
 const views = s.open();
 await views.track(s.threads.worker);
 const notice = views.threadValue(s.threads.worker)!.entries.find((e: any) => e.entryKind === "team.notice") as any;
 const expected = { kind: "alert", label: "alert · interrupt", sender: "reviewer", text: "Stop the gate run" };
 assert.deepEqual([notice?.kind, notice?.message], ["custom", expected], "the transcript preview names the origin from entry data");
 const full = await views.ops["thread.entry"]({ threadId: s.threads.worker, entry: notice.id } as never) as any;
 assert.deepEqual(JSON.parse(full.text).message, expected, "the full entry read keeps the same origin");
 assert.doesNotMatch(JSON.stringify(notice) + full.text, /interrupted|captured run/, "the interruption outcome stays model-facing");
});
