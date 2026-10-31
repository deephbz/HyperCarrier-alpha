import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { engineSkip } from "./engines.ts";
import { ENGINES, open } from "./resize-edges-fixture.ts";
// The owner's hover incident: "when hovering on it, msg list correctly pops up but the entire page gets into a strange
// layout". The prompt outline is an overlay. Opening it moves no region box and scrolls no element but the outline.

/** Region boxes, and the scroll offset of every element outside the outline. */
const layout = (page: Page) => page.evaluate(() => {
	const box = (selector: string) => { const r = document.querySelector(selector)?.getBoundingClientRect(); return r && [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100).join(" "); };
	const scrolled = [...document.querySelectorAll<HTMLElement>("*")].filter((el) => !el.closest(".prompt-outline") && (el.scrollLeft || el.scrollTop))
		.map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} ${el.scrollLeft},${el.scrollTop}`);
	return {
		regions: Object.fromEntries(["[data-region=sidebar]", ".main-slot .topbar", "[data-region=transcript]", ".panel-slot", ".companion-scrollbar"].map((s) => [s, box(s)])),
		page: [document.scrollingElement!.scrollLeft, document.scrollingElement!.scrollTop],
		scrolled,
	};
});

// `clip`: the app shell holds content below its box, as any clipped overflow would. A scroll that chains past the
// outline then moves the whole page.
const CASES = [
	["100%, reader at the newest prompt", undefined, 1, false],
	["100%, reader mid-transcript", undefined, 0.5, false],
	["125%, reader at the newest prompt", { overall: 1.25 }, 1, false],
	["100%, reader at the newest prompt, clipped shell overflow", undefined, 1, true],
] as const;
for (const [engine, type, path] of ENGINES) for (const [label, display, at, clip] of CASES) {
	test(`prompt rail ${engine} ${label}: the outline overlays; sidebar, header and transcript do not move`, { skip: engineSkip(engine) }, async (t) => {
		// The 600-turn demo Session: its outline is longer than the outline box, as on the owner's Sessions.
		const page = await open(t, engine, type, path(), { display, route: "#/h/devbox/t/pi%3Asess-big" });
		if (clip) await page.addStyleTag({ content: ".app { position: relative; } .app::after { content: ''; position: absolute; top: 100%; left: 0; width: 1px; height: 400px; }" });
		const rail = page.locator(".prompt-rail");
		await page.locator(".companion-scrollbar [data-user-mark]").first().waitFor({ state: "attached" });
		// The outline opens at the reader's prompt. At the newest prompt its list cannot center that item.
		await page.locator("[data-region=transcript]").evaluate((el, at) => { el.scrollTop = (el.scrollHeight - el.clientHeight) * at; }, at);
		await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
		const rest = await layout(page);
		assert.ok(rest.regions["[data-region=sidebar]"] && rest.regions["[data-region=transcript]"], "the page shows the sidebar and the transcript");
		await rail.hover();
		await page.locator(".prompt-outline").waitFor();
		await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
		assert.deepEqual(await layout(page), rest, "the open outline moves and scrolls nothing outside itself");
		const cur = await page.locator(".prompt-outline").evaluate((list) => { const a = list.getBoundingClientRect(), b = list.querySelector(".cur")?.getBoundingClientRect(); return b && b.top >= a.top && b.bottom <= a.bottom; });
		assert.equal(cur, true, "the outline opens at the reader's prompt");
		const outline = (await page.locator(".prompt-outline").boundingBox())!, viewport = page.viewportSize()!;
		assert.ok(outline.x >= 0 && outline.y >= 0 && outline.x + outline.width <= viewport.width && outline.y + outline.height <= viewport.height, `the outline lies inside the window: ${JSON.stringify(outline)}`);
		await page.mouse.move(1, 1);
		await page.locator(".prompt-outline").waitFor({ state: "detached" });
		assert.deepEqual(await layout(page), rest, "closing the outline restores nothing because nothing moved");
	});
}
