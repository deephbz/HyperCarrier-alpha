import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ENGINES, frames, gap, grown, newButton, offsetOf, open, scrollAway, view } from "./thread-scroll-fixture.ts";
import { engineSkip } from "./engines.ts";

// A frozen window extends downward under a reader away from the end (see thread-scroll-hold.test.ts), in both engines
// while a reply streams. thread-scroll-fragment.test.ts holds a split entry's fragment across extensions and trims.

test("scroll hold: scrolling to the bottom of a frozen window extends it downward and keeps the read entry in place", async (t) => {
	const { page, send } = await open(t, 200);
	await scrollAway(page);
	send({ ...view(320) });
	await newButton(page).getByText("↓ 120 new messages", { exact: true }).waitFor();
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
	await newButton(page).getByText("↓ 120 new messages", { exact: true }).waitFor();
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
	await newButton(page).getByText("↓ 120 new messages", { exact: true }).waitFor();
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
	await status.getByRole("button", { name: "↓ 1 new message · working…" }).waitFor();
	await page.locator("[data-region=transcript]").focus();
	await page.keyboard.press("Shift+G");
	await frames(page);
	assert.ok(await gap(page) <= 2, "G returns to the newest end");
	assert.equal((await status.textContent())?.trim(), "", "at the end the status row is empty");
});
