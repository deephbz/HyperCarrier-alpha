import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator, Page } from "playwright";
import { engineSkip } from "./engines.ts";
import { ENGINES, open, sidesSettled } from "./resize-edges-fixture.ts";

// An action menu takes the keyboard (Popover `menu`). Its portal follows the page's other controls, so without it Tab
// left an open More for "Read an earlier page" in the transcript. Focus moves into the menu, Tab, Shift+Tab and the
// arrow keys stay among its items, and Escape or a chosen item returns focus to the control that opened it.
const focused = (page: Page) => page.evaluate(() => {
	const el = document.activeElement as HTMLElement;
	return { text: el.textContent?.trim().slice(0, 40) ?? "", label: el.getAttribute("aria-label"), menu: Boolean(el.closest(".t-more-menu")) };
});

/** Walks the open menu with every navigation key; focus never leaves it, and Tab past the last item returns to the first. */
async function staysInside(page: Page, menu: Locator) {
	const items = await menu.locator("button:not(:disabled), a[href], [role=menuitem]").count();
	assert.ok(items > 0, "the menu has items");
	const first = await focused(page);
	assert.ok(first.menu, `the menu takes focus on open: ${JSON.stringify(first)}`);
	const keys = [...Array(items).fill("Tab"), ...Array(items).fill("Shift+Tab"), "ArrowDown", "ArrowUp", "End", "Home"];
	for (const key of keys) {
		await page.keyboard.press(key);
		const now = await focused(page);
		assert.ok(now.menu, `${key} keeps focus in the menu: ${JSON.stringify(now)}`);
	}
	assert.deepEqual(await focused(page), first, "Home returns to the first item");
	for (let i = 0; i < items; i++) await page.keyboard.press("Tab");
	assert.deepEqual(await focused(page), first, "Tab past the last item returns to the first");
}

for (const [engine, type, path] of ENGINES) {
	test(`menu keyboard ${engine}: the folded More takes the keyboard and gives it back`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { display: { overall: 1.3 }, route: "#/h/devbox/t/pi%3Asess-big" });
		await page.locator('[aria-label="Thread title"]').waitFor();
		const closePanel = page.getByTitle("Close panel", { exact: true });
		if (await closePanel.isVisible()) await closePanel.click();
		await page.setViewportSize({ width: 390, height: 720 });
		await sidesSettled(page);
		const hide = page.getByRole("button", { name: "Hide sidebar", exact: true });
		if (await hide.isVisible()) await hide.click();
		const more = page.getByLabel("More actions", { exact: true });
		const menu = page.locator(".t-more-menu");
		const onMore = () => more.evaluate((el) => el === document.activeElement);

		await more.focus();
		await page.keyboard.press("Enter");
		await menu.waitFor();
		assert.match(await menu.innerText(), /Chat/, "the header actions fold into More");
		await staysInside(page, menu);
		await page.keyboard.press("Escape");
		await menu.waitFor({ state: "detached" });
		assert.equal(await onMore(), true, "Escape returns focus to More");

		const choose = async (key: string) => {
			await page.keyboard.press("Enter");
			await menu.waitFor();
			await page.keyboard.press(key);
			await page.keyboard.press("Enter");
			await menu.waitFor({ state: "detached" });
		};
		await choose("Home");
		assert.equal(await onMore(), true, `a chosen item returns focus to More: ${JSON.stringify(await focused(page))}`);
		// The last item, "Close pane…", opens a dialog; the dialog keeps the focus it took.
		await choose("End");
		assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest("[role=dialog]"))), true, `the dialog keeps focus: ${JSON.stringify(await focused(page))}`);
	});

	test(`menu keyboard ${engine}: the row menu takes the keyboard and gives it back to its row`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-big" });
		const link = page.locator('.side .row a.title[aria-current="page"]').first();
		await link.focus();
		// The menu key and Shift+F10 fire contextmenu at 0,0 on the focused row.
		await link.evaluate((el) => el.closest(".row")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 0, clientY: 0 })));
		const menu = page.locator(".row-menu");
		await menu.waitFor();
		await staysInside(page, menu);
		await page.keyboard.press("Escape");
		await menu.waitFor({ state: "detached" });
		assert.equal(await link.evaluate((el) => el === document.activeElement), true, `Escape returns focus to the row: ${JSON.stringify(await focused(page))}`);
	});

	// A hover card is no action menu: it opens on focus and leaves the keyboard where it is.
	test(`menu keyboard ${engine}: a hover card leaves focus on its trigger`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-big" });
		const title = page.locator('[aria-label="Thread title"]');
		await title.focus();
		await page.locator(".session-metadata").waitFor();
		assert.equal(await title.evaluate((el) => el === document.activeElement), true, "the card leaves focus on the title");
	});
}
