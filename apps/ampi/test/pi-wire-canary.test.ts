import "./bound.ts";
// Wire-boundary canaries (docs/wire-boundary.md, Proof). A fixture Session carries unique sentinel values in the native
// fields that must stay in the hub. The test drives every op and topic a browser can reach and greps every encoded
// frame the browser receives. Sentinels, not key names: `model` and `durationMs` appear legitimately in Arc and tool views.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Hub } from "../src/hub/hub.ts";
import { Browser } from "./helpers.ts";
import { fixture, type Fixture } from "./pi-fixtures.ts";
import { TOKEN, iso, line } from "./pi-host-fixtures.ts";
import type { HubOps, OpName, Ops, PiTopicValues, Topic, ViewName, ViewTopic } from "../src/shared/protocol.ts";

/** Each sentinel and the pattern that finds it in an encoded frame. Numbers match only as whole JSON numbers. */
const num = (n: string) => new RegExp(`(?<![\\d.])${n.replace(".", "\\.")}(?![\\d])`);
const SENTINELS = {
	model: /zqx-model-7731/,
	provider: /zqxprov4419/,
	responseId: /zqx-resp-5527/,
	thinkingSignature: /zqx-sig-8812/,
	parentId: /zqx-parent-3390/,
	"usage.input": num("731903"),
	"usage.output": num("614327"),
	"usage.cacheRead": num("528149"),
	"usage.cacheWrite": num("439771"),
	"usage.totalTokens": num("2314150"),
	"cost.total": num("0.0439771"),
	error: /zqx-error-6604/,
} as const;
type Sentinel = keyof typeof SENTINELS;

const CANARY = "sess-canary", BAD = "sess-canary-bad";
const THREAD = `pi:${CANARY}`, BAD_THREAD = `pi:${BAD}`;

/**
 * The canary Session: one assistant turn carries every sentinel; a later turn has ordinary billing, so Session-level
 * usage views (latest model, summed cost) legitimately differ from every sentinel. Returns the native bytes written.
 */
function writeCanary(f: Fixture): string {
	const dir = join(f.agentDir, "sessions", "--canary--");
	mkdirSync(dir, { recursive: true });
	const canary =
		line({ type: "session", version: 3, id: CANARY, timestamp: iso(0), cwd: "/work/canary" }) +
			line({ type: "message", id: "cu1", parentId: "zqx-parent-3390", timestamp: iso(1), message: { role: "user", content: [{ type: "text", text: "Canary question" }], timestamp: Date.parse(iso(1)) } }) +
			line({
				type: "message",
				id: "ca1",
				parentId: "cu1",
				timestamp: iso(2),
				message: {
					role: "assistant",
					model: "zqx-model-7731",
					provider: "zqxprov4419",
					api: "anthropic-messages",
					responseId: "zqx-resp-5527",
					stopReason: "toolUse",
					usage: { input: 731903, output: 614327, cacheRead: 528149, cacheWrite: 439771, totalTokens: 2314150, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.0439771 } },
					timestamp: Date.parse(iso(2)),
					content: [
						{ type: "thinking", thinking: "Canary thinking.", thinkingSignature: "zqx-sig-8812" },
						{ type: "text", text: "Canary answer one." },
						{ type: "toolCall", id: "call-ca1", name: "bash", arguments: { command: "ls" } },
					],
				},
			}) +
			line({ type: "message", id: "cr1", parentId: "ca1", timestamp: iso(3), message: { role: "toolResult", toolCallId: "call-ca1", toolName: "bash", content: [{ type: "text", text: "a.txt" }], details: { durationMs: 12 }, isError: false, timestamp: Date.parse(iso(3)) } }) +
			line({
				type: "message",
				id: "ca2",
				parentId: "cr1",
				timestamp: iso(4),
				message: { role: "assistant", model: "model-x", provider: "prov", stopReason: "stop", usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, cost: { total: 0.25 } }, timestamp: Date.parse(iso(4)), content: [{ type: "text", text: "Canary answer two." }] },
			});
	writeFileSync(join(dir, "canary.jsonl"), canary);
	// The error sentinel: a line the reader cannot parse. No frame may echo its bytes.
	const bad = join(f.agentDir, "sessions", "--canary-bad--");
	mkdirSync(bad, { recursive: true });
	const broken =
		line({ type: "session", version: 3, id: BAD, timestamp: iso(0), cwd: "/work/canary-bad" }) +
			line({ type: "message", id: "bu1", parentId: null, timestamp: iso(1), message: { role: "user", content: [{ type: "text", text: "Canary bad question" }], timestamp: Date.parse(iso(1)) } }) +
			`{"type":"message","id":"bx1","parentId":"bu1","note":"zqx-error-6604",\n` +
			line({ type: "message", id: "bu2", parentId: "bu1", timestamp: iso(3), message: { role: "user", content: [{ type: "text", text: "Canary bad after" }], timestamp: Date.parse(iso(3)) } });
	writeFileSync(join(bad, "bad.jsonl"), broken);
	return canary + broken;
}

/** One hub with one Pi Host over `f`, as `setup` in pi-host-fixtures builds it, so a test can restart it on the same cache. */
async function startHub(f: Fixture) {
	const hub = new Hub(
		{
			hosts: [
				{
					id: "devbox",
					label: "devbox",
					kind: "pi-local",
					cacheDir: join(f.dir, "cache"),
					// The fixture Sessions date from 2026-01-01; without this window the Host may evict them before the test opens them.
					recentMs: Number.MAX_SAFE_INTEGER,
					agentConfig: { agentDir: f.agentDir, pollMs: 30, discoverMs: 150, teams: false, controlStatusMs: 300 },
					askCommand: [process.execPath, "-e", "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(s.length+':'+s.split('\\n')[0]))"],
					env: { HOME: f.dir, HERDR_BIN: join(f.dir, "herdr"), FAKE_HERDR_STATE: join(f.dir, "state.json"), FAKE_HERDR_LOG: join(f.dir, "calls.jsonl") },
				},
			],
			backend: "pi",
		},
		{ token: TOKEN },
	);
	const port = await hub.listen(0);
	const browser = await Browser.open(port, undefined, `ampi_k_${port}=${TOKEN}`);
	const tap = tapFrames(browser);
	return { hub, browser, tap, close: async () => { browser.ws.close(); await hub.close(); } };
}

/** Records every encoded frame the browser receives, named by the op or topic that caused it. */
function tapFrames(browser: Browser) {
	const names = new Map<string, string>(), frames: { source: string; text: string }[] = [];
	const topicName = (t: any) => (t.kind === "view" ? `view ${t.view}${t.threadId ? ` (${t.threadId})` : ""}` : `${t.kind}${t.threadId ? ` (${t.threadId})` : ""}`);
	const send = browser.ws.send.bind(browser.ws) as (data: string) => void;
	(browser.ws as any).send = (data: string) => {
		const m = JSON.parse(String(data));
		if (m.t === "req") names.set(`res:${m.id}`, `op ${m.op}`);
		if (m.t === "hub") names.set(`res:${m.id}`, `hub op ${m.op}`);
		if (m.t === "sub") names.set(`sid:${m.sid}`, `topic ${topicName(m.topic)}`);
		send(data);
	};
	browser.ws.on("message", (data) => {
		const text = String(data), m = JSON.parse(text);
		const source = m.t === "res" ? names.get(`res:${m.id}`) : "sid" in m ? names.get(`sid:${m.sid}`) : m.t === "hosts" ? "hosts frame" : undefined;
		frames.push({ source: source ?? `frame ${m.t}`, text });
	});
	return {
		frames,
		/** Every `<source> ← <sentinel>` pair found so far. */
		leaks(only: readonly Sentinel[] = Object.keys(SENTINELS) as Sentinel[]): string[] {
			const found = new Set<string>();
			for (const { source, text } of frames) for (const name of only) if (SENTINELS[name].test(text)) found.add(`${source} ← ${name}`);
			return [...found].sort();
		},
	};
}

/** Waits for the Host, then for both canary Sessions in its list; returns the subscribed canary thread. */
async function openCanary(browser: Browser): Promise<number> {
	await browser.when(() => browser.hosts.some((h) => h.id === "devbox" && h.status === "connected"), 10_000, "Pi Host connected");
	const threads = browser.sub("devbox", { kind: "threads" });
	await browser.until<any>(threads, (v) => v.threads[THREAD] && v.threads[BAD_THREAD], 15_000);
	const sid = browser.sub("devbox", { kind: "thread", threadId: THREAD });
	await browser.until<any>(sid, (v) => v.entries?.length >= 4, 15_000);
	return sid;
}

const settle = (ms: number) => new Promise((done) => setTimeout(done, ms));
const bounded = <T>(p: Promise<T>, ms: number) => Promise.race([p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: String(e?.message ?? e) })), settle(ms).then(() => ({ ok: false, e: "no answer" }))]);

/** Drives every topic and op once against the canary Sessions and returns the leak list. Shared by the tests below. */
let scan: Promise<{ leaks: string[]; outcomes: Record<string, string>; sources: string[] }> | undefined;
function scanOnce() {
	return (scan ??= (async () => {
		const f = fixture();
		writeFileSync(f.sessionA, line({ type: "session", version: 3, id: "sess-a", timestamp: iso(0), cwd: "/work" }));
		const native = writeCanary(f);
		// The scanner can see each sentinel: every pattern matches the native bytes.
		const unseen = (Object.keys(SENTINELS) as Sentinel[]).filter((name) => !SENTINELS[name].test(native));
		assert.deepEqual(unseen, [], "sentinels missing from the fixture");
		const { browser, tap, close } = await startHub(f);
		try {
			await openCanary(browser);
			// The registry keys both tables: a new op, view or topic kind fails the typecheck until it is scanned here.
			const topicTable: { [N in ViewName]: ViewTopic<N>[] } & { [K in keyof PiTopicValues]: Extract<Topic, { kind: K }>[] } = {
				threads: [], // openCanary subscribed it, and the canary thread
				node: [{ kind: "node" }],
				thread: [{ kind: "thread", threadId: BAD_THREAD }],
				rarebit: [{ kind: "view", view: "rarebit", threadId: THREAD }],
				team: [{ kind: "view", view: "team", threadId: THREAD }],
				"cos.timeline": [{ kind: "view", view: "cos.timeline" }],
				"cos.arc": [{ kind: "view", view: "cos.arc" }, { kind: "view", view: "cos.arc", threadId: THREAD }],
			};
			const topics: Topic[] = Object.values(topicTable).flat();
			const sids = topics.map((topic) => browser.sub("devbox", topic));
			await browser.until<any>(sids[topics.indexOf(topicTable.thread[0]!)]!, (v) => v.entries?.length >= 2, 15_000);
			const opTable: { [K in OpName]: Ops[K]["args"][] } = {
				"sessions.search": [{ query: "Canary" }],
				"thread.find": [{ threadId: THREAD, query: "Canary" }],
                "thread.outline": [{threadId: THREAD}],
				"thread.history": [{ threadId: THREAD }, { threadId: BAD_THREAD }],
				"thread.entry": [...["cu1", "ca1", "cr1", "ca2"].map((entry) => ({ threadId: THREAD, entry })), ...["bu1", "bx1", "bu2"].map((entry) => ({ threadId: BAD_THREAD, entry }))],
				"prompts.list": [{}],
				"models.list": [{}],
				"view.cos.timeline.locate": [{ threadId: THREAD, at: Date.parse(iso(2)) }],

				"view.rarebit.ask": [{ threadId: THREAD, question: "What happened?" }],
				"view.cos.arc.build": [{ threadId: THREAD }],
				// Resume first, so the later control ops reach a pane.
				"thread.resume": [{ threadId: THREAD, requestId: randomUUID(), place: { workspace: "new" } }],
				"thread.submit": [{ threadId: THREAD, content: "Canary follow-up" }],
				"thread.abort": [{ threadId: THREAD }],
				"thread.withdraw": [{ threadId: THREAD, submissionId: "canary-none" }],
				"thread.commands": [{ threadId: THREAD }],
				"thread.command": [{ threadId: THREAD, name: "model", args: "canary" }],
				"thread.close": [{ threadId: THREAD }],
				"thread.create": [{ cwd: "/work/canary", place: { workspace: "new" }, requestId: randomUUID() }],
			};
			const ops = Object.entries(opTable).flatMap(([op, list]) => list.map((args): [string, unknown] => [op, args]));
			const outcomes: Record<string, string> = {};
			for (const [op, args] of ops) {
				const r: any = await bounded(browser.req("devbox", op, args), 8000);
				outcomes[`${op} ${JSON.stringify(args).slice(0, 60)}`] = r.ok ? "ok" : `error: ${r.e.slice(0, 80)}`;
			}
			let hubId = 900_000;
			const hubTable: { [K in keyof HubOps]: HubOps[K]["args"] } = { "hosts.reconnect": { id: "devbox" }, "hosts.add": { target: "not a host" }, "hosts.remove": { id: "devbox" } };
			for (const [op, args] of Object.entries(hubTable)) {
				browser.ws.send(JSON.stringify({ t: "hub", id: hubId++, op, args }));
				outcomes[`hub ${op}`] = "sent";
			}
			// Late frames: Arc builds, recaps and topic ops that follow the op results.
			await settle(2000);
			return { leaks: tap.leaks(), outcomes, sources: [...new Set(tap.frames.map((x) => x.source))].sort() };
		} finally {
			await close();
		}
	})());
}

test("wire canary: no frame carries any native-field sentinel", async () => {
	const { leaks, outcomes, sources } = await scanOnce();
	assert.deepEqual(leaks, [], `leaks: ${leaks.join("; ")} · sources ${sources.join(", ")} · ops ${JSON.stringify(outcomes)}`);
	// Every topic and op answered: a source that never sent a frame was not scanned.
	assert.equal(sources.length, 31, `scanned sources: ${sources.join(", ")}`);
});

/** The pre-bump DERIVATION_VERSION: every index row written by a build before A24 step 5 carries it. */
const PRE_BUMP_VERSION = 5;
const OLD = { model: "zqx-old-model-1187", usage: { input: 118711, output: 118712, cacheRead: 118713, cacheWrite: 118714, cost: 0.0118715 } };

test("wire canary: an index row from the pre-bump build does not reach the browser after the new build loads", async () => {
	const f = fixture();
	writeFileSync(f.sessionA, line({ type: "session", version: 3, id: "sess-a", timestamp: iso(0), cwd: "/work" }));
	writeCanary(f);
	const first = await startHub(f);
	try {
		await openCanary(first.browser);
	} finally {
		await first.close();
	}
	// Rewrite the stored rows as a pre-bump build left them: billing in every assistant row, the old version stamp.
	const db = new DatabaseSync(findFile(join(f.dir, "cache"), "working-set.sqlite"));
	try {
		const rows = db.prepare("SELECT path, id, ui FROM entries WHERE ui IS NOT NULL").all() as { path: string; id: string; ui: string }[];
		let changed = 0;
		for (const row of rows) {
			const ui = JSON.parse(row.ui);
			if (ui.kind !== "assistant") continue;
			db.prepare("UPDATE entries SET ui=? WHERE path=? AND id=?").run(JSON.stringify({ ...ui, model: OLD.model, usage: OLD.usage }), row.path, row.id);
			changed++;
		}
		assert.ok(changed >= 2, `the first build stored ${changed} assistant rows`);
		for (const s of db.prepare("SELECT path, data FROM sessions").all() as { path: string; data: string }[]) {
			const data = JSON.parse(s.data);
			data.version = `${PRE_BUMP_VERSION}:${String(data.version).split(":").slice(1).join(":")}`;
			db.prepare("UPDATE sessions SET data=? WHERE path=?").run(JSON.stringify(data), s.path);
		}
	} finally {
		db.close();
	}
	const second = await startHub(f);
	try {
		await openCanary(second.browser);
		await bounded(second.browser.req("devbox", "thread.history", { threadId: THREAD }), 8000);
		const old = second.tap.frames.filter((x) => x.text.includes(OLD.model) || num(String(OLD.usage.input)).test(x.text)).map((x) => x.source);
		const native = second.tap.leaks(["usage.input", "usage.output", "cost.total", "model"]);
		assert.deepEqual([...new Set(old)], [], "pre-bump index rows reached the browser");
		assert.deepEqual(native, [], "the re-derived rows carry billing");
	} finally {
		await second.close();
	}
});

function findFile(dir: string, name: string): string {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (entry === name) return path;
		if (statSync(path).isDirectory()) {
			try { return findFile(path, name); } catch {}
		}
	}
	throw new Error(`${name} not found under ${dir}`);
}
