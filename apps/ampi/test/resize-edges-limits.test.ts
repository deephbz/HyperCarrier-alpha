import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { engineSkip } from "./engines.ts";
import { EDGES, ENGINES, edgeCases, eventually, near, open, read } from "./resize-edges-fixture.ts";
// The resize gesture (resize-edges-fixture.ts) at region sizes, then clamps, cancel, keyboard and the panel overlay.
// resize-edges.test.ts holds the display scales.
edgeCases([["region sizes 120%", { sidebar: 1.2, panel: 1.2, transcript: 1.2 }]]);
for (const [engine, type, path] of ENGINES) {
	const skip = engineSkip(engine);
	test(`resize ${engine}: clamps, return from beyond a clamp, release outside, cancel, keyboard`, { skip }, async (t) => {
		const page = await open(t, engine, type, path(), { display: { overall: 1.25 } });
		for (const side of ["sidebar", "panel"] as const) {
			const { min, max, grow } = EDGES[side];
			const start = await read(page, side);
			await page.mouse.move(start.x, start.y);
			await page.mouse.down();
			await page.mouse.move(start.x + grow * 900, start.y);
			assert.equal((await read(page, side)).now, max, `${side} stops at its max`);
			await page.mouse.move(start.x - grow * 900, start.y);
			assert.equal((await read(page, side)).now, min, `${side} stops at its min`);
			// Back inside the range, the grabbed point is under the cursor again.
			await page.mouse.move(start.x + grow * 30, start.y);
			near((await read(page, side)).x, start.x + grow * 30, `${side} edge back inside the range`);
			// Escape cancels: the start width returns and later moves do nothing.
			await page.keyboard.press("Escape");
			const cancelled = await read(page, side);
			assert.equal(cancelled.now, start.now, `${side} cancel restores the start width`);
			near(cancelled.x, start.x, `${side} cancel restores the edge`);
			await page.mouse.move(start.x + grow * 60, start.y);
			assert.equal((await read(page, side)).now, start.now, `${side} ignores moves after a cancel`);
			await page.mouse.up();
			assert.equal((await read(page, side)).saved, start.saved, `${side} cancel saves nothing`);
			// Release far outside the handle commits what is drawn.
			await page.mouse.move(start.x, start.y);
			await page.mouse.down();
			await page.mouse.move(start.x + grow * 40, start.y);
			await page.mouse.move(start.x + grow * 40, 790);
			const drawn = await read(page, side);
			await page.mouse.up();
			const released = await read(page, side);
			near(released.x, drawn.x, `${side} release outside keeps the edge`);
			await eventually(async () => (await read(page, side)).saved === released.now, `${side} release outside saves the drawn width`);
			// Keyboard: arrows step 8 toward growth; Home and End clamp.
			await page.locator(`.${side}-edge`).focus();
			await page.keyboard.press(grow > 0 ? "ArrowRight" : "ArrowLeft");
			assert.equal((await read(page, side)).now, released.now + 8, `${side} arrow grows by 8`);
			await page.keyboard.press("End");
			assert.equal((await read(page, side)).now, max, `${side} End`);
			await page.keyboard.press("Home");
			assert.equal((await read(page, side)).now, min, `${side} Home`);
		}
	});
	test(`resize ${engine}: the panel overlays the main below 480 px and the edge stays under the cursor`, { skip }, async (t) => {
		// 1100 px: the panel squeezes the sidebar out; the main is 720 px until the panel passes 620 px.
		const page = await open(t, engine, type, path());
		await page.setViewportSize({ width: 1100, height: 800 });
		await page.locator(".app.sidebar-hidden").waitFor({ state: "attached" });
		const start = await read(page, "panel");
		assert.equal(start.overlay, false);
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x - 300, start.y);
		const wide = await read(page, "panel");
		assert.equal(wide.overlay, true, "a 680 px panel leaves 420 px of main: overlay");
		near(wide.x, start.x - 300, "edge across the overlay switch");
		await page.mouse.move(start.x - 100, start.y);
		const back = await read(page, "panel");
		assert.equal(back.overlay, false, "back above 480 px of main: no overlay");
		near(back.x, start.x - 100, "edge back across the switch");
		await page.mouse.move(start.x - 300, start.y);
		await page.mouse.up();
		const released = await read(page, "panel");
		assert.equal(released.overlay, true, "release keeps the overlay");
		near(released.x, start.x - 300, "release keeps the edge");
	});
}
