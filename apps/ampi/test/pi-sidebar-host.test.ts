import "./bound.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";

// Renders the Pi sidebar's Host section through Vite's SSR loader (the web code is browser TSX).

const web = fileURLToPath(new URL("../web/", import.meta.url));
const store = new Map<string, string>();
let vite: ViteDevServer;
let section: (props: object) => unknown;
let fold: typeof import("../web/src/components/host-fold.ts");

before(async () => {
	// client.ts opens its hub WebSocket at import; this stub never connects.
	Object.assign(globalThis, {
		location: { protocol: "http:", host: "127.0.0.1:1", hash: "" },
		WebSocket: class { send() {} close() {} },
		localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
	});
	vite = await createServer({ configFile: `${web}vite.config.ts`, root: web, logLevel: "silent", server: { middlewareMode: true, hmr: false } });
	section = (await vite.ssrLoadModule("/src/components/PiSidebar.tsx")).PiHostSection;
	fold = (await vite.ssrLoadModule("/src/components/host-fold.ts")) as typeof fold;
});
after(async () => { await vite?.close(); });

const ERROR = "agent exited 255: connection to devbox timed out";
const KEY = "ampi.sidebar.hostCollapsed.devbox";
const NOW = Date.now(), WENT_AWAY = NOW - 3_600_000;
const HINT = "Check that `ssh devbox` works; the hub retries.";
type Host = { id: string; label: string; kind: string; status: string; phase?: string; since?: number; hint?: string; error?: string; retryAt?: number; lastSeen?: number; attempts: number };
const away = (over: Partial<Host> = {}): Host => ({ id: "devbox", label: "devbox", kind: "ssh", status: "disconnected", since: WENT_AWAY, error: ERROR, hint: HINT, lastSeen: WENT_AWAY, attempts: 3, ...over });
const render = (host: Host) => renderToStaticMarkup(createElement(section as never, { data: { host, threads: [], stale: false }, route: {}, filter: "" } as never));
const head = (html: string) => /<div class="side-head">[\s\S]*?<\/button>/.exec(html)?.[0] ?? "";
/** What a sighted reader sees: the markup without visually hidden text. */
const visible = (html: string) => html.replace(/<span class="visually-hidden">[\s\S]*?<\/span>/g, "");
const saved = (value: object) => store.set(KEY, JSON.stringify(value));

test("away Host, unfolded: a red dot, a quiet away header, and the full error inside the Host group", () => {
	store.clear();
	const html = render(away());
	assert.match(head(html), /class="dot disconnected"/);
	assert.match(head(html), /<span class="meta">away<\/span>/);
	assert.match(head(html), /title="devbox"/, "the header title stays the Host label");
	assert.ok(visible(html).includes(ERROR) && html.includes("copies readable"), "an unfolded Host shows its error and status detail");
});

test("away Host folded: the dot stays red and Overview keeps the error; folding only hides the error in the sidebar", () => {
	store.clear();
	fold.saveHostFold(away() as never, true);
	for (const html of [render(away()), render(away())]) {
		assert.match(head(html), /class="dot disconnected"/, "folding never acknowledges: the dot stays red");
		assert.match(head(html), /<span class="meta">away<\/span>/);
		assert.match(head(html), /aria-expanded="false"/);
		assert.ok(!visible(html).includes(ERROR) && !html.includes("copies readable"), "a folded Host shows no error or status detail");
		assert.match(head(html), /<span class="visually-hidden">: agent exited 255/, "a screen reader still hears the error");
	}
	assert.ok(fold.linkLine(fold.linkView(away() as never)).includes(ERROR), "Overview shows a folded away Host in full");
});

test("a fold saved by an older build, with its away record, reads as a plain fold", () => {
	store.clear();
	saved({ collapsed: true, awayAtFold: true, at: NOW, error: ERROR });
	const html = render(away());
	assert.match(head(html), /aria-expanded="false"/);
	assert.match(head(html), /class="dot disconnected"/);
	assert.match(head(html), /<span class="meta">away<\/span>/);
});

test("away Host folded, live again, then away again: the dot is green while live and red again when away", () => {
	store.clear();
	fold.saveHostFold(away() as never, true);
	assert.match(head(render(away({ status: "connected", since: undefined, hint: undefined, error: undefined, lastSeen: NOW + 1_000 }))), /class="dot connected"/);
	const again = away({ lastSeen: NOW + 2_000 });
	assert.match(head(render(again)), /class="dot disconnected"/);
	assert.match(head(render(again)), /aria-expanded="false"/, "the fold holds across the reconnect");
	assert.ok(fold.linkLine(fold.linkView(again as never)).includes(ERROR));
});

test("away Host folded, then a different error: the dot stays red and the new error is still folded", () => {
	store.clear();
	fold.saveHostFold(away() as never, true);
	const html = render(away({ error: "Permission denied (publickey)" }));
	assert.match(head(html), /class="dot disconnected"/);
	assert.match(head(html), /<span class="meta">away<\/span>/);
	assert.ok(!visible(html).includes("Permission denied"), "no auto-unfold");
});

test("unavailable Host (no readable copy) folded: the dot stays red", () => {
	store.clear();
	const failed = { ...away(), cacheFailed: true };
	fold.saveHostFold(failed as never, true);
	assert.match(head(render(failed)), /class="dot disconnected"/);
	assert.ok(fold.linkLine(fold.linkView(failed as never)).includes(ERROR));
});

test("retrying Host: the header names the phase and elapsed time, and the last failure and next step stay visible", () => {
	store.clear();
	const html = render(away({ status: "connecting", phase: "hello", since: Date.now() - 12_000, hint: "Waiting for the agent's hello." }));
	assert.match(head(html), /class="dot connecting"/);
	assert.match(head(html), /<span class="meta">connecting · awaiting hello · 1[23] s<\/span>/);
	assert.ok(visible(html).includes(ERROR), "a retry keeps the last failure until a hello arrives");
	assert.ok(visible(html).includes("Waiting for the agent&#x27;s hello."), "the hint says what the link does");
});

test("linkView: each status that is not connected projects its state, failure, and next step", () => {
	const now = 1_000_000;
	assert.deepEqual(fold.linkView({ status: "connected", connectedAt: now } as never, now), { state: "connected" });
	assert.deepEqual(fold.linkView({ status: "connecting", phase: "transport", since: now - 5_000, hint: "Opening ssh." } as never, now), { state: "connecting · opening link · 5 s", hint: "Opening ssh." });
	const down = fold.linkView({ status: "disconnected", since: now, error: "silent", hint: "Restart it.", retryAt: now + 180_000, lastSeen: now - 60_000 } as never, now);
	assert.deepEqual(down, { state: "away · seen 1m ago · retry in 3 min", error: "silent", hint: "Restart it." });
	assert.equal(fold.linkLine(down), "away · seen 1m ago · retry in 3 min — silent — Restart it.");
});

test("connected Host with a failed index write: the dot stays green and a secondary warning names the reason", () => {
	store.clear();
	const html = render({ ...away({ status: "connected", since: undefined, hint: undefined, error: undefined }), indexError: "ENOSPC: no space left on device" } as never);
	assert.match(head(html), /class="dot connected"/);
	assert.match(html, /class="host-note warn" data-index-error="devbox">Index not saved: ENOSPC: no space left on device</);
});

test("connected Host with stale cache reads or a cache fault: the dot stays green and secondary warnings name them", () => {
	store.clear();
	const html = render({ ...away({ status: "connected", since: undefined, hint: undefined, error: undefined }), staleReads: { reopened: 2, behind: 0, refused: 1 } } as never);
	assert.match(head(html), /class="dot connected"/);
	assert.match(html, /class="host-note warn" data-stale-reads="devbox">Stale cache reads: 2 repaired by a reopen, 1 refused in publish. The hub log names each one.</);
	assert.doesNotMatch(render(away({ status: "connected", since: undefined, hint: undefined, error: undefined }) as never), /data-stale-reads/);
	const fault = render({ ...away({ status: "connected", since: undefined, hint: undefined, error: undefined }), cacheFault: "1 Session copy reads behind the derive Worker after a reopen" } as never);
	assert.match(fault, /class="host-note warn" data-cache-fault="devbox">Cache fault: 1 Session copy reads behind the derive Worker after a reopen. Restart the hub if it lasts.</);
});

test("connected Host after an upgrade: a status note counts the Sessions still updating, and each such row says updating", async () => {
	store.clear();
	const connected = away({ status: "connected", since: undefined, hint: undefined, error: undefined });
	const row = { id: "pi:synthetic-session-3", title: "proj3 · 00000000", cwd: "/synthetic/proj3", createdAt: NOW, updatedAt: NOW, kind: "thread", activity: "idle", queued: 0, costUsd: 0, updating: true, live: false, control: false };
	assert.match(render({ ...connected, upgrade: { updated: 3, total: 50 } } as never), /class="host-note" role="status" data-upgrade="devbox">Updating 47 Sessions after upgrade</);
	const { ThreadBadges } = await vite.ssrLoadModule("/src/components/Sidebar.tsx");
	for (const compact of [true, false]) assert.match(renderToStaticMarkup(createElement(ThreadBadges, { t: row, compact })), />updating</);
	assert.match(render({ ...connected, upgrade: { updated: 49, total: 50 } } as never), />Updating 1 Session after upgrade</);
	assert.doesNotMatch(render(connected as never), /data-upgrade/);
});
