import "./bound.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { build } from "vite";
import react from "@vitejs/plugin-react";
// @ts-ignore: shared browser discovery is plain ESM.
import { findChrome } from "../scripts/perf/browser.mjs";
import { engineSkip } from "./engines.ts";

// Display units (web/src/display.ts) and the sites that convert between them, in Chromium and WebKit with the real
// ThreadView, Composer, QuoteSelection, RarebitView and stylesheets; only the hub is a script on the page's WebSocket.
// AmPi sets the display size with CSS `zoom` on the page and on its regions. The owner runs overall 130 %.

const web = fileURLToPath(new URL("../web", import.meta.url));
const ORIGIN = "http://localhost";
const THREAD = "pi:s1";
const HOST = { id: "devbox", link: "devbox", label: "devbox", kind: "local", status: "connected" };

async function componentBundle(): Promise<{ script: string; css: string }> {
	const entry = join(web, "display-units-test-entry.js");
	const result = await build({
		configFile: false, root: web, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
			name: "display-units-test",
			resolveId: (id) => id === entry ? `\0${entry}` : undefined,
			load: (id) => id === `\0${entry}` ? `
				import React from 'react';
				import { createRoot } from 'react-dom/client';
				import * as display from ${JSON.stringify(join(web, "src/display.ts"))};
				import { ThreadView } from ${JSON.stringify(join(web, "src/components/ThreadView.tsx"))};
				import { RarebitView } from ${JSON.stringify(join(web, "src/views/rarebit/View.tsx"))};
				const h = React.createElement;
				window.display = display;
				const summary = { control: true, id: ${JSON.stringify(THREAD)}, title: 'Units', createdAt: 0, updatedAt: 0, kind: 'thread', activity: 'idle', queued: 0, costUsd: 0 };
				const pane = window.PANE === 'thread'
					? h('div', { className: 'main-slot', style: { height: '600px' } }, h(ThreadView, { host: 'devbox', threadId: ${JSON.stringify(THREAD)}, summary, models: [], panel: undefined, setPanel() {} }))
					: window.PANE === 'rarebit'
						? h('div', { className: 'panel-slot', 'data-region': 'panel', style: { height: '500px', display: 'flex', flexDirection: 'column' } }, h(RarebitView, { host: 'devbox', threadId: ${JSON.stringify(THREAD)} }))
						: null;
				if (pane) createRoot(document.getElementById('root')).render(pane);
			` : undefined,
		}],
		build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, formats: ["iife"], name: "DisplayUnitsTest" } },
	});
	const output = (Array.isArray(result) ? result[0]! : result) as { output: { type: string; fileName: string; code?: string; source?: string | Uint8Array }[] };
	const css = output.output.filter((item) => item.fileName.endsWith(".css")).map((item) => String(item.source)).join("\n");
	return { script: output.output.find((item) => item.type === "chunk")!.code!, css };
}

const view = () => ({ conversationId: "s1", hiddenBefore: false, entries: [
	{ id: "e0", kind: "assistant", blocks: [{ type: "text", text: "First selected paragraph." }] },
	{ id: "e1", kind: "assistant", blocks: [{ type: "text", text: "Second paragraph." }] },
], live: {}, inbox: {}, agent: { cwd: "/work" }, usage: { costUsd: 0 } });
const kinds = { user: 0, continuation: 0, stop: 0, toolCalls: 0, toolResults: 0, thinking: 0, summary: 0, other: 0 };
/** Alternating user messages and agent stops, ids r0..r(n-1). */
const rarebit = (n: number) => ({
	items: Array.from({ length: n }, (_, i) => ({ id: `r${i}`, kind: i % 2 === 0 ? "user" : "stop", t: null, text: i % 2 === 0 ? `Question ${i}` : `Answer ${i}. ${"More detail. ".repeat(20 + (i % 5) * 10)}` })),
	stats: { user: Math.ceil(n / 2), continuation: 0, stop: Math.floor(n / 2), compactions: 0, rarebitTokens: n, totalTokens: n, ratio: 1 },
	diagnosis: { session: kinds, live: kinds, entries: n, ms: 1 }, selector: "default", revision: n, more: false, sourceVersion: `v${n}`,
});

const ENGINES = { chromium: () => chromium.launch({ headless: true, executablePath: findChrome() }), webkit: () => webkit.launch({ headless: true }) };
type Engine = keyof typeof ENGINES;
const browsers: Partial<Record<Engine, Promise<Browser>>> = {};
let bundle: ReturnType<typeof componentBundle> | undefined;
after(async () => { for (const browser of Object.values(browsers)) await (await browser)?.close(); });

/** The display: overall is the page zoom; region zooms one `[data-region]`, as App.tsx applies `ampi.display`. */
type Display = { name: string; overall: number; region?: number };
const DISPLAYS: Display[] = [{ name: "100 %", overall: 1 }, { name: "overall 130 %", overall: 1.3 }, { name: "region 120 %", overall: 1, region: 1.2 }, { name: "overall 130 % and region 120 %", overall: 1.3, region: 1.2 }];

async function open(t: TestContext, engine: Engine, pane: "thread" | "rarebit" | "none", display?: Display, region?: string): Promise<Page> {
	const { script, css: bundled } = await (bundle ??= componentBundle());
	const browser = await (browsers[engine] ??= ENGINES[engine]());
	const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
	t.after(() => page.context().close());
	page.setDefaultTimeout(3000);
	const css = readFileSync(join(web, "src/styles.css"), "utf8");
	await page.route("**/*", (route) => {
		const url = new URL(route.request().url());
		if (url.origin !== ORIGIN) return route.abort();
		if (url.pathname === "/component.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: script });
		if (url.pathname === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<meta charset="utf-8"><style>${css}\n${bundled}</style><div id="root"></div><script>window.PANE = ${JSON.stringify(pane)}</script><script src="/component.js"></script>` });
		return route.abort();
	});
	await page.routeWebSocket("**/ws", (client) => {
		const send = (frame: unknown) => client.send(JSON.stringify(frame));
		send({ t: "hosts", hosts: [HOST] });
		client.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (frame.t === "sub" && frame.topic?.kind === "view" && frame.topic.view === "rarebit") send({ t: "snap", sid: frame.sid, value: rarebit(40) });
			else if (frame.t === "sub" && frame.topic?.kind === "thread") send({ t: "snap", sid: frame.sid, value: view() });
			else if (frame.t === "sub") send({ t: "snap", sid: frame.sid, value: frame.topic?.kind === "threads" ? { threads: {} } : {} });
			else if (frame.t === "req" || frame.t === "hub") send({ t: "res", id: frame.id, ok: false, error: { code: "unsupported", message: "not in this test" } });
		});
	});
	await page.goto(`${ORIGIN}/`);
	if (pane === "thread") await page.locator('[data-entry="e0"]').waitFor();
	if (pane === "rarebit") await page.locator("[data-rarebit=r39]").waitFor();
	if (display) await page.evaluate(([display, region]) => {
		document.documentElement.style.zoom = String(display.overall);
		if (display.region) document.querySelector<HTMLElement>(`[data-region="${region}"]`)!.style.zoom = String(display.region);
	}, [display, region] as const);
	await frames(page);
	return page;
}

const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const near = (actual: number, expected: number, what: string, within = 1) => assert.ok(Math.abs(actual - expected) <= within, `${what}: ${actual.toFixed(4)} vs ${expected.toFixed(4)}`);

for (const engine of Object.keys(ENGINES) as Engine[]) {
	test(`display units (${engine}): scaleOf, toCss and toScreen at zoom 1, 0.8 and 1.3, in a region and a grid column`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, "none");
		for (const zoom of [1, 0.8, 1.3]) {
			const got = await page.evaluate((zoom) => {
				const { scaleOf, toCss, toScreen } = (window as unknown as { display: typeof import("../web/src/display.ts") }).display;
				document.documentElement.style.zoom = String(zoom);
				document.getElementById("root")!.innerHTML = `<div id="box" style="width:200px">box</div><div id="region" style="zoom:1.2"><div id="inner" style="width:200px">inner</div><div id="frac" style="width:333.3px;padding:0 1.5px;border:1px solid">frac</div></div>
					<div style="display:grid;grid-template-columns:300px 1fr"><div id="cell" style="zoom:1.2">cell</div><div></div></div>`;
				const box = document.getElementById("box")!, inner = document.getElementById("inner")!, cell = document.getElementById("cell")!;
				return { box: scaleOf(box), css: toCss(100, box), screen: toScreen(100, box), inner: scaleOf(inner), frac: scaleOf(document.getElementById("frac")!), innerCss: toCss(120, inner), cell: scaleOf(cell, 300), empty: scaleOf(document.createElement("div")) };
			}, zoom);
			near(got.box, zoom, `scale at ${zoom}`, 0.01);
			near(got.css, 100 / zoom, `toCss at ${zoom}`, 0.1);
			near(got.screen, 100 * zoom, `toScreen at ${zoom}`, 0.1);
			near(got.inner, zoom * 1.2, `region scale at ${zoom}`, 0.01);
			// A fractional width: offsetWidth rounds it, which a long scroll multiplies; the scale stays exact.
			near(got.frac, zoom * 1.2, `fractional width scale at ${zoom}`, 0.0003);
			near(got.innerCss, 120 / (zoom * 1.2), `region toCss at ${zoom}`, 0.1);
			// A grid column is the parent's CSS px; the cell's own zoom does not scale it.
			near(got.cell, zoom, `grid column scale at ${zoom}`, 0.01);
			assert.equal(got.empty, 1, "a detached element has scale 1");
		}
	});

	for (const display of DISPLAYS) {

		test(`display units (${engine}, ${display.name}): Rarebit Prev and Next put the user message 12 px below the top`, { skip: engineSkip(engine) }, async (t) => {
			const page = await open(t, engine, "rarebit", display, "panel");
			for (const name of ["Previous user message", "Previous user message", "Next user message"]) {
				const target = await page.evaluate((next) => {
					const el = document.querySelector<HTMLElement>(".rb-scroll")!;
					const { toScreen } = (window as unknown as { display: typeof import("../web/src/display.ts") }).display;
					const line = el.getBoundingClientRect().top + toScreen(12, el);
					const users = [...el.querySelectorAll<HTMLElement>(".rb-message[data-kind='user']")];
					const pick = next ? users.find((u) => u.getBoundingClientRect().top > line + 2) : users.filter((u) => u.getBoundingClientRect().top < line - 2).at(-1);
					return pick!.dataset.rarebit!;
				}, name.startsWith("Next"));
				await page.getByRole("button", { name }).click();
				await frames(page);
				const got = await page.evaluate((target) => {
					const el = document.querySelector<HTMLElement>(".rb-scroll")!;
					const { scaleOf } = (window as unknown as { display: typeof import("../web/src/display.ts") }).display;
					return { offset: el.querySelector<HTMLElement>(`[data-rarebit="${target}"]`)!.getBoundingClientRect().top - el.getBoundingClientRect().top, scale: scaleOf(el) };
				}, target);
				// A written scrollTop rounds to a whole pixel: Chromium a screen px, WebKit down to a CSS px.
				near(got.offset, 12 * got.scale, `${name} to ${target}`, 1.5 * got.scale);
			}
		});
	}
}
