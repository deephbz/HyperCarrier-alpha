import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { engineSkip } from "./engines.ts";
import type { Page } from "playwright";
import { EDGES, ENGINES, edgeCases, eventually, near, open, read } from "./resize-edges-fixture.ts";
// The resize gesture (resize-edges-fixture.ts) at region sizes, then clamps, cancel, keyboard, the one indicator and the
// panel overlay. resize-edges.test.ts holds the display scales.
edgeCases([["region sizes 120%", { sidebar: 1.2, panel: 1.2, transcript: 1.2 }]]);

const AWAY = { x: 1590, y: 790 };
/** The painted pixels of a 32 px strip centred on one edge, one string per column. A blank page decodes the PNG. */
async function strip(page: Page, side: keyof typeof EDGES): Promise<string[]> {
	const { x, y } = await read(page, side);
	const png = await page.screenshot({ clip: { x: Math.round(x) - 16, y: Math.round(y) - 6, width: 32, height: 12 }, animations: "disabled", caret: "hide" });
	const blank = await page.context().newPage();
	try {
		return await blank.evaluate(async (src) => {
			const image = new Image();
			image.src = src;
			await image.decode();
			const canvas = document.createElement("canvas");
			canvas.width = image.width; canvas.height = image.height;
			const g = canvas.getContext("2d")!;
			g.drawImage(image, 0, 0);
			const data = g.getImageData(0, 0, image.width, image.height).data;
			return Array.from({ length: image.width }, (_, col) => Array.from({ length: image.height }, (_, row) => data.slice((row * image.width + col) * 4, (row * image.width + col) * 4 + 3).join(",")).join(";"));
		}, `data:image/png;base64,${png.toString("base64")}`);
	} finally { await blank.close(); }
}
/** The runs of columns where `state` paints differently from `rest`, as [first column, width]. */
function lit(state: string[], rest: string[]): [number, number][] {
	const runs: [number, number][] = [];
	state.forEach((column, i) => {
		if (column === rest[i]) return;
		const last = runs.at(-1);
		if (last && last[0] + last[1] === i) last[1]++;
		else runs.push([i, 1]);
	});
	return runs;
}
/** One run of at most `width` columns inside the 8 px hit box (columns 12 to 19 of the strip). */
function oneLine(runs: [number, number][], width: number, what: string) {
	assert.equal(runs.length, 1, `${what}: one painted line, got runs ${JSON.stringify(runs)}`);
	const [first, size] = runs[0]!;
	assert.ok(size <= width && first >= 12 && first + size <= 20, `${what}: the line is at most ${width} px inside the hit box, got ${JSON.stringify(runs)}`);
}
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
	test(`resize ${engine}: the edge paints one line on hover, click, drag and keyboard focus, and a click looks like hover`, { skip }, async (t) => {
		const page = await open(t, engine, type, path());
		for (const side of ["sidebar", "panel"] as const) {
			const { grow } = EDGES[side];
			const edge = page.locator(`.${side}-edge`);
			const start = await read(page, side);
			await page.mouse.move(AWAY.x, AWAY.y);
			const rest = await strip(page, side);
			await page.mouse.move(start.x, start.y);
			const hover = await strip(page, side);
			oneLine(lit(hover, rest), 2, `${side} hover`);
			// A click focuses the edge, so Escape can cancel a drag. It paints exactly what hover paints, and nothing once the pointer leaves.
			await page.mouse.down();
			await page.mouse.up();
			assert.ok(await edge.evaluate((el) => el === document.activeElement), `${side} a click focuses the edge`);
			assert.deepEqual(lit(await strip(page, side), hover), [], `${side} a click paints what hover paints`);
			await page.mouse.move(AWAY.x, AWAY.y);
			assert.deepEqual(lit(await strip(page, side), rest), [], `${side} a clicked edge without the pointer paints nothing`);
			// Keyboard focus shows one line, wider than hover, for keyboard users.
			await page.keyboard.press("Shift+Tab");
			await page.keyboard.press("Tab");
			assert.ok(await edge.evaluate((el) => el === document.activeElement), `${side} Tab focuses the edge`);
			const keyboard = lit(await strip(page, side), rest);
			oneLine(keyboard, 8, `${side} keyboard focus`);
			assert.ok(keyboard[0]![1] > lit(hover, rest)[0]![1], `${side} keyboard focus is wider than hover: ${JSON.stringify(keyboard)}`);
			// A drag past the min clamp leaves the hit box; the line stays lit until release. The min keeps the panel out of
			// the overlay, which would re-lay the main beside the edge.
			await page.mouse.move(start.x, start.y);
			await page.mouse.down();
			await page.mouse.move(start.x - grow * 900, start.y);
			const dragged = await strip(page, side);
			await page.mouse.up();
			// WebKit keeps :hover on a released capture target until the pointer next moves.
			await page.mouse.move(AWAY.x, AWAY.y);
			const released = await strip(page, side);
			oneLine(lit(dragged, released), 2, `${side} drag past the clamp`);
			await page.mouse.move((await read(page, side)).x, start.y);
			oneLine(lit(await strip(page, side), released), 2, `${side} hover after release (so release paints nothing)`);
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
