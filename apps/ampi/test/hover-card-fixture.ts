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

// The real hover cards (the Composer's Session HUD and SessionTitle's metadata) with the real stylesheet, in Chromium
// and WebKit. Every hover card's border box lies inside the viewport with a 12 px margin on its first painted frame, and
// again after its content, the display size, or the window changes. The owner's AmPi.app runs at display size 130 %
// (`ampi.display`), the zoom that put the Composer HUD card past the bottom-right of the screen.

const web = fileURLToPath(new URL("../web", import.meta.url));
const ORIGIN = "http://localhost";
const MARGIN = 12;

async function componentScript(): Promise<string> {
	const entry = join(web, "hover-card-test-entry.js");
	const result = await build({
		configFile: false, root: web, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
			name: "hover-card-test",
			resolveId: (id) => id === entry ? `\0${entry}` : undefined,
			load: (id) => id === `\0${entry}` ? `
				import React from 'react';
				import { createRoot } from 'react-dom/client';
				import { ModelHudCard } from ${JSON.stringify(join(web, "src/components/ModelHudCard.tsx"))};
				import { SessionTitle } from ${JSON.stringify(join(web, "src/components/SessionTitle.tsx"))};
				const h = React.createElement;
				const id = 'tree-' + 'a1b2c3d4'.repeat(24);
				const summary = { id, title: 'Placement', cwd: '/workspace/' + 'deep/'.repeat(30) + 'billing', createdAt: 0, updatedAt: 0, kind: 'thread',
					activity: 'idle', queued: 0, costUsd: 1.5, model: 'magpie/claude/claude-opus-5-5-' + 'x'.repeat(80), contextTokens: 133100, cacheHit: 97 };
				const corners = { 'bottom-right': { right: 0, bottom: 0 }, 'bottom-left': { left: 0, bottom: 0 }, 'top-right': { right: 0, top: 0 } };
				const root = createRoot(document.getElementById('root'));
				let key = 0;
				let generation = 0;
				// setup({ corner, card, rows, keep }): the anchor sits in the Composer region at that corner. 'rows' grows the card.
				// React commits the render later; the region's data-setup names the setup it shows. Returns that name.
				window.setup = ({ corner, card, rows = 0, keep = false }) => {
					if (!keep) key++;
					generation++;
					const extra = rows ? h('div', null, Array.from({ length: rows }, (_, i) => h('p', { key: i }, 'Worker ' + i + ' ' + id))) : undefined;
					const anchor = card === 'hud'
						? h(ModelHudCard, { summary: rows ? { ...summary, title: Array.from({ length: rows }, (_, i) => 'line ' + i).join(' ') } : summary, label: 'HUD' })
						: h(SessionTitle, { title: 'Placement', summary, host: 'devbox', parent: extra }, h('span', { className: 'session-title-text' }, 'Placement'));
					root.render(h('div', { key, 'data-setup': String(generation), 'data-region': 'composer', className: 'composer-bar', style: { position: 'fixed', padding: '6px', ...corners[corner] } }, anchor));
					return String(generation);
				};
			` : undefined,
		}],
		build: { write: false, minify: false, lib: { entry, formats: ["iife"], name: "HoverCardTest" } },
	});
	const output = (Array.isArray(result) ? result[0]! : result) as { output: { type: string; code?: string }[] };
	return output.output.find((item) => item.type === "chunk")!.code!;
}

let bundle: Promise<string> | undefined;
export const ENGINES = { chromium: () => chromium.launch({ headless: true, executablePath: findChrome() }), webkit: () => webkit.launch({ headless: true }) };
export type Engine = keyof typeof ENGINES;
const browsers: Partial<Record<Engine, Promise<Browser>>> = {};
after(async () => { for (const browser of Object.values(browsers)) await (await browser)?.close(); });

type Setup = { corner: "bottom-right" | "bottom-left" | "top-right"; card: "hud" | "title"; rows?: number; keep?: boolean };
export async function open(t: TestContext, engine: Engine): Promise<Page> {
	const script = await (bundle ??= componentScript());
	const browser = await (browsers[engine] ??= ENGINES[engine]());
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	t.after(() => page.context().close());
	page.setDefaultTimeout(3000);
	const css = readFileSync(join(web, "src/styles.css"), "utf8");
	await page.route("**/*", (route) => {
		const url = new URL(route.request().url());
		if (url.origin !== ORIGIN) return route.abort();
		if (url.pathname === "/component.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: script });
		if (url.pathname === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<meta charset="utf-8"><style>${css}</style><div id="root"></div><script src="/component.js"></script>` });
		return route.abort();
	});
	await page.routeWebSocket("**/ws", (client) => client.send(JSON.stringify({ t: "hosts", hosts: [] })));
	await page.goto(`${ORIGIN}/`);
	// Each animation frame records the open card's border box, so a test sees the first painted frame.
	await page.evaluate(() => {
		const w = window as unknown as { frames: number[][] };
		w.frames = [];
		const tick = () => {
			const card = document.querySelector<HTMLElement>("section.session-metadata");
			if (card && getComputedStyle(card).visibility !== "hidden") { const r = card.getBoundingClientRect(); w.frames.push([r.left, r.top, r.right, r.bottom]); }
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
	return page;
}

export const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
/** Renders a setup and waits, at most 3 s, until React has committed it; a failure names the last region it saw. */
export async function setup(page: Page, value: Setup) {
	const seen = await page.evaluate(async (value) => {
		const generation = (window as unknown as { setup(v: unknown): string }).setup(value);
		const shown = () => document.querySelector<HTMLElement>("[data-region=composer]")?.dataset.setup ?? "none";
		for (const end = performance.now() + 3000; performance.now() < end;) {
			if (shown() === generation) return undefined;
			await new Promise((done) => setTimeout(done, 0));
		}
		return `setup ${generation} not committed after 3 s; the Composer region shows setup ${shown()}`;
	}, value);
	if (seen) assert.fail(seen);
}
export const zoom = (page: Page, overall: number, composer: number) => page.evaluate(([overall, composer]) => {
	document.documentElement.style.zoom = String(overall);
	document.querySelector<HTMLElement>("[data-region=composer]")!.style.zoom = String(composer);
	window.dispatchEvent(new Event("ampi:display"));
}, [overall, composer]);
export const trigger = (card: Setup["card"]) => card === "hud" ? ".model-hud-trigger" : ".session-title-text";
/** The card's border box, the viewport, and whether the card scrolls. */
export const measure = (page: Page) => page.evaluate(() => {
	const card = document.querySelector<HTMLElement>("section.session-metadata");
	if (!card) return undefined;
	const r = card.getBoundingClientRect();
	return { box: [r.left, r.top, r.right, r.bottom], width: innerWidth, height: innerHeight, scrolls: card.scrollHeight > card.clientHeight + 1 };
});
const inside = (box: number[], width: number, height: number) =>
	box[0]! >= MARGIN - 0.5 && box[1]! >= MARGIN - 0.5 && box[2]! <= width - MARGIN + 0.5 && box[3]! <= height - MARGIN + 0.5;
const fmt = (box: number[]) => box.map((v) => v.toFixed(0)).join(",");
export async function assertInside(page: Page, label: string) {
	const m = await measure(page);
	assert.ok(m, `${label}: the card is open`);
	assert.ok(inside(m.box, m.width, m.height), `${label}: card [${fmt(m.box)}] leaves the ${m.width}x${m.height} viewport`);
	return m;
}
export async function hoverOpen(page: Page, value: Setup, label: string) {
	await page.mouse.move(2, 2);
	await setup(page, value);
	await page.evaluate(() => { (window as unknown as { frames: number[][] }).frames = []; });
	await page.hover(trigger(value.card));
	await page.locator("section.session-metadata").waitFor({ state: "attached" });
	await frames(page);
	const m = await assertInside(page, label);
	const painted = await page.evaluate(() => (window as unknown as { frames: number[][] }).frames);
	assert.ok(painted.length > 0, `${label}: a frame painted the card`);
	for (const box of painted) assert.ok(inside(box, m.width, m.height), `${label}: a painted frame showed the card at [${fmt(box)}]`);
	return m;
}

export const ZOOMS = [[1, 1], [1.3, 1], [1.3, 1.15], [0.8, 1]] as const;
export const CORNERS = ["bottom-right", "bottom-left", "top-right"] as const;

/** Registers each engine's first-painted-frame case over the viewport sizes `sizes`. */
export const firstFrameCases = (sizes: readonly (readonly [number, number])[]) => {
	for (const engine of Object.keys(ENGINES) as Engine[]) {
		test(`${engine}: every hover card opens fully inside a ${sizes.map(([width, height]) => `${width}x${height}`).join(" or ")} viewport on its first painted frame`, { skip: engineSkip(engine) }, async (t) => {
			const page = await open(t, engine);
			for (const [width, height] of sizes) {
				await page.setViewportSize({ width, height });
				for (const [overall, composer] of ZOOMS) for (const corner of CORNERS) for (const [card, rows] of [["hud", 0], ["title", 0], ["title", 120]] as const) {
					await setup(page, { corner, card, rows });
					await zoom(page, overall, composer);
					const m = await hoverOpen(page, { corner, card, rows, keep: true }, `${width}x${height} zoom ${overall}/${composer} ${corner} ${card}${rows ? " huge" : ""}`);
					if (rows) assert.ok(m.scrolls, `${width}x${height} zoom ${overall}: a card taller than the viewport scrolls inside`);
				}
			}
		});
	}
};
