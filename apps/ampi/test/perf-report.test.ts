import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-ignore: the perf scripts are plain ESM.
import { checkLimits, hostLoad, indexRate, parseTrace, profileShift, profileStats, profileThread, profileToEvents, quantile, spanTable } from "../scripts/perf/report.mjs";
// @ts-ignore: the perf scripts are plain ESM.
import { compareSummaries, hostLine, summarizeGroup } from "../scripts/perf/compare.mjs";

test("perf report: parseTrace reads arrays, traceEvents objects, and unterminated files with a torn last line", () => {
	assert.deepEqual(parseTrace('[{"a":1}]'), [{ a: 1 }]);
	assert.deepEqual(parseTrace('{"traceEvents":[{"a":1}]}'), [{ a: 1 }]);
	assert.deepEqual(parseTrace('[\n{"a":1},\n{"a":2}\n,{"a":3}\n,{"a":'), [{ a: 1 }, { a: 2 }, { a: 3 }]);
	assert.deepEqual(parseTrace(""), []);
});

test("perf report: quantile interpolates and the median of an even list is the midpoint", () => {
	assert.equal(quantile([4, 1, 3, 2], 0.5), 2.5);
	assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 0.95), 10.5);
	assert.equal(quantile([], 0.5), undefined);
});

test("perf report: spanTable subtracts nested children from self time, per thread", () => {
	const x = (name: string, ts: number, dur: number, tid = 0) => ({ ph: "X", pid: 1, tid, cat: "startup", name, ts, dur });
	const { stats, topLevel } = spanTable([x("outer", 0, 100), x("inner", 10, 30), x("inner", 50, 20), x("other", 0, 500, 1), x("gc", 5, 1)].map((e) => (e.name === "gc" ? { ...e, cat: "gc" } : e)));
	const by = (name: string) => stats.find((s: { name: string }) => s.name === name);
	assert.deepEqual([by("outer").total, by("outer").self], [100, 50]);
	assert.deepEqual([by("inner").count, by("inner").total, by("inner").self], [2, 50, 50]);
	assert.equal(by("gc"), undefined, "GC events are not spans");
	assert.deepEqual(topLevel.get("1:0").map((e: { name: string }) => e.name), ["outer"]);
	assert.deepEqual(topLevel.get("1:1").map((e: { name: string }) => e.name), ["other"]);
});

test("perf report: indexRate compares the last 10% of jobs per second with the first 10%", () => {
	// 100 jobs: the first 10 at 10 ms apart, the last 10 at 40 ms apart (a 4x slowdown).
	const ends: number[] = [];
	let t = 0;
	for (let i = 0; i < 100; i++) ends.push((t += i < 50 ? 10_000 : 40_000));
	const rate = indexRate(ends, t + 1);
	assert.equal(rate.jobs, 100);
	assert.equal(rate.complete, true);
	assert.equal(rate.tailRatio, 0.25);
	assert.equal(rate.perSecond.reduce((a: number, b: number) => a + b, 0), 100);
	assert.equal(indexRate([], undefined).complete, false);
});

test("perf report: checkLimits gives pass, FAIL, or no data only for the scenario's limits", () => {
	const summary = {
		run: { scenario: "startup" }, external: { healthMs: 120, loopWallMs: 12_000 }, milestones: { listen: 400 },
		eld: { postListenMaxMs: 20 }, switches: {}, memory: { idleRssMb: 300 },
	};
	const limits = Object.fromEntries(checkLimits(summary).map((l: { id: string; pass: boolean | null }) => [l.id, l.pass]));
	assert.deepEqual(limits, { health: true, "hub-start": true, "post-listen-block": true, "idle-rss": true, "loop-wall": false });
	const index = checkLimits({ ...summary, run: { scenario: "index" }, index: { complete: true, tailRatio: 0.4 } });
	assert.deepEqual(index.map((l: { id: string; pass: boolean | null }) => [l.id, l.pass]), [["idle-rss", true], ["index-complete", true], ["index-rate-tail", false]]);
	const missing = checkLimits({ ...summary, run: { scenario: "switch" } });
	assert.equal(missing.find((l: { id: string }) => l.id === "switch-first-p95").pass, null);
	const app = checkLimits({ ...summary, run: { scenario: "app" }, scenario: { stats: { "open→window-shown": 420, "open→first-session-row-painted": 1300 } } });
	assert.deepEqual(app.map((l: { id: string; pass: boolean | null }) => [l.id, l.pass]), [["app-window", true], ["app-first-row", false], ["idle-rss", true], ["loop-wall", false]]);
});

/** A profile with one root, a `work` function and the clock-sync spin; samples every 1000 µs on V8's clock. */
function syntheticProfile(startTime: number) {
	const frame = (functionName: string) => ({ functionName, url: "file:///x/apps/ampi/src/trace.ts", lineNumber: 9, columnNumber: 0, scriptId: "1" });
	const nodes = [
		{ id: 1, callFrame: frame("(root)"), children: [2, 3, 4] },
		{ id: 2, callFrame: frame("(idle)") },
		{ id: 3, callFrame: frame("ampiTraceClockSync") },
		{ id: 4, callFrame: frame("work") },
	];
	const samples = [3, 3, 3, 4, 4, 2, 2, 2, 2, 4];
	return { nodes, startTime, endTime: startTime + 10_000, samples, timeDeltas: samples.map(() => 1000) };
}

test("perf report: profileStats splits busy and idle; profileShift maps the profile clock with the clock-sync spin", () => {
	const profile = syntheticProfile(5_000_000);
	const stats = profileStats(profile);
	assert.equal(stats.busy, 6000);
	assert.equal(stats.idle, 4000);
	const work = stats.functions.find((f: { fn: string }) => f.fn === "work");
	assert.deepEqual([work.self, work.where], [3000, "apps/ampi/src/trace.ts:10"]);
	// Spin samples cover profile time 5_001_000..5_004_000 (midpoint 5_002_500); the trace saw it at 9e12..+3000.
	const sync = { ph: "X", name: "clock-sync", pid: 7, tid: 0, ts: 9e12, dur: 3000 };
	assert.equal(profileShift([sync], profile, 7, 0), 9e12 + 1500 - 5_002_500);
	assert.equal(profileShift([sync], profile, 7, 1), undefined);
	assert.deepEqual(profileThread("CPU.20261019.093000.123.4.001.cpuprofile"), { pid: 123, tid: 4 });
});

test("perf compare: group medians, pass counts, and noise-banded verdicts", () => {
	const run = (health: number, rss: number, pass = true) => ({
		metrics: { "limit health": health, "idle rss MB": rss, "limit index-rate-tail": 0.6 },
		limits: [{ id: "health", label: "Health", target: "≤ 500", unit: "ms", value: health, pass }],
	});
	const a = [run(100, 300), run(110, 300), run(120, 300)];
	const group = summarizeGroup(a);
	assert.equal(group.metrics["limit health"].median, 110);
	assert.deepEqual(group.limits[0], { id: "health", label: "Health", target: "≤ 500", unit: "ms", pass: 3, fail: 0, noData: 0, median: 110, max: 120 });
	assert.equal(group.metrics["limit health"].mad, 10);
	const rows = Object.fromEntries(compareSummaries(a, [run(80, 305), run(85, 300), run(90, 310), run(600, 300, false)]).rows.map((r: { metric: string }) => [r.metric, r]));
	assert.equal(rows["limit health"].verdict, "better", "median 87.5 vs 110 is outside 2 × MAD 10, despite the 600 ms outlier");
	assert.equal(rows["idle rss MB"].verdict, "≈", "a 2.5 MB delta is inside 2 × MAD 2.5");
	assert.equal(rows["limit index-rate-tail"].verdict, "≈");
});

test("perf report: CPU stack slices nest exactly, so Perfetto needs no overflow track", () => {
	const frame = (id: number, functionName: string, children: number[] = []) => ({ id, callFrame: { functionName, url: "", lineNumber: 0 }, children });
	// root → a → b → c. Sub-microsecond deltas and a fractional shift used to stretch short frames past their parent.
	const profile = { nodes: [frame(1, "(root)", [2]), frame(2, "a", [3]), frame(3, "b", [4]), frame(4, "c")], startTime: 0, samples: [2, 3, 4, 2, 4, 3, 2], timeDeltas: [0, 0.4, 0.3, 0.2, 0.6, 0.35, 0.5] };
	const events = profileToEvents(profile, { pid: 1, tid: 1, shiftUs: 1000.33 });
	assert.ok(events.length > 0);
	for (const e of events) {
		assert.ok(Number.isInteger(e.ts) && Number.isInteger(e.dur) && e.dur > 0, `${e.name} has whole, positive µs`);
		for (const o of events) {
			if (o === e) continue;
			const overlaps = o.ts < e.ts + e.dur && e.ts < o.ts + o.dur;
			const nested = (o.ts >= e.ts && o.ts + o.dur <= e.ts + e.dur) || (e.ts >= o.ts && e.ts + e.dur <= o.ts + o.dur);
			assert.ok(!overlaps || nested, `${e.name} and ${o.name} overlap partially`);
		}
	}
});

test("perf report: a run is provisional below 50% CPU idle, under memory pressure, or without a CPU reading", () => {
	const normal = { level: "normal", freePct: 60 };
	assert.equal(hostLoad({ cpuIdlePct: 72, memoryBefore: normal, memoryAfter: normal }).provisional, false);
	assert.equal(hostLoad({ cpuIdlePct: 49.9, memoryBefore: normal, memoryAfter: normal }).provisional, true);
	const warned = hostLoad({ cpuIdlePct: 90, memoryBefore: normal, memoryAfter: { level: "warn", freePct: 10 } });
	assert.deepEqual([warned.memory, warned.provisional], ["warn", true]);
	assert.equal(hostLoad({ memoryBefore: normal }).provisional, true);
	// The group line reads the same per-run host record the report writes.
	const line = hostLine([{ host: hostLoad({ cpuIdlePct: 72, memoryBefore: normal, memoryAfter: normal }) }, { host: warned }]);
	assert.match(line, /CPU idle median 81%, 72–90% · memory normal\/warn · provisional 1\/2/);
});
