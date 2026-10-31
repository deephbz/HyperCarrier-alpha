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
					? h(Overview, { data: [{ host, threads, stale: false }], onNew() {}, onHostSetup() {}, onHelp() {} })
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

async function open(t: TestContext, pane: "overview" | "rarebit", served: (n: number) => unknown = rarebit): Promise<{ page: Page; publish: (n: number) => Promise<void>; serve: (value: unknown) => Promise<void>; frame: (value: unknown) => string }> {
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
	// The page's hub socket, so a test can deliver a frame in the task of a reader's input (`frame`).
	await page.addInitScript(() => {
		const Socket = window.WebSocket;
		(window as unknown as { WebSocket: unknown }).WebSocket = class extends Socket {
			constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); Object.assign(window, { hubSocket: this }); }
		};
	});
	await page.goto(`${ORIGIN}/`);
	return {
		frame: (value) => JSON.stringify({ t: "snap", sid, value }),
		page,
		publish: async (n) => { send!({ t: "snap", sid, value: rarebit(n) }); await page.locator(`[data-rarebit="r${n - 1}"]`).waitFor({ state: "attached" }); await frames(page); },
		serve: async (value) => { send!({ t: "snap", sid, value }); await frames(page); },
	};
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

// verify-ampi T3b show-keeps-place (I17): Show remaps the 60-message window around the anchor. The shown slice can end
// a few continuations below it, too little content for the anchor's height, and the restore then clamps at the bottom.
test("end band: after Prev, Hide then Show continuations keeps the first visible Rarebit message at its height", async (t) => {
	const { page } = await open(t, "rarebit", () => continued(200));
	await page.locator("[data-rarebit=r199]").waitFor();
	await frames(page);
	const from = await scrollTop(page, ".rb-scroll");
	await page.getByRole("button", { name: "Previous user message" }).click();
	await page.waitForFunction((from) => document.querySelector<HTMLElement>(".rb-scroll")!.scrollTop < from, from);
	await frames(page);
	const anchor = () => page.evaluate(() => {
		const el = document.querySelector<HTMLElement>(".rb-scroll")!;
		const box = el.getBoundingClientRect();
		const first = [...el.querySelectorAll<HTMLElement>(".rb-message.rb-stop[data-rarebit], .rb-message.rb-user[data-rarebit]")].find((i) => i.getBoundingClientRect().top >= box.top)!;
		return { id: first.dataset.rarebit!, y: first.getBoundingClientRect().top - box.top, gap: el.scrollHeight - el.scrollTop - el.clientHeight };
	});
	const before = await anchor();
	for (const [click, done] of [["Hide continuations", "Show continuations"], ["Show continuations", "Hide continuations"]] as const) {
		await page.getByRole("button", { name: click }).click();
		await page.getByRole("button", { name: done }).waitFor();
		await frames(page);
		const now = await anchor();
		assert.ok(now.id === before.id && Math.abs(now.y - before.y) <= 2, `${click}: ${before.id} at ${before.y.toFixed(1)} became ${now.id} at ${now.y.toFixed(1)} (gap ${now.gap.toFixed(1)})`);
	}
});

// The jump effect is the one writer of a placed message: the hook restores nothing in the render a step or a toggle
// places, whatever order the effects run in.
test("end band: Prev, Hide and Show each write the Rarebit scrollTop once", async (t) => {
	const { page } = await open(t, "rarebit", () => continued(200));
	await page.locator("[data-rarebit=r199]").waitFor();
	await frames(page);
	await page.evaluate(() => {
		const el = document.querySelector<HTMLElement>(".rb-scroll")!;
		const own = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
		Object.assign(window, { writes: 0 });
		Object.defineProperty(el, "scrollTop", { configurable: true, get() { return own.get!.call(this); }, set(value: number) { (window as unknown as { writes: number }).writes++; own.set!.call(this, value); } });
	});
	const writes: Record<string, number> = {};
	for (const [click, done] of [["Previous user message", "Previous user message"], ["Hide continuations", "Show continuations"], ["Show continuations", "Hide continuations"]] as const) {
		await page.evaluate(() => Object.assign(window, { writes: 0 }));
		await page.getByRole("button", { name: click }).click();
		await page.getByRole("button", { name: done }).waitFor();
		await frames(page);
		writes[click] = await page.evaluate(() => (window as unknown as { writes: number }).writes);
	}
	assert.deepEqual(writes, { "Previous user message": 1, "Hide continuations": 1, "Show continuations": 1 });
});

// A resize before the placing write's scroll event (the panel or the window changes size) restores the hook's record:
// the record must be the placed message, not the place before it.
test("end band: a resize before the scroll event keeps the message that Prev, Hide or Show placed", async (t) => {
	const { page } = await open(t, "rarebit", () => continued(200));
	await page.locator("[data-rarebit=r199]").waitFor();
	await frames(page);
	// From the bottom, Prev lands r196 over tail space: the placed scrollTop is the bottom.
	for (const [label, height] of [["Previous user message", 460], ["Hide continuations", 420], ["Show continuations", 380]] as const) {
		const result = await page.evaluate(async ([label, height]) => {
			const el = document.querySelector<HTMLElement>(".rb-scroll")!;
			const first = () => {
				const box = el.getBoundingClientRect();
				const node = [...el.querySelectorAll<HTMLElement>(".rb-message.rb-stop[data-rarebit], .rb-message.rb-user[data-rarebit]")].find((i) => i.getBoundingClientRect().top >= box.top)!;
				return { id: node.dataset.rarebit!, y: node.getBoundingClientRect().top - box.top };
			};
			const from = el.scrollTop;
			document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
			for (let i = 0; i < 50 && el.scrollTop === from; i++) await Promise.resolve();
			if (el.scrollTop === from) return { error: "the click did not write scrollTop in its task" };
			const placed = first();
			document.querySelector<HTMLElement>(".main-slot")!.style.height = `${height}px`;
			await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
			const node = el.querySelector<HTMLElement>(`[data-rarebit="${placed.id}"]`)!;
			return { placed, after: node.getBoundingClientRect().top - el.getBoundingClientRect().top };
		}, [label, height] as const);
		assert.ok(!("error" in result), `${label}: ${"error" in result ? result.error : ""}`);
		if ("error" in result) return;
		assert.ok(Math.abs(result.after - result.placed.y) <= 2, `${label}: ${result.placed.id} placed at ${result.placed.y.toFixed(1)} moved to ${result.after.toFixed(1)} after a resize`);
	}
});

// A placement ends at the view's record(): the hook keeps the place again in the next render. A message above the placed
// one that grows (its snapshot text changes) moves the placed message unless that render restores it.
test("end band: after Prev places a Rarebit message, a message above it that grows keeps it at its height", async (t) => {
	const { page, serve } = await open(t, "rarebit");
	const scroll = ".rb-scroll";
	await page.locator("[data-rarebit=r39]").waitFor();
	await page.evaluate(() => { const el = document.querySelector<HTMLElement>(".rb-scroll")!; el.scrollTop = el.scrollHeight / 2; });
	await frames(page);
	const from = await scrollTop(page, scroll);
	await page.getByRole("button", { name: "Previous user message" }).click();
	await page.waitForFunction((from) => document.querySelector<HTMLElement>(".rb-scroll")!.scrollTop < from, from);
	await frames(page);
	const placed = await page.evaluate(() => {
		const el = document.querySelector<HTMLElement>(".rb-scroll")!;
		const box = el.getBoundingClientRect();
		const first = [...el.querySelectorAll<HTMLElement>(".rb-message.rb-user[data-rarebit]")].find((i) => i.getBoundingClientRect().top >= box.top)!;
		return { id: first.dataset.rarebit!, y: first.getBoundingClientRect().top - box.top };
	});
	assert.ok(Number(placed.id.slice(1)) > 2, `Prev placed ${placed.id}, with r1 above it`);
	const grown = rarebit(40);
	grown.items[1]!.text += " Longer now.".repeat(200);
	await serve({ ...grown, revision: 41, sourceVersion: "v40-grown" });
	await page.waitForFunction(() => document.querySelector("[data-rarebit=r1]")!.textContent!.includes("Longer now."));
	await frames(page);
	const after = await topOf(page, `[data-rarebit=${placed.id}]`) - await topOf(page, scroll);
	assert.ok(Math.abs(after - placed.y) <= 2, `${placed.id} placed at ${placed.y.toFixed(1)} moved to ${after.toFixed(1)} when r1 grew`);
});

// The reader's own scroll input takes back a place the view holds: a step's write waits for its render, and a wheel or
// key in between wins (systems review of K1). Without input the step writes once.
test("end band: a reader's scroll input before a Rarebit step lands takes the place back", async (t) => {
	const { page } = await open(t, "rarebit");
	await page.locator("[data-rarebit=r39]").waitFor();
	await page.evaluate(() => { const el = document.querySelector<HTMLElement>(".rb-scroll")!; el.scrollTop = el.scrollHeight / 2; });
	await frames(page);
	const moves: Record<string, number> = {};
	for (const input of ["none", "wheel up", "wheel down", "ArrowUp", "PageDown"]) {
		moves[input] = await page.evaluate(async (input) => {
			const el = document.querySelector<HTMLElement>(".rb-scroll")!;
			const own = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
			let moved = 0;
			Object.defineProperty(el, "scrollTop", { configurable: true, get() { return own.get!.call(this); }, set(value: number) { if (Math.abs(value - own.get!.call(this)) >= 1) moved++; own.set!.call(this, value); } });
			document.querySelector<HTMLButtonElement>('button[aria-label="Previous user message"]')!.click();
			// The step renders in a later microtask, so this input comes first, as a reader's input between tasks would.
			if (input.startsWith("wheel")) el.dispatchEvent(new WheelEvent("wheel", { deltaY: input === "wheel up" ? -100 : 100, bubbles: true }));
			else if (input !== "none") el.dispatchEvent(new KeyboardEvent("keydown", { key: input, bubbles: true, cancelable: true }));
			await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
			delete (el as { scrollTop?: number }).scrollTop;
			return moved;
		}, input);
	}
	assert.deepEqual(moves, { none: 1, "wheel up": 0, "wheel down": 0, ArrowUp: 0, PageDown: 0 });
});

// After the reader's input takes a step back, a render restores the reader's place. That place is where the reader is
// until their scroll's first frame, so the restore must write nothing: a write cancels the browser's smooth scroll.
test("end band: a scroll up that takes a Rarebit step back keeps going through an arrival before its first frame", async (t) => {
	const { page, frame } = await open(t, "rarebit");
	await page.locator("[data-rarebit=r39]").waitFor();
	await page.evaluate(() => { const el = document.querySelector<HTMLElement>(".rb-scroll")!; el.scrollTop = el.scrollHeight / 2; });
	await frames(page);
	const from = await page.evaluate((data) => {
		const el = document.querySelector<HTMLElement>(".rb-scroll")!;
		const from = el.scrollTop;
		document.querySelector<HTMLButtonElement>('button[aria-label="Previous user message"]')!.click();
		el.dispatchEvent(new WheelEvent("wheel", { deltaY: -300, bubbles: true }));
		// A dispatched event scrolls nothing itself: this is the browser's smooth scroll for that wheel.
		el.scrollTo({ top: from - 300, behavior: "smooth" });
		(window as unknown as { hubSocket: WebSocket }).hubSocket.dispatchEvent(new MessageEvent("message", { data }));
		return from;
	}, frame(rarebit(41)));
	await page.locator('[data-rarebit="r40"]').waitFor({ state: "attached" });
	for (let i = 0; i < 20; i++) await frames(page);
	const now = await scrollTop(page, ".rb-scroll");
	assert.ok(Math.abs(from - 300 - now) < 2, `the scroll went ${(from - now).toFixed(1)} px up of 300 through the step and the arrival`);
});

// An up scroll from the end leaves the end at its input. A smooth scroll (the browser's own for a wheel or an arrow key)
// moves no pixel before its first frame; an arrival that renders before it would follow and cancel it.
test("end band: an up scroll from the Rarebit end keeps going through an arrival before its first frame", async (t) => {
	const { page, frame } = await open(t, "rarebit");
	await page.locator("[data-rarebit=r39]").waitFor();
	await frames(page);
	let n = 40;
	for (const input of ["wheel", "ArrowUp", "PageUp"]) {
		await page.evaluate(() => { const el = document.querySelector<HTMLElement>(".rb-scroll")!; el.scrollTop = el.scrollHeight; });
		await frames(page);
		assert.ok(await gap(page, ".rb-scroll") <= 2, `${input}: the reader starts at the end`);
		n++;
		const from = await page.evaluate(([input, data]) => {
			const el = document.querySelector<HTMLElement>(".rb-scroll")!;
			const from = el.scrollTop;
			el.dispatchEvent(input === "wheel" ? new WheelEvent("wheel", { deltaY: -300, bubbles: true }) : new KeyboardEvent("keydown", { key: input, bubbles: true, cancelable: true }));
			// A dispatched event scrolls nothing itself: this is the browser's smooth scroll for that input.
			el.scrollTo({ top: from - 300, behavior: "smooth" });
			(window as unknown as { hubSocket: WebSocket }).hubSocket.dispatchEvent(new MessageEvent("message", { data }));
			return from;
		}, [input, frame(rarebit(n))] as const);
		await page.locator(`[data-rarebit="r${n - 1}"]`).waitFor({ state: "attached" });
		for (let i = 0; i < 20; i++) await frames(page);
		const now = await scrollTop(page, ".rb-scroll");
		assert.ok(from - now > 250, `${input}: the scroll went ${(from - now).toFixed(1)} px up through the arrival`);
	}
});

// Blank tail space shows only at the newest message. Show remaps the window around the anchor and can end it a row
// below; while newer messages wait behind "Show 60 newer", they fill the space below the anchor instead.
test("end band: Show that ends the window just below the anchor fills it with newer messages, not blank space", async (t) => {
	const { page } = await open(t, "rarebit", () => continued(200));
	await page.locator("[data-rarebit=r199]").waitFor();
	await frames(page);
	const scroll = ".rb-scroll";
	const view = () => page.evaluate(() => {
		const el = document.querySelector<HTMLElement>(".rb-scroll")!;
		const box = el.getBoundingClientRect();
		const first = [...el.querySelectorAll<HTMLElement>(".rb-message.rb-stop[data-rarebit], .rb-message.rb-user[data-rarebit]")].find((i) => i.getBoundingClientRect().top >= box.top)!;
		const blank = [...el.children].filter((node) => node.getAttribute("aria-hidden") === "true").reduce((sum, node) => sum + (node as HTMLElement).offsetHeight, 0);
		const newer = [...el.querySelectorAll("button")].some((button) => button.textContent === "Show 60 newer");
		return { id: first.dataset.rarebit!, y: first.getBoundingClientRect().top - box.top, last: [...el.querySelectorAll<HTMLElement>("[data-rarebit]")].at(-1)!.dataset.rarebit!, blank, newer };
	});
	// A window of older messages, read in its middle with continuations hidden, then near its end.
	await page.getByRole("button", { name: /Show 60 earlier/ }).click();
	await frames(page);
	await toGap(page, scroll, 1200);
	await page.getByRole("button", { name: "Hide continuations" }).click();
	await page.getByRole("button", { name: "Show continuations" }).waitFor();
	await frames(page);
	await toGap(page, scroll, 20);
	const before = await view();
	assert.ok(before.newer, "newer messages wait behind the window");
	await page.getByRole("button", { name: "Show continuations" }).click();
	await page.getByRole("button", { name: "Hide continuations" }).waitFor();
	await frames(page);
	const now = await view();
	assert.ok(now.id === before.id && Math.abs(now.y - before.y) <= 2, `${before.id} at ${before.y.toFixed(1)} became ${now.id} at ${now.y.toFixed(1)}`);
	assert.ok(!now.newer || now.blank === 0, `${now.blank} px of blank space below ${now.last}, with newer messages behind "Show 60 newer"`);
	assert.ok(Number(now.last.slice(1)) > Number(before.id.slice(1)) + 2, `newer messages fill below ${before.id}; the window ends at ${now.last}`);
});

// A Rarebit step can add tail space in one pass and write scrollTop in the next. A reader's scroll input between the
// two takes the place back (K1); the dropped step must not leave its tail space. React runs both passes in one task, so
// the input here comes as the spacer mounts.
test("end band: a reader's scroll input that takes back a Rarebit step leaves no tail space of the step", async (t) => {
	const { page } = await open(t, "rarebit");
	await page.locator("[data-rarebit=r39]").waitFor();
	// The reader stops with r38, the last user message, just below the top line: Next's target.
	await page.evaluate(() => {
		const el = document.querySelector<HTMLElement>(".rb-scroll")!;
		el.scrollTop = el.querySelector<HTMLElement>("[data-rarebit=r38]")!.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 72;
	});
	await frames(page);
	const result = await page.evaluate(async () => {
		const el = document.querySelector<HTMLElement>(".rb-scroll")!;
		const blank = () => [...el.children].filter((node) => node.getAttribute("aria-hidden") === "true").reduce((sum, node) => sum + (node as HTMLElement).offsetHeight, 0);
		const before = blank();
		let inputs = 0;
		const own = { appendChild: el.appendChild, insertBefore: el.insertBefore };
		const input = <T,>(node: T) => {
			if (node instanceof HTMLElement && node.getAttribute("aria-hidden") === "true") { inputs++; el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true })); }
			return node;
		};
		el.appendChild = function <T extends Node>(node: T) { return input(own.appendChild.call(this, node) as T); };
		el.insertBefore = function <T extends Node>(node: T, child: Node | null) { return input(own.insertBefore.call(this, node, child) as T); };
		// Next lands r38 on the reading line over tail space: r38 and r39 cannot fill the pane below it.
		document.querySelector<HTMLButtonElement>('button[aria-label="Next user message"]')!.click();
		await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
		Object.assign(el, own);
		return { before, inputs, after: blank() };
	});
	assert.equal(result.inputs, 1, "the step added tail space, and the reader's input came as it mounted");
	assert.equal(result.after, result.before, `the dropped step left ${result.after - result.before} px of tail space`);
});

// A toggle keeps the anchor at its offset; a window that slides to fill newer messages keeps that much content above it.
// A tall continuation across the top edge puts the first visible message 160 px down, more than the window's own top. The
// hidden list keeps more than 60 messages after it, so the slid window starts at or above it.
test("end band: Hide that slides the window to newer messages keeps an anchor that sits low on screen", async (t) => {
	const tall = (n: number) => {
		const value = continued(n);
		for (const i of [215, 217, 218, 219]) value.items[i] = { ...value.items[i]!, kind: "continuation", text: `Continue ${i}. ${"A long continuation. ".repeat(250)}` };
		return value;
	};
	const { page } = await open(t, "rarebit", () => tall(400));
	await page.locator("[data-rarebit=r399]").waitFor();
	await page.evaluate(() => { document.querySelector<HTMLElement>(".main-slot")!.style.height = "1200px"; });
	await frames(page);
	for (const id of ["r280", "r220", "r160"]) {
		await page.getByRole("button", { name: /Show 60 earlier/ }).click();
		await page.locator(`[data-rarebit=${id}]`).waitFor();
	}
	await frames(page);
	await page.evaluate(() => {
		const el = document.querySelector<HTMLElement>(".rb-scroll")!;
		el.scrollTop += el.querySelector<HTMLElement>("[data-rarebit=r216]")!.getBoundingClientRect().top - el.getBoundingClientRect().top - 160;
	});
	await frames(page);
	const at = () => page.evaluate(() => {
		const el = document.querySelector<HTMLElement>(".rb-scroll")!;
		const box = el.getBoundingClientRect();
		const y = (id: string) => el.querySelector<HTMLElement>(`[data-rarebit=${id}]`)!.getBoundingClientRect().top - box.top;
		const blank = [...el.children].filter((node) => node.getAttribute("aria-hidden") === "true").reduce((sum, node) => sum + (node as HTMLElement).offsetHeight, 0);
		const newer = [...el.querySelectorAll("button")].some((button) => button.textContent === "Show 60 newer");
		return { y: y("r216"), above: el.querySelector("[data-rarebit=r215]") ? y("r215") : undefined, blank, newer };
	});
	const before = await at();
	assert.ok(Math.abs(before.y - 160) <= 1 && before.above! < 0, `r216 sits at ${before.y.toFixed(1)} below r215 across the top edge (${before.above?.toFixed(1)})`);
	await page.getByRole("button", { name: "Hide continuations" }).click();
	await page.getByRole("button", { name: "Show continuations" }).waitFor();
	await frames(page);
	const now = await at();
	assert.ok(Math.abs(now.y - before.y) <= 2, `Hide moved r216 from ${before.y.toFixed(1)} to ${now.y.toFixed(1)}`);
	assert.ok(!now.newer || now.blank === 0, `${now.blank} px of blank space with newer messages behind "Show 60 newer"`);
});

// Tail space belongs to the jump that placed a message. A window change of the reader's own, such as Show 60 earlier
// and then Show 60 newer, places nothing, so the old room does not come back below the newest message.
test("end band: Show 60 earlier then Show 60 newer leaves no tail space of an earlier step", async (t) => {
	const { page } = await open(t, "rarebit", () => rarebit(200));
	await page.locator("[data-rarebit=r199]").waitFor();
	await frames(page);
	const blank = () => page.evaluate(() => [...document.querySelector<HTMLElement>(".rb-scroll")!.children].filter((node) => node.getAttribute("aria-hidden") === "true").reduce((sum, node) => sum + (node as HTMLElement).offsetHeight, 0));
	// The reader stops with r198, the last user message, just below the top line. Next lands it over tail space.
	await page.evaluate(() => {
		const el = document.querySelector<HTMLElement>(".rb-scroll")!;
		el.scrollTop += el.querySelector<HTMLElement>("[data-rarebit=r198]")!.getBoundingClientRect().top - el.getBoundingClientRect().top - 72;
	});
	await frames(page);
	await page.getByRole("button", { name: "Next user message" }).click();
	await frames(page);
	const placed = await blank();
	assert.ok(placed > 0, "Next added tail space");
	await page.getByRole("button", { name: /Show 60 earlier/ }).click();
	await page.locator("[data-rarebit=r80]").waitFor();
	await page.getByRole("button", { name: "Show 60 newer" }).click();
	await page.locator("[data-rarebit=r199]").waitFor();
	await frames(page);
	assert.equal(await blank(), 0, `${placed} px of tail space from Next came back after Show 60 earlier and Show 60 newer`);
});
