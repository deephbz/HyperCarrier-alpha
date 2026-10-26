import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runDaemon } from "../src/node/daemon.ts";
import { TestClient, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==";

async function thread(tps: number) {
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: tps });
	const client = await TestClient.connect(daemon.socket);
	const threads = client.sub({ kind: "threads" });
	const { threadId } = await client.req("thread.create", { requestId: `edit-${tps}`, cwd: home, model: SIM, place: { workspace: "new", label: "Work" } });
	const view = client.sub({ kind: "thread", threadId });
	const users = (v: any): string[] => (v.entries ?? []).filter((e: any) => e.kind === "user").map((e: any) => e.text);
	const idle = () => client.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId].queued === 0, 10_000);
	const stop = async () => {
		client.close();
		await daemon.stop();
	};
	return { client, threadId, view, users, idle, stop };
}

test("an edit replaces a queued steer and follow-up in place; the run places only the edited text", async () => {
	const t = await thread(400);
	try {
		const { client, threadId, view } = t;
		await client.req("thread.submit", { threadId, content: "/sim long 3" });
		const steer = await client.req("thread.submit", { threadId, content: "steer old", whenBusy: "steer" });
		const follow = await client.req("thread.submit", { threadId, content: "follow old", whenBusy: "followUp" });
		const after = await client.req("thread.submit", { threadId, content: "follow after", whenBusy: "followUp" });
		assert.deepEqual([steer.evidence, follow.evidence, after.evidence], ["admitted", "admitted", "admitted"]);

		assert.deepEqual(await client.req("thread.editQueued", { threadId, submissionId: steer.submission, editId: "e1", expected: "steer old", text: "steer new" }), { edited: true });
		assert.deepEqual(await client.req("thread.editQueued", { threadId, submissionId: follow.submission, editId: "e2", expected: "follow old", text: "follow new" }), { edited: true });
		const queued = await client.until<any>(view, (v) => v.inbox.items.some((i: any) => i.content === "follow new"));
		assert.deepEqual(
			queued.inbox.items.map((i: any) => [i.id, i.mode, i.content, i.state]),
			[
				[steer.submission, "steer", "steer new", "queued"],
				[follow.submission, "followUp", "follow new", "queued"],
				[after.submission, "followUp", "follow after", "queued"],
			],
			"each item keeps its ID, mode and place",
		);

		await t.idle();
		const placed = t.users(await client.until<any>(view, (v) => t.users(v).includes("follow after")));
		assert.deepEqual(placed, ["/sim long 3", "steer new", "follow new", "follow after"], "the run placed the edited texts once, in queue order, and never the old ones");
	} finally {
		await t.stop();
	}
});

test("an item the run took before the edit answers taken; nothing is sent and the old text stays placed once", async () => {
	const t = await thread(4000);
	try {
		const { client, threadId, view } = t;
		await client.req("thread.submit", { threadId, content: "/sim long 2" });
		const follow = await client.req("thread.submit", { threadId, content: "follow old", whenBusy: "followUp" });
		// The owner opened the editor on "follow old"; the run takes the item before the owner saves.
		await client.until<any>(view, (v) => t.users(v).includes("follow old"), 10_000);
		await t.idle();
		assert.deepEqual(await client.req("thread.editQueued", { threadId, submissionId: follow.submission, editId: "e3", expected: "follow old", text: "follow new" }), { edited: false, reason: "taken" });
		await new Promise((resolve) => setTimeout(resolve, 200));
		const now = await t.idle();
		assert.equal(now.threads[threadId].queued, 0, "the failed edit queued nothing");
		assert.deepEqual(t.users(await client.until<any>(view, () => true)), ["/sim long 2", "follow old"], "the edited text was not sent");
	} finally {
		await t.stop();
	}
});

// Eight rounds move the edit from before the boundary to after it; both outcomes occur at normal load.
test("an edit racing the run's boundary either replaces the text or answers taken: no loss, no duplicate", async () => {
	const t = await thread(6000);
	try {
		const { client, threadId, view } = t;
		for (let round = 0; round < 8; round++) {
			await client.req("thread.submit", { threadId, content: "/sim long 1" });
			const follow = await client.req("thread.submit", { threadId, content: `old ${round}`, whenBusy: "followUp" });
			await new Promise((resolve) => setTimeout(resolve, round * 12));
			const result = await client.req("thread.editQueued", { threadId, submissionId: follow.submission, editId: `race ${round}`, expected: `old ${round}`, text: `new ${round}` });
			await t.idle();
			const users = t.users(await client.until<any>(view, (v) => t.users(v).some((text) => text === `old ${round}` || text === `new ${round}`)));
			const olds = users.filter((text) => text === `old ${round}`).length;
			const news = users.filter((text) => text === `new ${round}`).length;
			assert.equal(olds + news, 1, `round ${round}: exactly one copy was placed (old ${olds}, new ${news})`);
			assert.equal(news, result.edited ? 1 : 0, `round ${round}: the placed copy matches the answer ${JSON.stringify(result)}`);
			if (!result.edited) assert.equal(result.reason, "taken");
		}
	} finally {
		await t.stop();
	}
});

test("a stale expected text answers changed; a retry is idempotent; images stay; an unknown item answers taken; empty text is refused", async () => {
	const t = await thread(300);
	try {
		const { client, threadId, view } = t;
		await client.req("thread.submit", { threadId, content: "/sim long 2" });
		const follow = await client.req("thread.submit", { threadId, content: "look at this", whenBusy: "followUp", images: [{ data: PNG, mimeType: "image/png" }] });
		assert.deepEqual(await client.req("thread.editQueued", { threadId, submissionId: follow.submission, editId: "e5", expected: "look at this", text: "first edit" }), { edited: true });
		assert.deepEqual(
			await client.req("thread.editQueued", { threadId, submissionId: follow.submission, editId: "e6", expected: "look at this", text: "second edit" }),
			{ edited: false, reason: "changed" },
			"a second editor that saw the old text does not overwrite the first edit",
		);
		assert.deepEqual(
			await client.req("thread.editQueued", { threadId, submissionId: follow.submission, editId: "e7", expected: "look at this", text: "first edit" }),
			{ edited: true },
			"a retry of a landed edit answers edited, so the caller does not keep a second copy",
		);
		assert.deepEqual(await client.req("thread.editQueued", { threadId, submissionId: "999999", editId: "e8", expected: "x", text: "y" }), { edited: false, reason: "taken" });
		await assert.rejects(client.req("thread.editQueued", { threadId, submissionId: follow.submission, editId: "e9", expected: "first edit", text: "  " }), /cannot be empty/);

		await t.idle();
		const entry = (await client.until<any>(view, (v) => t.users(v).includes("first edit"))).entries.find((e: any) => e.kind === "user" && e.text === "first edit");
		assert.equal(entry.images, 1, "the edit kept the image");
		assert.ok(!t.users(await client.until<any>(view, () => true)).some((text) => text === "second edit" || text === "look at this"));
	} finally {
		await t.stop();
	}
});

test("a retry gets its recorded answer after placement; after 51 later edits evict it, a retry answers by placement or unknown, never taken", async () => {
	const t = await thread(4000);
	try {
		const { client, threadId, view } = t;
		await client.req("thread.submit", { threadId, content: "/sim long 2" });
		const follow = await client.req("thread.submit", { threadId, content: "follow old", whenBusy: "followUp" });
		const edit = { threadId, submissionId: follow.submission, editId: "lost-reply", expected: "follow old", text: "follow new" };
		// The edit commits; its answer is lost on the way back. The run then places the item.
		assert.deepEqual(await client.req("thread.editQueued", edit), { edited: true });
		await client.until<any>(view, (v) => t.users(v).includes("follow new"), 10_000);
		await t.idle();
		assert.deepEqual(await client.req("thread.editQueued", { ...edit, retry: true }), { edited: true }, "the retry learns that its edit landed");
		await assert.rejects(client.req("thread.editQueued", { ...edit, text: "other text" }), (e: any) => e.code === "key_conflict");
		const ghost = { ...edit, editId: "ghost", text: "ghost text" };
		assert.deepEqual(await client.req("thread.editQueued", ghost), { edited: false, reason: "taken" }, "a first attempt finds the item gone");
		assert.deepEqual(await client.req("thread.editQueued", { ...ghost, retry: true }), { edited: false, reason: "unknown" }, "a retry without a record and without its text placed stays unknown");

		// 51 later edits of another queued item push the first record out of the newest 50.
		await client.req("thread.submit", { threadId, content: "/sim long 40" });
		const other = await client.req("thread.submit", { threadId, content: "b 0", whenBusy: "followUp" });
		for (let i = 0; i < 51; i++)
			assert.deepEqual(await client.req("thread.editQueued", { threadId, submissionId: other.submission, editId: `b ${i}`, expected: `b ${i}`, text: `b ${i + 1}` }), { edited: true });
		await assert.doesNotReject(client.req("thread.editQueued", { ...edit, text: "other text" }), "the record of the first edit left");
		assert.deepEqual(await client.req("thread.editQueued", { ...edit, retry: true }), { edited: true }, "the placed entry of the submission carries the edited text");
		const late = { threadId, submissionId: other.submission, editId: "b 0", expected: "b 0", text: "b 1", retry: true };
		assert.deepEqual(await client.req("thread.editQueued", late), { edited: false, reason: "unknown" }, "an evicted edit, overwritten later, proves nothing");
		assert.deepEqual(await client.req("thread.editQueued", { ...late, retry: false, editId: "b fresh" }), { edited: false, reason: "changed" }, "a first attempt that finds other text is changed");
		await client.req("thread.abort", { threadId });
		await t.idle();
		assert.deepEqual(t.users(await client.until<any>(view, () => true)).slice(0, 2), ["/sim long 2", "follow new"]);
	} finally {
		await t.stop();
	}
});
