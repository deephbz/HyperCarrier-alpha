import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorAt, groupSessions, laneOffset, orderGroups, scrollFor, timelineRows, type Group, type RowSession } from "../web/src/views/cos/rows.ts";

type S = RowSession & { live: boolean; needs?: boolean };
const s = (ref: string, start: number, end: number, extra: Partial<S> = {}): S => ({ ref, host: "devbox", start, end, live: false, ...extra });
// Interleaved activity: Team alpha (lead started after one of its Workers, one Worker closed), Team beta (lead out of
// range), solo Sessions between them, and Team alpha's name reused on another Host.
const fleet: S[] = [
	s("solo-1", 10, 20),
	s("a-w1", 12, 40, { team: "alpha", role: "worker" }),
	s("b-w1", 14, 30, { team: "beta", role: "worker" }),
	s("a-lead", 15, 50, { team: "alpha", role: "lead", live: true }),
	s("solo-2", 16, 60),
	s("a-w2", 18, 25, { team: "alpha", role: "worker" }), // closed: recorded membership only
	s("b-lead", 1, 5, { team: "beta", role: "lead" }),
	s("b-w2", 22, 45, { team: "beta", role: "worker", needs: true }),
	s("other-a", 11, 30, { host: "other", team: "alpha", role: "lead" }),
];
const rank = (g: Group<S>) => Math.max(0, ...g.members.map((m) => m.needs ? 2 : 0));
const shown = (m: S) => m.live || (m.end >= 10 && m.start <= 100);
const rows = (merged: boolean, focus?: string) => timelineRows(orderGroups(groupSessions(fleet), rank, focus), merged, shown).map((r) => r.key);

test("Separate mode lists each Team's members together, lead first, in the merged order", () => {
	assert.deepEqual(rows(true), ["team:devbox/beta@1", "solo-1", "team:other/alpha@11", "team:devbox/alpha@15", "solo-2"]);
	// beta needs you, so it leads; its lead is out of range and stays out of the expanded rows.
	assert.deepEqual(rows(false), ["b-w1", "b-w2", "solo-1", "other-a", "a-lead", "a-w1", "a-w2", "solo-2"]);
});

test("Toggling changes rows only inside Team groups", () => {
	const groupsOf = (merged: boolean) => [...new Set(timelineRows(orderGroups(groupSessions(fleet), rank), merged, shown).map((r) => r.group.key))];
	assert.deepEqual(groupsOf(false), groupsOf(true));
});

test("Focus moves the whole group, not one member", () => {
	assert.deepEqual(rows(false, "a-w2").slice(0, 3), ["a-lead", "a-w1", "a-w2"]);
	assert.deepEqual(rows(true, "a-w2")[0], "team:devbox/alpha@15");
});

test("A merged Team row opens its lead and carries every member's spend; a Team without a present lead targets its first member", () => {
	const merged = timelineRows(orderGroups(groupSessions(fleet), rank), true, shown);
	const alpha = merged.find((r) => r.key === "team:devbox/alpha@15")!;
	assert.equal(alpha.target.ref, "a-lead");
	assert.deepEqual(alpha.members.map((m) => m.ref), ["a-lead", "a-w1", "a-w2"]);
	const noLead = timelineRows(groupSessions(fleet.filter((m) => m.ref !== "b-lead")), true, shown).find((r) => r.key === "team:devbox/beta@14")!;
	assert.equal(noLead.target.ref, "b-w1");
});

test("The reader's place survives a toggle: the top group stays at the same offset", () => {
	const ROW = 56;
	const groups = orderGroups(groupSessions(fleet), rank);
	const separate = timelineRows(groups, false, shown), merged = timelineRows(groups, true, shown);
	// Scrolled 10 px into a-w1, the second row of Team alpha.
	const top = separate.findIndex((r) => r.key === "a-w1") * ROW + 10;
	const anchor = anchorAt(separate, top, ROW)!;
	assert.deepEqual(anchor, { group: "team:devbox/alpha@15", row: 1, px: 10 });
	// Merged, alpha has one row: the place clamps to it. Expanding again restores the member row.
	assert.equal(scrollFor(merged, anchor, ROW), merged.findIndex((r) => r.key === "team:devbox/alpha@15") * ROW + 10);
	assert.equal(scrollFor(separate, anchorAt(merged, scrollFor(merged, anchor, ROW)!, ROW)!, ROW), separate.findIndex((r) => r.key === "a-lead") * ROW + 10);
	assert.equal(scrollFor(merged, { group: "gone", row: 0, px: 0 }, ROW), undefined);
});

test("A reused Team name stays two groups: each lead starts a lifetime, and a member joins the latest earlier lead", () => {
	const reused: S[] = [
		s("x-lead-1", 10, 30, { team: "x", role: "lead" }),
		s("x-w-early", 8, 20, { team: "x", role: "worker" }), // started before any lead: joins the earliest lifetime
		s("x-w-1", 12, 28, { team: "x", role: "worker" }),
		s("x-lead-2", 40, 60, { team: "x", role: "lead" }),
		s("x-w-2", 42, 55, { team: "x", role: "worker" }),
	];
	const groups = groupSessions(reused).map((g) => [g.key, g.members.map((m) => m.ref)]);
	assert.deepEqual(groups, [["team:devbox/x@10", ["x-lead-1", "x-w-early", "x-w-1"]], ["team:devbox/x@40", ["x-lead-2", "x-w-2"]]]);
});

test("the lane offset follows whichever element scrolls the lanes, at any display zoom", () => {
	const rect = (top: number, height = 0) => ({ top, height }) as DOMRect;
	const el = (top: number, page?: unknown) => ({ getBoundingClientRect: () => rect(top), closest: () => page ?? null }) as never;
	const lanes = (top: number, height: number, offsetHeight = height) => ({ getBoundingClientRect: () => rect(top, height), offsetHeight }) as never;
	// A desktop: the page sits above .cos-scroll, which scrolled its lanes 300 px.
	assert.equal(laneOffset(el(200, el(0)), lanes(-100, 560)), 300);
	// A phone: .cos-scroll moved up with the page; the page clips the lanes 150 px under its top.
	assert.equal(laneOffset(el(-150, el(40)), lanes(-110, 560)), 150);
	// Lanes still below the visible top have scrolled nothing.
	assert.equal(laneOffset(el(300, el(40)), lanes(320, 560)), 0);
	// A 1.25 display zoom: 125 px of client rects is 100 CSS px.
	assert.equal(laneOffset(el(-150, el(0)), lanes(-125, 700, 560)), 100);
});
