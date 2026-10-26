import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import { runDaemon } from "../src/node/daemon.ts";
import { TestClient, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };
const PNG_A = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_B = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==";

type Daemon = Awaited<ReturnType<typeof runDaemon>>;

/** The thread's user entries whose text contains `marker`, once its queue is empty: one per admitted message. */
async function admitted(daemon: Daemon, threadId: string, marker: string): Promise<number> {
	const { store, conversation, conversationId } = await daemon.runtime.thread(threadId);
	const id = Number(conversationId) as ConversationId;
	for (;;) {
		const live = await store.harness.snapshot(LiveDoc, id, BACKGROUND_CONTEXT);
		const inbox = await store.harness.snapshot(InboxDoc, id, BACKGROUND_CONTEXT);
		if (live?.run === undefined && !inbox?.items.length) break;
		await sleep(20);
	}
	const page = await conversation.entries({}, 500, undefined, BACKGROUND_CONTEXT);
	return page.items.filter((entry) => entry.kind === "pi.user" && JSON.stringify(entry.model ?? []).includes(marker)).length;
}

const refused = (code: string) => (error: { code?: string }) => error.code === code;

// An idempotency key belongs to one operation and its payload (review-submit-id.md, pushback 1 and 4).
test("submit keys: a reused key returns its receipt only for the same payload, across a restart", async () => {
	const home = tempHome();
	let daemon = await runDaemon({ home, simTokensPerSecond: 2000 });
	let client = await TestClient.connect(daemon.socket);
	try {
		const { threadId } = await client.req("thread.create", { requestId: "keys-thread", cwd: home, model: SIM });
		const first = await client.req("thread.submit", { threadId, content: "KEY_ALPHA", requestId: "k1" });
		assert.equal((await client.req("thread.submit", { threadId, content: "KEY_ALPHA", requestId: "k1" })).submission, first.submission, "the same message gets the same receipt");
		await assert.rejects(client.req("thread.submit", { threadId, content: "KEY_BRAVO", requestId: "k1" }), refused("key_conflict"), "another text under the key");
		await assert.rejects(client.req("thread.submit", { threadId, content: "KEY_ALPHA", whenBusy: "steer", requestId: "k1" }), refused("key_conflict"), "another busy mode under the key");
		await client.req("thread.submit", { threadId, content: "KEY_IMAGE", images: [{ data: PNG_A, mimeType: "image/png" }], requestId: "k2" });
		await assert.rejects(client.req("thread.submit", { threadId, content: "KEY_IMAGE", images: [{ data: PNG_B, mimeType: "image/png" }], requestId: "k2" }), refused("key_conflict"), "another image under the key");
		assert.equal(await admitted(daemon, threadId, "KEY_ALPHA"), 1);
		assert.equal(await admitted(daemon, threadId, "KEY_BRAVO"), 0, "a refused message admits nothing");
		assert.equal(await admitted(daemon, threadId, "KEY_IMAGE"), 1);

		const named = await client.req("thread.command", { threadId, name: "name", args: "Key one", key: "c1" });
		assert.deepEqual(await client.req("thread.command", { threadId, name: "name", args: "Key one", key: "c1" }), named, "the same command gets the first reply");
		await assert.rejects(client.req("thread.command", { threadId, name: "name", args: "Key two", key: "c1" }), refused("key_conflict"), "other arguments under the key");
		await assert.rejects(client.req("thread.command", { threadId, name: "thinking", args: "Key one", key: "c1" }), refused("key_conflict"), "another command under the key");

		client.close();
		await daemon.stop();
		daemon = await runDaemon({ home, simTokensPerSecond: 2000 });
		client = await TestClient.connect(daemon.socket);
		assert.equal((await client.req("thread.submit", { threadId, content: "KEY_ALPHA", requestId: "k1" })).submission, first.submission, "a restart keeps the receipt");
		await assert.rejects(client.req("thread.submit", { threadId, content: "KEY_BRAVO", requestId: "k1" }), refused("key_conflict"), "a restart keeps the check");
		await assert.rejects(client.req("thread.command", { threadId, name: "name", args: "Key two", key: "c1" }), refused("key_conflict"), "a restart keeps the command check");
		assert.equal(await admitted(daemon, threadId, "KEY_ALPHA"), 1);
		assert.equal(await admitted(daemon, threadId, "KEY_BRAVO"), 0);
		const threads = client.sub({ kind: "threads" });
		assert.equal((await client.until<any>(threads, (v) => v.threads[threadId])).threads[threadId].title, "Key one", "the refused rename ran no effect");
	} finally {
		client.close();
		await daemon.stop();
	}
});
