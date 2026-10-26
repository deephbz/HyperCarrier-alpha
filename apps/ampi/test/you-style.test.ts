import "./bound.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build } from "vite";
import react from "@vitejs/plugin-react";
// @ts-ignore: shared browser discovery is plain ESM.
import { findChrome } from "../scripts/perf/browser.mjs";

// The real ThreadView and RarebitView with the real stylesheets in Chromium; only the hub is a script on the page's
// WebSocket. A user message reads the same in the main transcript and in the Rarebit messages panel: one shared class
// carries its colors (owner request, backlog "You" style).

const web = fileURLToPath(new URL("../web", import.meta.url));
const ORIGIN = "http://localhost";
const HOSTS = { pi: { id: "devbox", link: "devbox#pi", label: "devbox", kind: "pi-local", status: "connected" }, durable: { id: "devbox", link: "devbox#durable", label: "devbox", kind: "durable", status: "connected" } };
const THREADS = { pi: "pi:s1", durable: "tree-a.8" };

async function componentBundle(): Promise<{ script: string; css: string }> {
	const entry = join(web, "you-style-test-entry.js");
	const result = await build({
		configFile: false, root: web, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
			name: "you-style-test",
			resolveId: (id) => id === entry ? `\0${entry}` : undefined,
			load: (id) => id === `\0${entry}` ? `
				import React from 'react';
				import { createRoot } from 'react-dom/client';
				import { ThreadView } from ${JSON.stringify(join(web, "src/components/ThreadView.tsx"))};
				import { RarebitView } from ${JSON.stringify(join(web, "src/views/rarebit/View.tsx"))};
				const threadId = window.THREAD;
				const summary = { id: threadId, title: 'You style', createdAt: 0, updatedAt: 0, kind: 'thread', activity: 'idle', queued: 0, costUsd: 0 };
				const h = React.createElement;
				createRoot(document.getElementById('root')).render(h('div', { style: { display: 'flex', height: '600px' } },
					h('div', { className: 'main-slot', style: { flex: 1, height: '600px' } },
						h(ThreadView, { host: 'devbox', threadId, summary, models: [], panel: undefined, setPanel() {} })),
					h('div', { style: { flex: 1, height: '600px', overflow: 'auto' } }, h(RarebitView, { host: 'devbox', threadId }))));
			` : undefined,
		}],
		build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, formats: ["iife"], name: "YouStyleTest" } },
	});
	const output = (Array.isArray(result) ? result[0]! : result) as { output: { type: string; fileName: string; code?: string; source?: string | Uint8Array }[] };
	const css = output.output.filter((item) => item.fileName.endsWith(".css")).map((item) => String(item.source)).join("\n");
	return { script: output.output.find((item) => item.type === "chunk")!.code!, css };
}

const thread = { conversationId: "s1", hiddenBefore: false, entries: [
	{ id: "e0", kind: "user", text: "Question", images: 0, ts: 0 },
	{ id: "e1", kind: "assistant", blocks: [{ type: "text", text: "Answer." }] },
], live: {}, inbox: {}, agent: { cwd: "/work" }, usage: { costUsd: 0 } };
const kinds = { user: 0, continuation: 0, stop: 0, toolCalls: 0, toolResults: 0, thinking: 0, summary: 0, other: 0 };
const rarebit = {
	items: [{ id: "e0", kind: "user", t: "2026-10-25T00:00:00.000Z", text: "Question" }, { id: "e1", kind: "stop", t: "2026-10-25T00:00:01.000Z", text: "Answer." }],
	stats: { user: 1, continuation: 0, stop: 1, compactions: 0, rarebitTokens: 2, totalTokens: 2, ratio: 1 },
	diagnosis: { session: kinds, live: kinds, entries: 2, ms: 1 }, selector: "default", revision: 1, more: false, sourceVersion: "v1",
};

let chrome: ReturnType<typeof chromium.launch> | undefined;
let bundle: ReturnType<typeof componentBundle> | undefined;
after(async () => { await (await chrome)?.close(); });

const side = { id: "side-1", at: "2026-10-25T00:00:02.000Z", count: 2, included: 2, omittedChars: 0, revision: 1, model: "test/model", turns: [{ question: "Side question", answer: "Side answer." }] };

for (const backend of ["pi", "durable"] as const) test(`You style (${backend}): a user message has the same colors in the transcript and the Rarebit messages panel`, async (t) => {
	const { script, css: bundled } = await (bundle ??= componentBundle());
	const browser = await (chrome ??= chromium.launch({ headless: true, executablePath: findChrome() }));
	const page = await browser.newPage({ viewport: { width: 1400, height: 700 } });
	t.after(() => page.context().close());
	page.setDefaultTimeout(5000);
	const css = readFileSync(join(web, "src/styles.css"), "utf8");
	await page.route("**/*", (route) => {
		const url = new URL(route.request().url());
		if (url.origin !== ORIGIN) return route.abort();
		if (url.pathname === "/component.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: script });
		if (url.pathname === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<meta charset="utf-8"><style>${css}\n${bundled}</style><div id="root"></div><script>window.THREAD = ${JSON.stringify(THREADS[backend])}</script><script src="/component.js"></script>` });
		return route.abort();
	});
	await page.routeWebSocket("**/ws", (client) => {
		const send = (frame: unknown) => client.send(JSON.stringify(frame));
		send({ t: "hosts", hosts: [HOSTS[backend]] });
		client.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (frame.t === "sub") {
				const topic = frame.topic ?? {};
				send({ t: "snap", sid: frame.sid, value: topic.kind === "thread" ? thread : topic.kind === "view" && topic.view === "rarebit" ? rarebit : topic.kind === "threads" ? { threads: {} } : {} });
			} else if (frame.t === "req" && frame.op === "view.rarebit.ask") send({ t: "res", id: frame.id, ok: true, value: { side } });
			else if (frame.t === "req" || frame.t === "hub") send({ t: "res", id: frame.id, ok: false, error: { code: "unsupported", message: "not in this test" } });
		});
	});
	await page.goto(`${ORIGIN}/`);
	await page.locator(".msg.user[data-entry=e0]").waitFor();
	await page.locator(".rb-message[data-rarebit=e0]").waitFor();
	// A durable thread renders the durable transcript: its user entry offers Fork, a Pi Session's does not.
	assert.equal(await page.locator(".msg.user[data-entry=e0] button", { hasText: "Fork" }).count(), backend === "durable" ? 1 : 0, `${backend}: the transcript renders the ${backend} path`);
	// Only user messages carry the shared class: never an assistant entry, a stop, or a side answer.
	const shared = () => page.evaluate(() => [...document.querySelectorAll(".you")].map((n) => (n as HTMLElement).dataset.entry ?? (n as HTMLElement).dataset.rarebit ?? (n.closest(".rb-side") ? "side" : n.className)));
	assert.deepEqual(await shared(), ["e0", "e0"], `${backend}: the shared "you" class marks the transcript and Rarebit user messages only`);
	const look = (selector: string, label: string) => page.evaluate(([selector, label]) => {
		const box = document.querySelector<HTMLElement>(selector)!;
		const head = getComputedStyle(box.querySelector<HTMLElement>(label)!);
		const s = getComputedStyle(box);
		return { shared: box.classList.contains("you"), background: s.backgroundColor, border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`, label: `${head.color} ${head.fontWeight}` };
	}, [selector, label] as const);
	const looks: Record<string, Awaited<ReturnType<typeof look>>> = {};
	for (const scheme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		const inTranscript = looks[scheme] = await look(".msg.user[data-entry=e0]", ".who > span");
		const inPanel = await look(".rb-message[data-rarebit=e0]", ".rb-message-heading");
		assert.deepEqual(inTranscript, inPanel, `${scheme}: the transcript user message differs from the Rarebit one`);
		assert.ok(inTranscript.shared, `${scheme}: both user messages carry the shared "you" class`);
		const assistant = await look(".msg[data-entry=e1]", "*");
		assert.ok(!assistant.shared && assistant.border !== inTranscript.border, `${scheme}: an assistant entry takes the user message style`);
	}
	// A side ask replaces the panel list with its question, in the same style, and its answer, without it.
	await page.getByRole("textbox", { name: "Ask on the side" }).fill("Side question");
	await page.getByRole("textbox", { name: "Ask on the side" }).press("Enter");
	await page.locator(".rb-side .rb-message.rb-stop").waitFor();
	assert.deepEqual(await shared(), ["e0", "side"], `${backend}: the shared "you" class marks the transcript user entry and the side-ask question only`);
	for (const scheme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		assert.deepEqual(await look(".rb-side .rb-message.rb-user", ".rb-message-heading"), looks[scheme], `${scheme}: the side-ask question differs from the transcript user message`);
	}
});
