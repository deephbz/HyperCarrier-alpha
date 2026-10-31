import "./bound.ts";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { PI_VIEWS } from "../src/pi/views/index.ts";
import { PiHost } from "../src/pi/host.ts";
import { iso, user, setup, testView } from "./pi-host-fixtures.ts";
// pi-host-g.test.ts holds the cold Session row, agent placement and Session role tests.

/** The Host's audit interval as a seam: the test runs each tick, so it can change an input after the tick marks and before it publishes. */
function auditTicks(t: TestContext): () => void {
	const audit = PiHost.AUDIT_MS, realSetInterval = globalThis.setInterval;
	PiHost.AUDIT_MS = 987_654;
	t.after(() => void (PiHost.AUDIT_MS = audit));
	let tick: (() => void) | undefined;
	t.mock.method(globalThis, "setInterval", ((fn: () => void, ms?: number) => {
		if (ms !== PiHost.AUDIT_MS) return realSetInterval(fn, ms);
		tick = fn;
		return realSetInterval(() => {}, 2 ** 30);
	}) as typeof setInterval);
	return () => { assert.ok(tick, "the Host started its audit"); tick!(); };
}

test("pi host: a retention window change between an audit's mark and its publish reaches the row with a mark", async (t) => {
	const tick = auditTicks(t);
	const missed: string[] = [];
	t.mock.method(console, "error", (...args: unknown[]) => { if (String(args[0]).includes("hostKey missed")) missed.push(String(args[0])); });
	const { WorkingSet } = await import("../src/pi/working-set.ts");
	t.mock.method(WorkingSet.prototype, "forget", async () => false);
	const { f, hub, browser } = await setup(t, { recentMs: 3650 * 86_400_000, agent: { recentMs: 1000 } });
	const threads = browser.sub("devbox", { kind: "threads" });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"] && v.threads["pi:sess-b"]?.live);
	f.setState({ ...f.state, agents: f.state.agents.filter((a: any) => a.pane_id !== "w1:p1") });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"] && v.threads["pi:sess-b"] && !v.threads["pi:sess-b"].live);
	const host = [...hub.links.values()].find((l) => l instanceof PiHost)!;
	// The agent stops listing sess-b 1 s after its last write; from then on only the window keeps its row.
	await new Promise((r) => setTimeout(r, 1500));
	tick();
	host.config.recentMs = 60_000;
	await new Promise((r) => setTimeout(r, 300));
	assert.deepEqual(missed, [], "the audit's publish reads the window its mark used");
	tick();
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"] && !v.threads["pi:sess-b"], 8000);
	await new Promise((r) => setTimeout(r, 300));
	assert.deepEqual(missed, []);
});

test("pi host: an open grace change between an audit's mark and its publish reaches the row with a mark", async (t) => {
	const tick = auditTicks(t);
	const grace = PiHost.OPEN_GRACE_MS;
	PiHost.OPEN_GRACE_MS = 60_000;
	t.after(() => void (PiHost.OPEN_GRACE_MS = grace));
	const missed: string[] = [];
	t.mock.method(console, "error", (...args: unknown[]) => { if (String(args[0]).includes("hostKey missed")) missed.push(String(args[0])); });
	const { WorkingSet } = await import("../src/pi/working-set.ts");
	t.mock.method(WorkingSet.prototype, "forget", async () => false);
	const { f, hub, browser } = await setup(t, { recentMs: 3650 * 86_400_000, agent: { recentMs: 1000 } });
	const threads = browser.sub("devbox", { kind: "threads" });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"] && v.threads["pi:sess-b"]?.live);
	f.setState({ ...f.state, agents: f.state.agents.filter((a: any) => a.pane_id !== "w1:p1") });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-b"] && !v.threads["pi:sess-b"].live);
	// sess-b goes cold; a closed view's grace is all that keeps its row.
	const host = [...hub.links.values()].find((l) => l instanceof PiHost)!;
	const view = browser.sub("devbox", { kind: "thread", threadId: "pi:sess-b" });
	await browser.until<any>(view, (v) => v.entries.length > 0);
	browser.ws.send(JSON.stringify({ t: "unsub", sid: view }));
	host.config.recentMs = 60_000;
	await new Promise((r) => setTimeout(r, 1500));
	assert.ok((browser.values.get(threads) as any).threads["pi:sess-b"], "the grace keeps the cold row");
	tick();
	PiHost.OPEN_GRACE_MS = 0;
	await new Promise((r) => setTimeout(r, 300));
	assert.deepEqual(missed, [], "the audit's publish reads the grace its mark used");
	tick();
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"] && !v.threads["pi:sess-b"], 8000);
	await new Promise((r) => setTimeout(r, 300));
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

