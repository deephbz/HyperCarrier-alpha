import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { ENGINES, anchor, frames, gap, grown, offsetOf, open, scrollAway, scrollTop, streaming, view } from "./thread-scroll-fixture.ts";
import { engineSkip } from "./engines.ts";

// Display zoom (owner: overall 130 %): rects are screen px and scrollTop is the transcript's CSS px. A restore that adds a
// rect delta to scrollTop overshoots by the zoom, so the read place drifts with every arrival. Offsets here are in CSS px.

/** Registers each engine's scroll-hold cases at display zoom `zoom`. */
export const zoomCases = (zoom: number) => {
	for (const engine of ENGINES) {
		const css = async (page: Page, id: string) => { const at = await offsetOf(page, id); return at === null ? null : at / zoom; };
		test(`scroll hold (${engine}, zoom ${zoom}): entries arriving and a growing last entry keep a reader's entry within 1 px`, { skip: engineSkip(engine) }, async (t) => {
			const { page, publish } = await open(t, 200, "pi", engine, zoom);
			await scrollAway(page);
			assert.ok(await gap(page) > 1000, "the reader is away from the newest end");
			const before = await anchor(page);
			const read = before.offset / zoom;
			for (const [n, tail] of [[201, ""], [203, ""], [210, ""], [210, "Streaming"], [210, `Streaming ${"more words ".repeat(400)}`]] as const) {
				await publish(n, tail);
				const at = await css(page, before.id);
				assert.ok(at !== null && Math.abs(at - read) <= 1, `after ${n} entries${tail ? " and a stream" : ""}, ${before.id} moved from ${read.toFixed(1)} to ${at?.toFixed(1)}`);
			}
		});
		test(`scroll hold (${engine}, zoom ${zoom}): a reader away stays within 1 px while a reply streams`, { skip: engineSkip(engine) }, async (t) => {
			const { page, send } = await open(t, 200, "pi", engine, zoom);
			await scrollAway(page);
			const before = await anchor(page);
			const read = before.offset / zoom;
			for (let lines = 1; lines <= 30; lines += 3) {
				send(streaming(200, lines));
				await page.waitForTimeout(30);
				await frames(page);
				const at = await css(page, before.id);
				assert.ok(at !== null && Math.abs(at - read) <= 1, `after ${lines} streamed lines the read entry moved from ${read.toFixed(1)} to ${at?.toFixed(1)}`);
			}
			assert.ok(await gap(page) > 60, "the reader stays away from the end");
		});
		test(`scroll hold (${engine}, zoom ${zoom}): k while one entry streams; the read line does not drift over ten arrivals`, { skip: engineSkip(engine) }, async (t) => {
			const { page, send } = await open(t, 201, "pi", engine, zoom);
			const grow = async (lines: number) => {
				send(view(201, grown(lines)));
				await page.waitForTimeout(16);
				await frames(page);
			};
			for (let lines = 1; lines <= 30; lines++) await grow(lines);
			assert.ok(await gap(page) <= 60, `the end follows the stream; gap ${await gap(page)}`);
			await page.locator("[data-region=transcript]").focus();
			await page.keyboard.press("k");
			for (let i = 0; i < 20; i++) await frames(page);
			assert.ok(await gap(page) > 60, `k leaves the end band; gap ${await gap(page)}`);
			const before = await anchor(page);
			const read = before.offset / zoom;
			for (let lines = 31; lines <= 40; lines++) {
				await grow(lines);
				const at = await css(page, before.id);
				assert.ok(at !== null && Math.abs(at - read) <= 1, `after ${lines - 30} arrivals the read entry moved from ${read.toFixed(1)} to ${at?.toFixed(1)}`);
			}
		});
		test(`scroll hold (${engine}, zoom ${zoom}): window growth above and ten arrivals that drop rows above keep the read entry within 1 px`, { skip: engineSkip(engine) }, async (t) => {
			const { page, publish } = await open(t, 200, "pi", engine, zoom);
			// The reader scrolls to the top of the paint window; the window grows upward and keeps the read entry.
			const top = await page.evaluate(() => {
				const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
				el.scrollTop = 0;
				const top = el.getBoundingClientRect().top;
				const node = [...el.querySelectorAll<HTMLElement>("[data-entry]")].find((n) => n.getBoundingClientRect().bottom > top + 40)!;
				return { id: node.dataset.entry!, offset: node.getBoundingClientRect().top - top };
			});
			await page.waitForFunction(() => document.querySelectorAll("[data-region=transcript] [data-entry]").length === 200);
			await frames(page);
			const grown = await css(page, top.id);
			assert.ok(grown !== null && Math.abs(grown - top.offset / zoom) <= 1, `the growth above moved ${top.id} from ${(top.offset / zoom).toFixed(1)} to ${grown?.toFixed(1)}`);
			await page.evaluate(() => {
				const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
				const node = el.querySelector<HTMLElement>("[data-entry=e100]")!;
				el.scrollTop += (node.getBoundingClientRect().top - el.getBoundingClientRect().top - 40) / (node.getBoundingClientRect().width / node.offsetWidth);
			});
			await frames(page);
			const before = await anchor(page);
			const read = before.offset / zoom;
			// A capped Pi tail: each arrival drops five entries above the reader.
			for (let k = 1; k <= 10; k++) {
				await publish(200 + 5 * k, "", 5 * k);
				const at = await css(page, before.id);
				assert.ok(at !== null && Math.abs(at - read) <= 1, `after ${k} arrivals, ${before.id} moved from ${read.toFixed(1)} to ${at?.toFixed(1)}`);
			}
		});
		test(`scroll hold (${engine}, zoom ${zoom}): an overlay panel covers exactly the transcript, also at its own zoom`, { skip: engineSkip(engine) }, async (t) => {
			const { page } = await open(t, 200, "pi", engine, zoom);
			for (const panel of [1, 1.2]) {
				const got = await page.evaluate(async (panel) => {
					document.querySelector(".panel-slot")?.remove();
					const slot = document.createElement("div");
					slot.className = "panel-slot";
					slot.style.cssText = `position:fixed;top:var(--transcript-top);bottom:var(--transcript-bottom);right:0;width:50px;zoom:${panel}`;
					document.body.append(slot);
					window.dispatchEvent(new Event("ampi:display"));
					await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
					const a = document.querySelector<HTMLElement>("[data-region=transcript]")!.getBoundingClientRect();
					const b = slot.getBoundingClientRect();
					return { top: b.top - a.top, bottom: b.bottom - a.bottom };
				}, panel);
				assert.ok(Math.abs(got.top) <= 1.5 * zoom * panel && Math.abs(got.bottom) <= 1.5 * zoom * panel, `panel zoom ${panel}: the overlay edges are off the transcript by ${JSON.stringify(got)}`);
			}
		});
		test(`scroll hold (${engine}, zoom ${zoom}): Back restores the saved entry place within 1 px`, { skip: engineSkip(engine) }, async (t) => {
			const { page } = await open(t, 200, "pi", engine, zoom);
			await scrollAway(page);
			await page.waitForFunction(() => Boolean(history.state?.place));
			const before = await scrollTop(page);
			await page.evaluate(() => { location.hash = "#another-place"; });
			await frames(page);
			await page.mouse.wheel(0, 400);
			await frames(page);
			assert.ok(Math.abs(await scrollTop(page) - before) > 200, "the reader moved away");
			await page.goBack();
			await frames(page);
			const after = await scrollTop(page);
			assert.ok(Math.abs(after - before) <= 1, `Back restored scrollTop ${after}, saved ${before}`);
		});
	}
};
