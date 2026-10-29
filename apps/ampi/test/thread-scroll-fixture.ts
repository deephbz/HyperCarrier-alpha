import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { build } from "vite";
import react from "@vitejs/plugin-react";
// @ts-ignore: shared browser discovery is plain ESM.
import { findChrome } from "../scripts/perf/browser.mjs";

// The scroll tests' page: the real ThreadView with the real stylesheet in Chromium or WebKit; only the hub is a script
// on the page's WebSocket.

const web = fileURLToPath(new URL("../web", import.meta.url));
const ORIGIN = "http://localhost";
const THREAD = "pi:s1";

export async function componentScript(): Promise<string> {
	const entry = join(web, "thread-scroll-test-entry.js");
	const result = await build({
		configFile: false, root: web, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
			name: "thread-scroll-test",
			resolveId: (id) => id === entry ? `\0${entry}` : undefined,
			load: (id) => id === `\0${entry}` ? `
				import React from 'react';
				import { createRoot } from 'react-dom/client';
				import { ThreadView } from ${JSON.stringify(join(web, "src/components/ThreadView.tsx"))};
				import { arriveEntry } from ${JSON.stringify(join(web, "src/nav.ts"))};
				arriveEntry(); window.addEventListener('hashchange', arriveEntry);
				const threadId = window.THREAD;
				const summary = { id: threadId, title: 'Scroll hold', createdAt: 0, updatedAt: 0, kind: 'thread', activity: 'idle', queued: 0, costUsd: 0 };
				const root = createRoot(document.getElementById('root'));
				const render = () => root.render(React.createElement('div', { className: 'main-slot', style: { height: '600px' } },
					React.createElement(ThreadView, { host: 'devbox', threadId, summary, models: [], panel: undefined, setPanel() {} })));
				render();
				setInterval(() => { if (window.parentTicks) render(); }, 250);
			` : undefined,
		}],
		build: { write: false, minify: false, lib: { entry, formats: ["iife"], name: "ThreadScrollTest" } },
	});
	const output = (Array.isArray(result) ? result[0]! : result) as { output: { type: string; code?: string }[] };
	return output.output.find((item) => item.type === "chunk")!.code!;
}

/** Alternating user and assistant entries of varied height, ids e0..e(n-1). */
export const entries = (n: number) => Array.from({ length: n }, (_, i) => i % 2 === 0
	? { id: `e${i}`, kind: "user", text: `Question ${i}`, images: 0 }
	: { id: `e${i}`, kind: "assistant", blocks: [{ type: "text", text: `Answer ${i}.\n\n${"More detail. ".repeat(4 + (i % 7) * 6)}` }] });
/** entries(200) with every assistant entry split by a bash call: prose, the tool call, and prose after the tool. */
export const splitEntries = () => entries(200).map((entry, i) => entry.kind === "assistant" ? { ...entry, blocks: [
	{ type: "text", text: `Answer ${i}. ${"Details. ".repeat(30)}` },
	{ type: "tool", callId: `mixed${i}`, name: "bash", args: { command: "pwd" } },
	{ type: "text", text: `After tool ${i}. ${"More details. ".repeat(30)}` },
] } : entry);
/** `tail`: extra text on the newest entry, as a streaming answer grows. `from`: the first entry a capped Pi tail serves. */
export const view = (n: number, tail = "", from = 0) => {
	const list: any[] = entries(n);
	if (tail) list[n - 1] = { id: `e${n - 1}`, kind: "assistant", blocks: [{ type: "text", text: tail }] };
	return { conversationId: "s1", hiddenBefore: from > 0, entries: list.slice(from), live: {}, inbox: {}, agent: { cwd: "/work" }, usage: { costUsd: 0 } };
};

let bundle: Promise<string> | undefined;
let chrome: Promise<Browser> | undefined;
let safari: Promise<Browser> | undefined;
after(async () => { await (await chrome)?.close(); await (await safari)?.close(); });
export type Engine = "chromium" | "webkit";
export const ENGINES: Engine[] = ["chromium", "webkit"];

export type Publish = (n: number, tail?: string, from?: number) => Promise<void>;
export const HOSTS = { pi: { id: "devbox", link: "devbox#pi", label: "devbox", kind: "pi-local", status: "connected" }, durable: { id: "devbox", link: "devbox#durable", label: "devbox", kind: "durable", status: "connected" } };
export const THREADS = { pi: THREAD, durable: "tree-a.8" };
/**
 * `zoom`: the overall display size, html `zoom` as App.tsx sets it; the viewport scales with it, so the layout keeps its
 * CSS px. `region`: the transcript's own display size, on every load.
 */
export async function open(t: TestContext, count: number, backend: keyof typeof HOSTS = "pi", engine: Engine = "chromium", zoom = 1, region = 1): Promise<{ page: Page; publish: Publish; send: (value: unknown) => void }> {
	const script = await (bundle ??= componentScript());
	const browser = await (engine === "webkit" ? (safari ??= webkit.launch({ headless: true })) : (chrome ??= chromium.launch({ headless: true, executablePath: findChrome() })));
	const page = await browser.newPage({ viewport: { width: Math.round(1000 * zoom), height: Math.round(700 * zoom) } });
	t.after(() => page.context().close());
	page.setDefaultTimeout(3000);
	const css = readFileSync(join(web, "src/styles.css"), "utf8");
	await page.route("**/*", (route) => {
		const url = new URL(route.request().url());
		if (url.origin !== ORIGIN) return route.abort();
		if (url.pathname === "/component.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: script });
		if (url.pathname === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<meta charset="utf-8"><style>${css}${region === 1 ? "" : `[data-region=transcript]{zoom:${region}}`}</style><div id="root"></div><script>document.documentElement.style.zoom = ${JSON.stringify(String(zoom))}; window.THREAD = ${JSON.stringify(THREADS[backend])}</script><script src="/component.js"></script>` });
		return route.abort();
	});
	let send: ((frame: unknown) => void) | undefined;
	let sid: number | undefined;
	await page.routeWebSocket("**/ws", (client) => {
		send = (frame) => client.send(JSON.stringify(frame));
		send({ t: "hosts", hosts: [HOSTS[backend]] });
		client.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (frame.t === "sub" && frame.topic?.kind === "thread") { sid = frame.sid; send!({ t: "snap", sid, value: view(count) }); }
			else if (frame.t === "sub") send!({ t: "snap", sid: frame.sid, value: frame.topic?.kind === "threads" ? { threads: {} } : {} });
			else if (frame.t === "req" || frame.t === "hub") send!({ t: "res", id: frame.id, ok: false, error: { code: "unsupported", message: "not in this test" } });
		});
	});
	await page.goto(`${ORIGIN}/`);
	// The paint window grows from its first paint to WINDOW entries right after open.
	await page.locator(`[data-entry="e${count - 120}"]`).waitFor({ state: "attached" });
	return {
		page,
		// A reader at the end paints the newest entry; a frozen window away from the end shows the count instead.
		publish: async (n, tail = "", from = 0) => {
			send!({ t: "snap", sid, value: view(n, tail, from) });
			await page.locator(`[data-entry="e${n - 1}"], [data-region=transcript] [role=status] button`).first().waitFor({ state: "attached" });
			await page.waitForTimeout(30);
			await frames(page);
		},
		send: (value) => send!({ t: "snap", sid, value }),
	};
}

export const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
/** The first entry whose bottom is below the scroller's top, and its top relative to the scroller's top. */
export const anchor = (page: Page) => page.evaluate(() => {
	const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
	const top = el.getBoundingClientRect().top;
	const node = [...el.querySelectorAll<HTMLElement>("[data-entry]")].find((n) => n.getBoundingClientRect().bottom > top + 40)!;
	return { id: node.dataset.entry!, offset: node.getBoundingClientRect().top - top };
});
export const offsetOf = (page: Page, id: string) => page.evaluate((id) => {
	const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
	const node = el.querySelector<HTMLElement>(`[data-entry="${id}"]`);
	return node ? node.getBoundingClientRect().top - el.getBoundingClientRect().top : null;
}, id);
export const gap = (page: Page) => page.evaluate(() => { const el = document.querySelector<HTMLElement>("[data-region=transcript]")!; return el.scrollHeight - el.scrollTop - el.clientHeight; });
/** Waits until the reader is more than `px` above the end. A wheel's scroll can land frames after `mouse.wheel` returns. */
export const awayFromEnd = (page: Page, px: number) => page.waitForFunction((px) => {
	const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
	return el.scrollHeight - el.scrollTop - el.clientHeight > px;
}, px, { timeout: 5000 }).catch(() => undefined);

/** A view whose run streams `lines` lines of prose after entry e(n-1). */
export const streaming = (n: number, lines: number) => ({ ...view(n), live: { run: { activity: "streaming" }, generation: { message: { role: "assistant", content: [{ type: "text", text: Array.from({ length: lines }, (_, i) => `Streamed line ${i + 1}.`).join("\n\n") }] } } } });
/** The newest entry e(n-1) with `lines` lines of prose, as one entry grows in place while it streams. */
export const grown = (lines: number, from = 1) => Array.from({ length: lines }, (_, i) => `Streamed line ${from + i} wraps across the transcript width with enough words to take more than one row at this size.`).join("\n\n");

/** The reader scrolls up, away from the newest end. */
export async function scrollAway(page: Page) {
	await page.locator("[data-region=transcript]").hover();
	await page.mouse.wheel(0, -4000);
	await frames(page);
}
/**
 * Waits until the transcript's scrollTop holds for five frames. Linux WebKit animates one wheel over about 200 ms;
 * macOS WebKit and Chromium apply it at once. A reader's place sampled before then is still moving.
 */
export const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => {
	const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
	let last = el.scrollTop, still = 0;
	const tick = () => {
		if (el.scrollTop !== last) { last = el.scrollTop; still = 0; } else if (++still >= 5) return done();
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
}));
export const scrollTop = (page: Page) => page.evaluate(() => document.querySelector<HTMLElement>("[data-region=transcript]")!.scrollTop);

/** The "↓ N new" button a reader away from the end sees. */
export const newButton = (page: Page) => page.locator("[data-region=transcript] [role=status] button");
/** The last streamed line's bottom, below the transcript's visible bottom, and its text. */
export const tailBelow = (page: Page) => page.evaluate(() => {
	const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
	const last = [...el.querySelectorAll<HTMLElement>("[data-entry] p")].at(-1)!;
	return { below: last.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom, text: last.textContent };
});
/** Tool traffic and Team messages, as a busy agent writes them. */
export const traffic = (k: number) => k % 3 === 2
	? [{ id: `m${k}`, kind: "custom", entryKind: "team-update", message: { kind: "team-update", label: "Team", sender: "lead", text: `Team message ${k}` } }]
	: [
		{ id: `c${k}`, kind: "assistant", blocks: [{ type: "tool", callId: `call${k}`, name: "bash", args: { command: `ls ${k}` } }] },
		{ id: `r${k}`, kind: "tool-result", callId: `call${k}`, name: "bash", isError: false, text: `output ${k}`, truncated: false },
	];
/** The source cap: past it, each arrival evicts the oldest entry. */
export const CAP = 400;
