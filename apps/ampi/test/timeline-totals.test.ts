import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { laneTotal, mergeBuckets, type Bucket, type Unit } from "../web/src/views/cos/totals.ts";

const B = 900_000;
const at = (i: number) => 1_000 * B + i * B;
// A Team of two Sessions; the lead starts 5 minutes into its first bucket.
const lead = { start: at(0) + 300_000, end: at(3) + 600_000, buckets: [[at(0), 1000, 0.1], [at(1), 2000, 0.2], [at(3), 4000, 0.4]] as Bucket[] };
const worker = { start: at(1), end: at(2) + 60_000, buckets: [[at(1), 300, 0.03], [at(2), 500, 0.05]] as Bucket[] };
const sum = (buckets: Bucket[], unit: Unit, from = -Infinity, to = Infinity) => buckets.filter((b) => b[0] >= from && b[0] < to).reduce((n, b) => n + b[unit], 0);
const merged = { start: lead.start, end: lead.end, buckets: mergeBuckets([lead, worker]) };

test("Timeline lane totals equal fixture sums over the full range", () => {
	const range: [number, number] = [at(-4), at(8)];
	for (const unit of [1, 2] as const) {
		for (const lane of [lead, worker]) assert.ok(Math.abs(laneTotal(lane.buckets, lane, range, B, unit) - sum(lane.buckets, unit)) < 1e-9);
		assert.ok(Math.abs(laneTotal(merged.buckets, merged, range, B, unit) - (sum(lead.buckets, unit) + sum(worker.buckets, unit))) < 1e-9);
	}
	assert.equal(laneTotal(merged.buckets, merged, range, B, 1), 7800);
});

test("Timeline lane totals equal fixture sums over a brushed sub-range on bucket edges", () => {
	const range: [number, number] = [at(1), at(3)];
	for (const unit of [1, 2] as const) {
		for (const lane of [lead, worker]) assert.ok(Math.abs(laneTotal(lane.buckets, lane, range, B, unit) - sum(lane.buckets, unit, ...range)) < 1e-9);
		assert.ok(Math.abs(laneTotal(merged.buckets, merged, range, B, unit) - (sum(lead.buckets, unit, ...range) + sum(worker.buckets, unit, ...range))) < 1e-9);
	}
	assert.equal(laneTotal(merged.buckets, merged, range, B, 1), 2800);
});

test("Timeline edge buckets count in proportion to their drawn span inside the range", () => {
	// The lead draws its first bucket for 10 minutes; a range covering the last 5 counts half of it.
	assert.equal(laneTotal(lead.buckets, lead, [at(0) + 600_000, at(1)], B, 1), 500);
	// The last bucket is drawn for 10 minutes up to the lead's last entry.
	assert.equal(laneTotal(lead.buckets, lead, [at(3), at(3) + 300_000], B, 1), 2000);
	assert.equal(laneTotal(lead.buckets, lead, [at(5), at(6)], B, 2), 0);
});
