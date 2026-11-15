import "./bound.ts";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { runDaemon } from "../src/node/daemon.ts";
import { readModelRoles } from "../src/node/model-roles.ts";
import { layerModelsJson } from "../src/node/models-json.ts";
import { listModels, modelsJsonErrors, openModels, startModel } from "../src/node/models.ts";
import { TestClient, tempHome } from "./helpers.ts";

/** An OpenAI chat-completions endpoint that streams one fixed reply and records each request. */
async function fakeCompletions() {
	const requests: { headers: IncomingHttpHeaders; body: any }[] = [];
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => (raw += chunk));
		req.on("end", () => {
			requests.push({ headers: req.headers, body: JSON.parse(raw || "{}") });
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (choice: object, extra: object = {}) =>
				res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m1", choices: [choice], ...extra })}\n\n`);
			chunk({ index: 0, delta: { role: "assistant", content: "hello from fake" }, finish_reason: null });
			chunk({ index: 0, delta: {}, finish_reason: "stop" }, { usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests, close: () => server.close() };
}

/** An Anthropic Messages endpoint that streams one fixed reply and records each request's path, headers and body. */
async function fakeMessages() {
	const requests: { url?: string; headers: IncomingHttpHeaders; body: any }[] = [];
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => (raw += chunk));
		req.on("end", () => {
			requests.push({ url: req.url, headers: req.headers, body: JSON.parse(raw || "{}") });
			res.writeHead(200, { "content-type": "text/event-stream" });
			const event = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
			event("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude/m1", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } });
			event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
			event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hello from messages" } });
			event("content_block_stop", { index: 0 });
			event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
			event("message_stop", {});
			res.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: () => server.close() };
}

function cacheMarks(value: unknown): { ttl?: string }[] {
	if (!value || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([key, item]) => (key === "cache_control" ? [item] : cacheMarks(item)));
}

function agentFixture(home: string, providers: object, settings: object): string {
	const agentDir = join(home, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers }));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
	return agentDir;
}

test("models: a models.json custom provider is listed, starts new threads, and streams with its configured auth", async () => {
	const fake = await fakeCompletions();
	const home = tempHome();
	process.env.AMPI_TEST_FAKECO_KEY = "key-env";
	const agentDir = agentFixture(
		home,
		{
			fakeco: {
				baseUrl: fake.url,
				api: "openai-completions",
				apiKey: "$AMPI_TEST_FAKECO_KEY",
				headers: { "X-Team": "durable" },
				models: [{ id: "m1", name: "Fake One", reasoning: true }, { id: "m2" }],
				modelOverrides: { m1: { contextWindow: 7777 } },
			},
		},
		{ defaultProvider: "fakeco", defaultModel: "m1", defaultThinkingLevel: "high" },
	);
	const daemon = await runDaemon({ home, agentDir, simTokensPerSecond: 5000, testProviders: ["fakeco"] });
	try {
		const client = await TestClient.connect(daemon.socket);
		const listed = await client.req("models.list", {});
		const m1 = listed.find((m: any) => m.provider === "fakeco" && m.id === "m1");
		assert.deepEqual([m1?.name, m1?.contextWindow, m1?.default], ["Fake One", 7777, true], "the override reaches models.list; settings pick the default");

		const { threadId } = await client.req("thread.create", { requestId: "fake-1", cwd: home, place: { workspace: "new", label: "Fake" }, prompt: "hi" });
		const view = client.sub({ kind: "thread", threadId });
		const reply = (await client.until<any>(view, (v) => v.entries?.some((e: any) => e.kind === "assistant" && e.stop))).entries.find((e: any) => e.kind === "assistant");
		assert.equal(reply.error, undefined);
		assert.deepEqual([reply.model, reply.blocks.map((b: any) => b.text).join("")], ["fakeco/m1", "hello from fake"]);
		const commands = await client.req("thread.commands", { threadId });
		assert.deepEqual([commands.model, commands.thinking], ["fakeco/m1", "high"], "defaultThinkingLevel applies to a reasoning model");
		assert.equal(fake.requests.length, 1);
		assert.equal(fake.requests[0]!.headers.authorization, "Bearer key-env", "the $ENV apiKey resolves at request time");
		assert.equal(fake.requests[0]!.headers["x-team"], "durable");
		assert.equal(fake.requests[0]!.body.model, "m1");
		client.close();
	} finally {
		await daemon.stop();
		fake.close();
		delete process.env.AMPI_TEST_FAKECO_KEY;
	}
});

test("models: a list re-reads a changed models.json, so a synced catalog needs no node restart", async () => {
	const home = tempHome();
	const fakeco = (ids: string[]) => ({ baseUrl: "http://127.0.0.1:9", api: "openai-completions", apiKey: "literal-key", models: ids.map((id) => ({ id })) });
	const agentDir = agentFixture(home, { fakeco: fakeco(["m1"]) }, {});
	const models = openModels({ agentDir });
	const ids = async () => (await listModels(models)).filter((m) => m.provider !== "ampi-sim").map((m) => `${m.provider}/${m.id}`).sort();
	assert.deepEqual(await ids(), ["fakeco/m1"]);
	// A sync adds a model and a provider: the next list has both.
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fakeco: fakeco(["m1", "m2-new"]), newco: fakeco(["n1"]) } }));
	assert.deepEqual(await ids(), ["fakeco/m1", "fakeco/m2-new", "newco/n1"]);
	// A file caught mid-write changes nothing; the next good read applies, and a removed provider goes.
	writeFileSync(join(agentDir, "models.json"), '{"providers": {"fakeco"');
	assert.deepEqual(await ids(), ["fakeco/m1", "fakeco/m2-new", "newco/n1"]);
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fakeco: fakeco(["m1", "m2-new"]) } }));
	assert.deepEqual(await ids(), ["fakeco/m1", "fakeco/m2-new"]);
});

test("models: Pi's saved catalogs (models-store.json) restore over the built-in providers, under models.json, and a change needs no restart", async () => {
	const home = tempHome();
	const builtin = builtinProviders().find((p) => p.id === "anthropic")!.getModels()[0]!;
	const saved = (provider: string, id: string) => ({ ...builtin, provider, id, name: id });
	const agentDir = agentFixture(home, { anthropic: { modelOverrides: { "claude-saved-2": { contextWindow: 4242 } } } }, {});
	const store = (entries: object | string) => writeFileSync(join(agentDir, "models-store.json"), typeof entries === "string" ? entries : JSON.stringify(entries));
	const future = Date.now() + 365 * 86_400_000;
	store({
		anthropic: { models: [saved("anthropic", "claude-saved-1"), saved("other", "not-anthropic")], lastModified: future, checkedAt: Date.now() },
		openai: { models: [saved("openai", "older-than-builtins")], lastModified: 1 },
		openrouter: { models: [saved("openrouter", "only-this")] },
	});
	const models = openModels({ agentDir });
	assert.ok(models.getModel("anthropic", "claude-saved-1"), "a saved catalog newer than the built-in data adds its models");
	assert.ok(models.getModel("anthropic", builtin.id), "the built-in models stay");
	assert.equal(models.getModel("anthropic", "not-anthropic"), undefined, "an entry for another provider is ignored");
	assert.equal(models.getModel("openai", "older-than-builtins"), undefined, "a catalog older than the built-in data is ignored");
	assert.deepEqual(models.getModels().filter((m) => m.provider === "openrouter").map((m) => m.id), ["only-this"], "openrouter's saved catalog replaces its built-ins");
	// `pi update --models` saves a newer catalog while the node runs: the next list has it, with models.json on top.
	store({ anthropic: { models: [saved("anthropic", "claude-saved-1"), saved("anthropic", "claude-saved-2")], lastModified: future } });
	await listModels(models);
	assert.equal(models.getModel("anthropic", "claude-saved-2")?.contextWindow, 4242, "models.json overrides apply to saved models");
	assert.ok(models.getModels().some((m) => m.provider === "openrouter" && m.id !== "only-this"), "without a saved catalog, openrouter is built-in again");
	// A store caught mid-write changes nothing.
	store('{"anthropic": {"models"');
	await listModels(models);
	assert.ok(models.getModel("anthropic", "claude-saved-2"));
});

test("models: Pi's start order, thinking levels, overrides of a built-in provider, and models.json errors", async () => {
	const home = tempHome();
	const builtin = builtinProviders().find((p) => p.id === "anthropic")!.getModels()[0]!;
	process.env.AMPI_TEST_FAKECO_KEY = "k";
	const agentDir = agentFixture(
		home,
		{
			fakeco: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "$AMPI_TEST_FAKECO_KEY", models: [{ id: "a/one", reasoning: true }, { id: "two" }] },
			anthropic: { modelOverrides: { [builtin.id]: { contextWindow: 4242, cost: { input: 99 } } } },
			broken: { api: "openai-completions" },
		},
		{},
	);
	try {
		const models = openModels({ agentDir });
		const overridden = models.getModel("anthropic", builtin.id)!;
		assert.deepEqual([overridden.contextWindow, overridden.cost.input, overridden.cost.output], [4242, 99, builtin.cost.output], "cost fields merge; others replace");
		assert.match(modelsJsonErrors(models).join("\n"), /Provider broken: must specify/);

		const start = (settings: object) => startModel(models, settings);
		assert.deepEqual(await start({ enabledModels: ["nope/x", "fakeco/a/one:low"], defaultProvider: "fakeco", defaultModel: "two" }), { provider: "fakeco", modelId: "a/one", thinkingLevel: "low" }, "the first enabledModels match wins, with its suffix");
		assert.deepEqual(await start({ enabledModels: ["fakeco/*"] }), { provider: "fakeco", modelId: "a/one", thinkingLevel: "medium" }, "a glob matches; Pi's default thinking is medium");
		assert.deepEqual(await start({ defaultProvider: "fakeco", defaultModel: "a/one", modelThinkingLevels: { "fakeco/a/one": "xhigh" }, defaultThinkingLevel: "low" }), { provider: "fakeco", modelId: "a/one", thinkingLevel: "xhigh" });
		assert.deepEqual(await start({ defaultProvider: "fakeco", defaultModel: "two", defaultThinkingLevel: "high" }), { provider: "fakeco", modelId: "two", thinkingLevel: "off" }, "a model without reasoning starts with thinking off");
		delete process.env.AMPI_TEST_FAKECO_KEY;
		const unavailable = await start({ defaultProvider: "fakeco", defaultModel: "two" });
		assert.notEqual(unavailable.provider, "fakeco", "a default whose provider has no auth is skipped, as in Pi");
	} finally {
		delete process.env.AMPI_TEST_FAKECO_KEY;
	}
});

test("models: the Worker model-role catalog follows Pi Team Bright's rules", () => {
	const home = tempHome();
	const agentDir = join(home, "agent");
	const project = join(home, "proj");
	mkdirSync(join(project, ".pi"), { recursive: true });
	mkdirSync(join(project, ".git"));
	mkdirSync(agentDir, { recursive: true });
	const role = (model: string, thinking = "medium") => ({ model, thinking, use: `use ${model}` });
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProjectTrust: "always",
			pi_team_bright: { default_model_role: "worker", model_roles: { worker: role("p/w"), reviewer: role("p/r", "high"), bad: { model: "noslash", thinking: "low", use: "x" } } },
		}),
	);
	const global = readModelRoles(home, { agentDir, home });
	assert.deepEqual(global.roles.map((r) => [r.name, `${r.model.provider}/${r.model.modelId}`, r.thinking]), [["worker", "p/w", "medium"], ["reviewer", "p/r", "high"]]);
	assert.deepEqual([global.defaultRole, global.invalidDefault, global.invalid], ["worker", false, ["bad"]]);

	writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ pi_team_bright: { default_model_role: "lead", model_roles: { reviewer: role("q/r", "max"), worker: { model: "p/w" } } } }));
	const merged = readModelRoles(project, { agentDir, home });
	assert.deepEqual(merged.roles.map((r) => [r.name, `${r.model.provider}/${r.model.modelId}`, r.thinking]), [["reviewer", "q/r", "max"]], "a project role replaces; an invalid one hides the global role");
	assert.deepEqual([merged.defaultRole, merged.invalidDefault], ["lead", true], "the project default wins and names no valid role");
	assert.ok(merged.diagnostics.some((d) => d.source === "project" && /no valid definition/.test(d.message)));
});

test("models: the node home's models.json moves one Pi model to Messages with the client cache-mark header; Pi's file stays as it was", async () => {
	const chat = await fakeCompletions();
	const messages = await fakeMessages();
	const home = tempHome();
	process.env.AMPI_TEST_GATEWAY_KEY = "gateway-key";
	const agentDir = agentFixture(
		home,
		{
			gateway: {
				baseUrl: chat.url,
				api: "openai-completions",
				apiKey: "$AMPI_TEST_GATEWAY_KEY",
				compat: { sendSessionAffinityHeaders: true },
				models: [{ id: "claude/m1", name: "Claude One", reasoning: true, contextWindow: 9999 }, { id: "codex/m2" }],
			},
		},
		{ defaultProvider: "gateway", defaultModel: "claude/m1" },
	);
	const piFile = readFileSync(join(agentDir, "models.json"), "utf8");
	writeFileSync(
		join(home, "models.json"),
		JSON.stringify({ providers: { gateway: { models: [{ id: "claude/m1", api: "anthropic-messages", baseUrl: messages.url, headers: { "X-Magpie-Cache-Marks": "client" } }] } } }),
	);
	const daemon = await runDaemon({ home, agentDir, simTokensPerSecond: 5000, testProviders: ["gateway"] });
	try {
		const client = await TestClient.connect(daemon.socket);
		const listed = (await client.req("models.list", {})).filter((m: any) => m.provider === "gateway");
		assert.deepEqual(
			listed.map((m: any) => [m.id, m.name, m.contextWindow, m.reasoning]),
			[["claude/m1", "Claude One", 9999, true], ["codex/m2", "codex/m2", 128000, false]],
			"the layered model keeps Pi's identity, limits and reasoning",
		);
		const { threadId } = await client.req("thread.create", { requestId: "messages-1", cwd: home, place: { workspace: "new", label: "Messages" }, prompt: "hi" });
		const view = client.sub({ kind: "thread", threadId });
		const reply = (await client.until<any>(view, (v) => v.entries?.some((e: any) => e.kind === "assistant" && e.stop))).entries.find((e: any) => e.kind === "assistant");
		assert.equal(reply.error, undefined);
		assert.deepEqual([reply.model, reply.blocks.map((b: any) => b.text).join("")], ["gateway/claude/m1", "hello from messages"]);
		assert.equal(chat.requests.length, 0, "the layered model no longer uses Chat");
		assert.equal(messages.requests.length, 1);
		const sent = messages.requests[0]!;
		assert.match(sent.url ?? "", /^\/v1\/messages/);
		assert.equal(sent.headers["x-magpie-cache-marks"], "client", "the opt-in header reaches the gateway");
		assert.ok([sent.headers["x-api-key"], sent.headers.authorization].some((value) => String(value).includes("gateway-key")), "Pi's provider auth applies");
		assert.equal(sent.body.model, "claude/m1");
		const marks = cacheMarks(sent.body);
		assert.ok(marks.length >= 1 && marks.length <= 4, `Cache Goblin places 1 to 4 marks on the wire; saw ${marks.length}`);
		assert.equal(sent.body.system.at(-1).cache_control?.ttl, "1h", "the system layer carries the 1h layer mark");
		assert.equal(sent.body.messages.at(-1).content.at(-1).cache_control?.ttl, "5m", "the tail carries the conversation TTL");
		assert.equal(readFileSync(join(agentDir, "models.json"), "utf8"), piFile, "Pi's models.json is unchanged");
		client.close();
	} finally {
		await daemon.stop();
		chat.close();
		messages.close();
		delete process.env.AMPI_TEST_GATEWAY_KEY;
	}
});

test("models: layerModelsJson merges by provider, model id and override id; Pi's providers and errors stay", () => {
	const pi = {
		path: "pi/models.json",
		error: "pi/models.json: bad",
		providers: {
			keep: { api: "openai-completions" },
			gw: { api: "openai-completions", headers: { A: "1" }, compat: { x: true }, models: [{ id: "m1", compat: { y: 1 } }, { id: "m2" }], modelOverrides: { m3: { name: "Three", contextWindow: 3 } } },
		},
	};
	const node = { path: "node/models.json", providers: { gw: { headers: { B: "2" }, models: [{ id: "m1", api: "anthropic-messages", compat: { z: 2 } }, { id: "m4" }], modelOverrides: { m3: { contextWindow: 33 } } }, added: { api: "x" } } };
	const layered = layerModelsJson(pi, node);
	assert.deepEqual(layered.providers.keep, pi.providers.keep);
	assert.deepEqual(layered.providers.added, { api: "x" });
	assert.deepEqual(layered.providers.gw, {
		api: "openai-completions",
		headers: { A: "1", B: "2" },
		compat: { x: true },
		models: [{ id: "m1", api: "anthropic-messages", compat: { y: 1, z: 2 } }, { id: "m2" }, { id: "m4" }],
		modelOverrides: { m3: { name: "Three", contextWindow: 33 } },
	});
	assert.equal(layered.error, "pi/models.json: bad");
	assert.deepEqual(layerModelsJson(pi, { path: "node/models.json", providers: {} }).providers, pi.providers, "no node file leaves Pi's layer as it is");
});
