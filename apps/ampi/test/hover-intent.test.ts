import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { engineSkip } from "./engines.ts";
import { ENGINES, open } from "./resize-edges-fixture.ts";

// A hover card opens only on hover intent (hoverIntent, Popover.tsx). At 390 px, "Hide sidebar" slides the Session
// title under the pointer that pressed it. The browser fires enter and over events there; the card stays closed until
// the pointer moves. A list that scrolls under a still pointer likewise keeps the selection the keys gave it. Keyboard
// focus still opens the cards.
// The page loads within the fixture's timeout. A card has BUDGET ms to open or close after the action that triggers it.
const BUDGET = 4000;
const ready = async (p: Page) => {
	await p.locator('[aria-label="Thread title"]').waitFor();
	await p.locator("[data-user-mark]").first().waitFor({ state: "attached" });
};
const frames = (p: Page) => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 300)))));

for (const [engine, type, path] of ENGINES) for (const zoom of [1, 1.3]) {
	test(`hover intent ${engine} ${zoom * 100}%: a title that slides under a still pointer opens no card`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { display: { overall: zoom }, route: "#/h/devbox/t/pi%3Asess-big" });
		await ready(page);
		const closePanel = page.getByTitle("Close panel", { exact: true });
		if (await closePanel.isVisible()) await closePanel.click();
		await page.setViewportSize({ width: 390, height: 720 });
		const hide = page.getByRole("button", { name: "Hide sidebar", exact: true });
		const box = (await hide.boundingBox())!;
		const x = box.x + box.width / 2, y = box.y + box.height / 2;
		await page.mouse.click(x, y);
		await frames(page);
		const under = await page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x!, y!)?.closest(".session-title-line")), [x, y]);
		assert.ok(under, "the title slides under the pointer");
		assert.equal(await page.locator(".session-metadata").count(), 0, "a still pointer opens the title card");
		await page.mouse.move(x + 2, y);
		await page.locator(".session-metadata").waitFor({ timeout: BUDGET });
	});
}

for (const [engine, type, path] of ENGINES) {
	test(`hover intent ${engine}: a palette list that scrolls under a still pointer keeps the key selection`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-big" });
		await page.setViewportSize({ width: 1000, height: 500 });
		await ready(page);
		await page.keyboard.press("ControlOrMeta+k");
		const items = page.locator(".palette-item");
		await items.first().waitFor();
		await items.nth(1).hover();
		const on = () => items.evaluateAll((all) => all.findIndex((el) => el.classList.contains("on")));
		await page.waitForFunction(() => document.querySelectorAll(".palette-item")[1]?.classList.contains("on"), undefined, { timeout: BUDGET });
		await page.keyboard.press("ArrowDown");
		const list = await items.first().evaluate((el) => {
			let s = el.parentElement;
			while (s && s.scrollHeight <= s.clientHeight) s = s.parentElement;
			if (s) s.scrollTop += 3 * el.getBoundingClientRect().height;
			return Boolean(s);
		});
		assert.ok(list, "the palette list scrolls");
		await frames(page);
		assert.equal(await on(), 2, "the item under the still pointer took the selection");
	});
}

for (const [engine, type, path] of ENGINES) {
	test(`hover intent ${engine}: keyboard focus opens the title and model cards`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-big" });
		await page.setViewportSize({ width: 1000, height: 650 });
		await ready(page);
		for (const [name, target] of [["title", '[aria-label="Thread title"]'], ["model", ".model-hud-trigger"]] as const) {
			// Shift+Tab, then Tab: the target takes focus from the keyboard, so it matches :focus-visible.
			await page.locator(target).first().focus();
			await page.keyboard.press("Shift+Tab");
			await page.locator(".session-metadata").waitFor({ state: "detached", timeout: BUDGET });
			await page.keyboard.press("Tab");
			assert.ok(await page.locator(target).first().evaluate((el) => el.matches(":focus-visible")), `${name}: keyboard focus`);
			await page.locator(".session-metadata").waitFor({ timeout: BUDGET });
		}
	});
}

// Popover closes on a scroll that moves its owner. Only a scroller that holds the owner moves it: the header can shift
// the title after the card opens, and the transcript's next scroll then closed the card.
for (const [engine, type, path] of ENGINES) {
	test(`hover intent ${engine}: a scroll beside the card's owner keeps the card open`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-big" });
		await page.setViewportSize({ width: 1000, height: 650 });
		await ready(page);
		await frames(page);
		await page.locator('[aria-label="Thread title"]').focus();
		await page.locator(".session-metadata").waitFor({ timeout: BUDGET });
		const scrolled = await page.evaluate(() => {
			document.querySelector<HTMLElement>(".session-title")!.style.marginLeft = "8px";
			const owner = document.querySelector(".session-title")!;
			const scroller = [...document.querySelectorAll<HTMLElement>("[data-region] *")].find((el) => el.scrollHeight > el.clientHeight + 100 && !el.contains(owner) && getComputedStyle(el).overflowY !== "visible");
			if (scroller) scroller.scrollTop += 100;
			return Boolean(scroller);
		});
		assert.ok(scrolled, "a scroller beside the title");
		await frames(page);
		assert.equal(await page.locator(".session-metadata").count(), 1, "the card closed on a scroll that cannot move its owner");
	});
}
