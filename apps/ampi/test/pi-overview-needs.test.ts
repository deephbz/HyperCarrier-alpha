import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThreadSummary } from "../src/shared/protocol.ts";
type ArcHead = NonNullable<ThreadSummary["arc"]>;
import { arcCoverage, arcNeedsRows, coverageNote } from "../web/src/views/cos/needs.ts";

const row = (id: string, arc?: ArcHead, over: Partial<ThreadSummary> = {}) => ({ host: "devbox", t: { id, title: id, cwd: "/synthetic", createdAt: 0, kind: "thread", activity: "idle", queued: 0, ref: `devbox/${id}`, updatedAt: Date.now(), live: true, ...(arc ? { arc } : {}), ...over } as ThreadSummary });
const head = (needsYou: number, oldestAt?: string, stale = 0): ArcHead => ({ needsYou, oldestAt, stale });

test("Overview orders Arc Needs-you Sessions by oldest point and excludes closed history", () => {
	const rows = [row("pi:new", head(3, "2026-10-20T03:00:00Z")), row("pi:old", head(2, "2026-10-20T01:00:00Z", 4)), row("pi:unknown", head(1)), row("pi:none", head(0)), row("pi:closed", head(2), { closed: { at: 2, by: "owner" } }), row("pi:archived", head(2), { archived: true })];
	assert.deepEqual(arcNeedsRows(rows).map((r) => r.t.id), ["pi:old", "pi:new", "pi:unknown"]);
});

test("Overview qualifies absent and stale receipts without claiming work finished", () => {
	const weekAgo = Date.now() - 7 * 86_400_000;
	assert.equal(coverageNote(arcCoverage([], weekAgo), true), "No Arc is built yet.");
	const mixed = [row("pi:a", head(0)), row("pi:b", head(0, undefined, 2)), row("pi:c"), row("pi:d"), row("pi:old", undefined, { live: false, updatedAt: weekAgo - 1 }), row("node", undefined, { ref: undefined })];
	const coverage = arcCoverage(mixed, weekAgo);
	assert.deepEqual(coverage, { built: 2, notBuilt: 2, stale: 1 });
	const note = coverageNote(coverage, true);
	assert.match(note, /^Nothing needs you in 2 built Arcs\./);
	assert.match(note, /2 recent Sessions have no Arc/);
	assert.match(note, /1 Arc is out of date/);
	assert.doesNotMatch(note, /finished/);
	assert.equal(coverageNote({ built: 3, notBuilt: 0, stale: 0 }, false), "");
});
