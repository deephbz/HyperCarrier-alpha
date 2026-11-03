import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ENGINES, open } from "./resize-edges-fixture.ts";
import { engineSkip } from "./engines.ts";

const WORST_ROUTE = "#/h/devbox/t/pi%3Asess-content-worst?e=content-worst-2";

for (const [engine, type, path] of ENGINES) {
	test(`transcript content ${engine}: 48k tool output stays in its block at 320 px and desktop width`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: WORST_ROUTE, fixture: "worst" });
		const tool = page.locator('.tool[data-result-entry="content-worst-3"]');
		await tool.waitFor();
		const preview = tool.locator(".tool-body pre").last();
		await preview.waitFor();
		assert.ok((await preview.textContent())!.length < 48_000, "the initial tool card uses a bounded preview");
		await tool.locator(".entry-body summary").filter({ hasText: "Output shortened" }).click();
		await page.waitForFunction(() => [...document.querySelectorAll(".tool-body .entry-body pre")].some((element) => element.textContent?.length === 48_000));
		const output = tool.locator(".tool-body pre").last();
		for (const width of [320, 1600]) {
			await page.setViewportSize({ width, height: 900 });
			const result = await output.evaluate((element) => ({
				length: element.textContent?.length ?? 0,
				body: (() => {
					const body = element.closest<HTMLElement>(".tool-body")!;
					return { clientWidth: body.clientWidth, scrollWidth: body.scrollWidth, clientHeight: body.clientHeight, scrollHeight: body.scrollHeight };
				})(),
			}));
			assert.equal(result.length, 48_000, "the complete tool result is available in its error disclosure");
			assert.ok(result.body.scrollHeight > result.body.clientHeight, "the tool body contains the long output in its own scroller");
			assert.ok(result.body.scrollWidth <= result.body.clientWidth, "the output does not widen its own scroller");
			assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `the page does not scroll sideways at ${width} px`);
		}
	});
}
