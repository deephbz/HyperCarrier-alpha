import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runDaemon } from "../src/node/daemon.ts";
import { TestClient, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==";

test("control: submit evidence, request-ID retry, and Esc returning queued text and image counts in Pi's shape", async () => {
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 200 });
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		assert.equal((await client.until<any>(threads, (v) => v.backend !== undefined)).backend, "durable");
		const { threadId } = await client.req("thread.create", { requestId: "control-a", cwd: home, model: SIM, place: { workspace: "new", label: "Work" } });

		assert.deepEqual(await client.req("thread.abort", { threadId }), { via: "node", evidence: "idle" }, "Esc on an idle thread");
		const first = await client.req("thread.submit", { threadId, content: "/sim long 200", requestId: "r1" });
		assert.equal(first.evidence, "started", "idle submit starts a run");
		assert.equal((await client.req("thread.submit", { threadId, content: "/sim long 200", requestId: "r1" })).submission, first.submission, "a retried request ID returns the first submission");
		await client.until<any>(threads, (v) => v.threads[threadId]?.activity === "streaming");

		const steer = await client.req("thread.submit", { threadId, content: "steer text", whenBusy: "steer" });
		const follow = await client.req("thread.submit", { threadId, content: "follow text", images: [{ data: PNG, mimeType: "image/png" }], whenBusy: "followUp" });
		assert.deepEqual([steer.via, steer.evidence, follow.evidence], ["node", "admitted", "admitted"]);
		// Pi returns text only: each projection keeps the image count, so the owner knows to attach the image again.
		const view = client.sub({ kind: "thread", threadId });
		const queued = await client.until<any>(view, (v) => v.inbox?.items.length === 2);
		assert.deepEqual(queued.inbox.items.map((i: any) => [i.state, i.images]), [["queued", undefined], ["queued", 1]]);

		const ack = await client.req("thread.abort", { threadId });
		assert.equal(ack.via, "node");
		assert.equal(ack.evidence, "aborted");
		assert.deepEqual(
			ack.submissions.map((s: any) => ({ submission: s.submission, deliverAs: s.deliverAs, state: s.state, text: s.text, images: s.images, at: typeof s.at })),
			[
				{ submission: steer.submission, deliverAs: "steer", state: "returned", text: "steer text", images: undefined, at: "number" },
				{ submission: follow.submission, deliverAs: "followUp", state: "returned", text: "follow text", images: 1, at: "number" },
			],
		);
		const idle = await client.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId].queued === 0);
		assert.equal(idle.threads[threadId].queued, 0, "withdrawn inputs leave the queue");

		// Esc keeps the returned text in the inbox, as Pi does, until the owner dismisses it.
		const returned = await client.until<any>(view, (v) => v.inbox?.items.length === 2 && v.inbox.items.every((i: any) => i.state === "returned"));
		assert.deepEqual(
			returned.inbox.items.map((i: any) => [i.id, i.mode, i.content, i.state, i.images]),
			[
				[steer.submission, "steer", "steer text", "returned", undefined],
				[follow.submission, "followUp", "follow text", "returned", 1],
			],
		);
		assert.equal(returned.live.run, undefined, "an aborted thread has no run");
		assert.deepEqual(await client.req("thread.withdraw", { threadId, submissionId: steer.submission }), { withdrawn: true });
		const left = await client.until<any>(view, (v) => v.inbox.items.length === 1);
		assert.equal(left.inbox.items[0].id, follow.submission, "withdraw dismisses only the named item");

		const textOnly = daemon.runtime.models.getModels().find((m) => !(m.input ?? ["text"]).includes("image"))!;
		await client.req("thread.configure", { threadId, model: { provider: textOnly.provider, modelId: textOnly.id } });
		await assert.rejects(
			client.req("thread.submit", { threadId, content: "look", images: [{ data: PNG, mimeType: "image/png" }] }),
			/does not accept images/,
			"a text-only model refuses images before they are stored",
		);
		client.close();
	} finally {
		await daemon.stop();
	}
});
