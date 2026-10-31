import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { engineSkip } from "./engines.ts";
import { ENGINES, open } from "./resize-edges-fixture.ts";

// R11: a view change moves focus only when focus would drop to body. A layout change that removes or inerts the focused
// element is such a drop. Hide sidebar inerts its own button; the browser blurs it at its next focus fixup, before or
// after the App's mutation observer runs. In either order focus returns to the Session's last region.

const settle = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
const region = (page: Page) => page.evaluate(() => document.activeElement?.closest<HTMLElement>("[data-region]")?.dataset.region ?? document.activeElement?.tagName);

for (const [engine, type, path] of ENGINES) {
	test(`focus loss ${engine}: Hide sidebar (inert) and Show sidebar (removal) return focus to the transcript`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-long-title" });
		// No panel: a panel squeezes the sidebar away at 390 px once its data loads, so the sidebar would depend on timing.
		await page.evaluate(() => localStorage.removeItem("ampi.panel"));
		await page.setViewportSize({ width: 390, height: 900 });
		await page.reload();
		const composer = page.getByRole("textbox", { name: "Message the agent", exact: true });
		const hide = page.getByRole("button", { name: "Hide sidebar", exact: true });
		const show = page.getByRole("button", { name: "Show sidebar", exact: true });
		// At 390 px the sidebar is a drawer that starts closed (App.tsx oneSide); its hide still inerts the button. A
		// phone's close returns to the transcript, never the composer, whose focus raises the keyboard (focus.ts).
		const seen = [];
		for (let round = 0; round < 6; round++) {
			await composer.click();
			await show.click();
			await settle(page);
			await hide.click();
			// The restore lands after a timer, a React commit, a passive effect and a frame. Wait for the settled focus;
			// a lost focus stays on body or inside [inert], and the assertion reports it.
			await page
				.waitForFunction(() => document.activeElement !== document.body && !document.activeElement?.closest("[inert]"), undefined, { timeout: 3000 })
				.catch(() => {});
			seen.push(await region(page));
		}
		assert.deepEqual(seen, Array(6).fill("transcript"));
	});
}
