import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { engineSkip } from "./engines.ts";
import { ENGINES, open } from "./resize-edges-fixture.ts";

// A popover's placement is a function of its anchor, bounds and content. Popover places again on many events, so a
// placement that read the box the last one left would move the popover by run order: a scale measured on that box
// moved the slash menu by 1/64 px across a layout-unit edge, and its text rendered differently in two equal runs.
for (const [engine, type, path] of ENGINES) {
	test(`popover placement ${engine}: a placement does not depend on the box the last placement left`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-long-title" });
		const composer = page.getByRole("textbox", { name: "Message the agent", exact: true });
		const menu = page.locator("[data-slash-menu]");
		const box = () => menu.evaluate((el: HTMLElement) => [el.style.left, el.style.top, el.style.width, el.style.maxWidth, el.style.maxHeight].join(" "));
		for (const zoom of ["1", "0.8", "1.3"]) {
			await page.evaluate((zoom) => { document.documentElement.style.zoom = zoom; }, zoom);
			await composer.fill("");
			await composer.fill("/");
			await menu.waitFor();
			const first = await box();
			for (const left of ["0px", "3.3px", "700px"]) {
				await menu.evaluate((el: HTMLElement, left) => {
					Object.assign(el.style, { left, width: "37.7px", maxWidth: "50px", maxHeight: "40px" });
					window.dispatchEvent(new Event("resize"));
				}, left);
				assert.equal(await box(), first, `zoom ${zoom}, last left ${left}`);
			}
		}
	});
}
