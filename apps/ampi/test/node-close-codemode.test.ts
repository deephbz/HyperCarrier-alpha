import "./bound.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Provider } from "@earendil-works/pi-ai/models";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, GenerationTask, hook, type TaskId, ToolTask, UsageDoc } from "@earendil-works/pi-durable";
import { runDaemon } from "../src/node/daemon.ts";
import type { NodePlugin } from "../src/node/runtime.ts";
import { hydrate } from "../src/plugins.ts";
import { TestClient, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };
const PROVIDER = "test-models";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An in-memory classifier and image provider that counts the requests that reach it. */
function modelsProvider() {
	const calls = { classify: 0, generateImages: 0 };
	const base = { provider: PROVIDER, baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const classifier = { ...base, id: "cls-1", name: "Test classifier", api: "test-classifier", type: "classifier", contextWindow: 8000 };
	const image = { ...base, id: "img-1", name: "Test images", api: "test-images", type: "image", output: ["image"] };
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const provider = {
		id: PROVIDER,
		name: "Test models",
		auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
		getModels: () => [],
		getAllModels: () => [classifier, image],
		stream: () => {
			throw new Error("chat is not supported");
		},
		streamSimple: () => {
			throw new Error("chat is not supported");
		},
		classify: async () => {
			calls.classify++;
			return { api: classifier.api, provider: PROVIDER, model: classifier.id, answers: { risky: "yes" }, usage: { ...usage, totalTokens: 7 }, stopReason: "stop", timestamp: Date.now() };
		},
		generateImages: async () => {
			calls.generateImages++;
			return { api: image.api, provider: PROVIDER, model: image.id, output: [], usage, stopReason: "stop", timestamp: Date.now() };
		},
	} as unknown as Provider;
	return { calls, provider, classifier };
}

const CODE = [
	`const [verdict] = await Promise.all([`,
	`models.classify({ provider: "${PROVIDER}", id: "cls-1" }, { state: { plan: "drop the orders table" }, questions: { risky: { type: "choice", instructions: "Is it risky?", criteria: { yes: "risky", no: "safe" } } } }),`,
	`models.generateImages({ provider: "${PROVIDER}", id: "img-1" }, { input: [{ type: "text", text: "a rollback diagram" }] }),`,
	`]);`,
	`return JSON.stringify(verdict.answers);`,
].join(" ");
const PROMPT = `Classify the plan\n/sim tool codemode ${JSON.stringify({ code: CODE })}`;

/**
 * Holds every code mode model call (the internal `models.*` tool tasks) after its `beforeTool` admission, and the
 * lead's next run in `beforeRequest`, so the lead's task stays live to own a subagent. Each held call continues across
 * a timer. The `test_scoped_classify` tool holds inside its execution and crosses a timer before it calls
 * `api.models.classify()` without a `sessionId`, so its request has only the tool scope to name its conversation.
 */
function holds(classifier: unknown) {
	const tools: (() => void)[] = [];
	const runs: (() => void)[] = [];
	const state = { holdTools: true, holdRun: false, toolsHeld: 0, answered: [] as string[], release: () => tools.splice(0).forEach((resume) => resume()), releaseRuns: () => runs.splice(0).forEach((resume) => resume()) };
	const scopedClassify = defineTool({
		name: "test_scoped_classify",
		description: "Classify after a hold and a timer",
		parameters: Type.Object({}),
		// Non-cooperative: it passes no abort signal, so only the dispatch gate can hold a closed thread's request.
		execute: async (_args, api) => {
			state.toolsHeld++;
			await new Promise<void>((resolve) => tools.push(resolve));
			await sleep(30);
			const result = await api.models.classify(classifier as Parameters<typeof api.models.classify>[0], { state: { plan: "drop" }, questions: { risky: { type: "choice", instructions: "Risky?", criteria: { yes: "risky", no: "safe" } } } } as Parameters<typeof api.models.classify>[1]);
			state.answered.push(String(api.conversationId));
			return { output: [{ type: "text" as const, text: JSON.stringify(result.answers) }] };
		},
	});
	let runReached = () => {};
	const runHeld = new Promise<void>((resolve) => (runReached = resolve));
	const plugin: NodePlugin = {
		extensions: [
			defineExtension({
				name: "test-codemode-hold",
				tools: [scopedClassify],
				hooks: [
					hook(ToolTask, {
						async beforeTool(call) {
							if (!state.holdTools || !/models\.(classify|generateImages)$/.test(call.name)) return undefined;
							state.toolsHeld++;
							await new Promise<void>((resolve) => tools.push(resolve));
							await sleep(30);
							return undefined;
						},
					}),
					hook(GenerationTask, {
						async beforeRequest() {
							if (!state.holdRun) return undefined;
							state.holdRun = false;
							const released = new Promise<void>((resolve) => runs.push(resolve));
							runReached();
							await released;
							return undefined;
						},
					}),
				],
			}),
		],
	};
	return { state, plugin, runHeld };
}

async function withDaemon(run: (args: { daemon: Awaited<ReturnType<typeof runDaemon>>; client: TestClient; threads: number; home: string; hold: ReturnType<typeof holds>["state"]; runHeld: Promise<void>; calls: ReturnType<typeof modelsProvider>["calls"] }) => Promise<void>) {
	const home = tempHome();
	const { calls, provider, classifier } = modelsProvider();
	const hold = holds(classifier);
	// Pi's tool selection: the threads offer code mode.
	const agentDir = join(home, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["+codemode"] }));
	const daemon = await runDaemon({ home, agentDir, simTokensPerSecond: 50000, testProviders: [PROVIDER], plugins: [...(await hydrate()), hold.plugin] });
	daemon.runtime.models.setProvider(provider);
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		await run({ daemon, client, threads, home, hold: hold.state, runHeld: hold.runHeld, calls });
		client.close();
	} finally {
		hold.state.holdTools = false;
		hold.state.release();
		hold.state.releaseRuns();
		await daemon.stop();
	}
}

async function untilHeld(hold: { toolsHeld: number }, count: number) {
	for (const deadline = Date.now() + 5000; hold.toolsHeld < count; await sleep(20)) assert.ok(Date.now() < deadline, `${count} code mode model calls are held (${hold.toolsHeld})`);
}

async function closeIntentOnly(client: TestClient, threadId: string) {
	process.env.AMPI_FAULT = "close-intent-only";
	try {
		assert.equal((await client.req("thread.close", { threadId })).evidence, "closed");
	} finally {
		delete process.env.AMPI_FAULT;
	}
}

test("Close: a code mode model call held after its admission dispatches nothing after the Close commit", async () => {
	await withDaemon(async ({ client, home, hold, calls }) => {
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: PROMPT });
		await untilHeld(hold, 2);
		await closeIntentOnly(client, threadId);
		hold.release();
		await sleep(500);
		assert.deepEqual(calls, { classify: 0, generateImages: 0 });
	});
});

test("Close of a lead: a subagent's code mode model call held after its admission dispatches nothing", async () => {
	await withDaemon(async ({ daemon, client, home, hold, runHeld, calls }) => {
		hold.holdRun = true;
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "Name three rollback risks" });
		await runHeld;
		const { store, conversationId } = await daemon.runtime.thread(threadId);
		const inspection = await store.harness.inspect(BACKGROUND_CONTEXT);
		const task = inspection.tasks.find((t) => String(t.record.conversationId) === conversationId && t.record.state.status !== "terminal");
		assert.ok(task, "the held lead run has a live task");
		const child = await store.harness.commit((tx) => tx.createConversation({ ownership: { kind: "task", taskId: task.record.id as TaskId } }), BACKGROUND_CONTEXT);
		await client.req("thread.submit", { threadId: store.threadKey(child.id), content: PROMPT });
		await untilHeld(hold, 2);
		await closeIntentOnly(client, threadId);
		hold.release();
		await sleep(500);
		assert.deepEqual(calls, { classify: 0, generateImages: 0 });
	});
});

test("an open thread's code mode model calls dispatch and answer", async () => {
	await withDaemon(async ({ client, threads, home, hold, calls }) => {
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: PROMPT });
		await untilHeld(hold, 2);
		hold.release();
		await client.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId]?.contextTokens, 5000);
		assert.deepEqual(calls, { classify: 1, generateImages: 1 });
	});
});

/** Threads A and B in one store, so their conversation IDs differ; A starts with `prompt`, and B gets it submitted. */
async function twoThreads(daemon: Awaited<ReturnType<typeof runDaemon>>, client: TestClient, home: string, prompt: string) {
	const a = (await client.req("thread.create", { cwd: home, model: SIM, prompt })).threadId;
	const { store } = await daemon.runtime.thread(a);
	const sibling = await store.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: SIM, cwd: home } }, BACKGROUND_CONTEXT);
	const b = store.threadKey(sibling.id);
	await client.req("thread.submit", { threadId: b, content: prompt });
	return { a, b };
}

/** The `pi.usage` tool buckets of the thread's conversation. */
async function toolUsage(daemon: Awaited<ReturnType<typeof runDaemon>>, threadId: string) {
	const { store, conversationId } = await daemon.runtime.thread(threadId);
	const usage = await store.harness.snapshot(UsageDoc, Number(conversationId) as never, BACKGROUND_CONTEXT);
	return Object.fromEntries(Object.entries(usage?.tools ?? {}).map(([name, total]) => [name, total.totalTokens]));
}

test("concurrent code mode calls of two threads: Close of A holds only A's, and B's request is B's", async () => {
	await withDaemon(async ({ daemon, client, threads, home, hold, calls }) => {
		const { a, b } = await twoThreads(daemon, client, home, PROMPT);
		await untilHeld(hold, 4);
		await closeIntentOnly(client, a);
		hold.release();
		await client.until<any>(threads, (v) => v.threads[b]?.activity === "idle" && v.threads[b]?.contextTokens, 5000);
		await sleep(300);
		assert.deepEqual(calls, { classify: 1, generateImages: 1 });
		assert.ok(Object.entries(await toolUsage(daemon, b)).some(([name, tokens]) => /models\.classify$/.test(name) && tokens === 7), "B's ledger has its classify");
		assert.deepEqual(await toolUsage(daemon, a), {}, "A's ledger has no model call");
	});
});

test("concurrent tool executions of two threads keep their own scope across a timer", async () => {
	await withDaemon(async ({ daemon, client, threads, home, hold, calls }) => {
		const prompt = "Classify later\n/sim tool test_scoped_classify {}";
		const { a, b } = await twoThreads(daemon, client, home, prompt);
		await untilHeld(hold, 2);
		await closeIntentOnly(client, a);
		hold.release();
		await client.until<any>(threads, (v) => v.threads[b]?.activity === "idle" && v.threads[b]?.contextTokens, 5000);
		await sleep(300);
		assert.equal(calls.classify, 1, "one request dispatches");
		assert.deepEqual(hold.answered, [(await daemon.runtime.thread(b)).conversationId], "B's request is the one that dispatches");
	});
});
