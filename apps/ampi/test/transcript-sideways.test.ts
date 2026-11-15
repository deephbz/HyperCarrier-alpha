import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { engineSkip } from "./engines.ts";
import { ENGINES, open } from "./resize-edges-fixture.ts";

// The owner's phone incident: a sideways drag on the transcript moved it off the screen edge, showed a white margin, and
// sprang back. The transcript scroller (.scroll) is vertical only (styles.css). Wide content scrolls inside its own
// block, and nothing in the transcript ends past the scroller: a wide table's width rule sizes it against the pane less
// the prompt rail (--rail-w). The real App and stylesheet on the demo hub: a phone with and without the rail (a Session
// under the rail's 8 prompts), and a desktop size. The content covers each kind of wide Markdown; Markdown renders no
// images (Markdown.tsx), and a user's images keep a max-width.

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const WIDE = `<table><thead><tr>${"<th>column</th>".repeat(10)}</tr></thead><tbody><tr>${"<td>wordwordword</td>".repeat(10)}</tr></tbody></table>`
	+ `<pre><code>${"long_line_".repeat(30)}</code></pre><p><code>${"x".repeat(120)}</code> https://example.com/${"a".repeat(160)}</p>`;

/** Adds wide Markdown to the first assistant reply, as the Markdown renderer would emit it. */
async function wideReply(page: Page) {
	await page.evaluate((html) => document.querySelector(".transcript .msg.assistant > .md")!.insertAdjacentHTML("beforeend", html), WIDE);
}

/** The transcript scroller's sideways overflow, and every rendered element that ends outside it. */
function sideways(page: Page) {
	return page.evaluate(() => {
		const scroll = document.querySelector<HTMLElement>(".transcript-frame > .scroll")!;
		const box = scroll.getBoundingClientRect();
		const out = [...scroll.querySelectorAll<HTMLElement>("*")]
			// A scrolling block's own content may extend past it; the block itself must fit.
			.filter((el) => !el.parentElement?.closest(".scroll pre, .scroll .md table") && el.getClientRects().length > 0)
			.map((el) => ({ el, r: el.getBoundingClientRect() }))
			.filter(({ r }) => r.width > 0 && (r.right > box.right + 0.5 || r.left < box.left - 0.5))
			.map(({ el, r }) => `${el.tagName.toLowerCase()}.${el.className} [${r.left.toFixed(1)}, ${r.right.toFixed(1)}]`);
		return { overflowX: getComputedStyle(scroll).overflowX, extra: scroll.scrollWidth - scroll.clientWidth, scroll: [box.left, box.right], out };
	});
}

for (const [engine, type, path] of ENGINES) {
	test(`phone layout ${engine}: follows the narrow rule without a resize event`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { context: { viewport: { width: 980, height: 844 }, hasTouch: true, isMobile: true }, suppressResize: true, waitForPhoneLayout: false });
		await page.setViewportSize({ width: 390, height: 844 });
		await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--side-overlay").trim() === "1");
		assert.equal(await page.locator(".app").evaluate((el) => el.classList.contains("side-overlay")), true, "App follows the CSS drawer rule without a resize event");
	});

	test(`phone breakpoint ${engine}: CSS and App agree at edges and display zoom`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { display: { overall: 1.25 }, context: { viewport: { width: 980, height: 844 }, hasTouch: true, isMobile: true }, suppressResize: true, waitForPhoneLayout: false });
		for (const width of [599, 600, 601]) {
			await page.setViewportSize({ width, height: 844 });
			await page.waitForFunction(() => {
				const css = getComputedStyle(document.documentElement).getPropertyValue("--side-overlay").trim() === "1";
				const app = document.querySelector(".app");
				return app && app.classList.contains("side-overlay") === css;
			});
			const state = await page.evaluate(() => ({ width: innerWidth, zoom: getComputedStyle(document.documentElement).zoom, css: getComputedStyle(document.documentElement).getPropertyValue("--side-overlay").trim(), app: document.querySelector(".app")?.classList.contains("side-overlay") }));
			assert.equal(state.width, width, `viewport width ${width}`);
			assert.equal(state.zoom, "1.25", `display zoom at ${width}`);
			assert.equal(state.app, state.css === "1", `App and CSS agree at ${width}`);
		}
	});

	test(`phone panel ${engine}: entering narrow layout closes the desktop panel`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-lead", context: { viewport: { width: 980, height: 844 }, hasTouch: true, isMobile: true }, suppressResize: true, waitForPhoneLayout: false });
		await page.waitForFunction(() => innerWidth === 980 && localStorage.getItem("ampi.panel") === "arc");
		const initial = await page.evaluate(() => ({ width: innerWidth, sideOverlay: document.querySelector(".app")?.classList.contains("side-overlay"), hasPanel: document.querySelector(".app")?.classList.contains("has-panel"), savedPanel: localStorage.getItem("ampi.panel") }));
		t.diagnostic(`desktop first render: ${JSON.stringify(initial)}`);
		assert.equal(initial.width, 980, "App starts at the desktop layout viewport");
		await page.setViewportSize({ width: 390, height: 844 });
		await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--side-overlay").trim() === "1");
		await page.waitForFunction(() => !document.querySelector(".app")?.classList.contains("has-panel") && localStorage.getItem("ampi.panel") === "arc");
		const state = await page.evaluate(() => ({ sideOverlay: document.querySelector(".app")?.classList.contains("side-overlay"), hasPanel: document.querySelector(".app")?.classList.contains("has-panel"), savedPanel: localStorage.getItem("ampi.panel") }));
		assert.equal(state.sideOverlay, true);
		assert.equal(state.hasPanel, false, "the phone's initial-layout panel rule applies after the viewport narrows");
		assert.equal(state.savedPanel, "arc", "narrow mode keeps the desktop panel preference");
	});

	test(`phone first render ${engine}: keep the saved desktop panel preference`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-lead", context: PHONE });
		assert.equal(await page.locator(".app").evaluate((el) => el.classList.contains("side-overlay")), true);
		assert.equal(await page.evaluate(() => localStorage.getItem("ampi.panel")), "arc");
		assert.equal(await page.locator(".app").evaluate((el) => el.classList.contains("has-panel")), false);
	});

	test(`desktop panel ${engine}: restore after narrow mode without changing its preference`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-lead", context: { viewport: { width: 1280, height: 844 } } });
		await page.waitForFunction(() => document.querySelector(".app")?.classList.contains("has-panel"));
		assert.equal(await page.evaluate(() => localStorage.getItem("ampi.panel")), "arc");
		await page.setViewportSize({ width: 390, height: 844 });
		await page.waitForFunction(() => document.querySelector(".app")?.classList.contains("side-overlay") && !document.querySelector(".app")?.classList.contains("has-panel"));
		assert.equal(await page.evaluate(() => localStorage.getItem("ampi.panel")), "arc", "narrow mode leaves the desktop preference untouched");
		await page.setViewportSize({ width: 1280, height: 844 });
		await page.waitForFunction(() => !document.querySelector(".app")?.classList.contains("side-overlay") && document.querySelector(".app")?.classList.contains("has-panel"));
		assert.equal(await page.evaluate(() => localStorage.getItem("ampi.panel")), "arc");
	});

	if (engine === "webkit") test("phone startup webkit: observe the 980 px meta-viewport transition", { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-lead", context: PHONE, recordResize: true });
		const observed = await page.evaluate(() => ({ initialWidth: (window as Window & { __initialInnerWidth?: number }).__initialInnerWidth, width: innerWidth, resizeEvents: (window as Window & { __resizeEvents?: number }).__resizeEvents ?? 0, sideOverlay: document.querySelector(".app")?.classList.contains("side-overlay") }));
		t.diagnostic(`real phone startup: ${JSON.stringify(observed)}`);
		assert.equal(observed.width, 390);
		assert.equal(observed.sideOverlay, true);
	});

	const cases = [
		["phone", { route: "#/h/devbox/t/pi%3Asess-lead", context: PHONE }, true],
		["phone without a rail", { route: "#/h/devbox/t/pi%3Asess-solo", context: PHONE }, false],
		["desktop", {}, true],
	] as const;
	for (const [size, options, rail] of cases) {
		test(`transcript sideways ${engine} ${size}: wide content fits the scroller, which never scrolls sideways`, { skip: engineSkip(engine) }, async (t) => {
			const page = await open(t, engine, type, path(), options);
			await page.locator(rail ? ".transcript-frame.strip" : ".transcript-frame:not(.strip)").waitFor();
			await wideReply(page);
			const m = await sideways(page);
			assert.equal(m.overflowX, "hidden", "the transcript scroller cannot be dragged sideways");
			assert.ok(m.extra <= 0, `the transcript scroller has ${m.extra} px of sideways overflow`);
			assert.deepEqual(m.out, [], `elements end outside the scroller ${JSON.stringify(m.scroll)}`);
			// A reveal into a wide table's last cell scrolls the table, never the transcript.
			await page.evaluate(() => document.querySelector(".transcript .md table tr:last-child td:last-child")!.scrollIntoView({ block: "nearest", inline: "end" }));
			assert.equal(await page.locator(".transcript-frame > .scroll").evaluate((el) => el.scrollLeft), 0, "a reveal scrolled the transcript sideways");
		});
	}
}
