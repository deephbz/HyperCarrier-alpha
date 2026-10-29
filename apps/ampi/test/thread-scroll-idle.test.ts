import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { frames, gap, open, splitEntries, traffic, view } from "./thread-scroll-fixture.ts";

// An idle running fold in the real ThreadView (see thread-scroll-hold.test.ts): with no arrivals and no reader action,
// conversation-only does not move a reader one or two screens up for ten seconds.

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
