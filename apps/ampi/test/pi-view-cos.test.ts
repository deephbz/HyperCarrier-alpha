import "./bound.ts";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Hub } from "../src/hub/hub.ts";
import type { ArcListValue, ArcValue } from "../src/pi/views/cos-arc.ts";
import { STEP2_VERSION } from "../src/pi/views/cos-arc.ts";
import type { TimelineValue } from "../src/pi/views/cos-timeline.ts";
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
	const ask = `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(calls)}, 'call\\n');
if(fs.existsSync(${JSON.stringify(fail)})){ console.error('No model configured on this synthetic hub'); process.exit(2); }
let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>{try{const p=JSON.parse(s); console.log(JSON.stringify(p.arcs ? (()=>{const id=(p.arcs.map(a=>a.rarebitEvidence).join('\\n').match(/\\[([^\\]]+)\\]/)||[])[1]; return {headline:'Reader arc',projects:[{name:'Canonical Reader',aliases:['Reader'],summary:'Synthetic work',status:'paused'}],transitions:[{chunk:'c0',kind:'pivot',to:'Reader'},{chunk:'invented',kind:'pivot'}],asks:p.askCandidates[0]?[{candidates:[p.askCandidates[0].id],text:'Approve the deploy',kind:'approval',answeredBy:null}]:[],threads:[{label:'Reader work',state:'active',progress:[],decisions:[{text:'Pick the parser',citations:[id],quote:'user evidence u1'}],blockers:[]}],unassigned:{progress:[],decisions:[],blockers:[]}};})() : {chunks:p.chunks.map(c=>({chunk:c.chunk,topic:'Label '+c.chunk,project:'Reader',ideas:[{text:'Cited idea',evidence:[c.evidence.match(/\\[([^\\]]+)\\]/)[1],'invented']},{text:'Invented only',evidence:['invented']}]}))}));}catch(e){console.error(String(e.stack).replace(/\\n/g,' | ')+' INPUT '+s.slice(0,400));process.exit(3);}});`;
	const hub = new Hub({ backend: "pi", models: HELPER_MODELS, hosts: [{ id: "devbox", label: "devbox", kind: "pi-local", cacheDir: join(f.dir, "cache"), askCommand: [process.execPath, "-e", ask], agentConfig: { agentDir: f.agentDir, pollMs: 30, discoverMs: 150, teams: false }, env: { HOME: f.dir, HERDR_BIN: join(f.dir, "herdr"), FAKE_HERDR_STATE: join(f.dir, "state.json"), FAKE_HERDR_LOG: join(f.dir, "calls.jsonl") } }] }, { token: "c".repeat(64) });
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

test("cos.arc: deterministic chunks keep a compaction inside and cut at an idle gap without a model; explicit hub build labels them and rejects invented citations", async (t) => {
	const { f, browser, calls, fail } = await setup(t);
	appendFileSync(f.sessionA, line({ type: "compaction", id: "k1", parentId: "a2", timestamp: new Date(T + 3600_000).toISOString(), summary: "Synthetic compact", firstKeptEntryId: "u1", tokensBefore: 1000 })
		+ message("u2", "k1", 25 * 3600_000, "user"));
	const list = browser.sub("devbox", { kind: "view", view: "cos.arc" });
	await browser.until<any>(list, (v) => v.sessions.some((s: any) => s.threadId === "pi:sess-a"));
	const sid = browser.sub("devbox", { kind: "view", view: "cos.arc", threadId: "pi:sess-a" });
	const first = await browser.until<ArcValue>(sid, (v) => v.chunks?.length === 2);
	assert.deepEqual(first.chunks.map((c) => [c.firstEntryId, c.compactionEntryId]), [["u1", "k1"], ["u2", null]]);
	assert.equal(existsSync(calls), false, "subscriptions never call a model");
	assert.equal(first.synthesis, null);
	assert.equal(first.chunks[0]!.firstAsk, "user evidence u1");
	appendFileSync(f.sessionB, message("bx1", null, 2000, "user"));
	await browser.req("devbox", "view.cos-arc.build", { threadId: "pi:sess-a" });
	const built = await browser.until<ArcValue>(sid, (v) => v.job?.state === "done" || v.job?.state === "error");
	assert.equal(built.job!.lastError, null, "a valid synthetic model answer must complete the combined build");
	assert.equal(built.coverage.labelledChunks, 2);
	assert.equal(built.coverage.synthesisCurrent, true);
	assert.equal(built.synthesis!.headline, "Reader arc");
	assert.deepEqual(Object.keys(built.context!).sort(), ["answered", "asOfEntryId", "asOfRarebitCount", "builtAt", "coverage", "format", "model", "needsYou", "overtaken", "rarebitFingerprint", "threads", "unassigned"]);
	assert.ok(Array.isArray(built.context!.answered), "answered asks remain available as an array");
	assert.equal(built.context!.format, STEP2_VERSION, "the tree records its prompt version");
	assert.equal(built.contextStatus.formatChanged, false);
	assert.deepEqual(built.context!.answered, [], "this fixture has no answered asks");
	// The owner turn u2 follows the ask in a1 without answering it, so the ask is overtaken.
	assert.deepEqual(built.context!.needsYou, []);
	const ask = built.context!.overtaken![0]!;
	assert.deepEqual(ask.citations.map((c) => [c.session, c.entryId]), [["devbox/pi:sess-a", "a1"]], "a citation is Session-qualified and follows the candidate statement");
	assert.deepEqual([ask.closed, ask.resolvedBy.map((c) => c.entryId)], ["overtaken", ["u2"]]);
	assert.equal(ask.kind, "approval");
	assert.equal(ask.citations[0]!.at, T + 899_000, "the ask carries its cited entry time for its age");
	assert.deepEqual(built.context!.threads[0]!.decisions[0]!.citations.map((c) => c.entryId), ["u1"]);
	assert.equal(built.context!.threads[0]!.decisions[0]!.quote, "user evidence u1");
	const head = await browser.until<ArcListValue>(list, (v) => v.sessions.some((s) => s.threadId === "pi:sess-a" && s.head.built));
	const listed = head.sessions.find((s) => s.threadId === "pi:sess-a")!.head;
	assert.deepEqual([listed.open, listed.overtaken], [{ decision: 0, approval: 0, input: 0, blocker: 0 }, 1], "the list reads per-kind open asks and the overtaken count from the receipt head");
	assert.deepEqual(built.transitions.map((t) => t.chunk), ["c0"]);
	assert.deepEqual(built.cards.map((c) => c.name), ["Canonical Reader"]);
	assert.deepEqual(built.chunks[0]!.label!.ideas, [{ text: "Cited idea", evidence: ["u1"] }]);
	assert.deepEqual(built.chunks.map((c) => c.firstEntryId), first.chunks.map((c) => c.firstEntryId), "model labels cannot move boundaries");
	appendFileSync(f.sessionA, message("a3", "u2", 25 * 3600_000 + 1000, "assistant", { stopReason: "stop" }));
	const grown = await browser.until<ArcValue>(sid, (v) => v.chunks?.at(-1)?.lastEntryId === "a3");
	assert.equal(grown.coverage.synthesisCurrent, false);
	assert.equal(grown.contextStatus.newMessages, 1, "appending a Rarebit row must mark tier 2 stale without a model call");
	const staleList = await browser.until<ArcListValue>(list, (v) => v.sessions.some((s) => s.threadId === "pi:sess-a" && s.head.newMessages === 1));
	assert.equal(staleList.sessions.find((s) => s.threadId === "pi:sess-a")!.head.overtaken, 1, "the stale marker keeps the last built asks visible");
	appendFileSync(f.sessionA, line({ type: "compaction", id: "k2", parentId: "a3", timestamp: new Date(T + 26 * 3600_000).toISOString(), summary: "Second compact", firstKeptEntryId: "u2", tokensBefore: 1000 })
		+ message("u3", "k2", 26 * 3600_000 + 1000, "user"));
	const compacted = await browser.until<ArcValue>(sid, (v) => v.chunks?.at(-1)?.lastEntryId === "u3");
	assert.equal(compacted.contextStatus.newMessages, grown.contextStatus.newMessages + 2, "a compaction does not reset the stale count; the assistant stop and next user row add two messages");
	assert.equal(compacted.context!.asOfEntryId, built.context!.asOfEntryId, "a compaction never rewrites the built tree");
	assert.equal(grown.chunks.at(-1)!.labelCurrent, false);
	writeFileSync(fail, "");
	await browser.req("devbox", "view.cos-arc.build", { threadId: "pi:sess-a" });
	const failed = await browser.until<ArcValue>(sid, (v) => v.job?.state === "error");
	assert.match(failed.job!.lastError!.message, /No model configured/);
	assert.equal(failed.chunks.length, compacted.chunks.length, "missing models never hide the skeleton or prior receipts");
});

test("cos.arc: no-model fixture follows tool-only appends, a user message, and a branch switch", async (t) => {
	const { f, browser, calls } = await setup(t);
	const sid = browser.sub("devbox", { kind: "view", view: "cos.arc", threadId: "pi:sess-a" });
	const first = await browser.until<ArcValue>(sid, (v) => v.chunks?.at(-1)?.lastEntryId === "a2");
	assert.equal(existsSync(calls), false, "opening an Arc must not call a model");
	appendFileSync(f.sessionA, message("tool-only", "a2", 902_000, "toolResult"));
	const withTool = await browser.until<ArcValue>(sid, (v) => v.chunks?.at(-1)?.lastEntryId === "tool-only");
	assert.ok(withTool.chunks.some((c) => c.firstEntryId === first.chunks[0]!.firstEntryId), "tool-only append must retain current Arc evidence");
	assert.equal(existsSync(calls), false, "tool-only append must not call a model");
	appendFileSync(f.sessionA, message("u2", "tool-only", 903_000, "user"));
	const withUser = await browser.until<ArcValue>(sid, (v) => v.chunks?.at(-1)?.lastEntryId === "u2");
	assert.equal(withUser.chunks.at(-1)!.lastEntryId, "u2", "a user message must enter the current Arc without a model call");
	assert.equal(existsSync(calls), false, "user append must not call a model");
	appendFileSync(f.sessionA, message("branch", "u1", 904_000, "user"));
	const branched = await browser.until<ArcValue>(sid, (v) => v.chunks?.some((c) => c.lastEntryId === "branch"));
	assert.ok(branched.chunks.every((c) => c.lastEntryId !== "u2" && c.lastEntryId !== "tool-only"), "branch switch must discard evidence outside the active branch");
	assert.equal(existsSync(calls), false, "branch switch must not call a model");
});

test("cos.arc: inherited parent evidence is excluded and the thirteenth owner turn starts a new chunk", async (t) => {
	const { f, browser, calls } = await setup(t, { parentSession: "/work/parent.jsonl", timestamp: new Date(T + 1800_000).toISOString() });
	let parent = "a2";
	for (let i = 0; i < 13; i++) {
		const id = `own${i}`;
		appendFileSync(f.sessionA, message(id, parent, 1800_000 + i * 1000, "user"));
		parent = id;
	}
	const sid = browser.sub("devbox", { kind: "view", view: "cos.arc", threadId: "pi:sess-a" });
	const value = await browser.until<ArcValue>(sid, (v) => v.chunks?.at(-1)?.lastEntryId === "own12");
	assert.deepEqual(value.chunks.map((c) => [c.firstEntryId, c.lastEntryId, c.ownerTurns]), [["own0", "own11", 12], ["own12", "own12", 1]]);
	assert.equal(value.coverage.excludedEntries, 3);
	assert.equal(value.buildEstimate.calls, 2, "one label call and one step-2 call");
	assert.equal(existsSync(calls), false);
});

test("cos.arc: archived chunking keeps complete turns; a directory move only describes a chunk; full Rarebit evidence cuts at the next owner turn", async (t) => {
	const { f, browser } = await setup(t);
	const tool = (id: string, parent: string, ms: number, file: string) => message(id, parent, ms, "assistant", { stopReason: "toolUse", content: [{ type: "toolCall", id: `call-${id}`, name: "read", arguments: { path: file } }] });
	appendFileSync(f.sessionA, message("p2", "a2", 1_000_000, "user") + tool("tool2", "p2", 1_001_000, "/work/apps/reader/index.ts")
		+ message("p3", "tool2", 1_060_000, "user") + tool("tool3", "p3", 1_061_000, "/work/apps/gui/index.ts")
		+ message("p4", "tool3", 1_120_000, "user", { content: [{ type: "text", text: "x".repeat(40_001) }] })
		+ message("p5", "p4", 1_180_000, "user"));
	const sid = browser.sub("devbox", { kind: "view", view: "cos.arc", threadId: "pi:sess-a" });
	const value = await browser.until<ArcValue>(sid, (v) => v.chunks?.at(-1)?.lastEntryId === "p5");
	assert.deepEqual(value.chunks.map((c) => [c.firstEntryId, c.lastEntryId, c.where]), [["u1", "p4", "apps/gui"], ["p5", "p5", null]]);
	assert.equal(value.buildEstimate.truncatedChunks, 1, "per-line clipping is disclosed even when the aggregate window fits");
});

test("cos.timeline: an unreadable Session is listed as unreadable without hiding the other streams", async (t) => {
	const { f, browser } = await setup(t);
	writeFileSync(f.sessionB, line({ type: "session", version: 3, id: "sess-b", timestamp: new Date(T).toISOString(), cwd: "/work" }) + message("u1", null, 2000, "user") + "{not json}\n");
	const sid = browser.sub("devbox", { kind: "view", view: "cos.timeline" });
	const value = await browser.until<TimelineValue>(sid, (v) => Boolean(v.unreadable?.length));
	assert.deepEqual(value.unreadable!.map((u) => u.ref), ["devbox/pi:sess-b"]);
	assert.ok(value.sessions.some((s) => s.threadId === "pi:sess-a"), "the readable Session keeps its stream");
});
