import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ENGINES, anchor, frames, gap, grown, offsetOf, open, scrollTop, tailBelow, view } from "./thread-scroll-fixture.ts";
import { engineSkip } from "./engines.ts";

// A reply streams into the real ThreadView (see thread-scroll-hold.test.ts): a reader at the end follows it in both
// engines, and a clamp or a move with no reader input does not count as the reader leaving.

for (const engine of ENGINES) test(`scroll hold (${engine}): one entry streams in place; the end follows it, k leaves, the read place holds, and G follows again`, { skip: engineSkip(engine) }, async (t) => {
	const { page, send } = await open(t, 201, "pi", engine);
	const grow = async (lines: number) => {
		send(view(201, grown(lines)));
		await page.waitForTimeout(16);
		await frames(page);
	};
	for (let lines = 1; lines <= 40; lines++) {
		await grow(lines);
		const { below } = await tailBelow(page);
		assert.ok(await gap(page) <= 60 && below <= 1, `after ${lines} lines: gap ${await gap(page)}, last line ${below} px below the bottom`);
	}
	await page.locator("[data-region=transcript]").focus();
	await page.keyboard.press("k");
	for (let i = 0; i < 20; i++) await frames(page);
	assert.ok(await gap(page) > 60, `k leaves the end band; gap ${await gap(page)}`);
	const read = await anchor(page);
	for (let lines = 41; lines <= 60; lines++) await grow(lines);
	const at = await offsetOf(page, read.id);
	assert.ok(at !== null && Math.abs(at - read.offset) <= 1, `the read entry moved from ${read.offset} to ${at}`);
	await page.keyboard.press("Shift+G");
	await frames(page);
	assert.ok(await gap(page) <= 2, `G returns to the end; gap ${await gap(page)}`);
	await grow(61);
	const tail = await tailBelow(page);
	assert.ok(tail.below <= 1 && /line 61 /.test(tail.text ?? ""), `after G the next line is visible; ${JSON.stringify(tail)}`);
});

// WebKit (owner incident, Herdr GUI): content shrank in a render the transcript did not see, so WebKit clamped scrollTop
// at the bottom, and the next streamed frame grew the content before the clamp's scroll event arrived. That scroll-up
// was no reader's; the end must keep following. The scroll event is held back here, so both engines see that order.
for (const engine of ENGINES) test(`scroll hold (${engine}): a clamp at the end is not the reader leaving; the stream stays followed`, { skip: engineSkip(engine) }, async (t) => {
	const { page, send } = await open(t, 201, "pi", engine);
	const grow = async (lines: number) => {
		send(view(201, grown(lines)));
		await page.waitForFunction((lines) => [...document.querySelectorAll("[data-entry] p")].at(-1)?.textContent?.includes(`line ${lines} `), lines);
	};
	await grow(4);
	await page.evaluate(() => {
		const spacer = document.createElement("div");
		spacer.id = "shrinks";
		spacer.style.height = "40px";
		document.querySelector("[data-region=transcript] .transcript")!.append(spacer);
	});
	await grow(5);
	await frames(page);
	assert.ok(await gap(page) <= 2, `the end follows; gap ${await gap(page)}`);
	const clamped = await page.evaluate(() => {
		const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
		const hold = (event: Event) => event.stopImmediatePropagation();
		window.addEventListener("scroll", hold, true);
		(window as unknown as { release: () => void }).release = () => window.removeEventListener("scroll", hold, true);
		const top = el.scrollTop;
		document.getElementById("shrinks")!.remove();
		return top - el.scrollTop;
	});
	assert.ok(clamped > 30, `the shrink clamps scrollTop; moved ${clamped}`);
	await grow(12);
	await page.evaluate(() => (window as unknown as { release: () => void }).release());
	await frames(page);
	const tail = await tailBelow(page);
	assert.ok(await gap(page) <= 60 && tail.below <= 1, `the stream stays followed; gap ${await gap(page)}, ${JSON.stringify(tail)}`);
	await grow(16);
	await frames(page);
	assert.ok((await tailBelow(page)).below <= 1, "later frames follow too");
});

// The same clamp, in the other event order: its scroll event arrives after the next child-only render grew the content
// again, and before the observer's correction. No reader moved, so the reader stays pinned and the observer follows.
for (const engine of ENGINES) test(`scroll hold (${engine}): a clamp's scroll event after regrowth, before the observer, keeps the stream followed`, { skip: engineSkip(engine) }, async (t) => {
	const { page, send } = await open(t, 201, "pi", engine);
	const grow = async (lines: number) => {
		send(view(201, grown(lines)));
		await page.waitForFunction((lines) => [...document.querySelectorAll("[data-entry] p")].at(-1)?.textContent?.includes(`line ${lines} `), lines);
	};
	await grow(4);
	await page.evaluate(() => {
		const spacer = document.createElement("div");
		spacer.id = "shrinks";
		spacer.style.height = "40px";
		document.querySelector("[data-region=transcript] .transcript")!.append(spacer);
	});
	await grow(5);
	await frames(page);
	assert.ok(await gap(page) <= 2, `the end follows; gap ${await gap(page)}`);
	const order = await page.evaluate(async () => {
		const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
		// Hold the browser's own scroll events; the clamp's event is dispatched below, in the order under test.
		const hold = (event: Event) => { if (event.isTrusted) event.stopImmediatePropagation(); };
		window.addEventListener("scroll", hold, true);
		(window as unknown as { release: () => void }).release = () => window.removeEventListener("scroll", hold, true);
		const top = el.scrollTop;
		document.getElementById("shrinks")!.remove();
		const clamped = top - el.scrollTop;
		// The shrinking render's microtasks run; no frame passes, so no observer runs.
		await Promise.resolve();
		const regrown = document.createElement("div");
		regrown.style.height = "120px";
		el.querySelector(".transcript")!.append(regrown);
		el.dispatchEvent(new Event("scroll"));
		return { clamped, gap: el.scrollHeight - el.scrollTop - el.clientHeight };
	});
	assert.ok(order.clamped > 30 && order.gap > 60, `the clamp and the regrowth leave the end out of view; ${JSON.stringify(order)}`);
	await frames(page);
	await page.evaluate(() => (window as unknown as { release: () => void }).release());
	assert.ok(await gap(page) <= 2, `the observer follows the regrown end; gap ${await gap(page)}`);
	await grow(8);
	await frames(page);
	assert.ok((await tailBelow(page)).below <= 1 && await gap(page) <= 2, `later frames follow too; gap ${await gap(page)}`);
});

// A page can move the transcript up with no wheel, key, touch or pointer on it: find-in-page jumps to a match above, a
// link or a focused notice scrolls its target into view, and a scroll step can come from outside the transcript. Each is
// the reader's own move; arrivals keep the read place and do not pull the reader back to the end.
for (const engine of ENGINES) for (const move of ["find", "link", "focus", "step"] as const) test(`scroll hold (${engine}): ${move} moves a following reader up with no input; arrivals keep the read place`, { skip: engineSkip(engine) }, async (t) => {
	const { page, send } = await open(t, 201, "pi", engine);
	const grow = async (lines: number) => {
		send(view(201, grown(lines)));
		await page.waitForFunction((lines) => [...document.querySelectorAll("[data-entry] p")].at(-1)?.textContent?.includes(`line ${lines} `), lines);
		await frames(page);
	};
	for (let lines = 1; lines <= 10; lines++) await grow(lines);
	assert.ok(await gap(page) <= 2, `the end follows; gap ${await gap(page)}`);
	const before = await scrollTop(page);
	const problem = await page.evaluate((move) => {
		const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
		const target = el.querySelector<HTMLElement>('[data-entry="e181"]')!;
		if (move === "find") {
			// Search back from the end, as find-in-page reaches a match above. WebKit scrolls to the match; Chromium's
			// window.find only selects it and leaves the scroll to its find bar, so the match is scrolled into view here.
			const top = el.scrollTop;
			if (!(window as unknown as { find(text: string, caseSensitive: boolean, backwards: boolean, wrap: boolean): boolean }).find("Answer 181.", false, true, true)) return "no match";
			if (el.scrollTop === top) getSelection()!.getRangeAt(0).startContainer.parentElement!.scrollIntoView({ block: "center" });
		} else if (move === "link") target.scrollIntoView({ block: "start" });
		else if (move === "focus") { target.tabIndex = -1; target.focus(); }
		// A k step from outside: three lines up, past the end band, as scrollKeyTarget lands it.
		else el.scrollTo({ top: el.scrollHeight - el.clientHeight - 60 - 24 - 72 });
		return undefined;
	}, move);
	assert.equal(problem, undefined);
	for (let i = 0; i < 6; i++) await frames(page);
	const moved = before - await scrollTop(page);
	assert.ok(moved > 60 && await gap(page) > 60, `${move} moved the reader up; moved ${moved}, gap ${await gap(page)}`);
	const read = await anchor(page);
	for (let lines = 11; lines <= 18; lines++) {
		await grow(lines);
		const at = await offsetOf(page, read.id);
		assert.ok(at !== null && Math.abs(at - read.offset) <= 2 && await gap(page) > 60, `after line ${lines}, ${read.id} moved from ${read.offset} to ${at}; gap ${await gap(page)}`);
	}
});
