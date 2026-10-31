import "./bound.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Page } from "playwright";
import { engineSkip } from "./engines.ts";
import { ENGINES, open } from "./resize-edges-fixture.ts";

// One sidebar writer and one rule per layout (focus.ts View.oneSide, App.tsx applyView). On a phone the sidebar is a
// drawer: it starts closed on every load, is never saved, and one side shows at a time, whatever the input (☰, the
// sidebar's hide button, ⌘B, ⌘L, a panel link). Desktop keeps the saved choice and shows both sides.

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const ROUTE = "#/h/devbox/t/pi%3Asess-lead";

test("App has one sidebar writer: applyView.sidebar, and the drawer resets when the narrow rule ends", () => {
	const app = readFileSync(new URL("../web/src/App.tsx", import.meta.url), "utf8");
	const writes = app.split("\n").filter((line) => /\bset(SidebarHidden|SidebarPeek|Drawer)\(/.test(line)).map((line) => line.trim());
	assert.equal(writes.length, 2, `sidebar writers:\n${writes.join("\n")}`);
	assert.match(writes[0]!, /^const resize = .*if \(!overlay\) setDrawer\(false\); \};$/);
	assert.match(writes[1]!, /^sidebar: \(show\) =>/);
});

/** Which sides show, and the saved desktop choice. */
function sides(page: Page) {
	return page.evaluate(() => {
		const app = document.querySelector(".app")!;
		return { sidebar: !app.classList.contains("sidebar-hidden"), panel: app.classList.contains("has-panel"), saved: localStorage.getItem("ampi.sidebar.hidden") };
	});
}

/** The focused element's region, and whether it draws a focus ring. */
function ring(page: Page) {
	return page.evaluate(() => {
		const el = document.activeElement!, style = getComputedStyle(el);
		return { region: el.getAttribute("data-region"), ring: style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0 };
	});
}
const focusedRegion = (page: Page, region: string) => page.waitForFunction((region) => document.activeElement?.getAttribute("data-region") === region, region, { timeout: 2000 });

for (const [engine, type, path] of ENGINES) {
	test(`side drawer ${engine}: a phone starts closed, never saves the drawer, and shows one side at a time`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: ROUTE, context: PHONE });
		// The desktop choice says "shown"; a phone load still opens on the transcript.
		await page.evaluate(() => localStorage.setItem("ampi.sidebar.hidden", "0"));
		await page.reload();
		await page.locator(".transcript [data-entry]").first().waitFor({ state: "attached" });
		assert.deepEqual(await sides(page), { sidebar: false, panel: false, saved: "0" });
		await page.evaluate(() => localStorage.setItem("ampi.sidebar.hidden", "1"));
		await page.reload();
		await page.locator(".transcript [data-entry]").first().waitFor({ state: "attached" });
		await page.getByRole("button", { name: "Show sidebar" }).click();
		assert.deepEqual(await sides(page), { sidebar: true, panel: false, saved: "1" }, "☰ opens the drawer and writes nothing");
		await page.keyboard.press("Meta+KeyL");
		assert.deepEqual(await sides(page), { sidebar: false, panel: true, saved: "1" }, "⌘L opens the panel and closes the drawer");
		// The open panel drawer covers the whole page, ☰ too (phone-layout.test.ts); ⌘B and a swipe still open the sidebar.
		const show = page.getByRole("button", { name: "Show sidebar" });
		const box = (await show.boundingBox())!;
		assert.equal(await page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest(".panel-slot")), [box.x + box.width / 2, box.y + box.height / 2]), true, "the panel drawer covers ☰");
		await page.keyboard.press("Meta+KeyB");
		assert.deepEqual(await sides(page), { sidebar: true, panel: false, saved: "1" }, "⌘B opens the drawer and closes the panel");
		await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
		assert.deepEqual(await sides(page), { sidebar: false, panel: false, saved: "1" }, "the sidebar's hide button closes the drawer");
		// ☰ moves focus into the drawer. A row that navigates closes it, also the open Session's row; a fold keeps it.
		// The owner was in the composer: a close must not return there, or the keyboard rises.
		await page.getByRole("textbox", { name: "Message the agent" }).click();
		await show.click();
		// The focus request resolves after the drawer renders.
		const inDrawer = await page.waitForFunction(() => Boolean(document.activeElement?.closest('[data-region="sidebar"]')), undefined, { timeout: 2000 }).then(() => true, () => false);
		assert.equal(inDrawer, true, `☰ moves focus into the drawer; focus is on ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120))}`);
		assert.equal(await page.evaluate(() => Boolean(document.activeElement?.matches("input, textarea, select, [contenteditable]"))), false, "☰ puts focus on no field, so no keyboard opens");
		await page.locator(".sidebar-slot .team-fold").first().click();
		assert.equal((await sides(page)).sidebar, true, "a fold keeps the drawer open");
		await page.locator('.sidebar-slot [data-thread="pi:sess-lead"] a.title').click();
		assert.equal((await sides(page)).sidebar, false, "a Session row closes the drawer");
		await page.waitForFunction(() => document.activeElement?.closest("[data-region]")?.getAttribute("data-region") === "transcript", undefined, { timeout: 2000 }).catch(() => {});
		assert.equal(await page.evaluate(() => Boolean(document.activeElement?.matches("input, textarea, select, [contenteditable]"))), false, "a row tap puts focus on no field");
		await show.click();
		await page.locator('.sidebar-slot [data-thread="pi:sess-solo"] a.title').click();
		await page.waitForFunction(() => location.hash.includes("sess-solo"));
		assert.equal((await sides(page)).sidebar, false, "another Session's row closes the drawer");
		await page.evaluate(() => { location.hash = "#/h/devbox/t/pi%3Asess-lead"; });
		await page.locator('[data-region="transcript"]').waitFor();
		// A rotation to a wide layout and back starts the drawer closed.
		await show.click();
		await page.setViewportSize({ width: 900, height: 390 });
		await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--side-overlay").trim() === "" && document.querySelector(".app")!.classList.contains("sidebar-hidden"));
		await page.setViewportSize({ width: 390, height: 844 });
		await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--side-overlay").trim() === "1");
		assert.equal((await sides(page)).sidebar, false, "a rotation round trip leaves the drawer closed");
		// A panel link while the drawer is open: the panel shows, the drawer closes.
		await page.getByRole("button", { name: "Show sidebar" }).click();
		await page.evaluate(() => { location.hash = "#/h/devbox/t/pi%3Asess-lead?p=arc"; });
		await page.waitForFunction(() => document.querySelector(".app")!.classList.contains("has-panel"));
		assert.deepEqual(await sides(page), { sidebar: false, panel: true, saved: "1" }, "a panel link closes the drawer");
		// Across the narrow rule nothing is written; desktop shows its saved choice again.
		await page.setViewportSize({ width: 1280, height: 844 });
		await page.waitForFunction(() => document.querySelector(".app")!.classList.contains("sidebar-hidden"));
		assert.deepEqual(await sides(page), { sidebar: false, panel: true, saved: "1" });
		await page.getByRole("button", { name: "Show sidebar" }).click();
		await page.setViewportSize({ width: 390, height: 844 });
		await page.reload();
		await page.locator(".transcript [data-entry]").first().waitFor({ state: "attached" });
		assert.equal((await sides(page)).sidebar, false, "a phone reload opens on the transcript");
	});

	test(`side drawer ${engine}: desktop keeps the saved choice and shows both sides`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: `${ROUTE}?p=arc` });
		assert.deepEqual(await sides(page), { sidebar: true, panel: true, saved: "0" });
		await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
		assert.deepEqual(await sides(page), { sidebar: false, panel: true, saved: "1" });
		await page.getByRole("button", { name: "Show sidebar" }).click();
		assert.deepEqual(await sides(page), { sidebar: true, panel: true, saved: "0" }, "☰ keeps the panel on a desktop");
		await page.keyboard.press("Meta+KeyB");
		await page.keyboard.press("Meta+KeyB");
		assert.equal((await sides(page)).panel, true, "⌘B never closes the panel on a desktop");
	});
	test(`side drawer ${engine}: a region focused by a script or a touch draws no ring; a keyboard move draws one`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: ROUTE, context: PHONE });
		// No input yet: a script moves focus to the transcript, as a Session open or a drawer close does.
		await page.locator('[data-region="transcript"]').evaluate((el: HTMLElement) => el.focus());
		assert.deepEqual(await ring(page), { region: "transcript", ring: false }, "a script's move on a fresh phone page");
		// A tap on a drawer row opens that Session, closes the drawer, and moves focus to the transcript.
		await page.getByRole("button", { name: "Show sidebar" }).tap();
		await page.locator('.sidebar-slot [data-thread="pi:sess-solo"] a.title').tap();
		await focusedRegion(page, "transcript");
		assert.deepEqual(await ring(page), { region: "transcript", ring: false }, "a row tap");
		// A desktop keyboard move into the transcript keeps its ring.
		const desktop = await open(t, engine, type, path(), { route: ROUTE });
		await desktop.getByRole("textbox", { name: "Message the agent" }).click();
		await desktop.keyboard.press("Meta+KeyI");
		await focusedRegion(desktop, "transcript");
		assert.deepEqual(await ring(desktop), { region: "transcript", ring: true }, "⌘I from the composer");
	});
}
