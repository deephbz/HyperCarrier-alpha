import "./bound.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page, type WebSocketRoute } from "playwright";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { arcPanelFixture } from "./arc-panel-fixture.ts";
// @ts-ignore: shared browser discovery is plain ESM.
import { findChrome } from "../scripts/perf/browser.mjs";

const web = fileURLToPath(new URL("../web", import.meta.url));
const origin = "http://localhost";
let browser: Browser, script: string, css: string;
before(async () => {
	const entry = join(web, "arc-panel-test.js");
	const result = await build({ configFile: false, root: web, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
		name: "arc-panel-test", resolveId: (id) => id === entry ? `\0${entry}` : undefined,
		load: (id) => id === `\0${entry}` ? `import React from 'react'; import { createRoot } from 'react-dom/client'; import { PiPanel } from ${JSON.stringify(join(web, "src/views/PiPanel.tsx"))};
		createRoot(document.getElementById('root')).render(React.createElement(PiPanel, {name:'arc', host:'devbox', threadId:'pi:arc-demo', summary:{id:'pi:arc-demo', activity:'idle', live:true, updatedAt:1792529400000}, setPanel:()=>{}}));` : undefined,
	}], build: { write: false, minify: false, lib: { entry, formats: ["iife"], name: "ArcPanelTest" } } });
	const output = (Array.isArray(result) ? result[0]! : result) as { output: { type: string; code?: string; source?: string; fileName: string }[] };
	script = output.output.find((item) => item.type === "chunk")!.code!;
	css = readFileSync(join(web, "src/styles.css"), "utf8") + output.output.filter((item) => item.fileName.endsWith(".css")).map((item) => item.source).join("\n");
	browser = await chromium.launch({ headless: true, executablePath: findChrome() });
});
after(async () => { await browser?.close(); });
const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

test("Arc panel: source disclosure, timeline sync, scoped boards, receipt arrivals and narrow themes", async (t) => {
	const page = await browser.newPage({ viewport: { width: 720, height: 1000 }, timezoneId: "UTC" });
	t.after(() => page.context().close());
	page.setDefaultTimeout(5000);
	const errors: string[] = [], requests: { op: string; args: Record<string, unknown> }[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	let socket: WebSocketRoute, sid: number;
	let value = arcPanelFixture();
	await page.route("**/*", (route) => {
		const url = new URL(route.request().url());
		if (url.origin !== origin) { errors.push(`External request ${url.origin}`); return route.abort(); }
		if (url.pathname === "/component.js") return route.fulfill({ contentType: "text/javascript", body: script });
		return route.fulfill({ contentType: "text/html", body: `<meta charset="utf-8"><style>${css}\n#root,.panel{width:100%;height:100vh;min-width:0}.panel-body{overflow-anchor:none}</style><div id="root"></div><script src="/component.js"></script>` });
	});
	await page.routeWebSocket("**/ws", (client) => {
		socket = client;
		client.onMessage((data) => {
			const frame = JSON.parse(String(data));
			if (frame.t === "sub") { assert.equal(frame.topic.view, "arc"); sid = frame.sid; client.send(JSON.stringify({ t: "snap", sid, value })); }
			if (frame.t === "req") {
				requests.push({ op: frame.op, args: frame.args });
				client.send(JSON.stringify({ t: "res", id: frame.id, ok: true, value: frame.op === "thread.entry" ? { text: `The source starts here. Evidence for ${frame.args.entry}. The source ends here.`, next: 0, more: false, version: "fixture" } : {} }));
			}
		});
	});
	await page.goto(origin);
	await page.getByRole("heading", { name: "Chapters (15)", exact: true }).waitFor();
	assert.equal(requests.length, 0, "reading a receipt makes no request or Build");
	assert.deepEqual(await page.locator(".arc-needs [data-point]").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-point"))), ["K1", "K2", "K5"]);
	assert.match(await page.locator(".arc-needs").innerText(), /Unblock[\s\S]*Confirm or reverse[\s\S]*Answer/);
	// A kept point shows its age where the owner reads it.
	assert.deepEqual(await page.locator(".arc-needs .arc-kept").evaluateAll((nodes) => nodes.map((n) => n.closest("[data-point]")?.getAttribute("data-point"))), ["K2"]);
	const row = page.locator('[data-chapter="3"] .arc-chapter-row');
	await row.hover();
	assert.equal(await page.locator('[data-band="3"]').getAttribute("class"), "arc-band  hover");
	assert.equal(await page.locator('[data-number="3"]').getAttribute("class"), "hover");
	await row.click();
	assert.equal(await row.getAttribute("aria-expanded"), "true");
	assert.equal(await page.locator(".arc-band-flash").count(), 1);
	await page.locator('[data-band="2"]').click();
	assert.equal(await page.locator('[data-chapter="2"] .arc-chapter-row').getAttribute("aria-expanded"), "true");
	const beforePath = await page.locator(".arc-stream").getAttribute("d");
	await page.getByRole("button", { name: "$", exact: true }).click();
	assert.notEqual(await page.locator(".arc-stream").getAttribute("d"), beforePath);
	await page.getByRole("button", { name: "Expand all", exact: true }).click();
	assert.equal(await page.locator('.arc-chapter-row[aria-expanded="true"]').count(), 15);
	await page.getByRole("button", { name: "Collapse all", exact: true }).click();
	assert.equal(await page.locator('.arc-chapter-row[aria-expanded="true"]').count(), 0);
	await row.click();
	await page.locator('[data-chapter="3"]').getByRole("button", { name: "Show its 4 key points" }).click();
	assert.equal(await page.getByLabel("Key point scope").inputValue(), "3");
	assert.equal(await page.locator(".arc-key-points h2").innerText(), "Key points (4)");
	// The Arc panel uses the shared type scale: headings and the Now label at body size, meta one step below.
	assert.deepEqual(await page.evaluate(() => [".arc-key-points h2", ".arc-now-label", ".arc-meta"].map((s) => getComputedStyle(document.querySelector(s)!).fontSize)), ["13px", "13px", "12px"]);
	assert.equal(await page.getByRole("button", { name: "Requests (1)" }).count(), 1);
	await page.getByRole("button", { name: "Requests (1)" }).click();
	assert.equal(await page.locator(".arc-board [data-point]").count(), 1);
	await page.getByLabel("Key point scope").selectOption("all");
	assert.equal(await page.getByRole("button", { name: "Requests (15)" }).count(), 1);
	const cite = page.locator(".arc-now .arc-cite").first();
	assert.equal(await cite.innerText(), "reply-15", "the chip retains a readable message reference");
	assert.ok((await page.locator(".arc-cite").allTextContents()).every((label) => /[0-9]/.test(label)), "every synthetic citation has its ID suffix");
	await cite.hover();
	await page.getByRole("region", { name: "Source reply-15" }).locator(".arc-source mark").waitFor();
	assert.match(await page.getByRole("region", { name: "Source reply-15" }).innerText(), /The source starts here\.[\s\S]*Evidence for reply-15\./);
	assert.equal(requests.filter((r) => r.op === "thread.entry").length, 1);
	await cite.click();
	assert.match(page.url(), /e=reply-15&p=arc/);
	await page.getByRole("button", { name: "Build", exact: true }).click();
	await page.getByLabel("Arc Build options").click();
	await page.getByRole("button", { name: "Rebuild", exact: true }).click();
	assert.deepEqual(requests.filter((r) => r.op === "view.arc.build").map((r) => r.args), [{ threadId: "pi:arc-demo" }, { threadId: "pi:arc-demo", rebuild: true }]);

	// A receipt arrival adds content above the reader. It must preserve the visible chapter and its open state.
	await row.click(); await row.click();
	await row.scrollIntoViewIfNeeded(); await frames(page);
	const top = await row.evaluate((el) => el.getBoundingClientRect().top);
	value = structuredClone(value);
	value.receipt!.builtAt = "2026-10-21T21:01:00Z";
	value.lastStopAt = "2026-10-21T20:59:00Z";
	value.receipt!.now.text += " Additional source checks passed.";
	socket!.send(JSON.stringify({ t: "snap", sid: sid!, value }));
	await page.getByText(/Updated 21:01/).waitFor(); await frames(page);
	assert.equal(await row.getAttribute("aria-expanded"), "true");
	assert.match(await page.locator(".arc-now").innerText(), /Its last report was 20:59/);
	assert.ok(Math.abs(await row.evaluate((el) => el.getBoundingClientRect().top) - top) < 2, "receipt arrival preserves the reading anchor");

	for (const width of [720, 559, 380, 320]) {
		await page.setViewportSize({ width, height: 1000 }); await frames(page);
		const layout = await page.evaluate(() => {
			const panel = document.querySelector(".panel-body")!;
			const columns = [".arc-span", ".arc-tokens", ".arc-cost"].map((selector) => [...document.querySelectorAll(selector)].map((el) => el.getBoundingClientRect().right));
			return { overflow: panel.scrollWidth - panel.clientWidth, columns, widths: [...document.querySelectorAll("[data-band]")].map((el) => el.getBoundingClientRect().width), board: getComputedStyle(document.querySelector(".arc-board")!).gridTemplateColumns.split(" ").length, secondLine: document.querySelector(".arc-span")!.getBoundingClientRect().top > document.querySelector(".arc-label")!.getBoundingClientRect().top };
		});
		assert.ok(layout.overflow <= 1, `${width}px: no sideways scroll (${layout.overflow})`);
		for (const column of layout.columns) assert.ok(Math.max(...column) - Math.min(...column) < 1, `${width}px: right columns align`);
		assert.ok(Math.min(...layout.widths) >= 7.9, `${width}px: every chapter band is clickable`);
		if (width < 560) { assert.equal(layout.board, 1); assert.equal(layout.secondLine, true); }
	}
	await page.setViewportSize({ width: 380, height: 1100 });
	await page.getByRole("button", { name: "Collapse all", exact: true }).click();
	await page.locator('[data-chapter="15"] .arc-chapter-row').click();
	await page.locator(".panel-body").evaluate((el) => { el.scrollTop = 0; });
	const proof = process.env.AMPI_ARC_PROOF;
	for (const theme of ["light", "dark"]) {
		await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme); await frames(page);
		const colors = await page.locator(".arc-now").evaluate((el) => ({ text: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor }));
		assert.notEqual(colors.text, colors.background);
		if (proof) { mkdirSync(proof, { recursive: true }); await page.screenshot({ path: join(proof, `arc-panel-${theme}-380.png`) }); }
	}
	// With automatic Builds on, a failure stays queued with its error until the retry.
	value.status = { state: "queued", error: { code: "model", message: "Synthetic provider unavailable" }, nextAt: "2026-10-21T21:05:00Z" };
	value.receipt!.asOfCount = 640; value.stale = 436; value.sourceCount = 1076;
	value.receipt!.builds.at(-1)!.state = "failed"; value.receipt!.builds.at(-1)!.error = value.status.error;
	socket!.send(JSON.stringify({ t: "snap", sid: sid!, value }));
	await page.getByRole("alert").waitFor();
	assert.match(await page.getByRole("alert").innerText(), /Showing the last good Arc/);
	assert.equal(await page.locator("[data-chapter]").count(), 15);
	assert.match(await page.locator(".arc-status").innerText(), /Covers 640 of 1,076 messages/);
	assert.match(await page.getByRole("alert").innerText(), /Build failed: Synthetic provider unavailable.*Build to cover the remaining messages/);
	assert.equal(await page.getByRole("button", { name: "Build", exact: true }).isEnabled(), true);
	assert.match(await page.getByRole("alert").innerText(), /next try 21:05/);
	assert.equal((await page.locator(".arc-panel").innerText()).match(/next try|starts 21:05/g)?.length, 1, "the retry time shows once");
	assert.match(await page.locator(".arc-status").innerText(), /Saved 21:01 \(partial\)/);
	// A partial Arc reads like a complete one: the status line alone says what it covers.
	assert.doesNotMatch(await page.locator(".arc-panel h2").first().innerText(), /as of/i);
	assert.doesNotMatch(await page.locator(".arc-needs").innerText(), /later messages/);
	await page.locator(".panel-body").evaluate((el) => { el.scrollTop = 0; });
	for (const theme of ["light", "dark"]) {
		await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme); await frames(page);
		if (proof) await page.screenshot({ path: join(proof, `arc-partial-${theme}-380.png`) });
	}
	value.status = { state: "queued", nextAt: "2026-10-21T21:05:00Z" };
	socket!.send(JSON.stringify({ t: "snap", sid: sid!, value }));
	await page.getByText(/Queued/).waitFor();
	assert.match(await page.locator(".arc-status").innerText(), /Saved 21:01 \(partial\).*Covers 640 of 1,076 messages/s);
	for (const theme of ["light", "dark"]) {
		await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme); await frames(page);
		if (proof) await page.screenshot({ path: join(proof, `arc-queued-${theme}-380.png`) });
	}
	// An older hub sends progress text only; the panel shows it as it is.
	value.status = { state: "building", progress: "Building window 1, call 1" };
	socket!.send(JSON.stringify({ t: "snap", sid: sid!, value }));
	await page.getByText(/Building window/).waitFor();
	assert.match(await page.locator(".arc-status").innerText(), /Covers 640 of 1,076 messages/);
	// Contract: arc.md / View: progress names the whole job in one muted italic line; elapsed time ticks outside the
	// status region, and the retry reason is on hover only.
	const startedAt = new Date(Date.now() - 72_000).toISOString();
	value.status = { state: "building", progress: "Building messages 641–1,076 of 1,076 · part 2 of 3 · try 2 of 3", work: { from: 641, to: 1076, total: 1076, part: 2, parts: 3, attempt: 2, attempts: 3, reason: "Expected an object", startedAt } };
	socket!.send(JSON.stringify({ t: "snap", sid: sid!, value }));
	const progress = page.locator(".arc-progress");
	await progress.waitFor();
	assert.equal(await progress.getByRole("status").innerText(), "Building messages 641–1,076 · part 2 of 3 · try 2 of 3");
	assert.match(await progress.innerText(), / · 1:1\d$/);
	assert.equal(await progress.getByRole("status").getAttribute("title"), "Last answer rejected: Expected an object");
	assert.equal(await progress.evaluate((el) => getComputedStyle(el).fontStyle), "italic");
	assert.doesNotMatch(await page.locator(".arc-panel").innerText(), /Expected an object/, "the internal reason stays out of the text");
	value.status = { state: "queued", progress: "Waiting for a model slot" };
	value.receipt!.builds.at(-1)!.error = { code: "busy", message: "Model-call capacity is busy." };
	socket!.send(JSON.stringify({ t: "snap", sid: sid!, value }));
	await page.getByText("Waiting for a model slot", { exact: true }).waitFor();
	assert.equal(await page.getByRole("alert").count(), 0, "admission wait is not a red model failure");
	value.branchChanged = true; delete value.sourceCount;
	socket!.send(JSON.stringify({ t: "snap", sid: sid!, value }));
	await page.getByText(/branch or selection changed/).waitFor();
	assert.doesNotMatch(await page.locator(".arc-status").innerText(), /Covers 640 of/);
	value.branchChanged = false; value.sourceCount = 1076;
	value.status = { state: "idle" }; value.stale = 0;
	value.receipt!.builds.at(-1)!.state = "done"; delete value.receipt!.builds.at(-1)!.error;
	value.receipt!.asOfCount = 1076; value.receipt!.builtAt = "2026-10-21T21:02:00Z";
	socket!.send(JSON.stringify({ t: "snap", sid: sid!, value }));
	await page.getByText(/Updated 21:02/).waitFor();
	assert.equal(await page.getByRole("alert").count(), 0);
	assert.doesNotMatch(await page.locator(".arc-status").innerText(), /Covers 640/);
	assert.equal(await page.locator("[data-chapter]").count(), 15);
	value = arcPanelFixture(40);
	socket!.send(JSON.stringify({ t: "snap", sid: sid!, value }));
	await page.getByRole("heading", { name: "Chapters (40)", exact: true }).waitFor();
	for (const width of [380, 720]) {
		await page.setViewportSize({ width, height: 1100 }); await frames(page);
		await page.locator(".arc-timeline").scrollIntoViewIfNeeded();
		const labels = await page.evaluate(() => {
			const bounds = (selector: string) => [...document.querySelectorAll(selector)].filter(el => getComputedStyle(el).visibility !== "hidden").map(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; });
			return { numbers: bounds("[data-number]"), ticks: bounds(".arc-time-ticks > span"), bands: bounds("[data-band]") };
		});
		assert.equal(labels.bands.length, 40); assert.ok(labels.bands.every(b => b.width > 0));
		for (const group of [labels.numbers, labels.ticks]) for (let i = 1; i < group.length; i++) assert.ok(group[i]!.left >= group[i - 1]!.right, `${width}px: timeline labels do not overlap`);
		assert.ok(labels.numbers.length < 40, "narrow bands omit their number");
		for (let n = 1; n <= 40; n++) {
			const band = page.locator(`[data-band="${n}"]`);
			await band.hover();
			assert.match(await page.locator(".arc-timeline > .arc-hint").innerText(), new RegExp(`Chapter ${n} ·`));
			await band.click();
			assert.equal(await page.locator(`[data-chapter="${n}"] .arc-chapter-row`).getAttribute("aria-expanded"), "true");
		}
		assert.equal(await page.getByRole("button", { name: "Show its 0 key points", exact: true }).count(), 0, "empty chapters have no key-point control");
		assert.ok(await page.getByRole("button", { name: "Show its 4 key points", exact: true }).count() > 0, "chapters with points retain their control");
		await page.locator(".arc-timeline").scrollIntoViewIfNeeded();
		for (const theme of ["light", "dark"]) {
			await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme); await frames(page);
			if (proof) await page.screenshot({ path: join(proof, `arc-forty-${theme}-${width}.png`) });
		}
	}
	assert.deepEqual(errors, []);
});
