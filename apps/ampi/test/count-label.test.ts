import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { countLabel } from "../web/src/count-label.ts";

// Overview and Timeline use these labels for empty, single-item and multi-item headers.
for (const [noun, labels] of [
	["Session", ["0 Sessions", "1 Session", "2 Sessions"]],
	["Host", ["0 Hosts", "1 Host", "2 Hosts"]],
	["stream", ["0 streams", "1 stream", "2 streams"]],
] as const) {
	test(`count label: ${noun} agrees with zero, one and two`, () => {
		assert.deepEqual([0, 1, 2].map((count) => countLabel(count, noun)), labels);
	});
}
