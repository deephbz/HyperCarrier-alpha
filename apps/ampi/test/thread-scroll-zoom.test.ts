import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { ENGINES, anchor, frames, gap, grown, offsetOf, open, scrollAway, view } from "./thread-scroll-fixture.ts";
import { engineSkip } from "./engines.ts";
import { zoomCases } from "./thread-scroll-zoom-cases.ts";

// Display zoom 130 % (thread-scroll-zoom-cases.ts). thread-scroll-zoom-out.test.ts holds zoom 80 %.
zoomCases(1.3);

// A place saved before the unit marker holds its offset in screen px, and history state outlives a reload and a deploy.
// Reload and Back restore such a place converted at the transcript, so the entry lands where it was read.
for (const engine of ENGINES) for (const [zoom, region] of [[1.3, 1], [1.3, 1.2]] as const) {
	const scale = zoom * region;
	test(`scroll hold (${engine}, zoom ${zoom}, transcript ${region}): a place saved in screen px restores within 1 px after reload and on Back`, { skip: engineSkip(engine) }, async (t) => {
		const { page } = await open(t, 200, "pi", engine, zoom, region);
		// The reader reads e151 with its top 60 CSS px above the transcript's top.
		await page.evaluate(() => {
			const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
			const node = el.querySelector<HTMLElement>("[data-entry=e151]")!;
			const scale = el.getBoundingClientRect().width / el.offsetWidth;
			el.scrollTop += (node.getBoundingClientRect().top - el.getBoundingClientRect().top) / scale + 60;
			el.dispatchEvent(new Event("scroll"));
		});
		await page.waitForFunction(() => history.state?.place?.id === "e151");
		const saved = await page.evaluate(() => history.state.place.offset as number);
		// The same place as the code before the marker wrote it.
		const legacy = () => page.evaluate((offset) => {
			const { unit: _, ...place } = history.state.place;
			history.replaceState({ ...history.state, place: { ...place, offset } }, "");
		}, saved * scale);
		const landed = async () => {
			await page.locator("[data-entry=e151]").waitFor({ state: "attached" });
			for (let i = 0; i < 4; i++) await frames(page);
			return (await offsetOf(page, "e151"))! / scale;
		};
		await legacy();
		await page.reload();
		let at = await landed();
		assert.ok(Math.abs(at - saved) <= 1, `reload restored e151 at ${at.toFixed(1)}, saved ${saved.toFixed(1)}`);
		// Back to a legacy entry after a reload: the page holds no notes of its own for that entry.
		await page.waitForFunction(() => history.state?.place?.id === "e151");
		await legacy();
		await page.evaluate(() => { location.hash = "#another-place"; });
		await page.reload();
		await page.locator("[data-region=transcript] [data-entry]").first().waitFor({ state: "attached" });
		await frames(page);
		await page.goBack();
		at = await landed();
		assert.ok(Math.abs(at - saved) <= 1, `Back restored e151 at ${at.toFixed(1)}, saved ${saved.toFixed(1)}`);
	});
}

// Live replies at combined display zoom: the overall html zoom and the transcript's own zoom at once.
for (const engine of ENGINES) {
	const zoom = 1.3, region = 1.2, scale = zoom * region;
	const live = (lines: number) => ({ ...view(201), live: { run: { activity: "streaming" }, generation: { message: { role: "assistant", content: [{ type: "text", text: grown(lines) }] } } } });
	const setup = async (t: Parameters<typeof open>[0]) => {
		const { page, send } = await open(t, 201, "durable", engine, zoom, region);
		const grow = async (lines: number) => {
			send(live(lines));
			await page.waitForFunction((lines) => [...document.querySelectorAll("[data-region=transcript] p")].some((p) => p.textContent?.includes(`line ${lines} `)), lines);
			await frames(page);
		};
		// The read fragment: the first paragraph whose bottom is below the transcript's top, found again by its text.
		const place = () => page.evaluate(() => {
			const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
			const top = el.getBoundingClientRect().top;
			return [...el.querySelectorAll<HTMLElement>("p")].find((node) => node.getBoundingClientRect().bottom > top + 40)!.textContent!;
		});
		const offset = (text: string) => page.evaluate(({ text, scale }) => {
			const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
			const p = [...el.querySelectorAll<HTMLElement>("p")].filter((node) => node.textContent === text);
			return p.length === 1 ? (p[0]!.getBoundingClientRect().top - el.getBoundingClientRect().top) / scale : null;
		}, { text, scale });
		const wheel = async (dy: number) => {
			const box = (await page.locator("[data-region=transcript]").boundingBox())!;
			await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
			await page.mouse.wheel(0, dy);
		};
		return { page, send, grow, place, offset, wheel };
	};
	test(`scroll hold (${engine}, zoom ${zoom}, transcript ${region}): the live reply shrinks, the reader scrolls up, the reply regrows; the read place holds`, { skip: engineSkip(engine) }, async (t) => {
		const { page, grow, place, offset, wheel } = await setup(t);
		for (let lines = 1; lines <= 30; lines += 3) await grow(lines);
		assert.ok(await gap(page) <= 60, `the end follows the reply; gap ${await gap(page)}`);
		// The reply shrinks (a re-render with less text); the reader scrolls up before it grows again.
		await grow(12);
		await wheel(-500);
		for (let i = 0; i < 10; i++) await frames(page);
		assert.ok(await gap(page) > 60, `the wheel leaves the end; gap ${await gap(page)}`);
		const read = await place();
		const before = (await offset(read))!;
		for (let lines = 13; lines <= 40; lines += 3) {
			await grow(lines);
			const at = await offset(read);
			assert.ok(at !== null && Math.abs(at - before) <= 1, `after the regrowth to line ${lines}, the read place moved from ${before.toFixed(1)} to ${at?.toFixed(1)}`);
		}
		assert.ok(await gap(page) > 60, `the reader stays away; gap ${await gap(page)}`);
	});
	// The delayed clamp of thread-scroll-hold at combined zoom: the reply shrinks in a render the transcript does not see,
	// the clamp's scroll event is held, the reader moves up, and the reply grows back, all before any frame, so before any
	// observer or correction. The held events arrive as one, after the regrowth or only after the observer's correction.
	// The reader's move is a scrollTop write: the transcript tells a reader only by scrollTop, and a real wheel cannot run
	// inside this task. The read place holds and the reader stays away.
	for (const event of ["after the regrowth", "after the correction"] as const) test(`scroll hold (${engine}, zoom ${zoom}, transcript ${region}): the reply shrinks, the reader moves up while the clamp's event waits, the reply regrows, the event arrives ${event}; the read place holds`, { skip: engineSkip(engine) }, async (t) => {
		const { page, grow, offset } = await setup(t);
		for (let lines = 1; lines <= 30; lines += 3) await grow(lines);
		assert.ok(await gap(page) <= 2, `the end follows the reply; gap ${await gap(page)}`);
		const order = await page.evaluate(async ({ scale, event }) => {
			const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
			const hold = (event: Event) => { if (event.isTrusted) event.stopImmediatePropagation(); };
			window.addEventListener("scroll", hold, true);
			(window as unknown as { release: () => void }).release = () => window.removeEventListener("scroll", hold, true);
			const reply = [...el.querySelectorAll<HTMLElement>("p")].filter((p) => /^Streamed line/.test(p.textContent ?? "")).slice(-8);
			const top = el.scrollTop;
			for (const p of reply) p.style.display = "none";
			const clamped = top - el.scrollTop;
			await Promise.resolve();
			el.scrollTop -= 300;
			const edge = el.getBoundingClientRect().top;
			const node = [...el.querySelectorAll<HTMLElement>("p")].find((node) => node.getBoundingClientRect().bottom > edge + 40)!;
			const offset = (node.getBoundingClientRect().top - edge) / scale;
			// The reply grows back past its old end, as the next streamed frame does, so the observer runs a correction.
			for (const p of reply) p.style.display = "";
			const more = document.createElement("div");
			more.style.height = "240px";
			el.querySelector(".transcript")!.append(more);
			if (event === "after the regrowth") el.dispatchEvent(new Event("scroll"));
			return { clamped, read: node.textContent!, offset, gap: el.scrollHeight - el.scrollTop - el.clientHeight };
		}, { scale, event });
		assert.ok(order.clamped > 30 && order.gap > 300, `the shrink clamps scrollTop and the regrowth leaves the end out of view; ${JSON.stringify(order)}`);
		const before = order.offset;
		for (let i = 0; i < 6; i++) {
			await frames(page);
			if (i === 2) await page.evaluate(() => {
				(window as unknown as { release: () => void }).release();
				document.querySelector("[data-region=transcript]")!.dispatchEvent(new Event("scroll"));
			});
			const at = await offset(order.read);
			assert.ok(at !== null && Math.abs(at - before) <= 1, `frame ${i}: the read place moved from ${before.toFixed(1)} to ${at?.toFixed(1)}`);
		}
		assert.ok(await gap(page) > 60, `the reader stays away; gap ${await gap(page)}`);
		for (let lines = 31; lines <= 37; lines += 3) {
			await grow(lines);
			const at = await offset(order.read);
			assert.ok(at !== null && Math.abs(at - before) <= 1, `after line ${lines}, the read place moved from ${before.toFixed(1)} to ${at?.toFixed(1)}`);
		}
		assert.ok(await gap(page) > 60, `the reader stays away after the stream grows; gap ${await gap(page)}`);
	});
	test(`scroll hold (${engine}, zoom ${zoom}, transcript ${region}): a reply that completes while the reader is away inside it keeps the read place`, { skip: engineSkip(engine) }, async (t) => {
		const { page, send, grow, place, offset, wheel } = await setup(t);
		for (let lines = 1; lines <= 30; lines += 3) await grow(lines);
		await wheel(-400);
		for (let i = 0; i < 10; i++) await frames(page);
		const read = await place();
		assert.ok(/^Streamed line/.test(read) && await gap(page) > 60, `the reader reads inside the reply, away from the end; ${read}, gap ${await gap(page)}`);
		const before = (await offset(read))!;
		for (let lines = 31; lines <= 34; lines++) await grow(lines);
		let at = await offset(read);
		assert.ok(at !== null && Math.abs(at - before) <= 1, `while streaming the read place moved from ${before.toFixed(1)} to ${at?.toFixed(1)}`);
		// The reply completes: the live reply becomes entry e201.
		send(view(202, grown(34)));
		await page.locator('[data-entry="e201"], [data-region=transcript] [role=status] button').first().waitFor({ state: "attached" });
		for (let i = 0; i < 6; i++) {
			await frames(page);
			at = await offset(read);
			assert.ok(at !== null && Math.abs(at - before) <= 1, `frame ${i} after completion: the read place moved from ${before.toFixed(1)} to ${at?.toFixed(1)}`);
		}
		assert.ok(await gap(page) > 60, `the reader stays away after completion; gap ${await gap(page)}`);
	});
}

// A live display-size change (Cmd+Shift+= / Cmd+0): App sets html `zoom` on a window of fixed screen size, so the
// transcript narrows in CSS px, rows rewrap and the scroller's own screen top moves. The read entry keeps its CSS offset
// from the transcript's top at each step.
for (const engine of ENGINES) {
	const setZoom = (page: Page, zoom: number) => page.evaluate(async (zoom) => {
		document.documentElement.style.zoom = String(zoom);
		await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
	}, zoom);
	for (const backend of ["pi", "durable"] as const) test(`scroll hold (${engine}, ${backend}): a live zoom change 1 → 1.3 → 1 away from the end keeps the read entry within 2 CSS px`, { skip: engineSkip(engine) }, async (t) => {
		const { page } = await open(t, 200, backend, engine);
		await scrollAway(page);
		assert.ok(await gap(page) > 1000, "the reader is away from the newest end");
		const before = await anchor(page);
		const steps = [1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.25, 1.1, 1];
		for (const zoom of steps) {
			await setZoom(page, zoom);
			await page.waitForTimeout(30);
			await frames(page);
			const at = await offsetOf(page, before.id);
			const css = at === null ? null : at / zoom;
			assert.ok(css !== null && Math.abs(css - before.offset) <= 2, `at zoom ${zoom}, ${before.id} moved from ${before.offset.toFixed(1)} to ${css?.toFixed(1)} CSS px`);
		}
	});
	test(`scroll hold (${engine}): a reader at the end stays there through a live zoom change and follows the next entry`, { skip: engineSkip(engine) }, async (t) => {
		const { page, publish } = await open(t, 200, "pi", engine);
		assert.ok(await gap(page) <= 2, "the reader starts at the end");
		for (const zoom of [1.1, 1.3]) {
			await setZoom(page, zoom);
			await page.waitForTimeout(30);
			await frames(page);
			assert.ok(await gap(page) <= 2, `at zoom ${zoom} the reader is still at the end (gap ${await gap(page)})`);
		}
		await publish(201);
		assert.ok(await gap(page) <= 2, "the next entry is followed");
	});
}
