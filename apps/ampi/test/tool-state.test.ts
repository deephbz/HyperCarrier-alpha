import "./bound.ts";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import { boundToolArgs, toolArgsPreview } from "../src/shared/entry-shapes.ts";
import { openCalls, toolCallState } from "../src/shared/tool-state.ts";
import { iso, line, setup, toolResult } from "./pi-host-fixtures.ts";

// Owner report A21: a running bash call showed "interrupted" and did not expand, because Pi Sessions send no live
// tool slots. A call's state comes from transcript evidence alone (src/shared/tool-state.ts).

const web = fileURLToPath(new URL("../web/", import.meta.url));
let vite: ViteDevServer;
let ToolCall: (props: object) => unknown, ToolArgs: (props: object) => unknown;

before(async () => {
	vite = await createServer({ configFile: `${web}vite.config.ts`, root: web, logLevel: "silent", server: { middlewareMode: true, hmr: false } });
	({ ToolCall, ToolArgs } = await vite.ssrLoadModule("/src/components/ToolCall.tsx"));
});
after(async () => { await vite?.close(); });

const call = (callId: string, stop?: string) => ({ kind: "assistant", stop, blocks: [{ type: "text" }, { type: "tool", callId }] });

test("tool state: only an aborted stop or a later turn makes a call without a result interrupted", () => {
	const tail = openCalls([{ kind: "user" }, call("c1", "toolUse")]);
	assert.deepEqual([...tail], ["c1"], "the tail call is open");
	assert.equal(toolCallState({ open: true, active: true }), "running");
	assert.equal(toolCallState({ open: true, active: false }), "unfinished", "an idle Session proves no interruption either");
	assert.equal(toolCallState({ result: { isError: false }, open: false, active: true }), "done");
	assert.equal(toolCallState({ result: { isError: true }, open: false, active: true }), "failed");
	assert.equal(toolCallState({ open: false, active: true }), "interrupted");

	assert.deepEqual([...openCalls([call("c1", "aborted")])], [], "aborted stop");
	assert.deepEqual([...openCalls([call("c1", "toolUse"), { kind: "user" }])], [], "a later owner turn");
	assert.deepEqual([...openCalls([call("c1", "toolUse"), call("c2", "toolUse")])], ["c2"], "a later assistant turn closes c1");
	assert.deepEqual([...openCalls([call("c1", "toolUse"), { kind: "tool-result", callId: "c1" }])], [], "the result arrived");
	assert.deepEqual([...openCalls([call("c1", "toolUse"), { kind: "custom" }, { kind: "compaction" }])], ["c1"], "notices are not turns");
});

test("tool state: a running Pi call without a live slot shows running, expands, and shows its command", () => {
	const html = (props: object) => renderToStaticMarkup(createElement(ToolCall as never, { name: "bash", args: toolArgsPreview("bash", { command: "sleep 30" }), ...props }));
	const running = html({ callOpen: true, active: true });
	assert.match(running, /class="spinner"/);
	assert.match(running, /class="state ">running</);
	assert.match(running, /class="tool-body quiet-scroll"/, "expanded");
	assert.match(running, /sleep 30/);
	assert.match(running, /waiting for output/);
	const streaming = html({ callOpen: true, active: true, live: { status: "running", output: "tick 1" } });
	assert.match(streaming, /tick 1/);
	assert.doesNotMatch(streaming, /waiting for output/);

	assert.match(html({ callOpen: false, active: true }), />interrupted</);
	assert.match(html({ callOpen: true, active: false }), />unfinished</);
	const done = html({ callOpen: false, active: true, result: { text: "ok", isError: false } });
	assert.match(done, />done</);
	assert.doesNotMatch(done, /spinner|waiting for output/);
});

test("tool row: the modeled preview draws the edit diff, the write preview and the Team-tool lines as the raw arguments did", () => {
	const html = (name: string, raw: object, props: object = {}) =>
		renderToStaticMarkup(createElement(ToolCall as never, { name, args: toolArgsPreview(name, raw), result: { text: "ok", isError: false }, ...props }));
	const edit = html("edit", { path: "src/a.ts", edits: [{ oldText: "old line", newText: "new line\nsecond" }] });
	assert.match(edit, /<span class="arg">src\/a\.ts · 1 edit\(s\)<\/span>/);
	assert.match(edit, /<div class="diff"><div class="hunk">@@<\/div><div class="del">-old line<\/div><div class="add">\+new line<\/div><div class="add">\+second<\/div><\/div>/);
	const write = html("write", { path: "notes.md", content: "one\ntwo\n" }, { callOpen: true, active: true, result: undefined });
	assert.match(write, /<span class="arg">notes\.md · 2 lines<\/span>/);
	assert.match(write, /<pre>one\ntwo\n<\/pre>/);
	const task = html("task_update", { task_id: "t1", transition: "goal_achieved", evidence: "ok" });
	assert.match(task, /<span class="arg">t1 → goal_achieved<\/span>/);
	const alert = html("alert_send", { kind: "attention", text: "Deploy\nfailed", task_id: "t1" }, { callOpen: true, active: true, result: undefined });
	assert.match(alert, /<span class="arg">attention: Deploy failed<\/span>/);
	assert.match(alert, /<div class="label">arguments<\/div><pre>\{\n  &quot;kind&quot;: &quot;attention&quot;/, "the remaining arguments show as JSON");
	assert.match(html("ensure_worker", { name: "w1", scope: "Build it" }), /<span class="arg">w1 — Build it<\/span>/);
	const clipped = renderToStaticMarkup(createElement(ToolCall as never, { name: "edit", args: { summary: "src/big.ts · 1 edit(s)", path: "src/big.ts" }, result: { text: "ok", isError: false } }));
	assert.doesNotMatch(clipped, /class="diff"/, "a clipped preview draws no diff");
});

test("tool row: a clipped preview says what it dropped, and the shortened-arguments view reads like the arguments", () => {
	const row = (name: string, raw: object) =>
		renderToStaticMarkup(createElement(ToolCall as never, { name, args: boundToolArgs(toolArgsPreview(name, raw), 2048).args, callOpen: true, active: true }));
	const paths = Array.from({ length: 100 }, (_, i) => `src/${i}/${"p".repeat(200)}`);
	assert.match(row("grep", { paths }), /\n\+\d+ more paths<\/pre>/);
	assert.match(row("bash", { command: "c".repeat(5000) }), /c\n…command shortened<\/pre>/);
	const view = (name: string, raw: object) => renderToStaticMarkup(createElement(ToolArgs as never, { args: toolArgsPreview(name, raw) }));
	const graph = view("task_graph_apply", { operation_id: "op1", tasks: [{ id: "t1", goal: "Build it" }] });
	assert.doesNotMatch(graph, /\\n|\\&quot;/, "the arguments show as pretty JSON, not escaped JSON");
	assert.match(graph, /&quot;goal&quot;: &quot;Build it&quot;/);
	assert.match(view("edit", { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] }), /<pre>src\/a\.ts<\/pre><pre>\{\n  &quot;edits&quot;/, "a shortened edit opens with its target, then its edits");
});

test("tool state: a working Pi Session with an open tail call reports running tools, never after the call ends", async (t) => {
	const { f, browser } = await setup(t);
	const threads = browser.sub("devbox", { kind: "threads" });
	const activity = (want: string) => browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.activity === want);
	await activity("streaming");
	const turn = (id: string, parent: string, n: number, stopReason: string) => line({
		type: "message", id, parentId: parent, timestamp: iso(n),
		message: { role: "assistant", content: [{ type: "toolCall", id: `call-${id}`, name: "bash", arguments: { command: "sleep 30" } }], stopReason, timestamp: Date.parse(iso(n)) },
	});
	appendFileSync(f.sessionA, turn("a2", "r1", 4, "toolUse"));
	await activity("tools");
	appendFileSync(f.sessionA, toolResult("r2", "a2", 5, "call-a2"));
	await activity("streaming");
	appendFileSync(f.sessionA, turn("a3", "r2", 6, "aborted"));
	const thread = browser.sub("devbox", { kind: "thread", threadId: "pi:sess-a" });
	await browser.until<any>(thread, (v) => v.entries.some((e: any) => e.id === "a3"));
	assert.equal((await activity("streaming")).threads["pi:sess-a"].activity, "streaming", "an aborted call is not running");
});
