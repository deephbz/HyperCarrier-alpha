import assert from "node:assert/strict";
import { test } from "node:test";
import { nextTimelineWindow, timelineWindow, windowRange, type TimelineWindow } from "../web/src/views/cos/window.ts";

test("Timeline page cycles 96/48/24/12 hours and Custom returns to 96", () => {
	let current: TimelineWindow = 96;
	for (const expected of [48, 24, 12, 96]) {
		current = nextTimelineWindow(current);
		assert.equal(current, expected);
	}
	assert.equal(nextTimelineWindow("Custom"), 96);
	assert.equal(nextTimelineWindow("Custom", true), 96);
});

test("Timeline panel cycles Session life before the bounded windows", () => {
	let current: TimelineWindow = "Session life";
	for (const expected of [96, 48, 24, 12, "Session life"]) {
		current = nextTimelineWindow(current, true);
		assert.equal(current, expected);
	}
});

test("Timeline window derives from URL range and never exceeds the 96-hour page scope", () => {
	const now = 1_000_000_000;
	for (const hours of [96, 48, 24, 12] as const) {
		const range = windowRange(hours, now);
		assert.equal(range[1], now);
		assert.equal(timelineWindow(...range), hours);
	}
	assert.equal(timelineWindow(), 96);
	assert.equal(timelineWindow(undefined, undefined, true), "Session life");
	assert.equal(timelineWindow(now - 12345, now), "Custom");
	assert.deepEqual(windowRange(120, now), windowRange(96, now));
});
