import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage, ProviderDoc, type ConversationId } from "@earendil-works/pi-durable";
// @ts-expect-error The planner publishes JavaScript without declarations.
import { placeMarkers } from "@hypercarrier/pi-cache-goblin/plan";
// @ts-expect-error The planner publishes JavaScript without declarations.
import { findGlobalBoundary } from "@hypercarrier/pi-cache-goblin/system-split";
import { cacheGoblinModels, CacheTtlDoc } from "../src/plugins/cache-goblin.ts";
import { piPayload, recordingModels } from "./node-plugin-fixture.ts";

function controls(value: unknown): { ttl?: string }[] {
	if (!value || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([key, item]) => key === "cache_control" ? [item] : controls(item));
}

test("recording provider receives the Pi planner placement through both stream paths", async () => {
	const { models, model, calls } = recordingModels();
	const wrapped = cacheGoblinModels(models, () => "5m");
	const expected = placeMarkers(piPayload, { sessionTtl: "5m", globalBoundary: (text: string) => findGlobalBoundary(text, { globalPaths: [] }) }).payload;
	for (const run of [wrapped.stream, wrapped.streamSimple, wrapped.complete, wrapped.completeSimple]) {
		const result = run(model, { messages: [] }, { sessionId: "fixture" });
		await ("result" in result ? result.result() : result);
		assert.deepEqual(calls.at(-1)?.payload, expected);
		assert.deepEqual(controls(calls.at(-1)?.payload).map((mark) => mark.ttl), ["1h", "1h", "5m"]);
		assert.ok(controls(calls.at(-1)?.payload).length <= 4);
	}
	assert.equal(controls(piPayload).length, 5, "the original fixture stays unchanged");
});

test("payload hook composition preserves prior replacements and non-Messages payloads", async () => {
	const { models, model, calls } = recordingModels();
	const wrapped = cacheGoblinModels(models, () => "1h");
	await wrapped.streamSimple(model, { messages: [] }, {
		onPayload: async () => ({ ...piPayload, max_tokens: 42 }),
	}).result();
	assert.equal((calls[0]!.payload as typeof piPayload).max_tokens, 42);
	assert.ok(controls(calls[0]!.payload).every((mark) => mark.ttl === "1h"));
	const other = recordingModels({ model: "other", input: "not Messages" });
	const pass = cacheGoblinModels(other.models, () => { throw new Error("must not look up unsupported payloads"); });
	await pass.streamSimple(other.model, { messages: [] }).result();
	assert.deepEqual(other.calls[0]!.payload, { model: "other", input: "not Messages" });
});

test("pi-durable supplies each conversation's persisted provider ID; concurrent TTLs and a switch stay isolated", { timeout: 5000 }, async () => {
	const { models, model, calls } = recordingModels();
	const ids = new Map<string, ConversationId>();
	const harness: Harness = await Harness.open(new MemoryStorage(), {
		models: cacheGoblinModels(models, async (sessionId) => {
			assert.ok(sessionId, "pi-durable must pass a provider session ID");
			const id = ids.get(sessionId);
			assert.ok(id !== undefined, "the request ID must equal public ProviderDoc.sessionId");
			return (await harness.snapshot(CacheTtlDoc, id, ctx))?.ttl ?? "5m";
		}), registry: createRegistry(), settings: { retry: { maxRetries: 0 } },
	}, ctx);
	try {
		const first = await harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } });
		const second = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: model.provider, modelId: model.id } } }, ctx);
		for (const conversation of [first, second]) {
			const provider = await harness.snapshot(ProviderDoc, conversation.id, ctx);
			assert.ok(provider);
			ids.set(provider.sessionId, conversation.id);
		}
		assert.equal(ids.size, 2);
		await second.commit(async (tx) => { (await tx.doc(CacheTtlDoc, second.id)).ttl = "1h"; }, ctx);
		await Promise.all([first, second].map(async (conversation) => {
			assert.equal((await (await conversation.submit({ type: "input", content: "Record" }, ctx)).wait(ctx)).status, "done");
		}));
		const firstKey = (await harness.snapshot(ProviderDoc, first.id, ctx))!.sessionId;
		const secondKey = (await harness.snapshot(ProviderDoc, second.id, ctx))!.sessionId;
		assert.equal(controls(calls.find((call) => call.sessionId === firstKey)!.payload).at(-1)!.ttl, "5m");
		assert.equal(controls(calls.find((call) => call.sessionId === secondKey)!.payload).at(-1)!.ttl, "1h");
		await first.commit(async (tx) => { (await tx.doc(CacheTtlDoc, first.id)).ttl = "1h"; }, ctx);
		await first.reset(undefined, ctx);
		assert.equal((await (await first.submit({ type: "input", content: "After switch" }, ctx)).wait(ctx)).status, "done");
		assert.equal(calls.at(-1)!.sessionId, firstKey);
		assert.equal(controls(calls.at(-1)!.payload).at(-1)!.ttl, "1h");
	} finally { await harness.close(ctx); }
});
