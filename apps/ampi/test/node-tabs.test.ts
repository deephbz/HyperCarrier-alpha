import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TaskId } from "@earendil-works/pi-durable";
import { runDaemon } from "../src/node/daemon.ts";
import { parseThreadKey } from "../src/node/runtime.ts";
import { keyBetween } from "../src/node/tabs.ts";
import { TestClient, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };
const panes = (v: any, tab: string) => v.layout?.workspaces.find((w: any) => w.id === tab)?.tabs[0].panes ?? [];

test("tabs: fractional keys sort between their bounds", () => {
	let low = "a0", high: string | undefined;
	for (let i = 0; i < 60; i++) {
		const key = keyBetween(low, high);
		assert.ok(key > low && (high === undefined || key < high), `${low} < ${key} < ${high}`);
		if (i % 2) low = key;
		else high = key;
	}
});

test("tabs: new tab, beside order, retry, inheritance by forks and task-owned conversations, and restart", async () => {
	const home = tempHome();
	let daemon = await runDaemon({ home, simTokensPerSecond: 5000 });
	try {
		let client = await TestClient.connect(daemon.socket);
		let threads = client.sub({ kind: "threads" });
		const a = await client.req("thread.create", { requestId: "tabs-a", cwd: home, model: SIM, place: { workspace: "new", label: "Alpha" } });
		assert.equal(a.tab.label, "Alpha");
		assert.equal(a.pane, undefined, "a durable thread has no pane");
		assert.deepEqual(await client.req("thread.create", { requestId: "tabs-a", cwd: home, model: SIM, place: { workspace: "new", label: "Other" } }), a, "a retried create returns the first thread and placement");
		const b = await client.req("thread.create", { requestId: "tabs-b", cwd: home, model: SIM, place: { beside: a.threadId } });
		const c = await client.req("thread.create", { requestId: "tabs-c", cwd: home, model: SIM, place: { beside: a.threadId, direction: "down" } });
		assert.deepEqual([b.tab, c.tab], [a.tab, a.tab]);
		const other = await client.req("thread.create", { requestId: "tabs-o", cwd: home, model: SIM });
		assert.notEqual(other.tab.id, a.tab.id, "a create without placement opens a new tab");
		let list = await client.until<any>(threads, (v) => panes(v, a.tab.id).length === 3 && v.threads[other.threadId]);
		assert.deepEqual(panes(list, a.tab.id), [a.threadId, c.threadId, b.threadId], "beside sorts directly after its thread");
		assert.deepEqual(list.threads[a.threadId].location, { workspace: a.tab.id, workspaceLabel: "Alpha", tab: a.tab.id, tabLabel: "Alpha" });
		assert.equal(list.threads[a.threadId].live, true);
		assert.equal(list.threads[a.threadId].control, true);
		assert.deepEqual(list.layout.workspaces.map((w: any) => w.id), [a.tab.id, other.tab.id], "tabs sort by their oldest thread");

		// A fork and a task-owned conversation (a subagent or a Worker) join their source's tab right after it.
		await client.req("thread.submit", { threadId: c.threadId, content: "/sim long 40" });
		const { store, conversationId } = await daemon.runtime.thread(c.threadId);
		const inspection = await store.harness.inspect(BACKGROUND_CONTEXT);
		const generation = inspection.tasks.find((t) => String(t.record.conversationId) === conversationId && t.record.state.status !== "terminal");
		assert.ok(generation, "the submitted run has a live task");
		const owned = await store.harness.commit((tx) => tx.createConversation({ ownership: { kind: "task", taskId: generation.record.id as TaskId } }), BACKGROUND_CONTEXT);
		const ownedId = store.threadKey(owned.id);
		const history = await client.req("thread.history", { threadId: c.threadId, before: "1000000", limit: 5 });
		const fork = await client.req("thread.fork", { threadId: c.threadId, entryId: String(history.entries[0].id) });
		await client.req("thread.abort", { threadId: c.threadId });
		list = await client.until<any>(threads, (v) => panes(v, a.tab.id).length === 5);
		const order = panes(list, a.tab.id);
		assert.equal(order[0], a.threadId);
		assert.equal(order[1], c.threadId);
		assert.deepEqual(new Set(order.slice(2, 4)), new Set([ownedId, fork.threadId]), "children sort after their source, before the next thread");
		assert.equal(order[4], b.threadId);
		assert.equal(parseThreadKey(fork.threadId).storeId, parseThreadKey(c.threadId).storeId);
		client.close();

		await daemon.stop();
		daemon = await runDaemon({ home, simTokensPerSecond: 5000 });
		client = await TestClient.connect(daemon.socket);
		threads = client.sub({ kind: "threads" });
		const after = await client.until<any>(threads, (v) => panes(v, a.tab.id).length === 5 && panes(v, other.tab.id).length === 1);
		assert.deepEqual(after.layout, list.layout, "a restart keeps tabs and order");
		client.close();
	} finally {
		await daemon.stop();
	}
});
