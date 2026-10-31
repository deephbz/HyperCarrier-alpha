import "./bound.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Page } from "playwright";
import { engineSkip } from "./engines.ts";
import { ENGINES, open } from "./resize-edges-fixture.ts";

// A sideways finger drag opens and closes a phone's drawers (docs/ux/swipe-drawers.md, drawer-swipe.ts). The browser
// here cannot build real TouchEvents, so each drag dispatches touch-shaped events with the same fields. They prove the
// state table, the exclusions and the settle rule; they do not prove touch-action, a browser's
// pointercancel, rubber banding, or Safari's edge swipes (the doc's device checks).

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const ROUTE = "#/h/devbox/t/pi%3Asess-lead";

type Drag = { steps?: number; ms?: number; holdMs?: number; end?: "touchend" | "touchcancel" | "none" };

/**
 * A one-finger drag from `from` to `to` on the element under `from`. Each event carries the drag's own clock as its
 * timeStamp: the hold, then one step every ms/steps. The swipe reads speed and the long press from timeStamp, so a
 * loaded machine that stretches the sleeps cannot turn a flick slow or a drag into a long press.
 */
async function drag(page: Page, from: [number, number], to: [number, number], options: Drag = {}) {
	await page.evaluate(async ({ from, to, steps = 10, ms = 200, holdMs = 0, end = "touchend" }) => {
		const target = document.elementFromPoint(from[0], from[1])!;
		const start = performance.now();
		const fire = (type: string, x: number, y: number, at: number) => {
			const touch = { identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y };
			const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
			const down = type === "touchstart" || type === "touchmove" ? [touch] : [];
			Object.defineProperties(event, { touches: { value: down }, targetTouches: { value: down }, changedTouches: { value: [touch] }, timeStamp: { value: start + at } });
			target.dispatchEvent(event);
		};
		const sleep = (wait: number) => new Promise((resolve) => setTimeout(resolve, wait));
		fire("touchstart", from[0], from[1], 0);
		if (holdMs) await sleep(holdMs);
		for (let i = 1; i <= steps; i++) {
			await sleep(ms / steps);
			fire("touchmove", from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps, holdMs + (ms * i) / steps);
		}
		if (end !== "none") fire(end, to[0], to[1], holdMs + ms);
	}, { from, to, ...options });
	// The settle ends, the committed view renders, and the drag's look goes.
	if (options.end !== "none") await page.waitForFunction(() => !document.querySelector(".app")!.classList.contains("drawer-drag"));
}

/** Which sides show, the saved choices, the route, and whether focus sits in an editable field. */
function state(page: Page) {
	return page.evaluate(() => {
		const app = document.querySelector(".app")!;
		const active = document.activeElement;
		return {
			sidebar: !app.classList.contains("sidebar-hidden"),
			panel: app.classList.contains("has-panel"),
			saved: localStorage.getItem("ampi.sidebar.hidden"),
			hash: location.hash,
			focus: active?.closest("[data-region]")?.getAttribute("data-region") ?? null,
			editable: Boolean(active?.matches("input, textarea, [contenteditable]")),
		};
	});
}

async function phone(t: Parameters<typeof open>[0], engine: string, type: Parameters<typeof open>[2], path: string | undefined, route = ROUTE) {
	const page = await open(t, engine, type, path, { route, context: PHONE });
	await page.locator(".transcript [data-entry]").first().waitFor({ state: "attached" });
	return page;
}

const MID: [number, number] = [195, 420];

/** The focus request resolves once the opened drawer renders. */
async function focusIn(page: Page, region: string) {
	await page.waitForFunction((region) => document.activeElement?.closest("[data-region]")?.getAttribute("data-region") === region, region, { timeout: 2000 }).catch(() => {});
}

// The reveal contract (a sideways drag keeps a pending reveal; a vertical drag ends it): touch-axis.test.ts proves the
// lock, and both reader inputs act only on a vertical drag.
test("the reader's touch inputs act only on a vertical drag", () => {
	const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
	assert.match(source("../web/src/keep-place.ts"), /const touch = \(\) => \{ if \(touchAxis\(\) === "y"\) input\(/);
	assert.match(source("../web/src/components/ThreadView.tsx"), /onTouchMoveCapture=\{\(event\) => \{ if \(touchAxis\(\) === "y" && [^}]*readerMoved\(\)/);
});

for (const [engine, type, path] of ENGINES) {
	test(`drawer swipe ${engine}: each state's swipes follow the table and commit through the view's commands`, { skip: engineSkip(engine) }, async (t) => {
		const page = await phone(t, engine, type, path());
		const before = await state(page);
		assert.deepEqual([before.sidebar, before.panel], [false, false]);
		await drag(page, [60, 420], [340, 420]);
		await focusIn(page, "sidebar");
		let now = await state(page);
		assert.deepEqual([now.sidebar, now.panel, now.focus, now.editable], [true, false, "sidebar", false], "nothing → right: the sidebar opens and takes focus");
		assert.deepEqual([now.saved, now.hash], [before.saved, before.hash], "a phone drawer writes no saved choice and no route");
		await drag(page, [200, 420], [380, 420]);
		assert.deepEqual([(await state(page)).sidebar, (await state(page)).panel], [true, false], "sidebar → right: nothing");
		await drag(page, [300, 420], [20, 420]);
		assert.deepEqual([(await state(page)).sidebar, (await state(page)).panel], [false, false], "sidebar → left: it closes");
		// The owner was in the composer: a close must not return there, or the keyboard rises.
		await page.getByRole("textbox", { name: "Message the agent" }).focus();
		await drag(page, [60, 420], [340, 420]);
		await focusIn(page, "sidebar");
		await drag(page, [300, 420], [20, 420]);
		await focusIn(page, "transcript");
		now = await state(page);
		assert.deepEqual([now.sidebar, now.panel, now.focus, now.editable], [false, false, "transcript", false], "after a draft, the close returns focus to the transcript, not the composer");
		await drag(page, [330, 420], [40, 420]);
		await focusIn(page, "panel");
		now = await state(page);
		assert.deepEqual([now.sidebar, now.panel, now.focus], [false, true, "panel"], "nothing → left: the default panel opens and takes focus");
		await drag(page, [100, 420], [10, 420]);
		assert.deepEqual([(await state(page)).sidebar, (await state(page)).panel], [false, true], "panel → left: nothing");
		await drag(page, [60, 420], [380, 420]);
		assert.deepEqual([(await state(page)).sidebar, (await state(page)).panel], [false, false], "panel → right: it closes");
	});

	test(`drawer swipe ${engine}: a drag that is no sideways swipe opens nothing`, { skip: engineSkip(engine) }, async (t) => {
		const page = await phone(t, engine, type, path());
		await drag(page, MID, [205, 120]);
		assert.equal((await state(page)).sidebar, false, "a vertical drag scrolls");
		await drag(page, [60, 420], [340, 420], { holdMs: 500 });
		assert.equal((await state(page)).sidebar, false, "a long press keeps native selection");
		await drag(page, [60, 420], [200, 420], { end: "touchcancel" });
		assert.deepEqual([(await state(page)).sidebar, await page.evaluate(() => document.querySelector(".app")!.getAttribute("style")?.includes("--drawer"))], [false, false], "a cancel restores the view and leaves no drag look");
		// A wide block scrolls sideways, also at its end. Fixed in place, so the transcript's own scroll cannot move it.
		await page.evaluate(() => {
			const block = document.createElement("div");
			block.id = "wide";
			block.style.cssText = "position:fixed;left:0;top:300px;z-index:10;overflow-x:auto;width:300px;height:60px";
			block.innerHTML = '<div style="width:1200px;height:60px"></div>';
			document.querySelector(".transcript")!.append(block);
		});
		const box = (await page.locator("#wide").boundingBox())!;
		const y = box.y + box.height / 2;
		await drag(page, [box.x + 20, y], [box.x + 280, y]);
		assert.equal((await state(page)).sidebar, false, "a drag in a wide block scrolls it");
		await page.evaluate(() => { const block = document.getElementById("wide")!; block.scrollLeft = 0; });
		await drag(page, [box.x + 20, y], [box.x + 280, y]);
		assert.equal((await state(page)).sidebar, false, "a drag at the block's start edge never hands over to a drawer");
		await page.locator("#wide").evaluate((block) => block.remove());
		// The composer keeps its caret drags.
		const field = (await page.getByRole("textbox", { name: "Message the agent" }).boundingBox())!;
		await drag(page, [field.x + 10, field.y + field.height / 2], [field.x + 250, field.y + field.height / 2]);
		assert.equal((await state(page)).sidebar, false, "a drag in the composer opens nothing");
	});

	test(`drawer swipe ${engine}: release settles by speed, then by position`, { skip: engineSkip(engine) }, async (t) => {
		const page = await phone(t, engine, type, path());
		await drag(page, [60, 420], [130, 420], { steps: 4, ms: 400 });
		assert.equal((await state(page)).sidebar, false, "a slow short drag settles back");
		await drag(page, [60, 420], [130, 420], { steps: 4, ms: 60 });
		assert.equal((await state(page)).sidebar, true, "a flick opens");
		await drag(page, [300, 420], [100, 420], { steps: 10, ms: 400 });
		assert.equal((await state(page)).sidebar, false, "a slow drag past half closes");
		await page.emulateMedia({ reducedMotion: "reduce" });
		await drag(page, [60, 420], [340, 420]);
		assert.equal((await state(page)).sidebar, true, "with reduced motion the drawer snaps and still opens");
	});

	test(`drawer swipe ${engine}: the sheet a panel-opening drag pulls in covers the Session header`, { skip: engineSkip(engine) }, async (t) => {
		const page = await phone(t, engine, type, path());
		// The sticky prompt header shows only past a prompt; its layer is what matters, so the test shows it in place.
		await page.locator(".prompt-head").evaluate((head: HTMLElement) => { head.style.visibility = "visible"; });
		await drag(page, [340, 420], [100, 420], { end: "none" });
		await page.locator(".app[data-drawer-opening=\"true\"] .drawer-sheet").waitFor();
		// The sheet is inert, and an inert element takes no hit test; the probe lifts that for its own synchronous run.
		const above = await page.evaluate(() => {
			const node = document.querySelector(".drawer-sheet")!;
			const sheet = node.getBoundingClientRect();
			node.removeAttribute("inert");
			const hits = [".main .topbar", ".prompt-head"].map((selector) => {
				const r = document.querySelector(selector)!.getBoundingClientRect();
				const x = Math.max(r.left, sheet.left) + 20, y = (r.top + r.bottom) / 2;
				return `${selector}: ${Boolean(document.elementFromPoint(x, y)?.closest(".drawer-sheet"))}`;
			});
			node.setAttribute("inert", "");
			return hits;
		});
		await page.evaluate(() => { const event = new Event("touchend", { bubbles: true }); Object.defineProperties(event, { touches: { value: [] }, changedTouches: { value: [] } }); document.querySelector(".app")!.dispatchEvent(event); });
		await page.waitForFunction(() => !document.querySelector(".app")!.classList.contains("drawer-drag"));
		assert.deepEqual(above, [".main .topbar: true", ".prompt-head: true"], "the drag sheet is the top layer");
	});

	test(`drawer swipe ${engine}: a page blocks touch scrolls only during a drag that can become a swipe`, { skip: engineSkip(engine) }, async (t) => {
		const page = await phone(t, engine, type, path());
		// Count the window's blocking touchmove listeners from the page's first script on.
		await page.addInitScript(() => {
			const blocking = new Set<unknown>();
			(window as { blocking?: Set<unknown> }).blocking = blocking;
			const add = window.addEventListener.bind(window);
			const remove = window.removeEventListener.bind(window);
			window.addEventListener = ((type: string, listener: unknown, options?: boolean | AddEventListenerOptions) => {
				if (type === "touchmove" && !(typeof options === "object" && options.passive)) blocking.add(listener);
				return add(type, listener as EventListener, options);
			}) as typeof window.addEventListener;
			window.removeEventListener = ((type: string, listener: unknown, options?: boolean | EventListenerOptions) => {
				if (type === "touchmove") blocking.delete(listener);
				return remove(type, listener as EventListener, options);
			}) as typeof window.removeEventListener;
		});
		await page.reload();
		await page.locator(".transcript [data-entry]").first().waitFor({ state: "attached" });
		const blocking = () => page.evaluate(() => (window as { blocking?: Set<unknown> }).blocking!.size);
		assert.equal(await blocking(), 0, "no touch: no blocking listener");
		await drag(page, MID, [205, 120]);
		assert.equal(await blocking(), 0, "a vertical drag unbinds it");
		await drag(page, [60, 420], [340, 420], { end: "none" });
		assert.equal(await blocking(), 1, "a swipe holds it until the finger lifts");
		await page.evaluate(() => { const event = new Event("touchend", { bubbles: true }); Object.defineProperties(event, { touches: { value: [] }, changedTouches: { value: [] } }); document.querySelector(".app")!.dispatchEvent(event); });
		await page.waitForFunction(() => !document.querySelector(".app")!.classList.contains("drawer-drag"));
		assert.equal(await blocking(), 0, "the swipe's end unbinds it");
	});

	test(`drawer swipe ${engine}: a desktop keeps its drags`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: ROUTE });
		await page.locator(".transcript [data-entry]").first().waitFor({ state: "attached" });
		const before = await state(page);
		await page.mouse.move(400, 420);
		await page.mouse.down();
		await page.mouse.move(900, 420, { steps: 10 });
		await page.mouse.up();
		await drag(page, [400, 420], [900, 420]);
		const after = await state(page);
		assert.deepEqual([after.sidebar, after.panel, after.saved], [before.sidebar, before.panel, before.saved]);
	});
}
