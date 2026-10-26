import "./bound.ts";
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as anthropicMessages from "@earendil-works/pi-ai/api/anthropic-messages";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { hydrate, nodePorts } from "../src/plugins.ts";
import { NodeRuntime } from "../src/node/runtime.ts";
import { tempHome } from "./helpers.ts";
import { PARITY_MODEL, PARITY_PROMPT, PARITY_PROVIDER as PROVIDER, type RequestShape, requestShape, type WireTool, writeParityFixture } from "./request-parity-fixture.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

type Sent = { body: any; beta: string | undefined; base: string };

/** The node's first wire request for the fixture: pi-ai's real Anthropic adapter, with a fetch that answers locally. */
async function durableRequest(): Promise<Sent> {
	const base = realpathSync(tempHome());
	const { home, agent, project } = writeParityFixture(base);
	const saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = agent;
	const sent: { body: any; beta: string | undefined }[] = [];
	const fetch = async (_url: unknown, init: RequestInit) => {
		sent.push({ body: JSON.parse(String(init.body)), beta: new Headers(init.headers).get("anthropic-beta") ?? undefined });
		const events = [
			{ type: "message_start", message: { id: "msg_local", type: "message", role: "assistant", model: PARITY_MODEL.id, content: [], usage: { input_tokens: 0, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		];
		return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const inner = createModels();
	const model = { ...PARITY_MODEL, provider: PROVIDER, baseUrl: "http://127.0.0.1:1" };
	inner.setProvider(createProvider({ id: PROVIDER, name: "Parity capture", baseUrl: model.baseUrl, models: [model as any], auth: { apiKey: { name: "Synthetic", resolve: async () => ({ auth: { apiKey: "synthetic" } }) } }, api: anthropicMessages as any }));
	const models = new Proxy(inner, {
		get(target, key) {
			if (key === "stream" || key === "streamSimple")
				return (m: any, context: any, options: any = {}) => (target as any)[key](m, context, { ...options, maxRetries: 0, fetch });
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const runtime = new NodeRuntime({ home: join(base, "ampi"), agentDir: agent, models, plugins: await hydrate(nodePorts({ agentDir: agent, home })), testProviders: [PROVIDER] });
	try {
		await runtime.start();
		// No explicit model: Pi's settings pick the model and thinking level, as they do for Pi.
		const { threadId } = await runtime.createThread({ cwd: project, title: "Request parity" });
		const { conversation } = await runtime.thread(threadId);
		const submission = await conversation.submit({ type: "input", content: PARITY_PROMPT }, BACKGROUND_CONTEXT);
		await submission.wait(BACKGROUND_CONTEXT);
		assert.ok(sent[0], "the node sent a model request");
		return { ...sent[0], base };
	} finally {
		await runtime.close();
		Object.assign(process.env, saved);
	}
}

let capture: Promise<Sent> | undefined;
/** One capture serves every test in this file. */
const firstRequest = () => (capture ??= durableRequest());

/** The comparable request: the whole body, with the fixture paths and the node's platform line replaced. */
const shapeOf = (sent: Sent) =>
	requestShape(sent.body, sent.beta, { [sent.base]: "<FIXTURE>", [repo]: "<REPO>" }, { [`Platform: ${process.platform}`]: "Platform: <PLATFORM>" });

/**
 * One intended difference: why it exists, the decision or design row that keeps it, and the edits that turn Pi's
 * request into the node's. Edits change one system block's exact text, addressed by top-level `<tag>` section;
 * sections join with a blank line, as Pi renders them. `preamble` is the untagged text before the first section.
 */
type Allowed = {
	id: string;
	reason: string;
	cite: string;
	edits: (
		| { systemBlock: number; preamble: string }
		| { systemBlock: number; section: string; remove: true }
		| { systemBlock: number; section: string; replace: string }
		| { systemBlock: number; section: string; insertAfter: string; text: string }
		| { stripDescriptionSuffix: string }
		| { tool: string; description: string }
		| { tool: string; insertAfter: string; value: WireTool }
	)[];
};

const SEPARATOR = "\n\n";
const OPEN_TAG = /^<([a-z_]+)(?: [^\n]*)?>$/gm;

/** Where `<tag>` … `</tag>` sits in a block: whole lines, first match. */
function sectionSpan(text: string, tag: string): { start: number; end: number } | undefined {
	for (const open of text.matchAll(OPEN_TAG)) {
		if (open[1] !== tag) continue;
		const close = text.indexOf(`\n</${tag}>`, open.index);
		const end = close + `\n</${tag}>`.length;
		if (close >= 0 && (end === text.length || text[end] === "\n")) return { start: open.index, end };
	}
	return undefined;
}

/** A block's top-level sections in order, by name and exact text; text outside any section is `#text`. */
function sections(text: string): { name: string; text: string }[] {
	const out: { name: string; text: string }[] = [];
	let at = 0;
	for (const open of text.matchAll(OPEN_TAG)) {
		if (open.index < at) continue;
		const span = sectionSpan(text.slice(open.index), open[1]!);
		if (!span || span.start !== 0) continue;
		if (open.index > at) out.push({ name: at === 0 ? "#preamble" : "#text", text: text.slice(at, open.index) });
		out.push({ name: open[1]!, text: text.slice(open.index, open.index + span.end) });
		at = open.index + span.end;
	}
	if (at < text.length) out.push({ name: at === 0 ? "#preamble" : "#text", text: text.slice(at) });
	return out;
}

/** Pi's request with every allowed difference applied: what the node must send. */
function expectedRequest(pi: RequestShape, allowed: Allowed[]): RequestShape {
	const out: RequestShape = structuredClone(pi);
	const spanOf = (text: string, tag: string) => {
		const span = sectionSpan(text, tag);
		assert.ok(span, `allowed difference names a missing section ${tag}`);
		return span;
	};
	const toolAt = (name: string) => {
		const index = out.body.tools.findIndex((tool) => tool.name === name);
		assert.ok(index >= 0, `allowed difference names a missing tool ${name}`);
		return index;
	};
	for (const edit of allowed.flatMap((entry) => entry.edits)) {
		if ("systemBlock" in edit) {
			const block = out.body.system[edit.systemBlock];
			assert.ok(block, `allowed difference names a missing system block ${edit.systemBlock}`);
			const text = block.text;
			if ("preamble" in edit) {
				const first = new RegExp(OPEN_TAG.source, "m").exec(text);
				assert.ok(first && text.slice(first.index - SEPARATOR.length, first.index) === SEPARATOR, "the preamble ends before a blank line and a section");
				block.text = edit.preamble + text.slice(first.index - SEPARATOR.length);
			} else if ("remove" in edit) {
				const { start, end } = spanOf(text, edit.section);
				if (text.slice(start - SEPARATOR.length, start) === SEPARATOR) block.text = text.slice(0, start - SEPARATOR.length) + text.slice(end);
				else if (text.slice(end, end + SEPARATOR.length) === SEPARATOR) block.text = text.slice(0, start) + text.slice(end + SEPARATOR.length);
				else assert.fail(`section ${edit.section} has no blank line beside it`);
			} else if ("replace" in edit) {
				const { start, end } = spanOf(text, edit.section);
				block.text = text.slice(0, start) + edit.replace + text.slice(end);
			} else {
				const { end } = spanOf(text, edit.insertAfter);
				block.text = text.slice(0, end) + SEPARATOR + edit.text + text.slice(end);
			}
		} else if ("stripDescriptionSuffix" in edit) {
			const suffix = new RegExp(edit.stripDescriptionSuffix);
			for (const tool of out.body.tools) tool.description = tool.description.replace(suffix, "");
		} else if ("insertAfter" in edit) out.body.tools.splice(toolAt(edit.insertAfter) + 1, 0, edit.value);
		else out.body.tools[toolAt(edit.tool)]!.description = edit.description;
	}
	return out;
}

/** Labeled parts first, so a failure names what drifted; the whole request last, so nothing goes unchecked. */
function assertParity(ours: RequestShape, expected: RequestShape) {
	assert.deepEqual(Object.keys(ours.body).sort(), Object.keys(expected.body).sort(), "body fields");
	for (const field of ["model", "stream", "max_tokens", "thinking"]) assert.deepEqual(ours.body[field], expected.body[field], `body ${field}`);
	const marks = (request: RequestShape) => request.body.system.map(({ text: _text, ...mark }) => mark);
	assert.deepEqual(marks(ours), marks(expected), "system blocks: count, type, and cache marks");
	for (const [index, block] of expected.body.system.entries()) {
		const theirs = sections(block.text);
		const mine = sections(ours.body.system[index]!.text);
		assert.deepEqual(mine.map((section) => section.name), theirs.map((section) => section.name), `system block ${index}: sections and order`);
		for (const [at, section] of theirs.entries()) assert.equal(mine[at]!.text, section.text, `system block ${index}: section ${section.name}`);
		assert.equal(ours.body.system[index]!.text, block.text, `system block ${index}: exact text`);
	}
	assert.deepEqual(ours.body.tools.map((tool) => tool.name), expected.body.tools.map((tool) => tool.name), "tool names and order");
	for (const [index, tool] of expected.body.tools.entries()) assert.deepEqual(ours.body.tools[index], tool, `tool ${tool.name}`);
	assert.deepEqual(ours.body.messages, expected.body.messages, "messages");
	assert.deepEqual(ours.betas, expected.betas, "the anthropic-beta header");
	assert.deepEqual(ours, expected);
}

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const piRequest = (): RequestShape => JSON.parse(readFileSync(join(fixtures, "pi-request.json"), "utf8")).request;
const allowedDifferences = (): Allowed[] => JSON.parse(readFileSync(join(fixtures, "request-parity-allowed.json"), "utf8"));

test("request parity: the node's first model request is Pi's, except the named differences", async () => {
	const allowed = allowedDifferences();
	for (const entry of allowed) assert.ok(entry.id && entry.reason && entry.cite && entry.edits.length > 0, `allowed difference ${entry.id} names its reason and citation`);
	assertParity(shapeOf(await firstRequest()), expectedRequest(piRequest(), allowed));
});

/** Pi's fixture text both mutations of the date case extend. */
const dated = (body: RequestShape["body"], date: string) => {
	const block = body.system[1]!;
	assert.ok(block.text.includes("Fixture project instructions."));
	block.text = block.text.replace("Fixture project instructions.", `Fixture project instructions. Reviewed ${date}.`);
};

// Each drift must fail, at the check that names it. The node's raw body is changed before the scrub, as a real drift would be.
const drifts: { name: string; fails: RegExp; node: (body: any) => void; pi?: (body: RequestShape["body"]) => void }[] = [
	{ name: "a reordered tool", fails: /tool names and order/, node: (body) => body.tools.splice(1, 0, ...body.tools.splice(0, 1)) },
	{ name: "a changed schema field", fails: /tool read/, node: (body) => (body.tools[0].input_schema.properties.path.type = "number") },
	{ name: "a moved cache mark", fails: /cache marks/, node: (body) => ((body.tools.at(-1).cache_control = body.system[1].cache_control), delete body.system[1].cache_control) },
	{ name: "a merged system block", fails: /cache marks/, node: (body) => body.system.splice(0, 2, { ...body.system[1], text: body.system[0].text + body.system[1].text }) },
	{ name: "a date literal outside the date line", fails: /system block 1: section project_instructions/, node: (body) => dated(body, "2026-10-25"), pi: (body) => dated(body, "2026-01-01") },
	{ name: "a changed model", fails: /body model/, node: (body) => (body.model = "claude/claude-sonnet-5-5") },
	{ name: "a changed stream flag", fails: /body stream/, node: (body) => (body.stream = false) },
	{ name: "a changed thinking budget", fails: /body thinking/, node: (body) => (body.thinking.budget_tokens = 4096) },
	{ name: "an extra body field", fails: /body fields/, node: (body) => (body.temperature = 1) },
];
for (const drift of drifts)
	test(`request parity fails on ${drift.name}`, async () => {
		const sent = structuredClone(await firstRequest());
		drift.node(sent.body);
		const expected = expectedRequest(piRequest(), allowedDifferences());
		drift.pi?.(expected.body);
		assert.throws(() => assertParity(shapeOf(sent), expected), (error: Error) => error instanceof assert.AssertionError && drift.fails.test(error.message));
	});
