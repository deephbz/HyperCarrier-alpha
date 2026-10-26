import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ENGINES, frames, open, view } from "./thread-scroll-fixture.ts";
import { engineSkip } from "./engines.ts";

for (const engine of ENGINES) test(`transcript mode keeps the reading place within 1 px and restores the browser default after reload (${engine}, zoom 1.3)`, { skip: engineSkip(engine) }, async (t) => {
	const { page, send } = await open(t, 180, "pi", engine, 1.3);
	const fixture = view(180);
	fixture.live = { run: {} };
	fixture.entries.push(
		{ id: "test-tool-call", kind: "assistant", blocks: [{ type: "tool", callId: "test-call", name: "bash", args: { command: "true" } }] },
		{ id: "test-tool-result", kind: "tool-result", callId: "test-call", name: "bash", isError: true, text: "transcript tool output", truncated: false },
	);
	send(fixture);
	const scroller = page.locator('[data-region="transcript"]');
	const composer = page.locator('[data-region="composer"] textarea');
	await composer.fill("unsent transcript-mode draft");
	await composer.focus();
	await page.keyboard.press("Control+T");
	await page.getByRole("button", { name: "Transcript mode: conversation only" }).waitFor();
	assert.equal(await composer.evaluate((node) => node === document.activeElement), true, "Ctrl+T keeps Composer focus");
	assert.equal(await composer.inputValue(), "unsent transcript-mode draft");
	await page.keyboard.press("l");
	assert.equal(await page.getByRole("button", { name: "Transcript mode: conversation only" }).count(), 1, "L does not toggle in Composer");
	assert.equal(await composer.inputValue(), "unsent transcript-mode draftl");
	await composer.fill("unsent transcript-mode draft");
	await composer.focus();
	await composer.evaluate((node) => {
		(window as any).webkit = { messageHandlers: { ampi: { postMessage() {} } } };
		node.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyT", key: "t", metaKey: true, bubbles: true }));
		delete (window as any).webkit;
	});
	await page.getByRole("button", { name: "Transcript mode: full transcript" }).waitFor();
	assert.equal(await composer.evaluate((node) => node === document.activeElement), true, "Cmd+T keeps Composer focus in app mode");
	assert.equal(await composer.inputValue(), "unsent transcript-mode draft");
	const control = page.getByRole("button", { name: "Transcript mode: full transcript" });
	await page.evaluate(() => { const el = document.querySelector<HTMLElement>('[data-region="transcript"]')!; el.scrollTop = 850; });
	await frames(page);
	const anchor = async () => page.evaluate(() => {
		const el = document.querySelector<HTMLElement>('[data-region="transcript"]')!;
		const box = el.getBoundingClientRect();
		const node = [...el.querySelectorAll<HTMLElement>("[data-entry]")].find((entry) => entry.getBoundingClientRect().bottom > box.top)!;
		return { id: node.dataset.entry, offset: node.getBoundingClientRect().top - box.top };
	});
	const before = await anchor();
	await page.getByText("transcript tool output").waitFor();
	await control.click();
	await page.getByRole("button", { name: "Transcript mode: conversation only" }).waitFor();
	await frames(page);
	const after = await page.locator(`[data-entry="${before.id}"]`).evaluate((node) => {
		const el = document.querySelector<HTMLElement>('[data-region="transcript"]')!;
		return node.getBoundingClientRect().top - el.getBoundingClientRect().top;
	});
	assert.ok(Math.abs(after - before.offset) <= 1, `anchor drift ${before.offset} → ${after}`);
	const folded = page.locator(".rb-tools summary");
	await folded.getByText("running · bash").waitFor();
	await folded.getByText("1 tool call").waitFor();
	await folded.getByText("1 error").waitFor();
	assert.equal(await page.getByText("transcript tool output").isVisible(), false, "conversation mode folds tool output");
	const reverse = await anchor();
	await page.getByRole("button", { name: "Transcript mode: conversation only" }).click();
	await page.getByText("transcript tool output").waitFor();
	const reverseAfter = await page.locator(`[data-entry="${reverse.id}"]`).evaluate((node) => {
		const el = document.querySelector<HTMLElement>('[data-region="transcript"]')!;
		return node.getBoundingClientRect().top - el.getBoundingClientRect().top;
	});
	assert.ok(Math.abs(reverseAfter - reverse.offset) <= 1, `reverse anchor drift ${reverse.offset} → ${reverseAfter}`);
	assert.equal(await page.evaluate(() => localStorage.getItem("ampi.transcript.mode")), "full");
	await page.getByRole("button", { name: "Transcript mode: full transcript" }).click();
	await page.getByRole("button", { name: "Transcript mode: conversation only" }).waitFor();
	assert.equal(await page.evaluate(() => localStorage.getItem("ampi.transcript.mode")), "conversation");
	await page.evaluate(() => { (window as any).ENTRY = "test-tool-result"; (window as any).parentTicks = true; });
	await page.locator(".rb-tools[open]").waitFor();
	await page.getByText("transcript tool output").waitFor();
	const jumpedTop = await scroller.evaluate((el) => el.scrollTop);
	await frames(page);
	assert.ok(Math.abs(await scroller.evaluate((el) => el.scrollTop) - jumpedTop) <= 1, "a link to a folded result expands the run and settles in place");
	// A reload paints a bounded window at once (never the whole history), then grows it to hold at least the window it
	// left; a window is named by its oldest painted entry. The read entry (the first one below the transcript's top)
	// never moves. Which commit paints first depends on load (the snapshot races the restore's passive effect), so a
	// MutationObserver reads every commit after its layout effects, and a scroll listener every scroll between commits; no
	// frame has to be seen.
	await page.addInitScript(() => {
		const list = () => [...document.querySelectorAll<HTMLElement>('[data-region="transcript"] [data-entry]')];
		const read = (entries: HTMLElement[], id?: string) => {
			const top = document.querySelector<HTMLElement>('[data-region="transcript"]')!.getBoundingClientRect().top;
			const node = id === undefined ? entries.find((entry) => entry.getBoundingClientRect().bottom > top) : entries.find((entry) => entry.dataset.entry === id);
			return node && { id: node.dataset.entry!, offset: node.getBoundingClientRect().top - top };
		};
		let first: { id: string; offset: number; head: string } | undefined, drift = 0;
		const measure = () => {
			const entries = list();
			if (!entries.length) return;
			first ??= { ...read(entries)!, head: entries[0].dataset.entry! };
			const now = read(entries, first.id);
			drift = Math.max(drift, now ? Math.abs(now.offset - first.offset) : Infinity);
			(window as any).__transcriptModeT3 = { first, drift, head: entries[0].dataset.entry };
		};
		new MutationObserver(measure).observe(document, { childList: true, subtree: true });
		document.addEventListener("scroll", measure, true);
	});
	const order = fixture.entries.map((entry: { id: string }) => entry.id);
	const head = (await page.locator('[data-region="transcript"] [data-entry]').first().getAttribute("data-entry"))!;
	assert.ok(order.indexOf(head) > 0, `the reader's window starts at ${head}, inside the history`);
	await page.reload();
	await scroller.waitFor();
	await page.getByRole("button", { name: "Transcript mode: conversation only" }).waitFor();
	// Complete: the window reaches back to where the reader's window started.
	await page.waitForFunction(({ order, head }) => { const at = (window as any).__transcriptModeT3?.head; return at !== undefined && order.indexOf(at) <= order.indexOf(head); }, { order, head });
	await frames(page);
	const paint = await page.evaluate(() => (window as any).__transcriptModeT3 as { first: { id: string; offset: number; head: string }; drift: number; head: string });
	assert.ok(order.indexOf(paint.head) > 0, `the grown window starts at ${paint.head}, inside the history`);
	assert.ok(order.indexOf(paint.first.head) >= order.indexOf(paint.head), `the first commit paints a bounded window: it starts at ${paint.first.head}, the grown window at ${paint.head}`);
	assert.ok(paint.drift <= 1, `reload paint moved the read entry ${paint.first.id} by ${paint.drift} px`);
});
