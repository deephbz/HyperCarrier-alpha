import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThreadSummary } from "../src/shared/protocol.ts";
import { type PinHost, resolvePin } from "../web/src/components/pin-place.ts";

const t = (id: string) => ({ id, title: id, cwd: "/w", createdAt: 0, updatedAt: 0, kind: "thread", activity: "idle", queued: 0, costUsd: 0 }) as unknown as ThreadSummary;
const host = (id: string, ids: string[], more: Partial<PinHost> = {}): PinHost => ({ host: { id: id.split("#")[0]!, link: id, label: id.split("#")[0]! }, threads: ids.map(t), stale: false, ...more });
const pin = (h: string, threadId = "pi:s1") => ({ host: h, threadId, title: "saved" });

test("pin place: the hinted Host opens it when it lists the Session, even if another route does too", () => {
	const r = resolvePin(pin("devbox"), [host("laptop", ["pi:s1"]), host("devbox", ["pi:s1"])]);
	assert.equal(r.target?.host, "devbox");
	assert.equal(r.moveHint, false);
	assert.equal(r.gone, false);
});

test("pin place: a stale hint resolves to the one Host that lists the Session and moves the hint", () => {
	const r = resolvePin(pin("old-name"), [host("devbox", ["pi:s1"])]);
	assert.equal(r.target?.host, "devbox");
	assert.equal(r.moveHint, true);
	// The hinted Host still loads its list: open the other route, but keep the hint.
	const loading = resolvePin(pin("devbox"), [host("devbox", [], { listing: true }), host("devbox#pi", ["pi:s1"])]);
	assert.equal(loading.target?.host, "devbox#pi");
	assert.equal(loading.moveHint, false);
});

test("pin place: two Hosts list it and neither is the hint: a choice, no target", () => {
	const r = resolvePin(pin("old-name"), [host("devbox", ["pi:s1"]), host("devbox#pi", ["pi:s1"])]);
	assert.equal(r.target, undefined);
	assert.deepEqual(r.listed.map((x) => x.host), ["devbox", "devbox#pi"]);
	assert.deepEqual(r.listed.map((x) => x.label), ["devbox", "devbox#pi"], "two routes to one Host: the links name the routes");
	assert.equal(r.moveHint, false);
	assert.equal(r.gone, false);
});

test("pin place: gone only once every list is complete", () => {
	assert.equal(resolvePin(pin("devbox"), [host("devbox", [])]).gone, true);
	assert.equal(resolvePin(pin("removed"), [host("devbox", [])]).gone, true, "a removed Host: Not found on removed");
	assert.equal(resolvePin(pin("devbox"), [host("devbox", [], { indexing: true })]).gone, false);
	assert.equal(resolvePin(pin("devbox"), [host("devbox", [], { stale: true })]).gone, false, "a disconnected hinted Host may still hold it");
	assert.equal(resolvePin(pin("devbox"), [host("devbox", []), host("laptop", [], { listing: true })]).gone, false);
	assert.equal(resolvePin(pin("devbox"), []).gone, false, "no Host data yet");
});
