import "./bound.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Page } from "playwright";
import { engineSkip } from "./engines.ts";
import { anchor, ENGINES, type Engine, entries, frames, gap, newButton, offsetOf, open, scrollAway, scrollTop, streaming, view } from "./thread-scroll-fixture.ts";

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
		await newButton(page).getByText(`↓ ${n - 400} new messages`, { exact: true }).waitFor();
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
	await status.getByRole("button", { name: "↓ 3 new messages" }).waitFor();
	await publish(204);
	await status.getByRole("button", { name: "↓ 4 new messages" }).click();
	await frames(page);
	assert.ok(await gap(page) <= 2, "the click returns to the newest end");
	assert.equal(await status.getByRole("button").count(), 0, "the count clears at the end");
	await publish(206);
	assert.ok(await gap(page) <= 2, "after the click the reader follows arriving entries");
	assert.equal(await status.getByRole("button").count(), 0, "a following reader sees no count");
});

test("scroll hold: one end band; a reader who scrolls down to 30 px above the end follows arrivals, and 30 px up leaves", async (t) => {
	const { page, publish } = await open(t, 200);
	const place = (gap: number) => page.evaluate((gap) => { const el = document.querySelector<HTMLElement>("[data-region=transcript]")!; el.scrollTop = el.scrollHeight - el.clientHeight - gap; }, gap);
	await place(600);
	await frames(page);
	await place(30);
	await frames(page);
	await publish(202);
	assert.ok(await gap(page) <= 2, `a reader who scrolls down into the end band follows; gap ${await gap(page)}`);
	assert.equal(await page.locator("[data-region=transcript] [role=status] button").count(), 0, "a reader inside the end band sees no count");
	await place(30);
	await frames(page);
	await publish(204);
	assert.ok(await gap(page) >= 30, `a reader who scrolls 30 px up from the end leaves it; gap ${await gap(page)}`);
	assert.equal(await page.locator("[data-region=transcript] [role=status] button").count(), 1, "the reader who left sees the count");
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

/**
 * A page whose `replay()` delivers the last Session snapshot again from its hub socket. Called in the task of a reader's
 * scroll, it renders the Session view before that scroll's event, as any hub frame can.
 */
async function replayable(t: TestContext, engine: Engine = "chromium") {
	const opened = await open(t, 200, "pi", engine);
	await opened.page.addInitScript(() => {
		const Socket = window.WebSocket;
		let last: unknown;
		(window as any).WebSocket = class extends Socket {
			constructor(url: string | URL, protocols?: string | string[]) {
				super(url, protocols);
				this.addEventListener("message", (event) => { if (JSON.parse(String(event.data)).value?.entries) last = event.data; });
				(window as any).replay = () => this.dispatchEvent(new MessageEvent("message", { data: last }));
			}
		};
	});
	await opened.page.reload();
	await opened.page.locator("[data-entry=e199]").waitFor({ state: "attached" });
	return opened;
}

// An up scroll key leaves the end at its input, like a wheel up (thread-scroll-wheel.test.ts). Its smooth step moves no
// pixel before the next frame, so a hub frame that renders between the key and that frame still sees a reader at the end;
// following would write scrollTop and cancel the step (failure: K1 journey on a busy hub, k did not scroll up).
test("scroll hold: an up scroll key leaves the end before a render in the same task", async (t) => {
	const { page } = await replayable(t);
	for (const key of ["k", "u"]) {
		await page.locator("[data-region=transcript]").focus();
		await page.keyboard.press("Shift+G");
		await frames(page);
		assert.ok(await gap(page) <= 2, "G starts the reader at the newest end");
		await page.evaluate((key) => {
			const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
			el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
			(window as any).replay();
		}, key);
		for (let i = 0; i < 20; i++) await frames(page);
		assert.ok(await gap(page) > 60, `${key} leaves the end band despite the render; gap ${await gap(page)}`);
	}
});

// Only a deliberate scroll up leaves the end at its input. The keymap's rules decide a key (isScrollKey: an editable
// target or a Ctrl or Alt chord scrolls nothing), and a pinch zoom (ctrl+wheel) or a horizontal wheel is no scroll. A
// dispatched event scrolls nothing itself, so a reader who left the end here would not follow the next arrival.
test("scroll hold: an input that scrolls nothing up keeps a reader at the end following", async (t) => {
	const { page, send } = await open(t, 200);
	await page.locator("[data-entry=e199]").waitFor({ state: "attached" });
	let n = 200;
	const kept: Record<string, boolean> = {};
	const cases = {
		"k in a text field": { key: "k", field: true },
		"Ctrl+ArrowUp": { key: "ArrowUp", ctrlKey: true },
		"Alt+ArrowUp": { key: "ArrowUp", altKey: true },
		"Ctrl+u": { key: "u", ctrlKey: true },
		"Shift+G": { key: "G", shiftKey: true },
		"ctrl+wheel up": { deltaY: -100, ctrlKey: true },
		"horizontal wheel": { deltaX: -100, deltaY: 0 },
		// Controls: a wheel up, and Cmd+↑, which scrolls a focused scroller to its top on macOS.
		"wheel up": { deltaY: -100 },
		"Cmd+ArrowUp": { key: "ArrowUp", metaKey: true },
	};
	for (const [name, input] of Object.entries(cases)) {
		await page.locator("[data-region=transcript]").focus();
		await page.keyboard.press("Shift+G");
		await frames(page);
		assert.ok(await gap(page) <= 2, `${name}: the reader starts at the newest end`);
		await page.evaluate((input) => {
			const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
			let target: HTMLElement = el;
			if ("field" in input) { target = document.createElement("input"); el.querySelector("[data-entry]")!.parentElement!.append(target); }
			target.dispatchEvent("deltaY" in input ? new WheelEvent("wheel", { ...input, bubbles: true }) : new KeyboardEvent("keydown", { ...input, bubbles: true, cancelable: true }));
			if ("field" in input) target.remove();
		}, input);
		// A following reader paints the newest entry at the end; a reader who left the end keeps a frozen window.
		n += 2;
		send(view(n));
		const painted = await page.locator(`[data-entry="e${n - 1}"]`).waitFor({ state: "attached", timeout: 1000 }).then(() => true, () => false);
		await frames(page);
		kept[name] = painted && await gap(page) <= 2;
	}
	assert.deepEqual(kept, { ...Object.fromEntries(Object.keys(cases).map((name) => [name, true])), "wheel up": false, "Cmd+ArrowUp": false });
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

test("scroll hold: a capped Pi tail counts arrivals by entry, though its length stays the same", async (t) => {
	const { page, publish } = await open(t, 200);
	await scrollAway(page);
	// The Pi Host serves the newest 200 entries: each arrival drops one entry at the window's start.
	await publish(203, "", 3);
	await newButton(page).getByText("↓ 3 new messages", { exact: true }).waitFor();
	await publish(205, "", 5);
	await newButton(page).getByText("↓ 5 new messages", { exact: true }).waitFor();
});

test("scroll hold: a last-seen entry that left the capped tail shows \"↓ new\"", async (t) => {
	const { page, publish } = await open(t, 200);
	await scrollAway(page);
	await publish(300, "", 100);
	await newButton(page).getByText("↓ 100 new messages", { exact: true }).waitFor();
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
	await newButton(page).getByText("↓ 1 new message", { exact: true }).waitFor();
});

test("scroll hold: G returns to the end and clears \"↓ N new\"; Escape leaves it", async (t) => {
	const { page, publish } = await open(t, 200);
	await scrollAway(page);
	for (const n of [201, 202, 203]) await publish(n);
	await newButton(page).getByText("↓ 3 new messages", { exact: true }).waitFor();
	await page.locator("[data-region=transcript]").focus();
	const away = await gap(page);
	await page.keyboard.press("Escape");
	await frames(page);
	assert.equal(await newButton(page).textContent(), "↓ 3 new messages", "Escape keeps the count");
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

// Only the reader moves scrollTop (scroll anchoring is off), and their scroll event comes a frame later. A render or a
// resize before that event sees the moved scrollTop first; it must treat the move as the reader's scroll, as the event
// would. A move down into the end band follows again; any move keeps its place.
for (const engine of ENGINES) test(`scroll hold (${engine}): a reader back at the end follows the next arrival after a render before the scroll event`, { skip: engineSkip(engine) }, async (t) => {
	const { page, publish } = await replayable(t, engine);
	await scrollAway(page);
	assert.ok(await gap(page) > 1000, "the reader is away from the newest end");
	await page.evaluate(() => {
		const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
		el.scrollTop = el.scrollHeight;
		(window as any).replay();
	});
	for (let i = 0; i < 5; i++) await frames(page);
	await publish(201);
	assert.equal(await newButton(page).count(), 0, "the reader at the end sees \"↓ N new\" instead of the arrival");
	assert.ok(await gap(page) <= 2, `the reader at the end did not follow the arrival; gap ${await gap(page)}`);
});

for (const engine of ENGINES) test(`scroll hold (${engine}): a resize before the scroll event keeps the reader's scroll up`, { skip: engineSkip(engine) }, async (t) => {
	const moved: Record<string, number> = {};
	for (const resize of ["Find bar", "style"]) for (const start of ["away", "end"]) {
		const { page } = await open(t, 200, "pi", engine);
		await page.locator("[data-entry=e199]").waitFor({ state: "attached" });
		if (start === "away") {
			await scrollAway(page);
			assert.ok(await gap(page) > 1000, "the reader is away from the newest end");
		} else assert.ok(await gap(page) <= 2, "the reader starts at the newest end");
		moved[`${start}, ${resize}`] = await page.evaluate(async (resize) => {
			const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
			const from = el.scrollTop;
			el.scrollTop = from - 300;
			// The Find bar renders the Session view and shrinks the transcript in one commit; a style resize renders nothing.
			if (resize === "style") el.style.maxHeight = `${el.clientHeight - 40}px`;
			else document.querySelector<HTMLButtonElement>('button[aria-label="Find in this Session"]')!.click();
			for (let i = 0; i < 5; i++) await new Promise((done) => requestAnimationFrame(done));
			return Math.round(from - el.scrollTop);
		}, resize);
	}
	assert.deepEqual(moved, { "away, Find bar": 300, "end, Find bar": 300, "away, style": 300, "end, style": 300 });
});
