import "./bound.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { DurableViews } from "../src/durable/reader-side.ts";
// @ts-ignore: real synthetic durable store fixture.
import { openFixtureStore } from "../../trace-analytics/test/fixtures/durable-store.mjs";
// @ts-ignore: reader service over a JSON wire round-trip.
import { serviceNode } from "../../trace-analytics/test/fixtures/durable-node.mjs";

// The durable Host answers thread.find with the window the ask names (FindAsk), as the Pi Host does: the head, the
// entry `from`, or the branch's end, and `anchored` says whether the scan met the anchor.
test("durable Find keeps the head, middle, tail and unknown-anchor windows of the ask", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ampi-find-window-"));
	const { harness, root } = await openFixtureStore(join(dir, "store.sqlite"));
	const views = new DurableViews({ host: "demo", cacheDir: join(dir, "cache"), node: () => serviceNode(harness) });
	t.after(async () => { await views.close(); await harness.close(context); rmSync(dir, { recursive: true, force: true }); });
	const ids: string[] = [];
	await root.commit(async (tx: any) => {
		for (let i = 0; i < 900; i++) {
			const entry = await tx.appendEntry(root.id, { kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: `windowcheck step ${i}` }], timestamp: Date.now() }] });
			ids.push(String(entry.id));
		}
	}, context);
	const threadId = `tree-a.${root.id}`;
	await views.track(threadId);
	const cases: [string, { from?: string; tail?: boolean }, string, boolean | undefined][] = [
		["head", {}, ids[0]!, undefined],
		["middle", { from: ids[450] }, ids[450]!, true],
		["tail", { tail: true }, ids[899]!, true],
		["unknown", { from: "not-an-entry" }, ids[0]!, false],
	];
	for (const [name, ask, expected, anchored] of cases) {
		const value = await views.ops["thread.find"]({ threadId, query: "windowcheck", ...ask }) as any;
		assert.equal(value.total, 900, name);
		assert.equal(value.anchored, anchored, `${name}: the Host says whether it met the anchor`);
		assert.ok(value.hits.some((hit: any) => hit.entry === expected), `${name}: the window holds the asked place`);
		assert.ok(value.hits.length <= 400, name);
	}
});
