import "./bound.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { build } from "vite";
import react from "@vitejs/plugin-react";
// @ts-ignore: shared browser discovery is plain ESM.
import { findChrome } from "../scripts/perf/browser.mjs";

// The real Overview and RarebitView with the real stylesheets in Chromium; only the hub is a script on the page's
// WebSocket. The 60 px end band belongs to the transcript. A list pane ends at its last 2 px: a reader 30 px above its
// end keeps a pager or a Prev/Next step in place instead of following the bottom (systems review of ui-new-below).

const web = fileURLToPath(new URL("../web", import.meta.url));
const ORIGIN = "http://localhost";
const THREAD = "pi:s1";
const HOST = { id: "devbox", link: "devbox#pi", label: "devbox", kind: "pi-local", status: "connected" };

async function componentBundle(): Promise<{ script: string; css: string }> {
	const entry = join(web, "end-band-test-entry.js");
	const result = await build({
		configFile: false, root: web, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
			name: "end-band-test",
			resolveId: (id) => id === entry ? `\0${entry}` : undefined,
			load: (id) => id === `\0${entry}` ? `
				import React from 'react';
				import { createRoot } from 'react-dom/client';
				import { Overview } from ${JSON.stringify(join(web, "src/components/Overview.tsx"))};
				import { RarebitView } from ${JSON.stringify(join(web, "src/views/rarebit/View.tsx"))};
				const h = React.createElement;
				const host = ${JSON.stringify(HOST)};
				const threads = Array.from({ length: 30 }, (_, i) => ({ id: 'pi:q' + i, title: 'Quiet ' + i, createdAt: 0, updatedAt: Date.now() - (i + 1) * 60000, kind: 'thread', activity: 'idle', queued: 0, costUsd: 0 }));
				const pane = window.PANE === 'overview'
					? h(Overview, { data: [{ host, threads, stale: false }], onNew() {}, onAddHost() {}, onHelp() {} })
					: h(RarebitView, { host: 'devbox', threadId: ${JSON.stringify(THREAD)} });
				createRoot(document.getElementById('root')).render(h('div', { className: 'main-slot', style: { height: '500px' } }, pane));
			` : undefined,
		}],
		build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, formats: ["iife"], name: "EndBandTest" } },
	});
	const output = (Array.isArray(result) ? result[0]! : result) as { output: { type: string; fileName: string; code?: string; source?: string | Uint8Array }[] };
	const css = output.output.filter((item) => item.fileName.endsWith(".css")).map((item) => String(item.source)).join("\n");
	return { script: output.output.find((item) => item.type === "chunk")!.code!, css };
}

const kinds = { user: 0, continuation: 0, stop: 0, toolCalls: 0, toolResults: 0, thinking: 0, summary: 0, other: 0 };
/** Alternating user messages and agent stops, ids r0..r(n-1). */
const rarebit = (n: number) => ({
	items: Array.from({ length: n }, (_, i) => ({ id: `r${i}`, kind: i % 2 === 0 ? "user" : "stop", t: null, text: i % 2 === 0 ? `Question ${i}` : `Answer ${i}. ${"More detail. ".repeat(20 + (i % 5) * 10)}` })),
	stats: { user: Math.ceil(n / 2), continuation: 0, stop: Math.floor(n / 2), compactions: 0, rarebitTokens: n, totalTokens: n, ratio: 1 },
	diagnosis: { session: kinds, live: kinds, entries: n, ms: 1 }, selector: "default", revision: n, more: false, sourceVersion: `v${n}`,
});

/** A user message, two continuations and a stop per turn, ids r0..r(n-1), as an agent asks to go on. */
const continued = (n: number) => {
	const kind = (i: number) => ["user", "continuation", "continuation", "stop"][i % 4]!;
	const items = Array.from({ length: n }, (_, i) => ({ id: `r${i}`, kind: kind(i), t: null, text: kind(i) === "stop" ? `Answer ${i}. ${"More detail. ".repeat(20 + (i % 5) * 10)}` : kind(i) === "user" ? `Question ${i}` : `Continue ${i}` }));
	const count = (k: string) => items.filter((i) => i.kind === k).length;
	return { ...rarebit(n), items, stats: { user: count("user"), continuation: count("continuation"), stop: count("stop"), compactions: 0, rarebitTokens: n, totalTokens: n, ratio: 1 } };
};

let chrome: ReturnType<typeof chromium.launch> | undefined;
let bundle: ReturnType<typeof componentBundle> | undefined;
after(async () => { await (await chrome)?.close(); });

async function open(t: TestContext, pane: "overview" | "rarebit", served: (n: number) => unknown = rarebit): Promise<{ page: Page; publish: (n: number) => Promise<void> }> {
	const { script, css: bundled } = await (bundle ??= componentBundle());
	const browser = await (chrome ??= chromium.launch({ headless: true, executablePath: findChrome() }));
	const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
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
	let send: ((frame: unknown) => void) | undefined;
	let sid: number | undefined;
	await page.routeWebSocket("**/ws", (client) => {
		send = (frame) => client.send(JSON.stringify(frame));
		send({ t: "hosts", hosts: [HOST] });
		client.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (frame.t === "sub" && frame.topic?.kind === "view" && frame.topic.view === "rarebit") { sid = frame.sid; send!({ t: "snap", sid, value: served(40) }); }
			else if (frame.t === "sub") send!({ t: "snap", sid: frame.sid, value: frame.topic?.kind === "threads" ? { threads: {} } : {} });
			else if (frame.t === "req" || frame.t === "hub") send!({ t: "res", id: frame.id, ok: false, error: { code: "unsupported", message: "not in this test" } });
		});
	});
	await page.goto(`${ORIGIN}/`);
	return { page, publish: async (n) => { send!({ t: "snap", sid, value: rarebit(n) }); await page.locator(`[data-rarebit="r${n - 1}"]`).waitFor({ state: "attached" }); await frames(page); } };
}

const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
/** Scroll `selector` to `px` above its end, as the reader's own scroll. */
const toGap = (page: Page, selector: string, px: number) => page.evaluate(([selector, px]) => {
	const el = document.querySelector<HTMLElement>(selector)!;
	el.scrollTop = el.scrollHeight - el.clientHeight - px;
}, [selector, px] as const).then(() => frames(page));
const gap = (page: Page, selector: string) => page.evaluate((selector) => { const el = document.querySelector<HTMLElement>(selector)!; return el.scrollHeight - el.scrollTop - el.clientHeight; }, selector);
const scrollTop = (page: Page, selector: string) => page.evaluate((selector) => document.querySelector<HTMLElement>(selector)!.scrollTop, selector);
const topOf = (page: Page, selector: string) => page.evaluate((selector) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect().top, selector);

test("end band: an Overview pager 30 px above the end keeps its place", async (t) => {
	const { page } = await open(t, "overview");
	const pager = "[data-place='pager:quiet']";
	await page.locator(pager).waitFor();
	await toGap(page, "[data-page-scroller]", 30);
	assert.ok(Math.abs(await gap(page, "[data-page-scroller]") - 30) <= 1, "the reader is 30 px above the end");
	const before = await topOf(page, pager);
	await page.locator(pager).getByRole("button", { name: "Next" }).click();
	await page.locator(pager).getByText("13–24 of 30").waitFor();
	await frames(page);
	const after = await topOf(page, pager);
	assert.ok(Math.abs(after - before) <= 1, `the pager moved from ${before.toFixed(1)} to ${after.toFixed(1)}`);
});

test("end band: a Rarebit Next step that lands 30 px above the end does not follow arrivals; nor does Prev", async (t) => {
	const { page, publish } = await open(t, "rarebit");
	const scroll = ".rb-scroll";
	await page.locator("[data-rarebit=r39]").waitFor();
	// The last stop below r38 is sized so that Next, which puts r38 near the top, lands 30 px above the end.
	await page.evaluate(() => {
		const el = document.querySelector<HTMLElement>(".rb-scroll")!;
		const target = el.querySelector<HTMLElement>("[data-rarebit=r38]")!;
		const top = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 12;
		const last = el.querySelector<HTMLElement>("[data-rarebit=r39]")!;
		last.style.paddingBottom = `${parseFloat(getComputedStyle(last).paddingBottom) + el.clientHeight + 30 - (el.scrollHeight - top)}px`;
		// The reader stops with r38 just below the top line: Next's target.
		el.scrollTop = top - 60;
	});
	await frames(page);
	await page.getByRole("button", { name: "Next user message" }).click();
	await frames(page);
	const landed = await gap(page, scroll);
	assert.ok(Math.abs(landed - 30) <= 2, `Next lands 30 px above the end; gap ${landed.toFixed(1)}`);
	const read = await topOf(page, "[data-rarebit=r38]");
	await publish(41);
	const kept = await topOf(page, "[data-rarebit=r38]");
	assert.ok(Math.abs(kept - read) <= 2, `an arrival moved r38 from ${read.toFixed(1)} to ${kept.toFixed(1)}`);
	// Prev from 30 px above the end steps up, and an arrival below keeps that place.
	await toGap(page, scroll, 30);
	const from = await scrollTop(page, scroll);
	await page.getByRole("button", { name: "Previous user message" }).click();
	await frames(page);
	const stepped = await scrollTop(page, scroll);
	assert.ok(stepped < from, "Prev steps up");
	await publish(42);
	assert.ok(Math.abs(await scrollTop(page, scroll) - stepped) <= 2, "an arrival after Prev moved the reader");
});

// verify-ampi T3b hide-continuations: Prev leaves the bottom; Hide continuations keeps the first visible message.
test("end band: after Prev, Hide continuations keeps the first visible Rarebit message at its height", async (t) => {
	const { page } = await open(t, "rarebit", () => continued(200));
	await page.locator("[data-rarebit=r199]").waitFor();
	await frames(page);
	const anchor = () => page.evaluate(() => {
		const el = document.querySelector<HTMLElement>(".rb-scroll")!;
		const box = el.getBoundingClientRect();
		const first = [...el.querySelectorAll<HTMLElement>(".rb-message.rb-stop[data-rarebit], .rb-message.rb-user[data-rarebit]")].find((i) => i.getBoundingClientRect().top >= box.top)!;
		return { id: first.dataset.rarebit!, y: first.getBoundingClientRect().top - box.top, gap: el.scrollHeight - el.scrollTop - el.clientHeight };
	});
	// Above the bottom, where a shorter list cannot clamp: the toggle's 60-message window then adds stops above the anchor.
	const top = () => page.evaluate(() => document.querySelector<HTMLElement>(".rb-scroll")!.scrollTop);
	for (let i = 0; i < 3; i++) {
		const from = await top();
		await page.getByRole("button", { name: "Previous user message" }).click();
		await page.waitForFunction((from) => document.querySelector<HTMLElement>(".rb-scroll")!.scrollTop < from, from);
		await frames(page);
	}
	const before = await anchor();
	await page.getByRole("button", { name: "Hide continuations" }).click();
	await page.getByRole("button", { name: "Show continuations" }).waitFor();
	await frames(page);
	const after = await topOf(page, `[data-rarebit=${before.id}]`) - await topOf(page, ".rb-scroll");
	assert.ok(Math.abs(after - before.y) <= 2, `${before.id} moved from ${before.y.toFixed(1)} to ${after.toFixed(1)} (gap before ${before.gap.toFixed(1)})`);
});
