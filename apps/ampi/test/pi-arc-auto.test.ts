import "./bound.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type ModelPurpose, resolveHelperModel, useHubConfig } from "../src/hub/helper-models.ts";
import { cosDemo } from "../scripts/demo/cos.ts";
import { ask } from "../src/pi/ask.ts";
import { buildQueue, roleWaitQueue } from "../src/pi/derive-queue.ts";
import type { Chunk } from "../src/pi/views/cos-arc-chunks.ts";
import { ARC_BUSY_WAIT, AUTO_BUILD_INTERVAL_MS, arcClock, autoBuild, autoJitterMs, buildArc, buildLog, cosArc, type ArcValue } from "../src/pi/views/cos-arc.ts";
import type { PiViewContext, PiViewSession } from "../src/pi/views/types.ts";
import type { ThreadSummary } from "../src/shared/protocol.ts";
import { HELPER_MODELS } from "./pi-host-fixtures.ts";

useHubConfig(undefined, HELPER_MODELS);

// The automatic Arc trigger (D16, owner option A) through the real ask runner and the offline demo model.

const root = mkdtempSync(join(tmpdir(), "ampi-arc-auto-"));
cosDemo({ dir: root, agentDir: join(root, "agent"), now: Date.now(), sessions: {} });
const model = [process.execPath, join(root, "cos-model.cjs")];
const T = Date.parse("2026-10-19T00:00:00.000Z");
const chunks: Chunk[] = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, index: i, hash: `h${i}`, startAt: new Date(T + i * 60_000).toISOString(), endAt: new Date(T + i * 60_000 + 30_000).toISOString(), firstEntryId: `u${i}`, lastEntryId: `a${i}`, firstAsk: `Step ${i}`, lastOwnerEntryId: `u${i}`, ownerTurns: 1, entries: 2, toolCalls: 0, where: null, idleBeforeMs: null, compactionEntryId: null }));
const CALLS = Math.ceil(chunks.length / 6) + 1;

function session(over: { summary?: Partial<ThreadSummary>; stopped?: boolean; count?: number; chunks?: Chunk[]; id?: string } = {}) {
	const id = over.id ?? "pi:sess-a";
	return { threadId: id, ref: `devbox/${id}`, sourceVersion: "v1",
		summary: { cwd: "/work/demo", live: true, activity: "idle", queued: 0, ...over.summary },
		data: { arc: { chunks: over.chunks ?? chunks }, rarebit: { count: over.count ?? 16, fingerprint: "f".repeat(64) }, timeline: { stopped: over.stopped ?? true, marks: [[T, "u7", "stop"], [T + 1, "a7", "stop"]] } },
		rarebits: () => ({ items: [], more: false, sourceVersion: "v1" }),
		arcEvidence: (ids: string[]) => new Map(ids.map((id) => { const i = id.slice(1); return [id, `[u${i}] USER: Run step ${i}.\n[a${i}] AGENT: Step ${i} landed and tests pass.`]; })),
		entryTimes: (ids: string[]) => new Map(ids.map((id) => [id, T + Number(id.slice(1)) * 60_000])) } as unknown as PiViewSession;
}

// `fail`: true or "source" throws a transient error; "answer" replies with text that is not JSON; "c7" fails only the
// label call that holds chunk c7.
function context(name: string, s: { current: PiViewSession }, fail: boolean | "source" | "answer" | "c7" = false) {
	const run = { calls: 0 };
	const dir = join(root, name); mkdirSync(dir, { recursive: true });
	const ctx = { host: "devbox", stateDir: () => dir, session: () => s.current, lease: () => () => {}, invalidate() {}, snapshot: <T>(read: () => T) => read(), model: (p: ModelPurpose, o?: string) => resolveHelperModel(p, o),
		async ask(req: Parameters<PiViewContext["ask"]>[0]) {
			run.calls++;
			await new Promise((r) => setTimeout(r, 5));
			if (fail === "source") throw Object.assign(new Error("synthetic source change"), { code: "source" });
			if (fail === "c7" && req.purpose === "arcLabels" && req.prompt.includes('"chunk":"c7"')) throw Object.assign(new Error("model_error: synthetic failure"), { code: "model_error" });
			if (fail === "answer") return { text: "not json", usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.01 } };
			if (fail === true) throw Object.assign(new Error("model_error: synthetic failure"), { code: "model_error" });
			return { ...(await ask(req, model)), usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.01 } };
		} } as unknown as PiViewContext;
	return { ctx, run };
}
async function settled(ctx: PiViewContext, s: PiViewSession) {
	for (let i = 0; i < 400; i++) {
		const v = cosArc.value(ctx, { kind: "view", view: "cos.arc", threadId: s.threadId }) as ArcValue;
		if (v.job?.state !== "running") return v;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error("Build arc did not finish");
}

test("arc auto build: one Build per qualifying stop, at most once per 10 min per Session, logged with its cost", async () => {
	const s = { current: session() };
	const { ctx, run } = context("auto", s);
	const now = Date.now();
	assert.equal(autoBuild(ctx, s.current, now), true, "a live, idle Session that stopped with no Arc builds");
	assert.equal(autoBuild(ctx, s.current, now), false, "a running Build is never duplicated");
	const v = await settled(ctx, s.current);
	assert.equal(v.job?.state, "done", v.job?.lastError?.message ?? "");
	assert.equal(run.calls, CALLS, "the stop costs exactly one Build's calls; no Summary or second Build call");
	assert.deepEqual(buildLog(ctx, s.current.threadId).map((b) => [b.trigger, b.state, b.calls, b.usage.cost?.toFixed(2), b.usage.input, b.afterEntryId]), [["auto", "done", CALLS, (CALLS * 0.01).toFixed(2), CALLS * 1000, "a7"]]);
	assert.equal(v.builds.length, 1, "the Arc page shows the log");

	assert.equal(autoBuild(ctx, s.current, now + AUTO_BUILD_INTERVAL_MS + 1), false, "no new Rarebit messages since the Build: no model call");
	s.current = session({ count: 18 });
	assert.equal(autoBuild(ctx, s.current, now + AUTO_BUILD_INTERVAL_MS - 1), false, "new messages inside the 10 min window wait");
	const restarted = context("auto", s);
	assert.equal(autoBuild(restarted.ctx, s.current, now + AUTO_BUILD_INTERVAL_MS - 1), false, "a hub restart reads the limit from the Build log");
	assert.equal(autoBuild(ctx, s.current, now + AUTO_BUILD_INTERVAL_MS), true, "the window has passed");
	await settled(ctx, s.current);
	assert.equal(run.calls, CALLS + 1, "unchanged chunks reuse their labels; the second Build calls only step 2");
	assert.equal(restarted.run.calls, 0);
});

test("arc auto build: a failed Build counts toward the limit and is logged as a failure", async () => {
	const s = { current: session() };
	const { ctx, run } = context("auto-fail", s, true);
	const now = Date.now();
	assert.equal(autoBuild(ctx, s.current, now), true);
	const v = await settled(ctx, s.current);
	assert.equal(v.job?.state, "error");
	const [entry] = buildLog(ctx, s.current.threadId);
	assert.equal(entry?.state, "error");
	assert.match(entry?.error ?? "", /synthetic failure/);
	assert.equal(entry?.errorCode, "model");
	assert.equal(entry?.usage.cost, null, "no call reported a price");
	const calls = run.calls;
	assert.equal(autoBuild(ctx, s.current, now + 60_000), false, "no retry inside the window");
	assert.equal(run.calls, calls);
});

test("arc auto build: after an answer failure, only messages newer than its start build automatically again; Build arc always runs (failure: the same input failed every 10 min)", async () => {
	const s = { current: session() };
	const { ctx, run } = context("auto-fail-input", s, "answer");
	const now = Date.now();
	assert.equal(autoBuild(ctx, s.current, now), true);
	await settled(ctx, s.current);
	assert.equal(buildLog(ctx, s.current.threadId)[0]?.errorCode, "answer");
	assert.equal(buildLog(ctx, s.current.threadId)[0]?.asOf, 16, "the record keeps the Rarebit count it started from");
	const calls = run.calls;
	assert.equal(autoBuild(ctx, s.current, now + AUTO_BUILD_INTERVAL_MS + 1), false, "the same input never builds again automatically");
	assert.equal(run.calls, calls);
	buildArc(ctx, s.current);
	await settled(ctx, s.current);
	assert.ok(run.calls > calls, "Build arc runs on the same input");
	s.current = session({ count: 18 });
	assert.equal(autoBuild(ctx, s.current, now + 2 * AUTO_BUILD_INTERVAL_MS + 2), false, "the manual failure counts: 2 failures back off 20 min");
	assert.equal(autoBuild(ctx, s.current, now + 3 * AUTO_BUILD_INTERVAL_MS + autoJitterMs(s.current.threadId)), true, "a newer message builds automatically after the backoff");
	await settled(ctx, s.current);
	assert.deepEqual(buildLog(ctx, s.current.threadId).map((b) => [b.trigger, b.state, b.asOf]), [["auto", "error", 16], ["manual", "error", 16], ["auto", "error", 18]]);
});

test("arc auto build: a model failure (busy slot, timeout, quota, model error) builds the same input once more after its backoff, then waits for new messages (failure: one flaky call stopped every automatic Build until a new message; a quota window failed the same input every 10 min)", async () => {
	const wait = ARC_BUSY_WAIT.autoMs;
	ARC_BUSY_WAIT.autoMs = 50;
	try {
		// Each upstream ask code folds into `model` (errorCode) and gets the one same-input retry.
		for (const [code, message] of [["busy", "three model calls are already running"], ["timeout", "anthropic/claude-haiku-5-5 timed out after 120 s"],
			["model_error", "429: Claude Code: You've hit your session limit · resets 4:20am (Asia/Hong_Kong)"], ["model_error", "model_error: synthetic failure"]] as const) {
			const id = `pi:sess-fold-${code}-${message.length}`, s = { current: session({ id }) };
			const { ctx } = context(`auto-fail-transient-${code}-${message.length}`, s), run = { calls: 0 };
			Object.assign(ctx, { ask: async () => { run.calls++; throw Object.assign(new Error(message), { code }); } });
			const now = Date.now();
			assert.equal(autoBuild(ctx, s.current, now), true);
			await settled(ctx, s.current);
			assert.equal(buildLog(ctx, id)[0]?.errorCode, "model", `${code} folds into model`);
			assert.equal(autoBuild(ctx, s.current, now + 60_000), false, `${code}: no retry inside the window`);
			// A quota reset can be later than the backoff; the retry then waits for it (the quota tests).
			const retryAt = view(ctx, id).nextAutoAt ?? now + 11 * 60_000;
			assert.equal(autoBuild(ctx, s.current, Math.max(retryAt, now + 11 * 60_000)), true, `${code}: the same input builds once more after the window`);
			await settled(ctx, s.current);
			const calls = run.calls;
			for (const later of [2, 10, 100]) assert.equal(autoBuild(ctx, s.current, now + later * 3600_000), false, `${code}: +${later} h: the same input does not build a third time`);
			assert.equal(run.calls, calls);
			s.current = session({ id, count: 18 });
			assert.equal(autoBuild(ctx, s.current, now + 100 * 3600_000), true, `${code}: a new message builds after the backoff`);
			await settled(ctx, s.current);
		}
	} finally { ARC_BUSY_WAIT.autoMs = wait; }
});

test("arc auto build: a source failure (the Session changed during the Build) never builds the same input again automatically", async () => {
	const s = { current: session() };
	const { ctx } = context("auto-fail-transient-source", s, "source");
	const now = Date.now();
	assert.equal(autoBuild(ctx, s.current, now), true);
	await settled(ctx, s.current);
	assert.equal(buildLog(ctx, s.current.threadId)[0]?.errorCode, "source");
	assert.equal(autoBuild(ctx, s.current, now + 11 * 60_000), false, "the same input does not build again");
	s.current = session({ count: 18 });
	assert.equal(autoBuild(ctx, s.current, now + 11 * 60_000), true, "a new message builds");
	await settled(ctx, s.current);
});

test("arc auto build: after 2 failed Builds that missed the same chunk, automatic Builds wait for new messages and the view names the chunks (failure: one bad chunk relabelled every 10 min)", async () => {
	const s = { current: session() };
	const { ctx } = context("auto-stuck", s, "c7");
	const now = Date.now();
	assert.equal(autoBuild(ctx, s.current, now), true);
	await settled(ctx, s.current);
	assert.equal(autoBuild(ctx, s.current, now + AUTO_BUILD_INTERVAL_MS + autoJitterMs(s.current.threadId)), true, "one transient label failure builds again");
	const v = await settled(ctx, s.current);
	assert.deepEqual(buildLog(ctx, s.current.threadId).map((b) => [b.state, b.failedChunks?.map((c) => c.hash)]), [["error", ["h6", "h7"]], ["error", ["h6", "h7"]]]);
	assert.equal(autoBuild(ctx, s.current, now + 2 * AUTO_BUILD_INTERVAL_MS + 2), false, "the same chunks failed twice: no automatic Build");
	assert.deepEqual((v as ArcValue & { stuck?: { chunks: string[] } | null }).stuck?.chunks, ["c6", "c7"], "the view names the stuck chunks");
	s.current = session({ count: 18 });
	assert.equal(autoBuild(ctx, s.current, now + 3 * AUTO_BUILD_INTERVAL_MS + 2 * autoJitterMs(s.current.threadId)), true, "a new message builds automatically again after the 20 min backoff");
	await settled(ctx, s.current);
});

test("arc auto build: chunks the model's answer omitted twice stay stuck through new messages until Build arc succeeds (failure: the same omission relabelled every new message)", async () => {
	const s = { current: session() };
	const { ctx } = context("auto-stuck-answer", s), inner = ctx.ask.bind(ctx);
	let omit = true;
	Object.assign(ctx, { ask: async (req: Parameters<PiViewContext["ask"]>[0]) => {
		const answer = await inner(req);
		if (!omit || req.purpose !== "arcLabels" || !req.prompt.includes('"chunk":"c7"')) return answer;
		const raw = JSON.parse(answer.text); raw.chunks = raw.chunks.filter((l: { chunk: string }) => l.chunk !== "c7");
		return { ...answer, text: JSON.stringify(raw) };
	} });
	const now = Date.now();
	assert.equal(autoBuild(ctx, s.current, now), true);
	await settled(ctx, s.current);
	s.current = session({ count: 18 });
	assert.equal(autoBuild(ctx, s.current, now + AUTO_BUILD_INTERVAL_MS + autoJitterMs(s.current.threadId)), true, "a newer message builds after one answer failure");
	await settled(ctx, s.current);
	assert.deepEqual(buildLog(ctx, s.current.threadId).map((b) => [b.state, b.labelErrorCode, b.failedChunks?.map((c) => c.id)]), [["error", "answer", ["c7"]], ["error", "answer", ["c7"]]]);
	s.current = session({ count: 20 });
	assert.equal(autoBuild(ctx, s.current, now + 2 * AUTO_BUILD_INTERVAL_MS + 2), false, "a new message does not unlock an answer failure");
	assert.deepEqual((await settled(ctx, s.current)).stuck, { chunks: ["c7"], until: "build" });
	omit = false;
	buildArc(ctx, s.current);
	const built = await settled(ctx, s.current);
	assert.deepEqual([built.job?.state, built.stuck], ["done", null], "a successful Build arc unlocks");
	s.current = session({ count: 22 });
	assert.equal(autoBuild(ctx, s.current, now + 3 * AUTO_BUILD_INTERVAL_MS + 3), true);
	await settled(ctx, s.current);
});

test("arc auto build: viewing an Arc of another step-2 version rebuilds it once and shows the last Arc meanwhile (failure: an old-format Arc stayed until the next stop)", async () => {
	const s = { current: session() };
	const first = context("auto-format", s);
	buildArc(first.ctx, s.current);
	assert.equal((await settled(first.ctx, s.current)).job?.state, "done");
	const dir = join(root, "auto-format"), file = join(dir, readdirSync(dir).find((f) => /^[0-9a-f]{64}\.json$/.test(f))!);
	const raw = JSON.parse(readFileSync(file, "utf8"));
	writeFileSync(file, JSON.stringify({ ...raw, step2Version: "older-step-2", context: { ...raw.context, format: "older-step-2" } }));
	// A fresh hub on the same state directory, past the 10 min bound.
	const again = context("auto-format", s), now = arcClock.now, later = arcClock.later, timers: (() => void)[] = [];
	Object.assign(arcClock, { now: () => Date.now() + AUTO_BUILD_INTERVAL_MS + 1, later: (fn: () => void) => timers.push(fn) });
	try {
		const opened = cosArc.value(again.ctx, { kind: "view", view: "cos.arc", threadId: s.current.threadId }) as ArcValue;
		assert.equal(opened.job?.state, "running", "the view starts one rebuild");
		assert.ok(opened.keptAt && opened.context?.threads.length, "the last Arc shows meanwhile");
		assert.equal(opened.contextStatus.formatChanged, true, "with the quiet format notice");
		const v = await settled(again.ctx, s.current);
		assert.equal(v.job?.state, "done");
		assert.equal(v.contextStatus.formatChanged, false);
		assert.deepEqual(buildLog(again.ctx, s.current.threadId).map((b) => [b.trigger, b.cause]), [["manual", undefined], ["auto", "rebuilt: the Arc format changed"]]);
		cosArc.value(again.ctx, { kind: "view", view: "cos.arc", threadId: s.current.threadId });
		assert.equal(buildLog(again.ctx, s.current.threadId).length, 2, "a current Arc does not rebuild again");
		assert.equal(timers.length, 0);
	} finally { Object.assign(arcClock, { now, later }); }
});

test("arc auto build: a Session below 4 Rarebit messages never builds automatically; at 4 it does (failure: one-prompt Sessions built empty Arcs every 10 min)", async () => {
	for (const [count, builds] of [[3, false], [4, true]] as const) {
		const s = { current: session({ count }) };
		const { ctx, run } = context(`auto-floor-${count}`, s);
		assert.equal(autoBuild(ctx, s.current, Date.now()), builds, `${count} messages`);
		if (builds) await settled(ctx, s.current);
		else assert.equal(run.calls, 0, "no model call below the floor");
	}
});

test("arc auto build: never for a non-live, busy, queued, or unstopped Session, nor without chunks, nor over a manual Build", async () => {
	const cases: [string, PiViewSession][] = [
		["not live", session({ summary: { live: false } })],
		["busy", session({ summary: { activity: "streaming" } })],
		["queued input", session({ summary: { queued: 1 } })],
		["not stopped", session({ stopped: false })],
		["no chunks", session({ chunks: [] })],
	];
	for (const [name, s] of cases) {
		const { ctx, run } = context(`skip-${name.replace(/ /g, "-")}`, { current: s });
		assert.equal(autoBuild(ctx, s, Date.now()), false, name);
		assert.equal(run.calls, 0, `${name}: no model call`);
	}
	const s = { current: session() };
	const { ctx, run } = context("manual-first", s);
	buildArc(ctx, s.current);
	assert.equal(autoBuild(ctx, s.current, Date.now()), false, "a running manual Build covers the stop");
	await settled(ctx, s.current);
	assert.equal(run.calls, CALLS);
	assert.deepEqual(buildLog(ctx, s.current.threadId).map((b) => b.trigger), ["manual"]);
});

test("arc summarize: the thread index carries only the head's open asks per kind, ask age, and staleness", async () => {
	const s = { current: session() };
	const { ctx } = context("summarize", s);
	assert.equal(cosArc.summarize!(ctx, s.current), undefined, "not built: no arc field");
	autoBuild(ctx, s.current, Date.now());
	await settled(ctx, s.current);
	const arc = cosArc.summarize!(ctx, s.current)!.arc!;
	assert.equal(arc.stale, false);
	assert.ok(JSON.stringify(arc).length < 400, "compact: no tree");
	for (const a of arc.asks) assert.ok(a.n > 0 && (a.since === null || Number.isFinite(a.since)));
	s.current = session({ count: 20 });
	const later = cosArc.summarize!(ctx, s.current)!.arc!;
	assert.equal(later.stale, true);
	assert.equal(later.newMessages, 4);
});

test("arc auto build: stops during a Build set one pending flag, and one automatic Build follows when the 10 min bound allows (failure: a stop during a Build was dropped)", async () => {
	const s = { current: session() };
	const { ctx, run } = context("pending", s);
	const scheduled: { run: () => void; ms: number }[] = [], later = arcClock.later, now = arcClock.now;
	let clock = Date.now();
	Object.assign(arcClock, { now: () => clock, later: (fn: () => void, ms: number) => scheduled.push({ run: fn, ms }) });
	try {
		const ask = ctx.ask;
		// Two agent stops with new messages land while the first label call is in flight.
		Object.assign(ctx, { ask: (req: Parameters<PiViewContext["ask"]>[0]) => {
			if (run.calls === 0) { s.current = session({ count: 18 }); autoBuild(ctx, s.current); s.current = session({ count: 20 }); autoBuild(ctx, s.current); }
			return ask(req);
		} });
		assert.equal(autoBuild(ctx, s.current), true);
		await settled(ctx, s.current);
		assert.equal(run.calls, CALLS, "no second Build ran during the first");
		assert.equal(scheduled.length, 1, "one pending follow-up for two stops");
		assert.ok(scheduled[0]!.ms > 0 && scheduled[0]!.ms <= AUTO_BUILD_INTERVAL_MS, `the follow-up waits for the bound: ${scheduled[0]!.ms} ms`);
		clock += AUTO_BUILD_INTERVAL_MS;
		scheduled[0]!.run();
		await settled(ctx, s.current);
		assert.deepEqual(buildLog(ctx, s.current.threadId).map((b) => b.trigger), ["auto", "auto"]);
		assert.equal(run.calls, CALLS + 1, "the follow-up reuses every label");
		assert.equal(scheduled.length, 1, "no stop landed during the follow-up");
		assert.equal((cosArc.value(ctx, { kind: "view", view: "cos.arc", threadId: s.current.threadId }) as ArcValue).contextStatus.newMessages, 0);
	} finally { Object.assign(arcClock, { now, later }); }
});

test("arc auto build: a finished manual Build counts toward the 10 min bound (failure: an auto Build followed a manual one at once)", async () => {
	const s = { current: session() };
	const { ctx, run } = context("manual-bound", s);
	buildArc(ctx, s.current);
	await settled(ctx, s.current);
	s.current = session({ count: 18 });
	assert.equal(autoBuild(ctx, s.current, Date.now() + 60_000), false);
	assert.equal(run.calls, CALLS);
	assert.equal(autoBuild(ctx, s.current, Date.now() + AUTO_BUILD_INTERVAL_MS + 1), true);
	await settled(ctx, s.current);
});

function fakeClock(start: number) {
	const scheduled: { run: () => void; ms: number }[] = [], later = arcClock.later, now = arcClock.now;
	const c = { t: start, scheduled, restore: () => Object.assign(arcClock, { now, later }) };
	Object.assign(arcClock, { now: () => c.t, later: (fn: () => void, ms: number) => scheduled.push({ run: fn, ms }) });
	return c;
}
const arcValue = (ctx: PiViewContext, s: PiViewSession) => cosArc.value(ctx, { kind: "view", view: "cos.arc", threadId: s.threadId }) as ArcValue;

test("arc auto build: a stop inside the 10 min bound is built at the bound's end without another stop (failure: the stop waited for the next stop)", async () => {
	const s = { current: session() };
	const { ctx, run } = context("bound-timer", s);
	const c = fakeClock(T + 3_600_000);
	try {
		const t0 = c.t;
		buildArc(ctx, s.current);
		await settled(ctx, s.current);
		assert.equal(arcValue(ctx, s.current).nextAutoAt, null, "nothing pending after a covering Build");
		c.t = t0 + 3 * 60_000;
		s.current = session({ count: 18 });
		assert.equal(autoBuild(ctx, s.current), false, "the bound refuses the stop");
		assert.equal(autoBuild(ctx, s.current), false, "a second stop adds no timer");
		assert.equal(c.scheduled.length, 1, "one timer per Session");
		assert.equal(c.scheduled[0]!.ms, 7 * 60_000, "the timer fires at the bound's end");
		assert.equal(arcValue(ctx, s.current).nextAutoAt, t0 + AUTO_BUILD_INTERVAL_MS, "the panel can show when the update comes");
		assert.equal(run.calls, CALLS);
		c.t = t0 + AUTO_BUILD_INTERVAL_MS;
		c.scheduled[0]!.run();
		await settled(ctx, s.current);
		assert.deepEqual(buildLog(ctx, s.current.threadId).map((b) => b.trigger), ["manual", "auto"]);
		assert.equal(run.calls, CALLS + 1);
		assert.equal(arcValue(ctx, s.current).nextAutoAt, null, "the started Build cleared the pending flag");
		assert.equal(arcValue(ctx, s.current).contextStatus.newMessages, 0);
		assert.equal(c.scheduled.length, 1, "no further timer");
	} finally { c.restore(); }
});

test("arc auto build: a timer that finds the Session thinking keeps the pending flag; the next idle stop builds (failure: the flag was dropped)", async () => {
	const s = { current: session() };
	const { ctx, run } = context("bound-thinking", s);
	const c = fakeClock(T + 7_200_000);
	try {
		const t0 = c.t;
		buildArc(ctx, s.current);
		await settled(ctx, s.current);
		c.t = t0 + 60_000;
		s.current = session({ count: 18 });
		assert.equal(autoBuild(ctx, s.current), false);
		assert.equal(c.scheduled.length, 1);
		c.t = t0 + AUTO_BUILD_INTERVAL_MS;
		s.current = session({ count: 18, summary: { activity: "thinking" } });
		c.scheduled[0]!.run();
		assert.equal(arcValue(ctx, s.current).job?.state, "done", "no Build while the agent thinks");
		assert.equal(arcValue(ctx, s.current).nextAutoAt, t0 + AUTO_BUILD_INTERVAL_MS, "the flag survives the refused attempt");
		s.current = session({ count: 20 });
		assert.equal(autoBuild(ctx, s.current), true, "the next idle change builds at once");
		await settled(ctx, s.current);
		assert.equal(run.calls, CALLS + 1);
		assert.equal(arcValue(ctx, s.current).nextAutoAt, null);
	} finally { c.restore(); }
});

// One Host with several live Sessions and the ask runner's 3 shared model slots: a 4th call in flight is refused `busy`.
function fleet(name: string, n: number) {
	const sessions = new Map(Array.from({ length: n }, (_, i) => [`pi:sess-q${i + 1}`, session({ id: `pi:sess-q${i + 1}` })]));
	const dir = join(root, name); mkdirSync(dir, { recursive: true });
	const run = { calls: 0, busy: 0, inFlight: 0, maxInFlight: 0, fail: undefined as undefined | (() => Error) };
	const ctx = { host: "devbox", stateDir: () => dir, session: (id: string) => sessions.get(id), lease: () => () => {}, invalidate() {}, snapshot: <T>(read: () => T) => read(), model: (p: ModelPurpose, o?: string) => resolveHelperModel(p, o),
		async ask(req: Parameters<PiViewContext["ask"]>[0]) {
			if (run.inFlight >= 3) { run.busy++; throw Object.assign(new Error("three model calls are already running"), { code: "busy" }); }
			run.calls++; run.inFlight++; run.maxInFlight = Math.max(run.maxInFlight, run.inFlight);
			try {
				await new Promise((r) => setTimeout(r, 20));
				if (run.fail) throw run.fail();
				return { ...(await ask(req, model)), usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.01 } };
			} finally { run.inFlight--; }
		} } as unknown as PiViewContext;
	return { ctx, run, sessions };
}
const view = (ctx: PiViewContext, threadId: string) => cosArc.value(ctx, { kind: "view", view: "cos.arc", threadId }) as ArcValue;
async function drained(ctx: PiViewContext, ids: string[], builds = 1) {
	for (let i = 0; i < 1500; i++) {
		if (ids.every((id) => buildLog(ctx, id).length >= builds && view(ctx, id).job?.state !== "running")) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error("the automatic Builds did not drain");
}

test("arc auto queue: Sessions that qualify together build one at a time with 2 slots; the viewed Session goes first; a manual Build starts at once and finishes with no busy refusal (failure: 14 automatic Builds at a hub start failed 'three model calls are already running')", async () => {
	const { ctx, run, sessions } = fleet("queue", 6);
	const ids = [...sessions.keys()], now = Date.now();
	assert.deepEqual(ids.map((id) => autoBuild(ctx, sessions.get(id)!, now)), [true, false, false, false, false, false], "one automatic Build runs; the rest wait");
	assert.equal(view(ctx, ids[1]).queuedAhead, 1, "a viewed waiting Session is next: 1 automatic Build ahead");
	assert.equal(view(ctx, ids[5]).queuedAhead, 1, "viewing another Session moves it to the head of the queue");
	// A message that arrives while a Session waits is in its Build: the snapshot is taken at dequeue.
	sessions.set(ids[5], session({ id: ids[5], count: 18 }));
	buildArc(ctx, sessions.get(ids[2])!);
	assert.equal(view(ctx, ids[2]).job?.state, "running", "a manual Build skips the queue");
	await drained(ctx, ids);
	assert.equal(run.busy, 0, "no call was refused busy");
	assert.ok(run.maxInFlight <= 3, `at most 3 calls in flight, saw ${run.maxInFlight}`);
	const order = ids.map((id) => [id, buildLog(ctx, id)[0]!] as const).filter(([, b]) => b.trigger === "auto").sort((a, b) => a[1].startedAt.localeCompare(b[1].startedAt)).map(([id]) => id);
	assert.deepEqual(order, [ids[0], ids[5], ids[1], ids[3], ids[4]], "the last viewed Session ran first, then the earlier viewed one, then FIFO");
	assert.deepEqual(ids.map((id) => buildLog(ctx, id)[0]!.state), Array(6).fill("done"), "every Build finished");
	assert.equal(buildLog(ctx, ids[5])[0]!.asOf, 18, "the Build read the message that arrived while it waited");
	assert.equal(buildLog(ctx, ids[2])[0]!.trigger, "manual");
});

test("arc auto queue: a Build whose calls time out still frees the queue for the next Session (failure: a hung call held every automatic Build)", async () => {
	const { ctx, run, sessions } = fleet("queue-timeout", 2);
	const ids = [...sessions.keys()], now = Date.now();
	run.fail = () => Object.assign(new Error("anthropic/claude-haiku-5-5 timed out after 120 s"), { code: "timeout" });
	assert.deepEqual(ids.map((id) => autoBuild(ctx, sessions.get(id)!, now)), [true, false]);
	await drained(ctx, ids);
	assert.deepEqual(ids.map((id) => [buildLog(ctx, id)[0]?.state, buildLog(ctx, id)[0]?.errorCode]), [["error", "model"], ["error", "model"]], "the second Session ran after the first failed");
});

test("arc auto build: consecutive failures back off 10, 20, 40, 80, then 120 min (cap) plus a fixed per-Session jitter; a success resets the 10 min cadence (failure: a 3 h quota window failed 15 Builds in a row)", async () => {
	const s = { current: session({ id: "pi:sess-backoff" }) };
	const { ctx } = context("auto-backoff", s), inner = ctx.ask.bind(ctx);
	let failing = true;
	Object.assign(ctx, { ask: async (req: Parameters<PiViewContext["ask"]>[0]) => { if (failing) throw Object.assign(new Error("model_error: synthetic failure"), { code: "model_error" }); return inner(req); } });
	const j = autoJitterMs(s.current.threadId);
	assert.ok(j >= 0 && j <= 60_000 && j === autoJitterMs(s.current.threadId), "the jitter is fixed per Session, within 0-60 s");
	let at = Date.now(), count = 16;
	assert.equal(autoBuild(ctx, s.current, at), true);
	await settled(ctx, s.current);
	for (const [k, minutes] of [[1, 10], [2, 20], [3, 40], [4, 80], [5, 120], [6, 120]] as const) {
		s.current = session({ id: "pi:sess-backoff", count: count += 2 });
		const due = at + minutes * 60_000 + j;
		assert.equal(autoBuild(ctx, s.current, due - 1), false, `after ${k} failures: not before ${minutes} min`);
		const v = view(ctx, s.current.threadId);
		assert.deepEqual([v.nextAutoAt, v.backoff], [due, { failures: k, code: "model" }], `after ${k} failures the view names the next try and why`);
		assert.equal(autoBuild(ctx, s.current, due), true, `after ${k} failures: at ${minutes} min`);
		at = due;
		await settled(ctx, s.current);
	}
	failing = false;
	s.current = session({ id: "pi:sess-backoff", count: count += 2 });
	assert.equal(autoBuild(ctx, s.current, at + 120 * 60_000 + j), true);
	assert.equal((await settled(ctx, s.current)).job?.state, "done");
	s.current = session({ id: "pi:sess-backoff", count: count += 2 });
	at += 120 * 60_000 + j;
	assert.equal(view(ctx, s.current.threadId).backoff, null, "a success clears the backoff");
	assert.equal(autoBuild(ctx, s.current, at + AUTO_BUILD_INTERVAL_MS), true, "after a success the 10 min cadence resumes");
	await settled(ctx, s.current);
});

test("arc auto build: a hub restart reads the backoff from the Build log (failure: every restart re-fired the failed Sessions at once)", async () => {
	const s = { current: session({ id: "pi:sess-restart" }) };
	const { ctx } = context("auto-restart", s, true);
	const now = Date.now();
	assert.equal(autoBuild(ctx, s.current, now), true);
	await settled(ctx, s.current);
	s.current = session({ id: "pi:sess-restart", count: 18 });
	assert.equal(autoBuild(ctx, s.current, now + AUTO_BUILD_INTERVAL_MS + 60_000), true);
	await settled(ctx, s.current);
	s.current = session({ id: "pi:sess-restart", count: 20 });
	const restarted = context("auto-restart", s, true), last = Date.parse(buildLog(restarted.ctx, s.current.threadId).at(-1)!.startedAt);
	assert.equal(autoBuild(restarted.ctx, s.current, last + 15 * 60_000), false, "2 failures in the log: 20 min, not 10");
	assert.equal(autoBuild(restarted.ctx, s.current, last + 21 * 60_000 + 60_000), true);
	await settled(restarted.ctx, s.current);
});

test("arc auto build: a quota error that names its reset time waits for it; an unparsable reset is logged once with its text and uses the backoff (failure: a session limit failed every 10 min until it reset)", async () => {
	const hk = (after: number) => { const t = new Date(after + 8 * 3600_000); let r = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 4, 20) - 8 * 3600_000; if (r <= after) r += 86_400_000; return r; };
	const warned: string[] = [], warn = console.warn;
	console.warn = (...a: unknown[]) => { warned.push(a.join(" ")); };
	try {
		for (const [name, text] of [["parsed", "Claude Code: You've hit your session limit · resets 4:20am (Asia/Hong_Kong)"], ["unparsed", "Claude Code: You've hit your session limit · resets soon (Mars/Olympus)"]] as const) {
			const s = { current: session({ id: `pi:sess-quota-${name}` }) };
			const { ctx } = context(`auto-quota-${name}`, s);
			Object.assign(ctx, { ask: async () => { throw Object.assign(new Error(`429: ${text}`), { code: "model_error" }); } });
			const now = Date.now();
			assert.equal(autoBuild(ctx, s.current, now), true);
			await settled(ctx, s.current);
			s.current = session({ id: `pi:sess-quota-${name}`, count: 18 });
			const backoff = now + AUTO_BUILD_INTERVAL_MS + autoJitterMs(s.current.threadId);
			const ended = Date.parse(buildLog(ctx, s.current.threadId)[0]!.endedAt!);
			const due = name === "parsed" ? Math.max(backoff, hk(ended)) : backoff;
			assert.equal(autoBuild(ctx, s.current, due - 1), false, `${name}: not before ${new Date(due).toISOString()}`);
			assert.equal(view(ctx, s.current.threadId).nextAutoAt, due);
			view(ctx, s.current.threadId);
			assert.equal(autoBuild(ctx, s.current, due), true, `${name}: at ${new Date(due).toISOString()}`);
			await settled(ctx, s.current);
		}
	} finally { console.warn = warn; }
	const logged = warned.filter((w) => w.includes("Mars/Olympus"));
	assert.equal(logged.length, 1, `the unparsable reset text is logged once: ${JSON.stringify(warned)}`);
	assert.equal(warned.filter((w) => w.includes("Asia/Hong_Kong")).length, 0);
});

test("arc auto build: a live Session with new messages and no automatic Build start for over 4 h logs one line with the reason (failure: an Arc went stale for hours with no trace)", async () => {
	const s = { current: session({ id: "pi:sess-quiet" }) };
	const { ctx } = context("auto-quiet", s);
	const now = Date.now();
	assert.equal(autoBuild(ctx, s.current, now), true);
	await settled(ctx, s.current);
	s.current = session({ id: "pi:sess-quiet", count: 20, summary: { activity: "streaming" } });
	const warned: string[] = [], warn = console.warn;
	console.warn = (...a: unknown[]) => { warned.push(a.join(" ")); };
	try {
		assert.equal(autoBuild(ctx, s.current, now + 3 * 3600_000), false);
		assert.equal(warned.length, 0, "not before 4 h");
		for (let i = 0; i < 3; i++) assert.equal(autoBuild(ctx, s.current, now + 4 * 3600_000 + 1 + i), false);
	} finally { console.warn = warn; }
	assert.equal(warned.length, 1, JSON.stringify(warned));
	assert.match(warned[0]!, /devbox\/pi:sess-quiet.*4 h.*not at a stop/);
});

test("arc auto build: a quota failure with no new messages builds the same input once more, at the later of its backoff and the named reset (failure: an idle Session's Arc never caught up after a session limit)", async () => {
	const s = { current: session({ id: "pi:sess-quota-idle" }) };
	const { ctx, run } = context("auto-quota-idle", s), inner = ctx.ask.bind(ctx);
	let quota = true;
	Object.assign(ctx, { ask: async (req: Parameters<PiViewContext["ask"]>[0]) => {
		if (quota) throw Object.assign(new Error("429: Claude Code: You've hit your session limit · resets 4:20am (Asia/Hong_Kong)"), { code: "model_error" });
		return inner(req);
	} });
	const now = Date.now();
	assert.equal(autoBuild(ctx, s.current, now), true);
	await settled(ctx, s.current);
	const ended = Date.parse(buildLog(ctx, s.current.threadId)[0]!.endedAt!);
	const t = new Date(ended + 8 * 3600_000);
	let reset = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 4, 20) - 8 * 3600_000; if (reset <= ended) reset += 86_400_000;
	const due = Math.max(now + AUTO_BUILD_INTERVAL_MS + autoJitterMs(s.current.threadId), reset);
	assert.equal(autoBuild(ctx, s.current, due - 1), false, "not before the reset");
	quota = false;
	assert.equal(autoBuild(ctx, s.current, due), true, "the same input builds once after the reset");
	assert.equal((await settled(ctx, s.current)).job?.state, "done");
	assert.ok(run.calls > 0);
});

test("arc auto build: a Build log from before error codes still gets the one retry for a busy or quota failure, counts in the backoff, and never stalls (failure: Sessions whose last record was an uncoded slot-cap failure never built again on the same input)", async () => {
	for (const [name, error, retries] of [["busy", "three model calls are already running", true], ["limit", "429: Claude Code: You've hit your session limit · resets 4:20am (Asia/Hong_Kong)", true], ["changed", "Session changed during Build arc. Retry on its current content.", false]] as const) {
		const s = { current: session({ id: `pi:sess-legacy-${name}` }) };
		const { ctx } = context(`auto-legacy-${name}`, s);
		// One record as the hub wrote it before error codes: no errorCode.
		const now = Date.now(), startedAt = new Date(now - 3 * 3600_000).toISOString();
		writeFileSync(join(root, `auto-legacy-${name}`, `${createHash("sha256").update(s.current.threadId).digest("hex")}.builds.json`), JSON.stringify([{ trigger: "auto", startedAt, endedAt: startedAt, state: "error", calls: 0, model: null,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }, afterEntryId: null, asOf: 16, error }]));
		assert.deepEqual(view(ctx, s.current.threadId).backoff, { failures: 1, code: null }, `${name}: the record counts as 1 failure`);
		// Its 10 min backoff ended hours ago: the Session builds now, with no stall; a named quota reset can still be ahead.
		const at = name === "limit" ? now + 86_400_000 : now;
		assert.equal(autoBuild(ctx, s.current, at), retries, `${name}: ${retries ? "one retry on the same input" : "the same input does not build again"}`);
		if (!retries) { s.current = session({ id: s.current.threadId, count: 18 }); assert.equal(autoBuild(ctx, s.current, at), true, `${name}: a new message builds now`); }
		assert.equal((await settled(ctx, s.current)).job?.state, "done");
	}
});

// Pi Team Bright Workers: the typed role from the Teams frame, never a pane or Session name.
const worker = { team: { teamId: "t", role: "worker" as const, worker: "w1" } };

test("arc auto build: a Worker Session never builds automatically; Build arc still does (failure: every Worker stop paid for an Arc nobody opened)", async () => {
	const s = { current: session({ summary: worker, id: "pi:sess-worker" }) };
	const { ctx, run } = context("worker-auto", s);
	const c = fakeClock(T + 10_800_000);
	try {
		assert.equal(autoBuild(ctx, s.current), false, "a qualifying Worker stop does not build");
		assert.equal(c.scheduled.length, 0, "and sets no timer");
		const v = arcValue(ctx, s.current);
		assert.equal(v.nextAutoAt, null, "no pending flag");
		assert.equal(v.autoOff, "worker", "the panel can say why");
		assert.equal(run.calls, 0);
	} finally { c.restore(); }
	buildArc(ctx, s.current);
	assert.equal((await settled(ctx, s.current)).job?.state, "done", "Build arc runs for a Worker");
	assert.equal(run.calls, CALLS);
	assert.deepEqual(buildLog(ctx, s.current.threadId).map((b) => b.trigger), ["manual"]);
	for (const [name, summary] of [["lead", { team: { teamId: "t", role: "lead" as const } }], ["no role", {}]] as const) {
		const l = { current: session({ summary, id: `pi:sess-${name.replace(" ", "-")}` }) };
		const r = context(`worker-other-${name.replace(" ", "-")}`, l);
		assert.equal(autoBuild(r.ctx, l.current, Date.now()), true, `a ${name} Session still builds automatically`);
		assert.equal((await settled(r.ctx, l.current)).autoOff, null);
	}
});

test("arc auto build: opening a Worker's outdated Arc does not rebuild it (failure: the view upgrade bypassed the Worker rule)", async () => {
	const s = { current: session({ summary: worker, id: "pi:sess-worker-format" }) };
	const first = context("worker-format", s);
	buildArc(first.ctx, s.current);
	assert.equal((await settled(first.ctx, s.current)).job?.state, "done");
	const dir = join(root, "worker-format"), file = join(dir, readdirSync(dir).find((f) => /^[0-9a-f]{64}\.json$/.test(f))!);
	const raw = JSON.parse(readFileSync(file, "utf8"));
	writeFileSync(file, JSON.stringify({ ...raw, step2Version: "older-step-2", context: { ...raw.context, format: "older-step-2" } }));
	const again = context("worker-format", s), c = fakeClock(Date.now() + AUTO_BUILD_INTERVAL_MS + 1);
	try {
		const opened = arcValue(again.ctx, s.current);
		assert.notEqual(opened.job?.state, "running", "no rebuild starts");
		assert.equal(opened.contextStatus.formatChanged, true, "the format notice stays");
		assert.equal(opened.nextAutoAt, null);
		assert.equal(c.scheduled.length, 0);
		assert.equal(again.run.calls, 0);
		assert.equal(buildLog(again.ctx, s.current.threadId).length, 1);
	} finally { c.restore(); }
});

// The verify harness and the preview wait for hub-start Builds through /api/health, so it counts the role wait in
// `roleWaits`. `builds` counts Builds only: verify/run.mjs fails a step in which `builds` grows without a Build.
test("arc auto build: before the first Teams frame a stop waits for the role, then builds when no Worker role arrives or after 30 s (failure: a Worker built before its role was read, an unread role pended forever, or /api/health missed the wait or counted it as a Build)", async () => {
	const idle = roleWaitQueue().pending, started = () => buildQueue().pending + buildQueue().done;
	for (const arrives of [true, false]) {
		const s = { current: session({ id: `pi:sess-unknown-${arrives}` }) };
		const { ctx, run } = context(`worker-unknown-${arrives}`, s);
		const known = { v: false };
		Object.assign(ctx, { rolesKnown: () => known.v });
		const c = fakeClock(T + 14_400_000), before = started();
		try {
			const t0 = c.t;
			assert.equal(autoBuild(ctx, s.current), false, "an unknown role does not build");
			assert.equal(run.calls, 0);
			assert.equal(roleWaitQueue().pending, idle + 1, "/api/health counts the wait");
			assert.equal(started(), before, "the wait is not a Build");
			assert.equal(c.scheduled.length, 1, "one re-check timer");
			assert.ok(c.scheduled[0]!.ms <= 5_000, "the re-check comes within 5 s");
			if (arrives) {
				known.v = true;
				c.t = t0 + c.scheduled[0]!.ms;
				c.scheduled[0]!.run();
			} else {
				// Each re-check that still waits adds one timer; the first that adds none started the Build.
				for (let seen = 0; seen < c.scheduled.length && seen < 20;) {
					const next = c.scheduled[seen++]!; c.t += next.ms; next.run();
				}
				assert.ok(c.t - t0 >= 30_000 && c.t - t0 <= 35_000, `the bound is 30 s (${c.t - t0} ms)`);
			}
			assert.equal(arcValue(ctx, s.current).job?.state, "running", arrives ? "the role arrived and is not Worker" : "after 30 s the role counts as absent");
		} finally { c.restore(); }
		await settled(ctx, s.current);
		assert.equal(run.calls, CALLS);
		assert.equal(roleWaitQueue().pending, idle, "the wait settles in /api/health");
	}
	// A Worker role that arrives within the bound stops the Build.
	const s = { current: session({ id: "pi:sess-unknown-worker" }) };
	const { ctx, run } = context("worker-unknown-worker", s);
	const known = { v: false };
	Object.assign(ctx, { rolesKnown: () => known.v });
	const c = fakeClock(T + 18_000_000);
	const before = started();
	try {
		autoBuild(ctx, s.current);
		assert.equal(roleWaitQueue().pending, idle + 1, "/api/health counts the wait");
		known.v = true; s.current = session({ id: "pi:sess-unknown-worker", summary: worker });
		const next = c.scheduled.at(-1)!; c.t += next.ms; next.run();
		assert.equal(run.calls, 0);
		assert.equal(arcValue(ctx, s.current).autoOff, "worker");
		assert.equal(arcValue(ctx, s.current).nextAutoAt, null);
	} finally { c.restore(); }
	await Promise.resolve();
	assert.equal(roleWaitQueue().pending, idle, "a wait that ends without a Build settles in /api/health");
	assert.equal(started(), before, "a wait that ends without a Build starts no Build in /api/health (verify/run.mjs: unattributable)");
});
