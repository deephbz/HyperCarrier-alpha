import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { RarebitDoc } from "@hypercarrier/rarebit-durable";
import { runDaemon } from "../src/node/daemon.ts";
import { CommandsDoc } from "../src/node/commands.ts";
import { type NodePlugin, parseThreadKey } from "../src/node/runtime.ts";
import { hydrate } from "../src/plugins.ts";
import { TestClient, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wraps the node's completeSimple, which Rarebit's Title jobs call. `before` holds each call before it
 * reaches the provider; a request counts as sent only if its signal is still live then, as a provider sends it.
 * `inflight` sends at once and holds the result.
 */
function probe() {
	const state = { mode: "before" as "before" | "inflight", entered: 0, sent: 0, release: () => {} };
	let gate = Promise.resolve();
	const hold = () => {
		gate = new Promise<void>((resolve) => (state.release = resolve));
	};
	const plugin: NodePlugin = {
		extensions: [],
		attach(_store, runtime) {
			const models = runtime.models;
			const complete = models.completeSimple.bind(models);
			Object.assign(models, {
				completeSimple: async (...args: Parameters<typeof complete>) => {
					state.entered++;
					const signal = args[2]?.signal;
					if (state.mode === "before") {
						await gate;
						if (!signal?.aborted) state.sent++;
						return complete(...args);
					}
					state.sent++;
					const result = complete(...args);
					await gate;
					return result;
				},
			});
		},
	};
	return { state, hold, plugin };
}

for (const action of ["title"]) test(`Close interrupts a held manual Rarebit ${action} without waiting for its provider`, async () => {
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 50_000, plugins: await hydrate() });
	const client = await TestClient.connect(daemon.socket);
	let release = () => {};
	let pending: Promise<unknown> | undefined;
	try {
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "Implement abortable receipts" });
		const view = client.sub({ kind: "rarebit", threadId });
		await client.until<any>(view, v => v.state.title);
		const complete = daemon.runtime.models.completeSimple.bind(daemon.runtime.models);
		const gate = new Promise<void>(resolve => { release = resolve; });
		let entered = false, aborted = false;
		daemon.runtime.models.completeSimple = async (...args) => {
			entered = true;
			args[2]?.signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
			const result = await complete(...args);
			await gate;
			return result;
		};
		pending = client.req("thread.command", { threadId, name: "rarebit", args: action, key: "held" }).catch(error => error);
		for (const deadline = Date.now() + 3000; !entered && Date.now() < deadline;) await sleep(5);
		assert.ok(entered, "manual model call entered");
		let closed = false;
		const closing = client.req("thread.close", { threadId }).then(() => { closed = true; });
		for (const deadline = Date.now() + 1000; !closed && Date.now() < deadline;) await sleep(5);
		assert.equal(aborted, true, "Close signals abort before the provider resolves");
		assert.equal(closed, true, "Close completes before releasing the model promise");
		await closing;
		const thread = await daemon.runtime.thread(threadId);
		const before = await thread.store.harness.snapshot(RarebitDoc, thread.conversation.id, BACKGROUND_CONTEXT);
		const commands = await thread.store.harness.snapshot(CommandsDoc, thread.conversation.id, BACKGROUND_CONTEXT);
		release(); const result = await pending;
		assert.equal((result as any).code, "closed");
		assert.deepEqual(await thread.store.harness.snapshot(RarebitDoc, thread.conversation.id, BACKGROUND_CONTEXT), before, "no receipt applies after Close");
		assert.deepEqual(await thread.store.harness.snapshot(CommandsDoc, thread.conversation.id, BACKGROUND_CONTEXT), commands, "no command reply commits after Close");
		await assert.rejects(client.req("thread.command", { threadId, name: "rarebit", args: "title", key: "closed" }), (error: any) => error.code === "closed");
	} finally { release(); await pending; client.close(); await daemon.stop(); }
});

test("Close aborts Rarebit jobs: a held job sends no request, an in-flight one writes nothing", async () => {
	const home = tempHome();
	const reports: string[] = [];
	const { state, hold, plugin } = probe();
	const daemon = await runDaemon({ home, simTokensPerSecond: 50000, plugins: [...(await hydrate()), plugin], report: (error) => reports.push(String(error)) });
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		const rarebit = async (key: string) => {
			const { storeId, conversationId } = parseThreadKey(key);
			return daemon.runtime.store(storeId).harness.snapshot(RarebitDoc, Number(conversationId) as ConversationId, BACKGROUND_CONTEXT);
		};
		for (const mode of ["before", "inflight"] as const) {
			Object.assign(state, { mode, entered: 0, sent: 0 });
			hold();
			const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "Add a health endpoint to the billing service" });
			// The reaction admitted the Title job, which reached the model call.
			for (const deadline = Date.now() + 5000; state.entered < 1 && Date.now() < deadline; ) await sleep(10);
			assert.ok(state.entered >= 1, `${mode}: Title reached the model call`);
			const atClose = await rarebit(threadId);
			assert.equal((await client.req("thread.close", { threadId })).evidence, "closed");
			state.release();
			await client.until<any>(threads, (v) => v.threads[threadId]?.closed);
			await sleep(300);
			assert.equal(state.sent, mode === "before" ? 0 : state.entered, `${mode}: requests sent`);
			const after = await rarebit(threadId);
			assert.deepEqual(after, atClose, `${mode}: the jobs write nothing after Close`);
			assert.equal(after?.title, undefined);
			assert.equal(after?.summary, undefined);
		}
		assert.deepEqual(reports.filter((r) => /abort|closed/i.test(r)), [], "an aborted job is not reported as a failure");
		client.close();
	} finally {
		await daemon.stop();
	}
});
