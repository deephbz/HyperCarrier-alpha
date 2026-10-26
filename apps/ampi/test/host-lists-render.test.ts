import "./bound.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";

// Renders the Pi sidebar section and Overview through Vite's SSR loader for a failed working-set init, for a
// Host before its first agents list, and for two Host sources that share one Host ID.

const web = fileURLToPath(new URL("../web/", import.meta.url));
let vite: ViteDevServer;
let section: (props: object) => unknown;
let overview: (props: object) => unknown;
let newAgent: (props: object) => unknown;
let labels: typeof import("../web/src/components/host-label.ts");

before(async () => {
	// client.ts opens its hub WebSocket at import; this stub never connects. Overview reads its last visit from storage.
	const stored = new Map<string, string>();
	const localStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k) };
	Object.assign(globalThis, { location: { protocol: "http:", host: "127.0.0.1:1", hash: "" }, WebSocket: class { send() {} close() {} }, localStorage, document: { activeElement: null } });
	vite = await createServer({ configFile: `${web}vite.config.ts`, root: web, logLevel: "silent", server: { middlewareMode: true, hmr: false } });
	section = (await vite.ssrLoadModule("/src/components/PiSidebar.tsx")).PiHostSection;
	overview = (await vite.ssrLoadModule("/src/components/Overview.tsx")).Overview;
	labels = (await vite.ssrLoadModule("/src/components/host-label.ts")) as typeof labels;
	newAgent = (await vite.ssrLoadModule("/src/components/PiDialogs.tsx")).NewAgentDialog;
});
after(async () => { await vite?.close(); });

const REASON = "Host cache unavailable: database is locked. Restart the hub; if it repeats, check the hub log and the cache at /synthetic/cache.";
const failed = { host: { id: "devbox", label: "devbox", kind: "pi-local", status: "disconnected", attempts: 0, error: REASON, cacheFailed: true }, threads: [], stale: true, indexing: true, listing: true, error: REASON };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

test("host lists render: a failed init says unavailable and the full reason, never No Sessions yet", () => {
	const side = text(renderToStaticMarkup(createElement(section as never, { data: failed, hosts: [failed.host], route: {}, filter: "" })));
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
	const side = text(renderToStaticMarkup(createElement(section as never, { data, hosts: [data.host], route: {}, filter: "" })));
	assert.match(side, /Looking for live Sessions….*Not placed yet \(1\)/);
	assert.doesNotMatch(side, /Not in a pane/);
	const listed = text(renderToStaticMarkup(createElement(section as never, { data: { ...data, listing: undefined }, hosts: [data.host], route: {}, filter: "" })));
	assert.match(listed, /Not in a pane \(1\)/);
	assert.doesNotMatch(listed, /Looking for live Sessions/);
});

test("host lists render: two sources of one Host ID name their source in the sidebar header and Overview; one source keeps its label", () => {
	const row = (id: string) => ({ id, ref: `devbox/${id}`, title: `Row ${id}`, cwd: "/work", createdAt: 0, updatedAt: 1, kind: "thread", activity: "idle", queued: 0, costUsd: 0, live: false, control: false });
	const host = (link: string, kind: string, id = "devbox") => ({ id, link, label: id, kind, status: "connected", attempts: 0 });
	const pi = { host: host("devbox#pi", "pi-local"), threads: [row("pi:sess-a")], stale: false };
	const durable = { host: host("devbox#durable", "local"), threads: [row("t-1")], stale: false };
	const other = { host: host("linuxbox", "pi-ssh", "linuxbox"), threads: [], stale: false };
	const hosts = [pi.host, durable.host, other.host];
	assert.deepEqual(hosts.map((h) => labels.hostLabel(h as never, hosts as never)), ["devbox · Pi in Herdr", "devbox · durable", "linuxbox"]);
	const head = (d: typeof pi) => text(/<div class="side-head">[\s\S]*?<\/button>/.exec(renderToStaticMarkup(createElement(section as never, { data: d, hosts, route: {}, filter: "" })))?.[0] ?? "");
	assert.match(head(pi), /devbox · Pi in Herdr/);
	assert.match(head(durable), /devbox · durable/);
	assert.match(head(other), /^ ?linuxbox live/);
	const page = text(renderToStaticMarkup(createElement(overview as never, { data: [pi, durable, other], onNew() {}, onAddHost() {}, onHelp() {} })));
	assert.match(page, /devbox · Pi in Herdr .*devbox · durable/);
	assert.doesNotMatch(page, /\bamd · /);
	// One source per Host ID renders the bare label, as before the rule.
	const alone = text(renderToStaticMarkup(createElement(section as never, { data: pi, hosts: [pi.host], route: {}, filter: "" })));
	assert.doesNotMatch(alone, / · (Pi in Herdr|durable)/);
});

test("New agent without a route Host prefers connected durable; Pi-only and explicit routes keep their defaults", () => {
	const pi = { id: "devbox", link: "devbox#pi", label: "devbox", kind: "pi-local", status: "connected", attempts: 0 };
	const durable = { ...pi, link: "devbox#durable", kind: "local" };
	const other = { ...pi, id: "other", link: "other#pi" };
	const selected = (hosts: typeof pi[], defaultHost?: string) => {
		const html = renderToStaticMarkup(createElement(newAgent as never, { hosts, defaultHost, onClose() {} }));
		const select = /<select[^>]*aria-label="Host"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1];
		assert.ok(select, html);
		return /<option value="([^"]+)" selected=""/.exec(select)?.[1];
	};
	localStorage.setItem("ampi.newAgent", JSON.stringify({ host: pi.link }));
	assert.equal(selected([pi, durable]), durable.link, "Overview chooses durable even when Pi was used last");
	assert.equal(selected([pi, durable], "missing#pi"), durable.link, "an inapplicable route uses the Overview default");
	assert.equal(selected([pi, { ...durable, id: "first", link: "first#durable" }, durable]), "first#durable", "the first connected durable source wins");
	assert.equal(selected([pi]), pi.link, "Pi-only behavior stays unchanged");
	assert.equal(selected([pi, { ...durable, status: "disconnected" }]), pi.link, "an offline durable source is not the default");
	assert.equal(selected([pi, durable], pi.link), durable.link, "the routed Pi Host still prefers its durable twin");
	assert.equal(selected([other, pi, durable], other.link), other.link, "an explicit route does not jump to another Host");
	localStorage.removeItem("ampi.newAgent");
});

test("host lists render: a route key resolves to its Host label; the link key never shows", () => {
	const pi = { id: "devbox", link: "devbox#pi", label: "devbox", kind: "pi-local" as const, status: "connected" as const, attempts: 0 };
	const durable = { ...pi, link: "devbox#durable", kind: "local" as const };
	assert.equal(labels.hostLabelFor("devbox#pi", [pi]), "devbox", "a Pi-only hub shows the bare label");
	assert.equal(labels.hostLabelFor("devbox", [pi]), "devbox");
	assert.equal(labels.hostLabelFor("devbox#durable", [pi, durable]), "devbox · durable");
	assert.equal(labels.hostLabelFor("devbox#pi", [pi, durable]), "devbox · Pi in Herdr");
	assert.equal(labels.hostLabelFor("gone#durable", [pi]), "gone", "an unlisted key shows its Host ID");
});
