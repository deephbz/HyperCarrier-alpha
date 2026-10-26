import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { ENGINES, anchor, entries, frames, gap, grown, offsetOf, open, scrollAway, scrollTop, streaming, view } from "./thread-scroll-fixture.ts";
import { engineSkip } from "./engines.ts";

// The real ThreadView with the real stylesheet in Chromium; only the hub is a script on the page's WebSocket. A reader
// away from the newest end keeps the entry they read at its screen height while entries arrive; a reader at the end
// follows (failure: owner report, each new entry moved the transcript the reader was reading).

test("scroll hold: entries arriving past the paint window keep a reader's entry at its screen height", async (t) => {
	const { page, publish } = await open(t, 200);
	// The reader scrolls up into the middle of the window and reads.
	await page.locator("[data-region=transcript]").hover();
	await page.mouse.wheel(0, -4000);
	await frames(page);
	assert.ok(await gap(page) > 1000, "the reader is away from the newest end");
	const before = await anchor(page);
	for (const n of [201, 203, 210]) {
		await publish(n);
		const offset = await offsetOf(page, before.id);
		assert.ok(offset !== null && Math.abs(offset - before.offset) <= 2, `after ${n} entries, ${before.id} moved from ${before.offset.toFixed(1)} to ${offset?.toFixed(1)}`);
	}
	// The newest answer streams in below the reader: nothing they read moves.
	for (const tail of ["Streaming", `Streaming ${"more words ".repeat(400)}`]) {
		await publish(210, tail);
		const offset = await offsetOf(page, before.id);
		assert.ok(offset !== null && Math.abs(offset - before.offset) <= 2, `a growing last entry moved ${before.id} to ${offset?.toFixed(1)}`);
	}
	// The reader's own scroll stands: the next arrival keeps the new place instead of returning to the old one.
	await page.mouse.wheel(0, 300);
	await frames(page);
	const moved = await offsetOf(page, before.id);
	assert.ok(moved !== null && moved < before.offset - 250, `the reader's scroll did not move ${before.id}: ${moved?.toFixed(1)}`);
	await publish(212);
	const kept = await offsetOf(page, before.id);
	assert.ok(kept !== null && Math.abs(kept - moved) <= 2, `after the reader scrolled, an arrival moved ${before.id} from ${moved.toFixed(1)} to ${kept?.toFixed(1)}`);
});

test("scroll hold: a stationary reader near the window top paints no arrived rows", async (t) => {
	const { page, send } = await open(t, 400);
	// The reader stops near the top of the paint window, above the distance that grows it.
	await page.evaluate(() => { document.querySelector<HTMLElement>("[data-region=transcript]")!.scrollTop = 1500; });
	await frames(page);
	const painted = () => page.locator("[data-region=transcript] [data-entry]").count();
	const first = await painted();
	const before = await anchor(page);
	// Three windows of arrivals: a place correction that read as the reader's scroll grew the window 120 rows at a time.
	// Arrivals below a frozen window only feed the count.
	for (let n = 412; n <= 760; n += 12) {
		send({ ...view(n) });
		await newButton(page).getByText(`↓ ${n - 400} new`, { exact: true }).waitFor();
		await frames(page);
		assert.equal(await painted(), first, `after ${n} entries the window painted rows past its frozen end`);
		const offset = await offsetOf(page, before.id);
		assert.ok(offset !== null && Math.abs(offset - before.offset) <= 2, `after ${n} entries, ${before.id} moved from ${before.offset.toFixed(1)} to ${offset?.toFixed(1)}`);
	}
	// The reader's own scroll to the top still grows the held window by one step.
	await page.evaluate(() => { document.querySelector<HTMLElement>("[data-region=transcript]")!.scrollTop = 0; });
	await page.waitForFunction((rows) => document.querySelectorAll("[data-region=transcript] [data-entry]").length === rows, first + 120);
});

test("scroll hold: a reader at the newest end follows arriving entries", async (t) => {
	const { page, publish } = await open(t, 200);
	assert.ok(await gap(page) <= 2, "the transcript opens at the newest end");
	for (const n of [201, 205]) {
		await publish(n);
		assert.ok(await gap(page) <= 2, `after ${n} entries the reader is still at the newest end`);
	}
});

test("scroll hold: arrivals below a reader away from the end show \"↓ N new\"; a click returns to the end and follows", async (t) => {
	const { page, publish } = await open(t, 200);
	const status = page.locator("[data-region=transcript] [role=status]");
	await page.locator("[data-region=transcript]").hover();
	await page.mouse.wheel(0, -4000);
	await frames(page);
	assert.equal(await status.getByRole("button").count(), 0, "no button before anything arrives");
	await publish(203);
	await status.getByRole("button", { name: "↓ 3 new" }).waitFor();
	await publish(204);
	await status.getByRole("button", { name: "↓ 4 new" }).click();
	await frames(page);
	assert.ok(await gap(page) <= 2, "the click returns to the newest end");
	assert.equal(await status.getByRole("button").count(), 0, "the count clears at the end");
	await publish(206);
	assert.ok(await gap(page) <= 2, "after the click the reader follows arriving entries");
	assert.equal(await status.getByRole("button").count(), 0, "a following reader sees no count");
});

test("scroll hold: one end band; a reader 30 px above the end follows arrivals", async (t) => {
	const { page, publish } = await open(t, 200);
	await page.evaluate(() => { const el = document.querySelector<HTMLElement>("[data-region=transcript]")!; el.scrollTop = el.scrollHeight - el.clientHeight - 30; });
	await frames(page);
	await publish(202);
	assert.ok(await gap(page) <= 2, `a reader inside the end band follows; gap ${await gap(page)}`);
	assert.equal(await page.locator("[data-region=transcript] [role=status] button").count(), 0, "a reader inside the end band sees no count");
});

test("scroll hold: k and u from the end leave the end band, so arrivals do not pull the reader back", async (t) => {
	const { page, publish } = await open(t, 200);
	let n = 200;
	for (const key of ["k", "u"]) {
		await page.locator("[data-region=transcript]").focus();
		await page.keyboard.press("Shift+G");
		await frames(page);
		assert.ok(await gap(page) <= 2, "G starts the reader at the newest end");
		await page.keyboard.press(key);
		// A smooth scroll takes several frames; arrivals render while it runs and after it ends.
		for (let i = 0; i < 20; i++) await frames(page);
		const left = await gap(page);
		assert.ok(left > 60, `${key} leaves the end band; gap ${left}`);
		await publish(n += 2);
		await frames(page);
		assert.ok(await gap(page) > 60, `the reader stays away from the end after ${key}; gap ${await gap(page)}`);
		await newButton(page).waitFor();
	}
});

/** How far the last streamed line's bottom is below the transcript's visible bottom (positive: hidden). */
const lastLineBelow = (page: Page) => page.evaluate(() => {
	const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
	const lines = [...el.querySelectorAll<HTMLElement>(".cursor-blink p, .msg.assistant p")];
	const last = lines.at(-1);
	return last ? last.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom : Number.NaN;
});

test("scroll hold: a reader at the end follows a streaming reply; its last line stays visible during and after the stream", async (t) => {
	const { page, send } = await open(t, 200);
	assert.ok(await gap(page) <= 2, "the transcript opens at the newest end");
	for (let lines = 1; lines <= 60; lines += 3) {
		send(streaming(200, lines));
		await page.waitForTimeout(40);
		await frames(page);
		const below = await lastLineBelow(page);
		assert.ok(below <= 2, `while streaming ${lines} lines the last line is ${below} px below the visible bottom; gap ${await gap(page)}`);
	}
	await frames(page);
	assert.ok(await gap(page) <= 2, `after the stream the reader is at the end; gap ${await gap(page)}`);
});

const tailBelow = (page: Page) => page.evaluate(() => {
	const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
	const last = [...el.querySelectorAll<HTMLElement>("[data-entry] p")].at(-1)!;
	return { below: last.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom, text: last.textContent };
});

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

// Owner incident (AmPi macOS app): a reader away from the end scrolls down with the trackpad while a reply streams. The
// reader's own scroll wins over the saved place: no step snaps back, the end band resumes follow, and the reply's end
// (a live reply replaced by its entry) does not jump.
for (const engine of ENGINES) for (const shape of ["same entry"] as const) test(`scroll hold (${engine}): ${shape}, a reader wheeling down through a stream moves with the wheel and follows at the end`, { skip: engineSkip(engine) }, async (t) => {
	const live = false;
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

test("scroll hold: a reader away from the end stays put while a reply streams", async (t) => {
	const { page, send } = await open(t, 200);
	await scrollAway(page);
	const before = await anchor(page);
	for (let lines = 1; lines <= 30; lines += 3) {
		send(streaming(200, lines));
		await page.waitForTimeout(30);
		await frames(page);
	}
	const after = await offsetOf(page, before.id);
	assert.ok(after !== null && Math.abs(after - before.offset) <= 2, `the read entry moved from ${before.offset} to ${after}`);
	assert.ok(await gap(page) > 60, "the reader stays away from the end");
});

const newButton = (page: Page) => page.locator("[data-region=transcript] [role=status] button");

test("scroll hold: a capped Pi tail counts arrivals by entry, though its length stays the same", async (t) => {
	const { page, publish } = await open(t, 200);
	await scrollAway(page);
	// The Pi Host serves the newest 200 entries: each arrival drops one entry at the window's start.
	await publish(203, "", 3);
	await newButton(page).getByText("↓ 3 new", { exact: true }).waitFor();
	await publish(205, "", 5);
	await newButton(page).getByText("↓ 5 new", { exact: true }).waitFor();
});

test("scroll hold: a last-seen entry that left the capped tail shows \"↓ new\"", async (t) => {
	const { page, publish } = await open(t, 200);
	await scrollAway(page);
	await publish(300, "", 100);
	await newButton(page).getByText("↓ 100 new", { exact: true }).waitFor();
	// e199, the newest entry when the reader left the end, slides out of the window: the count is unknown.
	await publish(400, "", 200);
	await newButton(page).getByText("↓ new", { exact: true }).waitFor();
});

test("scroll hold: a window that moves past every entry it had, on the same branch, shows \"↓ new\" and keeps the reader away", async (t) => {
	const { page, publish } = await open(t, 200);
	await scrollAway(page);
	const top = await scrollTop(page);
	// One coalesced snapshot (or a reconnect) serves e200..e399: no entry overlaps the window the reader left.
	await publish(400, "", 200);
	await newButton(page).getByText("↓ new", { exact: true }).waitFor();
	assert.ok(Math.abs(await scrollTop(page) - top) <= 2 && await gap(page) > 60, `the reader moved from ${top} to ${await scrollTop(page)}, gap ${await gap(page)}`);
	await publish(401, "", 201);
	assert.equal(await newButton(page).textContent(), "↓ new", "a later arrival keeps \"↓ new\"");
	assert.ok(Math.abs(await scrollTop(page) - top) <= 2, "a later arrival keeps the reader's place");
});

test("scroll hold: a branch summary that replaces the newest entry starts the count again", async (t) => {
	const { page, send } = await open(t, 200);
	await scrollAway(page);
	// Pi moved the Session to another branch at e190: its window ends in a branch summary and the new branch's entries.
	const branch = (n: number) => ({ ...view(191), entries: [...entries(191), { id: "m1", kind: "compaction", reason: "branch", summary: "Left branch" }, ...Array.from({ length: n }, (_, i) => ({ id: `b${i}`, kind: "user", text: `Branch ${i}`, images: 0 }))] });
	send(branch(10));
	await page.locator("[data-entry=b9]").waitFor({ state: "attached" });
	await frames(page);
	assert.ok(await gap(page) > 60, "the reader is still away from the end");
	assert.equal(await newButton(page).count(), 0, "a branch change clears the count");
	send(branch(11));
	await newButton(page).getByText("↓ 1 new", { exact: true }).waitFor();
});

test("scroll hold: G returns to the end and clears \"↓ N new\"; Escape leaves it", async (t) => {
	const { page, publish } = await open(t, 200);
	await scrollAway(page);
	for (const n of [201, 202, 203]) await publish(n);
	await newButton(page).getByText("↓ 3 new", { exact: true }).waitFor();
	await page.locator("[data-region=transcript]").focus();
	const away = await gap(page);
	await page.keyboard.press("Escape");
	await frames(page);
	assert.equal(await newButton(page).textContent(), "↓ 3 new", "Escape keeps the count");
	assert.ok(Math.abs(await gap(page) - away) <= 2, "Escape does not scroll");
	await page.keyboard.press("Shift+G");
	await frames(page);
	assert.ok(await gap(page) <= 2, "G returns to the newest end");
	assert.equal(await newButton(page).count(), 0, "G clears the count");
	await publish(204);
	assert.ok(await gap(page) <= 2, "after G the reader follows arriving entries");
	assert.equal(await newButton(page).count(), 0, "a following reader sees no count");
});

test("scroll hold: a source window that drops the held first entry keeps a mid-thread reader's entry in place", async (t) => {
	const { page, publish } = await open(t, 200);
	// The reader scrolls up until the paint window holds the whole served window, then reads mid-thread.
	const painted = () => page.locator("[data-region=transcript] [data-entry]").count();
	await page.evaluate(() => { document.querySelector<HTMLElement>("[data-region=transcript]")!.scrollTop = 0; });
	await page.waitForFunction(() => document.querySelectorAll("[data-region=transcript] [data-entry]").length === 200);
	await page.evaluate(() => {
		const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
		const node = el.querySelector<HTMLElement>("[data-entry=e100]")!;
		el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - 40;
	});
	await frames(page);
	assert.equal(await painted(), 200);
	const before = await anchor(page);
	// The Pi Host serves at most 300 entries: later rounds drop e0, the held first entry, and the entries after it.
	for (const [n, from] of [[300, 0], [350, 50], [380, 80]] as const) {
		await publish(n, "", from);
		const offset = await offsetOf(page, before.id);
		assert.ok(offset !== null && Math.abs(offset - before.offset) <= 2, `after ${n} entries from e${from}, ${before.id} moved from ${before.offset.toFixed(1)} to ${offset?.toFixed(1)}`);
	}
});

/** Tool traffic and Team messages, as a busy agent writes them. */
const traffic = (k: number) => k % 3 === 2
	? [{ id: `m${k}`, kind: "custom", entryKind: "team-update", message: { kind: "team-update", label: "Team", sender: "lead", text: `Team message ${k}` } }]
	: [
		{ id: `c${k}`, kind: "assistant", blocks: [{ type: "tool", callId: `call${k}`, name: "bash", args: { command: `ls ${k}` } }] },
		{ id: `r${k}`, kind: "tool-result", callId: `call${k}`, name: "bash", isError: false, text: `output ${k}`, truncated: false },
	];

test("scroll hold: conversation-only folds arriving tool calls and Team messages without moving a reader one or two screens up", async (t) => {
	const { page, send } = await open(t, 200);
	await page.getByRole("button", { name: "Transcript lens: full transcript" }).click();
	await frames(page);
	await page.locator('[aria-label="Transcript lens: conversation only"]').waitFor({state:"attached"});
	await page.locator("[data-region=transcript]").hover();
	await page.mouse.wheel(0, -1000);
	await frames(page);
	assert.ok(await gap(page) > 600 && await gap(page) < 1400, `the reader is one or two screens up: gap ${await gap(page)}`);
	const before = await anchor(page);
	// Five tool calls and two Team messages, one entry at a time.
	const extra: unknown[] = [];
	for (let k = 0; k < 7; k++) {
		for (const item of traffic(k)) {
			extra.push(item);
			send({ ...view(200), entries: [...entries(200), ...extra] });
			await page.waitForTimeout(30);
			await frames(page);
			const offset = await offsetOf(page, before.id);
			assert.ok(offset !== null && Math.abs(offset - before.offset) <= 2, `after ${(item as { id: string }).id}, ${before.id} moved from ${before.offset.toFixed(1)} to ${offset?.toFixed(1)}`);
		}
	}
});

const splitEntries = () => entries(200).map((entry, i) => entry.kind === "assistant" ? { ...entry, blocks: [
	{ type: "text", text: `Answer ${i}. ${"Details. ".repeat(30)}` },
	{ type: "tool", callId: `mixed${i}`, name: "bash", args: { command: "pwd" } },
	{ type: "text", text: `After tool ${i}. ${"More details. ".repeat(30)}` },
] } : entry);

for (const operation of ["open fold growth", "lens round trip"] as const) test(`scroll hold: split fragment survives ${operation}`, async (t) => {
	const {page, send} = await open(t, 200);
	const mixed: any[] = splitEntries();
	if (operation === "open fold growth") for (let i=192;i<240;i++) mixed[i]={id:`e${i}`,kind:'compaction',summary:'Context kept'};
	const publish = () => send({...view(200),entries:mixed,live:{run:{startedAt:1}}});
	publish(); await frames(page);
	await page.getByRole("button", {name:"Transcript lens: full transcript"}).click(); await frames(page);
	if (operation === "open fold growth") { await page.locator('.rb-tools').last().locator(':scope > summary').click(); await frames(page); }
	const fragment = page.locator('.md').filter({hasText:operation === "open fold growth" ? "Answer 191." : "After tool 191."});
	const position = () => fragment.evaluate(node=>node.getBoundingClientRect().top-document.querySelector('[data-region=transcript]')!.getBoundingClientRect().top);
	await fragment.evaluate(node=>{ const el=document.querySelector<HTMLElement>('[data-region=transcript]')!;el.scrollTop+=node.getBoundingClientRect().top-el.getBoundingClientRect().top-20; });
	await frames(page);
	if (operation === "open fold growth") {
		const fold=page.locator('.rb-tools').filter({has:page.locator('summary [data-entry=e191]')});
		await fold.locator(':scope > summary').click(); await frames(page);
		const before=await position();
		assert.ok(await gap(page)>600,'reader stays above the end while the open fold grows');
		const oldHeight=await fold.evaluate(node=>node.getBoundingClientRect().height);
		const entry=mixed[191] as any;
		entry.blocks[1].args.command="pwd\n".repeat(30);
		publish();await frames(page);
		assert.ok(await fold.evaluate(node=>node.getBoundingClientRect().height)>oldHeight+100,'the open running fold grows below the reader');
		assert.ok(Math.abs(await position()-before)<=2,`growth between the fragment and next unique entry moved the fragment ${before} -> ${await position()}`);
	} else {
		const before=await position();
		await page.getByRole('button',{name:'Transcript lens: conversation only'}).click(); await frames(page);
		await page.getByRole('button',{name:'Transcript lens: full transcript'}).click(); await frames(page);
		assert.ok(Math.abs(await position()-before)<=2,`lens round trip moved split prose from ${before} to ${await position()}`);
	}
});

test("scroll hold: Back restores the saved entry place without persisting DOM references", async (t) => {
	const {page} = await open(t, 200);
	await scrollAway(page);
	await page.waitForFunction(() => Boolean(history.state?.place));
	const before = await scrollTop(page);
	const place = await page.evaluate(() => history.state.place);
	assert.deepEqual(Object.keys(place).sort(), ["id", "key", "limit", "offset", "unit"]);
	await page.evaluate(() => { location.hash = "#another-place"; });
	await frames(page);
	await page.mouse.wheel(0, 400);
	await frames(page);
	assert.ok(Math.abs(await scrollTop(page)-before)>200);
	await page.goBack();
	await frames(page);
	assert.ok(Math.abs(await scrollTop(page)-before)<=2, "Back restores the entry-level saved place");
});

test("scroll hold: Back to a split entry restores the after-tool fragment", async (t) => {
	const {page, send} = await open(t, 200);
	send({...view(200),entries:splitEntries()}); await frames(page);
	await page.getByRole('button',{name:'Transcript lens: full transcript'}).click(); await frames(page);
	const fragment=page.locator('.msg.assistant[data-entry=e191]').last();
	assert.ok((await fragment.textContent())?.includes('After tool 191.'));
	await fragment.evaluate(node=>{const el=document.querySelector<HTMLElement>('[data-region=transcript]')!;el.scrollTop+=node.getBoundingClientRect().top-el.getBoundingClientRect().top+10;});
	await frames(page);
	await page.waitForFunction(()=>history.state?.place?.id==='e191');
	const before=await scrollTop(page);
	const position=()=>fragment.evaluate(node=>node.getBoundingClientRect().top-document.querySelector('[data-region=transcript]')!.getBoundingClientRect().top);
	const offset=await position();
	assert.deepEqual(await page.evaluate(()=>Object.keys(history.state.place).sort()),['id','key','limit','offset','unit']);
	await page.evaluate(()=>{location.hash='#another-place';}); await frames(page);
	await page.mouse.move(500,300); await page.mouse.wheel(0,400); await frames(page);
	assert.ok(Math.abs(await scrollTop(page)-before)>200);
	await page.goBack(); await frames(page);
	assert.ok(Math.abs(await position()-offset)<=2,`Back moved after-tool fragment from ${offset} to ${await position()}`);
});

test("scroll hold: conversation-only stays still for ten seconds with a running fold and no arrivals", async (t) => {
	const { page, send } = await open(t, 200);
	const mixed = splitEntries();
	send({ ...view(200), entries: [...mixed, ...traffic(201)], live: { run: { startedAt: Date.now() } } });
	await frames(page);
	await page.evaluate(() => {
		const calls: unknown[] = [];
		(window as any).scrollCalls = calls;
		const record = (kind: string, target: Element, value: unknown) => calls.push({kind, target: target.getAttribute("data-region") || target.tagName, value, top: target.scrollTop, stack: new Error().stack});
		const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
		Object.defineProperty(Element.prototype, "scrollTop", { ...descriptor, set(value) { record("scrollTop", this, value); descriptor.set!.call(this, value); } });
		for (const name of ["scrollTo", "scrollBy", "scrollIntoView"] as const) {
			const original = Element.prototype[name];
			(Element.prototype as any)[name] = function (...args: unknown[]) { record(name, this, args); return (original as any).apply(this, args); };
		}
		const focus = HTMLElement.prototype.focus;
		HTMLElement.prototype.focus = function (options) { record("focus", this, options); return focus.call(this, options); };
	});
	await page.locator("[data-region=transcript]").hover();
	await page.mouse.wheel(0, -1000);
	await frames(page);
	await page.getByRole("button", { name: "Transcript lens: full transcript" }).click();
	await frames(page);
	await page.locator('[aria-label="Transcript lens: conversation only"]').waitFor({state:"attached"});
	// A mode toggle may change geometry. Once it settles, no new source data or reader action occurs.
	const read = () => page.evaluate(() => { const el = document.querySelector<HTMLElement>("[data-region=transcript]")!; return {top:el.scrollTop,height:el.scrollHeight,rows:el.querySelectorAll("[data-entry]").length}; });
	const before = await read();
	assert.ok(await gap(page) > 600 && await gap(page) < 1400, `reader one or two screens up: ${await gap(page)}`);
	assert.ok((await page.locator('.rb-tools').last().textContent())?.includes('running'), 'last fold is running');
	await page.evaluate(() => { (window as any).scrollCalls.length = 0; (window as any).parentTicks = true; });
	await page.waitForTimeout(10000);
	const after = await read();
	const calls = await page.evaluate(() => (window as any).scrollCalls);
	assert.equal(after.height, before.height);
	assert.equal(after.rows, before.rows);
	assert.ok(Math.abs(after.top-before.top)<=2, `idle fold drift ${JSON.stringify({before,after,calls:calls.slice(0,3)})}`);
	assert.equal(calls.filter((call: any) => call.kind === 'scrollTop' && Math.abs(call.value-call.top)>2).length, 0, 'no transient scroll corrections without a geometry change');
});

/** One arrival at a time, as a busy agent writes them: a reply that streams, tool traffic, and a Team message. */
const arrivals = () => {
	const steps: unknown[][] = [];
	const extra: unknown[] = [];
	for (let k = 0; k < 4; k++) {
		for (const item of traffic(k)) { extra.push(item); steps.push([...extra]); }
		for (const text of [`Reply ${k}.`, `Reply ${k}.\n\n${"Streaming words. ".repeat(30)}`]) {
			const reply = { id: `a${k}`, kind: "assistant", blocks: [{ type: "text", text }] };
			if (extra.at(-1) && (extra.at(-1) as { id: string }).id === reply.id) extra[extra.length - 1] = reply; else extra.push(reply);
			steps.push([...extra]);
		}
	}
	return steps;
};
const CAP = 400;
for (const [backend, lens] of [["pi", false], ["pi", true]] as const) {
	for (const place of ["one or two screens up", "mid-thread"] as const) {
		test(`scroll hold: at the ${CAP}-entry source cap, ${backend}${lens ? " conversation-only" : ""}, each arrival evicts the oldest entry and a reader ${place} stays in place`, async (t) => {
			const { page, send } = await open(t, CAP, backend);
			if (lens) { await page.getByRole("button", { name: "Transcript lens: full transcript" }).click(); await frames(page); }
			if (place === "mid-thread") {
				// The reader scrolls up until the paint window holds the whole served window: its held first entry is the oldest.
				await page.waitForFunction(async () => {
					const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
					el.scrollTop = 0;
					await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
					return el.querySelectorAll("[data-entry=e0]").length === 1;
				}, undefined, { polling: 100 });
				await page.evaluate(() => {
					const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
					const node = el.querySelector<HTMLElement>("[data-entry=e200]")!;
					el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - 40;
				});
			} else {
				await page.locator("[data-region=transcript]").hover();
				await page.mouse.wheel(0, -1000);
			}
			await frames(page);
			await page.waitForTimeout(100);
			const before = await anchor(page);
			for (const extra of arrivals()) {
				send({ ...view(CAP), entries: [...entries(CAP), ...extra].slice(-CAP), hiddenBefore: true });
				await page.waitForTimeout(30);
				await frames(page);
				const offset = await offsetOf(page, before.id);
				assert.ok(offset !== null && Math.abs(offset - before.offset) <= 2, `after ${(extra.at(-1) as { id: string }).id} (${extra.length} arrived), ${before.id} moved from ${before.offset.toFixed(1)} to ${offset?.toFixed(1)}`);
			}
		});
	}
}
for (const [backend, lens] of [["pi", false], ["pi", true]] as const) {
	test(`scroll hold: at the ${CAP}-entry source cap, ${backend}${lens ? " conversation-only" : ""}, batches of 120 that evict the held first entry keep a reader near the window top in place`, async (t) => {
		const { page, send } = await open(t, CAP, backend);
		if (lens) { await page.getByRole("button", { name: "Transcript lens: full transcript" }).click(); await frames(page); }
		await page.evaluate(() => { document.querySelector<HTMLElement>("[data-region=transcript]")!.scrollTop = 300; });
		await frames(page);
		await page.waitForTimeout(100);
		const before = await anchor(page);
		for (let round = 1; round <= 3; round++) {
			const n = CAP + 120 * round;
			send({ ...view(n, "", n - CAP), hiddenBefore: true });
			await newButton(page).waitFor();
			await page.waitForTimeout(30);
			await frames(page);
			const offset = await offsetOf(page, before.id);
			assert.ok(offset !== null && Math.abs(offset - before.offset) <= 2, `after round ${round}, ${before.id} moved from ${before.offset.toFixed(1)} to ${offset?.toFixed(1)}`);
		}
	});
}

/** Painted rows, and painted rows the source window no longer serves (ids e0..e(from-1)). */
const rows = (page: Page, from: number) => page.evaluate((from) => {
	const ids = [...document.querySelectorAll<HTMLElement>("[data-region=transcript] [data-entry]")].map((n) => n.dataset.entry!);
	return { painted: ids.length, retained: ids.filter((id) => /^e\d+$/.test(id) && Number(id.slice(1)) < from).length };
}, from);
for (const backend of ["pi"] as const) {
	test(`scroll hold: ${backend}, thousands of arrivals while the reader is away paint nothing past the frozen window; G cleans up`, async (t) => {
		const { page, send } = await open(t, CAP, backend);
		await page.locator("[data-region=transcript]").hover();
		await page.mouse.wheel(0, -1000);
		await frames(page);
		await page.waitForTimeout(100);
		const before = await anchor(page);
		const first = await rows(page, 0);
		let peak = 0;
		// 3,000 arrivals in snapshots of 25 at the source cap: the source window moves past every painted row.
		for (let n = CAP + 25; n <= CAP + 3000; n += 25) {
			send({ ...view(n, "", n - CAP), hiddenBefore: true });
			await page.waitForTimeout(15);
			await frames(page);
			const now = await rows(page, n - CAP);
			peak = Math.max(peak, now.painted);
			assert.ok(now.painted <= first.painted, `after ${n} entries the window painted ${now.painted} rows, more than the ${first.painted} it froze`);
			const offset = await offsetOf(page, before.id);
			assert.ok(offset !== null && Math.abs(offset - before.offset) <= 2, `after ${n} entries, ${before.id} moved from ${before.offset.toFixed(1)} to ${offset?.toFixed(1)}`);
		}
		const end = await rows(page, 3000);
		assert.equal(end.retained, end.painted, "every painted row is retained after the source moved past it");
		assert.ok(end.painted <= first.painted, `retained rows plateau at the frozen window: ${end.painted} of ${first.painted}`);
		await newButton(page).getByText("↓ new", { exact: true }).waitFor();
		// The reader scrolls to the frozen bottom: the window extends into the served tail behind a divider that names the
		// entries the source dropped unpainted, and the read entry stays put.
		const read = await page.evaluate(() => {
			const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
			el.scrollTop = el.scrollHeight - el.clientHeight - 100;
			const top = el.getBoundingClientRect().top;
			const node = [...el.querySelectorAll<HTMLElement>("[data-entry]")].find((n) => n.getBoundingClientRect().bottom > top + 40)!;
			return { id: node.dataset.entry!, offset: node.getBoundingClientRect().top - top };
		});
		await page.locator(`[data-entry="e3000"]`).waitFor({ state: "attached" });
		await frames(page);
		const divider = page.locator("[data-region=transcript] .omitted");
		assert.equal(await divider.count(), 1, "one divider marks the dropped entries");
		assert.equal((await divider.textContent())?.trim(), "Some entries after this one were never shown here. ↓ new goes to the newest.");
		assert.equal(await page.locator("[data-region=transcript] .compaction.omitted").count(), 0, "the divider never reads as a compaction notice");
		const still = await offsetOf(page, read.id);
		assert.ok(still !== null && Math.abs(still - read.offset) <= 2, `the extension moved ${read.id} from ${read.offset.toFixed(1)} to ${still?.toFixed(1)}`);
		assert.ok((await rows(page, 3000)).painted <= first.painted + 120, "one extension paints at most one window more");
		// Reading on down through the served tail: rows more than one window above the read entry go, so the paint window
		// stays bounded while each extension keeps the read entry in place.
		for (let step = 1; step <= 2; step++) {
			const last = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-region=transcript] [data-entry]")].at(-1)!.dataset.entry!);
			const at = await page.evaluate(() => {
				const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
				el.scrollTop = el.scrollHeight - el.clientHeight - 100;
				const top = el.getBoundingClientRect().top;
				const node = [...el.querySelectorAll<HTMLElement>("[data-entry]")].find((n) => n.getBoundingClientRect().bottom > top + 40)!;
				return { id: node.dataset.entry!, offset: node.getBoundingClientRect().top - top };
			});
			await page.locator(`[data-entry="e${Number(last.slice(1)) + 1}"]`).waitFor({ state: "attached" });
			await frames(page);
			const offset = await offsetOf(page, at.id);
			assert.ok(offset !== null && Math.abs(offset - at.offset) <= 2, `extension ${step} moved ${at.id} from ${at.offset.toFixed(1)} to ${offset?.toFixed(1)}`);
			const now = await rows(page, 3000);
			assert.ok(now.painted <= 2 * 120 + 1 + 120, `extension ${step} painted ${now.painted} rows`);
		}
		await page.locator("[data-region=transcript]").focus();
		await page.keyboard.press("Shift+G");
		await page.locator(`[data-entry="e${CAP + 2999}"]`).waitFor({ state: "attached" });
		await frames(page);
		assert.ok(await gap(page) <= 2, "G returns to the newest end");
		const tail = await rows(page, 3000);
		assert.equal(tail.retained, 0, "G drops the retained rows");
		assert.ok(tail.painted <= CAP, `G paints the current tail only: ${tail.painted}`);
		assert.equal(await newButton(page).count(), 0, "G clears the count");
	});
}

test("scroll hold: scrolling to the bottom of a frozen window extends it downward and keeps the read entry in place", async (t) => {
	const { page, send } = await open(t, 200);
	await scrollAway(page);
	send({ ...view(320) });
	await newButton(page).getByText("↓ 120 new", { exact: true }).waitFor();
	await frames(page);
	assert.equal(await page.locator("[data-entry=e200]").count(), 0, "arrivals past the frozen window do not paint");
	// The reader scrolls to near the bottom of the frozen window; the anchor is measured before the scroll event.
	const before = await page.evaluate(() => {
		const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
		el.scrollTop = el.scrollHeight - el.clientHeight - 100;
		const top = el.getBoundingClientRect().top;
		const node = [...el.querySelectorAll<HTMLElement>("[data-entry]")].find((n) => n.getBoundingClientRect().bottom > top + 40)!;
		return { id: node.dataset.entry!, offset: node.getBoundingClientRect().top - top };
	});
	await page.locator("[data-entry=e200]").waitFor({ state: "attached" });
	await frames(page);
	const offset = await offsetOf(page, before.id);
	assert.ok(offset !== null && Math.abs(offset - before.offset) <= 2, `the extension moved ${before.id} from ${before.offset.toFixed(1)} to ${offset?.toFixed(1)}`);
	assert.ok(await gap(page) > 60, "the extended window keeps the reader away from the end");
	assert.equal(await newButton(page).count(), 1, "the count stays while arrivals are unread");
});

// Owner incident (AmPi macOS app): a reader near the bottom of a frozen window scrolls down while a reply streams. A
// scroll near that bottom captures the read place for the extension; the reader's later scroll must not be undone
// when the next streamed frame restores that place.
for (const engine of ENGINES) test(`scroll hold (${engine}): wheeling down a frozen window while a reply streams never snaps back`, { skip: engineSkip(engine) }, async (t) => {
	const { page, send } = await open(t, 200, "pi", engine);
	await scrollAway(page);
	send({ ...view(320) });
	await newButton(page).getByText("↓ 120 new", { exact: true }).waitFor();
	await frames(page);
	const top = () => page.evaluate(() => document.querySelector<HTMLElement>("[data-region=transcript]")!.scrollTop);
	await page.evaluate(() => { const el = document.querySelector<HTMLElement>("[data-region=transcript]")!; el.scrollTop = el.scrollHeight - el.clientHeight - 1200; });
	await frames(page);
	const box = (await page.locator("[data-region=transcript]").boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	let last = await top();
	for (let step = 1; step <= 16; step++) {
		await page.mouse.wheel(0, 120);
		await frames(page);
		send(view(320, grown(step)));
		await page.waitForTimeout(30);
		await frames(page);
		const now = await top();
		assert.ok(now >= last + 100, `step ${step}: the wheel moved down 120; scrollTop ${last} -> ${now}`);
		last = now;
	}
	assert.equal(await newButton(page).count(), 1, "the reader is still away; \"↓ new\" stays");
});

// The same incident at its narrowest: the reader scrolls on 300 px after the scroll that captured the place, before
// the extension renders. The reader's scroll wins: the extension keeps it, and later streamed frames do too.
for (const engine of ENGINES) test(`scroll hold (${engine}): a scroll after the extension's capture is kept when the extension renders`, { skip: engineSkip(engine) }, async (t) => {
	const { page, send } = await open(t, 200, "pi", engine);
	await scrollAway(page);
	send({ ...view(320) });
	await newButton(page).getByText("↓ 120 new", { exact: true }).waitFor();
	await frames(page);
	const moved = await page.evaluate(() => new Promise<{ from: number; to: number }>((done) => {
		const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
		el.addEventListener("scroll", () => {
			const from = el.scrollTop;
			el.scrollTop = from + 300;
			done({ from, to: el.scrollTop });
		}, { once: true });
		el.scrollTop = el.scrollHeight - el.clientHeight - 300;
	}));
	assert.ok(moved.to >= moved.from + 299, `the reader scrolled on; ${JSON.stringify(moved)}`);
	await page.locator("[data-entry=e200]").waitFor({ state: "attached" });
	await frames(page);
	const top = () => page.evaluate(() => document.querySelector<HTMLElement>("[data-region=transcript]")!.scrollTop);
	assert.ok(await top() >= moved.to - 1, `the extension kept the reader's scroll; ${moved.to} -> ${await top()}`);
	for (let step = 1; step <= 4; step++) {
		send(view(320, grown(step)));
		await page.waitForTimeout(30);
		await frames(page);
		assert.ok(await top() >= moved.to - 1, `frame ${step} kept the reader's scroll; ${moved.to} -> ${await top()}`);
	}
	assert.equal(await newButton(page).count(), 1, "the reader is still away; \"↓ new\" stays");
});

test("scroll hold: a source window with no overlap retains no stale rows; \"↓ new\" is the way back", async (t) => {
	const { page, publish } = await open(t, 200);
	await scrollAway(page);
	// A reconnect gap wider than everything painted: e1000..e1199 shares no entry with the window the reader left.
	await publish(1200, "", 1000);
	await newButton(page).getByText("↓ new", { exact: true }).waitFor();
	const now = await rows(page, 1000);
	assert.equal(now.retained, 0, "no row of the old window is retained");
	assert.ok(now.painted <= 200, `only the new window paints: ${now.painted}`);
	await newButton(page).click();
	await frames(page);
	assert.ok(await gap(page) <= 2, "the button returns to the newest end");
	assert.equal(await newButton(page).count(), 0, "the count clears at the end");
});

test("scroll hold: a busy thread shows \"working…\" to a reader away from the end; G clears it", async (t) => {
	const { page, send } = await open(t, 200);
	await scrollAway(page);
	const status = page.locator("[data-region=transcript] .new-below");
	const live = (text: string) => ({ run: { id: "r1" }, generation: { message: { role: "assistant", content: [{ type: "text", text }] } } });
	// The answer only streams: no entry completes, so no count, but the reader cannot see the live output.
	send({ ...view(200), live: live("Streaming") });
	await status.getByText("working…", { exact: true }).waitFor();
	assert.equal(await status.getByRole("button").count(), 0, "no control before an entry arrives");
	send({ ...view(201), live: live("Streaming more") });
	await status.getByRole("button", { name: "↓ 1 new · working…" }).waitFor();
	await page.locator("[data-region=transcript]").focus();
	await page.keyboard.press("Shift+G");
	await frames(page);
	assert.ok(await gap(page) <= 2, "G returns to the newest end");
	assert.equal((await status.textContent())?.trim(), "", "at the end the status row is empty");
});

/** Entries e{from}..e{n-1}, all assistant: prose, a tool call, and prose after the tool. No entry id paints only once. */
const splitWindow = (n: number, from: number) => ({ ...view(n, "", from), hiddenBefore: from > 0, entries: Array.from({ length: n - from }, (_, k) => {
	const id = `e${from + k}`;
	return { id, kind: "assistant", blocks: [
		{ type: "text", text: `Answer ${id}. ${"Details. ".repeat(4 + (k % 5) * 4)}` },
		{ type: "tool", callId: `split-${id}`, name: "bash", args: { command: "pwd" } },
		{ type: "text", text: `After tool ${id}. ${"More details. ".repeat(4 + (k % 3) * 6)}` },
	] };
}) });
for (const [backend, lens] of [["pi", false], ["pi", true]] as const) {
	for (const place of ["at the clamped bottom", "inside the extension band"] as const) {
		test(`scroll hold: ${backend}${lens ? " conversation-only" : ""}, a downward extension keeps a read after-tool fragment ${place} in place`, async (t) => {
			const { page, send } = await open(t, CAP, backend);
			send(splitWindow(CAP, 0));
			await page.locator("[data-region=transcript] .md", { hasText: `After tool e${CAP - 1}.` }).waitFor({ state: "attached" });
			await frames(page);
			if (lens) {
				await page.getByRole("button", { name: "Transcript lens: full transcript" }).click();
				await page.locator('[aria-label="Transcript lens: conversation only"]').waitFor({ state: "attached" });
				await frames(page);
			}
			await page.evaluate(() => { document.querySelector<HTMLElement>("[data-region=transcript]")!.scrollTop = 300; });
			await frames(page);
			await page.waitForTimeout(100);
			// 960 arrivals in source windows of the cap: the source moves past every frozen row.
			for (let n = CAP + 120; n <= CAP + 960; n += 120) {
				send(splitWindow(n, n - CAP));
				await newButton(page).waitFor();
				await page.waitForTimeout(30);
				await frames(page);
			}
			// The reader reads an after-tool fragment near the frozen bottom: the last one lands clamped at the bottom; a reader
			// 300 px above the bottom stays inside the 600 px extension band without a clamp.
			const before = await page.evaluate((clamped) => {
				const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
				const fragments = () => [...el.querySelectorAll<HTMLElement>(".md")].filter((node) => node.textContent!.startsWith("After tool"));
				if (clamped) { const node = fragments().at(-1)!; el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - 20; }
				else el.scrollTop = el.scrollHeight - el.clientHeight - 300;
				const top = el.getBoundingClientRect().top;
				const node = fragments().find((node) => node.getBoundingClientRect().top >= top)!;
				return { text: node.textContent!.split(".")[0] + ".", offset: node.getBoundingClientRect().top - top, gap: el.scrollHeight - el.scrollTop - el.clientHeight };
			}, place === "at the clamped bottom");
			const text = before.text;
			if (place === "at the clamped bottom") assert.ok(before.gap <= 1, `the reader is clamped at the frozen bottom: gap ${before.gap}`);
			else assert.ok(before.gap > 1 && before.gap < 600, `the reader is inside the band and not clamped: gap ${before.gap}`);
			await page.locator(".omitted").waitFor({ state: "attached" });
			await page.waitForTimeout(30);
			await frames(page);
			const after = await page.locator("[data-region=transcript] .md").filter({ hasText: text }).evaluate((node) => node.getBoundingClientRect().top - document.querySelector<HTMLElement>("[data-region=transcript]")!.getBoundingClientRect().top);
			assert.ok(Math.abs(after - before.offset) <= 2, `the extension moved "${text}" from ${before.offset.toFixed(1)} to ${after.toFixed(1)}`);
		});
	}
}
for (const [backend, lens] of [["pi", false], ["pi", true]] as const) {
	test(`scroll hold: ${backend}${lens ? " conversation-only" : ""}, a trim that drops the whole first segment keeps the read fragment`, async (t) => {
		const { page, send } = await open(t, CAP, backend);
		send(splitWindow(CAP, 0));
		await page.locator("[data-region=transcript] .md", { hasText: `After tool e${CAP - 1}.` }).waitFor({ state: "attached" });
		await frames(page);
		if (lens) {
			await page.getByRole("button", { name: "Transcript lens: full transcript" }).click();
			await page.locator('[aria-label="Transcript lens: conversation only"]').waitFor({ state: "attached" });
			await frames(page);
		}
		await page.evaluate(() => { document.querySelector<HTMLElement>("[data-region=transcript]")!.scrollTop = 300; });
		await frames(page);
		await page.waitForTimeout(100);
		for (let n = CAP + 120; n <= CAP + 960; n += 120) {
			send(splitWindow(n, n - CAP));
			await newButton(page).waitFor();
			await page.waitForTimeout(30);
			await frames(page);
		}
		// Three extensions below the divider after e399: the third trims every row of the first segment away.
		for (const next of [1079, 1199, 1319]) {
			const before = await page.evaluate(() => {
				const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
				const node = [...el.querySelectorAll<HTMLElement>(".md")].filter((node) => node.textContent!.startsWith("After tool")).at(-1)!;
				el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - 20;
				(node as HTMLElement & { read?: boolean }).read = true;
				return { text: node.textContent!.split(".")[0] + ".", offset: node.getBoundingClientRect().top - el.getBoundingClientRect().top };
			});
			await page.locator("[data-region=transcript] .md", { hasText: `After tool e${next}.` }).waitFor({ state: "attached" });
			await page.waitForTimeout(30);
			await frames(page);
			const after = await page.locator("[data-region=transcript] .md").filter({ hasText: before.text }).evaluate((node) => ({
				offset: node.getBoundingClientRect().top - document.querySelector<HTMLElement>("[data-region=transcript]")!.getBoundingClientRect().top,
				same: Boolean((node as HTMLElement & { read?: boolean }).read),
			}));
			assert.ok(after.same, `the extension to e${next} remounted the read fragment "${before.text}"`);
			assert.ok(Math.abs(after.offset - before.offset) <= 2, `the extension to e${next} moved "${before.text}" from ${before.offset.toFixed(1)} to ${after.offset.toFixed(1)}`);
		}
		assert.equal(await page.locator("[data-region=transcript] .md", { hasText: "After tool e399." }).count(), 0, "the trim dropped the first segment");
	});
}
