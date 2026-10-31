import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

// touch-axis.ts: one axis decision per touch drag for the drawer swipe and the reader's scroll inputs. A fake window
// carries touch-shaped events. The import has no effect: tests that stub `window` as a bare object import it too.
(globalThis as { window?: unknown }).window = globalThis;
const { installTouchAxis, lockAxis, onAxisLock, touchAxis } = await import("../web/src/touch-axis.ts");
const target = new EventTarget();
(globalThis as { window?: EventTarget }).window = target;
const uninstall = installTouchAxis();

function fire(type: string, ...points: [number, number][]) {
	const event = new Event(type);
	const touches = type === "touchend" || type === "touchcancel" ? [] : points.map(([clientX, clientY], identifier) => ({ identifier, clientX, clientY }));
	Object.defineProperty(event, "touches", { value: touches });
	target.dispatchEvent(event);
}

test("the lock waits for 10 px, then takes x only for a mostly sideways drag", () => {
	assert.equal(lockAxis(6, 6), "pending");
	assert.equal(lockAxis(16, 10), "x");
	assert.equal(lockAxis(15, 10), "y", "|dx| = 1.5·|dy| is no sideways drag");
	assert.equal(lockAxis(-12, 0), "x");
	assert.equal(lockAxis(0, -12), "y");
});

test("a drag holds its axis until the finger lifts, and the lock reports once", () => {
	const locks: string[] = [];
	const unbind = onAxisLock((_event, axis) => locks.push(axis));
	assert.equal(touchAxis(), "y", "no drag reads as today's reader input");
	fire("touchstart", [100, 100]);
	assert.equal(touchAxis(), "pending");
	fire("touchmove", [104, 101]);
	assert.equal(touchAxis(), "pending", "the first pixels of a drag are no reader input yet");
	fire("touchmove", [130, 102]);
	fire("touchmove", [131, 160]);
	assert.equal(touchAxis(), "x", "a later vertical move keeps the sideways lock");
	fire("touchend");
	assert.equal(touchAxis(), "y");
	fire("touchstart", [100, 100]);
	fire("touchmove", [102, 140]);
	fire("touchmove", [180, 141]);
	assert.equal(touchAxis(), "y", "a later sideways move keeps the vertical lock");
	fire("touchcancel");
	assert.deepEqual(locks, ["x", "y"]);
	unbind();
});

test("a second install only counts; the last uninstall stops the axis", () => {
	const second = installTouchAxis();
	second();
	second();
	fire("touchstart", [100, 100]);
	assert.equal(touchAxis(), "pending", "the first install still holds");
	fire("touchend");
	uninstall();
	fire("touchstart", [100, 100]);
	assert.equal(touchAxis(), "y", "no install: no drag");
	installTouchAxis();
});

test("a second finger makes the drag a pinch: reader input, no sideways drag", () => {
	fire("touchstart", [100, 100]);
	fire("touchstart", [100, 100], [200, 200]);
	assert.equal(touchAxis(), "y");
	fire("touchend");
});
