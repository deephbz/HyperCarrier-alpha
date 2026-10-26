import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { TeamDoc } from "@hypercarrier/pi-team-durable/authority";
import { runDaemon } from "../src/node/daemon.ts";
import { hydrate } from "../src/plugins.ts";
import { TestClient, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };
type Outcome = { value: unknown; error?: undefined; message?: undefined } | { value?: undefined; error: string | undefined; message: string | undefined };
const refused = (promise: Promise<unknown>): Promise<Outcome> => promise.then((value) => ({ value }), (error: { code?: string; message?: string }) => ({ error: error.code, message: error.message }));

/** A lead with one Team Worker, both idle. */
async function team(home: string, name: string) {
	const daemon = await runDaemon({ home, simTokensPerSecond: 20000, plugins: await hydrate() });
	const client = await TestClient.connect(daemon.socket);
	const { threadId } = await client.req<{ threadId: string }>("thread.create", {
		cwd: home,
		model: SIM,
		prompt: `/sim tool team_create {"name":"${name}","purpose":"Check Close of owned threads"}\n/sim tool ensure_worker {"name":"builder","scope":"Build"}`,
	});
	const view = client.sub({ kind: "thread", threadId });
	await client.until<any>(view, (v) => v.entries.filter((e: any) => e.kind === "tool-result").length >= 2 && !v.live?.run, 15000);
	const thread = await daemon.runtime.thread(threadId);
	const doc = (await thread.store.harness.snapshot(TeamDoc, context)) as any;
	const worker = doc.current.workers.builder;
	return { daemon, client, threadId, thread, workerConversation: String(worker.conversationId), workerId: thread.store.threadKey(worker.conversationId) };
}

test("after a lead Close, every admission into its Worker answers closed and its history stays readable", async () => {
	const home = tempHome();
	const { daemon, client, threadId, workerId } = await team(home, "close-owned");
	try {
		await client.req("thread.submit", { threadId: workerId, content: "A turn before Close" });
		await client.until<any>(client.sub({ kind: "thread", threadId: workerId }), (v) => v.entries.some((e: any) => e.kind === "assistant") && !v.live?.run, 15000);
		await client.req("thread.close", { threadId });
		const attempts = {
			submit: await refused(client.req("thread.submit", { threadId: workerId, content: "Must stay closed" })),
			command: await refused(client.req("thread.command", { threadId: workerId, name: "compact" })),
			compact: await refused(client.req("thread.compact", { threadId: workerId })),
			configure: await refused(client.req("thread.configure", { threadId: workerId, thinkingLevel: "low" })),
		};
		for (const [op, outcome] of Object.entries(attempts)) {
			assert.equal((outcome as { error?: string }).error, "closed", `${op}: ${JSON.stringify(outcome)}`);
			assert.equal((outcome as { message: string }).message, "This Worker's lead is closed; it is read-only. Fork it to continue.");
		}
		const threads = client.sub({ kind: "threads" });
		const row = (await client.until<any>(threads, (v) => v.threads[workerId]?.closed)).threads[workerId];
		assert.equal(row.closed.by, "lead");
		assert.equal(row.live, false);
		const history = await client.req<{ entries: unknown[] }>("thread.history", { threadId: workerId, before: String(Number.MAX_SAFE_INTEGER) });
		assert.ok(history.entries.length > 0);
	} finally {
		client.close();
		await daemon.stop();
	}
});

test("a Worker submit that races its lead's Close is refused or aborted, never left running", async () => {
	const home = tempHome();
	const { daemon, client, threadId, thread, workerId } = await team(home, "close-race");
	try {
		const [, submit] = await Promise.all([client.req("thread.close", { threadId }), refused(client.req<{ submission?: string; evidence?: string }>("thread.submit", { threadId: workerId, content: "/sim long 4000" }))]);
		if (submit.error !== undefined) assert.equal(submit.error, "closed", JSON.stringify(submit));
		else {
			const submission = await thread.store.harness.submission((submit.value as { submission: string }).submission as never, context);
			assert.equal((await submission!.wait(context)).status, "unanswered");
		}
		assert.equal((await refused(client.req("thread.submit", { threadId: workerId, content: "later" }))).error, "closed");
	} finally {
		client.close();
		await daemon.stop();
	}
});

test("a Team delivery that reaches the Worker after its lead's Close is aborted without a model call", async () => {
	const home = tempHome();
	const { daemon, client, threadId, thread, workerConversation, workerId } = await team(home, "close-delivery");
	try {
		await client.req("thread.close", { threadId });
		// The harness-level submit of durable-team's Deliver, past its eligibility commit; admit never sees it.
		const target = await thread.store.harness.conversation(Number(workerConversation) as ConversationId, context);
		const late = await refused(
			target!.submit({ type: "input", content: "/sim long 4000", whenBusy: "followUp", requestId: "ptb:late", entry: { kind: "team.notice", data: { source: "team", deliveryId: "late", epoch: 1 } } } as never, context),
		);
		if (late.error === undefined) {
			const wait = (late.value as { wait(context: unknown): Promise<{ status: string }> }).wait(context);
			const settled = await Promise.race([wait, new Promise<{ status: string }>((resolve) => setTimeout(() => resolve({ status: "still held after 15 s" }), 15000).unref())]);
			assert.equal(settled.status, "unanswered");
		}
		const threads = client.sub({ kind: "threads" });
		await client.until<any>(threads, (v) => v.threads[workerId]?.activity === "idle", 15000);
		const history = await client.req<{ entries: any[] }>("thread.history", { threadId: workerId, before: String(Number.MAX_SAFE_INTEGER) });
		assert.ok(!history.entries.some((e) => e.kind === "assistant" && JSON.stringify(e).includes("long")), "the late delivery reached the model");
	} finally {
		client.close();
		await daemon.stop();
	}
});

test("a second late delivery that arrives while the first sweep settles is also aborted", async () => {
	const home = tempHome();
	const { daemon, client, threadId, thread, workerConversation } = await team(home, "close-delivery-two");
	try {
		await client.req("thread.close", { threadId });
		const { harness } = thread.store;
		const target = await harness.conversation(Number(workerConversation) as ConversationId, context);
		const late = (n: number) =>
			target!.submit({ type: "input", content: "/sim long 4000", whenBusy: "followUp", requestId: `ptb:late-${n}`, entry: { kind: "team.notice", data: { source: "team", deliveryId: `late-${n}`, epoch: 1 } } } as never, context) as Promise<any>;
		// The first sweep's settle has aborted the conversation and seen its task end, and still holds the sweep: the
		// second input arrives now, and its refresh runs before the settle returns.
		let second: Promise<any> | undefined;
		const waitForTask = harness.waitForTask.bind(harness);
		harness.waitForTask = (async (...args: Parameters<typeof waitForTask>) => {
			const ended = await waitForTask(...args);
			if (!second) {
				harness.waitForTask = waitForTask;
				second = late(2);
				await second;
				await new Promise((resolve) => setTimeout(resolve, 600));
			}
			return ended;
		}) as typeof harness.waitForTask;
		const first = await late(1);
		const settled = (submission: any) =>
			Promise.race([submission.wait(context), new Promise<{ status: string }>((resolve) => setTimeout(() => resolve({ status: "still held after 15 s" }), 15000).unref())]);
		assert.equal((await settled(first)).status, "unanswered");
		for (let i = 0; i < 100 && !second; i++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(second, "the first sweep settled no task");
		assert.equal((await settled(await second)).status, "unanswered");
		const inspection = await harness.inspect(context);
		assert.deepEqual(inspection.tasks.filter(({ record }: any) => String(record.conversationId) === workerConversation && record.state.status !== "terminal").map(({ record }: any) => String(record.id)), []);
	} finally {
		client.close();
		await daemon.stop();
	}
});

test("the Worker of a closed lead stays closed after a restart, and an ownerless fork of the lead stays open", async () => {
	const home = tempHome();
	const first = await team(home, "close-restart");
	const { threadId, workerId } = first;
	const history = await first.client.req<{ entries: any[] }>("thread.history", { threadId, before: String(Number.MAX_SAFE_INTEGER) });
	await first.client.req("thread.close", { threadId });
	first.client.close();
	await first.daemon.stop();
	const daemon = await runDaemon({ home, simTokensPerSecond: 20000, plugins: await hydrate() });
	const client = await TestClient.connect(daemon.socket);
	try {
		const submit = await refused(client.req("thread.submit", { threadId: workerId, content: "Must stay closed" }));
		assert.equal(submit.error, "closed", JSON.stringify(submit));
		const row = (await client.until<any>(client.sub({ kind: "threads" }), (v) => v.threads[workerId]?.closed)).threads[workerId];
		assert.deepEqual([row.closed.by, row.live], ["lead", false], "the Worker's row reports the lead's Close after a restart");
		const fork = await client.req<{ threadId: string }>("thread.fork", { threadId, entryId: String(history.entries.at(-1).id) });
		const started = await client.req<{ evidence: string }>("thread.submit", { threadId: fork.threadId, content: "The fork is independent" });
		assert.equal(started.evidence, "started");
	} finally {
		client.close();
		await daemon.stop();
	}
});
