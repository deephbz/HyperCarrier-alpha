import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ENGINES, HOSTS, anchor, frames, gap, grown, newButton, offsetOf, open, scrollAway, scrollTop, settled, tailBelow, view } from "./thread-scroll-fixture.ts";
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

for (const engine of ENGINES) for (const backend of Object.keys(HOSTS) as (keyof typeof HOSTS)[])
for (const phone of [false, true]) for (const following of [false, true]) for (const action of ["Send", "Queue", "Steer", "Quote"] as const)
test(`send keeps view (${engine}, ${backend}, ${phone ? "phone" : "desktop"}, ${following ? "following" : "above tail"}, ${action})`, { skip: engineSkip(engine) }, async t => {
 const { page, send, answer } = await open(t, 201, backend, engine, 1, 1, phone ? { width: 390, height: 844 } : { width: 1000, height: 700 }, true);
 const current = view(201);
 if (action === "Queue" || action === "Steer") current.live = { run: { activity: "working" } };
 send(current); await frames(page);
 let submitted: Record<string, unknown> | undefined;
 answer((frame, reply) => {
  if (frame.op !== "thread.submit") return false;
  submitted = frame.args; reply({ ok: true, value: {} }); return true;
 });
 if (!following) { await scrollAway(page); await settled(page); assert.ok(await gap(page) > 60); }
 const draft = page.getByRole("textbox", { name: "Message the agent", exact: true });
 if (action === "Quote") {
  await page.evaluate(() => {
   const transcript = document.querySelector("[data-region=transcript]")!.getBoundingClientRect();
   const body = [...document.querySelectorAll("[data-entry] [data-quote-body], [data-entry] .md p")].find(node => {
    const rect = node.getBoundingClientRect(); return rect.top >= transcript.top + 5 && rect.bottom <= transcript.bottom - 5;
   })!;
   const range = document.createRange(); range.selectNodeContents(body);
   const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  });
  await page.getByRole("button", { name: "Quote q", exact: true }).click();
  await page.getByRole("textbox", { name: "Quote note (optional)" }).press("Enter");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Message the agent");
  assert.match(await draft.inputValue(), /^> /);
 } else await draft.fill(`Synthetic ${action} message`);
 await settled(page);
 const before = await scrollTop(page);
 await page.getByRole("button", { name: action === "Quote" || action === "Send" ? "Send ↵" : action === "Queue" ? /Queue/ : /Steer/, exact: action === "Quote" || action === "Send" }).click();
 await frames(page);
 assert.ok(submitted, "the user action submits a message");
 assert.equal(submitted.whenBusy, action === "Queue" ? "followUp" : "steer");
 if (!following) assert.equal(await scrollTop(page), before, "sending above the tail does not move scrollTop");
 const arrived = { ...current, entries: [...current.entries, { id: "sent", kind: "user", text: String(submitted.content), images: 0 }] };
 send(arrived); await frames(page); await settled(page);
 if (!following) {
  assert.equal(await scrollTop(page), before, "the sent message arrival keeps the read place");
  await newButton(page).click(); await frames(page);
 }
 await page.locator('[data-entry="sent"]').waitFor();
 assert.equal(await page.locator('[data-entry="sent"] [data-quote-body]').textContent(), submitted.content);
 assert.ok(await gap(page) <= 2, "following stays at the tail; the existing new-message control returns a reader there");
 send({ ...arrived, entries: [...arrived.entries, { id: "reply", kind: "assistant", blocks: [{ type: "text", text: grown(8) }] }] });
 await page.locator('[data-entry="reply"]').waitFor(); await frames(page);
 assert.ok(await gap(page) <= 2, "the next reply remains followed");
});
