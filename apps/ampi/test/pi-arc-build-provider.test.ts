import "./bound.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { useHubConfig, type ModelPurpose, resolveHelperModel } from "../src/hub/helper-models.ts";
import { ask } from "../src/pi/ask.ts";
import { piModelRegistry } from "../src/pi/model-registry.ts";
import { buildArc, buildLog, cosArc, type ArcValue } from "../src/pi/views/cos-arc.ts";
import { rarebitView } from "../src/pi/views/rarebit.ts";
import type { PiViewSession } from "../src/pi/views/types.ts";
import { HUB, MODELS, chunks, context, model, root, session, type Req } from "./pi-arc-build-fixture.ts";

// Real Pi calls go to a local Anthropic Messages endpoint (models.json sets only baseUrl, so built-in models stay). It
// records the model of every outgoing request and answers with the offline demo model. A two-chunk Arc Build (labels,
// step 2) and one side ask cover every purpose in three Pi calls. `providers` adds
// models.json providers on the same endpoint; settings.json names magpie as Pi's defaultProvider, which the hub ignores.
// `hubModels` is the whole hub.json models block. With `fails`, the
// Build must fail and the Rarebit calls are skipped. `providerRun` keeps the Build's job and log record.
let providerRun: { job: ArcValue["job"]; build: ReturnType<typeof buildLog>[number] | undefined } | undefined;
async function providerModels(name: string, hubModels: Record<string, string>, { providers = {}, fails = false }: { providers?: Record<string, object>; fails?: boolean } = {}) {
	const requests: { purpose: string; model: string }[] = [];
	const purposeOf = (system: string) => system.startsWith("You label") ? "labels" : system.includes("chief of staff") ? "synthesis" : "rarebitAsk";
	const text = (v: unknown): string => typeof v === "string" ? v : Array.isArray(v) ? v.map((b: { text?: string }) => b.text ?? "").join("") : "";
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (d) => (body += d)).on("end", () => {
			const b = JSON.parse(body) as { model: string; system?: unknown; messages: { role: string; content: unknown }[] };
			requests.push({ purpose: purposeOf(text(b.system)), model: b.model });
			const answer = spawnSync(model[0]!, model.slice(1), { input: text(b.messages.findLast((m) => m.role === "user")?.content), encoding: "utf8" }).stdout.trim();
			const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
			res.writeHead(200, { "content-type": "text/event-stream" });
			ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: b.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
			ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
			ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: answer } });
			ev("content_block_stop", { index: 0 });
			ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
			ev("message_stop", {});
			res.end();
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const agentDir = join(root, `${name}-agent`); mkdirSync(agentDir, { recursive: true });
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { anthropic: { baseUrl, apiKey: "test-key" }, ...Object.fromEntries(Object.entries(providers).map(([k, v]) => [k, { baseUrl, api: "anthropic-messages", ...v }])) } }));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "magpie" }));
	const saved = { PI_BIN: process.env.PI_BIN, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE, PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK };
	Object.assign(process.env, { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" });
	delete process.env.PI_BIN;
	const small = { ...session, data: { ...session.data, arc: { chunks: chunks.slice(0, 2) } } } as PiViewSession;
	const rarebit = { threadId: "pi:sess-r", revision: 1, rarebitSnapshot: () => ({ context: "[u1] USER: Ship the cache cap?", count: 1, included: 1, omittedChars: 0, evidenceHash: "e".repeat(64), entry: "u1" }) } as unknown as PiViewSession;
	try {
		const file = join(root, `${name}-hub.json`);
		writeFileSync(file, JSON.stringify({ hosts: [], models: hubModels }));
		useHubConfig(file);
		const r = context(name, () => 0);
		Object.assign(r.ctx, { ask: (req: Req) => ask(req), model: (p: ModelPurpose, o?: string) => resolveHelperModel(p, o, piModelRegistry), session: (id: string) => (id === rarebit.threadId ? rarebit : small) });
		buildArc(r.ctx, small);
		let v: ArcValue | undefined;
		for (let i = 0; i < 2400 && (!v || v.job?.state === "running"); i++) {
			await new Promise((res) => setTimeout(res, 25));
			v = cosArc.value(r.ctx, { kind: "view", view: "cos.arc", threadId: small.threadId }) as ArcValue;
		}
		providerRun = { job: v?.job ?? null, build: buildLog(r.ctx, small.threadId).at(-1) };
		assert.equal(v?.job?.state, fails ? "error" : "done", JSON.stringify(v?.job?.lastError));
		if (fails) return { requests: requests.length };

		const side = await rarebitView.ops!.ask!(r.ctx, { threadId: rarebit.threadId, question: "Is the cap set?" }) as { side: { turns: { error?: string }[] } };
		assert.equal(side.side.turns[0]!.error, undefined);
		return Object.fromEntries(["labels", "synthesis", "rarebitAsk"].map((p) => [p, [...new Set(requests.filter((q) => q.purpose === p).map((q) => q.model))]]));
	} finally {
		useHubConfig(HUB);
		server.close();
		for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
	}
}

test("arc build provider model: each purpose's outgoing provider request carries its hub.json model (failure: Arc calls went out on Pi's default model)", async () => {
	assert.deepEqual(await providerModels("provider-explicit", MODELS), { labels: ["claude-haiku-5-5"], synthesis: ["claude-sonnet-5-5"], rarebitAsk: ["claude-sonnet-5-5"] });
	assert.deepEqual(providerRun!.build!.models, { labels: "anthropic/claude-haiku-5-5", synthesis: "anthropic/claude-sonnet-5-5" });
});

test("arc build provider model override: hub.json models.<purpose> changes that purpose's outgoing provider request (failure: a call site lost its purpose)", async () => {
	assert.deepEqual(await providerModels("provider-hub", { arcLabels: "anthropic/claude-sonnet-5-5", arcSynthesis: "anthropic/claude-sonnet-5-5", rarebitAsk: "anthropic/claude-haiku-5-5" }),
		{ labels: ["claude-sonnet-5-5"], synthesis: ["claude-sonnet-5-5"], rarebitAsk: ["claude-haiku-5-5"] });
});

// A local gateway provider, as on the owner's hub: its ids carry a route prefix.
const MAGPIE = { magpie: { apiKey: "test-key", models: [{ id: "claude/claude-haiku-5-5" }, { id: "claude/claude-sonnet-5-5" }] } };

test("arc build provider alias: a gateway provider/id reaches the provider as configured and the Build log names provider/id per purpose (failure: Pi's fuzzy --model or a custom-model fallback picked the route)", async () => {
	assert.deepEqual(await providerModels("provider-alias", { ...MODELS, arcLabels: "magpie/claude/claude-haiku-5-5" }, { providers: MAGPIE }),
		{ labels: ["claude/claude-haiku-5-5"], synthesis: ["claude-sonnet-5-5"], rarebitAsk: ["claude-sonnet-5-5"] });
	assert.deepEqual(providerRun!.build!.models, { labels: "magpie/claude/claude-haiku-5-5", synthesis: "anthropic/claude-sonnet-5-5" });
});

test("arc build missing model: an unknown, bare, signed-out or unset model fails the Build with model, purpose, hub.json key and the listed rows before any provider call (failure: the Build spent labels, then fell back, guessed a provider, or failed late)", async () => {
	// Each case: hub.json models, the key and name that fail, the failed Build purpose, the purposes the message names, and the Try rows.
	const nope = "anthropic/claude-nope-9";
	for (const [name, hub, key, model, purpose, words, tried] of [["missing", { ...MODELS, arcSynthesis: nope }, "arcSynthesis", nope, "synthesis", "Arc synthesis", ""],
		["bare", { ...MODELS, arcSynthesis: "claude-sonnet-5-5" }, "arcSynthesis", "claude-sonnet-5-5", "synthesis", "Arc synthesis", " Try: anthropic/claude-sonnet-5-5."],
		["signed-out", { ...MODELS, arcLabels: "locked/claude-haiku-5-5" }, "arcLabels", "locked/claude-haiku-5-5", "label", "Arc labels", " Try: anthropic/claude-haiku-5-5."]] as const) {
		// `locked` has models but no credential, so Pi does not list it.
		assert.deepEqual(await providerModels(`provider-${name}`, hub, { providers: { locked: { models: [{ id: "claude-haiku-5-5" }] } }, fails: true }), { requests: 0 }, name);
		const err = providerRun!.job!.lastError!;
		assert.deepEqual([err.code, err.purpose, err.model, err.preflight], ["model", purpose, model, true], name);
		assert.equal(err.message, `No model named ${model} (hub.json, ${words}).`, name);
		assert.ok(err.hint!.startsWith(`Edit models.${key} in ${join(root, `provider-${name}-hub.json`)}.${tried} Available: anthropic/claude-`), `${name}: ${err.hint}`);
		assert.ok(err.available!.includes("anthropic/claude-sonnet-5-5") && !err.available!.some((m) => m.startsWith("locked/")), name);
		assert.deepEqual([providerRun!.build!.state, providerRun!.build!.errorCode, providerRun!.build!.calls, providerRun!.build!.models], ["error", "model", 0, undefined], name);
		assert.equal(providerRun!.build!.missingModel, model, name);
	}
	// Two bad keys: one Build failure names both, labels first, with one Available list.
	await providerModels("provider-both", { ...MODELS, arcLabels: "anthropic/claude-nope-8", arcSynthesis: nope }, { fails: true });
	const err = providerRun!.job!.lastError!;
	assert.deepEqual([err.purpose, err.model], ["label", "anthropic/claude-nope-8"]);
	assert.equal(err.message, "No model named anthropic/claude-nope-8 (hub.json, Arc labels). No model named anthropic/claude-nope-9 (hub.json, Arc synthesis).");
	assert.match(err.hint!, /^Edit models\.arcLabels in [^ ]*\. Edit models\.arcSynthesis in [^ ]*\. Available: anthropic\/claude-.*, \+\d+ more\.$/);
	// An unset key names the key and file, and the Build makes no provider call.
	await providerModels("provider-unset", { arcSynthesis: MODELS.arcSynthesis }, { fails: true });
	assert.equal(providerRun!.job!.lastError!.message, "No model set for Arc labels.");
	assert.equal(providerRun!.job!.lastError!.hint, `Set models.arcLabels in ${join(root, "provider-unset-hub.json")}. Use a provider/model-id from pi --list-models on the hub.`);
	assert.equal(providerRun!.build!.calls, 0);
});
