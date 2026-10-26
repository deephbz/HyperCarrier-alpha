import "./bound.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import { projectEntry } from "../src/pi/projection.ts";

// Renders the hub's placeholder for an entry the hub copy holds only as a stub, through the transcript's notice row.

const web = fileURLToPath(new URL("../web/", import.meta.url));
let vite: ViteDevServer;
let notice: (props: object) => unknown;

before(async () => {
	// client.ts opens its hub WebSocket at import; this stub never connects.
	Object.assign(globalThis, { location: { protocol: "http:", host: "127.0.0.1:1", hash: "" }, WebSocket: class { send() {} close() {} } });
	vite = await createServer({ configFile: `${web}vite.config.ts`, root: web, logLevel: "silent", server: { middlewareMode: true, hmr: false } });
	notice = (await vite.ssrLoadModule("/src/components/ThreadView.tsx")).NoticeEntry;
});
after(async () => { await vite?.close(); });

const stub = { ref: "devbox/pi-durable:tree-a.8#7", id: "7", parent: "6", t: 1000, kind: "other", oversized: { bytes: 17 << 20, sha256: "0".repeat(64), kind: "pi.assistant" } };

test("oversized notice: the expanded placeholder links the hub's relative raw export URL, not a dead link", () => {
	// The URL DurableHost passes (durable-host.ts rawExportUrl): hub-relative, so it carries the hub login cookie.
	const rawExport = `/raw/pi-durable:tree-a.8?host=${encodeURIComponent("devbox#durable")}`;
	const entry = projectEntry(stub as never, { rawExport }) as any;
	assert.equal(entry.rawExport, rawExport);
	assert.doesNotMatch(entry.message.text, /\]\(|\/raw\//, "the hub's link stays out of the markdown text the sanitizer reads");
	const html = renderToStaticMarkup(createElement(notice as never, { entry, host: "devbox#durable", threadId: "tree-a.8" }));
	const links = [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => ({ href: m[1]!.replace(/&amp;/g, "&"), text: m[2] }));
	assert.deepEqual(links, [{ href: rawExport, text: "Open the raw export" }], html);
	assert.match(html.replace(/<[^>]+>/g, " "), /17\.0 MiB `pi\.assistant` entry is too large for the hub copy and stays on the node\. Open the raw export to read it\./);
	assert.match(html, /^<details class="msg notice"/, "collapsed until opened, as every notice row");
});

test("oversized notice: without a raw export URL the placeholder names the Trace Viewer export and links nothing", () => {
	const html = renderToStaticMarkup(createElement(notice as never, { entry: projectEntry(stub as never), host: "devbox#durable", threadId: "tree-a.8" }));
	assert.doesNotMatch(html, /<a /);
	assert.match(html, /The Trace Viewer raw export has it\./);
});
