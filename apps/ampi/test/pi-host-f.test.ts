import "./bound.ts";
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PI_VIEWS } from "../src/pi/views/index.ts";
import { PiHost } from "../src/pi/host.ts";
import { iso, user, setup, testView } from "./pi-host-fixtures.ts";
// Change marking of the threads list, split from pi-host-d.test.ts: each host input alone, then random Herdr frames.

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
