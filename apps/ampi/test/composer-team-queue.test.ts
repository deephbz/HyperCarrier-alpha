import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { deliveryDraft } from "@hypercarrier/pi-team-durable/authority";
import { fixture } from "./composer-fixture.ts";

test("a durable Worker's queued Task and Alert render as read-only Team rows; Esc restores none of them into the composer", async (t) => {
	const { daemon, threadId, page, input, enter, errors } = await fixture(t, 200);
	await enter("//sim long 20");
	await page.getByRole("button", { name: "■ Stop", exact: true }).waitFor();
	await input.fill("Owner queued");
	await input.press("Alt+Enter");
	await page.locator(".queue-item .text").getByText("Owner queued", { exact: true }).waitFor();
	// The inputs durable-team submits to a Worker: a Task as a follow-up, an Alert as a steer.
	const { conversation } = await daemon.runtime.thread(threadId);
	const base = { epoch: "e1", conversationId: 1 as never };
	await conversation.submit(deliveryDraft({ ...base, key: "k-task", whenBusy: "followUp", kind: "task", sender: "team-lead", content: JSON.stringify({ kind: "task", task: { id: "t1", title: "Ship the endpoint", version: "v1" } }) }) as never, BACKGROUND_CONTEXT);
	await conversation.submit(deliveryDraft({ ...base, key: "k-alert", whenBusy: "steer", kind: "alert", sender: "reviewer", content: JSON.stringify({ kind: "alert", alert: { id: "a1", from: "reviewer", kind: "attention", text: "Check the gate\nmore" } }) }) as never, BACKGROUND_CONTEXT);

	const team = page.locator(".queue-item.team");
	await team.nth(1).waitFor();
	const rows = await team.evaluateAll((items) => items.map((item) => ({
		badge: item.querySelector(".badge")?.textContent,
		sender: item.querySelector(".notice-sender")?.textContent,
		summary: item.querySelector(".notice-first")?.textContent,
		title: item.getAttribute("title"),
		buttons: item.querySelectorAll("button").length,
	})));
	assert.deepEqual(rows.sort((a, b) => String(a.badge).localeCompare(String(b.badge))), [
		{ badge: "alert", sender: "reviewer", summary: "Check the gate", title: "Check the gate", buttons: 0 },
		{ badge: "task", sender: "team-lead", summary: "Ship the endpoint", title: "Ship the endpoint", buttons: 0 },
	], "badge, real sender and readable summary; no Edit, Edit here or ×; no JSON in the title");
	const owner = page.locator(".queue-item:not(.team)");
	assert.deepEqual(await owner.locator("button").allTextContents(), ["Edit", "×"], "the owner row keeps its controls");

	await input.fill("Unsent draft");
	await input.press("Escape");
	await page.getByRole("status").filter({ hasText: "2 Team inputs not sent · durable-team does not resend it" }).waitFor();
	// Stop settles each delivery unanswered and durable-team does not resend it (delivery.ts settle, scheduleDeliveries).
	assert.equal(await input.inputValue(), "Owner queued\n\nUnsent draft", "only the owner's own text returns to the composer");
	const returned = page.locator(".queue-item.team.settled");
	await returned.nth(1).waitFor();
	// Each returned row says what to do. A Task stays readable, and a lead revision makes a new version that durable-team
	// delivers (tools.ts reconcile keys a Task delivery by ID and version). An Alert is delivered once per Alert ID.
	assert.deepEqual((await returned.locator(".outcome").allTextContents()).sort(), [
		"not sent · durable-team does not resend it; ask the lead to resend",
		"not sent · the Worker can still read Task t1; the lead may resend it",
	]);
	assert.deepEqual(await returned.locator("button").evaluateAll((b) => b.map((x) => x.getAttribute("title"))), ["Dismiss", "Dismiss"], "a returned Team row offers only Dismiss");
	await returned.filter({ hasText: "Check the gate" }).getByRole("button", { name: "×" }).click();
	await page.locator(".queue-item.team.settled").filter({ hasText: "Check the gate" }).waitFor({ state: "detached" });
	assert.equal(await page.locator(".queue-item.team.settled").count(), 1, "Dismiss removed only that record");
	assert.deepEqual(errors, []);
});
