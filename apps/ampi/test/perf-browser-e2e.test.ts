import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hub } from "../src/hub/hub.ts";
import { runDaemon } from "../src/node/daemon.ts";
import { hydrate } from "../src/plugins.ts";
import { Browser, tempHome } from "./helpers.ts";
// @ts-expect-error: a plain ESM script without types
import { findChrome, runScenario } from "../scripts/perf/browser.mjs";

// The browser driver end to end: headless Chrome against a real hub. Exhaustive lane only (about 15 s).
const TOKEN = "c".repeat(64);
const SIM = { provider: "ampi-sim", modelId: "sim-1" };
const epochUs = () => (performance.timeOrigin + performance.now()) * 1000;

test("perf browser: the switch scenario on a real hub records first data, timed switches, and a trace on the runner clock", { skip: !findChrome() ? "no Chrome" : !existsSync(join(import.meta.dirname, "..", "web", "dist", "index.html")) ? "web/dist is not built" : false }, async (t) => {
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 50000, plugins: await hydrate() });
	const hub = new Hub({ hosts: [{ id: "local", label: "Local", kind: "local", home }] }, { token: TOKEN });
	const port = await hub.listen(0);
	t.after(async () => {
		await hub.close();
		await daemon.stop();
	});
	const client = await Browser.open(port, undefined, `ampi_k_${port}=${TOKEN}`);
	const threads = client.sub("local", { kind: "threads" });
	for (const word of ["alpha", "beta", "gamma"]) await client.req("local", "thread.create", { cwd: home, model: SIM, prompt: `${word}\n/sim bash echo ${word}` });
	await client.until<any>(threads, (v) => Object.values(v.threads).filter((x: any) => x.activity === "idle").length === 3, 20_000);
	client.ws.close();

	const runDir = mkdtempSync(join(tmpdir(), "ampi-perf-run-"));
	const logs: string[] = [];
	const start = epochUs();
	const result = await runScenario({ url: `http://127.0.0.1:${port}/?k=${TOKEN}`, origin: `http://127.0.0.1:${port}`, runDir, scenario: "switch", sessions: 3, epochUs, signal: AbortSignal.timeout(60_000), log: (m: string) => logs.push(m) });
	const end = epochUs();
	assert.equal(result.error, undefined);
	assert.equal(result.ok, true);
	const names = result.marks.map((m: any) => m.name);
	for (const name of ["navigate", "first-paint", "first-data", "sessions-listed", "scenario-end"]) assert.equal(names.filter((n: string) => n === name).length, 1, `one ${name}`);
	const first = result.marks.filter((m: any) => m.name === "switch-done-first");
	const revisit = result.marks.filter((m: any) => m.name === "switch-done-revisit");
	assert.deepEqual([first.map((m: any) => m.args.visit), revisit.map((m: any) => m.args.visit)], [[0, 1, 2], [0, 1, 2]]);
	for (const m of result.marks) {
		assert.ok(m.ts > start && m.ts < end, `${m.name} is on the runner clock`);
		if (m.dur !== undefined) assert.ok(m.dur > 0 && m.dur < 15_000_000);
	}
	const at = (name: string) => result.marks.find((m: any) => m.name === name).ts;
	assert.ok(at("navigate") < at("first-paint") && at("first-paint") <= at("first-data") + 50_000 && at("first-data") < at("scenario-end"));
	assert.ok(at("scenario-end") - revisit.at(-1).ts >= 1_000_000, "a 1 s idle ends the scenario");

	const raw = readFileSync(join(runDir, "trace-browser.json"), "utf8");
	assert.ok(!raw.includes(TOKEN), "no access key in the trace");
	assert.ok(!logs.join("\n").includes(TOKEN));
	const events = JSON.parse(raw).traceEvents;
	const browserMeta = events.find((e: any) => e.ph === "M" && e.name === "process_name" && e.args.name === "browser");
	assert.ok(browserMeta && typeof browserMeta.args.clockOffsetUs === "number");
	assert.ok(events.some((e: any) => e.ph === "M" && e.name === "process_name" && /^browser:Renderer/.test(e.args.name)));
	// Chrome's own copy of a page mark agrees with the mark the driver returned, within a millisecond.
	const chromeFirstData = events.find((e: any) => e.name === "ampi:first-data" && e.ph !== "M");
	assert.ok(chromeFirstData, "the page marks are in Chrome's trace");
	assert.ok(Math.abs(chromeFirstData.ts - at("first-data")) < 1000, `clocks agree: ${chromeFirstData.ts - at("first-data")} µs`);
	const timed = events.filter((e: any) => e.ph === "X" && e.dur > 0);
	assert.ok(timed.length > 100);
	assert.ok(timed.every((e: any) => e.ts > start - 1_000_000 && e.ts < end + 1_000_000), "every span is on the runner clock");
	assert.equal(events.filter((e: any) => e.name === "switch-first").length, 3);
});
