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

// A closed durable thread never needs the owner: its kept parked reason and last error are history, not a
// Needs-you signal. Renders the web code through Vite's SSR loader (failure: product re-review of close outcomes).

const web = fileURLToPath(new URL("../web/", import.meta.url));
let vite: ViteDevServer;
let util: typeof import("../web/src/util.ts");
let badges: (props: object) => unknown;
let notices: (before: Map<string, ThreadSummary>, data: never, current: undefined, away: boolean) => Notice[];

before(async () => {
	// client.ts opens its hub WebSocket at import; this stub never connects. attention.ts installs window.ampiOpen.
	Object.assign(globalThis, { location: { protocol: "http:", host: "127.0.0.1:1", hash: "" }, WebSocket: class { send() {} close() {} }, window: globalThis, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } });
	vite = await createServer({ configFile: `${web}vite.config.ts`, root: web, logLevel: "silent", server: { middlewareMode: true, hmr: false } });
	util = (await vite.ssrLoadModule("/src/util.ts")) as typeof util;
	badges = (await vite.ssrLoadModule("/src/components/Sidebar.tsx")).ThreadBadges;
	notices = (await vite.ssrLoadModule("/src/attention.ts")).notices;
});
after(async () => { await vite?.close(); });

const PARKED = "parked: the model provider refused the request";
const ERROR = "R2_FAILED_REASON: 529 overloaded";
const open = (over: Partial<ThreadSummary> = {}): ThreadSummary => ({ id: "tree-a.7", title: "Lead", updatedAt: 1, activity: "idle", queued: 0, control: true, live: true, ...over }) as ThreadSummary;
const flagged = (over: Partial<ThreadSummary> = {}) => open({ attention: [{ source: "node", reason: PARKED }], lastError: ERROR, rarebit: { status: "needs_attention", fresh: true, reason: "blocked on review" } as ThreadSummary["rarebit"], ...over });
const closed = (over: Partial<ThreadSummary> = {}) => flagged({ live: false, closed: { at: 2, by: "owner" }, ...over });
const host = { id: "devbox", link: "devbox", kind: "durable" } as unknown as HostState;
const html = (t: ThreadSummary, compact: boolean) => renderToStaticMarkup(createElement(badges as never, { t, compact }));

test("closed attention: a closed thread has no Needs-you signal from attention, lastError or Rarebit; an open control keeps error and node signals", () => {
	assert.deepEqual(util.attentionOf(closed()), []);
	assert.equal(util.needsYou(closed()), undefined, "Overview's Needs you card and the Dock count filter on needsYou");
	assert.deepEqual(util.attentionOf(flagged()).map((a) => a.source), ["error", "node"]);
	assert.equal(util.needsYou(flagged()), ERROR);
});

test("closed attention: the compact sidebar never badges attention; noncompact closed feedback hides live signals", () => {
	for (const compact of [true, false]) {
		const shut = html(closed(), compact);
		assert.doesNotMatch(shut, /Needs you|◆!|× error/, `closed, compact=${compact}: ${shut}`);
		if (compact) assert.doesNotMatch(html(flagged(), compact), /Needs you|!|× error/);
		else assert.match(html(flagged(), compact), /◆! parked[\s\S]*× error/);
	}
});

test("closed attention: the Close transition raises no notification; an open thread that starts needing the owner still does", () => {
	const before = new Map([["devbox|tree-a.7", flagged({ attention: undefined, lastError: undefined, rarebit: undefined, activity: "streaming" })]]);
	const data = (t: ThreadSummary) => [{ host, threads: [t], stale: false }] as never;
	assert.deepEqual(notices(before, data(closed()), undefined, true), [], "Close carries the parked reason and last error into a closed row, and ends the run without a Finished");
	const raised = notices(before, data(flagged()), undefined, true);
	assert.deepEqual(raised.map((n) => n.title), ["Needs you: Lead"]);
});

