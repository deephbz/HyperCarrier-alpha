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
import { control, fixture, replaceFile } from "./pi-fixtures.ts";
import { PI_VIEWS } from "../src/pi/views/index.ts";
import { BOOTSTRAP, PiHost, agentLaunch, modelLimits } from "../src/pi/host.ts";
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
		{ hosts: [{ id: "devbox", label: "devbox", kind: "pi-local", cacheDir: join(f.dir, "cache"), remoteNode: "/bin/false", recentMs: Number.MAX_SAFE_INTEGER }] },
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
	replaceFile(join(dir, `${sessionId}.json`), JSON.stringify({ schema: "hc-control/1", sessionId, sessionFile, pid, nonce: `n-${sessionId}`, startedAt: iso(9), version: "test" }));
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

test("pi host: a slash command goes to a control that serves it or as keys to the pane, never as a message", async (t) => {
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
	assert.ok(!f.herdrCalls().some((c) => c.join(" ").includes("/model")), "a command with a live control reached a pane as keys");
	assert.equal(ctl.requests.filter((r) => r.op === "submit").length, 0, "no command reached Pi as a message");
});

/** Pi's editor as the pane shows it: its text between two full-width rules, then the footer. */
const piScreen = (editor: string, top = "─".repeat(40)) => ["assistant text", "─".repeat(40), top, editor, "─".repeat(40), "~/work  p/m1"].join("\n");

/** sess-a has a live control that served its list; sess-b has none. */
async function noControl(t: any) {
	const { f, browser } = await setup(t);
	const ctl = await control(f, f.sessionA, { commands: true });
	t.after(() => ctl.close());
	const threads = browser.sub("devbox", { kind: "threads" });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.control === true && v.threads["pi:sess-b"]?.live === true);
	await browser.req("devbox", "thread.commands", { threadId: "pi:sess-a" });
	const setPane = (pane: string, fields: Record<string, unknown>) => {
		const state = f.state;
		Object.assign(state.agents.find((a: any) => a.pane_id === pane), fields);
		f.setState(state);
	};
	// Every Herdr write that carries slash text: what reached a pane.
	const typed = () => f.herdrCalls().filter((c) => c.some((a) => a.startsWith("/")));
	const command = (threadId: string, name: string, args?: string) => browser.req("devbox", "thread.command", { threadId, name, ...(args ? { args } : {}) });
	return { f, browser, ctl, threads, setPane, typed, command };
}

test("pi host: with no control a command is typed with Enter, even while Pi works, and carries no receipt", async (t) => {
	const { f, browser, ctl, setPane, typed, command } = await noControl(t);
	await assert.rejects(browser.req("devbox", "thread.commands", { threadId: "pi:sess-b" }), (e: any) => e.code === "no_control");
	// Enter runs a built-in even while Pi streams; Alt+Enter would queue the text as a message. While Pi works, its
	// status sits in the editor's top border.
	setPane("w1:p1", { agent_status: "working", screen: piScreen("", `── ⠋ Working ${"─".repeat(27)}`) });
	const ack = await browser.req("devbox", "thread.command", { threadId: "pi:sess-b", name: "model", args: "m2", key: "k-2", whenBusy: "followUp" });
	assert.ok(!f.herdrCalls().some((c) => c.includes("alt+enter")), "a command is never queued with Alt+Enter");
	assert.deepEqual(typed(), [["agent", "prompt", "w1:p1", "/model m2"]]);
	assert.deepEqual([ack.via, ack.disposition, ack.evidence], ["keys", "dispatched", "sent"], "keys carry no receipt");
	// A name from this Session's last command list stays known after its control goes away. The Host can still show
	// the control as live; it passes the pane anyway, and the agent finds no control when it sends.
	setPane("w1:p2", { agent_status: "idle", screen: piScreen("") });
	await ctl.close();
	await command("pi:sess-a", "review", "now");
	assert.deepEqual(typed().at(-1), ["agent", "prompt", "w1:p2", "/review now"]);
	assert.equal(ctl.requests.filter((r) => r.op === "submit").length, 0, "no command reached Pi as a message");
});

test("pi host: with no control a command is typed only into an empty editor", async (t) => {
	const { setPane, typed, command } = await noControl(t);
	// Leftover text would merge with the keys into one message.
	setPane("w1:p1", { screen: piScreen("half a thought") });
	await assert.rejects(command("pi:sess-b", "model", "m3"), (e: any) => e.code === "editor_not_empty");
	// More than one editor line and a dialog also refuse before any keys.
	setPane("w1:p1", { screen: piScreen("half a thought\nsecond line") });
	await assert.rejects(command("pi:sess-b", "model", "m3"), (e: any) => e.code === "editor_not_empty");
	setPane("w1:p1", { screen: piScreen(""), agent_status: "blocked" });
	await assert.rejects(command("pi:sess-b", "model", "m3"), (e: any) => e.code === "agent_blocked");
	// A screen that does not show Pi's editor is not proof of an empty one.
	setPane("w1:p1", { screen: "", agent_status: "idle" });
	await assert.rejects(command("pi:sess-b", "model", "m3"), (e: any) => e.code === "editor_not_empty");
	// A scroll label in the top border means hidden lines above an empty-looking one.
	setPane("w1:p1", { screen: piScreen("", `─── ↑ 2 more ${"─".repeat(27)}`) });
	await assert.rejects(command("pi:sess-b", "model", "m3"), (e: any) => e.code === "editor_not_empty");
	assert.deepEqual(typed(), [], "no command reached a pane");
});

/**
 * Synthetic copies of real `herdr agent read <pane> --source visible` output from Pi 1.4.0 in Herdr 0.9.5: startup
 * header, a notice box drawn with rules, the editor between two full-width borders, the footer. While Pi works, its
 * status sits in the top border; a scrolled editor labels its hidden lines in a border.
 */
const W = 80;
const RULE = "─".repeat(W);
const label = (text: string) => {
	const start = Math.floor((W - text.length) / 2);
	return "─".repeat(start) + text + "─".repeat(W - start - text.length);
};
const WORKING = `── ⠇ Working ${"─".repeat(W - 13)}`;
const realScreen = (top: string, editor: string[], bottom = RULE) => [
	"", " ▀▀█  v1.4.0", " █▀ █ escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more", "",
	RULE, " Package Updates Available", " - example-package", RULE, "", "89", "",
	top, ...editor, bottom, "~/work • probe", `↑2 ↓801 W2.4k $0.028 0.3%/1.0M${" ".repeat(30)}(p) p/m1 • medium`, "",
].join("\n");
const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`);
const SCREENS: [string, string, boolean][] = [
	["idle, empty", realScreen(RULE, [""]), true],
	["working, empty", realScreen(WORKING, [""]), true],
	["idle, draft", realScreen(RULE, ["half a thought"]), false],
	["working, draft", realScreen(WORKING, ["draft while working"]), false],
	["multi-line draft", realScreen(RULE, ["half a thought", "second line"]), false],
	["scrolled, lines above", realScreen(label(" ↑ 6 more "), lines(7, 18)), false],
	["scrolled, lines below", realScreen(RULE, lines(1, 12), label(" ↓ 6 more ")), false],
];

test("pi host: the editor check reads every real Pi screen shape", async (t) => {
	const { setPane, typed, command } = await noControl(t);
	for (const [name, screen, empty] of SCREENS) {
		setPane("w1:p1", { agent_status: name.startsWith("working") ? "working" : "idle", screen });
		const before = typed().length;
		if (empty) await command("pi:sess-b", "model", "m2");
		else await assert.rejects(command("pi:sess-b", "model", "m2"), (e: any) => e.code === "editor_not_empty", name);
		assert.equal(typed().length - before, empty ? 1 : 0, name);
	}
});

test("pi host: with no control a message is typed only into an empty editor, and slash text never as a message", async (t) => {
	const { f, browser, setPane } = await noControl(t);
	const submit = (content: string, asText?: true) => browser.req("devbox", "thread.submit", { threadId: "pi:sess-b", content, whenBusy: "steer", ...(asText ? { asText } : {}) });
	const reached = (text: string) => f.herdrCalls().filter((c) => c.some((a) => a.includes(text)));
	// Leftover text and the typed message would merge into one message.
	setPane("w1:p1", { screen: piScreen("half a thought") });
	await assert.rejects(submit("hello"), (e: any) => e.code === "editor_not_empty");
	assert.deepEqual(reached("hello"), [], "a message reached a pane with leftover text");
	// Keys have no way to send slash text as a message: Pi would run it.
	setPane("w1:p1", { screen: piScreen("") });
	await assert.rejects(submit("/model x", true), (e: any) => e.code === "needs_control" && /no live control/.test(e.message));
	assert.deepEqual(reached("/model x"), [], "slash text reached a pane as a message");
	await submit("hello");
	assert.deepEqual(reached("hello"), [["agent", "prompt", "w1:p1", "hello"]]);
});

test("pi host: slash text is a message only when the page marks it, before any route", async (t) => {
	const { f, browser } = await setup(t);
	const ctl = await control(f, f.sessionA, { commands: true });
	t.after(() => ctl.close());
	const threads = browser.sub("devbox", { kind: "threads" });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.control === true && v.threads["pi:sess-b"]?.live === true);
	const submit = (threadId: string, asText?: true) => browser.req("devbox", "thread.submit", { threadId, content: "/model x", whenBusy: "steer", ...(asText ? { asText } : {}) });
	const before = f.herdrCalls().length;
	for (const threadId of ["pi:sess-a", "pi:sess-b"])
		await assert.rejects(submit(threadId), (e: any) => e.code === "unsupported" && e.message === "This page is older than the hub. Reload it.");
	assert.equal(ctl.requests.filter((r) => r.op === "submit").length, 0, "an unmarked slash submit reached the control");
	assert.equal(f.herdrCalls().length, before, "an unmarked slash submit reached Herdr");
	await submit("pi:sess-a", true);
	assert.deepEqual(ctl.requests.filter((r) => r.op === "submit").map((r) => r.text), ["/model x"], "a marked slash submit goes as text");
});

test("pi host: with no control a name Pi runs only in its pane is refused as with a control", async (t) => {
	const { typed, command } = await noControl(t);
	for (const name of ["quit", "new"])
		await assert.rejects(command("pi:sess-b", name), (e: any) => e.code === "unsupported_command" && e.message === `/${name} works only in the Pi pane.`);
	assert.deepEqual(typed(), [], "a pane-only command reached a pane");
});

test("pi host: a new control endpoint for the Session drops the command names the old one listed", async (t) => {
	const { f, browser, ctl, threads, typed, command } = await noControl(t);
	await ctl.close();
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.control !== true);
	const next = await control(f, f.sessionA, { commands: true, nonce: "n-next" });
	t.after(() => next.close());
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.control === true);
	await next.close();
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.control !== true);
	await assert.rejects(command("pi:sess-a", "review"), (e: any) => e.code === "unknown_command");
	assert.deepEqual(typed(), []);
});

test("pi host: with no control a name Pi does not run is refused before any keys", async (t) => {
	const { f, setPane, typed, command } = await noControl(t);
	setPane("w1:p1", { screen: piScreen("") });
	const before = f.herdrCalls().length;
	await assert.rejects(command("pi:sess-b", "modle", "m3"), (e: any) => e.code === "unknown_command");
	// A name seen in another Session's list is not one this Pi runs.
	await assert.rejects(command("pi:sess-b", "review"), (e: any) => e.code === "unknown_command");
	assert.equal(f.herdrCalls().length, before, "an unknown name reached the pane");
	assert.deepEqual(typed(), []);
});

test("pi host: the agent splits Pi's built-ins exactly as pi-hc-control does", () => {
	const names = (source: string, list: string) => [...new RegExp(`const ${list} = \\[([\\s\\S]*?)\\];`).exec(source)![1]!.matchAll(/\[?["']([a-z-]+)["']/g)].map((m) => m[1]);
	const control = readFileSync(new URL("../../../packages/pi-hc-control/src/control.mjs", import.meta.url), "utf8");
	const builtins = [...new RegExp("const BUILTINS = \\[([\\s\\S]*?)\\n\\];").exec(control)![1]!.matchAll(/^\s*\["([a-z-]+)"/gm)].map((m) => m[1]);
	const agent = readFileSync(new URL("../src/pi/remote-agent.cjs", import.meta.url), "utf8");
	assert.deepEqual(names(agent, "PI_BUILTINS"), builtins);
	assert.deepEqual(names(agent, "PANE_ONLY"), names(control, "PANE_ONLY"));
});

/** An old remote agent: the same agent with its hello stripped of controlOps. */
function oldAgent() {
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
	return wrapper;
}

test("pi host: an old control or an old remote agent answers commands_unsupported without sending the command", async (t) => {
	const wrapper = oldAgent();
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
		// A Session without a control: an old agent cannot type a command into the pane, so it is too old at once.
		await browser.until<any>(threads, (v) => v.threads["pi:sess-b"]?.live === true);
		const old = label === "old remote agent";
		await assert.rejects(browser.req("devbox", "thread.commands", { threadId: "pi:sess-b" }), (e: any) => e.code === (old ? "commands_unsupported" : "no_control"), `${label}: a list without a control`);
		const asked = Date.now();
		if (old) await assert.rejects(browser.req("devbox", "thread.command", { threadId: "pi:sess-b", name: "model", args: "m2" }), /too old/, `${label}: a command without a control`);
		assert.ok(Date.now() - asked < 2000, `${label}: answered in ${Date.now() - asked} ms`);
		assert.ok(!f.herdrCalls().some((c) => c.some((a) => a.startsWith("/model"))), `${label}: no command reached a pane`);
	}
});

const PNG = { data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==", mimeType: "image/png" };

test("pi host: images go only to a control that takes them; keys, an older tier, or too large a set refuse at once", async (t) => {
	const { f, browser } = await setup(t);
	const ctl = await control(f, f.sessionA, { images: true });
	t.after(() => ctl.close());
	const threads = browser.sub("devbox", { kind: "threads" });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.control === true && v.threads["pi:sess-b"]?.live === true);
	// The summary offers images exactly where a send can succeed.
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.images?.count === 8 && v.threads["pi:sess-b"]?.images === undefined);
	const ack = await browser.req("devbox", "thread.submit", { threadId: "pi:sess-a", content: "see this", images: [PNG], whenBusy: "steer" });
	assert.equal(ack.evidence, "admitted");
	// An image alone is a message too.
	await browser.req("devbox", "thread.submit", { threadId: "pi:sess-a", content: "", images: [PNG, PNG], whenBusy: "followUp" });
	assert.deepEqual(ctl.requests.filter((r) => r.op === "submit").map(({ id: _id, ...r }) => r), [
		{ op: "submit", text: "see this", deliverAs: "steer", images: [PNG] },
		{ op: "submit", text: "", deliverAs: "followUp", images: [PNG, PNG] },
	]);
	const big = { data: "A".repeat(6 * 1024 * 1024 + 4), mimeType: "image/png" };
	await assert.rejects(browser.req("devbox", "thread.submit", { threadId: "pi:sess-a", content: "x", images: [big], whenBusy: "steer" }), (e: any) => e.code === "too_large");
	// A pane with no control: keys cannot type an image, and the text must not go without it.
	await assert.rejects(browser.req("devbox", "thread.submit", { threadId: "pi:sess-b", content: "see this", images: [PNG], whenBusy: "steer" }), (e: any) => e.code === "no_control");
	assert.ok(!f.herdrCalls().some((c) => c.includes("see this")), "no text reached a pane as keys");
	assert.equal(ctl.requests.filter((r) => r.op === "submit").length, 2);
});

test("pi host: an old control or an old remote agent answers images_unsupported without sending the text", async (t) => {
	for (const [label, host, images, message] of [["old remote agent", { remoteNode: oldAgent() }, true, /AmPi agent .* too old to send images/], ["old control", {}, false, /update pi-hc-control/]] as const) {
		const { f, browser } = await setup(t, host);
		const ctl = await control(f, f.sessionA, { images });
		t.after(() => ctl.close());
		const threads = browser.sub("devbox", { kind: "threads" });
		await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.control === true);
		assert.equal((await browser.until<any>(threads, (v) => v.threads["pi:sess-a"])).threads["pi:sess-a"].images, undefined, `${label}: the summary offers images`);
		await assert.rejects(browser.req("devbox", "thread.submit", { threadId: "pi:sess-a", content: "see this", images: [PNG], whenBusy: "steer" }), (e: any) => e.code === "images_unsupported" && message.test(e.message), label);
		assert.deepEqual(ctl.requests.filter((r) => r.op !== "status"), [], `${label}: nothing reached the control`);
	}
});

test("pi host: a model_change entry names the Session's model before any turn uses it (A27 /model)", async (t) => {
	const { f, browser } = await setup(t);
	const threads = browser.sub("devbox", { kind: "threads" });
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.model);
	appendFileSync(f.sessionA, line({ type: "model_change", id: "mc1", parentId: "r1", timestamp: new Date().toISOString(), provider: "p", modelId: "m2" }));
	await browser.until<any>(threads, (v) => v.threads["pi:sess-a"]?.model === "p/m2");
});

const BOOT = `eval(Buffer.from('${BOOTSTRAP}','base64').toString())`;

test("agent launch: a local Host runs the hub's own Node without a shell; a remote Host keeps its SSH login-shell command", () => {
	assert.deepEqual(agentLaunch({ id: "devbox", label: "devbox", kind: "pi-local" }), { command: process.execPath, args: ["-e", BOOT] });
	assert.deepEqual(agentLaunch({ id: "devbox", label: "devbox", kind: "pi-local", remoteNode: "/opt/my node/bin/node" }), { command: "/opt/my node/bin/node", args: ["-e", BOOT] }, "a path with spaces is one argument");
	const ssh = ["-T", "-C", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];
	assert.deepEqual(agentLaunch({ id: "far", label: "far", kind: "pi-ssh" }), { command: "ssh", args: [...ssh, "--", "far", `sh -lc ${JSON.stringify(`exec node -e "${BOOT}"`)}`] });
	assert.deepEqual(agentLaunch({ id: "far", label: "far", kind: "pi-ssh", target: "user@far", sshArgs: ["-p", "2222"], remoteNode: "/opt/node/bin/node" }), {
		command: "ssh",
		args: [...ssh, "-p", "2222", "--", "user@far", `sh -lc ${JSON.stringify(`exec /opt/node/bin/node -e "${BOOT}"`)}`],
	});
});

/** A local PiHost on the fixture's fake herdr; resolves once its agent says hello. */
async function localAgent(t: { after: (fn: () => unknown) => void }, f: ReturnType<typeof fixture>, extra: { remoteNode?: string; env?: Record<string, string> }) {
	const host = new PiHost({
		id: "devbox", label: "devbox", kind: "pi-local", cacheDir: join(f.dir, "cache"), remoteNode: extra.remoteNode,
		agentConfig: { agentDir: f.agentDir, pollMs: 30, discoverMs: 150, teams: false },
		env: { HOME: f.dir, HERDR_BIN: join(f.dir, "herdr"), FAKE_HERDR_STATE: join(f.dir, "state.json"), FAKE_HERDR_LOG: join(f.dir, "calls.jsonl"), ...extra.env },
	});
	t.after(() => host.stop());
	host.start();
	const end = Date.now() + 10_000;
	while (host.state.status !== "connected" && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal(host.state.status, "connected", `agent did not connect: ${JSON.stringify(host.state)}`);
	return host;
}

test("agent launch: a local PATH whose node fails still starts the agent on the hub's executable", async (t) => {
	const f = fixture();
	const bin = join(f.dir, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "node"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(join(f.dir, "path-node.log"))}\nexit 7\n`);
	chmodSync(join(bin, "node"), 0o755);
	const host = await localAgent(t, f, { env: { PATH: `${bin}:${process.env.PATH}` } });
	assert.equal(existsSync(join(f.dir, "path-node.log")), false, "the PATH node never ran");
	const command = spawnSync("ps", ["-o", "command=", "-p", String(host.state.node?.pid)], { encoding: "utf8" }).stdout.trim();
	assert.ok(command.startsWith(`${process.execPath} -e `), `the agent runs on the hub's Node: ${command}`);
});

test("agent launch: a local remoteNode with spaces gets -e and the bootstrap as arguments, the Host env, and the agent on stdin", async (t) => {
	const f = fixture();
	const dir = join(f.dir, "my node");
	mkdirSync(dir);
	const wrapper = join(dir, "node wrapper");
	writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$AMPI_PROBE" "$#" "$1" "$2" > ${JSON.stringify(join(f.dir, "args.log"))}\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
	chmodSync(wrapper, 0o755);
	await localAgent(t, f, { remoteNode: wrapper, env: { AMPI_PROBE: "from host env" } });
	assert.deepEqual(readFileSync(join(f.dir, "args.log"), "utf8").split("\n").slice(0, 4), ["from host env", "2", "-e", BOOT]);
});
