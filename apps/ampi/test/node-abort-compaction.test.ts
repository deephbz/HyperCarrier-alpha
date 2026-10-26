import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, LiveDoc } from "@earendil-works/pi-durable";
import { runDaemon } from "../src/node/daemon.ts";
import { EscDoc } from "../src/node/runtime.ts";
import { heldSummaries, TestClient, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };

const until = async (fn: () => Promise<unknown>, message: string) => {
	for (const deadline = Date.now() + 10_000; Date.now() < deadline; await new Promise((r) => setTimeout(r, 20))) if (await fn()) return;
	throw new Error(message);
};

test("Stop on a thread with only a manual compaction live cancels it: no summary, the thread is idle, and a later input answers", async () => {
	const home = tempHome();
	const { models, state } = heldSummaries();
	const daemon = await runDaemon({ home, models, plugins: [{ extensions: [], settings: { retry: { maxRetries: 0 }, compaction: { keepRecentTokens: 256 } } }] });
	const client = await TestClient.connect(daemon.socket);
	try {
		const rows = client.sub({ kind: "threads" });
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "/sim long 10" });
		const history = () => client.req("thread.history", { threadId, before: "1000000", limit: 100 }).then((h: any) => h.entries as any[]);
		const answered = (count: number) => until(async () => (await history()).filter((e) => e.kind === "assistant" && e.stop === "stop").length >= count, `${count} answers`);
		await answered(1);
		for (const [i, prompt] of ["/sim long 10", "/sim long 10"].entries()) {
			await client.req("thread.submit", { threadId, content: prompt, requestId: `seed-${i}` });
			await answered(i + 2);
		}
		await client.until<any>(rows, (v) => v.threads[threadId]?.activity === "idle");

		state.arm();
		const { taskId } = await client.req("thread.compact", { threadId });
		await until(async () => state.held === 1, "the summary request is held");
		const ack = await client.req("thread.abort", { threadId });
		assert.equal(ack.evidence, "aborted", "Stop reports the work it stopped");
		assert.deepEqual(ack.compactions, [{ taskId, reason: "manual", outcome: "aborted" }], "the ack names the cancelled compaction");
		assert.equal(state.aborted, 1, "the summary request saw the abort");

		await client.until<any>(rows, (v) => v.threads[threadId]?.activity === "idle");
		assert.equal((await history()).filter((e) => e.kind === "compaction").length, 0, "no summary is written");
		assert.equal((await client.req("thread.abort", { threadId })).evidence, "idle", "nothing is left to stop");

		const after = await client.req("thread.submit", { threadId, content: "/sim long 20", requestId: "after-stop" });
		assert.equal(after.evidence, "started");
		await answered(4);
	} finally {
		client.close();
		await daemon.stop();
	}
});

test("Stop cancels a background threshold compaction that conversation.abort leaves running", async () => {
	const home = tempHome();
	const { models, state } = heldSummaries(20000);
	const daemon = await runDaemon({ home, models, plugins: [{ extensions: [], settings: { retry: { maxRetries: 0 }, compaction: { keepRecentTokens: 256, reserveTokens: 1000, backgroundTokens: 15000 } } }] });
	const client = await TestClient.connect(daemon.socket);
	try {
		const rows = client.sub({ kind: "threads" });
		state.arm();
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "/sim long 10" });
		const history = () => client.req("thread.history", { threadId, before: "1000000", limit: 100 }).then((h: any) => h.entries as any[]);
		for (let i = 0; state.held === 0 && i < 4; i++) {
			await until(async () => state.held > 0 || daemon.runtime.threads.value.threads[threadId]?.activity === "idle", "turn ends");
			if (state.held === 0) await client.req("thread.submit", { threadId, content: "/sim long 10", requestId: `grow-${i}` });
		}
		await until(async () => state.held === 1, "a threshold summary request is held");
		// A background compaction outlives the run that started it: the run ends while the summary is held.
		const thread = await daemon.runtime.thread(threadId);
		const live = () => thread.store.harness.snapshot(LiveDoc, Number(thread.conversationId) as ConversationId, BACKGROUND_CONTEXT);
		await until(async () => !(await live())?.run, "the run ends");
		assert.deepEqual((await live())?.compactions?.map((c) => [c.reason, c.blocking]), [["threshold", false]]);
		const ack = await client.req("thread.abort", { threadId });
		assert.equal(ack.evidence, "aborted");
		assert.deepEqual(ack.compactions?.map((c: any) => [c.reason, c.outcome]), [["threshold", "aborted"]]);
		await client.until<any>(rows, (v) => v.threads[threadId]?.activity === "idle");
		assert.equal((await history()).filter((e) => e.kind === "compaction").length, 0, "no summary is written");
	} finally {
		client.close();
		await daemon.stop();
	}
});

/** A daemon with held summaries and a thread whose context has an old prefix to summarize. */
async function compactable(options: { stopWaitMs?: number } = {}) {
	const home = tempHome();
	const { models, state } = heldSummaries();
	const daemon = await runDaemon({ home, models, ...options, plugins: [{ extensions: [], settings: { retry: { maxRetries: 0 }, compaction: { keepRecentTokens: 256 } } }] });
	const client = await TestClient.connect(daemon.socket);
	const rows = client.sub({ kind: "threads" });
	const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "/sim long 10" });
	const history = () => client.req("thread.history", { threadId, before: "1000000", limit: 100 }).then((h: any) => h.entries as any[]);
	const answered = (count: number) => until(async () => (await history()).filter((e) => e.kind === "assistant" && e.stop === "stop").length >= count, `${count} answers`);
	await answered(1);
	for (const i of [2, 3]) {
		await client.req("thread.submit", { threadId, content: "/sim long 10", requestId: `seed-${i}` });
		await answered(i);
	}
	await client.until<any>(rows, (v) => v.threads[threadId]?.activity === "idle");
	const thread = await daemon.runtime.thread(threadId);
	const tasks = async () => (await thread.store.harness.inspect(BACKGROUND_CONTEXT)).tasks.map(({ record }) => record);
	const intents = async () => Object.keys((await thread.store.harness.snapshot(EscDoc, BACKGROUND_CONTEXT))?.intents ?? {});
	const hold = async (mode: "cooperative" | "uncooperative") => {
		const held = state.held;
		state.arm(mode);
		const { taskId } = await client.req("thread.compact", { threadId });
		await until(async () => state.held === held + 1, "the summary request is held");
		return taskId as string;
	};
	return { daemon, client, rows, threadId, thread, state, history, answered, tasks, intents, hold };
}

test("Stop bounds its wait: an uncooperative compaction answers `stopping` with `unknown`, and the node settles it later", async () => {
	const { daemon, client, rows, threadId, state, history, tasks, intents, hold } = await compactable({ stopWaitMs: 300 });
	try {
		const taskId = await hold("uncooperative");
		const started = Date.now();
		const ack = await client.req("thread.abort", { threadId });
		assert.ok(Date.now() - started < 3000, "the ack does not wait for the uncooperative provider");
		assert.equal(ack.evidence, "stopping", "the ack does not claim a stop it did not confirm");
		assert.deepEqual(ack.compactions, [{ taskId, reason: "manual", outcome: "unknown" }]);
		assert.equal((await tasks()).find((t) => String(t.id) === taskId)?.abortRequested, true, "the compaction is marked");
		assert.equal((await intents()).length, 1, "the Esc intent stays stored until settlement");

		state.release(1);
		await until(async () => (await intents()).length === 0, "settlement confirms the intent");
		await until(async () => !(await tasks()).some((t) => String(t.id) === taskId), "the compaction ends");
		await client.until<any>(rows, (v) => v.threads[threadId]?.activity === "idle");
		assert.equal((await history()).filter((e) => e.kind === "compaction").length, 0, "an abort-marked compaction writes no summary");
	} finally {
		state.releaseAll();
		client.close();
		await daemon.stop();
	}
});

test("Stop marks every captured compaction before it waits: an uncooperative first one does not keep the second unmarked", async () => {
	const { daemon, client, threadId, state, tasks, hold } = await compactable({ stopWaitMs: 300 });
	try {
		const first = await hold("uncooperative");
		const second = await hold("cooperative");
		const ack = await client.req("thread.abort", { threadId });
		assert.equal(ack.evidence, "stopping");
		assert.deepEqual(ack.compactions.map((c: any) => [c.taskId, c.outcome]), [[first, "unknown"], [second, "aborted"]]);
		assert.equal(state.aborted, 1, "the second summary request saw its abort");
		assert.equal((await tasks()).find((t) => String(t.id) === first)?.abortRequested, true, "the first is marked too");
	} finally {
		state.releaseAll();
		client.close();
		await daemon.stop();
	}
});

test("a compaction that finishes between Stop's snapshot and its mark reports `completed`; its summary stands", async () => {
	const { daemon, client, threadId, thread, state, history, hold } = await compactable();
	try {
		const taskId = await hold("cooperative");
		// Stop reads the live compaction; before it stores its intent, the summary request answers and the task ends.
		const harness = thread.store.harness;
		const snapshot = harness.snapshot.bind(harness);
		let finishing = true;
		harness.snapshot = (async (doc: any, ...args: any[]) => {
			const value = await (snapshot as any)(doc, ...args);
			if (finishing && doc === LiveDoc && value?.compactions?.length) {
				finishing = false;
				state.release(1);
				await harness.waitForTask(Number(taskId) as never, BACKGROUND_CONTEXT);
			}
			return value;
		}) as typeof harness.snapshot;
		const ack = await client.req("thread.abort", { threadId });
		harness.snapshot = snapshot;
		assert.equal(finishing, false, "the seam ran inside Stop");
		assert.deepEqual(ack.compactions, [{ taskId, reason: "manual", outcome: "completed", summary: "placed" }]);
		assert.equal(state.aborted, 0);
		assert.equal((await history()).filter((e) => e.kind === "compaction").length, 1, "the finished summary stands");
	} finally {
		state.releaseAll();
		client.close();
		await daemon.stop();
	}
});
