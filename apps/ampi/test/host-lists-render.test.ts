import "./bound.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, isValidElement, type ReactNode } from "react";
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
const failed = { host: { id: "devbox", link: "devbox#pi", label: "devbox", kind: "pi-local", status: "disconnected", attempts: 0, error: REASON, cacheFailed: true }, threads: [], stale: true, indexing: true, listing: true, error: REASON };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
function overviewText(data: object[]) {
	const keyWarnings: unknown[][] = [];
	const originalError = console.error;
	console.error = (...args: unknown[]) => { keyWarnings.push(args); };
	let html: string;
	try {
		html = renderToStaticMarkup(createElement(overview as never, { data, onNew() {}, onHostSetup() {}, onHelp() {} }));
	} finally {
		console.error = originalError;
	}
	assert.deepEqual(keyWarnings, [], "Overview Host rows must use unique React keys");
	return text(html!);
}

test("host lists render: Overview keeps distinct row identities for two sources of one Host", () => {
	const host = { id: "devbox", label: "devbox", status: "connected", attempts: 0 };
	const data = [
		{ host: { ...host, kind: "pi-local", link: "devbox#pi" }, threads: [], stale: false },
		{ host: { ...host, kind: "node", link: "devbox#node" }, threads: [], stale: false },
	];
	const identities = (rows: typeof data) => {
		const keys: (string | null)[] = [];
		function InspectOverview() {
			const tree = overview({ data: rows, onNew() {}, onHostSetup() {}, onHelp() {} }) as ReactNode;
			function visit(node: ReactNode) {
				if (Array.isArray(node)) { node.forEach(visit); return; }
				if (!isValidElement<{ className?: string; children?: ReactNode }>(node)) return;
				if (node.props.className === "ov-host") keys.push(node.key);
				visit(node.props.children);
			}
			visit(tree);
			return tree;
		}
		renderToStaticMarkup(createElement(InspectOverview));
		assert.equal(keys.length, 2, "both sources reach Overview");
		assert.equal(new Set(keys).size, 2, "each source needs its own React row identity");
		return keys;
	};
	const keys = identities(data);
	assert.deepEqual(identities([...data].reverse()), [...keys].reverse(), "row identity follows its source across reordering");
});

test("host lists render: a failed init says unavailable and the full reason, never No Sessions yet", () => {
	const side = text(renderToStaticMarkup(createElement(section as never, { data: failed, hosts: [failed.host], route: {}, filter: "" })));
	assert.match(side, /unavailable/);
	assert.doesNotMatch(side, /copies readable/);
	assert.ok(side.includes(REASON), side);
	const page = overviewText([failed]);
	assert.ok(page.includes(`devbox: ${REASON}`), page);
	assert.doesNotMatch(page, /No Sessions yet|Reading Sessions/);
});

test("host lists render: before the first agents list, saved rows stay listed as not placed yet under the note", () => {
	const row = { id: "pi:sess-a", ref: "devbox/pi:sess-a", title: "Saved Session", cwd: "/work", createdAt: 0, updatedAt: 0, kind: "thread", activity: "idle", queued: 0, costUsd: 0, live: false, control: false };
	const data = { host: { id: "devbox", label: "devbox", kind: "pi-local", status: "connected", attempts: 0 }, threads: [row], stale: false, listing: true };
	const side = text(renderToStaticMarkup(createElement(section as never, { data, hosts: [data.host], route: {}, filter: "" })));
	assert.match(side, /Looking for live Sessions….*Not placed yet \(1\)/);
	assert.doesNotMatch(side, /Not in a pane/);
	const listed = text(renderToStaticMarkup(createElement(section as never, { data: { ...data, listing: undefined }, hosts: [data.host], route: {}, filter: "" })));
	assert.match(listed, /Not in a pane \(1\)/);
	assert.doesNotMatch(listed, /Looking for live Sessions/);
});

test("host lists render: Overview counts each Host's in-scope and running Sessions by link", () => {
	const session = (id: string, over: object = {}) => ({ id, ref: `devbox/${id}`, title: id, cwd: "/work", createdAt: 0, updatedAt: 0, kind: "thread", activity: "idle", queued: 0, costUsd: 0, live: true, control: false, ...over });
	const host = (id: string, link: string) => ({ id, link, label: id, kind: "pi-local", status: "connected", attempts: 0 });
	// Archived rows are out of scope; workers count; two Hosts that share a link show the same counts.
	const data = [
		{ host: host("alpha", "a"), stale: false, threads: [session("pi:a1", { activity: "running" }), session("pi:a2", { kind: "worker", activity: "waiting" }), session("pi:a3", { archived: true, activity: "running" }), session("pi:a4")] },
		{ host: host("beta", "b"), stale: false, threads: [session("pi:b1", { archived: true })] },
		{ host: host("gamma", "a"), stale: false, threads: [session("pi:g1", { activity: "running" })] },
	];
	const page = text(renderToStaticMarkup(createElement(overview as never, { data, onNew() {}, onHostSetup() {}, onHelp() {} })));
	assert.match(page, /alpha 3 running · 4 Sessions in scope/);
	assert.match(page, /beta 0 running · 0 Sessions in scope/);
	assert.match(page, /gamma 3 running · 4 Sessions in scope/);
});
