import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error: a plain ESM script without types
import { clockOffset, prepareTrace, scrubText } from "../scripts/perf/browser.mjs";

const TOKEN = "c".repeat(64);

test("perf browser: Chrome's events move onto the epoch clock, processes are named, and the access key is scrubbed", () => {
	const events = [
		{ ph: "M", name: "process_name", pid: 10, tid: 0, ts: 0, args: { name: "Browser" } },
		{ ph: "M", name: "process_name", pid: 11, tid: 0, ts: 0, args: { name: "Renderer" } },
		{ ph: "X", name: "ResourceSendRequest", pid: 11, tid: 5, ts: 100, dur: 7, args: { data: { url: `http://127.0.0.1:1/?k=${TOKEN}`, nested: [`x${TOKEN}y`] } } },
		{ ph: "R", name: "ampi:clock-sync", pid: 11, tid: 5, ts: 250 },
	];
	const offsetUs = clockOffset({ markTraceTs: 250, markPageEpochUs: 1_000_250, pageSkewUs: 40 });
	assert.equal(offsetUs, 1_000_040);
	const text = scrubText(JSON.stringify(prepareTrace(events, { offsetUs, browserPid: 10 })), [TOKEN]);
	assert.ok(!text.includes(TOKEN));
	const out = JSON.parse(text);
	assert.deepEqual(out.filter((e: any) => e.name === "process_name").map((e: any) => [e.pid, e.args.name]), [[10, "browser"], [11, "browser:Renderer"]]);
	assert.equal(out.find((e: any) => e.pid === 10 && e.name === "process_name").args.clockOffsetUs, offsetUs);
	assert.equal(out.find((e: any) => e.name === "ampi:clock-sync").ts, 1_000_290, "the sync mark lands on page epoch + skew");
	assert.equal(out.find((e: any) => e.name === "ResourceSendRequest").args.data.url, "http://127.0.0.1:1/?k=…");
	// A key-shaped value outside the known secrets is still hidden in a link.
	assert.equal(JSON.parse(scrubText(JSON.stringify({ u: `/?k=${"d".repeat(64)}` }))).u, "/?k=…");
});

test("perf browser: with the driver's flag off, the web marks call no performance or frame API", async () => {
	const calls: string[] = [];
	const g = globalThis as any;
	const saved = { window: g.window, mark: performance.mark, raf: g.requestAnimationFrame };
	g.window = {};
	performance.mark = ((name: string) => calls.push(name)) as any;
	g.requestAnimationFrame = () => calls.push("raf");
	try {
		const perf = await import(`../web/src/perf.ts?off=${Date.now()}`);
		for (let i = 0; i < 3; i++) {
			perf.perfMark("switch-start");
			perf.perfMarkOnce("first-data");
			perf.perfMarkPainted("switch-done");
			perf.perfMarkPainted("sessions-listed", true);
		}
	} finally {
		g.window = saved.window;
		performance.mark = saved.mark;
		g.requestAnimationFrame = saved.raf;
	}
	assert.deepEqual(calls, []);
});
