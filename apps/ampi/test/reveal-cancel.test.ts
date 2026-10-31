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

// A reveal request serves the reader only until their next move (nav.ts revealStore.end). Its entry lies outside the
// served tail, so the reveal waits for thread.history; the reply comes 2 s later, after the reader's move or after a
// change the reader did not start. Real ThreadView, stylesheet and hash navigation; synthetic hub frames.
// Known gap: a text-selection drag that autoscrolls the transcript is not a reader move here, and does not end the request.
const web = fileURLToPath(new URL("../web", import.meta.url));
const THREAD = "pi:s1";
const DELAY = 2000;

async function componentScript(): Promise<string> {
	const entry = join(web, "reveal-cancel-test-entry.js");
	const result = await build({
		configFile: false, root: web, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
			name: "reveal-cancel-test",
			resolveId: (id) => id === entry ? `\0${entry}` : undefined,
			load: (id) => id === `\0${entry}` ? `
				import React from 'react';
				import { createRoot } from 'react-dom/client';
				import { ThreadView } from ${JSON.stringify(join(web, "src/components/ThreadView.tsx"))};
				import { arriveEntry, installNavLinks } from ${JSON.stringify(join(web, "src/nav.ts"))};
				import { installKeymapDispatcher } from ${JSON.stringify(join(web, "src/keymap.ts"))};
				// Like App: a route's entry is a reveal request (nav.ts).
				installNavLinks(); installKeymapDispatcher(); arriveEntry(); window.addEventListener('hashchange', arriveEntry);
				// Like App: the route names the Session, and each Session mounts its own view.
				const thread = () => decodeURIComponent(location.hash.split('?')[0].split('/t/')[1] || ${JSON.stringify(THREAD)});
				const summary = (id) => ({ id, title: 'Reveal cancel', createdAt: 0, updatedAt: 0, kind: 'thread', activity: 'idle', queued: 0, costUsd: 0 });
				const root = createRoot(document.getElementById('root'));
				const render = () => root.render(React.createElement('div', { className: 'main-slot', style: { height: '100vh' } },
					React.createElement(ThreadView, { key: thread(), host: 'devbox', threadId: thread(), summary: summary(thread()), models: [], entry: new URLSearchParams(location.hash.split("?")[1] || "").get("e") || undefined, panel: undefined, setPanel() {} })));
				window.addEventListener('hashchange', render); render();
			` : undefined,
		}],
		build: { write: false, minify: false, lib: { entry, formats: ["iife"], name: "RevealCancelTest" } },
	});
	const output = (Array.isArray(result) ? result[0]! : result) as { output: { type: string; code?: string }[] };
	return output.output.find((item) => item.type === "chunk")!.code!;
}

const entries = (n: number) => Array.from({ length: n }, (_, i) => i % 2 === 0
	? { id: "e" + i, kind: "user", text: "Question " + i, images: 0 }
	: { id: "e" + i, kind: "assistant", blocks: [{ type: "text", text: "Answer " + i + " " + "details ".repeat(30) }] });
const view = (n: number) => ({ conversationId: "s1", sourceVersion: "v" + n, hiddenBefore: true, entries: entries(n).slice(-200), live: {}, inbox: {}, agent: { cwd: "/work" }, usage: { costUsd: 0 } });
const outline = (n: number) => ({ version: "v" + n, totalEntries: n, truncated: false, users: entries(n).flatMap((e, i) => e.kind === "user" ? [{ id: e.id, ordinal: i, firstLine: "Question " + i }] : []) });
const TARGET = "e10";
const window1 = { first: 10, last: 10, skipped: 0, start: 0, size: 1 };
const found = { hits: [{ entry: TARGET, ref: TARGET, threadId: THREAD, snippet: "Question 10", version: "v400", prose: true, kind: "user", at: 10 }], more: false, scope: THREAD, asOf: null, total: 1, proseTotal: 1, windows: { all: window1, prose: window1 }, anchored: true, scanned: 400 };

let bundle: Promise<string> | undefined;
let chrome: ReturnType<typeof chromium.launch> | undefined;
after(async () => { await (await chrome)?.close(); });

/** A page whose thread.history replies arrive DELAY ms after their request; `asked` resolves at the request. */
async function open(t: TestContext) {
	const script = await (bundle ??= componentScript());
	const browser = await (chrome ??= chromium.launch({ headless: true, executablePath: findChrome() }));
	const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
	t.after(() => page.context().close());
	page.setDefaultTimeout(5000);
	await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: "<style>" + readFileSync(join(web, "src/styles.css"), "utf8") + "</style><div id=\"root\"></div><script>" + script + "</script>" }));
	let asked!: () => void;
	const history = new Promise<void>((resolve) => { asked = resolve; });
	let replied!: () => void;
	const landed = new Promise<void>((resolve) => { replied = resolve; });
	let publish!: (n: number) => void;
	let count = 400;
	/** The Sessions whose thread topic a mounted view asked for, in order. */
	const threads: string[] = [];
	await page.routeWebSocket("**/ws", (client) => {
		const send = (frame: unknown) => client.send(JSON.stringify(frame));
		let sid: number;
		publish = (n) => { count = n; send({ t: "snap", sid, value: view(n) }); };
		send({ t: "hosts", hosts: [{ id: "devbox", link: "devbox", label: "Demo", kind: "pi-local", status: "connected" }] });
		client.onMessage((message) => {
			const f = JSON.parse(String(message));
			if (f.t === "sub" && f.topic.kind === "thread") { sid = f.sid; threads.push(f.topic.threadId); send({ t: "snap", sid, value: view(count) }); }
			else if (f.t === "sub") send({ t: "snap", sid: f.sid, value: f.topic.kind === "threads" ? { threads: {} } : {} });
			else if (f.t === "req" && f.op === "thread.outline") send({ t: "res", id: f.id, ok: true, value: outline(count) });
			else if (f.t === "req" && f.op === "thread.find") send({ t: "res", id: f.id, ok: true, value: found });
			else if (f.t === "req" && f.op === "thread.history") {
				asked();
				setTimeout(() => { send({ t: "res", id: f.id, ok: true, value: { entries: entries(count).slice(0, 60), more: true, version: "v" + count } }); replied(); }, DELAY);
			} else if (f.t === "req" || f.t === "hub") send({ t: "res", id: f.id, ok: false, error: { code: "unsupported", message: "fixture" } });
		});
	});
	await page.goto("http://localhost/");
	await page.locator("[data-outline-version=\"v400\"]").waitFor();
	await page.locator("[data-entry=\"e399\"]").waitFor();
	/** Waits for the delayed reply, then for longer than a reveal settles. */
	const afterReply = async () => { await landed; await page.waitForTimeout(800); };
	return { page, history, afterReply, threads, publish: (n: number) => publish(n) };
}

/** Asks for the reveal through the rail, as a followed link does; the history read is then in flight. */
async function reveal(page: Page, history: Promise<void>) {
	await page.locator(`[data-user-mark="${TARGET}"]`).click();
	await history;
}

const place = (page: Page) => page.locator(".scroll").evaluate((el) => ({ top: el.scrollTop, end: el.scrollHeight - el.scrollTop - el.clientHeight <= 2 }));
const targetInView = (page: Page) => page.evaluate((id) => {
	const el = document.querySelector(`[data-entry="${id}"]`), box = document.querySelector(".scroll")!.getBoundingClientRect();
	if (!el) return false;
	const r = el.getBoundingClientRect();
	return r.bottom > box.top && r.top < box.bottom;
}, TARGET);

test("reveal cancel: G before the history reply keeps the reader at the newest end, following", async (t) => {
	const { page, history, afterReply, publish } = await open(t);
	await reveal(page, history);
	await page.locator(".scroll").focus();
	await page.keyboard.press("G");
	await afterReply();
	assert.equal(await targetInView(page), false, "the late reply does not move the reader");
	assert.equal((await place(page)).end, true);
	publish(402);
	await page.locator("[data-entry=\"e401\"]").waitFor();
	await page.waitForTimeout(100);
	assert.equal((await place(page)).end, true, "the reader still follows arrivals");
});

test("reveal cancel: a Find close before the history reply leaves the reader in place", async (t) => {
	const { page, history, afterReply } = await open(t);
	await page.getByRole("button", { name: "Find in this Session", exact: true }).click();
	await page.getByRole("textbox", { name: "Find in Session", exact: true }).fill("Question 10");
	// The Find result asks for the reveal of its match.
	await history;
	await page.getByRole("button", { name: "Close Find", exact: true }).click();
	const before = await place(page);
	await afterReply();
	assert.equal(await targetInView(page), false, "the late reply does not move the reader");
	assert.ok(Math.abs((await place(page)).top - before.top) <= 2, "the reader stays where Find left them");
});

const scrolls: [string, (page: Page) => Promise<void>][] = [
	["a trackpad scroll", async (page) => {
		const box = (await page.locator(".scroll").boundingBox())!;
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.wheel(0, -400);
	}],
	["PageUp", async (page) => { await page.locator(".scroll").focus(); await page.keyboard.press("PageUp"); }],
];
for (const [name, scroll] of scrolls) test(`reveal cancel: ${name} before the history reply leaves the reader in place`, async (t) => {
	const { page, history, afterReply } = await open(t);
	await reveal(page, history);
	await scroll(page);
	await page.waitForTimeout(300);
	const before = await place(page);
	assert.equal(before.end, false);
	await afterReply();
	assert.equal(await targetInView(page), false, "the late reply does not move the reader");
	assert.ok(Math.abs((await place(page)).top - before.top) <= 2, "the reader stays where they scrolled");
});

test("reveal cancel: the reader's send before the history reply goes to the newest end", async (t) => {
	const { page, history, afterReply } = await open(t);
	await reveal(page, history);
	const composer = page.getByRole("textbox", { name: "Message the agent", exact: true });
	await composer.fill("hello");
	await composer.press("Enter");
	await afterReply();
	assert.equal(await targetInView(page), false, "the late reply does not move the reader");
	assert.equal((await place(page)).end, true);
});

test("reveal cancel: a Session switch and return before the history reply return to the reader's place", async (t) => {
	const { page, history, afterReply, threads } = await open(t);
	await reveal(page, history);
	const before = await place(page);
	await page.evaluate(() => { location.hash = "#/h/devbox/t/pi%3As2"; });
	await page.locator("[data-entry=\"e399\"]").waitFor();
	assert.ok(threads.includes("pi:s2"), "B mounted");
	await page.evaluate(() => { location.hash = "#/h/devbox/t/pi%3As1"; });
	await page.locator("[data-entry=\"e399\"]").waitFor();
	await afterReply();
	assert.equal(await targetInView(page), false, "the late reply does not move the reader");
	assert.ok(Math.abs((await place(page)).top - before.top) <= 2, "the reader is back at their place in the Session");
});

test("reveal cancel: a lens toggle and a resize before the history reply keep the reveal", async (t) => {
	const { page, history, afterReply } = await open(t);
	await reveal(page, history);
	await page.getByLabel("Transcript mode").first().getByText("Chat", { exact: true }).click();
	await page.setViewportSize({ width: 900, height: 640 });
	await afterReply();
	assert.equal(await targetInView(page), true, "changes the reader did not start keep the request");
});
