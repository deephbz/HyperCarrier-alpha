import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Hub } from "../src/hub/hub.ts";
import { Browser } from "./helpers.ts";
import { control, fixture } from "./pi-fixtures.ts";
import { PI_VIEWS } from "../src/pi/views/index.ts";
import { modelLimits } from "../src/pi/host.ts";
import { TOKEN, iso, line, user, assistant, toolResult, setup } from "./pi-host-fixtures.ts";

test("pi host: create beside a Session binds the new Session id before Herdr runs, sends the prompt with the spawn, and never splits twice", async (t) => {
	const { f, browser } = await setup(t);
	const threads = browser.sub("devbox", { kind: "threads" });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-b"]?.location?.pane === "w1:p1");
	const requestId = randomUUID();
	const args = { cwd: "/work/app", place: { beside: "pi:sess-b", direction: "down" }, name: "Helper One", prompt: "start here", requestId: requestId.toUpperCase() };
	const created = await browser.req("devbox", "thread.create", args);
	assert.equal(created.threadId, `pi:${requestId}`, "the thread id is the (lowercased) requestId, known before Herdr ran");
	assert.equal(created.evidence, "started");
	assert.deepEqual(created.submitted, { via: "keys", evidence: "sent" });
	const pane = created.pane as string;
	assert.match(pane, /^w1:n\d+$/);
	// The prompt made Pi write its Session file, so the copy binds and replaces the placeholder.
	const list = await browser.until<any>(threads, (v) => v.threads[created.threadId]?.location?.pane === pane && v.threads[created.threadId].preview === "start here");
	assert.deepEqual(list.threads[created.threadId].location, { workspace: "w1", workspaceLabel: "alpha", tab: "w1:tA", tabLabel: "main", pane });
	assert.ok(list.layout.workspaces.find((w: any) => w.id === "w1").tabs[0].panes.includes(pane));
	assert.deepEqual(f.herdrCalls(), [
		["pane", "split", "--pane", "w1:p1", "--direction", "down", "--cwd", "/work/app", "--no-focus"],
		["pane", "rename", pane, "helper-one"],
		["agent", "start", "helper-one", "--kind", "pi", "--pane", pane, "--timeout", "30000", "--", "--session-id", requestId],
		["agent", "prompt", pane, "start here"],
	]);
	// A repeated request is answered from the Host's spawn ledger: no second split, start, or prompt.
	const again = await browser.req("devbox", "thread.create", args);
	assert.deepEqual([again.threadId, again.pane, again.evidence, again.submitted], [created.threadId, pane, "started", created.submitted]);
	assert.equal(f.herdrCalls().length, 4);
	assert.ok(existsSync(join(f.agentDir, "hc-control", "spawns", `${requestId}.json`)));
	await assert.rejects(browser.req("devbox", "thread.create", { ...args, requestId: "not-a-uuid" }), /UUID/);
	// Herdr refused to start Pi after the split: the error names the pane left open.
	f.setState({ ...f.state, startError: "agent_pane_busy" });
	await assert.rejects(browser.req("devbox", "thread.create", { ...args, requestId: randomUUID() }), (e: any) => e.code === "agent_pane_busy" && /^w1:n\d+$/.test(e.pane) && /pane w1:n\d+ .*left open in Herdr/.test(e.message));
});

test("pi host: a failing view does not stop other subscriptions, a view without a threadId follows every Session, and ask runs an isolated model call", async (t) => {
	PI_VIEWS.push(
		{
			name: "boom",
			value: (ctx, topic) => {
				if (ctx.session(String(topic.threadId))!.data.count > 3) throw new Error("too many");
				return { ok: true };
			},
		},
		{
			name: "count",
			value: (ctx) => ({ entries: ctx.sessions().reduce((n, s) => n + s.data.count, 0) }),
			ops: { ask: (ctx, args) => ctx.ask({ system: "Answer briefly.", prompt: String(args.prompt) }) },
		},
	);
	t.after(() => {
		for (const name of ["boom", "count"]) PI_VIEWS.splice(PI_VIEWS.findIndex((v) => v.name === name), 1);
	});
	const { f, browser } = await setup(t);
	await browser.until<any>(browser.sub("devbox", { kind: "threads" }), (v) => v.threads["pi:sess-a"] && v.threads["pi:sess-b"]);
	const boom = browser.sub("devbox", { kind: "view", view: "boom", threadId: "pi:sess-a" });
	const count = browser.sub("devbox", { kind: "view", view: "count" });
	const transcript = browser.sub("devbox", { kind: "thread", threadId: "pi:sess-a" });
	assert.deepEqual(await browser.until<any>(boom, (v) => v.ok), { ok: true });
	assert.equal((await browser.until<any>(count, (v) => v.entries === 4)).entries, 4);
	// Bytes for sess-b only: the Host-wide view follows them although its topic names no Session.
	appendFileSync(f.sessionB, user("u2", "u1", 5, "more"));
	await browser.until<any>(count, (v) => v.entries === 5);
	// sess-a grows past what "boom" tolerates: its subscribers get an error value; the transcript and "count" keep going.
	appendFileSync(f.sessionA, user("u2", "r1", 4, "more"));
	assert.equal((await browser.until<any>(boom, (v) => v.error)).error.code, "view_failed");
	await browser.until<any>(transcript, (v) => v.entries.some((e: any) => e.id === "u2"));
	await browser.until<any>(count, (v) => v.entries === 6);
	assert.deepEqual(await browser.req("devbox", "view.count.ask", { prompt: "hello\nworld" }), { text: "11:hello" });
	await assert.rejects(browser.req("devbox", "view.count.ask", { prompt: "fail now" }), (e: any) => e.code === "model_error");
});

test("pi host: model limits resolve the working budget as hc-auto-compact does", () => {
	const windows = { "magpie/claude/opus": 1_000_000, "prov/small": 128_000 };
	assert.deepEqual(modelLimits("magpie/claude/opus", { windows, budget: { tokens: 200_000 } }), { contextWindow: 1_000_000, workingBudget: 200_000 });
	assert.deepEqual(modelLimits("prov/small", { windows, budget: { tokens: 200_000 } }), { contextWindow: 128_000, workingBudget: 128_000 }, "clamped to the window");
	assert.deepEqual(modelLimits("magpie/claude/opus", { windows, budget: { tokens: 200_000, models: { "magpie/claude/opus": 400_000 } } }).workingBudget, 400_000, "a per-model budget wins");
	assert.deepEqual(modelLimits("magpie/claude/opus", { windows, budget: {} }), { contextWindow: 1_000_000, workingBudget: 1_000_000 }, "no budget_tokens: the window");
	assert.deepEqual(modelLimits("magpie/claude/opus", { windows, budget: null }), { contextWindow: 1_000_000 }, "no Auto Compact settings: no working budget");
	assert.deepEqual(modelLimits("prov/unknown", { windows, budget: { tokens: 200_000 } }), {}, "an unknown model claims nothing");
	assert.deepEqual(modelLimits(undefined, undefined), {});
});
