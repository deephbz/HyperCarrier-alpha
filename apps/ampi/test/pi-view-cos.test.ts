import "./bound.ts";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Hub } from "../src/hub/hub.ts";
import type { TimelineValue } from "../src/shared/timeline.ts";
import { Browser } from "./helpers.ts";
import { HELPER_MODELS } from "./pi-host-fixtures.ts";
import { fixture } from "./pi-fixtures.ts";

const T = Date.UTC(2026, 9, 18);
const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const message = (id: string, parent: string | null, ms: number, role: string, extra: object = {}) => line({ type: "message", id, parentId: parent, timestamp: new Date(T + ms).toISOString(), message: { role, content: [{ type: "text", text: `${role} evidence ${id}` }], ...extra } });

async function setup(t: { after: (fn: () => unknown) => void }, header: object = {}) {
	const f = fixture();
	writeFileSync(f.sessionA, line({ type: "session", version: 3, id: "sess-a", timestamp: new Date(T).toISOString(), cwd: "/work", ...header })
		+ message("u1", null, 1000, "user")
		+ message("a1", "u1", 899_000, "assistant", { content: [{ type: "text", text: "Should I approve the deploy?" }], stopReason: "stop", usage: { input: 100, output: 23, cacheRead: 50, cacheWrite: 7, cost: { total: .375 } } })
		+ message("a2", "a1", 901_000, "assistant", { stopReason: "error", content: [], usage: { input: 200, output: 11, cacheRead: null, cacheWrite: 0, cost: { total: .125 } } }));
	const calls = join(f.dir, "model-calls");
	const fail = join(f.dir, "no-model");
	const ask = "process.stdin.resume(); process.stdin.on('end', () => console.log('{}'));";
	const hub = new Hub({ models: HELPER_MODELS, hosts: [{ id: "devbox", label: "devbox", kind: "pi-local", cacheDir: join(f.dir, "cache"), askCommand: [process.execPath, "-e", ask], agentConfig: { agentDir: f.agentDir, pollMs: 30, discoverMs: 150, teams: false }, env: { HOME: f.dir, HERDR_BIN: join(f.dir, "herdr"), FAKE_HERDR_STATE: join(f.dir, "state.json"), FAKE_HERDR_LOG: join(f.dir, "calls.jsonl") } }] }, { token: "c".repeat(64) });
	const port = await hub.listen(0);
	const browser = await Browser.open(port, undefined, `ampi_k_${port}=${"c".repeat(64)}`);
	t.after(async () => { browser.ws.close(); await hub.close(); });
	await browser.until<any>(browser.sub("devbox", { kind: "threads" }), (v) => v.threads["pi:sess-a"]);
	return { f, browser, calls, fail };
}

test("cos.timeline: reader usage is bucketed across the boundary; stop/error marks, liveness and waiting follow new bytes", async (t) => {
	const { f, browser } = await setup(t);
	const sid = browser.sub("devbox", { kind: "view", view: "cos.timeline" });
	const first = await browser.until<TimelineValue>(sid, (v) => v.sessions.some((s) => s.threadId === "pi:sess-a"));
	const a = first.sessions.find((s) => s.threadId === "pi:sess-a")!;
	assert.equal(first.bucketMs, 900_000);
	assert.deepEqual(a.buckets, [[T, 180, .375], [T + 900_000, 211, .125]]);
	assert.deepEqual(a.marks, [[T + 899_000, "a1", "stop"], [T + 901_000, "a2", "error"]]);
	assert.equal(a.ref, "devbox/pi:sess-a");
	assert.equal(a.live, true);
	assert.equal(a.waiting, false, "a terminal error is not an owner-wait stop mark");
	assert.deepEqual([a.start, a.end], [T + 1000, T + 901_000]);
	appendFileSync(f.sessionA, message("u2", "a2", 902_000, "user"));
	const next = await browser.until<TimelineValue>(sid, (v) => v.sessions.some((s) => s.threadId === a.threadId && s.end === T + 902_000));
	assert.equal(next.sessions.find((s) => s.threadId === a.threadId)!.waiting, false);
	const blocked = f.state; blocked.agents[0].agent_status = "blocked"; f.setState(blocked);
	await browser.until<TimelineValue>(sid, (v) => v.sessions.some((s) => s.threadId === a.threadId && s.waiting));
	blocked.agents[0].agent_status = "working"; f.setState(blocked);
	await browser.until<TimelineValue>(sid, (v) => v.sessions.some((s) => s.threadId === a.threadId && !s.waiting));
	appendFileSync(f.sessionA, message("a3", "u2", 903_000, "assistant", { stopReason: "stop" }));
	// Stopped but still working (Herdr says so): not waiting yet. Idle after the stop: waiting on the owner.
	await browser.until<TimelineValue>(sid, (v) => v.sessions.some((s) => s.threadId === a.threadId && s.end === T + 903_000 && !s.waiting));
	blocked.agents[0].agent_status = "idle"; f.setState(blocked);
	await browser.until<TimelineValue>(sid, (v) => v.sessions.some((s) => s.threadId === a.threadId && s.end === T + 903_000 && s.waiting));
	appendFileSync(f.sessionA, message("u3", "a3", 904_000, "user"));
	await browser.until<TimelineValue>(sid, (v) => v.sessions.some((s) => s.threadId === a.threadId && s.end === T + 904_000 && !s.waiting));
	assert.equal(browser.snaps.get(sid), 1, "updates use deltas, not resubscription");
	assert.deepEqual(browser.gaps, []);
});

test("cos.timeline: an unreadable Session is listed as unreadable without hiding the other streams", async (t) => {
	const { f, browser } = await setup(t);
	writeFileSync(f.sessionB, line({ type: "session", version: 3, id: "sess-b", timestamp: new Date(T).toISOString(), cwd: "/work" }) + message("u1", null, 2000, "user") + "{not json}\n");
	const sid = browser.sub("devbox", { kind: "view", view: "cos.timeline" });
	const value = await browser.until<TimelineValue>(sid, (v) => Boolean(v.unreadable?.length));
	assert.deepEqual(value.unreadable!.map((u) => u.ref), ["devbox/pi:sess-b"]);
	assert.ok(value.sessions.some((s) => s.threadId === "pi:sess-a"), "the readable Session keeps its stream");
});
