import assert from "node:assert/strict";
import test from "node:test";
import type { UiEntry } from "../src/node/projection.ts";
import { runClock, runDuration, toolRuns, type ToolRun } from "../web/src/views/rarebit/tool-runs.ts";

const prose = (id: string, ts?: number): UiEntry => ({ id, ts, kind: "assistant", blocks: [{ type: "text", text: id }] });
const call = (id: string, ts?: number): UiEntry => ({ id, ts, kind: "assistant", blocks: [{ type: "thinking", text: "Inspect the evidence." }, { type: "tool", callId: id, name: "bash", args: { command: "pwd" } }] });
const result = (id: string, ts?: number, isError = false): UiEntry => ({ id: `${id}-result`, ts, kind: "tool-result", callId: id, name: "bash", text: "result", isError, truncated: false });
const runs = (entries: UiEntry[], live = false) => toolRuns(entries, live).filter((p): p is ToolRun => p.kind === "run");

test("lens folds calls, results and thinking across entries between prose timestamps", () => {
	const entries = [prose("before", 0), call("a", 1000), result("a", 2000), call("b", 3000), result("b", 4000, true), prose("after", 252000)];
	const snapshot = structuredClone(entries);
	const [run] = runs(entries, true);
	assert.equal(runs(entries).length, 1);
	assert.equal(run.calls, 2);
	assert.equal(run.errors, 1);
	assert.equal(runDuration(run.start, run.end), "4m 12s");
	assert.equal(run.running, false);
	assert.deepEqual(run.entries, entries.slice(1, -1));
	assert.deepEqual(entries, snapshot);
});

test("lens splits at prose within one assistant entry and preserves terminal errors", () => {
	const entry: UiEntry = { id: "mixed", ts: 1000, kind: "assistant", stop: "error", error: "provider failed", blocks: [
		{ type: "thinking", text: "first" }, { type: "text", text: "prose" }, { type: "tool", callId: "a", name: "read", args: {} },
	] };
	const parts = toolRuns([entry]);
	assert.deepEqual(parts.map((p) => p.kind), ["run", "entry", "run", "entry"]);
	assert.equal((parts[0] as ToolRun).calls, 0);
	assert.equal((parts[2] as ToolRun).calls, 1);
	assert.equal(parts[3].kind === "entry" && parts[3].entry.kind === "assistant" && parts[3].entry.error, "provider failed");
});

test("open runs end at their latest step and only live turns say running", () => {
	const entries = [prose("before", 0), call("a", 1000), result("a", 5000)];
	assert.equal(runs(entries, true)[0].end, 5000);
	assert.equal(runs(entries, true)[0].running, true);
	assert.equal(runs(entries)[0].running, false);
});

test("a window starting at a result retains the result and counts its call once", () => {
	const entries = [result("a", 1000), call("b", 2000), result("b", 3000), prose("after", 4000)];
	assert.equal(runs(entries)[0].calls, 2);
	assert.equal(runs(entries)[0].start, 1000);
	assert.deepEqual(runs(entries)[0].entries, entries.slice(0, -1));
	assert.equal(runs([call("b", 2000), ...entries.slice(2)])[0].calls, 1);
});

test("thinking-only runs remain inspectable; missing and reversed times stay explicit", () => {
	assert.equal(runs([{ id: "thought", kind: "assistant", blocks: [{ type: "thinking", text: "Inspect" }] }])[0].calls, 0);
	assert.equal(runDuration(undefined, 1000), "time unavailable");
	assert.equal(runDuration(1000, 0), "time unavailable");
	assert.equal(runClock(undefined), "?");
	assert.match(runClock(0), /^\d{2}:\d{2}$/);
});

const custom = (id: string, entryKind: string, ts?: number): UiEntry => ({ id, ts, kind: "custom", entryKind, text: id });

test("every non-prose entry is a run step; the run label counts each kind", () => {
	const entries: UiEntry[] = [
		prose("before", 0),
		call("a", 1000), custom("dm", "pi-team-bright.direct-message", 1100), result("a", 1200),
		custom("ix", "intercom_message", 1300), call("b", 1400), custom("tu", "ptb.team-update", 1500), result("b", 1600),
		{ id: "c", kind: "compaction", ts: 1700, summary: "Keep the evidence" },
		custom("ho", "auto-compact.handoff", 1800), custom("pu", "auto-compact.pickup", 1900),
		custom("ix2", "intercom_sent", 2000), call("c", 2100), result("c", 2200), custom("ack", "pi-team-bright.task-change", 2300),
		{ id: "r", kind: "reset", ts: 2400 }, custom("other", "web-search-results", 2500), custom("x", "rarebit-recap", 2600), call("d", 2700),
		{ id: "u", kind: "user", ts: 3000, text: "next", images: 0 },
	];
	const parts = toolRuns(entries);
	assert.deepEqual(parts.map((p) => p.kind), ["entry", "run", "entry"]);
	const run = parts[1] as ToolRun;
	assert.equal(run.entries.length, entries.length - 2);
	assert.equal(run.label, "4 tool calls, 3 PTB msgs, 2 intercom msgs, 1 compaction, 2 Auto Compact msgs, 1 context reset, 1 web-search-results msg, 1 rarebit-recap msg");
});

test("a run label names one of a kind, falls back to the entryKind prefix, and says thinking only when nothing else ran", () => {
	assert.equal(runs([call("a", 0)])[0].label, "1 tool call");
	assert.equal(runs([custom("p", "plannotator.review/v2", 0)])[0].label, "1 plannotator msg");
	assert.equal(runs([{ id: "t", kind: "assistant", blocks: [{ type: "thinking", text: "Inspect" }] }])[0].label, "thinking");
	assert.equal(runs([{ id: "t", kind: "assistant", blocks: [{ type: "thinking", text: "Inspect" }] }, custom("i", "intercom_message")])[0].label, "1 intercom msg");
});
