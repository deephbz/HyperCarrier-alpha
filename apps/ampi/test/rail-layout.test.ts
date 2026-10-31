import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { railLayout } from "../web/src/components/rail-layout.ts";

// The prompt rail is a short clean stack, not a ruler (owner-approved C+A mock): it caps at 40 dashes or 40% of the
// strip's height, whichever is smaller; a prompt on screen always shows; below 8 prompts there is no rail. Find marks
// merge when closer than 3 px.

const PITCH = 6;
const cap = (height: number) => Math.min(40, Math.floor((height * 0.4) / PITCH));
const none = new Set<number>();
const range = (from: number, to: number) => new Set(Array.from({ length: to - from }, (_, i) => from + i));

test("railLayout: the stack caps at 40 dashes or 40% of the height, whichever is smaller", () => {
	for (const prompts of [40, 600, 5000]) for (const height of [900, 700, 480, 300]) {
		const layout = railLayout(prompts, none, height)!;
		assert.equal(layout.shown.size, Math.min(prompts, cap(height)), `${prompts} prompts at ${height} px`);
		assert.ok(layout.shown.has(0), "the first prompt anchors the sample");
	}
	assert.equal(railLayout(40, none, 900)!.shown.size, 40, "40 prompts fit a tall strip whole");
	assert.equal(railLayout(40, none, 400)!.shown.size, 26, "40 prompts in a short strip sample 26");
});

test("railLayout: no rail below 8 prompts", () => {
	for (const prompts of [0, 1, 3, 7]) assert.equal(railLayout(prompts, none, 900), undefined);
	assert.equal(railLayout(8, none, 900)!.shown.size, 8);
});

test("railLayout: every prompt on screen shows and displaces its nearest sample, so the count holds", () => {
	const plain = railLayout(600, none, 900)!;
	for (const from of [0, 7, 293, 590]) {
		const inView = range(from, from + 5);
		const layout = railLayout(600, inView, 900)!;
		for (const i of inView) assert.ok(layout.shown.has(i), `prompt ${i} on screen has a dash`);
		assert.equal(layout.shown.size, plain.shown.size, `on-screen prompts from ${from} keep the count`);
		// Samples away from the reader hold still while the reader scrolls: the on-screen prompts displace only their
		// nearest samples (here 600 / 40 = 15 prompts apart).
		const far = [...plain.shown].filter((i) => Math.abs(i - from) > 6 * 15);
		assert.ok(far.every((i) => layout.shown.has(i)), `samples far from ${from} stay`);
	}
	// More prompts on screen than the cap allows: all of them still show.
	const crowd = railLayout(600, range(100, 160), 300)!;
	assert.ok([...range(100, 160)].every((i) => crowd.shown.has(i)));
});

test("railLayout: Find marks sit between the dashes around their prompt, merge closer than 3 px, and keep the current one", () => {
	const height = 900;
	// 10 prompts, all shown: a match in prompt 3's answer sits halfway between dashes 3 and 4.
	const all = railLayout(10, none, height, [{ id: "a", at: 3.5, cur: false }, { id: "p", at: 7, cur: true }])!;
	const top = (height - 10 * PITCH) / 2;
	assert.deepEqual(all.marks, [{ id: "a", y: top + 3.5 * PITCH + PITCH / 2, cur: false }, { id: "p", y: top + 7 * PITCH + PITCH / 2, cur: true }]);
	// A match in every answer of a 600-prompt Session: no two marks closer than 3 px; the current one survives a merge.
	const finds = Array.from({ length: 600 }, (_, i) => ({ id: `h${i}`, at: i + 0.5, cur: i === 301 }));
	const dense = railLayout(600, none, height, finds)!;
	const ys = dense.marks.map((m) => m.y);
	assert.ok(ys.every((y, i) => i === 0 || y - ys[i - 1]! >= 3), "merged marks are at least 3 px apart");
	assert.ok(dense.marks.length < 600 / 4, `${dense.marks.length} marks`);
	assert.equal(dense.marks.filter((m) => m.cur).length, 1);
	// Marks stay within the stack, with a half pitch of slack at either end.
	const stack = dense.shown.size * PITCH, start = (height - stack) / 2;
	assert.ok(ys.every((y) => y >= start - PITCH && y <= start + stack + PITCH), "marks stay on the stack");
	// A match before the first prompt sits just above the first dash.
	assert.equal(railLayout(10, none, height, [{ id: "pre", at: -0.5, cur: false }])!.marks[0]!.y, top);
});
