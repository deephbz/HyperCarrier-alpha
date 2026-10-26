import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { deliveryDraft, pageDraft, TASK_ID_MAX_LENGTH } from "@hypercarrier/pi-team-durable/authority";
import { runDaemon } from "../src/node/daemon.ts";
import { queueOrigin, TEAM_TASK_ID_LIMIT } from "../src/node/projection.ts";
import { teamBadge } from "../src/shared/team-origin.ts";
import { TestClient, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };

/**
 * A busy thread with the inputs durable-team really submits queued beside an owner steer: a Task, an Alert, a stop,
 * a notifier page and a legacy delivery whose entry data predates `delivery` and `sender`.
 */
async function busyWithTeamInputs(label: string) {
	const home = tempHome();
	const daemon = await runDaemon({ home });
	const client = await TestClient.connect(daemon.socket);
	const threads = client.sub({ kind: "threads" });
	const { threadId } = await client.req("thread.create", { requestId: label, cwd: home, model: SIM, place: { workspace: "new", label } });
	const view = client.sub({ kind: "thread", threadId });
	await client.req("thread.submit", { threadId, content: "/sim long 200" });
	await client.until<any>(threads, (v) => v.threads[threadId]?.activity === "streaming");
	const owner = await client.req("thread.submit", { threadId, content: "owner steer", whenBusy: "steer" });
	const { conversation } = await daemon.runtime.thread(threadId);
	const base = { epoch: "e1", conversationId: 1 as never };
	const drafts = {
		task: deliveryDraft({ ...base, key: "k-task", whenBusy: "followUp", kind: "task", sender: "team-lead", content: JSON.stringify({ kind: "task", task: { id: "t1", title: "Ship the endpoint\nwith tests", version: "v1" } }) }),
		alert: deliveryDraft({ ...base, key: "k-alert", whenBusy: "steer", kind: "alert", sender: "reviewer", content: JSON.stringify({ kind: "alert", alert: { id: "a1", from: "reviewer", kind: "attention", text: "Check the gate\n{\"detail\":1}" } }) }),
		stop: deliveryDraft({ ...base, key: "k-stop", whenBusy: "steer", kind: "stop", sender: "team-lead", content: JSON.stringify({ kind: "task_changed", task_id: "t1", message: "The previous Attempt was superseded." }) }),
		page: pageDraft({ id: "e1:notify:1:1", epoch: "e1", lead: 1, carrier: { kind: "input", text: JSON.stringify({ kind: "team_update", page_id: "e1:notify:1:1", result: {} }) } } as never),
		legacy: deliveryDraft({ ...base, key: "k-old", whenBusy: "steer", content: JSON.stringify({ kind: "task", task: { id: "t0", title: "Old title" } }) }),
	};
	const ids: Record<string, string> = { owner: owner.submission };
	for (const [name, draft] of Object.entries(drafts)) ids[name] = String((await conversation.submit(draft as never, BACKGROUND_CONTEXT)).id);
	const queued = await client.until<any>(view, (v) => v.inbox.items.filter((i: any) => i.state === "queued").length === 6);
	const byId = (v: any) => new Map<string, any>(v.inbox.items.map((i: any) => [i.id, i]));
	const stop = async () => {
		client.close();
		await daemon.stop();
	};
	return { client, threadId, view, threads, ids, queued, byId, stop };
}

const ORIGINS = {
	task: { kind: "team", delivery: "task", sender: "team-lead", summary: "Ship the endpoint", taskId: "t1" },
	alert: { kind: "team", delivery: "alert", sender: "reviewer", summary: "Check the gate" },
	stop: { kind: "team", delivery: "stop", sender: "team-lead", summary: "Attempt superseded; re-read Task t1", taskId: "t1" },
	page: { kind: "team", delivery: "update", sender: "durable-team", summary: "Team update" },
	legacy: { kind: "team", delivery: "notice", summary: "Team notice" },
};

test("queued Team inputs carry their origin from entry data; the node refuses editing or withdrawing them", async () => {
	const t = await busyWithTeamInputs("origin");
	try {
		const { client, threadId, ids } = t;
		const items = t.byId(t.queued);
		assert.equal(items.get(ids.owner).origin, undefined, "owner input has no origin");
		for (const [name, origin] of Object.entries(ORIGINS)) {
			assert.deepEqual(items.get(ids[name]!).origin, origin, `${name}: origin`);
			assert.ok(!origin.summary.includes("{"), `${name}: the summary shows no JSON`);
		}
		// A stale client still offers Edit and ×; withdrawing would settle the delivery unanswered with no resend.
		await assert.rejects(client.req("thread.editQueued", { threadId, submissionId: ids.task, editId: "x1", expected: items.get(ids.task).content, text: "owner text" }), (e: any) => e.code === "bad_request" && /Team input/.test(e.message));
		await assert.rejects(client.req("thread.withdraw", { threadId, submissionId: ids.alert }), (e: any) => e.code === "bad_request" && /Team input/.test(e.message));
		await assert.rejects(client.req("thread.withdraw", { threadId, submissionId: ids.legacy }), (e: any) => e.code === "bad_request");
		const after = t.byId(await t.client.until<any>(t.view, () => true));
		for (const name of ["task", "alert", "legacy"]) assert.equal(after.get(ids[name]!)?.state, "queued", `${name} stays queued`);
		assert.deepEqual(await client.req("thread.editQueued", { threadId, submissionId: ids.owner, editId: "x2", expected: "owner steer", text: "owner edited" }), { edited: true }, "owner input stays editable");
	} finally {
		await t.stop();
	}
});

test("Esc returns Team inputs with their origin and no text; the returned record keeps it, and Dismiss removes only the record", async () => {
	const t = await busyWithTeamInputs("esc");
	try {
		const { client, threadId, ids } = t;
		const ack = await client.req("thread.abort", { threadId });
		const sub = new Map<string, any>(ack.submissions.map((s: any) => [s.submission, s]));
		assert.equal(sub.get(ids.owner).text, "owner steer", "owner text returns for the composer");
		for (const [name, origin] of Object.entries(ORIGINS)) {
			assert.deepEqual([sub.get(ids[name]!).state, sub.get(ids[name]!).origin, sub.get(ids[name]!).text], ["returned", origin, undefined], `${name}: returned with origin and no text to restore`);
		}
		const returned = t.byId(await client.until<any>(t.view, (v) => v.inbox.items.length === 6 && v.inbox.items.every((i: any) => i.state === "returned")));
		for (const [name, origin] of Object.entries(ORIGINS)) assert.deepEqual(returned.get(ids[name]!).origin, origin, `${name}: the returned record keeps its origin`);
		assert.equal(returned.get(ids.owner).origin, undefined);
		assert.deepEqual(await client.req("thread.withdraw", { threadId, submissionId: ids.alert }), { withdrawn: true }, "a returned Team record can be dismissed");
		const left = await client.until<any>(t.view, (v) => v.inbox.items.length === 5);
		assert.ok(!left.inbox.items.some((i: any) => i.id === ids.alert));
	} finally {
		await t.stop();
	}
});

test("Close returns queued Team inputs with their origin and no text", async () => {
	const t = await busyWithTeamInputs("close");
	try {
		const ack = await t.client.req("thread.close", { threadId: t.threadId });
		const sub = new Map<string, any>(ack.submissions.map((s: any) => [s.submission, s]));
		assert.equal(sub.get(t.ids.owner).text, "owner steer");
		for (const [name, origin] of Object.entries(ORIGINS)) assert.deepEqual([sub.get(t.ids[name]!).origin, sub.get(t.ids[name]!).text], [origin, undefined], name);
	} finally {
		await t.stop();
	}
});

test("a Team origin names the exact Task ID up to durable-team's limit and omits an invalid one", () => {
	assert.equal(TEAM_TASK_ID_LIMIT, TASK_ID_MAX_LENGTH, "the copied limit matches durable-team's");
	const entry = (delivery: string) => ({ kind: "team.notice", data: { source: "team", deliveryId: "k", epoch: "e1", delivery, sender: "team-lead" } });
	const task = (id: unknown) => queueOrigin(entry("task"), JSON.stringify({ kind: "task", task: { id } }));
	const stop = (id: unknown) => queueOrigin(entry("stop"), JSON.stringify({ kind: "task_changed", task_id: id }));
	for (const id of ["t".repeat(65), "t".repeat(TASK_ID_MAX_LENGTH)]) {
		assert.equal(task(id)?.taskId, id, `a ${id.length}-character Task ID stays exact`);
		assert.equal(task(id)?.summary, `Task ${id}`);
		assert.deepEqual([stop(id)?.taskId, stop(id)?.summary], [id, `Attempt superseded; re-read Task ${id}`]);
	}
	for (const id of ["t".repeat(TASK_ID_MAX_LENGTH + 1), "", 7]) {
		assert.equal(task(id)?.taskId, undefined, `an invalid Task ID (${JSON.stringify(id).slice(0, 12)}) is omitted`);
		assert.equal(task(id)?.summary, "Team notice");
		assert.deepEqual([stop(id)?.taskId, stop(id)?.summary], [undefined, "Attempt superseded; re-read Task authority"]);
	}
});

test("an interrupt Alert's origin names the interrupt from entry data; the badge reads alert · interrupt", () => {
	const data = { source: "team", deliveryId: "k", epoch: "e1", delivery: "alert", sender: "reviewer" };
	const content = JSON.stringify({ kind: "alert", alert: { from: "reviewer", text: "Stop the gate" }, interruption: { outcome: "interrupted", message: "The captured run was interrupted." } });
	const origin = queueOrigin({ kind: "team.notice", data: { ...data, interrupt: true } }, content);
	assert.deepEqual(origin, { kind: "team", delivery: "alert", interrupt: true, sender: "reviewer", summary: "Stop the gate" });
	assert.equal(teamBadge(origin!), "alert · interrupt");
	const plain = queueOrigin({ kind: "team.notice", data }, content)!;
	assert.equal(plain.interrupt, undefined, "only the entry data names an interrupt, never the content");
	assert.equal(teamBadge(plain), "alert");
	assert.equal(queueOrigin({ kind: "team.notice", data: { ...data, delivery: "task", interrupt: true } }, "{}")?.interrupt, undefined, "only an Alert interrupts");
});
