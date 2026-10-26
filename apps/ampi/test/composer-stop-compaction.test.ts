import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fixture } from "./composer-fixture.ts";
import { heldSummaries, TestClient } from "./helpers.ts";

test("Stop shows while only a compaction runs; Stop and Esc cancel it and say so", async (t) => {
	const { models, state } = heldSummaries();
	const settings = { retry: { maxRetries: 0 }, compaction: { keepRecentTokens: 256 } };
	const { daemon, wire, threadId, page, input, enter, errors } = await fixture(t, 200, false, false, undefined, { models, plugins: [{ extensions: [], settings }] });
	const node = await TestClient.connect(daemon.socket);
	t.after(() => node.close());
	const answers = async (count: number) => {
		for (let i = 0; i < 200; i++) {
			const history = await node.req("thread.history", { threadId, before: "1000000", limit: 100 });
			if (history.entries.filter((e: any) => e.kind === "assistant" && e.stop === "stop").length >= count && daemon.runtime.threads.value.threads[threadId]?.activity === "idle") return;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		throw new Error(`${count} answers`);
	};
	for (let i = 1; i <= 3; i++) {
		await wire.req("devbox", "thread.submit", { threadId, content: "/sim long 10", requestId: `seed-${i}` });
		await answers(i);
	}
	const stop = page.getByRole("button", { name: "■ Stop", exact: true });
	for (const [held, how] of [[1, "click"], [2, "Escape"]] as const) {
		state.arm();
		await wire.req("devbox", "thread.compact", { threadId });
		for (let i = 0; i < 200 && state.held < held; i++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(state.held, held, "the summary request is held");
		await stop.waitFor();
		assert.equal(await page.getByRole("button", { name: "Queue", exact: true }).count(), 0, "no run: the composer still sends a new turn");
		if (how === "click") await stop.click();
		else await input.press("Escape");
		await page.getByRole("status").filter({ hasText: "Stopped; compaction cancelled, no summary written" }).waitFor();
		await stop.waitFor({ state: "detached" });
		assert.equal(state.aborted, held, `${how} aborted the summary request`);
	}
	const history = await node.req("thread.history", { threadId, before: "1000000", limit: 100 });
	assert.equal(history.entries.filter((e: any) => e.kind === "compaction").length, 0, "no summary is written");
	await enter("//sim long 2");
	await answers(4);
	assert.deepEqual(errors, []);
});

test("a compaction that finishes as Stop lands: the note says its summary stands, and the transcript keeps one summary", async (t) => {
	const { models, state } = heldSummaries();
	const settings = { retry: { maxRetries: 0 }, compaction: { keepRecentTokens: 256 } };
	const { daemon, wire, threadId, page, errors } = await fixture(t, 200, false, false, undefined, { models, plugins: [{ extensions: [], settings }] });
	const node = await TestClient.connect(daemon.socket);
	t.after(() => node.close());
	const history = async () => (await node.req("thread.history", { threadId, before: "1000000", limit: 100 })).entries as any[];
	for (let i = 1; i <= 3; i++) {
		await wire.req("devbox", "thread.submit", { threadId, content: "/sim long 10", requestId: `seed-${i}` });
		for (let j = 0; j < 200 && !((await history()).filter((e) => e.kind === "assistant" && e.stop === "stop").length >= i && daemon.runtime.threads.value.threads[threadId]?.activity === "idle"); j++) await new Promise((resolve) => setTimeout(resolve, 50));
	}
	state.arm();
	const { taskId } = await wire.req("devbox", "thread.compact", { threadId });
	for (let i = 0; i < 200 && state.held < 1; i++) await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(state.held, 1, "the summary request is held");
	for (let i = 0; i < 100 && daemon.runtime.threads.value.threads[threadId]?.activity !== "compacting"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(daemon.runtime.threads.value.threads[threadId]?.activity, "compacting", "a compaction with no run reads as compacting");
	// Stop reads the live compaction; before it stores its intent, the summary request answers and the task ends.
	const harness = (await daemon.runtime.thread(threadId)).store.harness;
	const snapshot = harness.snapshot.bind(harness);
	let finishing = true;
	harness.snapshot = (async (doc: any, ...args: any[]) => {
		const value = await (snapshot as any)(doc, ...args);
		if (finishing && value?.compactions?.length) {
			finishing = false;
			state.release(1);
			await harness.waitForTask(Number(taskId) as never, BACKGROUND_CONTEXT);
		}
		return value;
	}) as typeof harness.snapshot;
	await page.getByRole("button", { name: "■ Stop", exact: true }).click();
	await page.getByRole("status").filter({ hasText: "Stopped; compaction had finished; its summary stands" }).waitFor();
	harness.snapshot = snapshot;
	assert.equal(finishing, false, "the seam ran inside Stop");
	assert.equal(state.aborted, 0);
	assert.equal((await history()).filter((e) => e.kind === "compaction").length, 1, "the transcript shows one summary");
	assert.deepEqual(errors, []);
});

test("a compaction that ignores its abort past Stop's wait: the note says Stop is still stopping", async (t) => {
	const { models, state } = heldSummaries();
	const settings = { retry: { maxRetries: 0 }, compaction: { keepRecentTokens: 256 } };
	const { daemon, wire, threadId, page, errors } = await fixture(t, 200, false, false, undefined, { models, stopWaitMs: 300, plugins: [{ extensions: [], settings }] });
	t.after(() => state.releaseAll());
	const node = await TestClient.connect(daemon.socket);
	t.after(() => node.close());
	const history = async () => (await node.req("thread.history", { threadId, before: "1000000", limit: 100 })).entries as any[];
	for (let i = 1; i <= 3; i++) {
		await wire.req("devbox", "thread.submit", { threadId, content: "/sim long 10", requestId: `seed-${i}` });
		for (let j = 0; j < 200 && !((await history()).filter((e) => e.kind === "assistant" && e.stop === "stop").length >= i && daemon.runtime.threads.value.threads[threadId]?.activity === "idle"); j++) await new Promise((resolve) => setTimeout(resolve, 50));
	}
	state.arm("uncooperative");
	await wire.req("devbox", "thread.compact", { threadId });
	for (let i = 0; i < 200 && state.held < 1; i++) await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(state.held, 1, "the summary request is held");
	await page.getByRole("button", { name: "■ Stop", exact: true }).click();
	const note = page.getByRole("status").filter({ hasText: "Stop requested; still stopping" });
	await note.waitFor();
	assert.doesNotMatch(await note.innerText(), /cancelled|stands/, "the note claims no outcome it did not confirm");
	state.release(1);
	await page.getByRole("button", { name: "■ Stop", exact: true }).waitFor({ state: "detached" });
	assert.equal((await history()).filter((e) => e.kind === "compaction").length, 0, "the abort-marked compaction writes no summary");
	assert.deepEqual(errors, []);
});
