import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { CAP, anchor, entries, frames, gap, newButton, offsetOf, open, scrollAway, traffic, view } from "./thread-scroll-fixture.ts";

// The Pi Host's source cap (see thread-scroll-hold.test.ts): each arrival evicts the oldest entry, thousands of
// arrivals paint nothing past a frozen window, and a window with no overlap retains no stale rows.

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
for (const [backend, lens] of [["pi", false], ["pi", true]] as const) {
	for (const place of ["one or two screens up", "mid-thread"] as const) {
		test(`scroll hold: at the ${CAP}-entry source cap, ${backend}${lens ? " conversation-only" : ""}, each arrival evicts the oldest entry and a reader ${place} stays in place`, async (t) => {
			const { page, send } = await open(t, CAP, backend);
			if (lens) { await page.getByRole("button", { name: "Chat", exact: true }).click(); await frames(page); }
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
		if (lens) { await page.getByRole("button", { name: "Chat", exact: true }).click(); await frames(page); }
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
