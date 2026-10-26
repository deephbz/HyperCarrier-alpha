import "./bound.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { DurableViews } from "../src/durable/reader-side.ts";
// @ts-ignore: plain ESM test fixtures over a real pi-durable 1.4.0 store.
import { buildFixture, openFixtureStore } from "../../trace-analytics/test/fixtures/durable-store.mjs";
// @ts-ignore: the real reader service behind a JSON round-trip, as on the wire.
import { serviceNode } from "../../trace-analytics/test/fixtures/durable-node.mjs";

async function setup(t: any) {
	const dir = mkdtempSync(join(tmpdir(), "ampi-durable-hold-"));
	const { harness, root } = await openFixtureStore(join(dir, "store.sqlite"));
	await buildFixture(harness, root);
	const node = serviceNode(harness);
	const views = new DurableViews({ host: "demo", cacheDir: join(dir, "cache"), node: () => node as never });
	t.after(async () => { await views.close(); await harness.close(context); rmSync(dir, { recursive: true, force: true }); });
	const handles = () => node.service.stats().handles as number;
	/** Handles close one microtask after the reader lets them go; wait for the count, bounded. */
	const settle = async (want: number) => {
		for (const deadline = Date.now() + 3000; handles() !== want && Date.now() < deadline; ) await new Promise((r) => setTimeout(r, 10));
		assert.equal(handles(), want);
	};
	return { node, views, threadId: `tree-a.${root.id}`, root, handles, settle };
}

test("durable hold: an unheld sync closes its handle; holds are counted leases; the last release closes the watch", async (t) => {
	const { views, threadId, settle } = await setup(t);
	await views.track(threadId);
	assert.ok(views.threadValue(threadId)!.entries.length > 0, "the first sync derived the copy");
	await settle(0);

	const a = views.hold(threadId), b = views.hold(threadId);
	await views.sync(threadId);
	await settle(1);
	a();
	a(); // a lease releases once
	await views.sync(threadId);
	await settle(1);
	b();
	await settle(0);
});

test("durable hold: a refresh that fails after open leaves no open handle", async (t) => {
	const { node, views, threadId, settle } = await setup(t);
	const fence = node.fence;
	node.fence = async () => { throw Object.assign(new Error("fence failed"), { code: "unavailable" }); };
	await views.track(threadId);
	assert.match(String(views.threadValue(threadId)!.agent.readError), /fence failed/);
	assert.ok(node.calls.includes("open"), "the handle was opened before the failure");
	await settle(0);
	node.fence = fence;
	await views.sync(threadId);
	assert.equal(views.threadValue(threadId)!.agent.readError, null);
	await settle(0);
});

test("durable hold: syncs asked during an unheld sync coalesce into one more, never in parallel", async (t) => {
	const { node, views, threadId, handles, settle } = await setup(t);
	await views.track(threadId);
	await settle(0);
	const open = node.open;
	let opens = 0, overlap = 0;
	node.open = async (args: unknown) => { opens++; if (handles() > 0) overlap++; return open(args); };
	const first = views.sync(threadId);
	views.sync(threadId); views.sync(threadId); views.sync(threadId);
	await first;
	for (const deadline = Date.now() + 3000; (opens < 2 || handles() > 0) && Date.now() < deadline; ) await new Promise((r) => setTimeout(r, 10));
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(opens, 2, "one trailing sync for the three requests");
	assert.equal(overlap, 0, "no sync opened while another held a handle");
	await settle(0);
});
