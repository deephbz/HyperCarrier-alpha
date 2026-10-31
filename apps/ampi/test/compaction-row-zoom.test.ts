import "./bound.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit, type Browser } from "playwright";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import type { CompactRecord } from "@hypercarrier/auto-compact-durable";
// @ts-ignore: shared browser discovery is plain ESM.
import { findChrome } from "../scripts/perf/browser.mjs";
import { engineSkip } from "./engines.ts";

// The collapsed compaction rows, in their longest forms (three-digit counts, manual, low cache), stay on one line
// in the transcript column at the owner's 130 % display size, in Chromium and WebKit. The page is the real App with
// its stylesheet; the display size comes from the app's own zoom keys. The hub is a script on the page's WebSocket.

const web = fileURLToPath(new URL("../web", import.meta.url));
// A secure context, as loopback is: the app uses crypto.randomUUID.
const ORIGIN = "http://localhost";
const ZOOM = 1.3;
const HOST = { id: "devbox", link: "devbox#durable", label: "devbox", kind: "durable", status: "connected" };
const THREAD = "c1";

async function appScript(): Promise<string> {
	const entry = join(web, "compaction-row-zoom-test-entry.js");
	const result = await build({
		configFile: false, root: web, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
			name: "compaction-row-zoom-test",
			resolveId: (id) => id === entry ? `\0${entry}` : undefined,
			load: (id) => id === `\0${entry}` ? `
				import React from 'react';
				import { createRoot } from 'react-dom/client';
				import { App } from ${JSON.stringify(join(web, "src/App.tsx"))};
				createRoot(document.getElementById('root')).render(React.createElement(App));
			` : undefined,
		}],
		build: { write: false, minify: false, lib: { entry, formats: ["iife"], name: "CompactionRowZoomTest" } },
	});
	const output = (Array.isArray(result) ? result[0]! : result) as { output: { type: string; code?: string }[] };
	return output.output.find((item) => item.type === "chunk")!.code!;
}

const planner = { model: "claude/claude-haiku-5-5", requests: 1, usage: { input: 51_362, output: 399, cacheRead: 12_039, cacheWrite: 0, cost: 0 }, promptTokens: 63_401, cache: "19% of 63401 prompt tokens read from cache" };
const keep = (kept: number, dropped: number) => ({ cap: 20000, perItemTokens: 8000, keptTokens: 19_010, kept: Array.from({ length: kept }, (_, i) => ({ label: `t${i + 300}`, name: "read", entryId: String(i + 100), tokens: 1500 })), dropped: [], droppedCount: dropped });
const fit = "the summary does not fit: summary 10012 + kept tail 272 + prompt 4711 = 14995 tokens, over the 12600-token compaction trigger";
const RECORDS: CompactRecord[] = [
	{ method: "keepset", taskId: "task-1", attempts: 1, reason: "threshold", at: 1, replacedEntries: 412, firstKept: 430, planner, keep: keep(12, 287) },
	{ method: "keepset", taskId: "task-2", attempts: 1, reason: "manual", at: 1, replacedEntries: 1, firstKept: 431, planner: { ...planner, usage: { ...planner.usage, cacheRead: 60_000 } }, keep: keep(1, 0) },
	{ method: "native-fallback", taskId: "task-3", reason: "manual", at: 1, replacedEntries: 4, firstKept: 9, planRejected: fit, error: fit, planner },
	{ method: "native-fallback", taskId: "task-4", reason: "threshold", at: 1, replacedEntries: 4, firstKept: 9, error: "no cache reuse: no request captured for this conversation in this process" },
	{ method: "keepset", taskId: "task-5", attempts: 1, reason: "manual", at: 1, replacedEntries: 412, firstKept: 430, planner, keep: keep(12, 287) },
];
const summary = "## Working-state summary (written by you just before compaction)\n\nGoal: rename the parser.";
const ENTRIES = RECORDS.map((record, i) => ({ id: String(40 + i), kind: "compaction", summary: record.method === "keepset" ? summary : "native summary text", reason: record.reason, ts: 1000 * (i + 1), byTaskId: record.taskId }));
const view = { conversationId: THREAD, hiddenBefore: false, entries: ENTRIES, live: {}, inbox: {}, agent: { cwd: "/work" }, usage: { costUsd: 0 } };
const thread = { id: THREAD, title: "Compaction rows", createdAt: 0, updatedAt: 0, kind: "thread", activity: "idle", queued: 0, costUsd: 0 };
const ROWS = [
	/^Compacted · 412 entries replaced · 12 outputs kept · 287 dropped · low cache · \d\d:\d\d$/,
	/^Compacted \(manual\) · 1 entry replaced · 1 output kept · 0 dropped · \d\d:\d\d$/,
	/^Compacted \(manual\) · summary only \(plan too large for the window\) · low cache · \d\d:\d\d$/,
	/^Compacted · summary only \(first compaction after a restart; planner has no cached request yet\) · \d\d:\d\d$/,
	/^Compacted \(manual\) · 412 entries replaced · 12 outputs kept · 287 dropped · low cache · \d\d:\d\d$/,
];

let script: Promise<string> | undefined;
const browsers: Promise<Browser>[] = [];
after(async () => { for (const b of browsers) await (await b).close(); });

// Line fit depends on the system fonts. AmPi renders on macOS; Linux fonts are wider (a 809 px row text in an 817 px row).
const fonts = process.platform === "darwin" ? false : "line fit needs the macOS system fonts";
for (const engine of ["chromium", "webkit"] as const) {
	test(`compaction rows (${engine}): the longest rows keep one line at the app's zoom ${ZOOM}`, { skip: engineSkip(engine) || fonts }, async (t) => {
		const code = await (script ??= appScript());
		const launched = engine === "webkit" ? webkit.launch({ headless: true }) : chromium.launch({ headless: true, executablePath: findChrome() });
		browsers.push(launched);
		const page = await (await launched).newPage({ viewport: { width: Math.round(1000 * ZOOM), height: Math.round(700 * ZOOM) } });
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
		await page.routeWebSocket("**/ws", (client) => {
			const send = (frame: unknown) => client.send(JSON.stringify(frame));
			send({ t: "hosts", hosts: [HOST] });
			client.onMessage((message) => {
				const frame = JSON.parse(String(message));
				if (frame.t === "sub") send({ t: "snap", sid: frame.sid, value: frame.topic?.kind === "thread" ? view : frame.topic?.kind === "threads" ? { threads: { [THREAD]: thread } } : {} });
				else if (frame.t === "req" && frame.op === "compact.records") send({ t: "res", id: frame.id, ok: true, value: { records: RECORDS } });
				else if (frame.t === "req" || frame.t === "hub") send({ t: "res", id: frame.id, ok: false, error: { code: "unsupported", message: "not in this test" } });
			});
		});
		await page.goto(`${ORIGIN}/#/h/${encodeURIComponent(HOST.link)}/t/${THREAD}`);
		await page.locator(`.compaction[data-entry="44"][title]`).waitFor();
		// The app's zoom keys: six steps of 5 % from 100 %.
		for (let i = 0; i < 6; i++) await page.keyboard.press("Meta+Shift+Equal");
		await page.waitForFunction(() => document.documentElement.style.zoom === "1.3");
		const rows = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".compaction")].map((row) => {
			const range = document.createRange();
			range.selectNodeContents(row);
			// Each wrapped line adds a rect at a new top; the dashes are pseudo-elements, outside the range.
			const rects = [...range.getClientRects()].filter((r) => r.width > 0);
			const tops = new Set(rects.map((r) => Math.round(r.top)));
			const width = Math.round(rects.reduce((sum, r) => sum + r.width, 0));
			const box = row.getBoundingClientRect().width;
			return { text: row.textContent ?? "", lines: tops.size, title: row.title, spare: Math.round(box - width), width: `text ${width}px in a ${Math.round(box)}px row` };
		}));
		t.diagnostic(rows.map((row) => row.width).join("; "));
		assert.equal(rows.length, ROWS.length, JSON.stringify(rows.map((r) => r.text)));
		rows.forEach((row, i) => assert.match(row.text, ROWS[i]!));
		assert.match(rows[0]!.title, /keepset · 412 entries replaced · 12 outputs kept \(19\.0k of 20\.0k\)/);
		assert.match(rows[2]!.title, /the summary does not fit: summary 10012/);
		for (const row of rows) assert.equal(row.lines, 1, `one line at zoom ${ZOOM} (${row.width}): ${row.text}`);
		assert.ok(rows[4]!.spare >= 20, `the longest manual row keeps 20px spare (${rows[4]!.width})`);
	});
}
