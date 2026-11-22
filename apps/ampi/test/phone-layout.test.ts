import "./bound.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AXIS_TIMES, AXIS_MATRIX, calibratedFontSkip, phone, go, overflow, settled, open } from "./phone-axis-fixture.ts";
import { engineSkip } from "./engines.ts";
import { demoSessions, ENGINES, phoneTimelineFixture } from "./resize-edges-fixture.ts";
import { shortTick } from "../web/src/views/cos/axis.ts";

// A phone's page layout on every page. No page is wider than the phone: a wider page takes every sideways drag as its
// own pan, and the drawer swipe stops there (docs/ux/swipe-drawers.md rule 7). The Timeline's axis labels once made its
// page 578 px wide at 390 px. A phone has one vertical scroller per page: the Timeline's lanes take their full height,
// so a tall header or a large display size cannot squeeze them to nothing, and the time axis stays on top.
// transcript-sideways.test.ts owns the wide-block rules; this file checks only that they hold beside the others.

// The page formats the labels and this process computes the expected ones, so both use one locale and time zone.
const LOCALE = "en-US";
const WIDTHS = [320, 375, 390];
const SESSION = "#/h/devbox/t/pi%3Asess-lead";
// Measured line ceilings for the pinned historical endpoint below: width, zoom, Chromium [en-US,de-DE], WebKit [en-US,de-DE].
const KNOWN_AXIS_LIMITS = [
	[320, 2, [4, 3], [3, 3]],
	[375, 1.5, [1, 1], [1, 1]],
	[375, 1.75, [2, 1], [2, 1]],
	[375, 1.8, [2, 1], [2, 1]],
	[375, 1.81, [3, 1], [2, 1]],
	[375, 1.875, [3, 2], [3, 1]],
	[375, 2, [3, 2], [3, 2]],
] as const;
const WEB_SRC = fileURLToPath(new URL("../web/src", import.meta.url));

test("the phone breakpoint has one TypeScript source and two matching CSS consumers", () => {
	const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
	});
	const sourceFiles = walk(WEB_SRC);
	const sourcePath = join(WEB_SRC, "phone-breakpoint.ts");
	const source = readFileSync(sourcePath, "utf8");
	const declaration = /export const PHONE_BREAKPOINT_PX = (\d+);/.exec(source);
	assert.ok(declaration, "phone-breakpoint.ts exports the breakpoint in CSS pixels");
	const width = Number(declaration[1]);
	const declarations = sourceFiles.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/PHONE_BREAKPOINT_PX\s*=\s*\d+/g)].map(() => relative(WEB_SRC, file)));
	assert.deepEqual(declarations, [relative(WEB_SRC, sourcePath)], "the shared breakpoint has one declaration");
	const app = readFileSync(join(WEB_SRC, "App.tsx"), "utf8");
	assert.match(app, /matchMedia\(`\(max-width: \$\{PHONE_BREAKPOINT_PX\}px\)`\)/, "App builds its query from the shared width");
	const cssConsumers: { file: string; width: number }[] = [];
	for (const file of sourceFiles.filter((path) => path.endsWith(".css"))) {
		const css = readFileSync(file, "utf8");
		for (const match of css.matchAll(/@media\s*\([^)]*max-width:\s*(\d+)px[^)]*\)/g)) {
			if (Number(match[1]) === width) cssConsumers.push({ file: relative(WEB_SRC, file), width: Number(match[1]) });
		}
	}
	assert.deepEqual(cssConsumers, [
		{ file: "styles.css", width },
		{ file: "views/cos/cos.css", width },
	], "only the drawer and phone Timeline rules consume the shared width");
	const literalQueries = sourceFiles.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/max-width\s*:\s*(\d+)px/g)]
		.filter((match) => Number(match[1]) === width).map(() => relative(WEB_SRC, file)));
	assert.deepEqual(literalQueries, ["styles.css", "views/cos/cos.css"], "the shared width has no extra literal consumers");
});
const PAGES: [string, string, string][] = [
	["Overview", "#/v/overview", '.main .topbar b:text-is("Overview")'],
	["Timeline", "#/v/timeline", ".cos-axis time"],
	["Session", SESSION, ".transcript [data-entry]"],
];
const WIDE = `<table><thead><tr>${"<th>column</th>".repeat(10)}</tr></thead><tbody><tr>${"<td>wordwordword</td>".repeat(10)}</tr></tbody></table>`
	+ `<pre><code>${"long_line_".repeat(30)}</code></pre>`;

test("a phone's short axis label names each tick exactly and in the coarsest unit that tells them apart", () => {
	const at = (s: string) => new Date(s).getTime();
	const time = (s: string) => new Date(s).toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit" });
	// One calendar day: the time only.
	assert.equal(shortTick(at("2026-10-31T14:00"), at("2026-10-31T08:00"), at("2026-10-31T20:00"), LOCALE), time("2026-10-31T14:00"));
	// Under six days: weekday and time, so two ticks on one day stay apart.
	assert.equal(shortTick(at("2026-10-29T14:00"), at("2026-10-27T14:00"), at("2026-10-31T14:00"), LOCALE), `Thu ${time("2026-10-29T14:00")}`);
	// Six days or more: month and day, because the first and last ticks could share a weekday.
	assert.equal(shortTick(at("2026-10-24T14:00"), at("2026-10-24T14:00"), at("2026-10-31T14:00"), LOCALE), "Oct 24");
	// 300 days or more: month and year.
	assert.equal(shortTick(at("2025-10-31T14:00"), at("2025-10-31T14:00"), at("2026-10-31T14:00"), LOCALE), "Oct 2025");
});

for (const [engine, type, path] of ENGINES) for (const width of WIDTHS) {
	test(`phone layout ${engine} ${width} px: no page is wider than the phone, with or without a drawer`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: SESSION, context: phone(width) });
		for (const [name, route, ready] of PAGES) {
			await go(page, route, ready);
			assert.deepEqual(await overflow(page), { page: 0, main: 0 }, `${name}: no drawer`);
			if (width === 320 && name === "Session") {
				const actions = await page.locator(".composer-actions button").evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().top));
				assert.equal(new Set(actions).size, 1, "Queue, Steer and Stop share one row at 320 px");
			}
			// A page's name in its header shows whole.
			const title = await page.evaluate(() => { const h1 = document.querySelector<HTMLElement>(".cos-header h1"); return h1 && { text: h1.textContent, cut: h1.scrollWidth > h1.clientWidth }; });
			if (title) assert.deepEqual(title, { text: name, cut: false }, `${name}: the page name shows whole`);
			await page.getByRole("button", { name: "Show sidebar" }).click();
			await page.waitForFunction(() => !document.querySelector(".app")!.classList.contains("sidebar-hidden"));
			await settled(page);
			assert.deepEqual(await overflow(page), { page: 0, main: 0 }, `${name}: sidebar open`);
			await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
			await page.waitForFunction(() => document.querySelector(".app")!.classList.contains("sidebar-hidden"));
		}
		if (width !== 320) {
			// A long code line and a wide table scroll inside their own blocks, and the page still fits.
			await page.evaluate((html) => document.querySelector(".transcript .msg.assistant > .md")!.insertAdjacentHTML("beforeend", html), WIDE);
			await settled(page);
			const blocks = await page.evaluate(() => ["table", "pre"].map((selector) => {
				const reply = document.querySelector(".transcript .msg.assistant > .md")!;
				const block = [...reply.querySelectorAll<HTMLElement>(`:scope > ${selector}`)].at(-1)!;
				return block.scrollWidth > block.clientWidth && /auto|scroll/.test(getComputedStyle(block).overflowX);
			}));
			assert.deepEqual(blocks, [true, true], "the table and the code line scroll inside their blocks");
			assert.deepEqual(await overflow(page), { page: 0, main: 0 }, "Session: wide blocks");
			await page.keyboard.press("Meta+KeyL");
			await page.waitForFunction(() => document.querySelector(".app")!.classList.contains("has-panel"));
			await settled(page);
			assert.deepEqual(await overflow(page), { page: 0, main: 0 }, "Session: panel open");
		}
	});


	test(`phone layout ${engine} ${width} px: the Timeline axis contains synthetic long labels without clipping`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: SESSION, context: phone(width), beforeNavigate: (page) => page.clock.setFixedTime(new Date(AXIS_TIMES[1])) });
		await go(page, "#/v/timeline", ".cos-axis time");
		const texts = ["Wednesday 11:00 AM", "LongLocalizedWeekdayWithoutSpaces 12:00 PM", "Now"];
		await page.locator(".cos-axis time").evaluateAll((ticks, texts) => {
			for (const [i, tick] of [ticks[0], ticks[2], ticks[4]].entries()) tick.querySelector(".cos-tick-short")!.textContent = texts[i];
		}, texts);
		await settled(page);
		const geometry = await page.evaluate(() => {
			const box = document.querySelector(".cos-axis > div")!.getBoundingClientRect();
			return [...document.querySelectorAll<HTMLElement>(".cos-tick-short")].filter((span) => span.offsetParent).map((span) => {
				const rect = span.getBoundingClientRect();
				return { text: span.textContent, inside: rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5,
					cut: span.scrollWidth > Math.ceil(rect.width) || span.scrollHeight > Math.ceil(rect.height) };
			});
		});
		assert.deepEqual(geometry, texts.map((text) => ({ text, inside: true, cut: false })), "every whole label stays inside its axis");
	});

	test(`phone layout ${engine} ${width} px: the Timeline lanes take their full height at every display size, under a sticky axis`, { skip: engineSkip(engine) }, async (t) => {
		const fixedNow = Date.parse(AXIS_TIMES[1]);
		const expectedRows = await phoneTimelineFixture(fixedNow);
		let stuck = 0;
		for (const overall of [1, 1.25, 1.5, 2]) {
			const page = await open(t, engine, type, path(), { route: "#/v/overview", fixture: "empty", display: { overall }, context: phone(width), beforeNavigate: (page) => page.clock.setFixedTime(new Date(fixedNow)) });
			await go(page, "#/v/timeline", ".cos-stream-row");
			await page.waitForFunction((expected) => {
				const loading = [...document.querySelectorAll(".cos-notice, .cos-empty")].some((node) => node.textContent?.includes("Reading the Sessions…"));
				const rows = [...document.querySelectorAll<HTMLElement>(".cos-stream-row")].map((row) => row.dataset.lane);
				return !loading && rows.length === expected.length && expected.every((id) => rows.includes(id));
			}, expectedRows);
			const renderedRows = await page.locator(".cos-stream-row").evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.lane));
			assert.deepEqual([...renderedRows].sort(), [...expectedRows].sort(), "rendered Timeline row IDs match the ready fixture before scrolling");
			const view = await page.evaluate(async () => {
				const main = document.querySelector<HTMLElement>("main.cos-page")!;
				const lanes = document.querySelector<HTMLElement>(".cos-scroll")!;
				const axis = () => document.querySelector(".cos-axis")!.getBoundingClientRect();
				const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
				// Scroll the axis to the top, where it sticks: the lanes fill the screen below it. The rects scale with the
				// display zoom and scrollTop does not, so the shift converts by the page's own ratio.
				const zoom = main.getBoundingClientRect().height / main.clientHeight;
				const place = (axis().top - main.getBoundingClientRect().top) / zoom;
				main.scrollTop += place;
				await frame();
				const screen = main.getBoundingClientRect();
				const rows = [...document.querySelectorAll<HTMLElement>(".cos-stream-row")];
				const rowIds = rows.map((row) => row.dataset.lane!);
				const rowsInView = rows.map((row) => row.getBoundingClientRect()).filter((r) => r.top >= axis().bottom - 1 && r.bottom <= screen.bottom + 0.5).length;
				// Scroll the page two screens down, or to its end: the axis labels stay in view.
				main.scrollTop += 2 * main.clientHeight;
				await frame();
				const labels = [...document.querySelectorAll<HTMLElement>(".cos-axis time")].filter((time) => time.offsetParent).map((time) => time.getBoundingClientRect());
				// No axis text sits under ☰, which shows at the screen top at every drawer state.
				const reveal = document.querySelector(".sidebar-reveal")!.getBoundingClientRect();
				const walker = document.createTreeWalker(document.querySelector(".cos-axis")!, NodeFilter.SHOW_TEXT);
				const underReveal: string[] = [];
				for (let node = walker.nextNode(); node; node = walker.nextNode()) {
					const range = document.createRange();
					range.selectNodeContents(node);
					for (const r of range.getClientRects()) {
						if (r.width && r.left < reveal.right && r.right > reveal.left && r.top < reveal.bottom && r.bottom > reveal.top) underReveal.push(node.textContent!);
					}
				}
				const timeArea = document.querySelector(".cos-axis > div")!.getBoundingClientRect();
				const fragments = [...document.querySelectorAll(".cos-tick-short")].flatMap((span) => {
					const range = document.createRange(); range.selectNodeContents(span);
					return [...range.getClientRects()].filter((rect) => rect.width);
				});
				const fragmentsInside = fragments.every((rect) => rect.left >= timeArea.left - 0.5 && rect.right <= timeArea.right + 0.5);
				const tickStart = timeArea.left;
				const laneStart = document.querySelector(".cos-stream-row > :nth-child(2)")!.getBoundingClientRect().left;
				return {
					ownScroll: lanes.scrollHeight - lanes.clientHeight,
					scrolled: main.scrollTop > 0,
					// The page scrolled past the axis's own place, so only the sticky rule keeps it in view.
					stuck: main.scrollTop > place + 1,
					labelsInView: labels.length > 0 && labels.every((r) => r.top >= screen.top - 0.5 && r.bottom <= screen.bottom + 0.5),
					rows: rowIds,
					rowsInView,
					underReveal,
					fragmentsInside,
					axisHeight: axis().height,
					lanesHeight: lanes.getBoundingClientRect().height,
					tickShift: tickStart - laneStart,
				};
			});
			const label = `overall ${overall}`;
			assert.deepEqual(view.rows, renderedRows, `${label}: row IDs stay fixed through the scroll check`);
			assert.ok(view.ownScroll <= 1, `${label}: the lanes have no own vertical scroller`);
			assert.ok(view.scrolled, `${label}: the page scrolls`);
			assert.ok(view.labelsInView, `${label}: the axis labels stay in view`);
			assert.ok(view.fragmentsInside, `${label}: the sticky text fragments stay inside the time area`);
			t.diagnostic(JSON.stringify({ overall, width, axisHeight: view.axisHeight, lanesHeight: view.lanesHeight, rowsInView: view.rowsInView }));
			assert.ok(view.rowsInView >= Math.min(5, Math.ceil(5 / overall), view.rows.length), `${label}: ${view.rowsInView} of ${view.rows.length} lanes show below the axis`);
			assert.deepEqual(view.underReveal, [], `${label}: no axis text sits under ☰`);
			assert.ok(Math.abs(view.tickShift) <= 1, `${label}: the ticks start over the lanes' time column (${view.tickShift} px)`);
			if (view.stuck) stuck++;
		}
		assert.ok(stuck > 0, "one display size or more scrolls the page past the axis's own place");
	});
}

// phone-axis.test.ts owns the axis label matrix at every phone width; its own hub keeps this file inside the file bound.

for (const [engine, type, path] of ENGINES) {
	test(`phone layout ${engine}: CSS keeps tick membership at page and panel breakpoints`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: SESSION, context: { viewport: { width: 1280, height: 900 }, locale: LOCALE, timezoneId: "Asia/Singapore" }, beforeNavigate: (page) => page.clock.setFixedTime(new Date(AXIS_TIMES[1])) });
		await go(page, "#/v/timeline", ".cos-axis time");
		for (const width of [1280, 1100, 601, 600, 375, 320]) {
			await page.setViewportSize({ width, height: 900 }); await settled(page);
			const shown = await page.locator(".cos-axis time").evaluateAll((ticks) => ticks.map((tick, index) => ({ index, visible: Boolean((tick as HTMLElement).offsetParent) })).filter((tick) => tick.visible).map((tick) => tick.index));
			assert.deepEqual(shown, width > 1100 ? [0, 1, 2, 3, 4] : [0, 2, 4], `${width}px: CSS owns page membership`);
		}
		for (const width of [440, 320]) {
			const panel = await open(t, engine, type, path(), { route: `${SESSION}?p=timeline`, context: { viewport: { width: 1280, height: 900 }, locale: LOCALE, timezoneId: "Asia/Singapore" }, beforeNavigate: async (page) => {
				await page.clock.setFixedTime(new Date(AXIS_TIMES[1]));
				await page.addInitScript((width) => localStorage.setItem("ampi.panel.width", String(width)), width);
			} });
			await panel.locator(".cos-panel .cos-axis time").first().waitFor({ state: "attached" }); await settled(panel);
			const shown = await panel.locator(".cos-panel .cos-axis time").evaluateAll((ticks) => ticks.map((tick, index) => ({ index, visible: Boolean((tick as HTMLElement).offsetParent) })).filter((tick) => tick.visible).map((tick) => tick.index));
			assert.deepEqual(shown, width > 380 ? [0, 4] : [4], `${width}px panel: CSS owns panel membership`);
		}
	});

	for (const locale of [LOCALE, "de-DE"]) test(`phone layout ${engine}: the axis threshold covers every formatter family in ${locale}`, { skip: calibratedFontSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: SESSION, context: { ...phone(320), locale }, beforeNavigate: (page) => page.clock.setFixedTime(new Date(AXIS_TIMES[1])) });
		await go(page, "#/v/timeline", ".cos-axis time");
		const labels: { family: string; text: string }[] = [];
		// Sample the same local wall times in every runner zone.
		const at = (text: string) => Date.parse(text.replace(/\+08:00$/, ""));
		for (const now of AXIS_MATRIX) {
			const to = at(now);
			labels.push({ family: "time", text: shortTick(to, to - 3600_000, to, locale) });
			labels.push({ family: "weekday/time", text: shortTick(to, to - 4 * 86_400_000, to, locale) });
		}
		for (let month = 1; month <= 12; month++) for (const day of [1, 15, 28]) {
			const value = at(`2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T11:00:00+08:00`);
			labels.push({ family: "month/day", text: shortTick(value, value - 30 * 86_400_000, value, locale) });
			labels.push({ family: "month/year", text: shortTick(value, value - 400 * 86_400_000, value, locale) });
		}
		const measured = await page.evaluate((labels) => {
			const parent = document.querySelector(".cos-axis time")!;
			const axis = document.querySelector<HTMLElement>(".cos-axis")!;
			const scale = axis.getBoundingClientRect().width / axis.offsetWidth;
			return labels.map(({ family, text }) => {
				const probe = document.createElement("span");
				probe.style.cssText = "position:absolute;visibility:hidden;display:block;width:4.7em;white-space:normal;overflow-wrap:break-word";
				probe.textContent = text; parent.append(probe);
				const range = document.createRange(); range.selectNodeContents(probe);
				const rects = [...range.getClientRects()].filter((rect) => rect.width);
				const brokenTokens = [...text.matchAll(/\S+/gu)].filter((match) => {
					const token = document.createRange(); token.setStart(probe.firstChild!, match.index!); token.setEnd(probe.firstChild!, match.index! + match[0].length);
					return new Set([...token.getClientRects()].filter((rect) => rect.width).map((rect) => Math.round(rect.top))).size > 1;
				}).map((match) => match[0]);
				const result = { family, text, brokenTokens, lines: new Set(rects.map((rect) => Math.round(rect.top))).size,
					needEm: Math.max(...rects.map((rect) => rect.width / scale / parseFloat(getComputedStyle(probe).fontSize))),
					cut: probe.scrollWidth > probe.clientWidth + 1 };
				probe.remove(); return result;
			});
		}, labels);
		for (const label of measured) {
			assert.ok(label.lines <= 2, `${label.family}: ${label.text} fits two greedy browser lines`);
			assert.deepEqual(label.brokenTokens, [], `${label.family}: no supported token exceeds one track`);
			assert.ok(label.needEm <= 4.7 + 1e-6 && !label.cut, `${label.family}: ${label.text} fits the measured threshold`);
		}
		t.diagnostic(JSON.stringify({ locale, maxGreedyLineEm: Math.max(...measured.map((label) => label.needEm)), families: [...new Set(labels.map((label) => label.family))] }));
		for (const [delta, expected] of [[-0.01, 1], [0.01, 3]]) {
			await page.locator(".cos-axis > div").evaluate((node, width) => { (node as HTMLElement).style.width = `${width}em`; }, 15.4334 + delta);
			await settled(page);
			const state = await page.evaluate(() => {
				const area = document.querySelector(".cos-axis > div")!.getBoundingClientRect();
				const ticks = [...document.querySelectorAll<HTMLElement>(".cos-axis time")].filter((tick) => tick.offsetParent);
				const last = document.createRange(); last.selectNodeContents(ticks.at(-1)!.querySelector(".cos-tick-short")!);
				return { count: ticks.length, inside: [...last.getClientRects()].every((rect) => rect.left >= area.left - 0.5 && rect.right <= area.right + 0.5) };
			});
			assert.deepEqual(state, { count: expected, inside: true }, `threshold ${delta < 0 ? "below" : "above"}: CSS alone selects the visible ticks`);
		}
	});

	for (const width of [320, 375]) for (const locale of [LOCALE, "de-DE"]) test(`phone layout ${engine}: KNOWN LIMIT P2 historical endpoint at ${width} px ${locale}`, { skip: calibratedFontSkip(engine) }, async (t) => {
		const now = Date.parse(AXIS_TIMES[1]), to = now - 86_400_000;
		const rows = await phoneTimelineFixture(now - 2 * 86_400_000, "-historical");
		const page = await open(t, engine, type, path(), { route: "#/v/overview", fixture: "empty", context: { ...phone(width), locale }, beforeNavigate: (page) => page.clock.setFixedTime(new Date(now)) });
		// Reuse the locale/width context. A fresh document applies each zoom without spending another WebKit context.
		for (const [, overall, chromiumLines, webkitLines] of KNOWN_AXIS_LIMITS.filter((limit) => limit[0] === width)) await t.test(`zoom ${overall}`, async (t) => {
			await page.evaluate((overall) => localStorage.setItem("ampi.display", JSON.stringify({ overall })), overall);
			await page.reload();
			await go(page, `#/v/timeline?from=${now - 4 * 86_400_000}&to=${to + 3600_000}`, ".cos-stream-row");
			await page.waitForFunction((expected) => document.querySelectorAll(".cos-stream-row").length === expected, rows.length);
			// Use the actual brush control. Its persisted range must not turn a historical endpoint into Now.
			await page.getByRole("slider", { name: "Range end", exact: true }).press("Shift+ArrowLeft");
			await page.waitForFunction((to) => new URLSearchParams(location.hash.split("?")[1]).get("to") === String(to), to);
			const measure = () => page.evaluate(async () => {
				const main = document.querySelector<HTMLElement>("main.cos-page")!;
				const node = document.querySelector<HTMLElement>(".cos-axis")!;
				const scale = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
				main.scrollTop = 0;
				await new Promise((resolve) => requestAnimationFrame(resolve));
				main.scrollTop += (node.getBoundingClientRect().top - main.getBoundingClientRect().top) / scale;
				await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
				const axis = node.getBoundingClientRect(), area = node.lastElementChild!.getBoundingClientRect(), screen = main.getBoundingClientRect();
				const ticks = [...node.querySelectorAll<HTMLTimeElement>("time")].filter((tick) => tick.offsetParent);
				const last = ticks.at(-1)!, label = last.querySelector(".cos-tick-short")!;
				const range = document.createRange(); range.selectNodeContents(label);
				const fragments = [...range.getClientRects()].filter((rect) => rect.width).map((rect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }));
				const reveal = document.querySelector(".sidebar-reveal")!.getBoundingClientRect();
				const visibleRows = [...document.querySelectorAll(".cos-stream-row")].map((row) => row.getBoundingClientRect()).filter((rect) => rect.top >= axis.bottom - 1 && rect.bottom <= screen.bottom + 0.5).length;
				return { count: ticks.length, height: axis.height, areaWidth: area.width, areaLeft: area.left, areaRight: area.right, fragments,
					lines: new Set(fragments.map((rect) => Math.round(rect.top))).size, text: label.textContent, at: last.dateTime,
					visibleRows, tickShift: area.left - document.querySelector(".cos-stream-row > :nth-child(2)")!.getBoundingClientRect().left,
					drawerOverlap: fragments.some((rect) => rect.left < reveal.right && rect.right > reveal.left && rect.top < reveal.bottom && rect.bottom > reveal.top) };
		});
		const baseline = await page.addStyleTag({ content: ".cos-axis > div { display:flex!important;container-type:normal!important;gap:8px!important } .cos-axis time { min-width:auto!important;white-space:nowrap!important;overflow-wrap:normal!important } .cos-axis time:nth-child(1), .cos-axis time:nth-child(3) { display:block!important }" });
		const old = await measure();
		await baseline.evaluate((node) => node.parentNode!.removeChild(node));
		await settled(page);
		const current = await measure();
		t.diagnostic(JSON.stringify({ knownLimit: "P2: fixed name column constrains historical endpoint", width, overall, locale, old, current }));
		assert.equal(old.count, 3, "the baseline reproduces main's three visible ticks");
		assert.equal(Date.parse(current.at), to, "the brush keeps its historical endpoint");
		assert.notEqual(current.text, "Now", "the fallback never synthesizes Now for history");
		for (const rect of current.fragments) assert.ok(rect.left >= current.areaLeft - 0.5 && rect.right <= current.areaRight + 0.5, "every historical text fragment fits");
		const lines = (engine === "chromium" ? chromiumLines : webkitLines)[locale === LOCALE ? 0 : 1];
		const measuredCeiling = (16 + 24 * lines) * overall;
		assert.ok(current.height <= measuredCeiling + 0.5, `P2 no-worsening ceiling: ${current.height}px <= measured ${measuredCeiling}px`);
		assert.ok(current.visibleRows >= Math.ceil(5 / overall), "the known limit preserves the accepted scaled lane budget");
		assert.ok(Math.abs(current.tickShift) <= 1, "the axis and lane origin stay aligned");
		assert.equal(current.drawerOverlap, false, "the historical endpoint clears the drawer reserve");
		});
	});

	test(`phone layout ${engine}: the right panel drawer covers the Session header and the sticky prompt header`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: SESSION, context: phone(390) });
		// The sticky prompt header shows once the reader scrolls past a prompt, which this fixture's place never does. Only
		// its layer matters here, so the test shows it in place.
		await page.locator(".prompt-head").evaluate((head: HTMLElement) => { head.style.visibility = "visible"; });
		const above = () => page.evaluate(() => {
			const drawer = document.querySelector(".panel-slot")!.getBoundingClientRect();
			return [".main .topbar", ".prompt-head"].map((selector) => {
				const r = document.querySelector(selector)!.getBoundingClientRect();
				const x = Math.max(r.left, drawer.left) + 20, y = (r.top + r.bottom) / 2;
				return `${selector}: ${Boolean(document.elementFromPoint(x, y)?.closest(".panel-slot"))}`;
			});
		});
		await page.keyboard.press("Meta+KeyL");
		await page.waitForFunction(() => document.querySelector(".app")!.classList.contains("has-panel"));
		await settled(page);
		assert.deepEqual(await above(), [".main .topbar: true", ".prompt-head: true"], "the panel drawer is the top layer");
		// The panel covers ☰, so its own header keeps a close control a finger can hit.
		const close = page.locator('.panel-slot .panel-tabs button[title="Close panel"]');
		const box = (await close.boundingBox())!;
		assert.ok(box.width >= 40 && box.height >= 40, `the close control is ${box.width}×${box.height} px`);
		assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0, "the close control is on the screen");
		assert.equal(await close.evaluate((button) => { const r = button.getBoundingClientRect(); return document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2)?.closest("button") === button; }), true, "nothing covers the close control");
		await close.tap();
		await page.waitForFunction(() => !document.querySelector(".app")!.classList.contains("has-panel"));
	});
}

// Last in the file: the seeded Sessions stay on the hub. The Timeline renders a 28-lane window from the lanes' offset.
// On a phone the page scrolls, so the window must follow the page past lane 28.
let seeded = false;
for (const [engine, type, path] of ENGINES) {
	test(`phone layout ${engine}: past lane 28 the page scroll shows the right lanes under the axis`, { skip: engineSkip(engine) }, async (t) => {
		if (!seeded) {
			seeded = true;
			const dir = demoSessions();
			const lead = readdirSync(dir, { recursive: true }).map((f) => join(dir, String(f))).find((f) => f.endsWith("/lead.jsonl"))!;
			const [head, ...rest] = readFileSync(lead, "utf8").trim().split("\n");
			for (let i = 0; i < 32; i++) writeFileSync(join(dirname(lead), `seed-${i}.jsonl`), [JSON.stringify({ ...JSON.parse(head), id: `seed-${i}` }), ...rest].join("\n") + "\n");
		}
		const page = await open(t, engine, type, path(), { route: SESSION, context: phone(390) });
		await go(page, "#/v/timeline", ".cos-stream-row");
		await page.waitForFunction(() => document.querySelector<HTMLElement>(".cos-scroll > div[style]")!.offsetHeight >= 40 * 56, undefined, { timeout: 30_000 });
		// Put lane 26 under the stuck axis; the screen then shows lanes past the first window's 28.
		const at = await page.evaluate(() => {
			const main = document.querySelector<HTMLElement>("main.cos-page")!;
			main.scrollTop += document.querySelector(".cos-axis")!.getBoundingClientRect().top - main.getBoundingClientRect().top + 26 * 56;
			return main.scrollTop;
		});
		// The scroll event sets the window's offset and React commits it in a later task, which a loaded runner delays
		// past any fixed number of frames. The test waits for that render: the window no longer starts at lane 0.
		await page.waitForFunction(() => {
			const top = document.querySelector(".cos-scroll > div[style]")!.getBoundingClientRect().top;
			const row = document.querySelector(".cos-stream-row");
			return row !== null && Math.round((row.getBoundingClientRect().top - top) / 56) > 0;
		});
		const view = await page.evaluate((at) => {
			const main = document.querySelector<HTMLElement>("main.cos-page")!;
			const lanes = document.querySelector<HTMLElement>(".cos-scroll > div[style]")!;
			const axis = document.querySelector(".cos-axis")!.getBoundingClientRect(), screen = main.getBoundingClientRect();
			const top = lanes.getBoundingClientRect().top;
			const lanesInView = [...document.querySelectorAll(".cos-stream-row")].map((row) => row.getBoundingClientRect())
				.filter((r) => r.bottom > axis.bottom && r.top < screen.bottom).map((r) => Math.round((r.top - top) / 56)).sort((a, b) => a - b);
			return { held: main.scrollTop === at, lanesInView, want: Math.min(Math.ceil((screen.bottom - axis.bottom) / 56), Math.round(lanes.offsetHeight / 56) - 26) };
		}, at);
		assert.ok(view.held, "the re-render keeps the page's scroll place");
		assert.equal(view.lanesInView[0], 26, "the lane under the axis is lane 26");
		// Every lane between the axis and the screen bottom renders: no blank band.
		assert.deepEqual(view.lanesInView, Array.from({ length: view.lanesInView.length }, (_, i) => 26 + i), "the lanes in view are consecutive");
		assert.ok(view.lanesInView.length >= view.want, `${view.lanesInView.length} of ${view.want} lanes fill the screen`);
	});
}
