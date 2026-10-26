import "./bound.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Hub } from "../src/hub/hub.ts";
import { Browser } from "./helpers.ts";
import { control, fixture } from "./pi-fixtures.ts";
import { PI_VIEWS } from "../src/pi/views/index.ts";
import { PiHost, modelLimits } from "../src/pi/host.ts";
import { TOKEN, iso, line, user, assistant, toolResult, setup } from "./pi-host-fixtures.ts";

test("pi host: 96-hour eviction respects open/live pins, removes copied payloads, preserves locators, and tracks a changed source again", async (t) => {
 // A closed view holds its copy for OPEN_GRACE_MS; a short grace lets the eviction below follow the close.
 const grace = PiHost.OPEN_GRACE_MS;
 PiHost.OPEN_GRACE_MS = 300;
 t.after(() => void (PiHost.OPEN_GRACE_MS = grace));
 // Discovery faster than the index write delay: the pending write must still land.
 const { f, browser, hub } = await setup(t, { agent: { discoverMs: 40 } });
 const threads = browser.sub("devbox", { kind: "threads" });
 await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.live);
 const thread = browser.sub("devbox", { kind: "thread", threadId: "pi:sess-a" });
 await browser.until<any>(thread, (v) => v.entries.length === 3);
 const cache = join(f.dir, "cache", readdirSync(join(f.dir, "cache"))[0]!);
 const index = () => JSON.parse(readFileSync(join(cache, "index.json"), "utf8"));
 const savedBy = Date.now() + 3000;
 while (!existsSync(join(cache, "index.json")) && Date.now() < savedBy) await new Promise((resolve) => setTimeout(resolve, 10));
 assert.ok(existsSync(join(cache, "index.json")), "debounced copy index was persisted");
 f.setState({ ...f.state, agents: f.state.agents.filter((a: any) => a.agent_session?.value !== f.sessionA) });
 await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.live === false);
 assert.ok(index()[f.sessionA], "open interest pins an old copy");
 assert.ok((await browser.req("devbox", "thread.history", { threadId: "pi:sess-a" })).entries.length);
 browser.ws.send(JSON.stringify({ t: "unsub", sid: thread }));
 await browser.until<any>(threads, (v) => !v.threads["pi:sess-a"]);
 assert.equal(index()[f.sessionA], undefined); assert.ok(existsSync(f.sessionA), "native evidence is untouched");
 assert.ok(index()[f.sessionB], "live old Session stays copied");
 const expired = browser.sub("devbox", { kind: "thread", threadId: "pi:sess-a" });
 await browser.until<any>(expired, (v) => /outside retained scope/.test(v.agent.readError ?? ""));
 hub.link("devbox")!.reconnect();
 await new Promise((resolve) => setTimeout(resolve, 1600));
 assert.equal(index()[f.sessionA], undefined, "reconnect cannot recopy an unchanged expired source");
 appendFileSync(f.sessionA, line({ type: "message", id: "new", parentId: "r1", timestamp: new Date().toISOString(), message: { role: "user", content: "fresh again" } }));
 await browser.until<any>(expired, (v) => v.entries.some((e: any) => e.id === "new"));
});

test("pi host: submit goes through the control socket with its evidence; without one, keys say they prove less", async (t) => {
	const { f, browser } = await setup(t);
	const ctl = await control(f, f.sessionA);
	t.after(() => ctl.close());
	const threads = browser.sub("devbox", { kind: "threads" });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.control === true && v.threads["pi:sess-b"]?.live === true);
	const steer = await browser.req("devbox", "thread.submit", { threadId: "pi:sess-a", content: "look at b.txt", whenBusy: "steer" });
	assert.deepEqual(steer, { via: "control", evidence: "admitted", entryId: "e-42" }, "the entry the control socket names reaches the GUI");
	const submitted = ctl.requests.find((r) => r.op === "submit");
	assert.equal(submitted?.deliverAs, "steer");
	assert.equal(submitted?.text, "look at b.txt");

	// Session B runs in an idle pane with no control extension: the message is typed into the pane.
	const typed = await browser.req("devbox", "thread.submit", { threadId: "pi:sess-b", content: "go on", whenBusy: "followUp" });
	assert.deepEqual(typed, { via: "keys", evidence: "sent" });
	assert.ok(f.herdrCalls().some((c) => c.includes("prompt") && c.includes("go on")));

	await assert.rejects(browser.req("devbox", "thread.submit", { threadId: "pi:unknown", content: "x", whenBusy: "steer" }), /Unknown Session/);
	await assert.rejects(browser.req("devbox", "thread.compact", { threadId: "pi:sess-a" }), /not available for Pi Sessions/);
});

test("pi host: a Host link that cannot take commands ends at once; a pending submit fails instead of vanishing", async (t) => {
	// The agent keeps streaming frames, but nothing reads the hub's command pipe after the bootstrap line.
	const wrapper = join(fixture().dir, "half-open.cjs");
	writeFileSync(wrapper, `#!${process.execPath}
const fs = require("fs");
let first = Buffer.alloc(0);
const b = Buffer.alloc(1 << 16);
while (!first.includes(10)) { const n = fs.readSync(0, b); if (!n) process.exit(1); first = Buffer.concat([first, b.subarray(0, n)]); }
fs.closeSync(0);
fs.openSync("/dev/null", "r"); // fd 0 again, so the spawn below cannot take it
const agent = require("child_process").spawn(process.execPath, process.argv.slice(2), { stdio: ["pipe", "inherit", "inherit"] });
agent.stdin.write(first.subarray(0, first.indexOf(10) + 1));
agent.on("exit", (code) => process.exit(code ?? 1));
process.on("SIGTERM", () => { agent.kill(); process.exit(143); });
`);
	chmodSync(wrapper, 0o755);
	const { browser } = await setup(t, { remoteNode: wrapper });
	const threads = browser.sub("devbox", { kind: "threads" });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.live === true);
	const started = Date.now();
	await assert.rejects(browser.req("devbox", "thread.submit", { threadId: "pi:sess-a", content: "x", whenBusy: "steer" }), /disconnected|not connected/);
	assert.ok(Date.now() - started < 5000, `answered in ${Date.now() - started} ms, before the 20 s command timeout`);
	await browser.when(() => browser.hosts.some((h) => h.id === "devbox" && /hub stdin EPIPE/.test(h.error ?? "")), 5000, "the status names the stdin error");
});

test("pi host: switching between Sessions is served from local copies within the budget", async (t) => {
	const { browser } = await setup(t);
	const threads = browser.sub("devbox", { kind: "threads" });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"] && v.threads["pi:sess-b"]);
	const timings: number[] = [];
	for (let i = 0; i < 20; i++) {
		const threadId = i % 2 ? "pi:sess-a" : "pi:sess-b";
		const started = performance.now();
		const sid = browser.sub("devbox", { kind: "thread", threadId });
		await browser.until(sid, (v: any) => v.entries.length > 0);
		timings.push(performance.now() - started);
		browser.ws.send(JSON.stringify({ t: "unsub", sid }));
	}
	timings.sort((x, y) => x - y);
	const p95 = timings[Math.ceil(timings.length * 0.95) - 1]!;
	assert.ok(p95 < 50, `hub-side switch p95 ${p95.toFixed(1)} ms must stay under the 50 ms budget`);
});

test("pi host: abort names each queued message Pi returned to its input box; the composer queue keeps it until dismissed", async (t) => {
	const { f, browser } = await setup(t);
	const ctl = await control(f, f.sessionA, { queue: true });
	t.after(() => ctl.close());
	const threads = browser.sub("devbox", { kind: "threads" });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.control === true);
	const thread = browser.sub("devbox", { kind: "thread", threadId: "pi:sess-a" });
	const items = (v: any) => v?.inbox?.items ?? [];

	const ack = await browser.req("devbox", "thread.submit", { threadId: "pi:sess-a", content: "and then the tests", whenBusy: "followUp" });
	assert.deepEqual(ack, { via: "control", evidence: "admitted", submission: "sub-1" });
	await browser.until<any>(thread, (v) => items(v)[0]?.state === "queued");
	assert.deepEqual(items(browser.values.get(thread)), [{ id: "sub-1", mode: "followUp", content: "and then the tests", state: "queued" }]);
	await assert.rejects(browser.req("devbox", "thread.withdraw", { threadId: "pi:sess-a", submissionId: "sub-1" }), /cannot take back one queued message/);

	const stopped = await browser.req("devbox", "thread.abort", { threadId: "pi:sess-a" });
	assert.equal(stopped.evidence, "aborted");
	assert.deepEqual(stopped.submissions.map((s: any) => [s.submission, s.state, s.text]), [["sub-1", "returned", "and then the tests"]]);
	await browser.until<any>(thread, (v) => items(v)[0]?.state === "returned");

	assert.deepEqual(await browser.req("devbox", "thread.withdraw", { threadId: "pi:sess-a", submissionId: "sub-1" }), { withdrawn: true });
	await browser.until<any>(thread, (v) => items(v).length === 0);
	// Later status frames still list it; a dismissed item stays hidden.
	await new Promise((r) => setTimeout(r, 700));
	assert.deepEqual(items(browser.values.get(thread)), []);

	// A queued message the control stops reporting (Pi restarted or switched Session) has an unknown outcome.
	await browser.req("devbox", "thread.submit", { threadId: "pi:sess-a", content: "one more", whenBusy: "steer" });
	await browser.until<any>(thread, (v) => items(v)[0]?.state === "queued");
	ctl.submissions.length = 0;
	await browser.until<any>(thread, (v) => items(v)[0]?.state === "unknown");
	assert.equal(items(browser.values.get(thread))[0].content, "one more");
});
