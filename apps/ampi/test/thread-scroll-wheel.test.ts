import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { END_BAND } from "../web/src/keep-place.ts";
import { ENGINES, anchor, awayFromEnd, frames, gap, grown, offsetOf, open, scrollTop, settled, tailBelow, view } from "./thread-scroll-fixture.ts";
import { engineSkip } from "./engines.ts";

// A reader's wheel during a stream, in both engines (see thread-scroll-hold.test.ts): up leaves the end at its input,
// down moves with the wheel and follows at the end.

// A reply that completes while the reader is away: the live reply becomes its committed entry. The read fragment, in an
// older entry or in the reply itself, keeps its screen height; the reader is not pinned again and nothing jumps.
for (const engine of ENGINES) for (const where of ["above the reply", "inside the reply"] as const) test(`scroll hold (${engine}): a reply that completes while the reader is away ${where} keeps the read place`, { skip: engineSkip(engine) }, async (t) => {
	const { page, send } = await open(t, 201, "durable", engine);
	const frame = (lines: number) => ({ ...view(201), live: { run: { activity: "streaming" }, generation: { message: { role: "assistant", content: [{ type: "text", text: grown(lines) }] } } } });
	const grow = async (lines: number) => {
		send(frame(lines));
		await page.waitForFunction((lines) => [...document.querySelectorAll("[data-region=transcript] p")].some((p) => p.textContent?.includes(`line ${lines} `)), lines);
		await frames(page);
	};
	for (let lines = 1; lines <= 30; lines += 3) await grow(lines);
	const box = (await page.locator("[data-region=transcript]").boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.wheel(0, where === "inside the reply" ? -400 : -2600);
	for (let i = 0; i < 10; i++) await frames(page);
	// The read fragment: the first paragraph whose bottom is below the transcript's top, found again by its text.
	const place = () => page.evaluate(() => {
		const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
		const top = el.getBoundingClientRect().top;
		const p = [...el.querySelectorAll<HTMLElement>("p")].find((node) => node.getBoundingClientRect().bottom > top + 40)!;
		return { text: p.textContent!, entry: p.closest<HTMLElement>("[data-entry]")?.dataset.entry };
	});
	const offset = (text: string) => page.evaluate((text) => {
		const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
		const p = [...el.querySelectorAll<HTMLElement>("p")].filter((node) => node.textContent === text);
		return p.length === 1 ? p[0]!.getBoundingClientRect().top - el.getBoundingClientRect().top : null;
	}, text);
	const read = await place();
	assert.ok(where === "inside the reply" ? /^Streamed line/.test(read.text) : !/^Streamed line/.test(read.text), `the reader reads ${where}; ${JSON.stringify(read)}`);
	const before = where === "inside the reply" ? await offset(read.text) : (await anchor(page)).offset;
	const id = where === "inside the reply" ? undefined : (await anchor(page)).id;
	const now = async () => id ? offsetOf(page, id) : offset(read.text);
	assert.ok(before !== null && await gap(page) > 60, `the reader is away; gap ${await gap(page)}`);
	for (let lines = 31; lines <= 34; lines++) await grow(lines);
	let at = await now();
	assert.ok(at !== null && Math.abs(at - before!) <= 2, `while streaming the read place moved from ${before} to ${at}`);
	// The reply completes: the live reply becomes entry e201.
	send(view(202, grown(34)));
	await page.locator('[data-entry="e201"], [data-region=transcript] [role=status] button').first().waitFor({ state: "attached" });
	for (let i = 0; i < 6; i++) {
		await frames(page);
		at = await now();
		assert.ok(at !== null && Math.abs(at - before!) <= 2, `frame ${i} after completion: the read place moved from ${before} to ${at}`);
	}
	assert.ok(await gap(page) > 60, `the reader stays away after completion; gap ${await gap(page)}`);
});

// Reader input during a stream leaves the end at once, in both engines; G follows again.
for (const engine of ENGINES) test(`scroll hold (${engine}): a wheel up during a stream keeps the read place; G follows again`, { skip: engineSkip(engine) }, async (t) => {
	const { page, send } = await open(t, 201, "pi", engine);
	const grow = async (lines: number) => {
		send(view(201, grown(lines)));
		await page.waitForFunction((lines) => [...document.querySelectorAll("[data-entry] p")].at(-1)?.textContent?.includes(`line ${lines} `), lines);
		await frames(page);
	};
	await grow(10);
	const box = (await page.locator("[data-region=transcript]").boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.wheel(0, -300);
	await grow(11);
	for (let i = 0; i < 10; i++) await frames(page);
	await awayFromEnd(page, 60);
	assert.ok(await gap(page) > 60, `the wheel leaves the end; gap ${await gap(page)}`);
	const read = await anchor(page);
	for (let lines = 12; lines <= 20; lines++) await grow(lines);
	const at = await offsetOf(page, read.id);
	assert.ok(at !== null && Math.abs(at - read.offset) <= 1, `the read entry moved from ${read.offset} to ${at}`);
	await page.locator("[data-region=transcript]").focus();
	await page.keyboard.press("Shift+G");
	await grow(21);
	assert.ok((await tailBelow(page)).below <= 1 && await gap(page) <= 2, `G follows again; gap ${await gap(page)}`);
});

// The wheel up leaves the end at its input. macOS WebKit applies a wheel's scroll asynchronously, so a stream render can
// run before the scroll lands (failure: macOS CI, the render followed and ate the wheel). The wheel here moves nothing.
for (const engine of ENGINES) test(`scroll hold (${engine}): a wheel up whose scroll has not landed leaves the end before the next render`, { skip: engineSkip(engine) }, async (t) => {
	const { page, send } = await open(t, 201, "pi", engine);
	const grow = async (lines: number) => {
		send(view(201, grown(lines)));
		await page.waitForFunction((lines) => [...document.querySelectorAll("[data-entry] p")].at(-1)?.textContent?.includes(`line ${lines} `), lines);
		await frames(page);
	};
	await grow(10);
	assert.ok(await gap(page) <= 2, `the reader starts at the end; gap ${await gap(page)}`);
	const before = await scrollTop(page);
	await page.locator("[data-region=transcript]").dispatchEvent("wheel", { deltaY: -300, bubbles: true });
	await grow(11);
	for (let i = 0; i < 4; i++) await frames(page);
	assert.ok(Math.abs(await scrollTop(page) - before) <= 1 && await gap(page) > 2, `the render kept the read place; moved ${await scrollTop(page) - before}, gap ${await gap(page)}`);
});

// A reader's scroll up leaves the end at once, whatever its step: a trackpad sends steps of a few px, and Linux WebKit
// animates one wheel in steps. A stream render between two steps inside the end band must not pull the reader back
// (failure: Linux CI, steps under END_BAND kept the pin). Only the reader's scroll down into the band follows again.
for (const engine of ENGINES) for (const step of [20, 40]) test(`scroll hold (${engine}): wheel steps of ${step} px up during a stream leave the end; a scroll down to it follows again`, { skip: engineSkip(engine) }, async (t) => {
	const { page, send } = await open(t, 201, "pi", engine);
	let lines = 10;
	const grow = async () => {
		lines++;
		send(view(201, grown(lines)));
		await page.waitForFunction((lines) => [...document.querySelectorAll("[data-entry] p")].at(-1)?.textContent?.includes(`line ${lines} `), lines);
		await frames(page);
	};
	await grow();
	assert.ok(await gap(page) <= 2, `the end follows the stream; gap ${await gap(page)}`);
	const box = (await page.locator("[data-region=transcript]").boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	let last = 0;
	for (let i = 1; i <= 15; i++) {
		await page.mouse.wheel(0, -step);
		await frames(page);
		await grow();
		const now = await gap(page);
		assert.ok(now > 2 && now >= last - 1, `after ${i} steps the stream pulled the reader back: gap ${now}, before ${last}`);
		last = now;
	}
	await settled(page);
	assert.ok(await gap(page) > END_BAND, `the steps leave the end band; gap ${await gap(page)}`);
	const read = await anchor(page);
	for (let i = 0; i < 5; i++) await grow();
	const at = await offsetOf(page, read.id);
	assert.ok(at !== null && Math.abs(at - read.offset) <= 1, `the read entry moved from ${read.offset} to ${at}`);
	await page.mouse.wheel(0, 100_000);
	await settled(page);
	await grow();
	assert.ok((await tailBelow(page)).below <= 1 && await gap(page) <= 2, `a scroll down to the end follows again; gap ${await gap(page)}`);
});

// Owner incident (AmPi macOS app): a reader away from the end scrolls down with the trackpad while a reply streams. The
// reader's own scroll wins over the saved place: no step snaps back, the end band resumes follow, and the reply's end
// (a live reply replaced by its entry) does not jump.
for (const engine of ENGINES) for (const shape of ["same entry", "live reply"] as const) test(`scroll hold (${engine}): ${shape}, a reader wheeling down through a stream moves with the wheel and follows at the end`, { skip: engineSkip(engine) }, async (t) => {
	const live = shape === "live reply";
	const { page, send } = await open(t, 201, live ? "durable" : "pi", engine);
	const frame = (lines: number) => live
		? { ...view(201), live: { run: { activity: "streaming" }, generation: { message: { role: "assistant", content: [{ type: "text", text: grown(lines) }] } } } }
		: view(201, grown(lines));
	const grow = async (lines: number) => {
		send(frame(lines));
		await page.waitForFunction((lines) => [...document.querySelectorAll("[data-region=transcript] p")].some((p) => p.textContent?.includes(`line ${lines} `)), lines);
	};
	const top = () => page.evaluate(() => document.querySelector<HTMLElement>("[data-region=transcript]")!.scrollTop);
	for (let lines = 1; lines <= 12; lines++) await grow(lines);
	const box = (await page.locator("[data-region=transcript]").boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.wheel(0, -900);
	for (let i = 0; i < 10; i++) await frames(page);
	await awayFromEnd(page, 600);
	assert.ok(await gap(page) > 600, `the reader left the end; gap ${await gap(page)}`);
	let lines = 12, last = await top(), steps = 0;
	while (await gap(page) > 60 && steps++ < 60) {
		await grow(++lines);
		await page.mouse.wheel(0, 120);
		await frames(page);
		const now = await top();
		assert.ok(now >= last + 10, `step ${steps}: the wheel moved down; scrollTop ${last} -> ${now}, gap ${await gap(page)}`);
		last = now;
	}
	assert.ok(await gap(page) <= 60, `the wheel reached the end band; gap ${await gap(page)}`);
	for (let i = 0; i < 6; i++) {
		await grow(++lines);
		await frames(page);
		const tail = await tailBelow(page);
		assert.ok(tail.below <= 1, `the end band follows again; ${JSON.stringify(tail)}`);
	}
	// The reply ends: a live reply becomes entry e201; a same-entry reply stops growing. The end stays in view.
	send(live ? view(202, grown(lines)) : view(201, grown(lines)));
	if (live) await page.locator('[data-entry="e201"]').waitFor({ state: "attached" });
	await frames(page);
	const done = await tailBelow(page);
	assert.ok(done.below <= 1 && await gap(page) <= 2, `the reply's end stays in view; gap ${await gap(page)}, ${JSON.stringify(done)}`);
});
