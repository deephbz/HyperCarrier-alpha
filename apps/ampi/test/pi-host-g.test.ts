import "./bound.ts";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PI_VIEWS } from "../src/pi/views/index.ts";
import { PiHost } from "../src/pi/host.ts";
import { user, setup, testView } from "./pi-host-fixtures.ts";
// Split from pi-host-e.test.ts: the cold Session row, agent placement, the #hostInputs boundary and Session roles.

test("pi host: a cold Session's row shows while its thread is open and for a grace after it closes, then leaves with a mark", async (t) => {
	const audit = PiHost.AUDIT_MS, grace = PiHost.OPEN_GRACE_MS;
	PiHost.AUDIT_MS = 150;
	PiHost.OPEN_GRACE_MS = 3000;
	t.after(() => void Object.assign(PiHost, { AUDIT_MS: audit, OPEN_GRACE_MS: grace }));
	const missed: string[] = [];
	t.mock.method(console, "error", (...args: unknown[]) => { if (String(args[0]).includes("hostKey missed")) missed.push(String(args[0])); });
	// Eviction keeps the copy, so only an open or recently closed view keeps the cold row listed.
	const { WorkingSet } = await import("../src/pi/working-set.ts");
	const forget = t.mock.method(WorkingSet.prototype, "forget", async () => false);
	const { f, hub, browser } = await setup(t, { recentMs: 3650 * 86_400_000, agent: { recentMs: 1000 } });
	const threads = browser.sub("devbox", { kind: "threads" });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"] && v.threads["pi:sess-b"]?.live);
	f.setState({ ...f.state, agents: f.state.agents.filter((a: any) => a.pane_id !== "w1:p1") });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-b"] && !v.threads["pi:sess-b"].live);
	// sess-b goes cold: past the retention edge, with no pane.
	const host = [...hub.links.values()].find((l) => l instanceof PiHost)!;
	host.config.recentMs = 60_000;
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"] && !v.threads["pi:sess-b"]);
	const open = () => browser.sub("devbox", { kind: "thread", threadId: "pi:sess-b" });
	const close = (sid: number) => browser.ws.send(JSON.stringify({ t: "unsub", sid }));
	const first = open();
	await browser.until<any>(threads, (v) => v.threads["pi:sess-b"]);
	// Leaving the Session keeps its row under the pointer; reopening it inside the grace changes nothing.
	close(first);
	await new Promise((r) => setTimeout(r, 400));
	const n = browser.seq.get(threads);
	assert.ok((browser.values.get(threads) as any).threads["pi:sess-b"], "the row stays after its view closes");
	const again = open();
	await new Promise((r) => setTimeout(r, 400));
	assert.equal(browser.seq.get(threads), n, "a reopen inside the grace publishes nothing");
	close(again);
	forget.mock.resetCalls();
	await new Promise((r) => setTimeout(r, 1000));
	assert.equal(forget.mock.callCount(), 0, "a copy inside the grace is not evicted");
	assert.ok((browser.values.get(threads) as any).threads["pi:sess-b"]);
	// The grace ends at a marking tick (a frame or the audit), so the row leaves with a mark.
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"] && !v.threads["pi:sess-b"]);
	await new Promise((r) => setTimeout(r, 400));
	assert.deepEqual(missed, []);
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

test("pi host: Session roles count as read after the first teams frame, and at once when Teams are off (failure: Worker Sessions auto-built before their role arrived, or waited when no frame can come)", async (t) => {
	PI_VIEWS.push(testView("roles", (ctx, topic) => ({ known: ctx.rolesKnown?.() ?? null, frame: Boolean(ctx.teamsFrame()), count: ctx.session(String(topic.threadId))?.data.count ?? 0 })));
	t.after(() => void PI_VIEWS.splice(PI_VIEWS.findIndex((v) => v.name === "roles"), 1));
	// A Pi Team Bright read that answers only when the test opens its gate, so "before the first frame" is not a race.
	const dir = mkdtempSync(join(tmpdir(), "ampi-roles-")), gate = join(dir, "open"), ptb = join(dir, "ptb.mjs");
	writeFileSync(ptb, `import { existsSync } from "node:fs";\nexport async function readObservationSnapshot() { while (!existsSync(${JSON.stringify(gate)})) await new Promise((r) => setTimeout(r, 20)); return { schema: "none" }; }\n`);
	const { f, browser } = await setup(t, { agent: { teams: true, ptbObservation: ptb } });
	await browser.until<any>(browser.sub("devbox", { kind: "threads" }), (v) => v.threads["pi:sess-a"]);
	const roles = browser.sub("devbox", { kind: "view", view: "roles", threadId: "pi:sess-a" });
	assert.deepEqual(await browser.until<any>(roles, (v) => v.count === 3), { known: false, frame: false, count: 3 }, "no frame yet: roles unknown");
	writeFileSync(gate, "");
	await new Promise((r) => setTimeout(r, 2500));
	appendFileSync(f.sessionA, user("u2", "r1", 4, "more"));
	assert.deepEqual(await browser.until<any>(roles, (v) => v.count === 4), { known: true, frame: true, count: 4 }, "a teams frame, here a failed read, makes roles known");

	const off = await setup(t);
	await off.browser.until<any>(off.browser.sub("devbox", { kind: "threads" }), (v) => v.threads["pi:sess-a"]);
	assert.deepEqual(await off.browser.until<any>(off.browser.sub("devbox", { kind: "view", view: "roles", threadId: "pi:sess-a" }), (v) => v.count === 3), { known: true, frame: false, count: 3 }, "Teams off: roles known with no frame");
});
