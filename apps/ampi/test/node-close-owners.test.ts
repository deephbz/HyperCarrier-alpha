import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, type ConversationId, defineExtension, GenerationTask, hook, type TaskId } from "@earendil-works/pi-durable";
import { RarebitDoc } from "@hypercarrier/rarebit-durable";
import { runDaemon } from "../src/node/daemon.ts";
import type { NodePlugin } from "../src/node/runtime.ts";
import { hydrate } from "../src/plugins.ts";
import { TestClient, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Counts the plugin completions (no `sessionId`) that reach the models while counting. While `holdCalls`, each one
 * waits in flight for its abort. While `holdRun`, it holds the next generation in `beforeRequest`, so the lead's run
 * task stays live to own a subagent.
 */
function completionCounter() {
	const runs: (() => void)[] = [];
	const state = { counting: false, calls: 0, holdCalls: false, inFlight: 0, aborted: 0, holdRun: true, releaseRuns: () => runs.splice(0).forEach((resume) => resume()) };
	let reached = () => {};
	const runHeld = new Promise<void>((resolve) => (reached = resolve));
	const plugin: NodePlugin = {
		extensions: [
			defineExtension({
				name: "test-run-hold",
				hooks: [
					hook(GenerationTask, {
						async beforeRequest() {
							if (!state.holdRun) return undefined;
							state.holdRun = false;
							const released = new Promise<void>((resolve) => runs.push(resolve));
							reached();
							await released;
							return undefined;
						},
					}),
				],
			}),
		],
		attach(_store, runtime) {
			const models = runtime.models as typeof runtime.models & { countedPlugin?: boolean };
			if (models.countedPlugin) return;
			const complete = models.completeSimple.bind(models);
			Object.assign(models, {
				countedPlugin: true,
				completeSimple: async (...args: Parameters<typeof complete>) => {
					const signal = args[2]?.signal;
					if (state.holdCalls && signal && !args[2]?.sessionId) {
						state.inFlight++;
						await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
						state.aborted++;
						throw signal.reason;
					}
					if (state.counting && !args[2]?.sessionId) state.calls++;
					return complete(...args);
				},
			});
		},
		stops: () => [],
		confirmStop: () => {},
	};
	return { state, plugin, runHeld };
}

/**
 * A lead thread and a subagent conversation owned by the lead's task. The subagent's Rarebit jobs (Title)
 * are admitted and held just before their requests start: Rarebit reads the agent's model right before its request.
 */
async function withHeldChildJobs(run: (args: { daemon: Awaited<ReturnType<typeof runDaemon>>; fence: NodePlugin; client: TestClient; threads: number; threadId: string; childKey: string; release: () => void; counter: ReturnType<typeof completionCounter>["state"]; rarebit: () => Promise<unknown> }) => Promise<void>) {
	const home = tempHome();
	const counter = completionCounter();
	const daemon = await runDaemon({ home, simTokensPerSecond: 50000, plugins: [...(await hydrate()), counter.plugin] });
	const held: (() => void)[] = [];
	let holding = true;
	const release = () => {
		holding = false;
		held.splice(0).forEach((resume) => resume());
	};
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "Name three rollback risks" });
		await counter.runHeld;
		const { store, conversationId } = await daemon.runtime.thread(threadId);
		const inspection = await store.harness.inspect(BACKGROUND_CONTEXT);
		const task = inspection.tasks.find((t) => String(t.record.conversationId) === conversationId && t.record.state.status !== "terminal");
		assert.ok(task, "the held lead run has a live task");
		const child = await store.harness.commit((tx) => tx.createConversation({ ownership: { kind: "task", taskId: task.record.id as TaskId } }), BACKGROUND_CONTEXT);
		const childKey = store.threadKey(child.id);
		const snapshot = store.harness.snapshot.bind(store.harness);
		let reached = () => {};
		const jobsHeld = new Promise<void>((resolve) => (reached = resolve));
		store.harness.snapshot = (async (...args: Parameters<typeof snapshot>) => {
			if (holding && (args[0] as unknown) === AgentDoc && String(args[1]) === String(child.id) && new Error().stack?.includes("rarebit")) {
				const released = new Promise<void>((resolve) => held.push(resolve));
				reached();
				await released;
			}
			return snapshot(...args);
		}) as typeof store.harness.snapshot;
		await client.req("thread.submit", { threadId: childKey, content: "Name three rollback risks" });
		await jobsHeld;
		const rarebit = () => store.harness.snapshot(RarebitDoc, child.id as ConversationId, BACKGROUND_CONTEXT);
		await run({ daemon, fence: counter.plugin, client, threads, threadId, childKey, release, counter: counter.state, rarebit });
		client.close();
	} finally {
		release();
		counter.state.releaseRuns();
		await daemon.stop();
	}
}

test("Close of a lead: a subagent's Rarebit job held before its request starts no model call after the Close commit", async () => {
	await withHeldChildJobs(async ({ client, threadId, release, counter }) => {
		process.env.AMPI_FAULT = "close-intent-only";
		try {
			assert.equal((await client.req("thread.close", { threadId })).evidence, "closed");
		} finally {
			delete process.env.AMPI_FAULT;
		}
		counter.counting = true;
		release();
		await sleep(500);
		assert.equal(counter.calls, 0, "no model call of the closed lead's subagent");
	});
});

test("an open lead: the subagent's held Rarebit jobs run on release", async () => {
	await withHeldChildJobs(async ({ release, counter, rarebit }) => {
		counter.counting = true;
		release();
		for (const deadline = Date.now() + 5000; !(await rarebit() as { title?: unknown } | undefined)?.title; await sleep(20))
			assert.ok(Date.now() < deadline, "the subagent's Title finishes");
		assert.ok(counter.calls > 0, "the subagent's jobs reached the model");
	});
});

test("Close of a lead aborts a subagent's Rarebit request in flight", async () => {
	await withHeldChildJobs(async ({ client, threadId, release, counter }) => {
		counter.holdCalls = true;
		release();
		for (const deadline = Date.now() + 5000; counter.inFlight === 0; await sleep(20)) assert.ok(Date.now() < deadline, "a subagent request is in flight");
		process.env.AMPI_FAULT = "close-intent-only";
		try {
			assert.equal((await client.req("thread.close", { threadId })).evidence, "closed");
		} finally {
			delete process.env.AMPI_FAULT;
		}
		for (const deadline = Date.now() + 2000; counter.aborted < counter.inFlight; await sleep(20))
			assert.ok(Date.now() < deadline, `Close aborts the subagent's requests in flight (${counter.aborted} of ${counter.inFlight})`);
	});
});

test("a lifted fence on a lead refreshes its subagent: a Title aborted while the lead was fenced is redone", async () => {
	await withHeldChildJobs(async ({ daemon, fence, threadId, release, counter, rarebit }) => {
		const { store, conversationId } = await daemon.runtime.thread(threadId);
		const stopping = daemon.runtime.stop(store, [{ id: "test-fence", conversations: [conversationId] }], fence);
		// The fence aborts the subagent's held jobs; they end while the lead is still fenced.
		await sleep(100);
		release();
		await sleep(300);
		assert.equal((await rarebit() as { title?: unknown } | undefined)?.title, undefined, "no Title while the lead is fenced");
		counter.releaseRuns();
		assert.equal((await stopping)[0]?.status, "settled");
		for (const deadline = Date.now() + 5000; !(await rarebit() as { title?: unknown } | undefined)?.title; await sleep(20))
			assert.ok(Date.now() < deadline, "the subagent's Title is redone after the lift");
	});
});
