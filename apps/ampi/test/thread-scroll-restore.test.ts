import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ENGINES, frames, offsetOf, open } from "./thread-scroll-fixture.ts";
import { engineSkip } from "./engines.ts";

// Back and reload restore the reading place as an entry and an offset. The scroller can resize before the restore's
// scroll event: the prompt rail mounts when the outline arrives and hides the native scrollbar (K1F appBack). The
// restored place then holds; the place from before the restore (the newest end) does not come back.
for (const engine of ENGINES) test(`scroll hold (${engine}): a resize right after the restore keeps the restored place`, { skip: engineSkip(engine) }, async (t) => {
	const { page } = await open(t, 200, "pi", engine);
	// The reader reads e151 with its top 60 CSS px above the transcript's top.
	await page.evaluate(() => {
		const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
		const node = el.querySelector<HTMLElement>("[data-entry=e151]")!;
		el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top + 60;
		el.dispatchEvent(new Event("scroll"));
	});
	await page.waitForFunction(() => history.state?.place?.id === "e151");
	const saved = await page.evaluate(() => history.state.place.offset as number);
	// The first write that moves the transcript away from its end is the restore. The slot narrows in the same task, so
	// the resize lands before that write's scroll event.
	await page.addInitScript(() => {
		const d = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
		let armed = true;
		Object.defineProperty(Element.prototype, "scrollTop", { configurable: true, get: d.get, set(this: HTMLElement, v: number) {
			d.set!.call(this, v);
			if (!armed || !this.matches("[data-region=transcript]") || v > this.scrollHeight - this.clientHeight - 200) return;
			armed = false;
			this.closest<HTMLElement>(".main-slot")!.style.width = "700px";
		} });
	});
	await page.reload();
	await page.locator("[data-entry=e151]").waitFor({ state: "attached" });
	await page.waitForFunction(() => document.querySelector<HTMLElement>(".main-slot")?.style.width === "700px");
	for (let i = 0; i < 4; i++) await frames(page);
	const at = await offsetOf(page, "e151");
	assert.ok(at !== null && Math.abs(at - saved) <= 1, `the restore put e151 at ${at?.toFixed(1)}, saved ${saved.toFixed(1)}`);
});
