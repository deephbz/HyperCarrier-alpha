import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { anchor, entries, frames, gap, offsetOf, open, scrollAway, scrollTop, splitEntries, traffic, view } from "./thread-scroll-fixture.ts";

// Folds, split entries and Back in the real ThreadView (see thread-scroll-hold.test.ts): conversation-only folds arriving
// traffic, and a split entry's fragment keeps its place. thread-scroll-idle.test.ts holds the idle running fold.

test("scroll hold: conversation-only folds arriving tool calls and Team messages without moving a reader one or two screens up", async (t) => {
	const { page, send } = await open(t, 200);
	await page.getByRole("button", { name: "Chat", exact: true }).click();
	await frames(page);
	await page.locator('[aria-label="Transcript mode"] > [aria-pressed="true"]', { hasText: "Chat" }).first().waitFor({state:"attached"});
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

for (const operation of ["open fold growth", "lens round trip"] as const) test(`scroll hold: split fragment survives ${operation}`, async (t) => {
	const {page, send} = await open(t, 200);
	const mixed: any[] = splitEntries();
	if (operation === "open fold growth") for (let i=192;i<240;i++) mixed[i]={id:`e${i}`,kind:'compaction',summary:'Context kept'};
	const publish = () => send({...view(200),entries:mixed,live:{run:{startedAt:1}}});
	publish(); await frames(page);
	await page.getByRole("button", { name: "Chat", exact: true }).click(); await frames(page);
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
		await page.getByRole('button', { name: 'Full', exact: true }).click(); await frames(page);
		await page.getByRole('button', { name: 'Chat', exact: true }).click(); await frames(page);
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
	await page.getByRole('button', { name: 'Chat', exact: true }).click(); await frames(page);
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

test("reveal: a newer reveal leaves the earlier tool body open; the Transcript-mode toggle closes every body and fold a reveal opened", async (t) => {
	const {page, send} = await open(t, 200);
	// Each assistant entry's bash call has its result right after it.
	const mixed: any[] = splitEntries().flatMap((entry: any, i) => entry.kind === "assistant" ? [entry, {id:`r${i}`,kind:"tool-result",callId:`mixed${i}`,name:"bash",isError:false,text:`output ${i}`,truncated:false}] : [entry]);
	send({...view(200),entries:mixed}); await frames(page);
	const body = (i: number) => page.locator(`[data-entry=e${i}] .tool-head`);
	const reveal = async (entry: string) => { await page.evaluate((e) => { (window as any).ENTRY = e; (window as any).parentTicks = true; }, entry); };
	await reveal("r185");
	await page.waitForFunction(() => document.querySelector("[data-entry=e185] .tool-head")?.getAttribute("aria-expanded") === "true");
	await reveal("r191");
	await page.waitForFunction(() => document.querySelector("[data-entry=e191] .tool-head")?.getAttribute("aria-expanded") === "true");
	assert.equal(await body(185).getAttribute("aria-expanded"), "true", "a newer reveal leaves the earlier body open");
	await page.getByRole("button", { name: "Chat", exact: true }).click(); await frames(page);
	await page.locator('[aria-label="Transcript mode"] > [aria-pressed="true"]', { hasText: "Chat" }).first().waitFor({state:"attached"});
	assert.equal(await page.locator(".rb-tools[open]").count(), 0, "conversation only: no fold opens for the earlier reveals");
	await page.getByRole("button", { name: "Full", exact: true }).click(); await frames(page);
	assert.deepEqual([await body(185).getAttribute("aria-expanded"), await body(191).getAttribute("aria-expanded")], ["false", "false"], "full transcript again: the revealed bodies are closed");
	// In conversation only, a reveal opens the fold; the toggle round trip closes it.
	await page.getByRole("button", { name: "Chat", exact: true }).click(); await frames(page);
	await reveal("r181");
	await page.locator(".rb-tools[open]").first().waitFor({state:"attached"});
	await page.getByRole("button", { name: "Full", exact: true }).click(); await frames(page);
	await page.getByRole("button", { name: "Chat", exact: true }).click(); await frames(page);
	assert.equal(await page.locator(".rb-tools[open]").count(), 0, "the round trip closes the revealed fold");
});
