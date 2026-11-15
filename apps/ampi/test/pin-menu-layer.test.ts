import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { engineSkip } from "./engines.ts";
import { ENGINES, open } from "./resize-edges-fixture.ts";
// The owner's row-menu incident: right-click on a sidebar Session opened "Pin to top" 5–8 rows below the pointer, and
// near the window's bottom the page broke with an empty band. A menu lives in the top layer: it opens at the pointer,
// flips and clamps into the viewport, and opening it moves or scrolls nothing else.

/**
 * Every scroll offset outside the menu, the document's scroll size, the region boxes, and each sidebar row's Session and
 * box. A container's content height is not compared: a panel that finishes loading may grow, and a menu cannot change it.
 */
const layout = (page: Page) => page.evaluate(() => {
	const scrolls = [...document.querySelectorAll<HTMLElement>("*")].filter((el) => !el.closest(".popover") && (el.scrollTop || el.scrollLeft))
		.map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} ${el.scrollLeft},${el.scrollTop}`);
	const rect = (r?: DOMRect) => r && [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100).join(" ");
	const box = (selector: string) => rect(document.querySelector(selector)?.getBoundingClientRect());
	const doc = document.scrollingElement!;
	const rows = [...document.querySelectorAll<HTMLElement>(".side .row[data-thread]")].map((el) => `${el.dataset.thread} ${rect(el.getBoundingClientRect())}`);
	return { scrolls, page: [doc.scrollLeft, doc.scrollTop, doc.scrollWidth, doc.scrollHeight], sidebar: box("[data-region=sidebar]"), main: box(".main-slot"), rows };
});

/** Right-clicks `row` at a point inside it and returns that point and the open menu's box. */
async function menuAt(page: Page, row: ReturnType<Page["locator"]>, dy: (box: { y: number; height: number }) => number) {
	const box = (await row.boundingBox())!;
	const x = box.x + Math.min(40, box.width / 2), y = box.y + dy(box);
	await page.mouse.click(x, y, { button: "right" });
	const menu = page.locator(".row-menu");
	await menu.waitFor();
	await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
	return { x, y, menu: (await menu.boundingBox())! };
}

const DISPLAYS = [["100%", undefined], ["overall 125%", { overall: 1.25 }], ["sidebar 120%", { sidebar: 1.2 }]] as const;
// Session IDs declared by scripts/demo/sessions.ts and scripts/demo/index.ts (with DEMO_STRESS=0). Waiting for the
// whole fixture avoids taking a baseline while the Host is still indexing later rows.
const FIXTURE_THREAD_IDS = [
	"pi:sess-lead",
	"pi:sess-worker-reader",
	"pi:sess-worker-gui",
	"pi:sess-big",
	"pi:sess-solo",
	"pi:sess-ops-lead",
	"pi:sess-ops-worker",
	"pi:sess-long-title",
	"pi:sess-loose",
	"pi:sess-asks",
	"pi:sess-rarebit-empty",
	"pi:sess-rarebit-error",
	"pi:sess-typography",
	"pi:sess-lens-runs",
	"pi:sess-lens-window",
] as const;
for (const [engine, type, path] of ENGINES) for (const [label, display] of DISPLAYS) {
	test(`row menu ${engine} ${label}: opens at the pointer, inside the viewport, and moves nothing`, { skip: engineSkip(engine) }, async (t) => {
		// An idle Session: a live one follows its output and scrolls on its own.
		const page = await open(t, engine, type, path(), { display, route: "#/h/devbox/t/pi%3Asess-big" });
		const resize = async (height: number) => {
			const before = await page.evaluate(() => {
				const scroll = document.querySelector<HTMLElement>(".scroll")!;
				return { viewport: innerHeight, scroll: scroll.clientHeight, scale: scroll.getBoundingClientRect().height / scroll.offsetHeight };
			});
			await page.setViewportSize({ width: 1600, height });
			// WebKit can acknowledge the viewport before applying it. The idle Session follows the end when its
			// scroller shrinks: 800 -> 600 px moves scrollTop by 200 px without any transcript content growth.
			await page.waitForFunction(({ height, clientHeight }) => {
				const scroll = document.querySelector<HTMLElement>(".scroll");
				return innerWidth === 1600 && innerHeight === height && scroll && Math.abs(scroll.clientHeight - clientHeight) <= 1
					&& Math.abs(scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop) <= 1;
			}, { height, clientHeight: before.scroll + (height - before.viewport) / before.scale });
		};
		await resize(600);
		const rows = page.locator(".side .row[data-thread]");
		await rows.first().waitFor();
		// Expand both fixture Teams, then wait for every Session declared by scripts/demo/sessions.ts. A single Team
		// row is not readiness: the Host may still add later fixture rows after a transient pause.
		for (const leadId of ["pi:sess-lead", "pi:sess-ops-lead"]) {
			const fold = page.locator(`.side .row[data-thread="${leadId}"] [data-collapse-toggle]`);
			await fold.waitFor();
			if (await fold.getAttribute("aria-expanded") === "false") await fold.click();
		}
		const unplaced = page.locator('.side [data-sidebar-toggle="unplaced"]');
		await unplaced.waitFor();
		if (await unplaced.getAttribute("aria-expanded") === "false") await unplaced.click();
		await Promise.all(FIXTURE_THREAD_IDS.map((id) => page.locator(`.side .row[data-thread="${id}"]`).first().waitFor()));
		// Restore the initial folds after confirming that every fixture Session reached the sidebar.
		for (const leadId of ["pi:sess-lead", "pi:sess-ops-lead"]) {
			const fold = page.locator(`.side .row[data-thread="${leadId}"] [data-collapse-toggle]`);
			if (await fold.getAttribute("aria-expanded") === "true") await fold.click();
		}
		if (await unplaced.getAttribute("aria-expanded") === "true") await unplaced.click();
		await page.locator(".side-scroll").evaluate((el: HTMLElement) => { el.scrollTop = 0; });

		// Every fixture row is present. Capture the baseline before opening the menu.
		let rest = await layout(page);
		// A row with room below: the menu's top-left corner is the pointer.
		const top = await menuAt(page, rows.first(), (b) => b.height / 2);
		const viewport0 = page.viewportSize()!;
		assert.ok(top.menu.y + top.menu.height <= viewport0.height, "the menu is inside the viewport");
		assert.ok(Math.abs(top.menu.x - top.x) <= 1 && Math.abs(top.menu.y - top.y) <= 1, `menu at the pointer: pointer ${top.x},${top.y}, menu ${top.menu.x},${top.menu.y}`);
		assert.equal(await page.evaluate(() => document.activeElement?.closest(".row-menu") != null), true, "the menu item takes focus");
		assert.deepEqual(await layout(page), rest, "opening the menu moves and scrolls nothing");
		await page.keyboard.press("Escape");
		await page.locator(".row-menu").waitFor({ state: "detached" });

		// The lowest row on screen, with the window ending just below it: the menu flips above the pointer.
		// The row is named by its Session, after the Team fold and the layout settle.
		const lowest = () => rows.evaluateAll((els) => els.map((el) => ({ id: (el as HTMLElement).dataset.thread!, bottom: el.getBoundingClientRect().bottom }))
			.filter((r) => r.bottom <= innerHeight).reduce((a, b) => (b.bottom > a.bottom ? b : a)));
		const target = await lowest();
		await resize(Math.ceil(target.bottom) + 4);
		await page.waitForFunction((id) => {
			const row = [...document.querySelectorAll<HTMLElement>(".side .row[data-thread]")].find((el) => el.dataset.thread === id);
			return row && row.getBoundingClientRect().bottom > innerHeight - 12 && row.getBoundingClientRect().bottom <= innerHeight;
		}, target.id);
		const viewport = page.viewportSize()!;
		rest = await layout(page);
		const chosen = await lowest();
		assert.ok(chosen.bottom > viewport.height - 12, `the lowest row ends near the bottom: ${JSON.stringify(chosen)} of ${viewport.height}`);
		const row = page.locator(`.side .row[data-thread="${chosen.id}"]`).first();
		const low = await menuAt(page, row, (b) => b.height - 3);
		assert.ok(low.y > viewport.height - 12, `the pointer is near the bottom: ${low.y} of ${viewport.height}`);
		assert.ok(low.menu.x >= 0 && low.menu.y >= 0 && low.menu.x + low.menu.width <= viewport.width && low.menu.y + low.menu.height <= viewport.height, `menu inside the viewport: ${JSON.stringify(low.menu)}`);
		assert.ok(Math.abs(low.menu.x - low.x) <= 1 && Math.abs(low.menu.y + low.menu.height - low.y) <= 1, `menu flipped above the pointer: pointer ${low.x},${low.y}, menu ${JSON.stringify(low.menu)}`);
		assert.deepEqual(await layout(page), rest, "opening the menu near the bottom moves and scrolls nothing");
		await page.keyboard.press("Escape");
		await page.locator(".row-menu").waitFor({ state: "detached" });
		assert.deepEqual(await layout(page), rest, "closing the menu leaves the layout as it was");
	});
}
