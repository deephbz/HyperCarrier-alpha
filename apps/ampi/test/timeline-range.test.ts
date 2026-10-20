import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { brushRange, MIN_SPAN, type TimeRange } from "../web/src/views/cos/range.ts";

const minute = MIN_SPAN;
const bounds: TimeRange = [0, 120 * minute];
const initial: TimeRange = [30 * minute, 60 * minute];
test("Timeline brush pans the same span and clamps both full-domain edges", () => {
	assert.deepEqual(brushRange("pan", initial, 40 * minute, 50 * minute, bounds), [40 * minute, 70 * minute]);
	assert.deepEqual(brushRange("pan", initial, 40 * minute, -100 * minute, bounds), [0, 30 * minute]);
	assert.deepEqual(brushRange("pan", initial, 40 * minute, 200 * minute, bounds), [90 * minute, 120 * minute]);
});
test("Timeline brush handles cannot cross or reduce the range below one minute", () => {
	assert.deepEqual(brushRange("start", initial, 0, 90 * minute, bounds), [59 * minute, 60 * minute]);
	assert.deepEqual(brushRange("end", initial, 0, -10 * minute, bounds), [30 * minute, 31 * minute]);
	assert.deepEqual(brushRange("start", initial, 0, -10 * minute, bounds), [0, 60 * minute]);
	assert.deepEqual(brushRange("end", initial, 0, 200 * minute, bounds), [30 * minute, 120 * minute]);
});
test("Timeline brush selection works in either direction, including tiny and out-of-domain drags", () => {
	assert.deepEqual(brushRange("select", initial, 20 * minute, 40 * minute, bounds), [20 * minute, 40 * minute]);
	assert.deepEqual(brushRange("select", initial, 40 * minute, 20 * minute, bounds), [20 * minute, 40 * minute]);
	assert.deepEqual(brushRange("select", initial, 40 * minute, 40 * minute + 1, bounds), [40 * minute, 41 * minute]);
	assert.deepEqual(brushRange("select", initial, 110 * minute, 121 * minute, bounds), [109 * minute, 120 * minute]);
});
