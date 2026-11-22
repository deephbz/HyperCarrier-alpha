import "./bound.ts";
import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { engineSkip } from "./engines.ts";
import { ENGINES, type Engine } from "./thread-scroll-fixture.ts";
// @ts-ignore: shared browser discovery is plain ESM.
import { findChrome } from "../scripts/perf/browser.mjs";

declare global {
	interface Window { probe: { capture: () => unknown; pending: () => number | undefined; render: () => void; events: () => number; extensions: () => number } }
}

const web = fileURLToPath(new URL("../web", import.meta.url));
const origin = "http://localhost";
let bundle: Promise<string> | undefined;
let chrome: Promise<Browser> | undefined;
let safari: Promise<Browser> | undefined;
after(async () => { await (await chrome)?.close(); await (await safari)?.close(); });

async function component(): Promise<string> {
	const entry = join(web, "pending-capture-test-entry.js");
	const result = await build({
		configFile: false, root: web, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
			name: "pending-capture-test",
			resolveId: (id) => id === entry ? `\0${entry}` : undefined,
			load: (id) => id === `\0${entry}` ? `
				import React, { useLayoutEffect, useRef, useState } from 'react';
				import { createRoot } from 'react-dom/client';
				import { flushSync } from 'react-dom';
				import { useKeepPlace } from ${JSON.stringify(join(web, "src/keep-place.ts"))};
				function Probe() {
				  const scroller = useRef(null), pinned = useRef(false), scrollEvents = useRef(0), extensions = useRef(0), [revision, setRevision] = useState(0);
				  const place = useKeepPlace(scroller, '[data-row]', 'data-row', pinned, 60, () => false);
				  useLayoutEffect(() => {
				    const token = place.pendingExtend();
				    if (token !== undefined && place.completeExtend(token)) extensions.current++;
				  });
				  useLayoutEffect(() => { window.probe = { capture: place.capture, pending: place.pendingExtend, render: () => flushSync(() => setRevision(n => n + 1)), events: () => scrollEvents.current, extensions: () => extensions.current }; });
				  return React.createElement('div', { ref: scroller, onScroll: () => { scrollEvents.current++; place.onScroll(); }, 'data-scroller': '', style: { height: '300px', overflow: 'auto' } },
				    React.createElement('div', null, ...Array.from({ length: 120 }, (_, i) => React.createElement('div', { 'data-row': String(i), style: { height: '40px' } }, 'row ' + i))),
				    !pinned.current && React.createElement('button', { role: 'status' }, '↓ 3 new messages')); // Synthetic constant: ThreadView tests prove arrival counts.
				}
				createRoot(document.getElementById('root')).render(React.createElement(Probe));
			` : undefined,
		}],
		build: { write: false, minify: false, lib: { entry, formats: ["iife"], name: "PendingCaptureProbe" } },
	});
	const output = (Array.isArray(result) ? result[0]! : result) as { output: { type: string; code?: string }[] };
	return output.output.find((item) => item.type === "chunk")!.code!;
}

async function open(t: TestContext, engine: Engine): Promise<Page> {
	const script = await (bundle ??= component());
	const browser = await (engine === "webkit" ? (safari ??= webkit.launch({ headless: true })) : (chrome ??= chromium.launch({ headless: true, executablePath: findChrome() })));
	const page = await browser.newPage({ viewport: { width: 700, height: 500 } });
	t.after(() => page.context().close());
	await page.route("**/*", (route) => {
		if (new URL(route.request().url()).origin !== origin) return route.abort();
		if (new URL(route.request().url()).pathname === "/probe.js") return route.fulfill({ contentType: "text/javascript", body: script });
		return route.fulfill({ contentType: "text/html; charset=utf-8", body: '<meta charset="utf-8"><div id="root"></div><script src="/probe.js"></script>' });
	});
	await page.goto(origin);
	await page.locator('[data-row="119"]').waitFor();
	return page;
}

const anchor = (page: Page) => page.locator("[data-scroller]").evaluate((el: HTMLElement) => {
	const top = el.getBoundingClientRect().top;
	const row = [...el.querySelectorAll<HTMLElement>("[data-row]")].find((node) => node.getBoundingClientRect().bottom > top)!;
	return { id: row.dataset.row!, offset: row.getBoundingClientRect().top - top };
});

async function armCapture(page: Page) {
	await page.locator("[data-scroller]").evaluate((el: HTMLElement) => {
		el.scrollTop = el.scrollHeight - el.clientHeight - 10;
		el.dispatchEvent(new Event("scroll"));
	});
	const armed = await page.evaluate(() => window.probe.pending() !== undefined);
	assert.equal(armed, true, "the positive control proves that an extend token is armed");
	await page.evaluate(() => window.probe.capture());
}

for (const engine of ENGINES) {
	test(`pending capture (${engine}): an upward scroll event before layout cancels extension`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine);
		await armCapture(page);
		await page.locator("[data-scroller]").evaluate((el: HTMLElement) => { el.scrollTop -= 200; el.dispatchEvent(new Event("scroll")); });
		const read = await anchor(page);
		await page.evaluate(() => window.probe.render());
		assert.ok(await page.locator("[data-scroller]").evaluate((el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight > 100), "event-first upward movement does not complete the pending extension");
		const offset = await page.locator(`[data-row="${read.id}"]`).evaluate((node: HTMLElement) => node.getBoundingClientRect().top - node.parentElement!.parentElement!.getBoundingClientRect().top);
		assert.ok(Math.abs(offset - read.offset) <= 1, `event-first move preserves the read line: ${read.offset} to ${offset}`);
		assert.equal(await page.getByRole("status").textContent(), "↓ 3 new messages", "the reader sees the exact count after event-first movement");
		assert.equal(await page.evaluate(() => window.probe.extensions()), 0, "event-first upward movement is not consumed as an extension");
	});

	test(`pending capture (${engine}): an upward DOM move before layout cancels extension`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine);
		await armCapture(page);
		const result = await page.locator("[data-scroller]").evaluate((el: HTMLElement) => {
			el.scrollTop -= 200;
			const containerTop = el.getBoundingClientRect().top;
			const row = [...el.querySelectorAll<HTMLElement>("[data-row]")].find((node) => node.getBoundingClientRect().bottom > containerTop)!;
			const read = { id: row.dataset.row!, offset: row.getBoundingClientRect().top - containerTop };
			const tokenBeforeRender = window.probe.pending();
			const eventsBeforeRender = window.probe.events();
			window.probe.render();
			const offset = el.querySelector<HTMLElement>(`[data-row="${read.id}"]`)!.getBoundingClientRect().top - el.getBoundingClientRect().top;
			return { tokenBeforeRender, eventsBeforeRender, eventsAfterRender: window.probe.events(), read, offset, gap: el.scrollHeight - el.scrollTop - el.clientHeight, pill: el.querySelector('[role="status"]')?.textContent ?? null };
		});
		assert.notEqual(result.tokenBeforeRender, undefined, "the extend token is pending before layout consumes the capture");
		assert.equal(result.eventsAfterRender, result.eventsBeforeRender, "no scroll event ran between the upward write and forced layout");
		assert.ok(result.gap > 100, "layout-first upward movement stays away from the source tail");
		assert.equal(await page.evaluate(() => window.probe.extensions()), 0, "layout-first upward movement is not consumed as an extension");
		assert.ok(Math.abs(result.offset - result.read.offset) <= 1, `layout-first move preserves the read line: ${result.read.offset} to ${result.offset}`);
		assert.equal(result.pill, "↓ 3 new messages", "the synthetic pill remains visible after layout-first movement");
	});

	test(`pending capture (${engine}): no-upward control completes extension without following`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine);
		await armCapture(page);
		await page.evaluate(() => window.probe.render());
		assert.ok(await page.locator("[data-scroller]").evaluate((el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight > 1), "EXTEND does not follow the source tail");
		assert.equal(await page.getByRole("status").textContent(), "↓ 3 new messages", "EXTEND leaves the new-entry pill visible");
		assert.equal(await page.evaluate(() => window.probe.extensions()), 1, "the control consumes exactly one extension");
	});
}
