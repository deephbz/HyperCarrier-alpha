import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { engineSkip } from "./engines.ts";
import { ENGINES, open } from "./resize-edges-fixture.ts";

// The owner's phone incident: a sideways drag on the transcript moved it off the screen edge, showed a white margin, and
// sprang back. The transcript scroller (.scroll) is vertical only (styles.css). Wide content scrolls inside its own
// block, and nothing in the transcript ends past the scroller: a wide table's width rule sizes it against the pane less
// the prompt rail (--rail-w). The real App and stylesheet on the demo hub: a phone with and without the rail (a Session
// under the rail's 8 prompts), and a desktop size. The content covers each kind of wide Markdown; Markdown renders no
// images (Markdown.tsx), and a user's images keep a max-width.

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const WIDE = `<table><thead><tr>${"<th>column</th>".repeat(10)}</tr></thead><tbody><tr>${"<td>wordwordword</td>".repeat(10)}</tr></tbody></table>`
	+ `<pre><code>${"long_line_".repeat(30)}</code></pre><p><code>${"x".repeat(120)}</code> https://example.com/${"a".repeat(160)}</p>`;

/** Adds wide Markdown to the first assistant reply, as the Markdown renderer would emit it. */
async function wideReply(page: Page) {
	await page.evaluate((html) => document.querySelector(".transcript .msg.assistant > .md")!.insertAdjacentHTML("beforeend", html), WIDE);
}

/** The transcript scroller's sideways overflow, and every rendered element that ends outside it. */
function sideways(page: Page) {
	return page.evaluate(() => {
		const scroll = document.querySelector<HTMLElement>(".transcript-frame > .scroll")!;
		const box = scroll.getBoundingClientRect();
		const out = [...scroll.querySelectorAll<HTMLElement>("*")]
			// A scrolling block's own content may extend past it; the block itself must fit.
			.filter((el) => !el.parentElement?.closest(".scroll pre, .scroll .md table") && el.getClientRects().length > 0)
			.map((el) => ({ el, r: el.getBoundingClientRect() }))
			.filter(({ r }) => r.width > 0 && (r.right > box.right + 0.5 || r.left < box.left - 0.5))
			.map(({ el, r }) => `${el.tagName.toLowerCase()}.${el.className} [${r.left.toFixed(1)}, ${r.right.toFixed(1)}]`);
		return { overflowX: getComputedStyle(scroll).overflowX, extra: scroll.scrollWidth - scroll.clientWidth, scroll: [box.left, box.right], out };
	});
}

for (const [engine, type, path] of ENGINES) {
	const cases = [
		["phone", { route: "#/h/devbox/t/pi%3Asess-lead", context: PHONE }, true],
		["phone without a rail", { route: "#/h/devbox/t/pi%3Asess-solo", context: PHONE }, false],
		["desktop", {}, true],
	] as const;
	for (const [size, options, rail] of cases) {
		test(`transcript sideways ${engine} ${size}: wide content fits the scroller, which never scrolls sideways`, { skip: engineSkip(engine) }, async (t) => {
			const page = await open(t, engine, type, path(), options);
			await page.locator(rail ? ".transcript-frame.strip" : ".transcript-frame:not(.strip)").waitFor();
			await wideReply(page);
			const m = await sideways(page);
			assert.equal(m.overflowX, "hidden", "the transcript scroller cannot be dragged sideways");
			assert.ok(m.extra <= 0, `the transcript scroller has ${m.extra} px of sideways overflow`);
			assert.deepEqual(m.out, [], `elements end outside the scroller ${JSON.stringify(m.scroll)}`);
			// A reveal into a wide table's last cell scrolls the table, never the transcript.
			await page.evaluate(() => document.querySelector(".transcript .md table tr:last-child td:last-child")!.scrollIntoView({ block: "nearest", inline: "end" }));
			assert.equal(await page.locator(".transcript-frame > .scroll").evaluate((el) => el.scrollLeft), 0, "a reveal scrolled the transcript sideways");
		});
	}
}
