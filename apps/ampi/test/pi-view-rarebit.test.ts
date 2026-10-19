import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Hub } from "../src/hub/hub.ts";
import { WorkingSet } from "../src/pi/working-set.ts";
import { rarebitView, type RarebitFailure, type RarebitSide, type RarebitValue } from "../src/pi/views/rarebit.ts";
import type { PiViewContext, PiViewSession } from "../src/pi/views/types.ts";
import { Browser } from "./helpers.ts";
import { fixture } from "./pi-fixtures.ts";

const TOKEN = "e".repeat(64);
const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const row = (id: string, parentId: string | null, role: string, text: string, extra = {}) => line({ type: "message", id, parentId, timestamp: "2026-10-18T10:00:00Z", message: { role, content: [{ type: "text", text }], ...extra } });

async function setup(t: { after: (fn: () => unknown) => void }, text = "Hello") {
	const f = fixture();
	writeFileSync(f.sessionA, line({ type: "session", version: 3, id: "sess-a", timestamp: "2026-10-18T10:00:00Z", cwd: "/work" })
		+ row("u1", null, "user", text)
		+ row("injected", "u1", "user", "<system-reminder>Injected</system-reminder>")
		+ row("a1", "injected", "assistant", "Checking.", { stopReason: "toolUse", content: [{ type: "text", text: "Checking." }, { type: "thinking", thinking: "private" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "x" } }] })
		+ row("r1", "a1", "toolResult", "tool output", { toolCallId: "c1" })
		+ row("a2", "r1", "assistant", "Done.", { stopReason: "stop" })
		+ line({ type: "compaction", id: "k1", parentId: "a2", timestamp: "2026-10-18T10:01:00Z", summary: "Keep it.", firstKeptEntryId: "a2" })
		+ row("u2", "k1", "user", "More")
		+ row("err", "u2", "assistant", "", { stopReason: "error", errorMessage: "Provider unavailable" }));
	const hub = new Hub({ backend: "pi", hosts: [{
		id: "synthetic-host", label: "synthetic-host", kind: "pi-local", cacheDir: join(f.dir, "cache"),
		askCommand: [process.execPath, "-e", `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{if(/Question: "fail"/.test(s))process.exit(3);console.log(s);});`],
		agentConfig: { agentDir: f.agentDir, teams: false, pollMs: 30, discoverMs: 150 },
		env: { HOME: f.dir, HERDR_BIN: join(f.dir, "herdr"), FAKE_HERDR_STATE: join(f.dir, "state.json"), FAKE_HERDR_LOG: join(f.dir, "calls.jsonl") },
	}] }, { token: TOKEN });
	const port = await hub.listen(0);
	const browser = await Browser.open(port, undefined, `ampi_k_${port}=${TOKEN}`);
	t.after(async () => { browser.ws.close(); await hub.close(); });
	await browser.until<any>(browser.sub("synthetic-host", { kind: "threads" }), (v) => v.threads["pi:sess-a"]);
	const sid = browser.sub("synthetic-host", { kind: "view", view: "rarebit", threadId: "pi:sess-a" });
	const first = await browser.until<RarebitValue>(sid, (v) => v.items?.length === 6);
	const req = (op: string, args = {}) => browser.req("synthetic-host", `view.rarebit.${op}`, { threadId: "pi:sess-a", ...args });
	return { f, browser, sid, first, req };
}

test("Rarebit recap reuses exact evidence and model, shares in-flight calls, and retries failures", async (t) => {
	const f = fixture();
	writeFileSync(f.sessionA, line({ type: "session", version: 3, id: "sess-a", timestamp: "2026-10-18T10:00:00Z", cwd: "/work" }) + row("u1", null, "user", "First question"));
 const source = { host: "synthetic-host", path: f.sessionA, file: f.sessionA, cacheDir: join(f.dir, "recap-cache") };
 const store = new WorkingSet(source.host, source.cacheDir);
 t.after(() => store.close());
 const data = (await store.refresh(source))!;
 const session: PiViewSession = { threadId: "pi:sess-a", ref: "synthetic-host/pi:sess-a", path: f.sessionA, copyFile: f.sessionA, revision: 1, bytes: data.bytes, data, sourceVersion: data.version,
  window: () => [], rarebits: () => store.rarebits(source.path, session.revision), rarebitSnapshot: (limit) => store.rarebitSnapshot(source.path, limit), arcEvidence: () => new Map(), nearest: () => undefined, entryTimes: () => new Map() };
	let calls = 0;
	let finish!: (answer: { text: string }) => void;
	let reject!: (error: Error) => void;
	const ctx: PiViewContext = {
		host: "synthetic-host", stateDir: () => f.dir, sessions: () => [session], session: () => session,
		teams: () => [], teamsFrame: () => undefined, command: async () => ({}), invalidate: () => {}, lease: () => () => {}, snapshot: (read) => store.snapshot(read),
		ask: async () => { calls++; return new Promise((resolve, fail) => { finish = resolve; reject = fail; }); },
	};
	const recap = (args = {}) => rarebitView.ops!.recap!(ctx, { threadId: session.threadId, ...args });
	assert.equal(await recap({ cachedOnly: true }), null);
	assert.equal(calls, 0);
	const requests = Array.from({ length: 5 }, () => recap());
	assert.equal(calls, 1);
	assert.equal(await recap({ cachedOnly: true }), null);
	finish({ text: "First recap" });
	const results = await Promise.all(requests);
	assert.ok(results.every((result) => result === results[0]));
	assert.deepEqual(await recap(), results[0]);
	assert.deepEqual(await recap({ cachedOnly: true }), results[0]);
	// Changed Session bytes without changed selected evidence must not cause a new call.
	appendFileSync(f.sessionA, row("tool", "u1", "toolResult", "New tool output"));
 await store.refresh(source);
	session.revision++;
	assert.deepEqual(await recap(), results[0]);
	assert.equal(calls, 1);
	appendFileSync(f.sessionA, row("a1", "tool", "assistant", "New answer", { stopReason: "stop" }));
 await store.refresh(source);
	session.revision++;
	assert.equal(await recap({ cachedOnly: true }), null);
	const changed = recap();
	assert.equal(calls, 2);
	finish({ text: "Changed recap" });
	assert.equal((await changed as any).text, "Changed recap");
	const changedModel = recap({ model: "synthetic/other" });
	assert.equal(calls, 3);
	reject(new Error("synthetic failure"));
	await assert.rejects(changedModel, /synthetic failure/);
	const retry = recap({ model: "synthetic/other" });
	assert.equal(calls, 4);
	finish({ text: "Other model recap" });
	await retry;
	await recap({ model: "synthetic/other" });
	assert.equal(calls, 4);
	// A slow earlier request cannot displace the result of a newer request.
	const slow = recap({ model: "synthetic/slow" });
	const finishSlow = finish;
	const fast = recap({ model: "synthetic/fast" });
	finish({ text: "Latest request" });
	const latest = await fast;
	finishSlow({ text: "Earlier request" });
	await slow;
	assert.deepEqual(await recap({ model: "synthetic/fast", cachedOnly: true }), latest);
	assert.equal(calls, 6);
});

test("Rarebit hub value selects published active-branch prose, excludes injected/tool/thinking content, and follows bytes and branch changes", async (t) => {
	const { f, browser, sid, first } = await setup(t);
	assert.deepEqual(first.items.map((i) => [i.id, i.kind]), [["u1", "user"], ["a1", "continuation"], ["a2", "stop"], ["k1", "compaction"], ["u2", "user"], ["err", "error"]]);
	assert.deepEqual([first.stats.user, first.stats.continuation, first.stats.stop, first.stats.compactions, first.stats.rarebitTokens], [2, 1, 1, 1, 6]); // 5 + 9 + 5 + 4 characters
	assert.deepEqual(first.diagnosis.live, { user: 1, continuation: 0, stop: 0, toolCalls: 0, toolResults: 0, thinking: 0, summary: 2, other: 0 });
	assert.equal(first.diagnosis.session.toolResults, 3);
	assert.equal(first.diagnosis.session.thinking, 2);
	assert.equal(first.diagnosis.session.toolCalls, 4); // 'read' + '{"path":"x"}' = 16 characters
	appendFileSync(f.sessionA, row("u3", "err", "user", "Follow"));
	const next = await browser.until<RarebitValue>(sid, (v) => v.stats?.user === 3);
	assert.equal(next.items.at(-1)?.text, "Follow");
	assert.ok(next.revision > first.revision);
	appendFileSync(f.sessionA, row("branch", "u1", "user", "Alternative"));
	const branched = await browser.until<RarebitValue>(sid, (v) => v.items?.at(-1)?.id === "branch");
	assert.deepEqual(branched.items.map((i) => i.id), ["u1", "branch"]);
	assert.deepEqual(browser.gaps, []);
});

test("Rarebit side ask freezes evidence for follow-ups, keeps failures inline, bounds oversized input, and End discards it without Session writes", async (t) => {
	const { f, browser, sid, req } = await setup(t, "old-prefix " + "z".repeat(410_000) + " newest-suffix");
	const before = readFileSync(f.sessionA, "utf8");
	const first = (await req("ask", { question: "What changed?", model: "synthetic/model" })).side as RarebitSide;
	assert.equal(first.count, 4);
	assert.ok(first.omittedChars > 0);
	assert.ok(first.turns[0]!.answer!.includes("newest-suffix"));
	assert.ok(!first.turns[0]!.answer!.includes("old-prefix"));
	const evidence = (text: string) => text.split("BEGIN EVIDENCE\n")[1]!.split("\nEND EVIDENCE")[0]!;
	assert.equal(evidence(first.turns[0]!.answer!).length, 400_000);
	assert.equal(readFileSync(f.sessionA, "utf8"), before);
	// The stand-in echoes a large prompt; start a small side thread to check complete follow-up history.
	await req("ask", { sideId: first.id, end: true });
	await assert.rejects(req("ask", { sideId: first.id, question: "again" }), /ended/);
	writeFileSync(f.sessionA, before.replace(/old-prefix z+ newest-suffix/, "original evidence"));
	await browser.until<RarebitValue>(sid, (v) => v.items?.[0]?.text === "original evidence");
	const small = (await req("ask", { question: "first question" })).side as RarebitSide;
	appendFileSync(f.sessionA, row("new", "err", "user", "not in the frozen snapshot"));
	await browser.until<RarebitValue>(sid, (v) => v.items?.at(-1)?.id === "new");
	const follow = (await req("ask", { sideId: small.id, question: "follow up" })).side as RarebitSide;
	assert.equal(evidence(follow.turns[1]!.answer!), evidence(small.turns[0]!.answer!));
	assert.ok(follow.turns[1]!.answer!.includes("first question"));
	assert.ok(!follow.turns[1]!.answer!.includes("not in the frozen snapshot"));
	const failed = (await req("ask", { sideId: small.id, question: "fail" })).side as RarebitSide;
	assert.match(failed.turns.at(-1)!.error!, /model_error/);
	assert.equal(failed.id, small.id);
	await req("ask", { sideId: small.id, end: true });
	const fresh = (await req("ask", { question: "new snapshot" })).side as RarebitSide;
	assert.notEqual(fresh.id, small.id);
	assert.ok(fresh.turns[0]!.answer!.includes("not in the frozen snapshot"));
	assert.deepEqual(f.herdrCalls(), []);
});

test("Rarebit recovers from read failures on the next Session revision without a refresh; recap is bounded, cited, and does not write the Session", async (t) => {
	const { f, browser, sid, req } = await setup(t);
	const before = readFileSync(f.sessionA, "utf8");
	const recap = await req("recap", { model: "synthetic/recap" });
	assert.ok(recap.text.split(/\s+/).length <= 25);
	assert.equal(recap.entry, "u2");
	assert.equal(recap.model, "synthetic/recap");
	assert.equal(readFileSync(f.sessionA, "utf8"), before);
	appendFileSync(f.sessionA, row("new", "err", "user", "new bytes") + "{broken synthetic line}\n");
	const broken = await browser.until<RarebitFailure>(sid, (v) => Boolean(v.error));
	assert.equal(broken.error.code, "view_failed");
	assert.match(broken.error.message, /local Session copy/);
	writeFileSync(f.sessionA, before);
	const recovered = await browser.until<RarebitValue>(sid, (v) => v.items?.length === 6);
	assert.ok(recovered.revision > recap.revision);
	appendFileSync(f.sessionA, row("live-user", "err", "user", "Live question") + row("live-answer", "live-user", "assistant", "Live answer", { stopReason: "stop" }));
	const live = await browser.until<RarebitValue>(sid, (v) => v.items?.at(-1)?.id === "live-answer");
	assert.deepEqual(live.items.slice(-2).map((i) => [i.kind, i.text]), [["user", "Live question"], ["stop", "Live answer"]]);
	assert.doesNotMatch(broken.error.message, /refresh/i);
});
