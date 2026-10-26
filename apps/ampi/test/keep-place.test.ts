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

test("keep-place tracks a rendered fragment when an entry ID occurs more than once", () => {
	let scrollTop = 100;
	const rows = [{ id: "same", y: 0, height: 40 }, { id: "same", y: 120, height: 40 }, { id: "next", y: 180, height: 40 }];
	// These fragments carry no fragment key: only their entry ID, which repeats.
	const attribute = (id: string) => (name: string) => name === "data-fragment" ? null : id;
	let nodes = rows.map(row => ({ getAttribute: attribute(row.id), getBoundingClientRect: () => ({ top: row.y-scrollTop, bottom: row.y-scrollTop+row.height, height: row.height }) }));
	const el = { get scrollTop() { return scrollTop; }, set scrollTop(value) { scrollTop=value; }, getBoundingClientRect: () => ({top:0}), querySelectorAll: () => nodes } as unknown as HTMLElement;
	const place = capturePlace(el, "[data-id]", "data-id", false);
	restorePlace(el, "[data-id]", "data-id", place);
	assert.equal(scrollTop,100,"an unchanged second fragment must not restore to the first fragment");
	rows[1]!.height+=30;
	restorePlace(el, "[data-id]", "data-id", place);
	assert.equal(scrollTop,100,"resizing the same fragment below its top does not move the reader");
	rows.forEach(row => { row.y+=25; });
	restorePlace(el, "[data-id]", "data-id", place);
	assert.equal(scrollTop,125,"measured movement of that fragment still restores the reader place");
	// The anchor disappears during a projection change. An ambiguous ID cannot name its replacement.
	nodes = [nodes[0]!, {getAttribute:attribute("same"),getBoundingClientRect:()=>({top:5,bottom:45,height:40})}, nodes[2]!];
	rows[2]!.y+=10;
	restorePlace(el, "[data-id]", "data-id", place);
	assert.equal(scrollTop,135,"fall forward to a surviving fragment instead of guessing among duplicate IDs");
	nodes = nodes.slice(1);
	rows[2]!.y+=10;
	restorePlace(el, "[data-id]", "data-id", place);
	assert.equal(scrollTop,145,"one remaining duplicate is not proof that it is the captured fragment");
});

test("keep-place restores a remounted fragment by its fragment key, never by its place among the entry's fragments", () => {
	// One entry e paints fragments A and B; the reader reads B. Every query returns fresh nodes, as a remount does.
	const run = (after: { key: string; y: number }[]) => {
		let scrollTop = 100;
		let rows = [{ key: "e:0", y: 0 }, { key: "e:2", y: 120 }];
		const el = { get scrollTop() { return scrollTop; }, set scrollTop(value) { scrollTop = value; }, getBoundingClientRect: () => ({ top: 0 }),
			querySelectorAll: () => rows.map((row) => ({ getAttribute: (name: string) => name === "data-fragment" ? row.key : "e", getBoundingClientRect: () => ({ top: row.y - scrollTop, bottom: row.y - scrollTop + 40, height: 40 }) })) } as unknown as HTMLElement;
		const place = capturePlace(el, "[data-id]", "data-id", false);
		rows = after;
		restorePlace(el, "[data-id]", "data-id", place);
		return scrollTop;
	};
	// The same entry ID and fragment count in every case: only the fragment key names B.
	assert.equal(run([{ key: "e:4", y: 0 }, { key: "e:2", y: 155 }]), 135, "[A,B] -> [C,B] restores B");
	assert.equal(run([{ key: "e:2", y: 30 }, { key: "e:4", y: 150 }]), 10, "[A,B] -> [B,C] restores B, not the second fragment C");
	assert.equal(run([{ key: "e:4", y: 30 }, { key: "e:6", y: 150 }]), 100, "[A,B] -> [C,D] names no B and refuses");
});

test("keep-place uses an entry-level fallback when all rendered nodes are replaced", () => {
	// This fixture returns fresh nodes on every query, as a remounted projection does.
	const {el, rows} = fixture();
	const place = capturePlace(el, "[data-id]", "data-id", false);
	rows.forEach(row => { row.y += 35; });
	restorePlace(el, "[data-id]", "data-id", place);
	assert.equal(el.scrollTop, 135);
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
