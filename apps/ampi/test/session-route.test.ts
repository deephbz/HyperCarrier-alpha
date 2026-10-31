import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ENGINES, open } from "./resize-edges-fixture.ts";
import { engineSkip } from "./engines.ts";

// One Session has one route, `#/h/<Host ID>/t/<thread>`, whichever surface opens it. The demo Host's link key is
// `devbox#pi`; an older link names the Session by it, and arrives in place as the one route.
const THREAD = "pi:sess-big";
const ROUTE = `#/h/devbox/t/${encodeURIComponent(THREAD)}`;
const OLD = `#/h/devbox%23pi/t/${encodeURIComponent(THREAD)}`;

for (const [engine, type, path] of ENGINES) test(`session route ${engine}: an old link, ⌘K, the sidebar and a notification open one route with no new entry`, { skip: engineSkip(engine) }, async (t) => {
	const page = await open(t, engine, type, path());
	const before = await page.evaluate(() => location.hash);
	const row = page.locator(`.side .row[data-thread="${THREAD}"] a.title`).first();
	await row.waitFor();
	const title = await row.innerText();
	const start = await page.evaluate(() => history.length);
	const look = () => page.evaluate(() => {
		const el = document.querySelector<HTMLElement>("[data-region=transcript]");
		return { hash: location.hash, entries: history.length, mounted: el?.dataset.probe === "kept", top: Math.round(el?.scrollTop ?? -1) };
	});

	// A pasted older link: the paste is the browser's own step; the arrival rewrites it in place.
	await page.evaluate((old) => { location.hash = old; }, OLD);
	await page.waitForFunction((route) => location.hash === route, ROUTE);
	await page.locator('[data-region="transcript"] [data-entry]').first().waitFor({ state: "attached" });
	await page.waitForTimeout(400);
	await page.evaluate(() => {
		const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
		el.dataset.probe = "kept";
		el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) / 2);
	});
	await page.waitForTimeout(300);
	const opened = await look();
	assert.deepEqual({ ...opened, top: undefined }, { hash: ROUTE, entries: start + 1, mounted: true, top: undefined });
	assert.ok(opened.top > 0, "the transcript scrolled away from both ends");
	assert.equal(await row.getAttribute("href"), ROUTE);
	assert.equal(await row.getAttribute("aria-current"), "page");

	const paths: [string, () => Promise<unknown>][] = [
		["⌘K", async () => {
			await page.keyboard.press("ControlOrMeta+k");
			await page.locator(".modal input").first().fill(title);
			await page.locator(".palette-item.on").first().waitFor();
			await page.keyboard.press("Enter");
		}],
		["sidebar row", () => row.click()],
		["notification", () => page.evaluate((old) => (window as unknown as { ampiOpen(route: string): void }).ampiOpen(old), OLD)],
	];
	for (const [name, go] of paths) {
		await go();
		await page.waitForTimeout(400);
		assert.deepEqual(await look(), opened, `${name}: the same route, entry, view and place`);
	}

	await page.evaluate(() => history.back());
	await page.waitForFunction((before) => location.hash === before, before);
	assert.equal(await page.evaluate(() => history.length), start + 1, "Back left the Session in one step");
});
