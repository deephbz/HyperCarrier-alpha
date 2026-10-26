import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { defineExtension, defineTask, defineTool, type Storage, type TaskId } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { runDaemon } from "../src/node/daemon.ts";
import { parseThreadKey, REOPEN_ATTEMPTS } from "../src/node/runtime.ts";
import { TestClient, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };

/** A child task of a test extension: it holds its tool call until `held` is false, and stops when cancelled. */
let held = true;
const Hold = defineTask<null, { phase: "hold" }, null>({
	name: "test.hold",
	version: 1,
	initial: () => ({ phase: "hold" }),
	phases: {
		hold: async (_task, runtime, context) => {
			while (held) {
				context.abortSignal?.throwIfAborted();
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
		},
	},
	abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});
const HoldExtension = defineExtension({ name: "test-hold", tasks: [Hold] });
/** Always installed: the tool resumes after a restart and waits for its child, whose definition may be missing. */
const HoldTool = defineTool({
	name: "test_hold",
	description: "Wait for a held child task",
	parameters: Type.Object({}),
	replay: "safe",
	execute: async (_args, api, context) => {
		const id = (await api.memo<number>("hold", context)) ?? (await api.memo("hold", Number(await api.createTask(Hold, null, { ownership: { kind: "task", taskId: api.taskId } }, context)), context));
		await api.waitForTask(id as unknown as TaskId<null>, context);
		return { output: [{ type: "text" as const, text: "released" }] };
	},
});
const ToolExtension = defineExtension({ name: "test-hold-tool", tools: [HoldTool] });

/** The node's test seam: every Storage call of a broken store throws, as a reset platform or full disk would. */
function faultyStorage(broken: Set<string>) {
	return (storeId: string, storage: Storage): Storage =>
		new Proxy(storage, {
			get(target, prop) {
				const value = Reflect.get(target, prop, target);
				if (typeof value !== "function" || prop === "close") return value;
				return (...args: unknown[]) => {
					if (broken.has(storeId)) throw new Error(`injected storage fault in ${storeId}`);
					return value.apply(target, args);
				};
			},
		});
}

test("failures: a failed run shows its error while idle", async () => {
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 2000 });
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		const { threadId } = await client.req("thread.create", { requestId: "f-run", cwd: home, model: SIM, place: { workspace: "new", label: "F" }, prompt: "/sim error Provider is down" });
		const row = (await client.until<any>(threads, (v) => v.threads[threadId]?.lastError !== undefined)).threads[threadId];
		assert.equal(row.activity, "idle");
		assert.match(row.lastError, /Provider is down/, "idle with an error is a failure, never done");
		client.close();
	} finally {
		await daemon.stop();
	}
});

test("failures: input queued behind a failed model run stays pending until the next submit or /retry runs it", async () => {
	const home = tempHome();
	// A retryable provider error keeps the run busy for one short retry, so input can queue behind it.
	const retry = { name: "test-retry", extensions: [], settings: { retry: { maxRetries: 1, baseDelayMs: 300 } } };
	const daemon = await runDaemon({ home, simTokensPerSecond: 50000, plugins: [retry] });
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		for (const [label, next] of [["submit", "submit"], ["/retry", "retry"]] as const) {
			const { threadId } = await client.req("thread.create", { requestId: `kept-${next}`, cwd: home, model: SIM, place: { workspace: "new", label }, prompt: "/sim error 503 overloaded" });
			assert.equal((await client.req("thread.submit", { threadId, content: "queued behind the failure" })).evidence, "admitted", `${label}: the busy run queues the input`);
			const failed = (await client.until<any>(threads, (v) => v.threads[threadId]?.lastError !== undefined && v.threads[threadId].activity === "idle")).threads[threadId];
			assert.equal(failed.queued, 1, `${label}: the input stays visibly pending after the failed run (afterFailedRun "keep")`);
			if (next === "submit") await client.req("thread.submit", { threadId, content: "and this" });
			else assert.equal((await client.req("thread.command", { threadId, name: "retry" })).evidence, "retried", "/retry places the kept input");
			await client.until<any>(threads, (v) => v.threads[threadId]?.queued === 0 && v.threads[threadId].activity === "idle" && /received your message/.test(v.threads[threadId].preview ?? ""));
			const { store, conversationId } = await daemon.runtime.thread(threadId);
			const view = await (await store.conversation(conversationId)).context(BACKGROUND_CONTEXT);
			const roles = view.messages.map((m: any) => (m.role === "user" ? `user:${typeof m.content === "string" ? m.content : m.content.map((c: any) => c.text).join("")}` : m.role));
			const kept = roles.indexOf("user:queued behind the failure");
			assert.ok(kept > 0 && roles.slice(kept).includes("assistant"), `${label}: the kept input was placed and answered: ${roles.join(" | ")}`);
		}
		client.close();
	} finally {
		await daemon.stop();
	}
});

test("failures: one store's storage failure leaves the others working, stays visible, and reopens a bounded number of times", async () => {
	const home = tempHome();
	const broken = new Set<string>();
	const delays: number[] = [];
	const daemon = await runDaemon({
		home,
		simTokensPerSecond: 2000,
		report: () => {},
		wrapStorage: faultyStorage(broken),
		// Each backoff delay is recorded and fired at once, so six attempts take no wall time.
		setTimer: (callback, delayMs) => {
			delays.push(delayMs);
			setImmediate(callback);
		},
	});
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		const a = await client.req("thread.create", { requestId: "f-a", cwd: home, model: SIM, place: { workspace: "new", label: "A" }, prompt: "/sim long 5" });
		const b = await client.req("thread.create", { requestId: "f-b", cwd: home, model: SIM, place: { workspace: "new", label: "B" }, prompt: "/sim long 5" });
		await client.until<any>(threads, (v) => [a, b].every(({ threadId }) => v.threads[threadId]?.activity === "idle" && v.threads[threadId].preview));
		const storeA = parseThreadKey(a.threadId).storeId;

		broken.add(storeA);
		await assert.rejects(client.req("thread.submit", { threadId: a.threadId, content: "lost" }), "the failing commit is not acknowledged");
		const failed = await client.until<any>(threads, (v) => /gave up/.test(v.threads[a.threadId]?.lastError ?? ""));
		assert.match(failed.threads[a.threadId].lastError, /storage unavailable: .*injected storage fault/);
		assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 32000], "six reopen attempts with doubling backoff");
		assert.equal(REOPEN_ATTEMPTS, 6);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(delays.length, 6, "no reopen timer after the last attempt");
		const health = await client.req("node.health");
		assert.deepEqual(
			health.stores.filter((s: any) => s.id === storeA).map((s: any) => [s.gaveUp, /injected/.test(s.unavailable)]),
			[[true, true]],
		);

		// The other store still submits and reads.
		const more = await client.req("thread.submit", { threadId: b.threadId, content: "/sim long 3" });
		assert.equal(more.evidence, "started");
		await client.until<any>(threads, (v) => v.threads[b.threadId]?.activity === "idle" && v.threads[b.threadId].queued === 0);
		const view = client.sub({ kind: "thread", threadId: b.threadId });
		assert.equal((await client.until<any>(view, (v) => v.entries.filter((e: any) => e.kind === "user").length === 2)).conversationId, parseThreadKey(b.threadId).conversationId);

		// /retry tries once more; with the fault still there, the store stays unavailable and starts no timer.
		await assert.rejects(client.req("thread.command", { threadId: a.threadId, name: "retry" }), /did not reopen/);
		assert.equal(delays.length, 6);
		broken.delete(storeA);
		const retried = await client.req("thread.command", { threadId: a.threadId, name: "retry" });
		assert.equal(retried.evidence, "store_reopened");
		await client.until<any>(threads, (v) => v.threads[a.threadId]?.lastError === undefined);
		assert.equal((await client.req("thread.submit", { threadId: a.threadId, content: "/sim long 2" })).evidence, "started", "the reopened store takes input");
		assert.deepEqual(await client.req("store.reopen", { storeId: storeA }), { store: storeA, state: "open" });
		client.close();
	} finally {
		await daemon.stop();
	}
});

test("failures: a task whose definition is missing shows why, keeps queued input pending, and runs once the definition is installed", async () => {
	const home = tempHome();
	held = true;
	let threadId = "";
	const first = await runDaemon({ home, simTokensPerSecond: 2000, plugins: [{ extensions: [ToolExtension, HoldExtension] }] });
	try {
		const client = await TestClient.connect(first.socket);
		const threads = client.sub({ kind: "threads" });
		({ threadId } = await client.req("thread.create", { requestId: "f-missing", cwd: home, model: SIM, place: { workspace: "new", label: "M" }, prompt: "/sim tool test_hold {}" }));
		await client.until<any>(threads, (v) => v.threads[threadId]?.activity === "tools");
		const queued = await client.req("thread.submit", { threadId, content: "/sim long 1" });
		assert.equal(queued.evidence, "admitted", "the held run queues the input");
		client.close();
	} finally {
		await first.stop();
	}

	const delays: number[] = [];
	const second = await runDaemon({ home, simTokensPerSecond: 2000, plugins: [{ extensions: [ToolExtension] }], report: () => {}, setTimer: (callback, delayMs) => (delays.push(delayMs), setImmediate(callback)) });
	try {
		const client = await TestClient.connect(second.socket);
		const threads = client.sub({ kind: "threads" });
		const row = (await client.until<any>(threads, (v) => v.threads[threadId]?.attention)).threads[threadId];
		assert.match(row.attention[0].reason, /Task test\.hold needs an extension this node does not have/);
		// The tool call stays open, waiting on its blocked child; the attention row says why it cannot finish.
		assert.deepEqual([row.activity, row.queued], ["tools", 1], "the input stays visibly pending");
		const health = await client.req("node.health");
		assert.equal(health.stores.flatMap((s: any) => s.tasks).find((t: any) => t.kind === "test.hold").reason, "missing_task");
		assert.deepEqual(delays, [], "a blocked task is not a storage failure: no reopen");
		assert.equal((await client.req("thread.command", { threadId, name: "retry" })).evidence, "nothing_parked", "/retry cannot run a missing definition");

		// Installing the definition runs the task; the queued input runs after it.
		held = false;
		second.runtime.registry.install(HoldExtension);
		const done = await client.until<any>(threads, (v) => v.threads[threadId]?.queued === 0 && !v.threads[threadId].attention && /Paragraph/.test(v.threads[threadId].preview ?? ""));
		assert.equal(done.threads[threadId].activity, "idle");
		client.close();
	} finally {
		await second.stop();
	}
});
