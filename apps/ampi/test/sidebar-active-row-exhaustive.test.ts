import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ENGINES, open, waitForProgress } from "./resize-edges-fixture.ts";
import { engineSkip } from "./engines.ts";

for (const [engine, type, path] of ENGINES) {
	test(`sidebar active row ${engine}: 1,000-Session deep link reveals the distant target`, { skip: engineSkip(engine), timeout: 170_000 }, async (t) => {
		// Keep one full-scale case in the exhaustive lane; the fast suite proves the same fold/reveal with 96 rows.
		const page = await open(t, engine, type, path(), { fixture: "huge", route: "#/h/devbox/t/pi%3Asess-lead", seedArcs: false });
		const group = page.locator('[data-group="unplaced"] > button.group-row');
		assert.equal(await group.getAttribute("aria-expanded"), "false", "the target group starts collapsed");
		await group.click();
		await waitForProgress(
			() => page.locator('.side-scroll [data-group="unplaced"] .row[data-thread]').count(),
			(count) => String(count ?? 0),
			(count): count is number => count !== undefined && count >= 1000,
		);
		const targetRow = page.locator('.side-scroll [data-group="unplaced"] .row[data-thread]').nth(900);
		const geometry = await targetRow.evaluate((row) => {
			const bounds = row.getBoundingClientRect(), list = row.closest<HTMLElement>(".side-scroll")!.getBoundingClientRect();
			return { offset: bounds.top - list.bottom, viewport: list.height };
		});
		assert.ok(geometry.offset >= 3 * geometry.viewport, `row 900 begins at least three viewports below the fold: ${geometry.offset}px / ${geometry.viewport}px`);
		const target = await targetRow.locator("a.title").getAttribute("href");
		assert.ok(target);
		await page.getByRole("button", { name: "devbox connected", exact: true }).click();
		await page.goto(new URL(target, page.url()).href);
		await page.reload();
		await waitForProgress(
			() => page.locator('.side-scroll .row.active[data-thread]').getAttribute("data-thread"),
			(id) => id ?? "no active row",
			(id): id is string => Boolean(id),
		);
		await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		const visible = await page.evaluate(() => {
			const row = document.querySelector<HTMLElement>(".side-scroll .row.active[data-thread]"), list = document.querySelector<HTMLElement>(".side-scroll")!;
			if (!row) return false;
			const a = row.getBoundingClientRect(), b = list.getBoundingClientRect();
			return a.top >= b.top && a.bottom <= b.bottom;
		});
		assert.equal(visible, true, "the deep link reveals and centers the target row");
	});
}
