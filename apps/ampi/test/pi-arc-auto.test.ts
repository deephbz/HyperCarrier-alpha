import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cosDemo } from "../scripts/demo/cos.ts";
import type { DemoContext } from "../scripts/demo/index.ts";
import { ask } from "../src/pi/ask.ts";
import type { Chunk } from "../src/pi/views/cos-arc-chunks.ts";
import { AUTO_BUILD_INTERVAL_MS, arcClock, autoBuild, buildArc, buildLog, cosArc, type ArcValue } from "../src/pi/views/cos-arc.ts";
import type { PiViewContext, PiViewSession } from "../src/pi/views/types.ts";
import type { ThreadSummary } from "../src/shared/protocol.ts";

// The automatic Arc trigger (D16, owner option A) through the real ask runner and the offline demo model.

const root = mkdtempSync(join(tmpdir(), "ampi-arc-auto-"));
cosDemo({ dir: root, agentDir: join(root, "agent") } as DemoContext);
const model = [process.execPath, join(root, "cos-model.cjs")];
const T = Date.parse("2026-10-19T00:00:00.000Z");
const chunks: Chunk[] = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, index: i, hash: `h${i}`, startAt: new Date(T + i * 60_000).toISOString(), endAt: new Date(T + i * 60_000 + 30_000).toISOString(), firstEntryId: `u${i}`, lastEntryId: `a${i}`, firstAsk: `Step ${i}`, lastOwnerEntryId: `u${i}`, ownerTurns: 1, entries: 2, toolCalls: 0, where: null, idleBeforeMs: null, compactionEntryId: null }));
const CALLS = Math.ceil(chunks.length / 6) + 2;

function session(over: { summary?: Partial<ThreadSummary>; stopped?: boolean; count?: number; chunks?: Chunk[] } = {}) {
	return { threadId: "pi:sess-a", ref: "devbox/pi:sess-a", sourceVersion: "v1",
		summary: { cwd: "/work/demo", live: true, activity: "idle", queued: 0, ...over.summary },
		data: { arc: { chunks: over.chunks ?? chunks }, rarebit: { count: over.count ?? 16, fingerprint: "f".repeat(64) }, timeline: { stopped: over.stopped ?? true, marks: [[T, "u7", "stop"], [T + 1, "a7", "stop"]] } },
		rarebits: () => ({ items: [], more: false, sourceVersion: "v1" }),
		arcEvidence: (ids: string[]) => new Map(ids.map((id) => { const i = id.slice(1); return [id, `[u${i}] USER: Run step ${i}.\n[a${i}] AGENT: Step ${i} landed and tests pass.`]; })),
		entryTimes: (ids: string[]) => new Map(ids.map((id) => [id, T + Number(id.slice(1)) * 60_000])) } as unknown as PiViewSession;
}

function context(name: string, s: { current: PiViewSession }, fail = false) {
	const run = { calls: 0 };
	const dir = join(root, name); mkdirSync(dir, { recursive: true });
	const ctx = { host: "devbox", stateDir: () => dir, session: () => s.current, lease: () => () => {}, invalidate() {}, snapshot: <T>(read: () => T) => read(),
		async ask(req: Parameters<PiViewContext["ask"]>[0]) {
			run.calls++;
			await new Promise((r) => setTimeout(r, 5));
			if (fail) throw Object.assign(new Error("model_error: synthetic failure"), { code: "model_error" });
			return { ...(await ask(req, model)), usage: { input: 1000, output: 100, cost: 0.01 } };
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
	assert.equal(run.calls, CALLS + 2, "unchanged chunks reuse their labels; the second Build calls only synthesis and the tree");
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
		assert.equal(run.calls, CALLS + 2, "the follow-up reuses every label");
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
