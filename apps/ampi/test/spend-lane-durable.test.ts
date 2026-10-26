import "./bound.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { DurableViews } from "../src/durable/reader-side.ts";
import { ALL_COVERS, HISTORY_COVERS, historySpend, spendLabel, sumSpend, summarySpend } from "../src/shared/spend.ts";
import { laneSpend } from "../web/src/views/cos/totals.ts";
// @ts-ignore: plain ESM test fixtures over a real pi-durable 1.4.0 store.
import { buildFixture, openFixtureStore } from "../../trace-analytics/test/fixtures/durable-store.mjs";
// @ts-ignore: the real reader service behind a JSON round-trip, as on the wire.
import { serviceNode } from "../../trace-analytics/test/fixtures/durable-node.mjs";

// A durable Session row reads pi.usage, which counts every request class. A Timeline lane sums history entries,
// which hold no compaction or tool model call cost on either backend, so its label names them (reader-design.md "Cost").
test("spend label: a durable Timeline lane names what its history leaves out; the same thread's Session row is bare", async (t) => {
 const dir = mkdtempSync(join(tmpdir(), "ampi-spend-lane-"));
 const { harness, root } = await openFixtureStore(join(dir, "store.sqlite"));
 await buildFixture(harness, root);
 const node = serviceNode(harness);
 const views = new DurableViews({ host: "demo", cacheDir: join(dir, "cache"), node: () => node as never });
 t.after(async () => { await views.close(); await harness.close(context); rmSync(dir, { recursive: true, force: true }); });
 const threadId = `tree-a.${root.id}`;
 await views.track(threadId);

 const row = views.summaryFields(threadId)!;
 assert.deepEqual(row.spend?.covers, [...ALL_COVERS], "the Session row's figure is pi.usage");
 assert.equal(row.spendLabel, "$0", "a full-coverage figure reads as the bare amount");

 const lane = (views.value({ kind: "view", view: "cos.timeline" } as never) as any).sessions.find((s: any) => s.threadId === threadId);
 assert.ok(lane?.priced, "the fixture's history reports a price");
 const usd = lane.buckets.reduce((n: number, b: number[]) => n + b[2], 0);
 assert.equal(spendLabel(laneSpend([lane], usd)), "$0 (excludes compaction, tool model calls)");
 assert.equal(spendLabel(laneSpend([lane], usd)), spendLabel(historySpend(usd)), "a durable lane reads as a Pi lane with the same amount");
});

// The verifier's totals-4 thread: one assistant entry without usage, so pi.usage records no request.
test("spend label: a durable thread whose pi.usage records no request and whose history has no price reads no price reported", async (t) => {
 const dir = mkdtempSync(join(tmpdir(), "ampi-spend-unpriced-"));
 const { harness, root } = await openFixtureStore(join(dir, "store.sqlite"));
 const message = fauxAssistantMessage("UNPRICED"); delete (message as { usage?: unknown }).usage;
 await root.commit((tx: any) => tx.appendEntry(root.id, { kind: "pi.assistant", model: [message] }), context);
 const node = serviceNode(harness);
 const views = new DurableViews({ host: "demo", cacheDir: join(dir, "cache"), node: () => node as never });
 t.after(async () => { await views.close(); await harness.close(context); rmSync(dir, { recursive: true, force: true }); });
 const threadId = `tree-a.${root.id}`;
 await views.track(threadId);

 const row = views.summaryFields(threadId)!;
 // Session metadata and Info print spendLabel; Overview and Team totals sum `spend`.
 assert.equal(row.spendLabel, "no price reported", "an absent price never reads as a priced $0");
 assert.deepEqual(row.spend, historySpend(null), "the history is the figure, as without the document");
 assert.deepEqual(row.spend?.covers, [...HISTORY_COVERS]);
 assert.equal(spendLabel(sumSpend([summarySpend(row as never)])), "no price reported", "a total of unpriced Sessions has no amount");
});
