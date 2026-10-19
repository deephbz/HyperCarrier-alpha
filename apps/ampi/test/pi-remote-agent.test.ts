import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { AGENT, Agent, control, type Fixture, fixture, type Frame } from "./pi-fixtures.ts";

test("pi remote agent: layout in Herdr order, agents carry ids, sessionId from header", async (t) => {
	const f = fixture();
	const agent = Agent.start(f);
	t.after(() => agent.stop());
	const hello = await agent.wait((x) => x.t === "hello", "hello");
	assert.equal(hello.herdr, true);
	assert.equal(hello.control, false);
	const frame = await agent.wait((x) => x.t === "agents" && x.agents.length > 0, "agents");
	assert.equal(frame.source, "herdr");
	assert.deepEqual(frame.layout, {
		workspaces: [
			{ id: "w2", label: "beta", tabs: [{ id: "w2:tC", label: "other", panes: [] }] },
			{ id: "w1", label: "alpha", tabs: [{ id: "w1:tA", label: "main", panes: ["w1:p2", "w1:p1"] }, { id: "w1:tB", label: "spare", panes: [] }] },
		],
	});
	assert.deepEqual(frame.agents.map((a: Frame) => [a.pane, a.workspace, a.tab, a.session, a.sessionId, a.status, a.control]), [
		["w1:p2", "w1", "w1:tA", f.sessionA, "sess-a", "working", null],
		["w1:p1", "w1", "w1:tA", f.sessionB, "sess-b", "idle", null],
	]);
});

test("pi remote agent: ships appended bytes and holds a partial line until it ends", async (t) => {
	const f = fixture();
	const agent = Agent.start(f, { pollMs: 30 });
	t.after(() => agent.stop());
	await agent.wait((x) => x.t === "reset" && x.path === f.sessionA && x.offset === 0, "reset");
	const head = readFileSync(f.sessionA, "utf8");
	await agent.wait((x) => x.t === "chunk" && x.path === f.sessionA && x.offset === 0 && x.data === head, "header chunk");
	appendFileSync(f.sessionA, '{"type":"message","id":"m1"');
	await new Promise((r) => setTimeout(r, 200));
	const from = agent.frames.length;
	assert.ok(!agent.frames.some((x) => x.t === "chunk" && x.path === f.sessionA && x.offset > 0), "no chunk for a partial line");
	appendFileSync(f.sessionA, '}\n{"type":"message","id":"m2"}\n');
	const chunk = await agent.wait((x) => x.t === "chunk" && x.path === f.sessionA, "appended chunk", from);
	assert.equal(chunk.offset, Buffer.byteLength(head));
	assert.equal(chunk.data, '{"type":"message","id":"m1"}\n{"type":"message","id":"m2"}\n');
});

test("pi remote agent: default discovery includes 95-hour sources and excludes 97-hour sources", async (t) => {
 const f = fixture();
 f.setState({ ...f.state, agents: [] });
 const now = Date.now();
 utimesSync(f.sessionA, new Date(now - 95 * 3600_000), new Date(now - 95 * 3600_000));
 utimesSync(f.sessionB, new Date(now - 97 * 3600_000), new Date(now - 97 * 3600_000));
 const agent = Agent.start(f); t.after(() => agent.stop());
 const frame = await agent.wait((x) => x.t === "agents", "recent discovery");
 assert.ok(frame.agents.some((a: Frame) => a.session === f.sessionA));
 assert.ok(!frame.agents.some((a: Frame) => a.session === f.sessionB));
});

test("pi remote agent: submit and abort go to a live control socket and forward its evidence", async (t) => {
	const f = fixture();
	const ctl = await control(f, f.sessionA);
	// A live Session that Herdr does not list is still reported, with no pane.
	const orphan = join(f.agentDir, "sessions", "--work--", "c.jsonl");
	writeFileSync(orphan, `${JSON.stringify({ type: "session", id: "sess-c" })}\n`);
	const dir = join(f.agentDir, "hc-control");
	const server = createServer((c) => c.on("data", (d) => {
		const req = JSON.parse(String(d));
		c.write(`${JSON.stringify({ id: req.id, ok: true, value: { sessionId: "sess-c", sessionFile: orphan, nonce: "n-c", idle: true, compacting: false, pending: { steer: 0, followUp: 0 } } })}\n`);
	}));
	await new Promise<void>((resolve) => server.listen(join(dir, "sess-c.sock"), resolve));
	writeFileSync(join(dir, "sess-c.json"), JSON.stringify({ schema: "hc-control/1", sessionId: "sess-c", sessionFile: orphan, pid: process.pid, nonce: "n-c" }));
	const agent = Agent.start(f);
	t.after(() => { agent.stop(); ctl.close(); server.close(); });

	const frame = await agent.wait((x) => x.t === "agents" && x.agents.length === 3, "agents with control");
	const a = frame.agents.find((x: Frame) => x.session === f.sessionA);
	assert.deepEqual(a.control, { live: true, idle: false, compacting: false, pending: { steer: 0, followUp: 1 } });
	const c = frame.agents.find((x: Frame) => x.session === orphan);
	assert.equal(c.pane, null);
	assert.equal(c.sessionId, "sess-c");
	assert.equal(c.control.idle, true);

	const ack = await agent.request({ t: "submit", id: 1, session: f.sessionA, pane: "w1:p2", text: "look at the tests", deliverAs: "followUp" });
	assert.deepEqual([ack.ok, ack.via, ack.evidence, ack.entryId], [true, "control", "admitted", "e-42"]);
	assert.deepEqual(ctl.requests.filter((r) => r.op === "submit").map((r) => [r.text, r.deliverAs]), [["look at the tests", "followUp"]]);
	const stop = await agent.request({ t: "abort", id: 2, session: f.sessionA });
	assert.deepEqual([stop.ok, stop.via, stop.evidence], [true, "control", "aborted"]);
	assert.deepEqual(f.herdrCalls(), [], "no keys were sent");
});

test("pi remote agent: without a live descriptor, submit uses Herdr keys after the binding recheck", async (t) => {
	const f = fixture();
	// Stale descriptor: the socket answers with another nonce, so it cannot pass for the live Session.
	const ctl = await control(f, f.sessionB, { nonce: "n-new", descriptorNonce: "n-old" });
	const agent = Agent.start(f);
	t.after(() => { agent.stop(); ctl.close(); });
	const frame = await agent.wait((x) => x.t === "agents" && x.agents.length > 0, "agents");
	assert.equal(frame.agents.find((x: Frame) => x.session === f.sessionB).control, null);

	// Nonce mismatch: idle agent, a steer starts a turn through `agent prompt`.
	const steer = await agent.request({ t: "submit", id: 1, session: f.sessionB, pane: "w1:p1", text: "hello", deliverAs: "steer" });
	assert.deepEqual([steer.ok, steer.via, steer.evidence], [true, "keys", "sent"]);
	assert.ok(!ctl.requests.some((r) => r.op === "submit"));
	// No descriptor at all, busy agent: steer is a prompt; follow-up types the text, then alt+enter.
	const busySteer = await agent.request({ t: "submit", id: 2, session: f.sessionA, text: "steer me", deliverAs: "steer" });
	assert.equal(busySteer.evidence, "sent");
	const follow = await agent.request({ t: "submit", id: 3, session: f.sessionA, pane: "w1:p2", text: "after this", deliverAs: "followUp" });
	assert.deepEqual([follow.ok, follow.via, follow.evidence], [true, "keys", "sent"]);
	const stop = await agent.request({ t: "abort", id: 4, session: f.sessionA, pane: "w1:p2" });
	assert.deepEqual([stop.ok, stop.evidence], [true, "sent"]);
	const idle = await agent.request({ t: "abort", id: 5, session: f.sessionB, pane: "w1:p1" });
	assert.deepEqual([idle.ok, idle.via, idle.evidence], [true, "keys", "idle"]);
	assert.deepEqual(f.herdrCalls(), [
		["agent", "prompt", "w1:p1", "hello"],
		["agent", "prompt", "w1:p2", "steer me"],
		["pane", "send-text", "w1:p2", "after this"],
		["agent", "send-keys", "w1:p2", "alt+enter"],
		["agent", "send-keys", "w1:p2", "esc"],
	]);
});

test("pi remote agent: key tokens are configurable; a changed binding is refused", async (t) => {
	const f = fixture();
	const agent = Agent.start(f, { keys: { typeArgv: ["pane", "send-text", "{pane}", "{text}"], followUp: ["enter"] } });
	t.after(() => agent.stop());
	await agent.wait((x) => x.t === "agents" && x.agents.length > 0, "agents");
	// The pane now hosts another Session: never type into it.
	f.setState({ ...f.state, agents: f.state.agents.map((a: Frame) => a.pane_id === "w1:p2" ? { ...a, agent_session: { kind: "path", agent: "pi", value: f.sessionB } } : a) });
	const refused = await agent.request({ t: "submit", id: 1, session: f.sessionA, pane: "w1:p2", text: "x", deliverAs: "steer" });
	assert.deepEqual([refused.ok, refused.via, refused.error.code], [false, "keys", "binding_changed"]);
	const missing = await agent.request({ t: "abort", id: 2, session: f.sessionA, pane: "w9:none" });
	assert.equal(missing.error.code, "binding_changed");
	assert.deepEqual(f.herdrCalls(), []);
	// A blocked agent shows a dialog; typed text would answer it.
	f.setState({ ...f.state, agents: f.state.agents.map((a: Frame) => a.pane_id === "w1:p1" ? { ...a, agent_status: "blocked" } : a) });
	const blocked = await agent.request({ t: "submit", id: 3, session: f.sessionB, pane: "w1:p1", text: "y", deliverAs: "steer" });
	assert.equal(blocked.error.code, "agent_blocked");
	f.setState({ ...f.state, agents: f.state.agents.map((a: Frame) => a.pane_id === "w1:p1" ? { ...a, agent_status: "working" } : a) });
	const follow = await agent.request({ t: "submit", id: 4, session: f.sessionB, pane: "w1:p1", text: "later", deliverAs: "followUp" });
	assert.equal(follow.ok, true);
	assert.deepEqual(f.herdrCalls(), [["pane", "send-text", "w1:p1", "later"], ["agent", "send-keys", "w1:p1", "enter"]]);
});

test("pi remote agent: spawn ledger and start outcomes; close fails closed on Team state", async (t) => {
	const f = fixture();
	// Pi Team Bright's observation, read from a file the test rewrites: first unavailable, then Session B's pane is a teammate.
	const snapshotFile = join(f.dir, "snapshot.json");
	writeFileSync(snapshotFile, JSON.stringify({ schema: "pi-teams-observation/1", availability: "unavailable", issues: [{ code: "store_locked" }], teams: [] }));
	const observation = join(f.dir, "observation.mjs");
	writeFileSync(observation, `import { readFileSync } from "node:fs";\nexport const readObservationSnapshot = async () => JSON.parse(readFileSync(${JSON.stringify(snapshotFile)}, "utf8"));\n`);
	const agent = Agent.start(f, { teams: true, teamsMs: 100, ptbObservation: observation });
	t.after(() => agent.stop());
	await agent.wait((x) => x.t === "agents" && x.agents.length > 0, "agents");
	// Installed but no good snapshot: any pane may be a teammate's.
	const stale = await agent.request({ t: "close", id: 1, session: f.sessionA, pane: "w1:p2" });
	assert.deepEqual([stale.ok, stale.error.code], [false, "team_unknown"]);
	writeFileSync(snapshotFile, JSON.stringify({
		schema: "pi-teams-observation/1", availability: "available", issues: [],
		teams: [{ teamName: "crew", memberships: [{
			membershipId: "m1", memberName: "w1", coordinationRole: "teammate", lifecycle: { state: "current" },
			terminalTarget: { backend: "herdr", kind: "pane", targetId: "w1:p1" }, session: { kind: "pi-jsonl-path", locator: f.sessionB },
		}] }],
	}));
	await agent.wait((x) => x.t === "teams" && x.members.length === 1, "teams", 0, 8000);
	const worker = await agent.request({ t: "close", id: 2, session: f.sessionB, pane: "w1:p1" });
	assert.deepEqual([worker.ok, worker.error.code], [false, "team_worker"]);
	assert.deepEqual(f.herdrCalls(), [], "no Herdr call for a refused close");

	// Two concurrent spawns with one requestId while Herdr is slow to split: one split; the other cannot know yet.
	const spawn = (id: number, requestId: string) => agent.request({ t: "spawn", id, requestId, sessionId: requestId, cwd: "/work", beside: "w1:p2", name: "x" });
	const splits = () => f.herdrCalls().filter((c) => c[1] === "split").length;
	f.setState({ ...f.state, splitDelayMs: 200 });
	const twin = randomUUID();
	const [first, second] = await Promise.all([spawn(3, twin), spawn(4, twin)]);
	assert.deepEqual([first.ok, first.evidence, second.ok, second.error?.code], [true, "started", false, "outcome_unknown"]);
	assert.equal(splits(), 1);
	f.setState({ ...f.state, splitDelayMs: 0 });

	// A start Herdr refuses before acting is a refusal, with the pane it left; a start that may have run is `unknown`.
	const busyRequestId = randomUUID();
	const unknownRequestId = randomUUID();
	const stuckRequestId = randomUUID();
	const goneRequestId = randomUUID();
	f.setState({ ...f.state, startError: "agent_pane_busy" });
	const busy = await spawn(5, busyRequestId);
	assert.deepEqual([busy.ok, busy.error.code, typeof busy.pane], [false, "agent_pane_busy", "string"]);
	f.setState({ ...f.state, startError: "agent_start_timeout" });
	const unknown = await agent.request({ t: "spawn", id: 6, requestId: unknownRequestId, sessionId: unknownRequestId, cwd: "/work", beside: "w1:p2", prompt: "hi" });
	assert.deepEqual([unknown.ok, unknown.via, unknown.evidence, unknown.submitted?.error?.code], [true, "herdr", "unknown", "not_started"]);
	const ledger = join(f.agentDir, "hc-control", "spawns", `${unknownRequestId}.json`);
	assert.equal(statSync(ledger).mode & 0o777, 0o600);
	assert.equal(statSync(join(f.agentDir, "hc-control", "spawns")).mode & 0o777, 0o700);
	assert.equal(JSON.parse(readFileSync(ledger, "utf8")).state, "unknown");
	// Repeats answer from the ledger; an attempt that stopped while splitting is never split again.
	assert.equal(splits(), 3);
	assert.deepEqual([(await spawn(7, busyRequestId)).error.code, (await spawn(8, unknownRequestId)).evidence], ["agent_pane_busy", "unknown"]);
	writeFileSync(join(f.agentDir, "hc-control", "spawns", `${stuckRequestId}.json`), JSON.stringify({ state: "splitting" }));
	const stuck = await spawn(9, stuckRequestId);
	assert.deepEqual([stuck.ok, stuck.error.code], [false, "outcome_unknown"]);
	assert.equal(splits(), 3);
	// An explicit split refusal carries Herdr's code.
	const gone = await agent.request({ t: "spawn", id: 10, requestId: goneRequestId, sessionId: goneRequestId, cwd: "/work", beside: "w9:none" });
	assert.deepEqual([gone.ok, gone.error.code], [false, "pane_not_found"]);
});

test("pi remote agent: AMPI_TRACE records frames, Herdr calls, control requests, and reads on the epoch clock without text or paths", async (t) => {
	const f = fixture();
	const runDir = join(f.dir, "run");
	mkdirSync(runDir);
	const ctl = await control(f, f.sessionA);
	t.after(() => ctl.close());
	const before = (performance.timeOrigin + performance.now()) * 1000;
	process.env.AMPI_TRACE = runDir;
	const agent = Agent.start(f, { host: "devbox" });
	delete process.env.AMPI_TRACE;
	await agent.wait((x) => x.t === "chunk" && x.path === f.sessionA, "chunk");
	const ack = await agent.request({ t: "submit", id: 1, session: f.sessionA, text: "owner secret words", deliverAs: "followUp" });
	assert.equal(ack.via, "control");
	const exited = new Promise((resolve) => agent.child.once("exit", resolve));
	agent.stop();
	await exited;
	const after = (performance.timeOrigin + performance.now()) * 1000;
	const raw = readFileSync(join(runDir, `trace-${agent.child.pid}-0.json`), "utf8");
	const events = JSON.parse(raw).traceEvents as Frame[];
	assert.deepEqual(events.filter((e) => e.ph === "M").map((e) => [e.name, e.pid, e.tid, e.args.name]), [
		["process_name", agent.child.pid, 0, "remote-agent:devbox"],
		["thread_name", agent.child.pid, 0, "main"],
	]);
	const names = new Set(events.map((e) => e.name));
	for (const name of ["hello", "frame hello", "frame agents", "frame chunk", "herdr agent list", "control status", "control submit", "read", "discover"]) assert.ok(names.has(name), `${name} is traced`);
	for (const e of events.filter((x) => x.ph !== "M")) {
		assert.ok(e.ts >= before && e.ts <= after, `${e.name} is on the epoch µs clock`);
		if (e.ph === "X") assert.ok(e.dur >= 0);
	}
	assert.ok(events.some((e) => e.name === "read" && e.args.bytes > 0));
	assert.ok(!raw.includes("owner secret words") && !raw.includes(f.dir), "no owner text or paths in the trace");
});

// The agent's output path under a slow or failing pipe. FAULT_ENOBUFS fails that many fd-1 writes; the pre-fix
// agent wrote through process.stdout, where libuv reports the same errno as a stream error.
const FAULT = `const fs = require("fs");
let left = Number(process.env.FAULT_ENOBUFS || 0);
const write = fs.write;
const enobufs = () => Object.assign(new Error("ENOBUFS: no buffer space available, write"), { code: "ENOBUFS", errno: -55, syscall: "write" });
fs.write = function (fd, ...rest) {
  if (fd === 1 && left > 0) { left--; return process.nextTick(rest[rest.length - 1], enobufs()); }
  return write.call(this, fd, ...rest);
};
setTimeout(() => { if (process.stdout.listenerCount("error")) process.stdout.emit("error", enobufs()); }, 300);
`;

function startPiped(f: Fixture, env: Record<string, string> = {}) {
	const preload = join(f.dir, "fault.cjs");
	writeFileSync(preload, FAULT);
	const cfg = { agentDir: f.agentDir, pollMs: 30, discoverMs: 150, teams: false, controlStatusMs: 300 };
	const child = spawn(process.execPath, ["--require", preload, AGENT], {
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			...process.env, HOME: f.dir, HERDR_BIN: join(f.dir, "herdr"), HCM_CFG: Buffer.from(JSON.stringify(cfg)).toString("base64"),
			FAKE_HERDR_STATE: join(f.dir, "state.json"), FAKE_HERDR_LOG: join(f.dir, "calls.jsonl"), ...env,
		},
	});
	let stderr = "";
	child.stderr!.on("data", (d) => { stderr += d; });
	return { agent: new Agent(child), stderr: () => stderr };
}

/** Chunks of one Session must tile its bytes: in order, no gap, no repeat. */
function tiled(frames: Frame[], path: string): string {
	let at = 0, data = "";
	for (const c of frames.filter((x) => x.t === "chunk" && x.path === path)) {
		assert.equal(c.offset, at, "chunks arrive in order with no gap");
		at += Buffer.byteLength(c.data);
		data += c.data;
	}
	return data;
}

test("pi remote agent: transient ENOBUFS on stdout is retried; the agent stays and frames arrive in order", async (t) => {
	const f = fixture();
	const { agent, stderr } = startPiped(f, { FAULT_ENOBUFS: "6" });
	t.after(() => agent.stop());
	await agent.wait((x) => x.t === "hello", "hello");
	await new Promise((r) => setTimeout(r, 500)); // past the injected stream error
	for (let i = 0; i < 50; i++) appendFileSync(f.sessionA, `${JSON.stringify({ type: "message", id: `m${i}` })}\n`);
	const ack = await agent.request({ t: "submit", id: 1, session: "/nowhere.jsonl", text: "x", deliverAs: "steer" });
	assert.equal(ack.ok, false);
	await agent.wait((x) => x.t === "chunk" && x.path === f.sessionA && x.data.includes('"m49"'), "last chunk");
	assert.equal(tiled(agent.frames, f.sessionA), readFileSync(f.sessionA, "utf8"));
	assert.equal(agent.child.exitCode, null, `agent alive; stderr: ${stderr()}`);
	assert.equal(agent.child.signalCode, null);
});

test("pi remote agent: a reader that stops for a while gets every byte once it resumes", async (t) => {
	const f = fixture();
	const line = `${JSON.stringify({ type: "message", text: "y".repeat(4000) })}\n`;
	appendFileSync(f.sessionA, line.repeat(6000)); // ~24 MB: three times the pump's high-water mark
	const { agent, stderr } = startPiped(f);
	t.after(() => agent.stop());
	await agent.wait((x) => x.t === "hello", "hello");
	agent.child.stdout!.pause();
	await new Promise((r) => setTimeout(r, 1500));
	agent.child.stdout!.resume();
	const size = statSync(f.sessionA).size;
	await agent.wait((x) => x.t === "chunk" && x.path === f.sessionA && x.offset + Buffer.byteLength(x.data) === size, "last byte", 0, 30_000);
	assert.equal(tiled(agent.frames, f.sessionA), readFileSync(f.sessionA, "utf8"));
	assert.equal(agent.child.exitCode, null, `agent alive; stderr: ${stderr()}`);
});

test("pi remote agent: a response overtakes queued Session bytes at a frame boundary", async (t) => {
	const f = fixture();
	const line = `${JSON.stringify({ type: "message", text: "z".repeat(4000) })}\n`;
	appendFileSync(f.sessionA, line.repeat(6000)); // ~24 MB: the pump fills its queue to the high-water mark
	const { agent, stderr } = startPiped(f);
	t.after(() => agent.stop());
	await agent.wait((x) => x.t === "chunk" && x.path === f.sessionA, "first chunk", 0, 30_000);
	agent.child.stdout!.pause();
	const paused = agent.frames.length;
	await new Promise((r) => setTimeout(r, 1500));
	agent.child.stdin!.write(`${JSON.stringify({ t: "submit", id: 7, session: "/nowhere.jsonl", text: "x", deliverAs: "steer" })}\n`);
	await new Promise((r) => setTimeout(r, 500)); // the agent queues its answer
	agent.child.stdout!.resume();
	const ack = await agent.wait((x) => x.t === "ack" && x.id === 7, "ack", 0, 30_000);
	// Before the ack: at most the frame in flight, plus what the pipe and this reader buffer.
	const ahead = agent.frames.slice(paused, agent.frames.indexOf(ack)).filter((x) => x.t === "chunk").reduce((n, x) => n + Buffer.byteLength(x.data), 0);
	assert.ok(ahead < 3 << 20, `${ahead} Session bytes arrived before the ack`);
	const size = statSync(f.sessionA).size;
	await agent.wait((x) => x.t === "chunk" && x.path === f.sessionA && x.offset + Buffer.byteLength(x.data) === size, "last byte", 0, 30_000);
	assert.equal(tiled(agent.frames, f.sessionA), readFileSync(f.sessionA, "utf8"));
	assert.equal(agent.child.exitCode, null, `agent alive; stderr: ${stderr()}`);
});

test("pi remote agent: every exit names its reason on stderr", async (t) => {
	const f = fixture();
	const { agent, stderr } = startPiped(f);
	t.after(() => agent.stop());
	await agent.wait((x) => x.t === "hello", "hello");
	const exited = new Promise((r) => agent.child.on("close", r));
	agent.child.stdin!.end();
	assert.equal(await exited, 0);
	assert.match(stderr(), /remote-agent exit 0: stdin end/);
	const g = startPiped(fixture());
	await g.agent.wait((x) => x.t === "hello", "hello");
	const killed = new Promise((r) => g.agent.child.on("close", (code) => r(code)));
	g.agent.child.kill("SIGTERM");
	assert.equal(await killed, 143);
	assert.match(g.stderr(), /remote-agent exit 143: SIGTERM/);
});
