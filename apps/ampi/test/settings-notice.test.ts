import "./bound.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { build } from "vite";
import react from "@vitejs/plugin-react";
// @ts-ignore: shared browser discovery is plain ESM.
import { findChrome } from "../scripts/perf/browser.mjs";
import type { SettingsNotice } from "../src/shared/protocol.ts";
import { engineSkip } from "./engines.ts";

// A durable node that ignored invalid Pi settings says so once per settings stamp, as Pi's Auto Compact warns: the
// real App with its stylesheet, and a script on the page's WebSocket as the hub.

const web = fileURLToPath(new URL("../web", import.meta.url));
const ORIGIN = "http://ampi.test";
const HOST = { id: "devbox", link: "devbox#durable", label: "devbox", kind: "durable", status: "connected" };
const ERROR = "auto_compact.threshold must be greater than 1 and less than 110";

async function appScript(): Promise<string> {
	const entry = join(web, "settings-notice-test-entry.js");
	const result = await build({
		configFile: false, root: web, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
			name: "settings-notice-test",
			resolveId: (id) => id === entry ? `\0${entry}` : undefined,
			load: (id) => id === `\0${entry}` ? `
				import React from 'react';
				import { createRoot } from 'react-dom/client';
				import { App } from ${JSON.stringify(join(web, "src/App.tsx"))};
				createRoot(document.getElementById('root')).render(React.createElement(App));
			` : undefined,
		}],
		build: { write: false, minify: false, lib: { entry, formats: ["iife"], name: "SettingsNoticeTest" } },
	});
	const output = (Array.isArray(result) ? result[0]! : result) as { output: { type: string; code?: string }[] };
	return output.output.find((item) => item.type === "chunk")!.code!;
}

let browser: Promise<Browser> | undefined;
after(async () => { if (browser) await (await browser).close(); });

test("settings notice: one per Host and stamp, kept across a reload, ended by a fixed file", { skip: engineSkip("chromium") }, async (t) => {
	const code = await appScript();
	const page = await (await (browser = chromium.launch({ headless: true, executablePath: findChrome() }))).newPage({ viewport: { width: 1000, height: 700 } });
	t.after(() => page.context().close());
	page.setDefaultTimeout(5000);
	const css = readFileSync(join(web, "src/styles.css"), "utf8");
	await page.route("**/*", (route) => {
		const url = new URL(route.request().url());
		if (url.origin !== ORIGIN) return route.abort();
		if (url.pathname === "/app.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: code });
		if (url.pathname === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<meta charset="utf-8"><style>${css}</style><div id="root"></div><script src="/app.js"></script>` });
		return route.abort();
	});
	// The node's threads value; `publish` sends it again as the node would after a settings edit.
	let notice: SettingsNotice | undefined = { stamp: "1000:40", errors: [ERROR], file: "/root/.pi/agent/settings.json" };
	let publish = () => {};
	await page.routeWebSocket("**/ws", (client) => {
		const send = (frame: unknown) => client.send(JSON.stringify(frame));
		send({ t: "hosts", hosts: [HOST] });
		client.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (frame.t === "sub" && frame.topic?.kind === "threads") {
				publish = () => send({ t: "snap", sid: frame.sid, value: { threads: {}, backend: "durable", ...(notice ? { settingsNotice: notice } : {}) } });
				publish();
			} else if (frame.t === "sub") send({ t: "snap", sid: frame.sid, value: {} });
			else if (frame.t === "req" || frame.t === "hub") send({ t: "res", id: frame.id, ok: false, error: { code: "unsupported", message: "not in this test" } });
		});
	});
	const toast = page.locator(".settings-notice");
	await page.goto(`${ORIGIN}/`);
	await assert.doesNotReject(toast.waitFor());
	assert.equal(await toast.innerText(), `devbox: ignored invalid Pi settings in ~/.pi/agent/settings.json: ${ERROR}. Dismiss`);

	// The same stamp after a reload is the same fact: no second notice.
	await page.reload();
	// The Host's list renders from the same threads value that carries the notice.
	await page.getByText("No threads yet. Start a thread to begin.").waitFor();
	assert.equal(await toast.count(), 0, "a reload does not repeat the notice");

	// A new stamp with the same error is a new edit: one notice, until dismissed.
	notice = { ...notice!, stamp: "2000:41" };
	publish();
	await toast.waitFor();
	await toast.getByRole("button", { name: "Dismiss" }).click();
	await toast.waitFor({ state: "detached" });

	// A notice the owner has not dismissed ends when the file is fixed.
	notice = { ...notice!, stamp: "3000:42" };
	publish();
	await toast.waitFor();
	notice = undefined;
	publish();
	await toast.waitFor({ state: "detached" });
});
