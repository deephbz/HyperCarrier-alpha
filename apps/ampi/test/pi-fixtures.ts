// Fixtures for the Pi backend tests: a fake Herdr CLI, synthetic Pi Session files, and a fake control socket.
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempHome } from "./helpers.ts";

export const AGENT = fileURLToPath(new URL("../src/pi/remote-agent.cjs", import.meta.url));

// A fake `herdr` CLI: answers list/get from a state file and records every write call.
export const FAKE_HERDR = `#!${process.execPath}
const fs = require("fs");
const path = require("path");
let argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("herdr 0.0.0-fake"); process.exit(0); }
if (argv[0] === "--session") argv = argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_HERDR_STATE, "utf8"));
const save = () => fs.writeFileSync(process.env.FAKE_HERDR_STATE, JSON.stringify(state));
const log = () => fs.appendFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify(argv) + "\\n");
const reply = (result) => console.log(JSON.stringify({ result }));
const refuse = (code, message) => { console.log(JSON.stringify({ error: { code, message } })); process.exit(1); };
const opt = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const paneOf = (id) => state.agents.find((x) => x.pane_id === id);
const paneView = (p) => ({ pane_id: p.pane_id, workspace_id: p.workspace_id, tab_id: p.tab_id });
const next = () => (state.seq = (state.seq || 0) + 1);
const [a, b, c] = argv;
const KEY_NAMES = ["alt+enter", "esc", "enter"];
if (a === "session" && b === "list") console.log(JSON.stringify({ sessions: [{ name: "default", running: true }] }));
else if (a === "workspace" && b === "list") reply({ workspaces: state.workspaces });
else if (a === "tab" && b === "list") reply({ tabs: state.tabs });
else if (a === "agent" && b === "list") reply({ agents: state.agents });
else if (a === "agent" && b === "get") {
  const agent = paneOf(c);
  if (!agent) { console.error("pane not found"); process.exit(1); }
  reply({ agent });
} else if (a === "agent" && (b === "prompt" || b === "send-keys" || b === "read")) {
  if (b !== "read") log();
  // Real Herdr accepts key names only; literal text goes through \`pane send-text\`.
  const bad = b === "send-keys" && argv.slice(3).find((k) => !KEY_NAMES.includes(k));
  if (bad) refuse("invalid_key", "unsupported key " + bad);
  // Like Pi 1.1, a started agent writes its Session file with the first message.
  const p = b === "prompt" && paneOf(c);
  if (p && p.startSession) {
    const id = p.startSession, file = path.join(state.sessionsDir, id + ".jsonl"), now = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, timestamp: now, cwd: p.cwd }) + "\\n"
      + JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: now, message: { role: "user", content: [{ type: "text", text: argv[3] }], timestamp: Date.now() } }) + "\\n");
    delete p.startSession;
    p.agent_session = { kind: "path", agent: "pi", value: file };
    save();
  }
  reply({ text: "" });
} else if (a === "pane" && b === "send-text") {
  log();
  if (!paneOf(c)) refuse("pane_not_found", "no pane " + c);
  reply({ text: "" });
} else if (a === "pane" && b === "get") {
  const p = paneOf(c);
  if (!p) refuse("pane_not_found", "no pane " + c);
  reply({ pane: paneView(p) });
} else if (a === "pane" && b === "list") {
  reply({ panes: state.agents.filter((p) => p.workspace_id === opt("--workspace")).map(paneView) });
} else if (a === "pane" && b === "split") {
  log();
  if (state.splitDelayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, state.splitDelayMs);
  Object.assign(state, JSON.parse(fs.readFileSync(process.env.FAKE_HERDR_STATE, "utf8")));
  const beside = paneOf(opt("--pane"));
  if (!beside) refuse("pane_not_found", "no pane");
  const pane_id = beside.workspace_id + ":n" + next();
  state.agents.push({ pane_id, workspace_id: beside.workspace_id, tab_id: beside.tab_id, cwd: opt("--cwd"), agent_status: "unknown", agent_session: { kind: "none" } });
  save();
  reply({ pane: { pane_id, workspace_id: beside.workspace_id, tab_id: beside.tab_id } });
} else if (a === "workspace" && b === "create") {
  log();
  const n = next(), workspace_id = "wn" + n, tab_id = workspace_id + ":t1", pane_id = workspace_id + ":p1";
  state.workspaces.push({ workspace_id, label: opt("--label") });
  state.tabs.push({ tab_id, workspace_id, label: "1" });
  state.agents.push({ pane_id, workspace_id, tab_id, cwd: opt("--cwd"), agent_status: "unknown", agent_session: { kind: "none" } });
  save();
  reply({ workspace: { workspace_id }, tab: { tab_id }, root_pane: { pane_id } });
} else if (a === "pane" && b === "rename") {
  log();
  const p = paneOf(c);
  if (!p) refuse("pane_not_found", "no pane");
  p.label = argv[3];
  save();
  reply({ pane: paneView(p) });
} else if (a === "pane" && b === "close") {
  log();
  if (!paneOf(c)) refuse("pane_not_found", "no pane");
  state.agents = state.agents.filter((p) => p.pane_id !== c);
  save();
  reply({ closed: c });
} else if (a === "agent" && b === "start") {
  log();
  const p = paneOf(opt("--pane"));
  if (!p) refuse("pane_not_found", "no pane");
  if (state.startError) refuse(state.startError, "fake start error");
  const rest = argv.slice(argv.indexOf("--") + 1);
  const at = (flag) => (rest.includes(flag) ? rest[rest.indexOf(flag) + 1] : undefined);
  // --session <path> resumes an existing file; --session-id <id> starts a Session that has no file until a message.
  const resume = at("--session");
  Object.assign(p, { name: c, terminal_title_stripped: "pi", agent_status: "idle", focused: false, agent: "pi",
    agent_session: resume ? { kind: "path", agent: "pi", value: resume } : { kind: "none" }, ...(resume ? {} : { startSession: at("--session-id") }) });
  save();
  reply({ type: "agent_started", agent: { name: c, pane_id: p.pane_id, terminal_id: "t" + p.pane_id, agent: "pi", interactive_ready: true } });
} else { console.error("unknown " + argv.join(" ")); process.exit(2); }
`;

export type Frame = Record<string, any>;

export interface Fixture {
	dir: string;
	agentDir: string;
	sessionA: string;
	sessionB: string;
	state: any;
	setState(next: any): void;
	herdrCalls(): string[][];
}

export function fixture(): Fixture {
	const dir = tempHome();
	const agentDir = join(dir, "agent");
	const sessions = join(agentDir, "sessions", "--work--");
	mkdirSync(sessions, { recursive: true });
	const sessionA = join(sessions, "a.jsonl");
	const sessionB = join(sessions, "b.jsonl");
	writeFileSync(sessionA, `${JSON.stringify({ type: "session", id: "sess-a", cwd: "/work" })}\n`);
	writeFileSync(sessionB, `${JSON.stringify({ type: "session", id: "sess-b", cwd: "/work" })}\n`);
	const bin = join(dir, "herdr");
	writeFileSync(bin, FAKE_HERDR);
	chmodSync(bin, 0o755);
	const agent = (pane: string, ws: string, tab: string, session: string, status = "idle") => ({
		pane_id: pane, workspace_id: ws, tab_id: tab, name: pane, terminal_title_stripped: `pi ${pane}`, cwd: "/work",
		agent_status: status, focused: false, agent: "pi", agent_session: { kind: "path", agent: "pi", value: session },
	});
	const f: Fixture = {
		dir,
		agentDir,
		sessionA,
		sessionB,
		get state() {
			return JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
		},
		setState(next) {
			writeFileSync(join(dir, "state.json"), JSON.stringify(next));
		},
		herdrCalls() {
			const log = join(dir, "calls.jsonl");
			return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
		},
	};
	// Herdr order is deliberately not sorted: w2 before w1, p2 before p1.
	f.setState({
		sessionsDir: sessions,
		workspaces: [{ workspace_id: "w2", label: "beta" }, { workspace_id: "w1", label: "alpha" }],
		tabs: [{ tab_id: "w1:tA", label: "main" }, { tab_id: "w1:tB", label: "spare" }, { tab_id: "w2:tC", workspace_id: "w2", label: "other" }],
		agents: [
			agent("w1:p2", "w1", "w1:tA", sessionA, "working"),
			agent("w1:p1", "w1", "w1:tA", sessionB),
			{ pane_id: "w2:p3", workspace_id: "w2", tab_id: "w2:tC", agent_status: "idle", agent_session: { kind: "none" } },
		],
	});
	return f;
}

export class Agent {
	frames: Frame[] = [];
	#waiters = new Set<() => void>();
	readonly child: ChildProcess;
	constructor(child: ChildProcess) {
		this.child = child;
		let buf = "";
		child.stdout!.setEncoding("utf8");
		child.stdout!.on("data", (d: string) => {
			buf += d;
			let i: number;
			while ((i = buf.indexOf("\n")) >= 0) {
				this.frames.push(JSON.parse(buf.slice(0, i)));
				buf = buf.slice(i + 1);
			}
			for (const w of this.#waiters) w();
		});
	}
	static start(f: Fixture, extra: Record<string, unknown> = {}): Agent {
		const cfg = { agentDir: f.agentDir, pollMs: 30, discoverMs: 150, teams: false, controlStatusMs: 300, ...extra };
		const child = spawn(process.execPath, [AGENT], {
			stdio: ["pipe", "pipe", "inherit"],
			env: {
				...process.env, HOME: f.dir, HERDR_BIN: join(f.dir, "herdr"), HCM_CFG: Buffer.from(JSON.stringify(cfg)).toString("base64"),
				FAKE_HERDR_STATE: join(f.dir, "state.json"), FAKE_HERDR_LOG: join(f.dir, "calls.jsonl"),
			},
		});
		return new Agent(child);
	}
	send(msg: Frame) {
		this.child.stdin!.write(`${JSON.stringify(msg)}\n`);
	}
	/** Resolves with the first frame (at or after `from`) that matches. */
	wait(pred: (f: Frame) => boolean, what: string, from = 0, ms = 5000): Promise<Frame> {
		return new Promise((resolve, reject) => {
			const check = () => {
				const hit = this.frames.slice(from).find(pred);
				if (hit) { this.#waiters.delete(check); clearTimeout(timer); resolve(hit); }
			};
			const timer = setTimeout(() => { this.#waiters.delete(check); reject(new Error(`timed out waiting for ${what}`)); }, ms);
			this.#waiters.add(check);
			check();
		});
	}
	async request(msg: Frame): Promise<Frame> {
		const from = this.frames.length;
		this.send(msg);
		return this.wait((f) => f.t === "ack" && f.id === msg.id, `ack ${msg.id}`, from, 8000);
	}
	stop() {
		this.child.kill();
	}
}

// A tiny hc-control server (contract section 1) plus its descriptor.
// With `queue`, it tracks submissions as pi-hc-control does: submit queues one, abort returns all to the editor.
export async function control(f: Fixture, session: string, opts: { nonce?: string; descriptorNonce?: string; idle?: boolean; queue?: boolean } = {}) {
	const dir = join(f.agentDir, "hc-control");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const nonce = opts.nonce ?? "n-live";
	const sessionId = session.endsWith("a.jsonl") ? "sess-a" : "sess-b";
	const socket = join(dir, `${sessionId}.sock`);
	const requests: Frame[] = [];
	const submissions: { submission: string; deliverAs: string; state: string; at: number; text: string }[] = [];
	const server: Server = createServer((c) => {
		let buf = "";
		c.setEncoding("utf8");
		c.on("data", (d: string) => {
			buf += d;
			let i: number;
			while ((i = buf.indexOf("\n")) >= 0) {
				const req = JSON.parse(buf.slice(0, i));
				buf = buf.slice(i + 1);
				requests.push(req);
				const reply =
					req.op === "status" ? { id: req.id, ok: true, value: { sessionId, sessionFile: session, nonce, idle: opts.idle ?? false, compacting: false, pending: { steer: 0, followUp: 1 }, ...(opts.queue ? { submissions } : {}) } }
					: req.op === "submit" && opts.queue ? (() => {
						const record = { submission: `sub-${submissions.length + 1}`, deliverAs: req.deliverAs, state: "queued", at: Date.now(), text: req.text };
						submissions.push(record);
						return { id: req.id, ok: true, evidence: "admitted", submission: record.submission };
					})()
					: req.op === "submit" ? { id: req.id, ok: true, evidence: "admitted", entryId: "e-42" }
					: req.op === "abort" && opts.queue ? (() => {
						const queued = submissions.filter((r) => r.state === "queued");
						for (const r of queued) r.state = "returned";
						return { id: req.id, ok: true, evidence: "aborted", submissions: queued };
					})()
					: req.op === "abort" ? { id: req.id, ok: true, evidence: "aborted" }
					: { id: req.id, ok: false, error: { code: "bad_op", message: "?" } };
				c.write(`${JSON.stringify(reply)}\n`);
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(socket, resolve));
	writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify({
		schema: "hc-control/1", sessionId, sessionFile: session, pid: process.pid, nonce: opts.descriptorNonce ?? nonce, startedAt: Date.now(), version: "test",
	}));
	return { requests, submissions, close: () => server.close() };
}
