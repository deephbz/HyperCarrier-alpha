import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ENGINES, open } from "./resize-edges-fixture.ts";
import { engineSkip } from "./engines.ts";

// One Session has one route, `#/h/<Host ID>/t/<thread>`, whichever surface opens it. The demo Host's link key is
// `devbox#pi`; a thread link by the link key names no Host and says so.
const THREAD = "pi:sess-big";
const ROUTE = `#/h/devbox/t/${encodeURIComponent(THREAD)}`;
const OLD = `#/h/devbox%23pi/t/${encodeURIComponent(THREAD)}`;

for (const [engine, type, path] of ENGINES) test(`session route ${engine}: a pasted link, ⌘K, the sidebar and a notification open one route with no new entry; a link-key link names no Host`, { skip: engineSkip(engine) }, async (t) => {
	const page = await open(t, engine, type, path());
	const before = await page.evaluate(() => location.hash);
	const row = page.locator(`.side .row[data-thread="${THREAD}"] a.title`).first();
	await row.waitFor();
	const title = await row.innerText();
	const start = await page.evaluate(() => history.length);
	// The reader's place is the top visible row and its offset. scrollTop is not: the first paint shows a short window,
	// and when the window grows, rows added above raise scrollTop while the reader's view stays where it was.
	const look = () => page.evaluate(() => {
		const el = document.querySelector<HTMLElement>("[data-region=transcript]");
		const top = el?.getBoundingClientRect().top ?? 0;
		const row = [...(el?.querySelectorAll<HTMLElement>("[data-entry]") ?? [])].find((r) => r.getBoundingClientRect().bottom > top + 1);
		return { hash: location.hash, entries: history.length, mounted: el?.dataset.probe === "kept", place: row && `${row.dataset.entry}@${Math.round(row.getBoundingClientRect().top - top)}` };
	});

	// A pasted link: the paste is the browser's own step.
	await page.evaluate((route) => { location.hash = route; }, ROUTE);
	await page.locator('[data-region="transcript"] [data-entry]').first().waitFor({ state: "attached" });
	await page.waitForTimeout(400);
	await page.evaluate(() => {
		const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
		el.dataset.probe = "kept";
		el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) / 2);
	});
	await page.waitForTimeout(300);
	const opened = await look();
	assert.deepEqual({ ...opened, place: undefined }, { hash: ROUTE, entries: start + 1, mounted: true, place: undefined });
	assert.ok(await page.evaluate(() => {
		const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
		return el.scrollTop > 0 && el.scrollTop < el.scrollHeight - el.clientHeight - 1;
	}), "the transcript scrolled away from both ends");
	assert.ok(opened.place, "a row is in view");
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
		["notification", () => page.evaluate((route) => (window as unknown as { ampiOpen(route: string): void }).ampiOpen(route), ROUTE)],
	];
	for (const [name, go] of paths) {
		await go();
		await page.waitForTimeout(400);
		assert.deepEqual(await look(), opened, `${name}: the same route, entry, view and place`);
	}

	await page.evaluate(() => history.back());
	await page.waitForFunction((before) => location.hash === before, before);
	assert.equal(await page.evaluate(() => history.length), start + 1, "Back left the Session in one step");

	await page.evaluate((old) => { location.hash = old; }, OLD);
	await page.locator("[data-session-unresolved]").filter({ hasText: "This Host is not listed: devbox#pi." }).waitFor();
	assert.equal(await page.evaluate(() => location.hash), OLD, "the link stays as typed");
	assert.equal(await page.locator('[data-region="transcript"]').count(), 0, "no Session view mounts");
});
