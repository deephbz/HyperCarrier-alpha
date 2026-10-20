import "./bound.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { Hub } from "../src/hub/hub.ts";
import { Browser } from "./helpers.ts";
import { control, fixture } from "./pi-fixtures.ts";
import { PI_VIEWS } from "../src/pi/views/index.ts";
import { PiHost, modelLimits } from "../src/pi/host.ts";
import { TOKEN, iso, line, user, assistant, toolResult, setup } from "./pi-host-fixtures.ts";

test("pi host: unreadable latest activity cannot expire an old copy", async (t) => {
 const { f, browser } = await setup(t);
 const threads = browser.sub("devbox", { kind: "threads" });
 await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.live);
 appendFileSync(f.sessionA, "{unreadable latest activity}\n");
 const rarebit = browser.sub("devbox", { kind: "view", view: "rarebit", threadId: "pi:sess-a" });
 await browser.until<any>(rarebit, (v) => v.error);
 browser.ws.send(JSON.stringify({ t: "unsub", sid: rarebit }));
 f.setState({ ...f.state, agents: f.state.agents.filter((a: any) => a.agent_session?.value !== f.sessionA) });
 await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.live === false);
 // Leave the copy unpinned while remote forget acknowledgments can settle.
 await new Promise((resolve) => setTimeout(resolve, 500));
 const retained = browser.sub("devbox", { kind: "thread", threadId: "pi:sess-a" });
 const value = await browser.until<any>(retained, (v) => v.entries?.length === 3);
 assert.equal(value.conversationId, "pi:sess-a");
});

test("pi host: known source loss keeps the only copy and exposes recovery instead of expiring it", async (t) => {
 // A closed view holds its copy for OPEN_GRACE_MS; a short grace lets the eviction below follow the close.
 const grace = PiHost.OPEN_GRACE_MS;
 PiHost.OPEN_GRACE_MS = 300;
 t.after(() => void (PiHost.OPEN_GRACE_MS = grace));
 const { f, browser } = await setup(t);
 const threads = browser.sub("devbox", { kind: "threads" });
 await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.live);
 rmSync(f.sessionA);
 f.setState({ ...f.state, agents: f.state.agents.filter((a: any) => a.agent_session?.value !== f.sessionA) });
 const thread = browser.sub("devbox", { kind: "thread", threadId: "pi:sess-a" });
 await browser.until<any>(thread, (v) => v.entries.length === 3);
 browser.ws.send(JSON.stringify({ t: "unsub", sid: thread }));
 await browser.until<any>(threads, (v) => /retained for recovery/.test(v.threads["pi:sess-a"]?.lastError ?? ""));
 const retained = browser.sub("devbox", { kind: "thread", threadId: "pi:sess-a" });
 const view = await browser.until<any>(retained, (v) => /retained for recovery/.test(v.agent.readError ?? ""));
 assert.equal(view.entries.length, 3);
});

test("pi host: a source lost just after its view closes shows recovery only after the open grace", async (t) => {
 const grace = PiHost.OPEN_GRACE_MS;
 PiHost.OPEN_GRACE_MS = 3000;
 t.after(() => void (PiHost.OPEN_GRACE_MS = grace));
 const { f, browser } = await setup(t);
 const threads = browser.sub("devbox", { kind: "threads" });
 await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.live);
 const thread = browser.sub("devbox", { kind: "thread", threadId: "pi:sess-a" });
 await browser.until<any>(thread, (v) => v.entries.length === 3);
 rmSync(f.sessionA);
 f.setState({ ...f.state, agents: f.state.agents.filter((a: any) => a.agent_session?.value !== f.sessionA) });
 browser.ws.send(JSON.stringify({ t: "unsub", sid: thread }));
 await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.live === false);
 await new Promise((resolve) => setTimeout(resolve, 600));
 const inside = browser.values.get(threads) as any;
 assert.ok(inside.threads["pi:sess-a"], "the row stays inside the grace");
 assert.doesNotMatch(inside.threads["pi:sess-a"].lastError ?? "", /retained for recovery/, "no forget probe inside the grace");
 await browser.until<any>(threads, (v) => /retained for recovery/.test(v.threads["pi:sess-a"]?.lastError ?? ""));
});

test("pi host: while the Host is away, the last copy stays readable and actions fail instead of going elsewhere", async (t) => {
	const { f, hub, browser } = await setup(t);
	const threads = browser.sub("devbox", { kind: "threads" });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.live);
	await hub.close();
	// A new hub over the same copies, whose Host cannot be reached.
	const away = new Hub(
		{ hosts: [{ id: "devbox", label: "devbox", kind: "pi-local", cacheDir: join(f.dir, "cache"), remoteNode: "/bin/false", recentMs: Number.MAX_SAFE_INTEGER }], backend: "pi" },
		{ token: TOKEN },
	);
	const port = await away.listen(0);
	const reader = await Browser.open(port, undefined, `ampi_k_${port}=${TOKEN}`);
	t.after(async () => {
		reader.ws.close();
		await away.close();
	});
	const list = reader.sub("devbox", { kind: "threads" });
	const value = await reader.until<any>(list, (v) => v.threads["pi:sess-a"]);
	assert.equal(value.threads["pi:sess-a"].live, false);
	const thread = reader.sub("devbox", { kind: "thread", threadId: "pi:sess-a" });
	await reader.until<any>(thread, (v) => v.entries.length === 3);
	await assert.rejects(reader.req("devbox", "thread.submit", { threadId: "pi:sess-a", content: "x", whenBusy: "steer" }), /not running|not connected/);
});

/** A Pi control endpoint for a Session that has no file yet, as pi-hc-control writes it at session_start. */
async function bareControl(f: { agentDir: string }, sessionId: string, sessionFile: string, pid: number) {
	const dir = join(f.agentDir, "hc-control");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const requests: any[] = [];
	const server = createServer((c) => {
		let buf = "";
		c.setEncoding("utf8");
		c.on("data", (d: string) => {
			buf += d;
			let i: number;
			while ((i = buf.indexOf("\n")) >= 0) {
				const req = JSON.parse(buf.slice(0, i));
				buf = buf.slice(i + 1);
				requests.push(req);
				const reply = req.op === "status"
					? { id: req.id, ok: true, value: { sessionId, sessionFile, nonce: `n-${sessionId}`, idle: true, compacting: false, pending: { steer: 0, followUp: 0 } } }
					: { id: req.id, ok: true, evidence: "started", entryId: "e-first" };
				c.write(`${JSON.stringify(reply)}\n`);
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(join(dir, `${sessionId}.sock`), resolve));
	writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify({ schema: "hc-control/1", sessionId, sessionFile, pid, nonce: `n-${sessionId}`, startedAt: iso(9), version: "test" }));
	return { requests, close: () => server.close() };
}

test("pi host: a live control descriptor makes a Session present before its file; the file merges into it", async (t) => {
	const { f, browser } = await setup(t);
	const dir = join(f.agentDir, "sessions", "--fresh--");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "e.jsonl");
	const live = await bareControl(f, "sess-e", file, process.pid);
	// A descriptor whose process is gone never shows, even when something still answers on its socket.
	const dead = spawnSync(process.execPath, ["-e", ""]).pid;
	const stale = await bareControl(f, "sess-z", join(dir, "z.jsonl"), dead);
	t.after(() => { live.close(); stale.close(); });
	const threads = browser.sub("devbox", { kind: "threads" });
	const listed = await browser.until<any>(threads, (v) => v.threads["pi:sess-e"] && v.threads["pi:sess-a"]);
	const e = listed.threads["pi:sess-e"];
	assert.deepEqual([e.live, e.control, e.activity, e.ref, e.createdAt], [true, true, "idle", "devbox/pi:sess-e", Date.parse(iso(9))]);
	assert.equal(listed.threads["pi:sess-z"], undefined, "a dead pid's descriptor is not presence");
	const thread = browser.sub("devbox", { kind: "thread", threadId: "pi:sess-e" });
	assert.deepEqual((await browser.until<any>(thread, () => true)).entries, []);

	const sent = await browser.req("devbox", "thread.submit", { threadId: "pi:sess-e", content: "first words", whenBusy: "steer" });
	assert.deepEqual(sent, { via: "control", evidence: "started", entryId: "e-first" });
	assert.deepEqual(live.requests.filter((r) => r.op === "submit").map((r) => r.text), ["first words"]);
	assert.deepEqual(f.herdrCalls(), [], "no keys were sent");

	// Pi writes the file with the first message: one thread, now with its transcript.
	writeFileSync(file, line({ type: "session", version: 3, id: "sess-e", timestamp: new Date().toISOString(), cwd: "/fresh" }) + user("e-first", null, 10, "first words"));
	await browser.until<any>(thread, (v) => v.entries.length === 1 && v.entries[0].text === "first words");
	const merged = await browser.until<any>(threads, (v) => v.threads["pi:sess-e"]?.cwd === "/fresh");
	assert.equal(Object.keys(merged.threads).filter((id) => id.includes("sess-e")).length, 1);
	assert.deepEqual([merged.threads["pi:sess-e"].live, merged.threads["pi:sess-e"].control, merged.threads["pi:sess-e"].preview], [true, true, "first words"]);
});

test("pi host: slash commands go only to a control that serves them; every older tier refuses at once", async (t) => {
	const { f, browser } = await setup(t);
	const ctl = await control(f, f.sessionA, { commands: true });
	t.after(() => ctl.close());
	const threads = browser.sub("devbox", { kind: "threads" });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.control === true && v.threads["pi:sess-b"]?.live === true);
	const listed = await browser.req("devbox", "thread.commands", { threadId: "pi:sess-a" });
	assert.deepEqual(listed.models, [{ ref: "p/m2" }]);
	const ran = await browser.req("devbox", "thread.command", { threadId: "pi:sess-a", name: "model", args: "m2", key: "k-1" });
	assert.deepEqual(ran, { via: "control", disposition: "handled", notice: "Model: p/m2", effect: { model: "p/m2" } });
	assert.deepEqual(ctl.requests.filter((r) => r.op === "command").map(({ id: _id, ...r }) => r), [{ op: "command", name: "model", args: "m2", key: "k-1" }]);
	// The control's error detail reaches the composer, so an ambiguous id can name its matches.
	await assert.rejects(browser.req("devbox", "thread.command", { threadId: "pi:sess-a", name: "model", args: "x" }), (e: any) => e.code === "bad_args" && e.matches?.join() === "p/x,q/x");
	// A pane with no control: the composer falls back to keys, which Pi's TUI runs natively.
	await assert.rejects(browser.req("devbox", "thread.commands", { threadId: "pi:sess-b" }), (e: any) => e.code === "no_control");
	assert.ok(!f.herdrCalls().some((c) => c.includes("/model")), "no command reached a pane as keys");
	assert.equal(ctl.requests.filter((r) => r.op === "submit").length, 0, "no command reached Pi as text");
});

test("pi host: an old control or an old remote agent answers commands_unsupported without sending the command", async (t) => {
	// An old remote agent: the same agent with its hello stripped of controlOps.
	const wrapper = join(fixture().dir, "old-agent.cjs");
	writeFileSync(wrapper, `#!${process.execPath}
const agent = require("child_process").spawn(process.execPath, process.argv.slice(2), { stdio: ["inherit", "pipe", "inherit"] });
let buf = "";
agent.stdout.setEncoding("utf8");
agent.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    process.stdout.write((line.includes('"t":"hello"') ? JSON.stringify({ ...JSON.parse(line), controlOps: undefined }) : line) + "\\n");
  }
});
agent.on("exit", (code) => process.exit(code ?? 1));
process.on("SIGTERM", () => { agent.kill(); process.exit(143); });
`);
	chmodSync(wrapper, 0o755);
	for (const [label, host, commands] of [["old remote agent", { remoteNode: wrapper }, true], ["old control", {}, false]] as const) {
		const { f, browser } = await setup(t, host);
		const ctl = await control(f, f.sessionA, { commands });
		t.after(() => ctl.close());
		const threads = browser.sub("devbox", { kind: "threads" });
		await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.control === true);
		const started = Date.now();
		await assert.rejects(browser.req("devbox", "thread.command", { threadId: "pi:sess-a", name: "model", args: "m2" }), /too old for slash commands/, label);
		assert.ok(Date.now() - started < 2000, `${label}: answered in ${Date.now() - started} ms`);
		assert.deepEqual(ctl.requests.filter((r) => r.op !== "status"), [], `${label}: nothing reached the control`);
		// A pane with no control falls back to keys whatever the agent's version, so it must not read as too old.
		await browser.until<any>(threads, (v) => v.threads["pi:sess-b"]?.live === true);
		await assert.rejects(browser.req("devbox", "thread.commands", { threadId: "pi:sess-b" }), (e: any) => e.code === "no_control", `${label}: a Session without a control`);
	}
});

test("pi host: a model_change entry names the Session's model before any turn uses it (A27 /model)", async (t) => {
	const { f, browser } = await setup(t);
	const threads = browser.sub("devbox", { kind: "threads" });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.model);
	appendFileSync(f.sessionA, line({ type: "model_change", id: "mc1", parentId: "r1", timestamp: new Date().toISOString(), provider: "p", modelId: "m2" }));
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.model === "p/m2");
});
