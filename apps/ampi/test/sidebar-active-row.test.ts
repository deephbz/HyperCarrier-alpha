import "./bound.ts";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Page } from "playwright";
import { ENGINES, fixtureSessions, open as openFixture, waitForProgress } from "./resize-edges-fixture.ts";
import { engineSkip } from "./engines.ts";

// Ninety-six stress rows place the target several sidebar viewports below the fold; the test checks that geometry.
const SIDEBAR_STRESS_SESSIONS = 96;
const SIDEBAR_TARGET_ROW = 90;
const visible = (page: Page) => page.evaluate(() => {
	const row = document.querySelector<HTMLElement>(".side-scroll .row.active[data-thread]");
	const list = document.querySelector<HTMLElement>(".side-scroll")!;
	if (!row) return false;
	const a = row.getBoundingClientRect(), b = list.getBoundingClientRect();
	return a.top >= b.top && a.bottom <= b.bottom;
});
const frame = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const waitForRows = (page: Page) => waitForProgress(
	() => page.locator('.side-scroll [data-group="unplaced"] .row[data-thread]').count(),
	(rows) => String(rows ?? "unavailable"),
	(rows): rows is number => rows !== undefined && rows >= SIDEBAR_STRESS_SESSIONS,
);
const assertThreeViewportsBelow = async (row: ReturnType<Page["locator"]>) => {
	const geometry = await row.evaluate((node) => {
		const bounds = node.getBoundingClientRect(), list = node.closest<HTMLElement>(".side-scroll")!.getBoundingClientRect();
		return { offset: bounds.top - list.bottom, viewport: list.height };
	});
	assert.ok(geometry.offset >= 3 * geometry.viewport, `target starts at least three viewports below the fold: ${geometry.offset}px / ${geometry.viewport}px`);
};
const waitForActiveRow = (page: Page) => waitForProgress(
	() => page.evaluate(() => document.querySelector<HTMLElement>(".side-scroll .row.active[data-thread]")?.dataset.thread),
	(id) => id ?? "no active row",
	(id): id is string => !!id,
);
// This fixture does not inspect Arc. Skip its unrelated 1,200-entry Build, which competes with Session indexing.
const open = (t: Parameters<typeof openFixture>[0], engine: string, type: Parameters<typeof openFixture>[2], path: string | undefined, options: NonNullable<Parameters<typeof openFixture>[4]> = {}) => openFixture(t, engine, type, path, { ...options, seedArcs: false });
function source(dir: string, id: string): string | undefined {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) { const found = source(path, id); if (found) return found; }
		else if (entry.name.endsWith(".jsonl") && JSON.parse(readFileSync(path, "utf8").split("\n")[0]!).id === id) return path;
	}
}

for (const [engine, type, path] of ENGINES) {
	test(`sidebar active row ${engine}: a cold deep link reveals a target below three viewports through its default folds`, { skip: engineSkip(engine), timeout: 170_000 }, async (t) => {
		const page = await open(t, engine, type, path(), { fixture: "huge", stressSessions: SIDEBAR_STRESS_SESSIONS, route: "#/h/devbox/t/pi%3Asess-lead" });
		const group = page.locator('[data-group="unplaced"] > button.group-row');
		assert.equal(await group.getAttribute("aria-expanded"), "false", "the target group starts collapsed");
		await group.click();
		await waitForRows(page);
		const targetRow = page.locator('.side-scroll [data-group="unplaced"] .row[data-thread]').nth(SIDEBAR_TARGET_ROW);
		await assertThreeViewportsBelow(targetRow);
		const target = await targetRow.locator("a.title").getAttribute("href");
		assert.ok(target);
		// A cold page starts with Not in a pane folded. A saved Host fold must also yield to explicit navigation.
		const host = page.getByRole("button", { name: "devbox connected", exact: true });
		await host.click();
		assert.equal(await host.getAttribute("aria-expanded"), "false", "the saved Host fold hides the target before navigation");
		await page.goto(new URL(target, page.url()).href);
		await page.reload();
		await waitForActiveRow(page);
		await frame(page);
		assert.equal(await visible(page), true, "the deep link reveals and centers its active row");
	});

	test(`sidebar active row ${engine}: Alt+Down reveals the clipped next row; updates preserve the owner's scroll and other folds`, { skip: engineSkip(engine), timeout: 170_000 }, async (t) => {
		const page = await open(t, engine, type, path(), { fixture: "huge", stressSessions: SIDEBAR_STRESS_SESSIONS, route: "#/h/devbox/t/pi%3Asess-lead" });
		await page.locator('[data-group="unplaced"] > button.group-row').click();
		await waitForRows(page);
		const other = page.locator('.side-scroll [data-group]:not([data-group="unplaced"]) > button.group-row').first();
		await other.click();
		assert.equal(await other.getAttribute("aria-expanded"), "false");
		const target = await page.locator('.side-scroll [data-group="unplaced"] .row[data-thread] a.title').nth(SIDEBAR_TARGET_ROW).getAttribute("href");
		await page.goto(new URL(target!, page.url()).href);
		await waitForActiveRow(page);
		const unrelated = other;
		const before = await page.locator('.side-scroll .row.active[data-thread]').getAttribute("data-thread");
		// Put the current row at the bottom edge so the next row begins outside the view.
		await page.locator(".side-scroll").evaluate((list) => { const row = list.querySelector<HTMLElement>(".row.active[data-thread]")!; const a = row.getBoundingClientRect(), b = list.getBoundingClientRect(); list.scrollTop += a.bottom - b.bottom; });
		const nextRow = page.locator('.side-scroll [data-group="unplaced"] .row[data-thread]').nth(SIDEBAR_TARGET_ROW + 1);
		const clipped = await nextRow.evaluate((row) => row.getBoundingClientRect().top >= row.closest<HTMLElement>(".side-scroll")!.getBoundingClientRect().bottom);
		assert.equal(clipped, true, "the next row starts clipped below the sidebar viewport");
		await page.keyboard.press("Alt+ArrowDown");
		await page.waitForFunction((before) => document.querySelector(".side-scroll .row.active[data-thread]")?.getAttribute("data-thread") !== before, before);
		await frame(page);
		const revealed = await visible(page);
		assert.equal(await unrelated.getAttribute("aria-expanded"), "false", "the unrelated fold stays closed");
		const id = (await page.locator('.side-scroll .row.active[data-thread]').getAttribute("data-thread"))!.replace(/^pi:/, "");
		const file = source(await fixtureSessions("huge", "huge", false, SIDEBAR_STRESS_SESSIONS), id)!;
		assert.ok(file);
		await page.locator(".side-scroll").evaluate((list) => { list.scrollTop = 0; });
		await frame(page);
		const scroll = await page.locator(".side-scroll").evaluate((list) => list.scrollTop);
		const last = JSON.parse(readFileSync(file, "utf8").trimEnd().split("\n").at(-1)!);
		const name = `Updated synthetic title ${engine}`;
		appendFileSync(file, JSON.stringify({ type: "session_info", id: `title-${engine}`, parentId: last.id, timestamp: new Date().toISOString(), name }) + "\n");
		await page.waitForFunction((name) => document.querySelector(".side-scroll .row.active .title")?.textContent === name, name);
		await frame(page);
		assert.equal(await page.locator(".side-scroll").evaluate((list) => list.scrollTop), scroll, "a list update never recenters the active row");
		assert.equal(await unrelated.getAttribute("aria-expanded"), "false");
		assert.equal(revealed, true, "Alt+Down reveals the newly opened row");
	});

	test(`sidebar active row ${engine}: navigation does not save its temporary Team unfold`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { fixture: "huge", stressSessions: SIDEBAR_STRESS_SESSIONS, route: "#/h/devbox/t/pi%3Asess-lead" });
		const toggle = page.locator('.side-scroll [data-collapse-toggle]').first();
		const team = (await toggle.getAttribute("data-collapse-toggle"))!;
		await toggle.click();
		const child = page.locator(`.side-scroll .row.child[data-parent-leader="${team}"] a.title`).first();
		const target = (await child.getAttribute("href"))!;
		await toggle.click();
		assert.equal(await toggle.getAttribute("aria-expanded"), "false");
		await page.goto(new URL(target, page.url()).href);
		await page.locator('.side-scroll .row.child.active').waitFor();
		await page.goto(new URL("#/h/devbox/t/pi%3Asess-lead", page.url()).href);
		await page.reload();
		await page.locator('.side-scroll [data-collapse-toggle]').first().waitFor();
		assert.equal(await page.locator(`[data-collapse-toggle="${team}"]`).getAttribute("aria-expanded"), "false", "reload restores the owner's saved Team fold");
	});

	test(`sidebar active row ${engine}: toggling another Team never saves a revealed Team`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { fixture: "demo", route: "#/h/devbox/t/pi%3Asess-lead" });
		const toggles = page.locator('.side-scroll [data-collapse-toggle]');
		const a = toggles.first(), b = toggles.nth(1);
		const teamA = (await a.getAttribute('data-collapse-toggle'))!;
		const teamB = (await b.getAttribute('data-collapse-toggle'))!;
		await a.click();
		const target = (await page.locator(`.side-scroll .row.child[data-parent-leader="${teamA}"] a.title`).first().getAttribute('href'))!;
		await a.click();
		await page.goto(new URL(target, page.url()).href);
		await page.locator('.side-scroll .row.child.active').waitFor();
		await b.click();
		await page.goto(new URL('#/h/devbox/t/pi%3Asess-lead', page.url()).href);
		await page.reload();
		const restoredA = page.locator(`[data-collapse-toggle="${teamA}"]`);
		await restoredA.waitFor();
		assert.equal(await restoredA.getAttribute('aria-expanded'), 'false', 'saving B must not persist the revealed A');
		assert.equal(await page.locator(`[data-collapse-toggle="${teamB}"]`).getAttribute('aria-expanded'), 'true', 'the manual B toggle still persists');
		await page.goto(new URL(target, page.url()).href);
		await page.locator('.side-scroll .row.child.active').waitFor();
		await restoredA.click();
		assert.equal(await restoredA.getAttribute('aria-expanded'), 'false', 'a manual close removes the temporary reveal');
		await page.goto(new URL('#/h/devbox/t/pi%3Asess-lead', page.url()).href);
		await page.getByRole('button', { name: 'Collapse all Teams for devbox', exact: true }).click();
		assert.equal(await page.locator('.side-scroll [data-collapse-toggle][aria-expanded="true"]').count(), 0);
		await page.getByRole('button', { name: 'Expand all Teams for devbox', exact: true }).click();
		await page.reload();
		await page.locator('.side-scroll [data-collapse-toggle]').first().waitFor();
		assert.equal(await page.locator('.side-scroll [data-collapse-toggle][aria-expanded="false"]').count(), 0, 'explicit expand-all persists across reload');
	});

	test(`sidebar active row ${engine}: clicking a clipped row reveals only its clipped edge`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { fixture: "huge", stressSessions: SIDEBAR_STRESS_SESSIONS, route: "#/h/devbox/t/pi%3Asess-lead" });
		await page.locator('[data-group="unplaced"] > button.group-row').click();
		await waitForRows(page);
		const row = page.locator('.side-scroll [data-group="unplaced"] .row[data-thread]').nth(SIDEBAR_TARGET_ROW);
		const before = await row.evaluate((row) => {
			const list = row.closest<HTMLElement>(".side-scroll")!;
			list.scrollTop += row.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom - 8;
			return list.scrollTop;
		});
		await frame(page);
		const box = (await row.boundingBox())!;
		const listBox = (await page.locator('.side-scroll').boundingBox())!;
		await page.mouse.click(box.x + 3, Math.min(box.y + 3, listBox.y + listBox.height - 2));
		await page.waitForFunction(() => document.querySelector('.side-scroll [data-group="unplaced"] .row.active'));
		await frame(page);
		const after = await page.locator('.side-scroll').evaluate((list) => list.scrollTop);
		assert.ok(after >= before && after - before <= 9, `only the clipped 8px moves: ${after - before}`);
		assert.equal(await visible(page), true, JSON.stringify(await row.evaluate((row) => ({ row: row.getBoundingClientRect().toJSON(), list: row.closest('.side-scroll')!.getBoundingClientRect().toJSON() }))));
	});

	test(`sidebar active row ${engine}: owner input cancels a pending reveal before its Session arrives`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { fixture: "huge", stressSessions: SIDEBAR_STRESS_SESSIONS, route: "#/h/devbox/t/pi%3Asess-lead" });
		const group = page.locator('[data-group="unplaced"] > button.group-row');
		assert.equal(await group.getAttribute("aria-expanded"), "false");
		const id = `sidebar-late-${engine}`;
		await page.goto(new URL(`#/h/devbox/t/pi%3A${id}`, page.url()).href);
		const list = page.locator(".side-scroll");
		const box = (await list.boundingBox())!;
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.wheel(0, 100);
		await frame(page);
		const timestamp = new Date().toISOString();
		writeFileSync(join(await fixtureSessions("huge", "huge", false, SIDEBAR_STRESS_SESSIONS), `${id}.jsonl`), [
			{ type: "session", version: 3, id, timestamp, cwd: "/work/synthetic" },
			{ type: "message", id: "late-user", parentId: null, timestamp, message: { role: "user", content: "A synthetic Session arrives after the owner scrolls." } },
		].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
		await page.locator('.transcript [data-entry="late-user"]').waitFor();
		await frame(page);
		assert.equal(await group.getAttribute("aria-expanded"), "false", "late data cannot reopen the group after owner input");
	});
}
