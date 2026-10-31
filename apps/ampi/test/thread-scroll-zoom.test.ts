import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { ENGINES, anchor, frames, gap, offsetOf, open, scrollAway } from "./thread-scroll-fixture.ts";
import { engineSkip } from "./engines.ts";
import { zoomCases } from "./thread-scroll-zoom-cases.ts";

// Display zoom 130 % (thread-scroll-zoom-cases.ts). thread-scroll-zoom-out.test.ts holds zoom 80 %.
zoomCases(1.3);

// A place saved before the unit marker holds its offset in screen px, and history state outlives a reload and a deploy.
// Reload and Back restore such a place converted at the transcript, so the entry lands where it was read.
for (const engine of ENGINES) for (const [zoom, region] of [[1.3, 1], [1.3, 1.2]] as const) {
	const scale = zoom * region;
	test(`scroll hold (${engine}, zoom ${zoom}, transcript ${region}): a place saved in screen px restores within 1 px after reload and on Back`, { skip: engineSkip(engine) }, async (t) => {
		const { page } = await open(t, 200, "pi", engine, zoom, region);
		// The reader reads e151 with its top 60 CSS px above the transcript's top.
		await page.evaluate(() => {
			const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
			const node = el.querySelector<HTMLElement>("[data-entry=e151]")!;
			const scale = el.getBoundingClientRect().width / el.offsetWidth;
			el.scrollTop += (node.getBoundingClientRect().top - el.getBoundingClientRect().top) / scale + 60;
			el.dispatchEvent(new Event("scroll"));
		});
		await page.waitForFunction(() => history.state?.place?.id === "e151");
		const saved = await page.evaluate(() => history.state.place.offset as number);
		// The same place as the code before the marker wrote it.
		const legacy = () => page.evaluate((offset) => {
			const { unit: _, ...place } = history.state.place;
			history.replaceState({ ...history.state, place: { ...place, offset } }, "");
		}, saved * scale);
		const landed = async () => {
			await page.locator("[data-entry=e151]").waitFor({ state: "attached" });
			for (let i = 0; i < 4; i++) await frames(page);
			return (await offsetOf(page, "e151"))! / scale;
		};
		await legacy();
		await page.reload();
		let at = await landed();
		assert.ok(Math.abs(at - saved) <= 1, `reload restored e151 at ${at.toFixed(1)}, saved ${saved.toFixed(1)}`);
		// Back to a legacy entry after a reload: the page holds no notes of its own for that entry.
		await page.waitForFunction(() => history.state?.place?.id === "e151");
		await legacy();
		await page.evaluate(() => { location.hash = "#another-place"; });
		await page.reload();
		await page.locator("[data-region=transcript] [data-entry]").first().waitFor({ state: "attached" });
		await frames(page);
		await page.goBack();
		at = await landed();
		assert.ok(Math.abs(at - saved) <= 1, `Back restored e151 at ${at.toFixed(1)}, saved ${saved.toFixed(1)}`);
	});
}

// A live display-size change (Cmd+Shift+= / Cmd+0): App sets html `zoom` on a window of fixed screen size, so the
// transcript narrows in CSS px, rows rewrap and the scroller's own screen top moves. The read entry keeps its CSS offset
// from the transcript's top at each step.
for (const engine of ENGINES) {
	const setZoom = (page: Page, zoom: number) => page.evaluate(async (zoom) => {
		document.documentElement.style.zoom = String(zoom);
		await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
	}, zoom);
	for (const backend of ["pi"] as const) test(`scroll hold (${engine}, ${backend}): a live zoom change 1 → 1.3 → 1 away from the end keeps the read entry within 2 CSS px`, { skip: engineSkip(engine) }, async (t) => {
		const { page } = await open(t, 200, backend, engine);
		await scrollAway(page);
		assert.ok(await gap(page) > 1000, "the reader is away from the newest end");
		const before = await anchor(page);
		const steps = [1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.25, 1.1, 1];
		for (const zoom of steps) {
			await setZoom(page, zoom);
			await page.waitForTimeout(30);
			await frames(page);
			const at = await offsetOf(page, before.id);
			const css = at === null ? null : at / zoom;
			assert.ok(css !== null && Math.abs(css - before.offset) <= 2, `at zoom ${zoom}, ${before.id} moved from ${before.offset.toFixed(1)} to ${css?.toFixed(1)} CSS px`);
		}
	});
	test(`scroll hold (${engine}): a reader at the end stays there through a live zoom change and follows the next entry`, { skip: engineSkip(engine) }, async (t) => {
		const { page, publish } = await open(t, 200, "pi", engine);
		assert.ok(await gap(page) <= 2, "the reader starts at the end");
		for (const zoom of [1.1, 1.3]) {
			await setZoom(page, zoom);
			await page.waitForTimeout(30);
			await frames(page);
			assert.ok(await gap(page) <= 2, `at zoom ${zoom} the reader is still at the end (gap ${await gap(page)})`);
		}
		await publish(201);
		assert.ok(await gap(page) <= 2, "the next entry is followed");
	});
}
