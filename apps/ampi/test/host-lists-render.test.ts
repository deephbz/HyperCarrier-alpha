import "./bound.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";

// Renders the Pi sidebar section and Overview through Vite's SSR loader for a failed working-set init and for a
// Host before its first agents list.

const web = fileURLToPath(new URL("../web/", import.meta.url));
let vite: ViteDevServer;
let section: (props: object) => unknown;
let overview: (props: object) => unknown;

before(async () => {
	// client.ts opens its hub WebSocket at import; this stub never connects. Overview reads its last visit from storage.
	const stored = new Map<string, string>();
	const localStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k) };
	Object.assign(globalThis, { location: { protocol: "http:", host: "127.0.0.1:1", hash: "" }, WebSocket: class { send() {} close() {} }, localStorage });
	vite = await createServer({ configFile: `${web}vite.config.ts`, root: web, logLevel: "silent", server: { middlewareMode: true, hmr: false } });
	section = (await vite.ssrLoadModule("/src/components/PiSidebar.tsx")).PiHostSection;
	overview = (await vite.ssrLoadModule("/src/components/Overview.tsx")).Overview;
});
after(async () => { await vite?.close(); });

const REASON = "Host cache unavailable: database is locked. Restart the hub; if it repeats, check the hub log and the cache at /synthetic/cache.";
const failed = { host: { id: "devbox", label: "devbox", kind: "pi-local", status: "disconnected", attempts: 0, error: REASON, cacheFailed: true }, threads: [], stale: true, indexing: true, listing: true, error: REASON };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

test("host lists render: a failed init says unavailable and the full reason, never No Sessions yet", () => {
	const side = text(renderToStaticMarkup(createElement(section as never, { data: failed, route: {}, filter: "" })));
	assert.match(side, /unavailable/);
	assert.doesNotMatch(side, /copies readable/);
	assert.ok(side.includes(REASON), side);
	const page = text(renderToStaticMarkup(createElement(overview as never, { data: [failed], onNew() {}, onAddHost() {}, onHelp() {} })));
	assert.ok(page.includes(`devbox: ${REASON}`), page);
	assert.doesNotMatch(page, /No Sessions yet|Reading Sessions/);
});

test("host lists render: before the first agents list, saved rows stay listed as not placed yet under the note", () => {
	const row = { id: "pi:sess-a", ref: "devbox/pi:sess-a", title: "Saved Session", cwd: "/work", createdAt: 0, updatedAt: 0, kind: "thread", activity: "idle", queued: 0, costUsd: 0, live: false, control: false };
	const data = { host: { id: "devbox", label: "devbox", kind: "pi-local", status: "connected", attempts: 0 }, threads: [row], stale: false, listing: true };
	const side = text(renderToStaticMarkup(createElement(section as never, { data, route: {}, filter: "" })));
	assert.match(side, /Looking for live Sessions….*Not placed yet \(1\)/);
	assert.doesNotMatch(side, /Not in a pane/);
	const listed = text(renderToStaticMarkup(createElement(section as never, { data: { ...data, listing: undefined }, route: {}, filter: "" })));
	assert.match(listed, /Not in a pane \(1\)/);
	assert.doesNotMatch(listed, /Looking for live Sessions/);
});
