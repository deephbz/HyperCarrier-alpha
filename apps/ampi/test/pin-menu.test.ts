import "./bound.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build } from "vite";
import react from "@vitejs/plugin-react";
// @ts-ignore: browser discovery is shared ESM.
import { findChrome } from "../scripts/perf/browser.mjs";

// The real row menu beside two scroll regions; no Host connection or owner data.
test("pin menu: a scroll in another region keeps it open; a scroll that moves its row closes it", async () => {
	const web = fileURLToPath(new URL("../web", import.meta.url));
	const entry = join(web, "pin-menu-test.js");
	const result = await build({ configFile: false, root: web, logLevel: "silent", define: { "process.env.NODE_ENV": '"production"' }, plugins: [react(), {
		name: "pin-menu-test", resolveId: (id) => id === entry ? `\0${entry}` : undefined,
		load: (id) => id === `\0${entry}` ? `
			import React from 'react'; import {createRoot} from 'react-dom/client';
			import {PinMenu, openPinMenu} from ${JSON.stringify(join(web, "src/components/Pinned.tsx"))};
			const h = React.createElement, tall = h('div', {style: {height: '2000px'}});
			createRoot(document.getElementById('root')).render(h(React.Fragment, null,
				h('div', {id: 'side', style: {height: '200px', overflow: 'auto'}}, h('div', {className: 'row', onContextMenu: (e) => openPinMenu(e, 'demo', 't1', 'One')}, 'One'), tall),
				h('div', {id: 'page', style: {height: '200px', overflow: 'auto'}}, tall),
				h(PinMenu)));
		` : undefined,
	}], build: { write: false, minify: false, lib: { entry, formats: ["iife"], name: "PinMenuTest" } } });
	const output = (Array.isArray(result) ? result[0]! : result) as { output: { type: string; code?: string }[] };
	const script = output.output.find((x) => x.type === "chunk")!.code!;
	const browser = await chromium.launch({ headless: true, executablePath: findChrome() });
	try {
		const page = await browser.newPage();
		page.setDefaultTimeout(2000);
		await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: `<style>${readFileSync(join(web, "src/styles.css"), "utf8")}</style><div id="root"></div><script>${script}</script>` }));
		await page.routeWebSocket("**/ws", () => {});
		await page.goto("http://localhost/");
		const menu = page.locator(".row-menu");
		await page.locator(".row").click({ button: "right" });
		await menu.waitFor();
		// The Overview page scrolls itself as Sessions arrive; the sidebar row stays put.
		await page.evaluate(() => { document.getElementById("page")!.scrollTop = 300; });
		await page.waitForTimeout(100);
		assert.equal(await menu.count(), 1, "a scroll in another region closed the menu");
		assert.equal(await menu.locator("button").innerText(), "Pin to top");
		await page.evaluate(() => { document.getElementById("side")!.scrollTop = 300; });
		await menu.waitFor({ state: "detached" });
	} finally {
		await browser.close();
	}
});
