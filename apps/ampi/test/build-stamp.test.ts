import "./bound.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildOrder, compare, controlSkew, controlStamp, skewText, stamp, type Stamp, VERSION_SKEW } from "../src/shared/build.ts";
// @ts-expect-error: the control package is plain JavaScript.
import { controlStamp as ownControlStamp } from "../../../packages/pi-hc-control/src/stamp.mjs";

const s = (id: string, order: number, line: Stamp["line"] = "stable"): Stamp => ({ id, order, line });

test("compare: equal versions are the same build, whatever the order or line says", () => {
	assert.equal(compare(s("aaa", 10), s("aaa", 10)), "same");
	assert.equal(compare(s("aaa", 10, "stable"), s("aaa", 20, "durable")), "same");
});

test("compare: the greater build order is newer, across lines too", () => {
	assert.equal(compare(s("aaa", 20), s("bbb", 10)), "older");
	assert.equal(compare(s("aaa", 10), s("bbb", 20)), "newer");
	assert.equal(compare(s("aaa", 10, "stable"), s("bbb", 20, "durable")), "newer", "the line is not compared");
	assert.equal(compare(s("aaa", 20, "durable"), s("bbb", 10, "stable")), "older");
});

test("compare: a tie in order breaks by version text, so both sides agree", () => {
	assert.equal(compare(s("bbb", 10), s("aaa", 10)), "older");
	assert.equal(compare(s("aaa", 10), s("bbb", 10)), "newer");
	for (const [a, b] of [[s("x1", 5), s("x2", 5)], [s("x1", 5), s("x2", 6)]] as const) {
		const ab = compare(a, b), ba = compare(b, a);
		assert.notEqual(ab, "same");
		assert.equal(ba, ab === "older" ? "newer" : "older", "the two sides see opposite directions");
	}
});

test("build order: a directory without git metadata has none and fails", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ampi-no-git-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	assert.throws(() => buildOrder(dir), /No build order: .* not in a git checkout/);
});

test("stamp: this checkout has a version, an order and a line", () => {
	const own = stamp();
	assert.match(own.id, /^[0-9a-f]{12}$/);
	assert.ok(Number.isInteger(own.order) && own.order > 1_600_000_000);
	assert.ok(own.line === "stable" || own.line === "durable");
	assert.equal(stamp(), own, "computed once per process");
});

test("control skew: each direction names the right part; no stamp fails closed; the detail names both stamps", () => {
	const hub = s("hub", 20);
	assert.equal(controlSkew(hub, s("hub", 20), "devbox"), undefined);
	const older = controlSkew(hub, s("ctl", 10), "devbox")!;
	assert.equal(older.code, VERSION_SKEW);
	assert.equal(older.message, skewText.controlOlder("devbox"));
	assert.equal(older.message, "devbox runs an older pi-hc-control. Update it.\nPull pi-hc-control on devbox, then run /reload in each Pi pane there.");
	const newer = controlSkew(hub, s("ctl", 30), "devbox")!;
	assert.equal(newer.message, "This AmPi is older than devbox's pi-hc-control. Update it.\nPull AmPi on this machine, then restart the hub (npm run deploy:live in apps/ampi).");
	const none = controlSkew(hub, null, "devbox")!;
	assert.equal(none.code, VERSION_SKEW);
	assert.equal(none.message, "devbox's pi-hc-control has no build stamp. Update it.\nPull pi-hc-control on devbox, then run /reload in each Pi pane there.");
	assert.match(older.detail, /ctl .*expects hub/);
	assert.match(none.detail, /no stamp; this AmPi expects hub/);
});

test("the hub expects the stamp pi-hc-control computes for itself in this checkout", () => {
	assert.deepEqual(controlStamp(), ownControlStamp());
	assert.match(controlStamp().id, /^[0-9a-f]{12}$/);
});
