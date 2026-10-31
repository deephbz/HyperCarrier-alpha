import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { runDaemon } from "../src/node/daemon.ts";
import { type NodePlugin, parseThreadKey } from "../src/node/runtime.ts";
import { hydrate } from "../src/plugins.ts";
import { CompactDoc } from "../src/plugins/compact.ts";
import { TestClient, tempHome, writePiSettings } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Last in the production plugin set: counts plugin model calls (Rarebit Title) and, when armed, holds the
 * first post-response refresh after its summary is built and before the reactions run.
 */
function probe() {
	const state = { calls: 0, armed: false, held: undefined as string | undefined, release: () => {} };
	let reached = () => {};
	/** Holds the next post-response refresh; resolves when it is held. */
	const arm = () =>
		new Promise<void>((resolve) => {
			state.armed = true;
			reached = resolve;
		});
	const plugin: NodePlugin = {
		extensions: [],
		attach(_store, runtime) {
			const models = runtime.models;
			if ((models as { counted?: boolean }).counted) return;
			const complete = models.completeSimple.bind(models);
			Object.assign(models, {
				counted: true,
				completeSimple: (...args: Parameters<typeof complete>) => {
					state.calls++;
					return complete(...args);
				},
			});
		},
		async summarize(store, conversationId, summary) {
			if (!state.armed || summary.activity !== "idle" || summary.queued > 0 || summary.contextTokens === undefined || summary.closed) return;
			state.armed = false;
			state.held = store.threadKey(conversationId);
			const released = new Promise<void>((resolve) => (state.release = resolve));
			reached();
			await released;
		},
	};
	return { state, arm, plugin };
}

test("plugin reactions start no work for a closed thread, across a held refresh and a reopen", async () => {

	writePiSettings({ auto_compact: { budget_tokens: 300 }, compaction: { keepRecentTokens: 20 } });
	const home = tempHome();
	const compactDecision = async (daemon: Awaited<ReturnType<typeof runDaemon>>, key: string) => {
		const { storeId, conversationId } = parseThreadKey(key);
		return (await daemon.runtime.store(storeId).harness.snapshot(CompactDoc, Number(conversationId) as ConversationId, BACKGROUND_CONTEXT))?.budget;
	};

	// 1. The owner closes a thread after its first reply, while its refresh holds an open summary. The second Close
	// stops at its test-only kill point: the intent is stored and no fence is marked, so only `ampi.meta` says closed.
	const first = probe();
	let daemon = await runDaemon({ home, simTokensPerSecond: 50000, plugins: [...(await hydrate()), first.plugin] });
	const closedKeys: string[] = [];
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		for (const fault of [undefined, "close-intent-only"]) {
			const held = first.arm();
			const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "Draft the migration plan for the orders table\n/sim long 4" });
			closedKeys.push(threadId);
			await held;
			assert.equal(first.state.held, threadId);
			if (fault) process.env.AMPI_FAULT = fault;
			try {
				assert.equal((await client.req("thread.close", { threadId })).evidence, "closed");
			} finally {
				delete process.env.AMPI_FAULT;
			}
			first.state.release();
			await client.until<any>(threads, (v) => v.threads[threadId]?.closed);
			await sleep(300);
			assert.equal(first.state.calls, 0, `no Title model call for the closed thread (${fault ?? "Close"})`);
			assert.equal(await compactDecision(daemon, threadId), undefined, `no compaction decision for the closed thread (${fault ?? "Close"})`);
		}
		client.close();
	} finally {
		await daemon.stop();
	}

	// 2. Reopen: recovery refreshes the closed thread, and its reactions still start nothing. An open thread reacts.
	const second = probe();
	daemon = await runDaemon({ home, simTokensPerSecond: 50000, plugins: [...(await hydrate()), second.plugin] });
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		await client.until<any>(threads, (v) => closedKeys.every((key) => v.threads[key]?.closed));
		await sleep(300);
		assert.equal(second.state.calls, 0, "reopen starts no model call for the closed threads");
		for (const key of closedKeys) assert.equal(await compactDecision(daemon, key), undefined);
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "Draft the migration plan for the orders table\n/sim long 4" });
		await client.until<any>(client.sub({ kind: "rarebit", threadId }), v => Boolean(v.state.title));
		assert.ok(second.state.calls > 0, "the control thread's reactions call the model");
		assert.ok(await compactDecision(daemon, threadId), "the control thread's reactions decide a compaction");
		client.close();
	} finally {
		await daemon.stop();
	}
});
