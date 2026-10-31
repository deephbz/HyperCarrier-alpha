import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { engineSkip } from "./engines.ts";
import { CORNERS, ENGINES, assertInside, firstFrameCases, frames, measure, open, setup, trigger, zoom, type Engine } from "./hover-card-fixture.ts";

// Hover card placement (hover-card-fixture.ts) in the large viewports, then after changes and on keyboard focus.
// hover-card-small.test.ts holds the first painted frame in the small viewports.
firstFrameCases([[1440, 900], [1280, 800]]);

for (const engine of Object.keys(ENGINES) as Engine[]) {
	test(`${engine}: an open card stays inside after its content, the display size, or the window changes, and on reopen`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine);
		for (const card of ["hud", "title"] as const) {
			await page.setViewportSize({ width: 1440, height: 900 });
			await setup(page, { corner: "bottom-right", card });
			await zoom(page, 1, 1);
			// Keyboard focus keeps the card open while the window moves the anchor away from the pointer.
			await page.mouse.move(2, 2);
			await page.focus(card === "hud" ? ".model-hud-trigger" : ".session-copy");
			await frames(page);
			await assertInside(page, `${card} at 100 %`);
			await zoom(page, 1.3, 1);
			await frames(page);
			await assertInside(page, `${card} after the display size changes to 130 %`);
			await page.setViewportSize({ width: 900, height: 600 });
			await frames(page);
			await assertInside(page, `${card} after the window shrinks to 900x600`);
			await setup(page, { corner: "bottom-right", card, rows: 120, keep: true });
			await frames(page);
			const grown = await assertInside(page, `${card} after its content grows`);
			assert.ok(grown.scrolls, `${card}: the grown card scrolls inside`);
			await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
			await page.locator(".session-metadata").waitFor({ state: "detached" });
			await page.hover(trigger(card));
			await frames(page);
			await assertInside(page, `${card} on reopen`);
		}
	});

	test(`${engine}: keyboard focus opens a card without moving focus, Escape closes it, and the pointer can enter it`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine);
		for (const corner of CORNERS) {
			await setup(page, { corner, card: "hud" });
			await zoom(page, 1.3, 1);
			await page.mouse.move(2, 2);
			await page.focus(".model-hud-trigger");
			await frames(page);
			await assertInside(page, `${corner}: focus opens the card`);
			assert.equal(await page.evaluate(() => document.activeElement?.className), "model-hud-trigger hint", `${corner}: focus stays on the trigger`);
			await page.keyboard.press("Escape");
			await page.locator(".session-metadata").waitFor({ state: "detached" });
			await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
			await page.hover(".model-hud-trigger");
			const m = await assertInside(page, `${corner}: hover opens the card`);
			const [left, top, right, bottom] = m.box as [number, number, number, number];
			await page.mouse.move((left + right) / 2, (top + bottom) / 2, { steps: 12 });
			await frames(page);
			assert.ok(await measure(page), `${corner}: the card stays open while the pointer moves into it`);
		}
	});
}
