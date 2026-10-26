import "./bound.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { durableAuditReview } from "../src/durable/prompt-audit.ts";
import { runDaemon } from "../src/node/daemon.ts";
import { TestClient, tempHome } from "./helpers.ts";
import { recordingModels } from "./node-plugin-fixture.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc } from "@earendil-works/pi-durable";
import { MetaDoc, type NodePlugin } from "../src/node/runtime.ts";

function controls(value: unknown): { ttl?: string }[] {
	if (!value || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([key, item]) => (key === "cache_control" ? [item as { ttl?: string }] : controls(item)));
}

test("node audit: audit.snapshot answers not_found before the first prompt, then serves the renderer's snapshot; /export-system-prompt saves it once", async () => {
	const home = tempHome();
	const { models, model } = recordingModels();
	const daemon = await runDaemon({ home, models, testProviders: ["recording"] });
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		const { threadId } = await client.req("thread.create", { requestId: "audit", cwd: home, model: { provider: model.provider, modelId: model.id }, place: { workspace: "new", label: "A" } });
		await assert.rejects(client.req("audit.snapshot", { threadId }), { code: "not_found", message: "No system prompt recorded yet for this thread." });

		await client.req("thread.submit", { threadId, content: "Record" });
		await client.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId].preview);
		const review = await durableAuditReview((op, args) => client.req(op, args), "host", { threadId });
		assert.equal(review.snapshot.schemaVersion, 1);
		assert.equal(review.snapshot.cwd, home);
		assert.match(review.snapshot.systemPrompt, /\S/);
		assert.ok(review.snapshot.activeTools.some((tool) => tool.name === "read"), "the node's tools are in the snapshot");
		assert.match(review.markdown, /System prompt/i);
		await assert.rejects(client.req("audit.snapshot", { threadId, entryId: "999999" }), { code: "not_found" });

		const saved = await client.req("thread.command", { threadId, name: "export-system-prompt", args: "review.json" });
		const path = join(home, ".pi", "prompt-snapshots", "review.json");
		assert.equal(saved.notice, `System prompt saved to ${path}`);
		assert.equal(JSON.parse(readFileSync(path, "utf8")).integrity.contentSha256, review.snapshot.integrity.contentSha256);
		await assert.rejects(client.req("thread.command", { threadId, name: "export-system-prompt", args: "review.json" }), /exists/);
		await assert.rejects(client.req("thread.command", { threadId, name: "export-system-prompt", args: "../x.json" }), { code: "bad_args" });
		assert.equal(existsSync(join(home, ".pi", "x.json")), false);
		client.close();
	} finally {
		await daemon.stop();
	}
});

test("node cache: each request carries its own conversation's /cache TTL", async () => {
	const home = tempHome();
	const { models, model, calls } = recordingModels();
	const daemon = await runDaemon({ home, models, testProviders: ["recording"] });
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		const ref = { provider: model.provider, modelId: model.id };
		const a = (await client.req("thread.create", { requestId: "cache-a", cwd: home, model: ref, place: { workspace: "new", label: "A" } })).threadId;
		const b = (await client.req("thread.create", { requestId: "cache-b", cwd: home, model: ref, place: { workspace: "new", label: "B" } })).threadId;
		assert.equal((await client.req("thread.command", { threadId: b, name: "cache", args: "1h" })).notice, "Cache TTL: 1h (from the next model request)");
		assert.equal((await client.req("thread.command", { threadId: a, name: "cache", args: "status" })).notice, "Cache TTL: 5m");
		await assert.rejects(client.req("thread.command", { threadId: a, name: "cache", args: "2h" }), { code: "bad_args" });
		for (const threadId of [a, b]) {
			await client.req("thread.submit", { threadId, content: "Record" });
			await client.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId].preview);
		}
		assert.equal(calls.length, 2);
		assert.notEqual(calls[0]!.sessionId, calls[1]!.sessionId);
		assert.deepEqual(calls.map((call) => controls(call.payload).at(-1)?.ttl), ["5m", "1h"]);
		assert.ok(calls.every((call) => controls(call.payload).length <= 4));
		client.close();
	} finally {
		await daemon.stop();
	}
});

test("internal storage conversations keep metadata but do not replay Close through plugins", async () => {
	const home = tempHome(), closed: string[] = [], summarized: string[] = [];
	const Internal = defineDoc<{ id?: string }>({ kind: "test.internal", version: 1, scope: "session", initial: () => ({}), checkpointWhen: () => true });
	const plugin: NodePlugin = {
		extensions: [],
		async internal(store, id) { return (await store.harness.snapshot(Internal, BACKGROUND_CONTEXT))?.id === id; },
		closing(_store, id) { closed.push(id); return []; },
		summarize(_store, id) { summarized.push(id); },
	};
	let daemon = await runDaemon({ home, plugins: [plugin] });
	let client = await TestClient.connect(daemon.socket);
	try {
		const { threadId } = await client.req("thread.create", { requestId: "internal", cwd: home, model: { provider: "ampi-sim", modelId: "sim-1" } });
		const { store } = await daemon.runtime.thread(threadId);
		const internal = await store.harness.commit(async tx => {
			const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const id = String(record.id);
			(await tx.doc(Internal)).id = id;
			(await tx.doc(MetaDoc)).convs[id].closed = { at: 1000, by: "owner" };
			return id;
		}, BACKGROUND_CONTEXT);
		client.close(); await daemon.stop(); closed.length = 0; summarized.length = 0;
		daemon = await runDaemon({ home, plugins: [plugin] }); client = await TestClient.connect(daemon.socket);
		const rows = await client.until<any>(client.sub({ kind: "threads" }), value => !!value.threads[threadId]);
		assert.deepEqual(Object.keys(rows.threads), [threadId]);
		assert.equal(closed.includes(internal), false); assert.equal(summarized.includes(internal), false);
		const { store: reopened, conversationId: rootId } = await daemon.runtime.thread(threadId);
		assert.deepEqual((await reopened.harness.snapshot(MetaDoc, BACKGROUND_CONTEXT))?.convs[internal].closed, { at: 1000, by: "owner" });
		await assert.rejects(daemon.runtime.closeThread(reopened.threadKey(internal)), { code: "not_found" });
		await daemon.runtime.closeThread(threadId);
		assert.ok(closed.includes(rootId), "ordinary threads still reach plugin Close");
	} finally { client.close(); await daemon.stop(); }
});
