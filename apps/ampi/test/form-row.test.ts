import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator, Page } from "playwright";
import { engineSkip } from "./engines.ts";
import { ENGINES, open } from "./resize-edges-fixture.ts";

// The adversarial finding R7a: on a 390 px phone at display size 130%, the Find bar slid off the left edge and its
// query box showed "Fi" while its chips kept their width; the Session header squeezed its title to nothing and pushed ⋯
// off the right edge. One rule covers every form row: the field keeps a usable width, and every control stays inside
// the row. Ancillary controls wrap below the field. They never squeeze the field and never overflow.
// Members: the Find bar, the ⌘K palette search row, the Session header, and the Composer.

/** A usable field is at least 10 em of the row's text wide, about 20 characters. The form-row primitive reserves 12 em
 * for the field slot (styles.css `--field-min`); the slot's adornment, the header's copy button, leaves the rest. */
const USABLE_EM = 10;
const VIEWPORTS = [["phone", 390, 720], ["narrow", 760, 720], ["desktop", 1280, 800]] as const;

/** The row and field boxes, every visible control box, and the overflow of the row and the document. */
async function measure(row: Locator, field: Locator) {
	const fieldHandle = await field.elementHandle();
	return row.evaluate((el: HTMLElement, fieldEl) => {
		const box = (r: DOMRect) => ({ x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width });
		const controls = [...el.querySelectorAll<HTMLElement>("input:not([type=hidden]), textarea, select, button, a[href], summary, [role=status]")]
			// Controls the reader sees: a folded, invisible group keeps its boxes but is not on the row.
			.filter((c) => c.checkVisibility({ visibilityProperty: true }) && !c.closest("details:not([open]) > :not(summary)"))
			.map((c) => ({ name: c.getAttribute("aria-label") || c.textContent?.trim().slice(0, 24) || c.tagName.toLowerCase(), ...box(c.getBoundingClientRect()) }));
		const f = fieldEl as HTMLElement;
		const style = getComputedStyle(el), scale = el.getBoundingClientRect().width / el.offsetWidth;
		return {
			row: box(el.getBoundingClientRect()),
			content: (el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) * scale,
			field: box(f.getBoundingClientRect()),
			em: parseFloat(style.fontSize) * scale,
			overflow: el.scrollWidth - el.clientWidth,
			controls,
			viewport: innerWidth,
			document: document.documentElement.scrollWidth - innerWidth,
			// An overflowing row scrolls a clipping ancestor sideways: the Find bar then started at x = -10.
			scrolled: (() => { let sum = 0; for (let a = el.parentElement; a; a = a.parentElement) sum += a.scrollLeft; return sum; })(),
		};
	}, fieldHandle);
}

type Shape = Awaited<ReturnType<typeof measure>>;
/** The form-row invariant, as violations. `oneLine` adds: a desktop row keeps its controls on the field's line. */
function violations(name: string, m: Shape, oneLine: boolean) {
	const out: string[] = [];
	const usable = Math.min(USABLE_EM * m.em, m.content) - 1;
	if (m.field.width < usable) out.push(`${name}: field ${m.field.width.toFixed(1)} px < usable ${usable.toFixed(1)} px`);
	if (m.row.x < -1 || m.row.right > m.viewport + 1) out.push(`${name}: row [${m.row.x.toFixed(1)}, ${m.row.right.toFixed(1)}] leaves the ${m.viewport} px viewport`);
	if (m.overflow > 1) out.push(`${name}: row content overflows by ${m.overflow} px`);
	if (m.document > 0) out.push(`${name}: document scrolls sideways by ${m.document} px`);
	if (m.scrolled) out.push(`${name}: an ancestor scrolled sideways by ${m.scrolled} px`);
	for (const c of m.controls) if (c.x < m.row.x - 1 || c.right > m.row.right + 1) out.push(`${name}: "${c.name}" [${c.x.toFixed(1)}, ${c.right.toFixed(1)}] leaves the row [${m.row.x.toFixed(1)}, ${m.row.right.toFixed(1)}]`);
	if (oneLine) for (const c of m.controls) if (c.y >= m.field.bottom) out.push(`${name}: "${c.name}" wrapped below the field on a wide row`);
	return out;
}

async function settle(page: Page) {
	await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

for (const [engine, type, path] of ENGINES) for (const zoom of [0.8, 1, 1.3]) {
	test(`form rows ${engine} ${zoom * 100}%: the field keeps a usable width and every control stays inside its row`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { display: { overall: zoom }, route: "#/h/devbox/t/pi%3Asess-big" });
		const closePanel = page.getByTitle("Close panel", { exact: true });
		if (await closePanel.isVisible()) await closePanel.click();
		await page.getByRole("button", { name: "Find in this Session", exact: true }).click();
		// "✓ Tools" is the wider chip label.
		await page.getByRole("search", { name: "Find in this Session" }).getByRole("button", { name: /Tools/ }).click();
		const failures: string[] = [];
		for (const [label, width, height] of VIEWPORTS) {
			await page.setViewportSize({ width, height });
			const hide = page.getByRole("button", { name: "Hide sidebar", exact: true });
			if (width < 500 && await hide.isVisible()) await hide.click();
			await settle(page);
			// A counter with a result: with "✓ Tools", the widest Find bar a reader sees.
			const query = page.getByRole("textbox", { name: "Find in Session", exact: true });
			await query.fill("selector");
			const oneLine = label === "desktop" && zoom <= 1;
			const members: [string, Locator, Locator][] = [
				["Find bar", page.getByRole("search", { name: "Find in this Session" }), query],
				["Session header", page.locator(".thread-bar"), page.getByRole("textbox", { name: "Thread title", exact: true })],
				["Composer", page.locator("[data-region=composer]"), page.locator("[data-region=composer] textarea")],
			];
			for (const [name, row, field] of members) failures.push(...violations(`${label} ${name}`, await measure(row, field), oneLine && name !== "Composer"));
			const show = page.getByRole("button", { name: "Show sidebar", exact: true });
			if (await show.isVisible()) await show.click();
			await page.getByRole("button", { name: /Search Sessions or prose/ }).click();
			const search = page.getByRole("textbox", { name: "Find a Session" });
			// The palette row: the smallest box holding the field and its scope control.
			await search.fill("Benachrichtigungseinstellungen");
			await settle(page);
			failures.push(...violations(`${label} palette`, await measure(search.locator("xpath=ancestor::*[.//*[@aria-label='Search scope']][1]"), search), oneLine));
			await page.keyboard.press("Escape");
			if (width < 500 && await hide.isVisible()) await hide.click();
		}
		assert.deepEqual(failures, []);
	});
}
