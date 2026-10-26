import "./bound.ts";
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
import { TOKEN, iso, line, user, assistant, toolResult, setup, testView } from "./pi-host-fixtures.ts";

test("pi host: Sessions arrive Host-qualified, in Herdr's layout, and a transcript updates as bytes arrive", async (t) => {
	const { f, browser } = await setup(t);
	await browser.when(() => browser.hosts.some((h) => h.id === "devbox" && h.status === "connected"), 10_000, "Pi Host connected");
	const threads = browser.sub("devbox", { kind: "threads" });
	const list = await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.location?.pane === "w1:p2" && v.threads["pi:sess-b"]);
	const a = list.threads["pi:sess-a"];
	// Identity is the Host alias plus the Session ID; Herdr's place is auxiliary.
	assert.equal(a.ref, "devbox/pi:sess-a");
	assert.deepEqual(a.location, { workspace: "w1", workspaceLabel: "alpha", tab: "w1:tA", tabLabel: "main", pane: "w1:p2" });
	assert.equal(a.activity, "streaming", "Herdr says the pane is working");
	assert.equal(a.costUsd, 0.25);
	assert.equal(a.spendLabel, "$0.25 (excludes compaction, tool model calls)");
	assert.equal(list.threads["pi:sess-b"].spendLabel, "no price reported");
	assert.equal(a.model, "prov/model-x");
	assert.equal(Math.floor(a.cacheHit), 33, "cache read over the latest assistant prompt");
	assert.deepEqual(list.layout.workspaces.map((w: any) => w.id), ["w2", "w1"], "Herdr's order, not sorted");
	assert.deepEqual([a.contextWindow, a.workingBudget], [undefined, undefined], "no model limits known yet");

	// The Host's model registry and Auto Compact settings give the window and the working budget, as hc-hud shows them.
	writeFileSync(join(f.agentDir, "models-store.json"), JSON.stringify({ prov: { models: [{ id: "model-x", contextWindow: 1_000_000 }] } }));
	writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({ auto_compact: { budget_tokens: 200_000 } }));
	const limited = (await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.workingBudget)).threads["pi:sess-a"];
	assert.deepEqual([limited.contextWindow, limited.workingBudget], [1_000_000, 200_000]);
	// models.json overrides the catalog; the budget never exceeds the window.
	writeFileSync(join(f.agentDir, "models.json"), JSON.stringify({ providers: { prov: { modelOverrides: { "model-x": { contextWindow: 128_000 } } } } }));
	const clamped = (await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.contextWindow === 128_000)).threads["pi:sess-a"];
	assert.equal(clamped.workingBudget, 128_000);

	const thread = browser.sub("devbox", { kind: "thread", threadId: "pi:sess-a" });
	const view = await browser.until<any>(thread, (v) => v.entries.length === 3);
	assert.deepEqual(
		view.entries.map((e: any) => e.kind),
		["user", "assistant", "tool-result"],
	);
	assert.deepEqual(view.entries[1].blocks[1], { type: "tool", callId: "call-a1", name: "bash", args: { summary: "ls", command: "ls" } });
	assert.ok(!view.entries[1].bodyAvailable, "a short answer with a tool call is not a shortened preview");
	const page: any = await browser.req("devbox", "thread.entry", { threadId: "pi:sess-a", entry: "a1" });
	assert.deepEqual(JSON.parse(page.text), { id: "a1", kind: "assistant", ts: Date.parse(iso(2)), blocks: [{ type: "text", text: "Listing." }, { type: "tool", callId: "call-a1", name: "bash", args: { summary: "ls", command: "ls" } }] });
	assert.equal(view.entries[2].callId, "call-a1");

	// New bytes on the Host reach the open transcript as ops, without a resubscribe.
	appendFileSync(f.sessionA, user("u2", "r1", 4, "thanks"));
	const after = await browser.until<any>(thread, (v) => v.entries.length === 4);
	assert.equal(after.entries[3].text, "thanks");
	assert.deepEqual(browser.gaps, []);
	assert.equal(browser.snaps.get(thread), 1, "one snapshot, then ops");

	// A recent Session file that no pane runs (started outside Herdr) is listed too: no location, not live.
	const outside = join(f.agentDir, "sessions", "--elsewhere--", "d.jsonl");
	mkdirSync(join(f.agentDir, "sessions", "--elsewhere--"));
	writeFileSync(outside, line({ type: "session", version: 3, id: "sess-d", timestamp: new Date().toISOString(), cwd: "/elsewhere" }) + user("u1", null, 1, "outside"));
	const d = (await browser.until<any>(threads, (v) => v.threads["pi:sess-d"])).threads["pi:sess-d"];
	assert.deepEqual([d.location, d.live, d.cwd], [undefined, false, "/elsewhere"]);
});

test("pi host: a new agent is listed before its first message; close suspends, resume brings it back", async (t) => {
	const { f, browser } = await setup(t);
	const threads = browser.sub("devbox", { kind: "threads" });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-b"]?.location);
	const requestId = randomUUID();
	const created = await browser.req("devbox", "thread.create", { cwd: "/work/solo", place: { workspace: "new" }, requestId });
	assert.equal(created.pending, true, "no Session file yet: Pi writes it with the first message");
	const ws = (created.pane as string).split(":")[0];
	assert.deepEqual(f.herdrCalls()[0], ["workspace", "create", "--no-focus", "--cwd", "/work/solo", "--label", "solo"]);
	// The placeholder: navigable at once, located by its pane (the label can lag the pane by one discovery pass).
	const listed = await browser.until<any>(threads, (v) => v.threads[created.threadId]?.location?.workspaceLabel === "solo");
	const placeholder = listed.threads[created.threadId];
	assert.deepEqual([placeholder.title, placeholder.ref, placeholder.live, placeholder.preview, placeholder.location.pane], [
		`pi-${requestId.slice(0, 8)}`, `devbox/${created.threadId}`, true, "New agent: waiting for its first message", created.pane,
	]);
	const thread = browser.sub("devbox", { kind: "thread", threadId: created.threadId });
	await browser.until<any>(thread, (v) => Array.isArray(v.entries) && v.entries.length === 0);
	// A submit to it types into its pane; Pi writes the file, and the copy takes over from the placeholder.
	assert.deepEqual(await browser.req("devbox", "thread.submit", { threadId: created.threadId, content: "hello there", whenBusy: "steer" }), { via: "keys", evidence: "sent" });
	assert.deepEqual(f.herdrCalls().at(-1), ["agent", "prompt", created.pane, "hello there"]);
	await browser.until<any>(thread, (v) => v.entries.length === 1 && v.entries[0].text === "hello there");
	// A new agent closed before its first message: its pane closes and the placeholder leaves the list.
	const idle = await browser.req("devbox", "thread.create", { cwd: "/work", place: { beside: "pi:sess-b", direction: "down" }, requestId: randomUUID() });
	await browser.until<any>(threads, (v) => v.threads[idle.threadId]);
	assert.deepEqual(await browser.req("devbox", "thread.close", { threadId: idle.threadId }), { via: "herdr", evidence: "closed" });
	assert.deepEqual(f.herdrCalls().at(-1), ["pane", "close", idle.pane]);
	await browser.until<any>(threads, (v) => !v.threads[idle.threadId]);

	// Last pane of its workspace: refused without a close, then closed once the owner confirms.
	const before = f.herdrCalls().length;
	await assert.rejects(browser.req("devbox", "thread.close", { threadId: created.threadId }), /last pane/);
	assert.equal(f.herdrCalls().length, before, "no pane close");
	assert.deepEqual(await browser.req("devbox", "thread.close", { threadId: created.threadId, lastPane: true }), { via: "herdr", evidence: "closed" });
	assert.deepEqual(f.herdrCalls().at(-1), ["pane", "close", created.pane]);
	assert.ok(!f.state.agents.some((a: any) => a.workspace_id === ws));

	// Beside another pane: closes; the Session leaves its pane and stays readable from its copy.
	// Its entries are from 2026-01-01, older than recentMs: closing from the GUI still keeps it listed,
	// also when discovery reports the closed pane before the close returns.
	f.setState({ ...f.state, closeDelayMs: 700 });
	assert.deepEqual(await browser.req("devbox", "thread.close", { threadId: "pi:sess-a" }), { via: "herdr", evidence: "closed" });
	assert.deepEqual(f.herdrCalls().at(-1), ["pane", "close", "w1:p2"]);
	const after = await browser.until<any>(threads, (v) => v.threads["pi:sess-a"] && !v.threads["pi:sess-a"].location);
	assert.equal(after.threads["pi:sess-a"].live, false);
	const transcript = browser.sub("devbox", { kind: "thread", threadId: "pi:sess-a" });
	await browser.until<any>(transcript, (v) => v.entries.length === 3);
	await assert.rejects(browser.req("devbox", "thread.close", { threadId: "pi:sess-a" }), /not running/);

	// Resume: Pi reopens the exact Session file in a new pane, and the same thread gets a location again.
	await assert.rejects(browser.req("devbox", "thread.resume", { threadId: "pi:sess-b", place: { workspace: "new" }, requestId: randomUUID() }), /already running/);
	const resumed = await browser.req("devbox", "thread.resume", { threadId: "pi:sess-a", place: { beside: "pi:sess-b", direction: "right" }, requestId: randomUUID() });
	assert.equal(resumed.threadId, "pi:sess-a");
	const start = f.herdrCalls().find((c) => c[1] === "start" && c.includes(resumed.pane))!;
	assert.deepEqual(start.slice(start.indexOf("--")), ["--", "--session", f.sessionA]);
	assert.deepEqual(f.herdrCalls().find((c) => c[1] === "split" && c.includes("--cwd") && c[3] === "w1:p1" && c[5] === "right"), ["pane", "split", "--pane", "w1:p1", "--direction", "right", "--cwd", "/work", "--no-focus"]);
	const back = await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.location?.pane === resumed.pane);
	assert.equal(back.threads["pi:sess-a"].live, true);
});

test("pi host: a view publishes from the Session's entries and follows new bytes; its ops run on the named Host", async (t) => {
	PI_VIEWS.push(testView("probe", (ctx, topic) => {
		const session = ctx.session(String(topic.threadId));
		return session ? { host: ctx.host, ref: session.ref, kinds: session.window().map((e) => e.kind), revision: session.revision } : undefined;
	}));
	t.after(() => void PI_VIEWS.splice(PI_VIEWS.findIndex((v) => v.name === "probe"), 1));
	const { f, browser } = await setup(t);
	await browser.until<any>(browser.sub("devbox", { kind: "threads" }), (v) => v.threads["pi:sess-a"]);
	const sid = browser.sub("devbox", { kind: "view", view: "probe", threadId: "pi:sess-a" });
	const first = await browser.until<any>(sid, (v) => v.kinds.length === 3);
	assert.equal(first.ref, "devbox/pi:sess-a");
	appendFileSync(f.sessionA, user("u2", "r1", 4, "more"));
	const next = await browser.until<any>(sid, (v) => v.kinds.length === 4);
	assert.ok(next.revision > first.revision);
	// A registry view op runs against the named Host's Sessions.
	assert.equal((await browser.req("devbox", "view.cos.timeline.locate", { threadId: "pi:sess-a", at: Date.parse(iso(2)) })).ref, "devbox/pi:sess-a");
	await assert.rejects(browser.req("devbox", "view.probe.echo", {}), /not available/);
	await assert.rejects(browser.req("devbox", "view.nope.echo", {}), /not available/);
});
