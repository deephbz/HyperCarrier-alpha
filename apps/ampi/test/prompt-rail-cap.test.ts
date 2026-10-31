import "./bound.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Page } from "playwright";
import { engineSkip } from "./engines.ts";
import { ENGINES, type Engine, frames, open, settled, view } from "./thread-scroll-fixture.ts";

// The owner's rail incident: a 600-prompt Session drew a ruler of dashes down the whole transcript edge, and Find
// threw the reader to the oldest match. The rail is a short centered stack (railLayout); Find opens at the reader's place.

const SIZES = { desktop: { width: 1280, height: 900 }, narrow: { width: 760, height: 900 }, phone: { width: 390, height: 844 } };
const ZOOMS = [0.8, 1, 1.3];
/** The transcript holds e0–e199: 100 prompts (even ids), each answered by the next odd id. */
const COUNT = 200;
const rendered = Array.from({ length: COUNT / 2 }, (_, i) => `e${2 * i}`);
const users = (ids: string[]) => ids.map((id, ordinal) => ({ id, ordinal, firstLine: `Question ${id}` }));
/** `prompts` outline users: the last ones the transcript renders, after older ones it does not. */
const outlineOf = (prompts: number) => users(prompts <= rendered.length ? rendered.slice(-prompts) : [...Array.from({ length: prompts - rendered.length }, (_, i) => `old${i}`), ...rendered]);

async function railPage(t: TestContext, engine: Engine, prompts: number, zoom = 1, size = SIZES.desktop) {
	const fixture = await open(t, COUNT, "pi", engine, zoom, 1, size);
	const outline = { version: "v1", totalEntries: COUNT, users: outlineOf(prompts), truncated: false };
	const finds: { from?: string }[] = [];
	fixture.answer((frame, reply) => {
		if (frame.op === "thread.outline") return reply({ ok: true, value: outline }), true;
		if (frame.op !== "thread.find") return false;
		// The hub's window: every answer matches "Answer"; 400 older matches lie before this copy's entries.
		const from = frame.args.from as string | undefined;
		finds.push({ from });
		const hits = Array.from({ length: COUNT / 2 }, (_, i) => ({ entry: `e${2 * i + 1}`, ref: "", threadId: "pi:s1", snippet: `Answer ${2 * i + 1}`, kind: "assistant", version: "v1", prose: true, at: 400 + 2 * i + 1, prompt: `e${2 * i}` }));
		const start = from ? hits.findIndex((h) => Number(h.entry.slice(1)) >= Number(from.slice(1))) : 0;
		const window = { first: hits[0]!.at, last: hits.at(-1)!.at, skipped: 400, start: start < 0 ? hits.length : start, size: hits.length };
		reply({ ok: true, value: { hits, more: true, total: 500, proseTotal: 500, windows: { all: window, prose: window }, scanned: 600, scope: "", asOf: 0 } });
		return true;
	});
	fixture.send({ ...view(COUNT), sourceVersion: "v1" });
	if (prompts >= 8) await fixture.page.locator('.companion-scrollbar[data-outline-version="v1"] [data-user-mark]').first().waitFor({ state: "attached" });
	await frames(fixture.page);
	return { ...fixture, finds };
}

/** What the rail draws: its height, the shown dashes, and which of the prompts on screen lack a dark dash. */
const rail = (page: Page) => page.evaluate(() => {
	const nav = document.querySelector<HTMLElement>(".companion-scrollbar")!;
	const box = nav.getBoundingClientRect();
	const probe = document.createElement("i"); probe.style.color = "var(--text)"; document.body.append(probe);
	const text = getComputedStyle(probe).color; probe.remove();
	const shown = [...nav.querySelectorAll<HTMLElement>("[data-user-mark]")].filter((a) => getComputedStyle(a).display !== "none").map((a) => a.querySelector("span")!.getBoundingClientRect());
	const scroller = document.querySelector<HTMLElement>("[data-region=transcript]")!.getBoundingClientRect();
	const onScreen = [...document.querySelectorAll<HTMLElement>(".msg.user[data-entry]")].filter((u) => { const r = u.getBoundingClientRect(); return r.bottom > scroller.top && r.top < scroller.bottom; }).map((u) => u.dataset.entry!);
	const dark = (id: string) => { const a = nav.querySelector<HTMLElement>(`[data-user-mark="${id}"]`); return a && getComputedStyle(a).display !== "none" && getComputedStyle(a.querySelector("span")!).backgroundColor === text; };
	return { height: nav.clientHeight, shown: shown.length, above: shown.length ? shown[0]!.top - box.top : 0, below: shown.length ? box.bottom - shown.at(-1)!.bottom : 0, onScreen, notDark: onScreen.filter((id) => !dark(id)) };
});
/** The cap railLayout applies: about 40 dashes, or 40% of the rail's height at a 6 px pitch, whichever is smaller. */
const cap = (height: number) => Math.max(8, Math.min(40, Math.floor((height * 0.4) / 6)));

for (const engine of ENGINES) for (const [name, size] of Object.entries(SIZES)) for (const zoom of ZOOMS) {
	test(`${engine} ${name} ${zoom}x: a 600-prompt rail is a short centered stack; prompts on screen are dark`, { skip: engineSkip(engine) }, async (t) => {
		const { page } = await railPage(t, engine, 600, zoom, size);
		for (const where of ["end", "middle"]) {
			if (where === "middle") { await page.locator("[data-region=transcript]").evaluate((el) => { el.scrollTop = (el.scrollHeight - el.clientHeight) / 2; }); await settled(page); await frames(page); }
			const r = await rail(page);
			assert.equal(r.shown, cap(r.height), `${where}: ${r.shown} dashes in a ${r.height} px rail`);
			assert.ok(r.shown <= 40);
			assert.ok(Math.abs(r.above - r.below) <= 7, `${where}: the stack is centered (${r.above} px above, ${r.below} px below)`);
			assert.ok(r.onScreen.length > 0, `${where}: a prompt is on screen`);
			assert.deepEqual(r.notDark, [], `${where}: every prompt on screen has a dark dash`);
		}
	});
}

for (const engine of ENGINES) {
	test(`${engine}: a 40-prompt rail keeps its cap; a 7-prompt Session keeps the native scrollbar and draws no Find marks`, { skip: engineSkip(engine) }, async (t) => {
		let { page } = await railPage(t, engine, 40);
		const r = await rail(page);
		assert.equal(r.shown, Math.min(40, cap(r.height)));
		const scrollbar = (page: Page) => page.locator("[data-region=transcript]").evaluate((el) => ({ strip: el.parentElement!.classList.contains("strip"), width: getComputedStyle(el).scrollbarWidth }));
		assert.deepEqual(await scrollbar(page), { strip: true, width: "none" }, "a rail hides the native scrollbar");
		({ page } = await railPage(t, engine, 7));
		await page.locator('[data-region=transcript]').waitFor();
		await frames(page);
		assert.equal(await page.locator(".prompt-rail, [data-user-mark]").count(), 0);
		assert.deepEqual(await scrollbar(page), { strip: false, width: "auto" }, "no rail keeps the native scrollbar");
		await page.getByRole("button", { name: "Find in this Session" }).click();
		await page.getByRole("textbox", { name: "Find in Session" }).fill("Answer");
		await page.waitForFunction(() => /^\d+ \/ 500$/.test(document.querySelector(".find-bar [role=status]")?.textContent ?? ""));
		assert.equal(await page.locator("[data-find-mark]").count(), 0);
	});

	for (const [name, size] of Object.entries(SIZES)) test(`${engine} ${name}: Find from the tail keeps the reader's place; its marks never overlap`, { skip: engineSkip(engine) }, async (t) => {
		const { page, finds } = await railPage(t, engine, 600, 1, size);
		const reading = await page.evaluate(() => {
			const el = document.querySelector<HTMLElement>("[data-region=transcript]")!, box = el.getBoundingClientRect(), line = box.top + box.height / 2;
			return [...el.querySelectorAll<HTMLElement>("[data-entry]")].find((n) => !n.closest("summary") && n.getBoundingClientRect().bottom > line)!.dataset.entry!;
		});
		const before = await page.locator("[data-region=transcript]").evaluate((el) => el.scrollTop);
		await page.getByRole("button", { name: "Find in this Session" }).click();
		await page.getByRole("textbox", { name: "Find in Session" }).fill("Answer");
		const counter = page.locator(".find-bar [role=status]");
		await page.waitForFunction(() => /^\d+ \/ 500$/.test(document.querySelector(".find-bar [role=status]")?.textContent ?? ""));
		await settled(page);
		assert.equal(finds[0]?.from, reading, "Find asks for the window at the reader's entry");
		// The first answer at or after the reading entry, counted after the 400 older matches.
		const n = Number(reading.slice(1)), first = n % 2 ? n : n + 1;
		assert.equal(await counter.textContent(), `${400 + (first - 1) / 2 + 1} / 500`);
		const after = await page.locator("[data-region=transcript]").evaluate((el) => el.scrollTop);
		const height = await page.locator("[data-region=transcript]").evaluate((el) => el.clientHeight);
		assert.ok(Math.abs(after - before) < height / 2, `the reader stays near their place (moved ${after - before} px)`);
		const marks = await page.locator("[data-find-mark]").evaluateAll((all) => all.map((m) => parseFloat((m as HTMLElement).style.top)).sort((a, b) => a - b));
		assert.ok(marks.length > 0, "the rail marks matches");
		for (let i = 1; i < marks.length; i++) assert.ok(marks[i]! - marks[i - 1]! >= 3, `marks ${marks[i - 1]} and ${marks[i]} are at least 3 px apart`);
		assert.equal(await page.locator("[data-find-mark].cur").count(), 1, "one mark is current");
	});
}
