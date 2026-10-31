import "./bound.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Page } from "playwright";
import { engineSkip } from "./engines.ts";
import { demoSessions, ENGINES, open } from "./resize-edges-fixture.ts";
import { shortTick } from "../web/src/views/cos/axis.ts";

// A phone's page layout on every page. No page is wider than the phone: a wider page takes every sideways drag as its
// own pan, and the drawer swipe stops there (docs/ux/swipe-drawers.md rule 7). The Timeline's axis labels once made its
// page 578 px wide at 390 px. A phone has one vertical scroller per page: the Timeline's lanes take their full height,
// so a tall header or a large display size cannot squeeze them to nothing, and the time axis stays on top.
// transcript-sideways.test.ts owns the wide-block rules; this file checks only that they hold beside the others.

// The page formats the labels and this process computes the expected ones, so both use one locale and time zone.
const LOCALE = "en-US";
const phone = (width: number) => ({ viewport: { width, height: width === 375 ? 667 : 844 }, hasTouch: true, isMobile: true, locale: LOCALE, timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone });
const WIDTHS = [375, 390];
const SESSION = "#/h/devbox/t/pi%3Asess-lead";
const PAGES: [string, string, string][] = [
	["Overview", "#/v/overview", '.main .topbar b:text-is("Overview")'],
	["Timeline", "#/v/timeline", ".cos-axis time"],
	["Arcs", "#/v/arcs", "main.cos-page"],
	["Session", SESSION, ".transcript [data-entry]"],
];
const WIDE = `<table><thead><tr>${"<th>column</th>".repeat(10)}</tr></thead><tbody><tr>${"<td>wordwordword</td>".repeat(10)}</tr></tbody></table>`
	+ `<pre><code>${"long_line_".repeat(30)}</code></pre>`;

/** The page's and the main view's sideways overflow, in px. */
function overflow(page: Page) {
	return page.evaluate(() => {
		const doc = document.scrollingElement!;
		const main = document.querySelector<HTMLElement>("[data-page-root] .main")!;
		return { page: doc.scrollWidth - doc.clientWidth, main: main.scrollWidth - main.clientWidth };
	});
}

async function settled(page: Page) {
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function go(page: Page, route: string, ready: string) {
	await page.evaluate((route) => { location.hash = route; }, route);
	await page.locator(ready).first().waitFor({ state: "attached" });
	await settled(page);
}

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
	});

	test(`phone layout ${engine} ${width} px: the Timeline axis shows three whole labels inside the axis`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: SESSION, context: phone(width) });
		await go(page, "#/v/timeline", ".cos-axis time");
		const axis = await page.evaluate(() => {
			const box = document.querySelector(".cos-axis > div")!.getBoundingClientRect();
			const shown = [...document.querySelectorAll<HTMLTimeElement>(".cos-axis time")].filter((time) => time.offsetParent);
			return {
				box: { left: box.left, right: box.right },
				labels: shown.map((time) => {
					const label = [...time.children].find((span) => getComputedStyle(span).display !== "none") as HTMLElement;
					const rect = label.getBoundingClientRect();
					return { at: Date.parse(time.dateTime), text: label.textContent!, left: rect.left, right: rect.right, cut: label.scrollWidth > Math.ceil(rect.width) };
				}),
				range: [...document.querySelectorAll<HTMLTimeElement>(".cos-axis time")].map((time) => Date.parse(time.dateTime)),
				now: Date.now(),
			};
		});
		assert.equal(axis.labels.length, 3, "first, middle and last ticks");
		// The default range ends now: the live "Now" tick is the right label, and it must clear the middle one.
		assert.equal(axis.labels[2].text, "Now", "the default range's last tick is live");
		const [from, to] = [axis.range[0], axis.range[4]];
		for (const [i, label] of axis.labels.entries()) {
			const live = i === 2 && Math.abs(to - axis.now) < 120_000;
			assert.equal(label.text, live ? "Now" : shortTick(label.at, from, to, LOCALE), "the whole formatted value");
			assert.equal(label.cut, false, `${label.text} is not cut`);
			assert.ok(label.left >= axis.box.left - 0.5 && label.right <= axis.box.right + 0.5, `${label.text} sits inside the axis`);
			if (i) assert.ok(label.left >= axis.labels[i - 1].right, `${label.text} does not overlap the label before it`);
		}
	});

	test(`phone layout ${engine} ${width} px: the Timeline lanes take their full height at every display size, under a sticky axis`, { skip: engineSkip(engine) }, async (t) => {
		let stuck = 0;
		for (const overall of [1, 1.25, 1.5]) {
			const page = await open(t, engine, type, path(), { route: SESSION, display: { overall }, context: phone(width) });
			await go(page, "#/v/timeline", ".cos-stream-row");
			await page.waitForFunction(() => document.querySelectorAll(".cos-stream-row").length >= 5);
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
				const rows = [...document.querySelectorAll(".cos-stream-row")].map((row) => row.getBoundingClientRect());
				const rowsInView = rows.filter((r) => r.top >= axis().bottom - 1 && r.bottom <= screen.bottom + 0.5).length;
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
				const tickStart = document.querySelector(".cos-axis > div")!.getBoundingClientRect().left;
				const laneStart = document.querySelector(".cos-stream-row > :nth-child(2)")!.getBoundingClientRect().left;
				return {
					ownScroll: lanes.scrollHeight - lanes.clientHeight,
					scrolled: main.scrollTop > 0,
					// The page scrolled past the axis's own place, so only the sticky rule keeps it in view.
					stuck: main.scrollTop > place + 1,
					labelsInView: labels.length > 0 && labels.every((r) => r.top >= screen.top - 0.5 && r.bottom <= screen.bottom + 0.5),
					rows: rows.length,
					rowsInView,
					underReveal,
					tickShift: tickStart - laneStart,
				};
			});
			const label = `overall ${overall}`;
			assert.ok(view.ownScroll <= 1, `${label}: the lanes have no own vertical scroller`);
			assert.ok(view.scrolled, `${label}: the page scrolls`);
			assert.ok(view.labelsInView, `${label}: the axis labels stay in view`);
			assert.ok(view.rowsInView >= Math.min(5, view.rows), `${label}: ${view.rowsInView} of ${view.rows} lanes show below the axis`);
			assert.deepEqual(view.underReveal, [], `${label}: no axis text sits under ☰`);
			assert.ok(Math.abs(view.tickShift) <= 1, `${label}: the ticks start over the lanes' time column (${view.tickShift} px)`);
			if (view.stuck) stuck++;
		}
		assert.ok(stuck > 0, "one display size or more scrolls the page past the axis's own place");
	});
}

for (const [engine, type, path] of ENGINES) {
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
		const view = await page.evaluate(async () => {
			const main = document.querySelector<HTMLElement>("main.cos-page")!;
			const lanes = document.querySelector<HTMLElement>(".cos-scroll > div[style]")!;
			const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			// Put lane 26 under the stuck axis; the screen then shows lanes past the first window's 28.
			main.scrollTop += document.querySelector(".cos-axis")!.getBoundingClientRect().top - main.getBoundingClientRect().top + 26 * 56;
			const at = main.scrollTop;
			await frame();
			const axis = document.querySelector(".cos-axis")!.getBoundingClientRect(), screen = main.getBoundingClientRect();
			const top = lanes.getBoundingClientRect().top;
			const lanesInView = [...document.querySelectorAll(".cos-stream-row")].map((row) => row.getBoundingClientRect())
				.filter((r) => r.bottom > axis.bottom && r.top < screen.bottom).map((r) => Math.round((r.top - top) / 56)).sort((a, b) => a - b);
			return { held: main.scrollTop === at, lanesInView, want: Math.min(Math.ceil((screen.bottom - axis.bottom) / 56), Math.round(lanes.offsetHeight / 56) - 26) };
		});
		assert.ok(view.held, "the re-render keeps the page's scroll place");
		assert.equal(view.lanesInView[0], 26, "the lane under the axis is lane 26");
		// Every lane between the axis and the screen bottom renders: no blank band.
		assert.deepEqual(view.lanesInView, Array.from({ length: view.lanesInView.length }, (_, i) => 26 + i), "the lanes in view are consecutive");
		assert.ok(view.lanesInView.length >= view.want, `${view.lanesInView.length} of ${view.want} lanes fill the screen`);
	});
}
