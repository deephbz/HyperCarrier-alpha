import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThreadSummary } from "../src/shared/protocol.ts";
import { arcCoverage, arcFinished, asksByKind, coverageNote } from "../web/src/views/cos/needs.ts";

// Overview's tier-2 Needs you and Appear finished, from thread-index rows alone (the `arc` head; D16).

const row = (id: string, arc?: ThreadSummary["arc"], over: Partial<ThreadSummary> = {}) => ({ host: "devbox", t: { id, ref: `devbox/${id}`, updatedAt: Date.now(), live: true, ...(arc ? { arc } : {}), ...over } as ThreadSummary });
const arc = (asks: NonNullable<ThreadSummary["arc"]>["asks"], over: Partial<NonNullable<ThreadSummary["arc"]>> = {}) => ({ builtAt: "2026-10-19T00:00:00.000Z", stale: false, newMessages: 0, finished: false, asks, ...over });

test("overview needs: tier-2 asks group by kind in a fixed order, oldest ask first, unknown age last", () => {
	const rows = [
		row("pi:new", arc([{ kind: "decision", n: 1, since: 3000 }, { kind: "blocker", n: 2, since: 100 }])),
		row("pi:old", arc([{ kind: "decision", n: 2, since: 1000 }, { kind: "approval", n: 1, since: 50 }], { stale: true, newMessages: 3 })),
		row("pi:unknown", arc([{ kind: "decision", n: 1, since: null }])),
		row("pi:none", arc([])),
	];
	const groups = asksByKind(rows);
	assert.deepEqual(groups.map((g) => [g.kind, g.rows.map((r) => r.row.t.id)]), [["decision", ["pi:old", "pi:new", "pi:unknown"]], ["approval", ["pi:old"]], ["blocker", ["pi:new"]]]);
	assert.equal(groups[0]!.rows[0]!.stale, true, "a stale Arc's ask stays listed and says so");
});

test("overview needs: the empty card says why, and Appear finished needs a current Arc with every thread done", () => {
	const weekAgo = Date.now() - 7 * 86_400_000;
	assert.equal(coverageNote(arcCoverage([], weekAgo), true), "No Arc is built yet.");
	const mixed = [row("pi:a", arc([])), row("pi:b", arc([], { stale: true, newMessages: 2 })), row("pi:c"), row("pi:d"), row("pi:old", undefined, { live: false, updatedAt: weekAgo - 1 }), row("node", undefined, { ref: undefined })];
	const c = arcCoverage(mixed, weekAgo);
	assert.deepEqual(c, { built: 2, notBuilt: 2, stale: 1 }, "old non-live and node Sessions are not counted");
	const note = coverageNote(c, true);
	assert.match(note, /^No open asks in 2 built Arcs\./);
	assert.match(note, /2 recent Sessions have no Arc/);
	assert.match(note, /1 Arc is out of date/);
	assert.doesNotMatch(coverageNote(c, false), /No open asks/, "a non-empty card only qualifies its coverage");
	assert.equal(coverageNote({ built: 3, notBuilt: 0, stale: 0 }, false), "");
	assert.equal(arcFinished(row("f", arc([], { finished: true })).t), true);
	assert.equal(arcFinished(row("f", arc([], { finished: true, stale: true })).t), false, "an out-of-date Arc never says finished");
	assert.equal(arcFinished(row("f").t), false);
});
