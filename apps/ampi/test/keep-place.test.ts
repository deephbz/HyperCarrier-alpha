import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { capturePlace, leftBottom, restorePlace } from "../web/src/keep-place.ts";

function fixture() {
	let scrollTop = 100;
	let rows = [{ id: "a", y: 80 }, { id: "b", y: 140 }, { id: "c", y: 200 }];
	const nodes = () => rows.map((row) => ({ getAttribute: () => row.id, getBoundingClientRect: () => ({ top: row.y - scrollTop + 20, bottom: row.y - scrollTop + 70, height: 50 }) }));
	const el = { get scrollTop() { return scrollTop; }, set scrollTop(value) { scrollTop = value; }, scrollHeight: 1000, getBoundingClientRect: () => ({ top: 20 }), querySelectorAll: nodes } as unknown as HTMLElement;
	return { el, rows, remove: (id: string) => { rows = rows.filter((r) => r.id !== id); } };
}

test("keep-place restores the same screen height after content changes", () => {
	const { el, rows } = fixture();
	const place = capturePlace(el, "[data-id]", "data-id", false);
	rows.forEach((row) => { row.y += 80; });
	restorePlace(el, "[data-id]", "data-id", place);
	assert.equal(el.scrollTop, 180);
});

test("keep-place falls forward to a surviving anchor", () => {
	const { el, rows, remove } = fixture();
	const place = capturePlace(el, "[data-id]", "data-id", false);
	remove("a");
	rows[1].y += 30;
	restorePlace(el, "[data-id]", "data-id", place);
	assert.equal(el.scrollTop, 130);
});

test("keep-place follows the bottom and tolerates no surviving anchor", () => {
	const { el } = fixture();
	restorePlace(el, "[data-id]", "data-id", { bottom: true, anchors: [] });
	assert.equal(el.scrollTop, 1000);
	restorePlace(el, "[data-id]", "data-id", { bottom: false, anchors: [{ id: "gone", top: 0, offset: 0 }] });
	assert.equal(el.scrollTop, 1000);
});

test("keep-place sees a reader leave the bottom before the scroll event arrives", () => {
	const at = (scrollTop: number, scrollHeight = 1000) => ({ scrollTop, scrollHeight, clientHeight: 400 }) as unknown as HTMLElement;
	assert.equal(leftBottom(at(0), 600), true);
	assert.equal(leftBottom(at(599), 600), false);
	// Content shrank under a pinned reader: the browser clamped scrollTop, but the reader is still at the bottom.
	assert.equal(leftBottom(at(400, 800), 600), false);
	// Content grew under a pinned reader: scrollTop did not move up.
	assert.equal(leftBottom(at(600, 1400), 600), false);
	// One render collapses 300 px above and appends 100 px below a following reader. With scroll anchoring off the browser
	// keeps scrollTop unless the new height clamps it, and a clamp lands at the bottom.
	assert.equal(leftBottom(at(400, 800), 600), false);
	// It collapses 100 px above and appends 300 px below: scrollTop stays.
	assert.equal(leftBottom(at(600, 1200), 600), false);
});
