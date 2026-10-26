import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import * as anthropic from "@earendil-works/pi-ai/api/anthropic-messages";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage, section } from "@earendil-works/pi-durable";
import { type CompactRecord, hcCompactExtension, PLAN_PROMPT_PREFIX } from "@hypercarrier/auto-compact-durable";
import { cacheGoblinModels, lastRequest } from "../src/plugins/cache-goblin.ts";

// The keepset planner sends the conversation's last real request again with one appended user message. Offline, on the
// Anthropic Messages wire format: every byte of the last request's system, tools, and messages (cache marks included)
// is a prefix of the planning request.

const model = { id: "claude-offline", name: "offline", provider: "offline", api: "anthropic-messages", baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as const;

function sse(text: string, model: string) {
	const events = [
		{ type: "message_start", message: { id: "msg_offline", type: "message", role: "assistant", content: [], model, usage: { input_tokens: 10, cache_read_input_tokens: 900, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } },
		{ type: "message_stop" },
	];
	return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

type Wire = { body: any; planner: boolean };
type OfflineOptions = {
	/** Extra prompt section text and a tool description, so the durable system message carries them. */
	section?: string;
	toolDescription?: string;
	trigger?: number;
	/** `fail`: the history source throws, as an unreadable store. */
	history?: "ok" | "fail";
	/** Awaited before the planner's answer, so a test can grow the conversation while the plan is written. */
	hold?: (wire: Wire) => Promise<void>;
	/** An ordinary answer; READY by default. */
	answer?: (body: any) => string;
};

/** A real durable Harness on the offline Anthropic wire, with the Cache Goblin capture and the HC compact hook. */
async function offline(options: OfflineOptions = {}) {
	const wire: Wire[] = [];
	const models = createModels();
	models.setProvider(createProvider({ id: "offline", models: [model as never], auth: { apiKey: { name: "Offline", resolve: async () => ({ auth: { apiKey: "offline" } }) } }, api: anthropic as never }));
	// The wire: every request body as sent. The planner answers with a plan; other requests answer READY.
	const sending = new Proxy(models, {
		get(target, key) {
			const value = Reflect.get(target, key, target);
			if (!["stream", "streamSimple", "complete", "completeSimple"].includes(String(key))) return typeof value === "function" ? value.bind(target) : value;
			return (m: never, c: never, o: any = {}) => value.call(target, m, c, {
				...o,
				fetch: async (_url: string, init: { body: string }) => {
					const body = JSON.parse(init.body);
					const planner = JSON.stringify(body.messages.at(-1)).includes(PLAN_PROMPT_PREFIX);
					const sent = { body, planner };
					wire.push(sent);
					if (planner) await options.hold?.(sent);
					return sse(planner ? JSON.stringify({ summary: "Offline working-state summary.", keep: [] }) : (options.answer?.(body) ?? "READY"), body.model);
				},
			});
		},
	});
	const records: CompactRecord[] = [];
	const registry = createRegistry();
	const tool = defineTool({ name: "offline_read", description: options.toolDescription ?? "Offline fixture. Never call it.", parameters: { type: "object", properties: {}, required: [] }, replay: "safe", execute: async () => ({ output: [{ type: "text", text: "offline" }] }) });
	const sections = [section("preamble", () => "Offline keepset verification. Reply READY.", { tag: false }), ...(options.section ? [section("offline_rules", () => options.section)] : [])];
	registry.install(defineExtension({ name: "offline-prompt", tools: [tool], sections }));
	let conversation: Awaited<ReturnType<Harness["root"]>> | undefined;
	registry.install(hcCompactExtension({
		lastRequest,
		record: (_api, record) => { records.push(record); },
		history: async (_api, context) => {
			if (options.history === "fail") throw new Error("history store offline");
			return (await conversation!.entries({ order: "ascending" }, 10_000, undefined, context)).items;
		},
		...(options.trigger ? { trigger: () => options.trigger } : {}),
	}));
	const harness = await Harness.open(new MemoryStorage(), {
		models: cacheGoblinModels(sending as never, () => "5m"),
		registry,
		settings: { retry: { enabled: false, maxRetries: 0 }, compaction: { enabled: false, keepRecentTokens: 1 }, stream: { maxRetries: 0 } },
	}, ctx);
	conversation = await harness.root(ctx, { agent: { model: { provider: "offline", modelId: model.id }, thinkingLevel: "off" } });
	const root = conversation;
	const submit = async (content: string) => assert.equal((await (await root.submit({ type: "input", content }, ctx)).wait(ctx)).status, "done");
	const compact = async () => {
		const task = await harness.waitForTask(await root.compact(undefined, ctx), ctx);
		assert.equal(task.state.outcome?.status, "completed", JSON.stringify(task.state));
		return records.at(-1)!;
	};
	return { wire, records, registry, harness, conversation: root, submit, compact, close: () => harness.close(ctx) };
}

test("keepset planner: the offline planning payload is the last real request plus one unmarked user message", async () => {
	const { wire, records, submit, compact, close } = await offline();
	try {
		await submit(`Offline dataset.\n${Array.from({ length: 200 }, (_, i) => `Record ${i}: alpha beta gamma.`).join("\n")}`);
		await submit("Second ordinary turn.");
		await submit("Last ordinary turn.");
		const last = wire.at(-1)!;
		assert.equal(last.planner, false);
		await compact();
		const planners = wire.filter((w) => w.planner);
		assert.equal(planners.length, 1, "one planning request");
		const plan = planners[0]!.body;
		const json = (v: unknown) => JSON.stringify(v ?? null);
		assert.equal(json(plan.system), json(last.body.system), "system bytes and marks");
		assert.equal(json(plan.tools), json(last.body.tools), "tool bytes");
		assert.equal(plan.messages.length, last.body.messages.length + 1, "one appended message");
		assert.equal(json(plan.messages.slice(0, -1)), json(last.body.messages), "message bytes and marks");
		const prefix = json(last.body.messages).slice(0, -1);
		assert.ok(json(plan.messages).startsWith(prefix), "the last request's messages are a byte prefix");
		const appended = plan.messages.at(-1);
		assert.equal(appended.role, "user");
		assert.doesNotMatch(json(appended), /cache_control/, "the appended message is unmarked");
		assert.match(json(last.body.messages), /cache_control/, "the last request had a tail mark");
		for (const key of new Set([...Object.keys(plan), ...Object.keys(last.body)]))
			if (!["messages", "max_tokens"].includes(key)) assert.equal(json(plan[key]), json(last.body[key]), key);
		const record = records.at(-1)!;
		assert.equal(record.method, "keepset", JSON.stringify(record));
		assert.deepEqual(record.planner?.usage, { input: 10, output: 20, cacheRead: 900, cacheWrite: 0, cost: 0 });
		assert.equal(record.planner?.promptTokens, 910);
		assert.match(record.planner!.cache, /^99% of 910 prompt tokens read from cache$/);
		assert.equal(record.attempts, 1);
	} finally {
		await close();
	}
});

const fitParts = (reason: string | undefined) => {
	const m = /^the summary does not fit: summary (\d+) \+ kept tail (\d+) \+ prompt (\d+) = (\d+) tokens, over the (\d+)-token compaction trigger$/.exec(reason ?? "");
	assert.ok(m, `a fit reason: ${reason}`);
	return { summary: Number(m[1]), tail: Number(m[2]), prompt: Number(m[3]), limit: Number(m[5]) };
};

test("keepset fit: a large durable section and tool schema count as prompt overhead; a short plan over a small trigger is rejected and its spend kept", async () => {
	const { wire, submit, compact, close } = await offline({ section: "Durable rule text. ".repeat(2000), toolDescription: "Wide schema text. ".repeat(2000), trigger: 15_000 });
	try {
		await submit("First ordinary turn.");
		await submit("Last ordinary turn.");
		const last = wire.at(-1)!.body;
		assert.match(JSON.stringify(last.system), /Durable rule text/, "the section is on the wire");
		assert.match(JSON.stringify(last.tools), /Wide schema text/, "the schema is on the wire");
		const record = await compact();
		assert.equal(record.method, "native-fallback", JSON.stringify(record));
		const fit = fitParts(record.planRejected);
		// 38k characters of section and 36k of schema at 3.5 characters per token.
		assert.ok(fit.prompt >= 20_000, `the prompt overhead counts the section and the schema: ${fit.prompt}`);
		assert.ok(fit.summary < 500, `the plan itself is short: ${fit.summary}`);
		assert.equal(fit.limit, 15_000);
		assert.equal(record.planner?.requests, 1, "the paid planning request is in the record");
		assert.equal(record.planner?.promptTokens, 910);
	} finally {
		await close();
	}
});

test("keepset fit: the tail is measured after the planner answers, so a large result appended while it plans counts", async () => {
	let planning!: () => void;
	const planned = new Promise<void>((resolve) => (planning = resolve));
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	const big = "Large background result. ".repeat(3000);
	const { submit, compact, close } = await offline({
		trigger: 15_000,
		hold: async () => { planning(); await held; },
		answer: (body) => (JSON.stringify(body.messages.at(-1)).includes("Background turn") ? big : "READY"),
	});
	try {
		await submit("First ordinary turn.");
		await submit("Last ordinary turn.");
		const compacting = compact();
		await planned;
		// The conversation keeps running while the plan is written: this answer lands after the plan's capture.
		await submit("Background turn.");
		release();
		const record = await compacting;
		assert.equal(record.method, "native-fallback", JSON.stringify(record));
		const fit = fitParts(record.planRejected);
		assert.ok(fit.tail >= big.length / 3.5, `the refreshed tail holds the background answer: ${fit.tail}`);
		assert.equal(record.planner?.requests, 1);
	} finally {
		release();
		await close();
	}
});

test("keepset fit: an unreadable history fails safe with a named reason, never a zero tail", async () => {
	const { submit, compact, close } = await offline({ history: "fail" });
	try {
		await submit("First ordinary turn.");
		await submit("Last ordinary turn.");
		const record = await compact();
		assert.equal(record.method, "native-fallback", JSON.stringify(record));
		assert.equal(record.planRejected, "the fit check cannot read the history: history store offline");
		assert.equal(record.planner?.requests, 1, "the paid planning request is in the record");
	} finally {
		await close();
	}
});

test("keepset fit: a section and tool patch placed before the first kept entry still counts as prompt overhead", async () => {
	const { registry, conversation, submit, compact, close } = await offline({ trigger: 15_000 });
	try {
		await submit("First ordinary turn.");
		// A mid-conversation install: durable writes one system entry with the new section and the new tool schema.
		const wide = defineTool({ name: "offline_wide", description: "Wide patched schema. ".repeat(2000), parameters: { type: "object", properties: {}, required: [] }, replay: "safe", execute: async () => ({ output: [{ type: "text", text: "wide" }] }) });
		registry.install(defineExtension({ name: "offline-wide", tools: [wide], sections: [section("offline_patch", () => "Patched durable rule. ".repeat(2000))] }));
		await submit("Turn after the patch.");
		await submit("Second turn after the patch.");
		await submit("Last ordinary turn.");
		const entries = (await conversation.entries({ order: "ascending" }, 10_000, undefined, ctx)).items;
		const systems = entries.filter((e) => (e.model as { role: string }[] | undefined)?.some((m) => m.role === "system"));
		const patch = systems.find((e) => JSON.stringify(e.model).includes("Patched durable rule"));
		assert.ok(patch, "the patch is a later system entry");
		assert.ok(Number(patch.id) > Number(systems[0]!.id), "the patch follows the initial system entry");
		assert.match(JSON.stringify(patch.model), /Wide patched schema/, "the tool patch rides on the same entry");
		const record = await compact();
		assert.ok(Number(patch.id) < record.firstKept, `the cut passes the patch: patch ${patch.id}, first kept ${record.firstKept}`);
		assert.equal(record.method, "native-fallback", JSON.stringify(record));
		const fit = fitParts(record.planRejected);
		// 44k characters of section and 42k of schema at 3.5 characters per token; durable restates both after the cut.
		assert.ok(fit.prompt >= 24_000, `the prompt overhead counts the patched section and schema: ${fit.prompt}`);
		assert.ok(fit.tail < 1_000, `the patch is not in the kept tail: ${fit.tail}`);
		assert.equal(record.planner?.requests, 1);
	} finally {
		await close();
	}
});
