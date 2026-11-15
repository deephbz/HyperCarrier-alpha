import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ENGINES, open, seededArc } from "./resize-edges-fixture.ts";
import { engineSkip } from "./engines.ts";

const THREAD = "pi:sess-content-worst";
const ROUTE = `#/h/devbox/t/${encodeURIComponent(THREAD)}?p=arc`;

for (const [engine, type, path] of ENGINES) {
	test(`Arc content ${engine}: long chapter label and point title stay within two lines at 320 px`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: ROUTE, context: { viewport: { width: 320, height: 800 } }, fixture: "worst" });
		await seededArc(THREAD, "worst");
		await page.locator(".arc-label").first().waitFor();
		const label = page.locator(".arc-label").filter({ hasText: "Đặng Thị Ngọc Hân" });
		await label.waitFor();
		const labelLines = await label.evaluate((element) => {
			const style = getComputedStyle(element);
			return Math.round(element.getBoundingClientRect().height / parseFloat(style.lineHeight));
		});
		assert.ok(labelLines <= 2, `chapter label occupies ${labelLines} lines`);
		const title = page.locator(".arc-needs .arc-point > strong").first();
		await title.waitFor();
		const titleLines = await title.evaluate((element) => {
			const style = getComputedStyle(element);
			return Math.round(element.getBoundingClientRect().height / parseFloat(style.lineHeight));
		});
		assert.ok(titleLines <= 2, `point title occupies ${titleLines} lines`);
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Arc does not scroll the page sideways");
	});
}
