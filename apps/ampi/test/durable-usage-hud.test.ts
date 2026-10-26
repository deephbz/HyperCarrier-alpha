import "./bound.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { UsageDoc } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { DurableViews } from "../src/durable/reader-side.ts";
import { hudView } from "../web/src/hud.ts";
// @ts-ignore: plain ESM test fixtures over a real pi-durable 1.4.0 store.
import { openFixtureStore } from "../../trace-analytics/test/fixtures/durable-store.mjs";
// @ts-ignore: the real reader service behind a JSON round-trip, as on the wire.
import { serviceNode } from "../../trace-analytics/test/fixtures/durable-node.mjs";

const MODEL = "magpie/claude/claude-opus-5-5";
// The live cutover thread's two replies (verifier, dd10ed62): the first writes the cache, the second reads it.
const REPLIES = [
	{ input: 3, output: 40, cacheRead: 0, cacheWrite: 16155, cacheWrite1h: 15748, totalTokens: 16198, cost: { input: 0, output: 0.001, cacheRead: 0, cacheWrite: 0.12, total: 0.121 } },
	{ input: 3, output: 52, cacheRead: 15796, cacheWrite: 441, totalTokens: 16292, cost: { input: 0, output: 0.0013, cacheRead: 0.0016, cacheWrite: 0.0029, total: 0.0058 } },
];

// The durable Info panel lists the node's pi.usage by model, and the Composer HUD shows CH%, as a Pi Session does
// (failure: live cutover thread showed "No model calls yet" and no HUD trigger).
test("durable usage: the thread topic carries pi.usage by model with cache counters, and the summary carries CH%", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ampi-durable-usage-"));
	const { harness, root } = await openFixtureStore(join(dir, "store.sqlite"));
	for (const usage of REPLIES) {
		const message = { ...fauxAssistantMessage("Done."), provider: "magpie", model: "claude/claude-opus-5-5", usage };
		await root.commit(async (tx: any) => {
			await tx.appendEntry(root.id, { kind: "pi.assistant", model: [message] });
			const totals = (await tx.doc(UsageDoc, root.id)).models;
			const total = totals[MODEL];
			if (!total) totals[MODEL] = structuredClone(usage);
			else for (const k of ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "totalTokens"] as const) total[k] = (total[k] ?? 0) + (usage[k as keyof typeof usage] as number ?? 0);
			if (total) total.cost.total += usage.cost.total;
		}, context);
	}
	const node = serviceNode(harness);
	const views = new DurableViews({ host: "demo", cacheDir: join(dir, "cache"), node: () => node as never });
	t.after(async () => { await views.close(); await harness.close(context); rmSync(dir, { recursive: true, force: true }); });
	const threadId = `tree-a.${root.id}`;
	await views.track(threadId);

	const usage = views.threadValue(threadId)!.usage as any;
	assert.deepEqual(Object.keys(usage.models ?? {}), [MODEL], "Info lists the thread's model");
	assert.equal(usage.models[MODEL].cacheRead, 15796);
	assert.equal(usage.models[MODEL].cacheWrite, 16155 + 441);
	assert.equal(usage.models[MODEL].cacheWrite1h, 15748);
	assert.equal(usage.costUsd, views.summaryFields(threadId)!.costUsd, "the topic's cost stays the summary's spend");

	const row = views.summaryFields(threadId)!;
	assert.equal(Math.floor(row.cacheHit!), Math.floor(100 * 15796 / (3 + 15796 + 441)), "CH% is the last reply's prompt share read from cache");
	const hud = hudView({ id: threadId, title: "t", createdAt: 0, updatedAt: 0, kind: "thread", activity: "idle", queued: 0, ...row } as never);
	assert.match(hud.lines[1]!.map((s) => s.text).join(""), / CH97%$/);
});

const web = fileURLToPath(new URL("../web/", import.meta.url));
let vite: ViteDevServer;
let controls: (props: object) => unknown;
before(async () => {
	// client.ts opens its hub WebSocket at import; this stub never connects.
	Object.assign(globalThis, { location: { protocol: "http:", host: "127.0.0.1:1", hash: "" }, WebSocket: class { send() {} close() {} }, window: globalThis, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } });
	vite = await createServer({ configFile: `${web}vite.config.ts`, root: web, logLevel: "silent", server: { middlewareMode: true, hmr: false } });
	controls = (await vite.ssrLoadModule("/src/components/Composer.tsx")).ModelControls;
});
after(async () => { await vite?.close(); });

test("durable usage: the durable Composer offers the Session HUD beside its pickers; a Pi Session keeps its model label", () => {
	const summary = { id: "tree-a.7", title: "t", createdAt: 0, updatedAt: 0, kind: "thread", activity: "idle", queued: 0, costUsd: 0.13, model: MODEL, cacheHit: 97.3 };
	const html = (pi: boolean) => renderToStaticMarkup(createElement(controls as never, { host: "devbox#durable", threadId: "tree-a.7", summary, models: [], model: MODEL, closed: false, pi }));
	const durable = html(false);
	assert.match(durable, /title="Model"/, "the model picker stays");
	assert.match(durable, /class="model-hud-trigger hint"[^>]*>HUD</, "the HUD trigger shows on a durable thread");
	assert.match(html(true), /class="model-hud-trigger hint"[^>]*>magpie\/claude\/claude-opus-5-5</, "a Pi Session's trigger is its model");
	assert.doesNotMatch(html(true), /title="Model"/);
});
