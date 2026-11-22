import "./bound.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import type { PiEntry } from "../src/shared/protocol.ts";
import { openCalls } from "../src/shared/tool-state.ts";
import { longestRunningToolCall, runningToolCalls, TOOL_ELAPSED_MAX_MS, TOOL_ELAPSED_WARN_MS, toolElapsedTone } from "../web/src/components/tool-elapsed.ts";
import { toolRuns } from "../web/src/views/rarebit/tool-runs.ts";

const T0 = 1_700_000_000_000;
const web = fileURLToPath(new URL("../web/", import.meta.url));
let vite: ViteDevServer;
let ToolCall: (props: Record<string, unknown>) => any;
let RarebitTools: (props: Record<string, unknown>) => any;

before(async () => {
	vite = await createServer({
		configFile: `${web}vite.config.ts`,
		root: web,
		logLevel: "silent",
		server: { middlewareMode: true, hmr: false },
		plugins: [{
			name: "stub-client-for-ssr",
			enforce: "pre",
			resolveId(id) { if (id.endsWith("/client.ts") || id === "./client.ts") return "\0stub-client"; },
			load(id) { if (id === "\0stub-client") return "export const useTopic = () => ({ value: undefined, error: undefined });"; },
		}],
	});
	({ ToolCall } = await vite.ssrLoadModule("/src/components/ToolCall.tsx"));
	({ RarebitTools } = await vite.ssrLoadModule("/src/views/rarebit/Lens.tsx"));
});
after(async () => { await vite?.close(); });

test("toolElapsedTone: normal below 10s, log-scale orange-to-red from 10s to 1000m, clamped at ends", () => {
	assert.deepEqual(toolElapsedTone(-5_000), { text: "0s", ratio: null, pct: null });
	assert.deepEqual(toolElapsedTone(0), { text: "0s", ratio: null, pct: null });
	assert.deepEqual(toolElapsedTone(9_999), { text: "9s", ratio: null, pct: null });

	const at10s = toolElapsedTone(TOOL_ELAPSED_WARN_MS);
	assert.equal(at10s.text, "10s");
	assert.equal(at10s.ratio, 0);
	assert.equal(at10s.pct, 0);

	const at100s = toolElapsedTone(100_000);
	assert.equal(at100s.text, "1m 40s");
	assert.ok(at100s.ratio !== null && Math.abs(at100s.ratio - 1 / Math.log10(6_000)) < 1e-6);
	assert.equal(at100s.pct, 26);

	const at1000s = toolElapsedTone(1_000_000);
	assert.equal(at1000s.text, "16m 40s");
	assert.ok(at1000s.ratio !== null && Math.abs(at1000s.ratio - 2 / Math.log10(6_000)) < 1e-6);
	assert.equal(at1000s.pct, 53);

	const at1000m = toolElapsedTone(TOOL_ELAPSED_MAX_MS);
	assert.equal(at1000m.text, "16h 40m 0s");
	assert.equal(at1000m.ratio, 1);
	assert.equal(at1000m.pct, 100);

	const beyond = toolElapsedTone(TOOL_ELAPSED_MAX_MS * 2);
	assert.equal(beyond.ratio, 1);
	assert.equal(beyond.pct, 100);
});

test("runningToolCalls: sequential batch advances startedAt to latest sibling tool-result", () => {
	const entries: PiEntry[] = [
		{
			kind: "assistant",
			id: "a1",
			ts: T0,
			blocks: [
				{ type: "tool", callId: "c1", name: "read", args: { summary: "a.ts" } },
				{ type: "tool", callId: "c2", name: "bash", args: { summary: "sleep 30" } },
				{ type: "tool", callId: "c3", name: "edit", args: { summary: "b.ts" } },
			],
		},
		{ kind: "tool-result", id: "r1", ts: T0 + 5_000, callId: "c1", name: "read", text: "ok", isError: false, truncated: false },
	];
	const open = openCalls(entries);
	assert.deepEqual([...open], ["c2", "c3"]);

	const idle = runningToolCalls(entries, open, false);
	assert.equal(idle.size, 0, "unfinished calls when not busy produce no running timers");

	const running = runningToolCalls(entries, open, true);
	assert.equal(running.size, 2);
	assert.deepEqual(running.get("c2"), { callId: "c2", name: "bash", startedAt: T0 + 5_000 });
	assert.deepEqual(running.get("c3"), { callId: "c3", name: "edit", startedAt: T0 + 5_000 });
	assert.deepEqual(longestRunningToolCall(running), {
		call: { callId: "c2", name: "bash", startedAt: T0 + 5_000 },
		parallelCount: 2,
	});
});

test("runningToolCalls: preserves calls across [tool, text, tool] split and picks earliest start on parallel calls", () => {
	const entries: PiEntry[] = [
		{
			kind: "assistant",
			id: "a1",
			ts: T0,
			blocks: [
				{ type: "tool", callId: "c1", name: "bash", args: { summary: "long" } },
				{ type: "text", text: "Checking both..." },
				{ type: "tool", callId: "c2", name: "read", args: { summary: "file" } },
			],
		},
	];
	const open = openCalls(entries);
	const running = runningToolCalls(entries, open, true);
	assert.deepEqual([...running.keys()], ["c1", "c2"]);

	const parts = toolRuns(entries, true);
	const lastRun = parts.findLast((p) => p.kind === "run");
	assert.ok(lastRun && lastRun.kind === "run" && lastRun.running);

	const distinct = new Map([
		["later", { callId: "later", name: "read", startedAt: T0 + 20_000 }],
		["earlier", { callId: "earlier", name: "bash", startedAt: T0 + 2_000 }],
	]);
	assert.deepEqual(longestRunningToolCall(distinct), {
		call: { callId: "earlier", name: "bash", startedAt: T0 + 2_000 },
		parallelCount: 2,
	});
});

test("runningToolCalls: aborted assistant entries and completed calls are excluded", () => {
	const aborted: PiEntry[] = [
		{
			kind: "assistant",
			id: "a1",
			ts: T0,
			stop: "aborted",
			blocks: [{ type: "tool", callId: "c1", name: "bash", args: { summary: "sleep 30" } }],
		},
	];
	assert.equal(runningToolCalls(aborted, openCalls(aborted), true).size, 0);

	const completed: PiEntry[] = [
		{
			kind: "assistant",
			id: "a1",
			ts: T0,
			blocks: [{ type: "tool", callId: "c1", name: "bash", args: { summary: "echo hi" } }],
		},
		{ kind: "tool-result", id: "r1", ts: T0 + 1_000, callId: "c1", name: "bash", text: "hi", isError: false, truncated: false },
	];
	assert.equal(runningToolCalls(completed, openCalls(completed), true).size, 0);
});

test("ToolCall and RarebitTools render elapsed duration only for running calls with log-scale color", () => {
	const freshHtml = renderToStaticMarkup(createElement(ToolCall, { name: "bash", args: { summary: "ls" }, callOpen: true, active: true, startedAt: T0, now: T0 + 4_000 }));
	assert.match(freshHtml, /running <span class="tool-elapsed">4s<\/span>/);
	assert.doesNotMatch(freshHtml, /tool-elapsed warn/);

	const slowHtml = renderToStaticMarkup(createElement(ToolCall, { name: "bash", args: { summary: "npm test" }, callOpen: true, active: true, startedAt: T0, now: T0 + 100_000 }));
	assert.match(slowHtml, /running <span class="tool-elapsed warn" style="--elapsed-pct:26%">1m 40s<\/span>/);

	const doneHtml = renderToStaticMarkup(createElement(ToolCall, { name: "bash", args: { summary: "ls" }, result: { text: "ok", isError: false }, callOpen: false, active: true, startedAt: T0, now: T0 + 100_000 }));
	assert.doesNotMatch(doneHtml, /tool-elapsed/);

	const unfinishedHtml = renderToStaticMarkup(createElement(ToolCall, { name: "bash", args: { summary: "ls" }, callOpen: true, active: false, startedAt: T0, now: T0 + 100_000 }));
	assert.doesNotMatch(unfinishedHtml, /tool-elapsed/);

	const run = { kind: "run" as const, id: "a1:0", entries: [], keys: [], calls: 2, errors: 0, start: T0, end: T0 + 5_000, running: true, label: "2 tool calls" };
	const chatSingle = renderToStaticMarkup(createElement(RarebitTools, {
		run,
		runningTool: { call: { callId: "c1", name: "bash", startedAt: T0 }, parallelCount: 1 },
		now: T0 + 100_000,
		children: null,
	}));
	assert.match(chatSingle, /running · bash <span class="tool-elapsed warn" style="--elapsed-pct:26%">1m 40s<\/span>/);

	const chatParallel = renderToStaticMarkup(createElement(RarebitTools, {
		run,
		runningTool: { call: { callId: "c1", name: "bash", startedAt: T0 }, parallelCount: 3 },
		now: T0 + 100_000,
		children: null,
	}));
	assert.match(chatParallel, /running · bash \(\+2\) <span class="tool-elapsed warn" style="--elapsed-pct:26%">1m 40s<\/span>/);

	const chatDone = renderToStaticMarkup(createElement(RarebitTools, {
		run: { ...run, running: false },
		runningTool: undefined,
		now: T0 + 100_000,
		children: null,
	}));
	assert.doesNotMatch(chatDone, /tool-elapsed/);
});
