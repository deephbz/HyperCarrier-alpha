import "./bound.ts";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseSeries, record, report } from "../scripts/durable/memory-series.mjs";
import { tempHome } from "./helpers.ts";

const T0 = Date.parse("2026-10-25T00:00:00Z");
const HOUR = 3.6e6;
const series = (points: [hours: number, hub: number, node: number, agent?: number, helpers?: number][]) =>
	parseSeries(["time,hub_MB,agent_MB,node_MB,helpers_MB", ...points.map(([h, hub, node, agent = 0, helpers = 0]) => `${new Date(T0 + h * HOUR).toISOString()},${hub},${agent},${node},${helpers}`)].join("\n"));

test("memory series: a flat series below the limits is recorded as D21 evidence", () => {
	const { lines, stop } = report(series([[0, 300, 200], [12, 301, 200], [24, 302, 200]]), T0 + 7 * 24 * HOUR);
	assert.deepEqual(stop, []);
	assert.match(lines[0]!, /^samples 3 over 24\.0 h, .*; 144\.0 h left in the trial week$/);
	assert.match(lines[1]!, /^hub: first 300\.0 MB, last 302\.0 MB, peak 302\.0 MB, slope 0\.08 MB\/h, projected 314\.0 MB at the trial end \(limit 450 MB\)$/);
	assert.match(lines.at(-1)!, /^RECORD:/);
});

test("memory series: a sample above a step 6 limit or a slope that projects past one stops the trial", () => {
	assert.deepEqual(report(series([[0, 300, 200], [1, 455, 200], [2, 300, 200]]), T0 + 3 * HOUR).stop, ["a hub sample reached 455.0 MB, above 450 MB"]);
	// The hub stays flat. hub+node rises 2 MB/h from 660 MB; 72 h are left, so it projects 852 MB, past 800.
	const { lines, stop } = report(series([[0, 300, 360], [12, 300, 384], [24, 300, 408]]), T0 + 96 * HOUR);
	assert.deepEqual(stop, ["the hub+node slope projects 852.0 MB at the trial end, above 800 MB"]);
	assert.match(lines.at(-1)!, /^STOP: run runbook step 7\. the hub\+node slope projects/);
	assert.throws(() => report(series([[0, 300, 200]]), T0), /a slope needs 2 samples/);
	assert.throws(() => parseSeries("time,rss\n"), /not a memory series/);
});

test("memory series: a large Pi agent is separate from hub; helpers do not trigger the three split limits", () => {
	const split = series([[0, 199, 80, 472, 600], [24, 199, 80, 472, 600]]);
	const { lines, stop } = report(split, T0 + 7 * 24 * HOUR);
	assert.deepEqual(stop, []);
	assert.ok(lines.some((line) => /^hub\+agent: first 671\.0 MB/.test(line)));
	assert.ok(lines.some((line) => /^helpers: first 600\.0 MB/.test(line)));
	assert.deepEqual(report(series([[0, 300, 80, 500], [1, 300, 80, 501]]), T0 + HOUR).stop,
		["a hub+agent sample reached 801.0 MB, above 800 MB"]);
	assert.deepEqual(report(series([[0, 300, 80, 360], [12, 300, 80, 384], [24, 300, 80, 408]]), T0 + 96 * HOUR).stop,
		["the hub+agent slope projects 852.0 MB at the trial end, above 800 MB"]);
	assert.deepEqual(report(series([[0, 300, 500], [1, 300, 501]]), T0 + HOUR).stop,
		["a hub+node sample reached 801.0 MB, above 800 MB"]);
});

test("memory series: legacy CSV checks only the aggregate ceiling and makes no hub-alone claim", () => {
	const legacy = (hub: number) => parseSeries(`time,hub_MB,node_MB\n2026-10-25T00:00:00Z,${hub},200\n2026-10-26T00:00:00Z,${hub},200\n`);
	const { lines, stop } = report(legacy(671), T0 + 7 * 24 * HOUR);
	assert.deepEqual(stop, [], "the old aggregate above 450 is not a hub-alone violation");
	assert.ok(lines.some((line) => line.includes("Legacy CSV") && line.includes("hub-alone") && line.includes("unknown")));
	assert.ok(lines.some((line) => line.startsWith("legacy hub-tree:")));
	assert.ok(!lines.some((line) => line.startsWith("hub:") || line.startsWith("hub+node:")));
	assert.deepEqual(report(legacy(801), T0 + 24 * HOUR).stop, ["a legacy hub-tree sample reached 801.0 MB, above 800 MB"]);
});

test("memory series: split writes cannot corrupt an existing legacy CSV or hide missing columns", async () => {
	const out = join(tempHome(), "legacy.csv");
	const legacy = "time,hub_MB,node_MB\n2026-10-25T00:00:00Z,671,80\n";
	writeFileSync(out, legacy);
	let sampled = false;
	await assert.rejects(record({ out, everyMs: 0, count: 1, sample: () => { sampled = true; return { hub: 199, agent: 472, node: 80, helpers: 0 }; } }), /Use a new output file/);
	assert.equal(sampled, false);
	assert.equal(readFileSync(out, "utf8"), legacy);
	for (const row of ["2026-10-25T00:00:00Z,199,472,80", "2026-10-25T00:00:00Z,199,,80,0", "2026-10-25T00:00:00Z,199,472,80,-1"])
		assert.throws(() => parseSeries(`time,hub_MB,agent_MB,node_MB,helpers_MB\n${row}`), /invalid memory sample/);
	assert.throws(() => report([...parseSeries(legacy), ...series([[24, 199, 80, 472]])], T0), /cannot mix legacy/);
});

test("memory series: record appends one row per sample, skips a failed one, and stops at the count", async () => {
	const out = join(tempHome(), "memory.csv");
	let call = 0;
	const values = [{ hub: 301.26, agent: 123.45, node: 99.94, helpers: 6.66 }, undefined, { hub: 302, agent: 124, node: 100, helpers: 0 }];
	await record({
		out,
		everyMs: 0,
		count: 3,
		now: () => new Date(T0 + call * 600_000),
		sample: () => {
			const value = values[call++];
			if (!value) throw new Error("missing root 4242");
			return value;
		},
	});
	assert.equal(readFileSync(out, "utf8"), "time,hub_MB,agent_MB,node_MB,helpers_MB\n2026-10-25T00:00:00.000Z,301.3,123.5,99.9,6.7\n2026-10-25T00:20:00.000Z,302.0,124.0,100.0,0.0\n");
	assert.equal(call, 3);
});
