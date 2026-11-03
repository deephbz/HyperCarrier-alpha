import "./bound.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";

// The transcript's notice row on the server: it reads its Host's thread surface before the hub lists any Host, so the
// link key names the kind, and a kind can supply the text of an entry that carries no message.

const web = fileURLToPath(new URL("../web/", import.meta.url));
let vite: ViteDevServer;
let notice: (props: object) => unknown;
let hostKinds: unknown[];
let kindUis: Record<string, unknown>;

before(async () => {
	// client.ts opens its hub WebSocket at import; this stub never connects.
	Object.assign(globalThis, { location: { protocol: "http:", host: "127.0.0.1:1", hash: "" }, WebSocket: class { send() {} close() {} } });
	vite = await createServer({ configFile: `${web}vite.config.ts`, root: web, logLevel: "silent", server: { middlewareMode: true, hmr: false } });
	notice = (await vite.ssrLoadModule("/src/components/ThreadView.tsx")).NoticeEntry;
	({ hostKinds } = await vite.ssrLoadModule("/src/extensions.ts"));
	({ kindUis } = await vite.ssrLoadModule("/src/extensions-ui.ts"));
});
after(async () => { await vite?.close(); });

const render = (entry: object, host: string) => renderToStaticMarkup(createElement(notice as never, { entry: { id: "9", kind: "custom", entryKind: "relay.note", ts: 1000, ...entry }, host, threadId: "x.9" }));

test("notice row: a server render draws a Pi notice before the hub lists any Host", () => {
	const html = render({ message: { kind: "notice", label: "relay note", text: "First line\nrest" } }, "devbox#pi");
	assert.match(html, /<span class="notice-first">First line<\/span>/);
});

test("notice row: the link key names the kind before the Host list arrives, and the kind supplies the text of an entry without a message", (t) => {
	hostKinds.push({ source: "fake", sourceLabel: "fake", matches: () => false, ownsThread: (id: string) => id.startsWith("x."), herdr: false, reader: true });
	kindUis.fake = { thread: { noticeMessage: (entry: { entryKind: string; text?: string }) => ({ kind: "notice", label: entry.entryKind, text: `From the kind: ${entry.text}` }) } };
	t.after(() => {
		hostKinds.pop();
		delete kindUis.fake;
	});
	const html = render({ text: "old text" }, "devbox#fake");
	assert.match(html, /<span class="badge ">relay\.note<\/span>/);
	assert.match(html, /<span class="notice-first">From the kind: old text<\/span>/);
});
