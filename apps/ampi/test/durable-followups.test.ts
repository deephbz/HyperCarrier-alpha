import "./bound.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { DurableViews } from "../src/durable/reader-side.ts";
import { money } from "../web/src/util.ts";
// @ts-ignore: shared reader is plain ESM.
import { durableSpend, piSpendOfTotal, spendLabel } from "../../trace-analytics/src/sources/spend.mjs";
// @ts-ignore: plain ESM test fixtures over a real pi-durable 1.4.0 store.
import { buildFixture, openFixtureStore } from "../../trace-analytics/test/fixtures/durable-store.mjs";
// @ts-ignore: the real reader service behind a JSON round-trip, as on the wire.
import { serviceNode } from "../../trace-analytics/test/fixtures/durable-node.mjs";

const RAW = (threadId: string) => `http://trace.demo/raw/pi-durable:${threadId}`;

/** The fixture root (with its reset) and one entry past the copy's 64 KiB entry bound. */
async function store(t: any) {
 const dir = mkdtempSync(join(tmpdir(), "ampi-durable-followups-"));
 const { harness, root } = await openFixtureStore(join(dir, "store.sqlite"));
 await buildFixture(harness, root);
 await (await root.submit({ type: "write", entry: { kind: "fixture.blob", data: { blob: "x".repeat(300_000) } } }, context)).wait(context);
 const node = serviceNode(harness);
 const views = new DurableViews({ host: "demo", cacheDir: join(dir, "cache"), node: () => node as never, maxEntryBytes: 64 * 1024, rawExportUrl: RAW });
 t.after(async () => { await views.close(); await harness.close(context); rmSync(dir, { recursive: true, force: true }); });
 const threadId = `tree-a.${root.id}`;
 await views.track(threadId);
 return { root, views, threadId };
}

test("durable follow-ups: a reset is a reset entry, and an oversized stub is a visible placeholder with the raw export", async (t) => {
 const { views, threadId } = await store(t);
 const entries = views.threadValue(threadId)!.entries as any[];

 // (1) pi.reset projects as the node projects it (node/projection.ts), never as a custom 'user' entry.
 const resets = entries.filter((e) => e.kind === "reset");
 assert.equal(resets.length, 1);
 assert.equal(resets[0].handoff, "We were testing the reader. Continue.");
 assert.ok(!entries.some((e) => e.kind === "custom" && e.entryKind === "user"), "no custom 'user' entry");
 const rarebit = views.value({ kind: "view", view: "rarebit", threadId } as never) as any;
 assert.ok(rarebit.items.some((i: any) => i.id === resets[0].id), "the Rarebit view marks the reset as a context restart");

 // (2) The stub names its size and links the raw export, in the preview and in the full entry.
 const stub = entries.find((e) => e.kind === "custom" && e.entryKind === "fixture.blob");
 assert.ok(stub, `a placeholder in ${JSON.stringify(entries.map((e) => e.kind))}`);
 assert.equal(stub.message.label, "not copied");
 assert.match(stub.message.text, /This 29\d KiB `fixture\.blob` entry is too large for the hub copy/);
 assert.equal(stub.rawExport, RAW(threadId));
 assert.doesNotMatch(stub.message.text, /\]\(/, "the trusted link stays out of the markdown text");
 const full = await views.ops["thread.entry"]({ threadId, entry: stub.id } as never) as any;
 assert.deepEqual(JSON.parse(full.text).message, stub.message);
});

test("durable follow-ups: session.cwd follows the node's pi.agent without a new entry", async (t) => {
 const { root, views, threadId } = await store(t);
 // A held thread follows the node's watch; an unheld one syncs only when asked.
 const release = views.hold(threadId);
 await views.sync(threadId);
 const before = views.context.session(threadId)!.data;
 const changed = new Promise<void>((resolve) => {
  const on = (e: { threadId?: string }) => { if (e.threadId === threadId && views.context.session(threadId)!.data.session.cwd === "/demo/next") { views.off("changed", on); resolve(); } };
  views.on("changed", on);
 });
 await root.configure({ cwd: "/demo/next" }, context);
 await changed;
 const after = views.context.session(threadId)!.data;
 assert.equal(after.session.cwd, "/demo/next");
 assert.equal(views.summaryFields(threadId)!.cwd, "/demo/next", "the summary reads the derived Session");
 assert.equal(after.tip, before.tip, "no entry was added");
 assert.notEqual(after.version, before.version, "the Session head is part of the copy version");
 release();
});

test("durable follow-ups: the thread's model and thinking level follow the node's pi.agent after configure, past the last answer's model (failure: l3-round3-input accounts-2)", async (t) => {
 const { root, views, threadId } = await store(t);
 const release = views.hold(threadId);
 await views.sync(threadId);
 // The fixture's answers ran on fixture-sim/sim-1, which the root's pi.agent also names.
 assert.equal((views.threadValue(threadId)!.agent as any).model, "fixture-sim/sim-1");
 const before = views.context.session(threadId)!.data;
 const changed = new Promise<void>((resolve) => {
  const on = (e: { threadId?: string }) => { if (e.threadId === threadId && (views.threadValue(threadId)!.agent as any).model === "other-sim/next" && (views.threadValue(threadId)!.agent as any).thinkingLevel === "high") { views.off("changed", on); resolve(); } };
  views.on("changed", on);
 });
 // configure acks before any answer runs on the new model, so no history entry names it.
 await root.configure({ model: { provider: "other-sim", modelId: "next" }, thinkingLevel: "high" }, context);
 let timer: ReturnType<typeof setTimeout> | undefined;
 try { await Promise.race([changed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`the copy kept ${JSON.stringify(views.threadValue(threadId)!.agent)}`)), 2000); })]); }
 finally { clearTimeout(timer); }
 assert.equal(views.summaryFields(threadId)!.model, "other-sim/next", "the row fallback names the same model");
 assert.equal(views.context.session(threadId)!.data.tip, before.tip, "no entry was added");
 release();
});

test("durable follow-ups: the cost label renders as money() when the spend rule leaves nothing out", () => {
 for (const usd of [0, 0.004, 0.01, 0.25, 12.5, 1234.567]) assert.equal(spendLabel(durableSpend({ models: { m: { cost: { total: usd } } } })), money(usd));
 // A Pi row covers responses and failed runs, so its label names what it leaves out.
 assert.equal(spendLabel(piSpendOfTotal(0.25)), `${money(0.25)} (excludes compaction, tool model calls)`);
 // A row with no reported price reads the same on both backends.
 assert.equal(spendLabel(piSpendOfTotal(null)), spendLabel(durableSpend(undefined)));
});
