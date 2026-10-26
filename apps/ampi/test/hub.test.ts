import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helperModel, ModelNotFound, resolveHelperModel, type CarrierModel } from "../src/hub/helper-models.ts";
import { parsePiModels, piModelRegistry, setListTimeout } from "../src/pi/model-registry.ts";
import { Hub, hubProof, loadHubConfig } from "../src/hub/hub.ts";
import { runDaemon } from "../src/node/daemon.ts";
import { hydrate } from "../src/plugins.ts";
import { Browser, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };
const TOKEN = "a".repeat(64);


test("hub: replicas stay exact through compaction, a repeated sub never doubles a stream, foreign origins are refused", async () => {
	process.env.AMPI_WORKING_BUDGET = "2500";
	process.env.AMPI_COMPACT_KEEP_RECENT = "200";
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 50000, plugins: await hydrate() });
	const hub = new Hub({ hosts: [{ id: "local", label: "Local", kind: "local", home }] }, { token: TOKEN });
	const port = await hub.listen(0);
	try {
		const KEY = (p: number) => `ampi_k_${p}=${TOKEN}`;
		await assert.rejects(Browser.open(port, "https://evil.example", KEY(port)), /HTTP 403/);
		await assert.rejects(Browser.open(port, "http://127.0.0.1:5999", KEY(port)), /HTTP 403/, "another local page is not the hub's own page");
		await assert.rejects(Browser.open(port, undefined, KEY(port + 1)), /HTTP 403/, "a cookie for another port is not this hub's key");
		// A local process that sends no Origin is not trusted either: it needs the owner's access key.
		await assert.rejects(Browser.open(port, undefined), /HTTP 403/);
		await assert.rejects(Browser.open(port, undefined, `ampi_k_${port}=${"b".repeat(64)}`), /HTTP 403/);
		// The page learns the key once from `?k=` and keeps it in an HttpOnly cookie.
		const login = await fetch(`http://127.0.0.1:${port}/?k=${TOKEN}`, { redirect: "manual" });
		assert.equal(login.status, 303);
		assert.equal(login.headers.get("location"), "/");
		assert.match(login.headers.get("set-cookie") ?? "", new RegExp(`^${KEY(port)}; HttpOnly; SameSite=Strict`));
		assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(), { ok: true, proof: hubProof(TOKEN) }, "health reveals nothing but a proof");
		const browser = await Browser.open(port, undefined, KEY(port));
		const threads = browser.sub("local", { kind: "threads" });
		await browser.until(threads, () => true);
		const create = { cwd: home, model: SIM, prompt: "first\n/sim long 4", requestId: "create-once" };
		const { threadId } = await browser.req("local", "thread.create", create);
		// A retried create (lost response, double submit) finds the same thread and does not resubmit its prompt.
		const again = await Promise.all([browser.req("local", "thread.create", create), browser.req("local", "thread.create", create)]);
		assert.deepEqual(again.map((r) => r.threadId), [threadId, threadId]);
		// The same sid subscribed twice (a reconnect replay): the hub must keep exactly one node stream for it.
		const view = browser.sub("local", { kind: "thread", threadId }, 9001);
		browser.sub("local", { kind: "thread", threadId }, 9001);
		for (const content of ["two\n/sim long 4", "three\n/sim long 4", "four\n/sim long 4"]) {
			await browser.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId]?.queued === 0);
			await browser.req("local", "thread.submit", { threadId, content });
			await new Promise((r) => setTimeout(r, 300));
		}
		const compacted = await browser.until<any>(view, (v) => v.entries.some((e: any) => e.kind === "compaction"), 20_000);
		await browser.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId]?.queued === 0);
		await new Promise((r) => setTimeout(r, 500));
		const replica = browser.values.get(view) as any;
		const fresh = await browser.until<any>(browser.sub("local", { kind: "thread", threadId }), () => true);
		assert.deepEqual(
			replica.entries.map((e: any) => e.id),
			fresh.entries.map((e: any) => e.id),
			"the replica matches a fresh snapshot after compaction",
		);
		assert.ok(compacted.entries.length < 12);
		assert.deepEqual(new Set(replica.entries.map((e: any) => e.id)).size, replica.entries.length, "no duplicated entries");
		assert.deepEqual(browser.gaps, []);
		const index = browser.values.get(threads) as any;
		assert.equal(Object.values(index.threads).filter((t: any) => t.kind === "thread").length, 1, "one thread, not three");
		const history = await browser.req("local", "thread.history", { threadId, before: "1000000", limit: 500 });
		assert.equal(history.entries.filter((e: any) => e.kind === "user" && e.text.startsWith("first")).length, 1, "the prompt ran once");
		browser.ws.close();
	} finally {
		await hub.close();
		await daemon.stop();
		delete process.env.AMPI_WORKING_BUDGET;
		delete process.env.AMPI_COMPACT_KEEP_RECENT;
	}
});

test("hub helper models: the per-call model, else hub.json models.<purpose>, else none; no env var or default; a bad entry names the file; unread keys and env vars are named; loading keeps models (failure: a built-in default or AMPI_RAREBIT_*_MODEL chose the model)", () => {
	const dir = mkdtempSync(join(tmpdir(), "ampi-models-")), file = join(dir, "hub.json"), none = join(dir, "missing.json");
	const write = (body: unknown) => writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
	const saved = [process.env.AMPI_RAREBIT_RECAP_MODEL, process.env.AMPI_RAREBIT_ASK_MODEL], warn = console.warn, warned: string[] = [];
	console.warn = (m: string) => { warned.push(m); };
	try {
		write({ hosts: [], models: { rarebitAsk: "p/hub" } });
		process.env.AMPI_RAREBIT_ASK_MODEL = "p/env";
		assert.equal(helperModel("rarebitAsk", "p/arg", file), "p/arg");
		assert.equal(helperModel("rarebitAsk", "", file), "p/hub", "an empty per-call model is no choice");
		assert.equal(helperModel("rarebitAsk", undefined, none), null, "the env var is not read");
		assert.deepEqual(warned, [`ampi hub: AMPI_RAREBIT_ASK_MODEL is ignored; set models.rarebitAsk in ${file}.`, `ampi hub: AMPI_RAREBIT_ASK_MODEL is ignored; set models.rarebitAsk in ${none}.`]);
		helperModel("rarebitAsk", undefined, none);
		assert.equal(warned.length, 2, "a note is logged once until the notes change");
		delete process.env.AMPI_RAREBIT_ASK_MODEL;
		assert.deepEqual((["arcLabels", "arcSynthesis", "rarebitAsk"] as const).map((p) => helperModel(p, undefined, none)), [null, null, null], "no built-in default");
		assert.deepEqual(loadHubConfig(file).models, { rarebitAsk: "p/hub" });
		// models.arc and a typo are not read, and each is named once.
		write({ hosts: [], models: { arc: "p/arc", arcLabel: "p/typo", arcSynthesis: "p/synth" } });
		warned.length = 0;
		assert.deepEqual([helperModel("arcLabels", undefined, file), helperModel("arcSynthesis", undefined, file)], [null, "p/synth"]);
		assert.deepEqual(warned, ["ampi hub: models.arc is no longer read; set models.arcLabels and models.arcSynthesis.",
			"ampi hub: models.arcLabel is not a model key; use models.arcLabels, models.arcSynthesis, models.rarebitAsk."]);
		write({ hosts: [], models: { arcLabels: 5 } });
		assert.throws(() => helperModel("arcLabels", undefined, file), (e: Error & { code?: string }) => e.code === "no_model" && e.message === `${file}: models.arcLabels must be a provider/model-id string from pi --list-models`);
		write("{");
		assert.throws(() => helperModel("arcSynthesis", undefined, file), (e: Error) => e.message.includes(file));
	} finally {
		console.warn = warn;
		for (const [i, k] of (["AMPI_RAREBIT_RECAP_MODEL", "AMPI_RAREBIT_ASK_MODEL"] as const).entries()) if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i];
	}
});

// Rows as Pi 1.3.0 lists them on a machine with a direct Anthropic key, a local gateway and OpenRouter.
const PI_ROWS: CarrierModel[] = [
	{ provider: "anthropic", id: "claude-haiku-5-5" }, { provider: "anthropic", id: "claude-sonnet-5-5" },
	{ provider: "magpie", id: "anthropic/claude-haiku-5-5" }, { provider: "magpie", id: "claude/claude-haiku-5-5" }, { provider: "magpie", id: "claude/claude-sonnet-5-5" },
	{ provider: "magpie", id: "claude/claude-opus-5-5" }, { provider: "openrouter", id: "anthropic/claude-haiku-5-5" }, { provider: "openrouter", id: "anthropic/claude-opus-5-5" },
];

test("hub helper model resolution: only an exact provider/id row resolves; a miss re-reads once and names Try rows for the same id and every row as Available; an unset key fails with no registry read (failure: a bare or near name resolved to a route the owner did not choose)", async () => {
	const reads: boolean[] = [];
	let rows: CarrierModel[] = PI_ROWS.slice(0, 2);
	const registry = { list: async (fresh: boolean) => { reads.push(fresh); return rows; } };
	const miss = (purpose: "arcLabels" | "arcSynthesis", name: string | undefined) => resolveHelperModel(purpose, name, registry).then(() => assert.fail(name), (e: ModelNotFound) => e);
	assert.equal(await resolveHelperModel("arcLabels", "anthropic/claude-haiku-5-5", registry), "anthropic/claude-haiku-5-5");
	assert.deepEqual(reads, [false]);
	// An unset key: the error names the key and the file, and Pi is not asked.
	reads.length = 0;
	const unset = await miss("arcLabels", undefined);
	assert.deepEqual(reads, [], "an unset key reads no registry");
	assert.equal(unset.model, null);
	assert.equal(unset.message, "No model set for Arc labels. Set models.arcLabels in hub.json. Use a provider/model-id from pi --list-models on the hub.");
	// A wrong name: one re-read, then Try rows for the same id and every row, sorted, as Available.
	const wrong = await miss("arcSynthesis", "magpie/claude/claude-sonnet-5-5");
	assert.ok(wrong.code === "model_not_found" && wrong.purpose === "arcSynthesis" && wrong.model === "magpie/claude/claude-sonnet-5-5");
	assert.equal(wrong.message, "No model named magpie/claude/claude-sonnet-5-5 (per-Build model, Arc synthesis). Change or clear the per-Build model. Try: anthropic/claude-sonnet-5-5. Available: anthropic/claude-haiku-5-5, anthropic/claude-sonnet-5-5.");
	assert.deepEqual(reads, [false, true]);
	rows = PI_ROWS;
	assert.equal(await resolveHelperModel("arcSynthesis", "magpie/claude/claude-sonnet-5-5", registry), "magpie/claude/claude-sonnet-5-5", "a sign-in shows on the re-read");
	assert.equal(await resolveHelperModel("arcSynthesis", "anything"), "anything", "without a registry the name is used as written");
	// A bare id, a thinking suffix, a near name and a last-segment match never resolve.
	for (const name of ["claude-haiku-5-5", "claude-sonnet-5-5:high", "claude/claude-opus-5-5", "claude-opus-5-5"]) assert.ok((await miss("arcLabels", name)) instanceof ModelNotFound, name);
	assert.deepEqual((await miss("arcLabels", "claude-haiku-5-5")).misses[0]!.exact, ["anthropic/claude-haiku-5-5", "magpie/anthropic/claude-haiku-5-5", "magpie/claude/claude-haiku-5-5", "openrouter/anthropic/claude-haiku-5-5"], "Try rows carry the same id");
	assert.deepEqual((await miss("arcLabels", "anthropic/claude-nope-9")).misses[0]!.exact, [], "no near names");
	// Available lists 12 rows, then +N more; `available` keeps all.
	rows = Array.from({ length: 15 }, (_, i) => ({ provider: "p", id: `m-${String(i).padStart(2, "0")}` }));
	const many = await miss("arcLabels", "p/x");
	assert.equal(many.available!.length, 15);
	assert.ok(many.hint.endsWith("Available: p/m-00, p/m-01, p/m-02, p/m-03, p/m-04, p/m-05, p/m-06, p/m-07, p/m-08, p/m-09, p/m-10, p/m-11, +3 more."), many.hint);
	// One per-Build name that fails both Arc purposes reads as one miss; two names read as two, with one Available.
	rows = PI_ROWS.slice(0, 2);
	const both = ModelNotFound.merge(await miss("arcLabels", "anthropic/claude-nope-9"), await miss("arcSynthesis", "anthropic/claude-nope-9"));
	assert.equal(both.message, "No model named anthropic/claude-nope-9 (per-Build model, Arc labels and synthesis). Change or clear the per-Build model. Available: anthropic/claude-haiku-5-5, anthropic/claude-sonnet-5-5.");
	const two = ModelNotFound.merge(await miss("arcLabels", "x-1"), await miss("arcSynthesis", "y-1")) as ModelNotFound;
	assert.equal(two.summary, "No model named x-1 (per-Build model, Arc labels). No model named y-1 (per-Build model, Arc synthesis).");
	assert.equal(two.hint, "Change or clear the per-Build model. Available: anthropic/claude-haiku-5-5, anthropic/claude-sonnet-5-5.");
});

test("hub Pi model registry: the --list-models table parses, an unreadable list fails with registry_unreadable, and neither a failed read nor an empty table is cached (failure: one bad read hid every model until restart)", async () => {
	assert.deepEqual(parsePiModels("provider   model                    context\nanthropic  claude-haiku-5-5   1M\nmagpie     claude/claude-haiku-5-5  128K\n"), [{ provider: "anthropic", id: "claude-haiku-5-5" }, { provider: "magpie", id: "claude/claude-haiku-5-5" }]);
	assert.deepEqual(parsePiModels("No models available. Use /login to log into a provider.\n"), []);
	assert.deepEqual(parsePiModels("Update available: 1.3.1\nprovider model context\nanthropic claude-haiku-5-5 1M\n"), [{ provider: "anthropic", id: "claude-haiku-5-5" }], "a banner line before the header");
	assert.throws(() => parsePiModels("Usage: pi [options]"), (e: Error & { code?: string }) => e.code === "registry_unreadable" && /^Pi's model list format changed/.test(e.message));
	const dir = mkdtempSync(join(tmpdir(), "ampi-registry-")), bin = join(dir, "pi"), mode = join(dir, "mode");
	writeFileSync(bin, `#!${process.execPath}\nconst m = require("node:fs").readFileSync(${JSON.stringify(mode)}, "utf8");\nrequire("node:fs").appendFileSync(${JSON.stringify(join(dir, "reads"))}, "r");\nif (m === "slow") setTimeout(() => {}, 10000); else console.log(m === "bad" ? "garbage" : m === "empty" ? "No models available." : "provider model context\\nanthropic claude-haiku-5-5 1M");\n`);
	chmodSync(bin, 0o755);
	const saved = process.env.PI_BIN;
	process.env.PI_BIN = join(dir, "no-such-pi");
	try {
		await assert.rejects(piModelRegistry.list(false), (e: Error & { code?: string }) => e.code === "registry_unreadable" && /cannot run .*no-such-pi \(ENOENT\); check PI_BIN\.$/.test(e.message));
		process.env.PI_BIN = bin;
		for (const [m, expect] of [["bad", "registry_unreadable"], ["empty", 0], ["good", 1]] as const) {
			writeFileSync(mode, m);
			const listed = piModelRegistry.list(false);
			if (typeof expect === "string") await assert.rejects(listed, (e: Error & { code?: string }) => e.code === expect, m);
			else assert.equal((await listed).length, expect, m);
		}
		writeFileSync(mode, "bad");
		assert.equal((await piModelRegistry.list(false)).length, 1, "a good table is cached");
		await assert.rejects(piModelRegistry.list(true), (e: Error & { code?: string }) => e.code === "registry_unreadable", "fresh reads Pi again");
		writeFileSync(mode, "good");
		const before = readFileSync(join(dir, "reads"), "utf8").length;
		await Promise.all([piModelRegistry.list(true), piModelRegistry.list(true), piModelRegistry.list(false)]);
		assert.equal(readFileSync(join(dir, "reads"), "utf8").length - before, 1, "concurrent reads share one Pi run");
		writeFileSync(mode, "slow");
		setListTimeout(300);
		await assert.rejects(piModelRegistry.list(true), (e: Error & { code?: string }) => e.code === "registry_unreadable" && /\(timed out after 0\.3 s\); check PI_BIN\.$/.test(e.message), "a hung Pi is killed");
	} finally {
		setListTimeout(30_000);
		if (saved === undefined) delete process.env.PI_BIN; else process.env.PI_BIN = saved;
	}
});

test("hub.json: a Host add or remove re-reads the file and changes only hosts, so an owner's models edit survives; a malformed file fails the change with its path and is never rewritten (failure: hosts.add saved the startup snapshot)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ampi-hubjson-")), file = join(dir, "hub.json");
	const startup = { hosts: [], models: { arcLabels: "p/a" } };
	writeFileSync(file, JSON.stringify({ ...startup, note: "owner key" }));
	const hub = new Hub(structuredClone(startup), { configPath: file, token: TOKEN });
	const port = await hub.listen(0);
	try {
		const browser = await Browser.open(port, undefined, `ampi_k_${port}=${TOKEN}`);
		let id = 900;
		const hubOp = (op: string, args: Record<string, unknown>) => new Promise<any>((resolve) => {
			const mine = id++;
			browser.ws.on("message", (data) => { const frame = JSON.parse(String(data)); if (frame.t === "res" && frame.id === mine) resolve(frame); });
			browser.ws.send(JSON.stringify({ t: "hub", id: mine, op, args }));
		});
		const disk = () => JSON.parse(readFileSync(file, "utf8"));
		const edit = (change: (config: any) => void) => { const config = disk(); change(config); writeFileSync(file, JSON.stringify(config)); };
		// The owner edits models while the hub runs; the next Host change must keep the edit.
		edit((c) => { c.models.arcLabels = "p/b"; });
		const added = await hubOp("hosts.add", { target: "ampi-test.invalid" });
		assert.equal(added.ok, true, JSON.stringify(added));
		assert.deepEqual(disk().models, { arcLabels: "p/b" }, "hosts.add kept the owner's models edit");
		assert.equal(disk().note, "owner key");
		assert.deepEqual(disk().hosts.map((h: any) => h.target), ["ampi-test.invalid"]);
		assert.equal(helperModel("arcLabels", undefined, file), "p/b");
		edit((c) => { c.models.arcSynthesis = "p/c"; });
		const removed = await hubOp("hosts.remove", { id: added.value.id });
		assert.equal(removed.ok, true, JSON.stringify(removed));
		assert.deepEqual(disk(), { hosts: [], models: { arcLabels: "p/b", arcSynthesis: "p/c" }, note: "owner key" }, "hosts.remove kept every other key");
		assert.equal(helperModel("arcSynthesis", undefined, file), "p/c");
		// A file that no longer parses fails the change with its path; the hub neither writes it nor changes its Hosts.
		const kept = await hubOp("hosts.add", { target: "kept.invalid" });
		writeFileSync(file, "{ not json");
		const refused = await hubOp("hosts.add", { target: "refused.invalid" });
		assert.equal(refused.ok, false);
		assert.match(refused.error.message, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		const refusedRemove = await hubOp("hosts.remove", { id: kept.value.id });
		assert.equal(refusedRemove.ok, false);
		assert.match(refusedRemove.error.message, /not valid JSON/);
		assert.equal(readFileSync(file, "utf8"), "{ not json", "a malformed file is never rewritten");
		assert.deepEqual(hub.hostStates().map((h) => h.id), [kept.value.id], "the refused add and remove changed no Host");
		browser.ws.close();
	} finally {
		await hub.close();
	}
});
