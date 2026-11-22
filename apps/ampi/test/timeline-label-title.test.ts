import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ENGINES, open } from "./resize-edges-fixture.ts";
import { engineSkip } from "./engines.ts";

for (const [engine, type, path] of ENGINES) {
	test(`Timeline label ${engine}: the narrow label exposes its full text`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-lead", context: { viewport: { width: 320, height: 800 } } });
		await page.goto(new URL("#/timeline", page.url()).href);
		await page.locator('.cos-band-label .cos-total').first().waitFor();
		const labels = await page.locator('.cos-band-label > span').evaluateAll((labels) => labels.map((label) => ({ text: label.textContent, title: label.getAttribute('title'), clipped: label.scrollWidth > label.clientWidth })));
		assert.ok(labels.some((label) => label.clipped), "the narrow viewport truncates a real label");
		for (const label of labels) assert.equal(label.title, label.text);
	});
}
