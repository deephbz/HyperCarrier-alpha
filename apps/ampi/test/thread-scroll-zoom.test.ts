import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ENGINES, frames, offsetOf, open } from "./thread-scroll-fixture.ts";
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

