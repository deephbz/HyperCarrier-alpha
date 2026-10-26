import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { TeamDoc } from "@hypercarrier/pi-team-durable/authority";
import { hydrate } from "../src/plugins.ts";
import { fixture } from "./composer-fixture.ts";

test("a Worker of a closed lead opens read-only: Closed with its lead, disabled controls, and keys send nothing", async (t) => {
	const { daemon, wire, threadId, page, sent, errors, origin } = await fixture(t, 20000, false, false, undefined, { plugins: await hydrate() });
	await wire.req("devbox", "thread.submit", {
		threadId,
		content: '/sim tool team_create {"name":"closed-worker","purpose":"Check the closed Worker composer"}\n/sim tool ensure_worker {"name":"builder","scope":"Build"}',
	});
	const thread = await daemon.runtime.thread(threadId);
	let workerId: string | undefined;
	for (let i = 0; i < 300 && !(workerId && daemon.runtime.threads.value.threads[threadId]?.activity === "idle"); i++) {
		const team = (await thread.store.harness.snapshot(TeamDoc, context)) as any;
		const worker = team?.current?.workers?.builder;
		if (worker) workerId = thread.store.threadKey(worker.conversationId);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.ok(workerId, "the lead created its Worker");
	await wire.req("devbox", "thread.close", { threadId });
	// ThreadView passes the Worker's summary row to its composer.
	await page.goto(`${origin}/?thread=${encodeURIComponent(workerId)}&summary=1`);
	await page.getByRole("status").filter({ hasText: "Archived. Unarchive to continue." }).waitFor();
	const input = page.getByRole("textbox", { name: "Message the agent" });
	assert.equal(await input.isDisabled(), true);
	for (const title of ["Model", "Thinking level"]) assert.equal(await page.locator(`select[title="${title}"]`).isDisabled(), true, `${title} is disabled`);
	const before = sent.length;
	for (const key of ["Enter", "Alt+Enter", "Escape", "Control+Enter"]) await page.keyboard.press(key);
	await page.waitForTimeout(300);
	const ops = sent.slice(before).map((frame) => frame.op).filter((op) => op && !op.startsWith("sub"));
	assert.deepEqual(ops, [], "a key press on the closed Worker sends no node op");
	assert.deepEqual(errors, []);
	assert.equal(await page.locator(".composer-feedback.error, [role=alert]").count(), 0, "no error feedback");
});
