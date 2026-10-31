import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

// A fake browser history: one entry list with an index, history writes counted (WebKit limits them).
type Entry = { state: unknown; hash: string };
const fake = { entries: [] as Entry[], index: 0, writes: 0 };
const location = { get hash() { return fake.entries[fake.index]!.hash; } };
const history = {
	get state() { return fake.entries[fake.index]!.state; },
	get length() { return fake.entries.length; },
	pushState(state: unknown, _: string, url?: string) {
		fake.writes++;
		fake.entries.splice(fake.index + 1, Infinity, { state: structuredClone(state), hash: url ?? location.hash });
		fake.index++;
	},
	replaceState(state: unknown, _: string, url?: string) {
		fake.writes++;
		fake.entries[fake.index] = { state: structuredClone(state), hash: url ?? location.hash };
	},
	back() { if (fake.index > 0) fake.index--; },
	forward() { if (fake.index < fake.entries.length - 1) fake.index++; },
};
Object.assign(globalThis, { location, history, window: new EventTarget() });

/** A fresh module instance per test, as after a page load on the current fake history. */
let loads = 0;
async function load(entries: Entry[], index = entries.length - 1) {
	Object.assign(fake, { entries, index, writes: 0 });
	return import(`../web/src/nav.ts?load=${loads++}`) as Promise<typeof import("../web/src/nav.ts")>;
}
const state = () => history.state as { id?: string; nav?: number | null; focus?: string; place?: { id: string } };
const session = (thread: string, query = "") => `#/h/local/t/${thread}${query}`;
const overview = "#/v/overview";

test("entryKind: Sessions, pages and entry links are steps; a panel-only change is not", async () => {
	const { entryKind } = await load([{ state: null, hash: overview }]);
	assert.equal(entryKind(overview, session("a")), "push");
	assert.equal(entryKind(session("a"), overview), "push");
	assert.equal(entryKind(session("a"), session("b")), "push");
	assert.equal(entryKind(session("a"), session("a", "?e=m1")), "push");
	assert.equal(entryKind(session("a"), session("a", "?p=rarebit")), "replace");
	assert.equal(entryKind(session("a", "?e=m1"), session("a", "?e=m1&p=team")), "replace");
	assert.equal(entryKind(session("a"), session("b"), "replace"), "replace");
	assert.equal(entryKind("#/h/local", "#/h/other"), "push");
});

test("boot: a fresh tab is depth 0 and Back there stays in AmPi", async () => {
	const nav = await load([{ state: null, hash: "#/other-site" }, { state: null, hash: overview }]);
	assert.deepEqual(nav.arriveEntry(), { kind: "new" });
	assert.equal(state().nav, 0);
	nav.goBack();
	assert.equal(location.hash, overview);
});

test("boot: an entry written before this code is unknown, so Back is allowed", async () => {
	const nav = await load([{ state: null, hash: overview }, { state: { place: { id: "x" } }, hash: session("a") }]);
	assert.deepEqual(nav.arriveEntry(), { kind: "new" });
	assert.equal(state().nav, null);
	assert.deepEqual(state().place, { id: "x" });
	nav.goBack();
	assert.equal(location.hash, overview);
});

test("navigate stamps depth at write time; Back and Forward return each entry's focus", async () => {
	const nav = await load([{ state: null, hash: session("a") }]);
	nav.arriveEntry();
	nav.noteFocus("transcript");
	assert.equal(nav.navigate(overview), true);
	assert.equal(nav.navigate(overview), false, "the current route is no step");
	assert.deepEqual(nav.arriveEntry(), { kind: "same" });
	assert.equal(state().nav, 1);
	nav.noteFocus("page");
	nav.goBack();
	assert.deepEqual(nav.arriveEntry(), { kind: "traverse", focus: "transcript" });
	nav.goBack();
	assert.equal(location.hash, session("a"), "depth 0 blocks Back");
	nav.goForward();
	assert.deepEqual(nav.arriveEntry(), { kind: "traverse", focus: "page" });
	assert.equal(fake.entries.length, 2);
});

test("a hash edit that skips navigate counts as a new step", async () => {
	const nav = await load([{ state: null, hash: overview }]);
	nav.arriveEntry();
	history.pushState(null, "", session("a")); // the address bar or another location.hash writer
	assert.deepEqual(nav.arriveEntry(), { kind: "new" });
	assert.equal(state().nav, 1);
});

test("a reload keeps the entry and returns its focus", async () => {
	const first = await load([{ state: null, hash: session("a") }]);
	first.arriveEntry();
	first.noteFocus("composer");
	first.flushEntry();
	const reloaded = await load(fake.entries);
	assert.deepEqual(reloaded.arriveEntry(), { kind: "traverse", focus: "composer" });
});

test("Find: the first match jump is a step, later jumps replace it, so Back returns to the reading place first", async () => {
	const nav = await load([{ state: null, hash: overview }]);
	nav.arriveEntry();
	nav.navigate(session("a"));
	nav.arriveEntry();
	nav.noteEntry({ place: { id: "reading" } }, nav.entryId());
	const step = nav.findSteps();
	nav.navigate(session("a", "?e=m1"), step());
	nav.arriveEntry();
	nav.noteEntry({ place: { id: "m1" } }, nav.entryId());
	nav.navigate(session("a", "?e=m2"), step());
	nav.navigate(session("a", "?e=m3"), step());
	assert.equal(fake.entries.length, 3, "Overview, the reading place, one Find step");
	assert.equal(location.hash, session("a", "?e=m3"));
	assert.equal(state().place, undefined, "a later match drops the earlier match's place, so the ?e= jump wins");
	nav.goBack();
	nav.arriveEntry();
	assert.equal(location.hash, session("a"));
	assert.deepEqual(state().place, { id: "reading" });
	nav.goBack();
	assert.equal(location.hash, overview, "the second Back leaves the Session");
});

test("a panel-only change replaces the entry and keeps its place", async () => {
	const nav = await load([{ state: null, hash: session("a") }]);
	nav.arriveEntry();
	nav.noteEntry({ place: { id: "p" } }, nav.entryId());
	nav.navigate(session("a", "?p=rarebit"));
	assert.equal(fake.entries.length, 1);
	assert.deepEqual(state().place, { id: "p" });
	assert.equal(state().nav, 0);
});

test("one Session has one route: every link builder names its Host by Host ID", async () => {
	// The notification builder is checked in needs-you-notify.test.ts, which loads attention.ts with the web build.
	const { href, canonicalRoute, parseRoute } = await import("../web/src/util.ts");
	const canonical = "#/h/devbox/t/pi%3Asess-a";
	assert.deepEqual(
		{
			linkKey: href.thread("devbox#pi", "pi:sess-a"),
			hostId: href.thread("devbox", "pi:sess-a"),
			citation: href.ref("devbox/pi:sess-a"),
			oldLink: canonicalRoute("#/h/devbox%23pi/t/pi%3Asess-a"),
		},
		{ linkKey: canonical, hostId: canonical, citation: canonical, oldLink: canonical },
	);
	assert.equal(canonicalRoute("#/h/devbox%23pi"), "#/h/devbox%23pi", "a Host route keeps its link key");
	assert.equal(canonicalRoute("#/h/devbox%23pi/x/term-1"), "#/h/devbox%23pi/x/term-1", "a terminal route keeps its link key");
	for (const malformed of ["#/h/devbox/t/%E0%A4", "#/h/devbox%23pi/t/%E0%A4", "#/h/%E0%A4/t/c1"]) {
		assert.equal(canonicalRoute(malformed), malformed, "a malformed escape stays as typed");
		const { query: _, ...route } = parseRoute(malformed);
		assert.deepEqual(route, { page: "overview", rest: [] }, "a malformed escape names the Overview");
	}
	assert.equal(href.thread("devbox#durable", "t-1", { entry: "m1" }), "#/h/devbox/t/t-1?e=m1");
});

test("an older link-key route arrives in place as the Session's one route; a step to either form pushes nothing", async () => {
	const old = "#/h/devbox%23pi/t/pi%3Asess-a?e=m1";
	const canonical = "#/h/devbox/t/pi%3Asess-a?e=m1";
	const nav = await load([{ state: null, hash: overview }]);
	assert.equal(nav.entryKind(old, canonical), "replace");
	assert.equal(nav.entryKind("#/h/devbox/t/pi%3Asess-a", old), "push", "an entry jump stays a step");
	nav.arriveEntry();
	history.pushState(null, "", old); // a pasted bookmark: the browser's own step
	assert.deepEqual(nav.arriveEntry(), { kind: "new" });
	assert.equal(location.hash, canonical);
	assert.equal(fake.entries.length, 2);
	assert.equal(nav.navigate(old), false, "the old form names the current route");
	assert.equal(nav.navigate(canonical), false);
	assert.equal(fake.entries.length, 2);
	nav.goBack();
	assert.equal(location.hash, overview, "Back leaves the Session in one step");
});

test("an older link-key entry reached by Back is rewritten in place and keeps its state", async () => {
	const nav = await load([{ state: { id: "a", nav: 0, place: { id: "p" } }, hash: "#/h/devbox%23pi/t/pi%3Asess-a" }, { state: { id: "b", nav: 1 }, hash: overview }]);
	nav.arriveEntry();
	nav.goBack();
	assert.equal(nav.arriveEntry().kind, "traverse");
	assert.equal(location.hash, "#/h/devbox/t/pi%3Asess-a");
	assert.deepEqual(state().place, { id: "p" });
	assert.equal(fake.entries.length, 2);
});

test("one Host with a Pi and a durable source: their Sessions never share a route, and a Host route keeps its link key", async () => {
	const nav = await load([{ state: null, hash: overview }]);
	const { href, parseRoute } = await import("../web/src/util.ts");
	const { findHost } = await import("../web/src/components/host-label.ts");
	const hosts = [{ id: "devbox", link: "devbox#pi" }, { id: "devbox", link: "devbox#durable" }];
	const pi = href.thread("devbox#pi", "pi:sess-a");
	const durable = href.thread("devbox#durable", "t1a2b3c.c1");
	assert.notEqual(pi, durable);
	assert.equal(nav.entryKind(pi, durable), "push");
	for (const [route, link] of [[pi, "devbox#pi"], [durable, "devbox#durable"], ["#/h/devbox%23durable", "devbox#durable"], ["#/h/devbox%23pi/x/term-1", "devbox#pi"]] as const) {
		const r = parseRoute(route);
		assert.equal(findHost(hosts, r.host, r.thread)?.link, link, route);
	}
	assert.equal(findHost(hosts, "devbox"), undefined, "a bare Host route is ambiguous here, so no builder writes one");
});

test("focus writes are deferred: 200 focus changes cost one history write (WebKit's 100 per 10 s limit)", async () => {
	const nav = await load([{ state: null, hash: session("a") }]);
	nav.arriveEntry();
	fake.writes = 0;
	for (let i = 0; i < 200; i++) nav.noteFocus(i % 2 ? "transcript" : "composer");
	assert.equal(fake.writes, 0);
	nav.flushEntry();
	assert.equal(fake.writes, 1);
	assert.equal(state().focus, "transcript", "the last focus wins");
});

test("a waiting focus record never lands on the entry the browser moved to", async () => {
	const nav = await load([{ state: null, hash: overview }]);
	nav.arriveEntry();
	nav.navigate(session("a"));
	nav.arriveEntry();
	nav.flushEntry();
	nav.noteFocus("composer");
	history.back(); // the browser's own Back, before the deferred write
	nav.flushEntry();
	assert.equal(state().focus, undefined);
	assert.deepEqual(nav.arriveEntry(), { kind: "traverse", focus: undefined });
});

test("entryState sees a waiting place before it is written, so a remount in the same entry reads the newest place", async () => {
	const nav = await load([{ state: null, hash: overview }, { state: null, hash: session("a") }]);
	nav.arriveEntry();
	nav.noteEntry({ place: { id: "newest" } }, nav.entryId());
	assert.equal(state().place, undefined);
	assert.deepEqual(nav.entryState().place, { id: "newest" });
	history.back(); // a different entry: the waiting patch is not its state
	assert.equal(nav.entryState().place, undefined);
});

/** A hash edit that skips `navigate` (`location.hash =`, a typed URL): the browser adds an unstamped entry. */
function hashEdit(hash: string) {
	fake.entries.splice(fake.index + 1, Infinity, { state: null, hash });
	fake.index++;
}

test("a place noted just before a hash edit survives it, and Back returns that place (T3d back-keeps-place)", async () => {
	const nav = await load([{ state: null, hash: session("a") }]);
	nav.arriveEntry();
	nav.noteEntry({ place: { id: "older" } }, nav.entryId());
	nav.flushEntry();
	nav.noteEntry({ place: { id: "newest" } }, nav.entryId());
	hashEdit(overview); // before the deferred write
	nav.arriveEntry();
	nav.flushEntry();
	assert.equal(state().place, undefined, "the Overview entry gets no Session place");
	history.back();
	assert.equal(nav.arriveEntry().kind, "traverse");
	assert.deepEqual(nav.entryState().place, { id: "newest" }, "this page's newest note beats the older written copy");
	nav.flushEntry();
	assert.deepEqual(state().place, { id: "newest" }, "and reaches the entry's copy once it is current again");
});

test("a note observed on one entry and recorded after a navigation stays on that entry", async () => {
	const nav = await load([{ state: null, hash: session("a") }]);
	nav.arriveEntry();
	const at = nav.entryId();
	nav.navigate(overview);
	nav.arriveEntry();
	nav.noteEntry({ place: { id: "late" } }, at); // ThreadView's scroll frame ran after the navigation
	nav.flushEntry();
	assert.equal(state().place, undefined);
	history.back();
	nav.arriveEntry();
	assert.deepEqual(nav.entryState().place, { id: "late" });
});

test("reading at the newest end clears an older place, so Back follows new messages", async () => {
	const nav = await load([{ state: null, hash: session("a") }]);
	nav.arriveEntry();
	nav.noteEntry({ place: { id: "older" } }, nav.entryId());
	nav.flushEntry();
	nav.noteEntry({ place: undefined }, nav.entryId());
	nav.navigate(overview);
	nav.arriveEntry();
	history.back();
	nav.arriveEntry();
	assert.equal(nav.entryState().place, undefined);
	assert.equal(state().place, undefined);
});

test("the ledger stays bounded: an evicted entry leaves both its notes and its unwritten mark", async () => {
	const nav = await load([{ state: null, hash: session("a") }]);
	nav.arriveEntry();
	const first = nav.entryId();
	nav.noteEntry({ place: { id: "first" } }, first);
	for (let i = 0; i < 500; i++) nav.noteEntry({ place: { id: `p${i}` } }, `left-${i}`);
	assert.equal(nav.entryState().place, undefined, "the oldest notes were evicted");
	fake.writes = 0;
	nav.flushEntry();
	assert.equal(fake.writes, 0, "an evicted entry has nothing left to write");
});

test("known error after deploy: an older null-state entry reloads as depth 0 once, and the next step counts from there", async () => {
	const nav = await load([{ state: null, hash: overview }, { state: null, hash: session("a") }]);
	assert.deepEqual(nav.arriveEntry(), { kind: "new" });
	assert.equal(state().nav, 0);
	nav.navigate(overview);
	assert.equal(state().nav, 1);
});

test("carrier: AmPi.app owns ⌘[ / ⌘]; a plain browser keeps its own Back", async () => {
	const { carrier } = await load([{ state: null, hash: overview }]);
	assert.equal(carrier(), "browser");
	Object.assign(window, { webkit: { messageHandlers: { ampi: {} } } });
	try {
		assert.equal(carrier(), "app");
	} finally {
		delete (window as { webkit?: unknown }).webkit;
	}
});
