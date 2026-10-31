import "./bound.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import type { HostState } from "../src/hub/hosts.ts";
import type { ThreadSummary } from "../src/shared/protocol.ts";

type Notice = { title: string; body: string; host: string; threadId: string };

// One Needs-you derivation over every ask source: a live signal (error, node, pane) or an open Arc ask. The
// notifier, the Dock count and Overview read it, so an agent that asks while the owner is away raises one Needs-you
// notification, and a run that only ends raises Finished. Renders the web code through Vite's SSR loader
// (failure: verifier D-asks-away-once, owner away, the Arc ask card displays, no notification).

const web = fileURLToPath(new URL("../web/", import.meta.url));
let vite: ViteDevServer;
let util: typeof import("../web/src/util.ts");
let notices: (before: Map<string, ThreadSummary>, data: never, current: undefined, away: boolean) => Notice[];
let notice: (props: object) => unknown;
let overview: (props: object) => unknown;
let notify: (title: string, body: string, host: string, threadId: string) => void;
let needsYouCount: (data: never) => number;
let badges: (props: object) => unknown;
let timelineStream: (props: object) => unknown;

before(async () => {
	// client.ts opens its hub WebSocket at import; this stub never connects. attention.ts installs window.ampiOpen.
	Object.assign(globalThis, { location: { protocol: "http:", host: "127.0.0.1:1", hash: "" }, WebSocket: class { send() {} close() {} }, window: globalThis, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, document: { activeElement: null } });
	vite = await createServer({ configFile: `${web}vite.config.ts`, root: web, logLevel: "silent", server: { middlewareMode: true, hmr: false } });
	util = (await vite.ssrLoadModule("/src/util.ts")) as typeof util;
	({ notices, notify, needsYouCount } = await vite.ssrLoadModule("/src/attention.ts"));
	overview = (await vite.ssrLoadModule("/src/components/Overview.tsx")).Overview;
	notice = (await vite.ssrLoadModule("/src/components/ThreadView.tsx")).NoticeEntry;
	badges = (await vite.ssrLoadModule("/src/components/Sidebar.tsx")).ThreadBadges;
	timelineStream = (await vite.ssrLoadModule("/src/views/cos/Timeline.tsx")).TimelineStream;
});
after(async () => { await vite?.close(); });

const host = { id: "devbox", link: "devbox", kind: "durable" } as unknown as HostState;
const thread = (over: Partial<ThreadSummary> = {}): ThreadSummary => ({ id: "tree-a.7", title: "Worker", updatedAt: 1, activity: "idle", queued: 0, control: true, live: true, ...over }) as ThreadSummary;
const arc = (asks: NonNullable<ThreadSummary["arc"]>["asks"], stale = false): ThreadSummary["arc"] => ({ builtAt: "2026-10-25T00:00:00Z", stale, newMessages: 0, finished: false, asks });
const decision = [{ kind: "decision" as const, n: 1, since: 1000 }];
const step = (from: ThreadSummary, to: ThreadSummary, away = true) =>
	notices(new Map([[`devbox|${from.id}`, from]]), [{ host, threads: [to], stale: false }] as never, undefined, away);

test("needs you: retired Team and Rarebit sources from old nodes do not ask the owner", () => {
 const retired = thread({ attention: [{ source: "Team", reason: "Task api blocked" }, { source: "Rarebit", reason: "review" }, { source: "rarebit", reason: "old spelling" }], rarebit: { status: "needs_attention", fresh: true, reason: "review" } as ThreadSummary["rarebit"] });
 assert.deepEqual(util.attentionOf({ ...retired, lastError: "provider failed" }), [{ source: "error", reason: "provider failed" }]);
 assert.equal(util.needsYou(retired), undefined);
 assert.deepEqual(step(thread(), retired), [], "a blocked Task raises no notification");
 assert.equal(util.needsYou({ ...retired, arc: arc(decision) }), "Arc: 1 open decision");
 const page = renderToStaticMarkup(createElement(overview as never, { data: [{ host, threads: [retired], stale: false }], onNew() {}, onHostSetup() {}, onHelp() {} }));
 assert.match(page, /Needs you <span class="hint">0<\/span>/);
 assert.equal(needsYouCount([{ host, threads: [retired], stale: false }] as never), 0);
 for (const active of [{ ...retired, arc: arc(decision) }, { ...retired, lastError: "provider failed" }]) {
  const data = [{ host, threads: [active], stale: false }] as never;
  assert.equal(needsYouCount(data), 1);
  const shown = renderToStaticMarkup(createElement(overview as never, { data, onNew() {}, onHostSetup() {}, onHelp() {} }));
  assert.match(shown, /Needs you <span class="hint">1<\/span>/);
  assert.deepEqual(step(retired, active).map((n) => n.title), ["Needs you: Worker"]);
 }
});

test("needs you: an open Arc ask is a Needs-you reason, for the Dock count and Overview alike; a closed thread has none", () => {
	assert.equal(util.needsYou(thread({ arc: arc(decision) })), "Arc: 1 open decision");
	assert.equal(util.needsYou(thread({ arc: arc([{ kind: "approval", n: 2, since: null }, { kind: "input", n: 1, since: 5 }]) })), "Arc: 2 open approvals, 1 open input request");
	assert.equal(util.needsYou(thread({ arc: arc([]) })), undefined, "an Arc with no open ask needs nothing");
	assert.equal(util.needsYou(thread({ arc: arc(decision), closed: { at: 2, by: "owner" } })), undefined, "a closed thread never needs the owner");
	assert.equal(util.needsYou(thread({ arc: arc(decision), lastError: "529 overloaded" })), "529 overloaded", "a live signal leads");
	assert.deepEqual(util.attentionOf(thread({ arc: arc(decision) })), [], "attentionOf stays the live signals; Overview lists asks by kind");
	const row = (t: ThreadSummary) => renderToStaticMarkup(createElement(badges as never, { t, compact: true }));
	assert.doesNotMatch(row(thread({ arc: arc(decision) })), /Needs you|>!</, "the sidebar has no attention badge");
	assert.doesNotMatch(row(thread({ arc: arc(decision), closed: { at: 2, by: "owner" } })), /Needs you/);
});

test("sidebar: errors, retired signals and Arc asks never show an exclamation badge; queue and Team metadata stay", () => {
 for (const over of [{ lastError: "provider failed" }, { attention: [{ source: "Team", reason: "Task api blocked" }] }, { arc: arc(decision) }]) {
  const html = renderToStaticMarkup(createElement(badges as never, { t: thread({ ...over, queued: 2, team: { teamId: "demo", role: "lead" } }), compact: true }));
  assert.doesNotMatch(html, /!|badge (?:err|attn)|Needs you/);
  assert.match(html, /2 ↵/);
  assert.match(html, />team</);
 }
});

test("needs you: away, an agent that asks raises exactly one Needs-you notification; the same open ask on a rebuild raises none", () => {
	const settled = thread({ preview: "Decision needed: A or B?" });
	const asked = thread({ preview: "Decision needed: A or B?", arc: arc(decision) });
	const raised = step(settled, asked);
	assert.deepEqual(raised.map(({ title, host, threadId }) => ({ title, host, threadId })), [{ title: "Needs you: Worker", host: "devbox", threadId: "tree-a.7" }]);
	assert.match(raised[0]!.body, / · Arc: 1 open decision$/);
	assert.deepEqual(step(asked, thread({ ...asked, arc: arc(decision, true) })), [], "a stale head with the same asks is no new transition");
	assert.deepEqual(step(thread({ activity: "streaming" }), asked).map((n) => n.title), ["Needs you: Worker"], "a run that ends with its ask published raises Needs you, never Finished as well");
});

test("needs you: away, a run that only ends raises Finished; a later Arc ask replaces it on the same thread tag", () => {
	const ended = thread({ preview: "Done." });
	const finished = step(thread({ activity: "streaming" }), ended);
	assert.deepEqual(finished.map((n) => n.title), ["Finished: Worker"]);
	const asked = step(ended, thread({ ...ended, arc: arc(decision) }));
	assert.deepEqual(asked.map((n) => n.title), ["Needs you: Worker"]);
	assert.equal(`${asked[0]!.host}|${asked[0]!.threadId}`, `${finished[0]!.host}|${finished[0]!.threadId}`, "one notification tag per thread, so a browser shows only the newer");
});

test("needs you: away, resolving one of two asks stays silent; a grown count or a new ask kind raises Needs you", () => {
	const two = thread({ arc: arc([{ kind: "decision", n: 2, since: 1000 }]) });
	const one = thread({ arc: arc([{ kind: "decision", n: 1, since: 1000 }]) });
	assert.deepEqual(step(two, one), [], "a shrink resolves an ask; it never pings");
	assert.deepEqual(step(one, two).map((n) => n.body.split(" · ").at(-1)), ["Arc: 2 open decisions"]);
	const approval = thread({ arc: arc([{ kind: "decision", n: 1, since: 1000 }, { kind: "approval", n: 1, since: 2000 }]) });
	assert.deepEqual(step(two, approval).map((n) => n.title), ["Needs you: Worker"], "a new kind is a new ask, even while the total stays 2");
	assert.deepEqual(step(thread({ arc: arc(decision), lastError: "529 overloaded" }), thread({ arc: arc(decision) })), [], "a cleared error leaves the same ask, already notified");
});

test("needs you: Overview groups only the asks of threads that need the owner; a closed thread's kept Arc ask is history", () => {
	const data = (threads: ThreadSummary[]) => [{ host: { id: "devbox", label: "devbox", kind: "pi-local", status: "connected", attempts: 0, link: "devbox#pi" }, threads, stale: false }];
	const page = (threads: ThreadSummary[]) => renderToStaticMarkup(createElement(overview as never, { data: data(threads), onNew() {}, onHostSetup() {}, onHelp() {} }));
	const open = page([thread({ arc: arc(decision) })]);
	assert.match(open, /data-kind="decision"/);
	assert.match(open, /Needs you <span class="hint">1<\/span>/);
	const closed = page([thread({ arc: arc(decision), closed: { at: 2, by: "owner" } })]);
	assert.doesNotMatch(closed, /data-kind="decision"/, "Overview agrees with the Dock count");
	assert.match(closed, /Needs you <span class="hint">0<\/span>/);
});

test("needs you: the macOS shell gets the thread tag, so a later Needs you replaces Finished there too", () => {
	const posted: unknown[] = [];
	Object.assign(globalThis, { webkit: { messageHandlers: { ampi: { postMessage: (m: unknown) => posted.push(m) } } } });
	try {
		notify("Finished: Worker", "devbox · Done.", "devbox", "tree-a.7");
		notify("Needs you: Worker", "devbox · Arc: 1 open decision", "devbox", "tree-a.7");
	} finally {
		delete (globalThis as { webkit?: unknown }).webkit;
	}
	assert.deepEqual(posted.map((m) => (m as { tag?: string }).tag), ["devbox|tree-a.7", "devbox|tree-a.7"]);
});

test("needs you: a notification opens the Session's one route, which names the Host by Host ID", () => {
	const posted: unknown[] = [];
	Object.assign(globalThis, { webkit: { messageHandlers: { ampi: { postMessage: (m: unknown) => posted.push(m) } } } });
	try {
		notify("Needs you: lead", "devbox · asks", "devbox#pi", "pi:sess-a");
	} finally {
		delete (globalThis as { webkit?: unknown }).webkit;
	}
	assert.equal((posted[0] as { route?: string }).route, util.href.thread("devbox", "pi:sess-a"));
	assert.equal((posted[0] as { route?: string }).route, "#/h/devbox/t/pi%3Asess-a");
});

test("Timeline: current Needs-you agrees with Overview; Team blockers and historical errors stay facts without a waiting flag", () => {
 const row = (summary: ThreadSummary) => {
  const session = { host: host.id, threadId: summary.id, ref: `${host.id}/${summary.id}`, title: summary.title, start: 0, end: 1000, live: true, blocked: false, waiting: false, marks: [[500, "old-error", "error"]], buckets: [], entries: [[500, "old-error"]], summary };
  return renderToStaticMarkup(createElement(timelineStream as never, { label: "Worker", band: { key: session.ref, group: { key: session.ref, team: false, members: [session], start: 0, end: 1000 }, title: session.title, members: [session], target: session, team: false, buckets: [], start: 0, end: 1000 }, from: 0, to: 1000, bucketMs: 1000, unit: 1, scale: 0, color: 0, focus: false, now: 1000, onHover() {}, seen: new Map(), total: 0 }));
 };
 const blocked = thread({ attention: [{ source: "Team", reason: "Task api blocked" }] });
 assert.doesNotMatch(row(blocked), /cos-waiting|cos-wait-label/);
 assert.match(row(thread({ arc: arc(decision) })), /cos-waiting/);
 assert.match(row(thread({ lastError: "provider failed" })), /cos-waiting/);
 assert.doesNotMatch(row(thread({ lastError: "provider failed", closed: { at: 2, by: "owner" } })), /cos-waiting/);
 const archived = thread({ archived: true, lastError: "provider failed", arc: arc(decision) });
 const history = row(archived);
 assert.match(history, /cos-stream-row/, "archived history keeps its Timeline lane");
 assert.doesNotMatch(history, /cos-waiting|cos-wait-label/, "archived error and Arc asks never need the owner");
 assert.equal(util.needsYou(archived), undefined);
 assert.deepEqual(util.attentionOf(archived), []);
 assert.deepEqual(step(thread(), archived), []);
 const data = [{ host, threads: [archived, thread({ id: "quiet.1", title: "Quiet" })], stale: false }] as never;
 assert.equal(needsYouCount(data), 0);
 const page = renderToStaticMarkup(createElement(overview as never, { data, onNew() {}, onHostSetup() {}, onHelp() {} }));
 assert.match(page, /Needs you <span class="hint">0<\/span>/);
});

test("needs you: away, a cleared signal that leaves an older one shown is silent", () => {
	const node = { source: "node", reason: "waiting on approval" };
	const before = thread({ lastError: "529 overloaded", attention: [node] });
	assert.deepEqual(step(before, thread({ attention: [node] })), [], "the error cleared; the node signal was already shown");
});

test("needs you: away, a second live signal raises Needs you while the first stays", () => {
	const node = { source: "node", reason: "waiting on approval" };
	const added = step(thread({ attention: [node] }), thread({ attention: [node, { source: "node", reason: "parked: provider refused the request" }] }));
	assert.deepEqual(added.map((n) => n.title), ["Needs you: Worker"], "a second signal is new even while the first stays");
});
