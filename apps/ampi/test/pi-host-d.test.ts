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
import { PiHost, modelLimits } from "../src/pi/host.ts";
import { TOKEN, iso, line, user, assistant, toolResult, setup, testView } from "./pi-host-fixtures.ts";

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
		testView("boom", (ctx, topic) => {
			if (ctx.session(String(topic.threadId))!.data.count > 3) throw new Error("too many");
			return { ok: true };
		}),
		testView("count", (ctx) => ({ entries: ctx.sessions().reduce((n, s) => n + s.data.count, 0) })),
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
	const asked = await browser.req("devbox", "view.rarebit.ask", { threadId: "pi:sess-a", question: "hello" });
	assert.match(asked.side.turns[0].answer, /^\d+:Snapshot: /);
	assert.equal(asked.side.model, "anthropic/claude-sonnet-5-5", "the ask runs on the rarebitAsk purpose's resolved model");
	const failed = await browser.req("devbox", "view.rarebit.ask", { threadId: "pi:sess-a", question: "fail now" });
	assert.match(failed.side.turns[0].error, /^model_error/);
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

test("pi host: identical Herdr frames recompute nothing; a changed agent marks only its Session", async (t) => {
	const calls = { summarize: [] as string[], changed: [] as string[] };
	PI_VIEWS.push({
		...testView("quiet", () => ({ ok: true })),
		summarize: (_ctx, session) => void calls.summarize.push(session.threadId),
		changed: (_ctx, sessions) => void calls.changed.push(...sessions.map((s) => s.threadId)),
	});
	t.after(() => void PI_VIEWS.splice(PI_VIEWS.findIndex((v) => v.name === "quiet"), 1));
	const { WorkingSet } = await import("../src/pi/working-set.ts");
	const live = t.mock.method(WorkingSet.prototype, "live");
	const { f, browser } = await setup(t);
	const threads = browser.sub("devbox", { kind: "threads" });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.activity !== undefined && v.threads["pi:sess-b"]);
	const settle = () => new Promise((r) => setTimeout(r, 1200)); // about 8 agents frames at discoverMs 150
	await settle();
	calls.summarize.length = calls.changed.length = 0;
	live.mock.resetCalls();
	await settle();
	assert.deepEqual(calls, { summarize: [], changed: [] }, "identical agents frames mark no Session");
	assert.equal(live.mock.callCount(), 0, "identical agents frames write no transcript-window liveness");
	// sess-b's pane starts working: only sess-b changes, in one threads ops frame.
	const n = browser.seq.get(threads);
	f.setState({ ...f.state, agents: f.state.agents.map((a: any) => (a.pane_id === "w1:p1" ? { ...a, agent_status: "working" } : a)) });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-b"].activity === "streaming");
	await settle();
	assert.deepEqual(calls.changed, ["pi:sess-b"]);
	assert.equal(browser.seq.get(threads), n! + 1);
	// A tab rename reaches the location label of the Sessions in that tab.
	f.setState({ ...f.state, tabs: f.state.tabs.map((x: any) => (x.tab_id === "w1:tA" ? { ...x, label: "renamed" } : x)) });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"].location?.tabLabel === "renamed" && v.threads["pi:sess-b"].location?.tabLabel === "renamed");
});

test("pi host: each host input alone updates only its Session's row", async (t) => {
	const changed: string[] = [];
	PI_VIEWS.push({ ...testView("marks", () => ({ ok: true })), changed: (_ctx, sessions) => void changed.push(...sessions.map((s) => s.threadId)) });
	t.after(() => void PI_VIEWS.splice(PI_VIEWS.findIndex((v) => v.name === "marks"), 1));
	const { f, browser } = await setup(t);
	const threads = browser.sub("devbox", { kind: "threads" });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.activity === "streaming" && v.threads["pi:sess-b"]?.live && v.threads["pi:sess-b"].updatedAt);
	// A Session's first data feeds its `recent` input; the next agents frame must not mark it again.
	changed.length = 0;
	await new Promise((r) => setTimeout(r, 600));
	assert.deepEqual(changed, [], "frames after each Session's first data");
	// New data moves sess-b's `recent` input after the last frame keyed it: one mark, not a second one at the next frame.
	const now = Math.floor((Date.now() - Date.parse(iso(0))) / 1000);
	appendFileSync(f.sessionB, user("u2", "u1", now, "more work"));
	await browser.until<any>(threads, (v) => v.threads["pi:sess-b"].updatedAt === Date.parse(iso(now)));
	await new Promise((r) => setTimeout(r, 450));
	assert.deepEqual(changed, ["pi:sess-b"], "new data in sess-b");
	const step = async (what: string, change: () => void, done: (v: any) => boolean, marked: string[]) => {
		changed.length = 0;
		change();
		await browser.until<any>(threads, done);
		await new Promise((r) => setTimeout(r, 450));
		assert.deepEqual([...new Set(changed)], marked, what);
	};
	const status = (pane: string, agent_status: string) => () => f.setState({ ...f.state, agents: f.state.agents.map((a: any) => (a.pane_id === pane ? { ...a, agent_status } : a)) });
	await step("an ask opens: Needs you", status("w1:p2", "blocked"), (v) => v.threads["pi:sess-a"].attention?.[0]?.reason === "needs input", ["pi:sess-a"]);
	await step("the ask closes", status("w1:p2", "working"), (v) => !v.threads["pi:sess-a"].attention && v.threads["pi:sess-a"].activity === "streaming", ["pi:sess-a"]);
	await step("working to idle", status("w1:p2", "idle"), (v) => v.threads["pi:sess-a"].activity === "idle", ["pi:sess-a"]);
	await step("a model's context window", () => writeFileSync(join(f.agentDir, "models-store.json"), JSON.stringify({ prov: { models: [{ id: "model-x", contextWindow: 1_000_000 }] } })),
		(v) => v.threads["pi:sess-a"].contextWindow === 1_000_000, ["pi:sess-a"]);
	await step("a pane label", () => f.setState({ ...f.state, agents: f.state.agents.map((a: any) => (a.pane_id === "w1:p1" ? { ...a, terminal_title_stripped: "renamed" } : a)) }),
		(v) => v.threads["pi:sess-b"].title === "renamed", ["pi:sess-b"]);
	await step("the pane closes", () => f.setState({ ...f.state, agents: f.state.agents.filter((a: any) => a.pane_id !== "w1:p1") }), (v) => v.threads["pi:sess-b"] && !v.threads["pi:sess-b"].live, ["pi:sess-b"]);
});

test("pi host: the threads audit finds no row that change marking missed over random Herdr frames", async (t) => {
	const audit = PiHost.AUDIT_MS;
	PiHost.AUDIT_MS = 120;
	t.after(() => void (PiHost.AUDIT_MS = audit));
	const missed: string[] = [];
	t.mock.method(console, "error", (...args: unknown[]) => { if (String(args[0]).includes("hostKey missed")) missed.push(String(args[0])); });
	const { f, browser } = await setup(t);
	const threads = browser.sub("devbox", { kind: "threads" });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"] && v.threads["pi:sess-b"]);
	let seed = 7;
	const pick = <T,>(xs: T[]) => xs[(seed = (seed * 48271) % 2147483647) % xs.length];
	// One input changes per frame, so a change marking that misses it leaves the row stale until the audit.
	const changes: ((s: any) => void)[] = [
		(s) => { const a = pick(s.agents) as any; a.agent_status = pick(["idle", "working", "blocked", "unknown"]); },
		(s) => { const a = pick(s.agents) as any; a.terminal_title_stripped = pick(["pi", "pi task", undefined]); },
		(s) => { const a = pick(s.agents) as any; a.name = pick([a.pane_id, "renamed"]); },
		(s) => { const x = pick(s.tabs) as any; x.label = pick(["main", "spare", "other", "renamed"]); },
		(s) => { const x = pick(s.workspaces) as any; x.label = pick(["alpha", "beta", "renamed"]); },
	];
	for (let i = 0; i < 20; i++) {
		const s = structuredClone(f.state);
		pick(changes)(s);
		f.setState(s);
		await new Promise((r) => setTimeout(r, 300));
	}
	await new Promise((r) => setTimeout(r, 400));
	assert.deepEqual(missed, []);
});

test("pi host: a Session leaves the threads list when it crosses the retention edge, with no new frame content", async (t) => {
	const audit = PiHost.AUDIT_MS;
	PiHost.AUDIT_MS = 150;
	t.after(() => void (PiHost.AUDIT_MS = audit));
	const missed: string[] = [];
	t.mock.method(console, "error", (...args: unknown[]) => { if (String(args[0]).includes("hostKey missed")) missed.push(String(args[0])); });
	// Eviction keeps the copy, so only the `recent` host input can drop the row.
	const { WorkingSet } = await import("../src/pi/working-set.ts");
	t.mock.method(WorkingSet.prototype, "forget", async () => false);
	// The agent lists a file without a pane only for 1 s after its last write. The retention window moves, not the clock, so load cannot move the edge.
	const { f, hub, browser } = await setup(t, { recentMs: 3650 * 86_400_000, agent: { recentMs: 1000 } });
	const threads = browser.sub("devbox", { kind: "threads" });
	// sess-b arrives through its pane, so a slow first scan cannot miss it; then its pane closes.
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"] && v.threads["pi:sess-b"]?.live);
	f.setState({ ...f.state, agents: f.state.agents.filter((a: any) => a.pane_id !== "w1:p1") });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"] && v.threads["pi:sess-b"] && !v.threads["pi:sess-b"].live);
	const host = [...hub.links.values()].find((l) => l instanceof PiHost)!;
	// sess-b's last entry is at iso(1), so a window that ends one minute after it puts sess-b past the edge.
	host.config.recentMs = 60_000;
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"] && !v.threads["pi:sess-b"], 8000);
	await new Promise((r) => setTimeout(r, 400));
	assert.deepEqual(missed, []);
});

test("pi host: data the worker committed before its refresh resolves is marked when a quiet audit adopts it", async (t) => {
	const audit = PiHost.AUDIT_MS;
	PiHost.AUDIT_MS = 120;
	t.after(() => void (PiHost.AUDIT_MS = audit));
	const missed: string[] = [];
	t.mock.method(console, "error", (...args: unknown[]) => { if (String(args[0]).includes("hostKey missed")) missed.push(String(args[0])); });
	const changed: string[] = [];
	PI_VIEWS.push({ ...testView("adopt", () => ({ ok: true })), changed: (_ctx, sessions) => void changed.push(...sessions.map((s) => s.threadId)) });
	t.after(() => void PI_VIEWS.splice(PI_VIEWS.findIndex((v) => v.name === "adopt"), 1));
	// A held refresh: the worker has committed, but its message has not arrived.
	const { WorkingSet } = await import("../src/pi/working-set.ts");
	const refresh = WorkingSet.prototype.refresh;
	let hold: Promise<void> | undefined, release = () => {};
	t.mock.method(WorkingSet.prototype, "refresh", async function (this: InstanceType<typeof WorkingSet>, ...args: Parameters<typeof refresh>) {
		const data = await refresh.apply(this, args);
		if (hold) await hold;
		return data;
	});
	const { f, browser } = await setup(t);
	const threads = browser.sub("devbox", { kind: "threads" });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.updatedAt && v.threads["pi:sess-b"]?.updatedAt);
	await new Promise((r) => setTimeout(r, 600));
	hold = new Promise((r) => (release = r));
	changed.length = 0;
	const now = Math.floor((Date.now() - Date.parse(iso(0))) / 1000);
	appendFileSync(f.sessionB, user("u2", "u1", now, "more work"));
	// Audits run while the refresh is held; one of them adopts the committed data.
	await browser.until<any>(threads, (v) => v.threads["pi:sess-b"].updatedAt === Date.parse(iso(now)));
	await new Promise((r) => setTimeout(r, 400));
	release();
	await new Promise((r) => setTimeout(r, 400));
	assert.deepEqual(missed, []);
	assert.deepEqual([...new Set(changed)], ["pi:sess-b"]);
});

test("pi host: the first agent listed for a Session file places it, as before the path index", async (t) => {
	const { f, browser } = await setup(t);
	const second = { ...f.state.agents.find((a: any) => a.pane_id === "w1:p1"), pane_id: "w2:p9", workspace_id: "w2", tab_id: "w2:tC" };
	f.setState({ ...f.state, agents: [...f.state.agents, second] });
	const threads = browser.sub("devbox", { kind: "threads" });
	const v = await browser.until<any>(threads, (v) => v.threads["pi:sess-b"]?.location && v.layout.workspaces.some((w: any) => w.tabs.some((x: any) => x.panes.includes("w2:p9"))));
	assert.equal(v.threads["pi:sess-b"].location.pane, "w1:p1");
});

test("pi host: Session projections read host state only through #hostInputs", () => {
	const source = readFileSync(new URL("../src/pi/host.ts", import.meta.url), "utf8");
	const body = (name: string) => {
		const start = source.search(new RegExp(`\\n\\s*${name}\\(`));
		assert.ok(start > 0, name);
		const end = source.indexOf("\n\t}\n", start), alt = source.indexOf("\n }\n", start);
		return source.slice(start, Math.min(...[end, alt].filter((i) => i > 0)));
	};
	// Host-level frame state; #isLive is #hostInputs' agent.live and #queuedItems its queued rows.
	const frameState = /this\.#(agents|agentsByPath|agentFor|teams|teamsFrame|layout|limits|livenessKnown|panes|queued)\b/g;
	for (const name of ["#summary", "#viewSession", "#threadValue"]) assert.deepEqual(body(name).match(frameState), null, `${name} reads host state outside #hostInputs`);
});
