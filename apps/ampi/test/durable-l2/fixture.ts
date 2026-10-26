// Raw pi-durable 1.4.0 host fixture. No AmPi runtime, network provider, credentials, or product fault hooks.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTask, defineTool, Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { simProvider, SIM_MODEL, SIM_PROVIDER } from "../../src/node/sim.ts";

const [caseName, dir, mode] = process.argv.slice(2);
const send = (event: unknown) => process.send!(event);
const releases = new Map<string, () => void>();
process.on("message", (message: { release?: string }) => { if (message.release) releases.get(message.release)?.(); });
async function barrier(name: string, value?: unknown): Promise<void> {
	const gate = new Promise<void>((resolve) => releases.set(name, resolve));
	send({ type: "barrier", name, value });
	await gate;
	releases.delete(name);
}
const log = (event: unknown) => appendFileSync(join(dir, "effects.jsonl"), JSON.stringify({ mode, event }) + "\n");
const saved = (value: unknown) => writeFileSync(join(dir, "ids.json"), JSON.stringify(value));
const loadIds = (): any => JSON.parse(readFileSync(join(dir, "ids.json"), "utf8"));
const models = createModels();
models.setProvider(simProvider({ tokensPerSecond: 1e9 }));
let agent = { provider: SIM_PROVIDER, modelId: SIM_MODEL };
let modelEntered!: () => void;
const entered = new Promise<void>((resolve) => { modelEntered = resolve; });
if (caseName === "failed-run") {
	const faux = fauxProvider({ provider: "l2-faux", api: "l2-faux", models: [{ id: "offline" }], tokensPerSecond: 1e9 });
	faux.setResponses([async () => {
		modelEntered();
		await barrier("model-wait");
		return fauxAssistantMessage([], { stopReason: "error", errorMessage: "L2 deterministic model failure" });
	}]);
	models.setProvider(faux.provider);
	agent = { provider: "l2-faux", modelId: "offline" };
}
const Effect = defineTool({
	name: "l2_effect", description: "Synthetic keyed file effect", parameters: Type.Object({ key: Type.String() }),
	replay: caseName === "tool-safe" ? "safe" : "unsafe",
	execute: async (args, api) => {
		log({ kind: "attempt", key: args.key, taskId: api.taskId });
		const effect = join(dir, "effect-once.json");
		if (!existsSync(effect)) {
			writeFileSync(effect, JSON.stringify({ key: args.key }), { flag: "wx" });
			log({ kind: "effect-created", key: args.key });
		} else assert.equal(JSON.parse(readFileSync(effect, "utf8")).key, args.key);
		if (mode === "seed") await barrier("effect-before-result", { key: args.key, taskId: api.taskId });
		return { output: [{ type: "text" as const, text: `effect ${args.key}` }] };
	},
});
const Waiter = defineTask<null, { phase: "work" }, null>({
	name: "l2.waiter", version: 1, initial: () => ({ phase: "work" }),
	phases: { work: async (task, runtime, context) => {
		log({ kind: "task-run", taskId: task.id });
		if (mode === "seed" || mode === "recrash") await barrier("task-running", { taskId: task.id });
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
	} },
	abort: async (task, runtime, context) => {
		log({ kind: "task-abort", reason: task.abortReason, taskId: task.id });
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});
const Sleep = defineTask<{ deadline: number }, { phase: "sleep" } | { phase: "deliver" }, null>({
	name: "l2.sleep", version: 1, initial: () => ({ phase: "sleep" }),
	phases: {
		sleep: async (task, runtime, context) => {
			await runtime.sleepUntil(task.input.deadline, { phase: "deliver" }, context);
			await barrier("sleep-committed", { taskId: task.id, deadline: task.input.deadline });
		},
		deliver: async (task, runtime, context) => {
			log({ kind: "sleep-delivered", taskId: task.id, at: runtime.now() });
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
		},
	},
	abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});
const registry = createRegistry();
registry.install(defineExtension({ name: "l2", tools: [Effect], tasks: [Waiter, Sleep] }));
let now = 1_000_000;
const reports: unknown[] = [];
const h = await Harness.open(await openNodeSqliteStorage(join(dir, "store.sqlite")), {
	models, registry, now: () => now,
	// The host explicitly resumes due sleeps; no wall-clock sleep participates in this fixture.
	onWake: () => {},
	settings: { restartLimit: caseName === "park" ? 2 : 5, afterFailedRun: "keep", retry: { maxRetries: 0 } },
	onReport: (error, info) => { reports.push({ error: String(error), info }); },
}, ctx);
h.subscribeCommits((commit) => appendFileSync(join(dir, "commits.jsonl"), JSON.stringify({ mode, ...commit }) + "\n"));
const root = await h.root(ctx, { agent: { model: agent } });
async function snapshot() {
	return {
		inspection: await h.inspect(ctx),
		entries: await root.entries({ order: "ascending" }, 1000, undefined, ctx),
		tasks: await root.commit((tx) => tx.scanTasks({}, 1000), ctx), reports,
	};
}
async function result(value: unknown) {
	await h.close(ctx);
	send({ type: "result", value });
	process.disconnect!();
}

try {
	if (caseName === "admit") {
		const input = { type: "input" as const, content: "/sim tool l2_effect {\"key\":\"admission\"}", requestId: "input-1" };
		const submission = await root.submit(input, ctx);
		if (mode === "seed") {
			saved({ submissionId: submission.id });
			await barrier("admitted", { submissionId: submission.id, before: await snapshot() });
		} else {
			const ids = loadIds();
			assert.equal(submission.id, ids.submissionId);
			assert.equal((await submission.wait(ctx)).status, "done");
			await root.waitForIdle(ctx);
			await result({ sameSubmissionId: submission.id, after: await snapshot() });
		}
	} else if (caseName === "tool-safe" || caseName === "tool-unsafe") {
		if (mode === "seed") {
			const submission = await root.submit({ type: "input", content: "/sim tool l2_effect {\"key\":\"effect-1\"}", requestId: "tool-input" }, ctx);
			saved({ submissionId: submission.id });
			send({ type: "before", value: await snapshot() });
			await submission.wait(ctx);
		} else {
			const submission = await h.submission(loadIds().submissionId, ctx);
			assert.ok(submission);
			h.resume();
			const settled = await submission.wait(ctx);
			await root.waitForIdle(ctx);
			await result({ settled, after: await snapshot() });
		}
	} else if (caseName === "memory-wait" || caseName === "park") {
		let taskId: TaskId<null>;
		if (mode === "seed") {
			taskId = await root.commit((tx) => tx.createTask(Waiter, null, { ownership: { kind: "conversation" }, ...(caseName === "memory-wait" ? { abandonOnRestart: true } : {}) }), ctx);
			saved({ taskId });
			send({ type: "before", value: await snapshot() });
		} else taskId = loadIds().taskId;
		if (caseName === "park" && mode === "recovered") {
			const parked = await snapshot();
			assert.ok(parked.inspection.tasks.some((t) => t.record.id === taskId && t.state.kind === "blocked" && t.state.reason === "restart_limit"));
			const parkedWake = h.wake();
			assert.equal(parkedWake.active, false, "parked work must not demand a restart loop");
			await h.retryTask(taskId, ctx);
			const settled = await h.waitForTask(taskId, ctx);
			await result({ parked, parkedWake, settled, after: await snapshot() });
		} else {
			h.resume();
			const settled = await h.waitForTask(taskId, ctx);
			if (mode !== "seed" && mode !== "recrash") await result({ settled, after: await snapshot() });
		}
	} else if (caseName === "failed-run") {
		if (mode === "seed") {
			const first = await root.submit({ type: "input", content: "fail the first model call", requestId: "failed-1" }, ctx);
			await entered;
			const queued = await root.submit({ type: "input", content: "leave this queued", requestId: "queued-2", whenBusy: "followUp" }, ctx);
			saved({ first: first.id, queued: queued.id });
			send({ type: "before", value: await snapshot() });
			await barrier("inputs-queued", { first: first.id, queued: queued.id });
			await first.wait(ctx);
			await root.waitForIdle(ctx);
			await barrier("failed-run-committed", { first: await first.status(ctx), queued: await queued.status(ctx), before: await snapshot() });
		} else {
			h.resume();
			await root.waitForIdle(ctx);
			const first = await h.submission(loadIds().first, ctx), queued = await h.submission(loadIds().queued, ctx);
			await result({ first: await first!.status(ctx), queued: await queued!.status(ctx), wake: h.wake(), after: await snapshot() });
		}
	} else if (caseName === "sleep") {
		let taskId: TaskId<null>;
		if (mode === "seed") {
			taskId = await root.commit((tx) => tx.createTask(Sleep, { deadline: now + 1000 }, { ownership: { kind: "conversation" } }), ctx);
			saved({ taskId, deadline: now + 1000 });
			h.resume();
			await h.waitForTask(taskId, ctx);
		} else {
			const ids = loadIds();
			taskId = ids.taskId;
			const beforeDue = await snapshot();
			now = ids.deadline - 1;
			h.resume();
			// A Session-line read observes scheduler recovery without advancing the fake clock.
			const beforeDeadline = await snapshot();
			now = ids.deadline;
			h.resume();
			const settled = await h.waitForTask(taskId, ctx);
			await result({ beforeDue, beforeDeadline, deadline: ids.deadline, settled, after: await snapshot() });
		}
	} else throw new Error(`unknown case ${caseName}`);
} catch (error) {
	send({ type: "failure", value: String(error) });
	console.error(error);
	process.exitCode = 1;
	await h.close(ctx);
	process.disconnect!();
}
