import "./bound.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { devices, type Page } from "playwright";
import { engineSkip } from "./engines.ts";
import { ENGINES, open, sidesSettled } from "./resize-edges-fixture.ts";

// The adversarial finding H1: on a 390 px phone at display size 100% and 130%, with the sidebar closed, the Session
// header drew its secondary actions and gave the name 0 px. One composition rule covers every header: FormRow
// (FormRow.tsx) reserves the name's width, and the header fold (header-fold.ts) moves the secondary actions into More
// as soon as one would leave the name's line. Only a row too narrow for the name and the primary actions wraps them,
// below a name that then takes the whole row. The name and the document hold at every width and size.

const ROUTE = "#/h/devbox/t/pi%3Asess-long-title";
const WIDTHS = [1280, 760, 390] as const;

async function settle(page: Page) {
	// A ResizeObserver callback commits the fold in the next frame; three frames hold it and its repaint.
	await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
}

async function size(page: Page, width: number) {
	await page.setViewportSize({ width, height: 900 });
	await sidesSettled(page);
	const hide = page.getByRole("button", { name: "Hide sidebar", exact: true });
	if (width < 500 && await hide.isVisible()) await hide.click();
	await settle(page);
}

/** The name's box and text, every drawn action's box, the fold state, and any sideways overflow. */
/** ☰ and its icon against the header's Pin and Find: sizes, and the vertical offset of their centres. */
const revealBox = (page: Page) => page.evaluate(() => {
	const box = (el: Element) => el.getBoundingClientRect(), mid = (r: DOMRect) => (r.top + r.bottom) / 2;
	const r = box(document.querySelector(".sidebar-reveal")!), pin = box(document.querySelector('.thread-bar [aria-label="Pin this Session"]')!);
	const icon = box(document.querySelector(".sidebar-reveal svg")!), find = box(document.querySelector('.thread-bar [aria-label="Find in this Session"] svg')!);
	return { w: r.width, h: r.height, off: mid(r) - mid(pin), icon: [icon.width, icon.height], find: [find.width, find.height], iconOff: mid(icon) - mid(find) };
});

async function header(page: Page) {
	return page.evaluate(() => {
		const row = document.querySelector<HTMLElement>(".thread-bar")!;
		const name = row.querySelector<HTMLElement>(".session-title")!.getBoundingClientRect();
		const field = row.querySelector<HTMLElement>(":scope > .form-field")!, style = getComputedStyle(row);
		const scale = row.getBoundingClientRect().width / row.offsetWidth;
		const actions = [...row.querySelectorAll<HTMLElement>(":scope > .form-actions > *")]
			.filter((el) => !el.hasAttribute("data-folded") && el.getClientRects().length > 0)
			.map((el) => { const r = el.getBoundingClientRect(); return { name: el.getAttribute("aria-label") || el.textContent!.trim().slice(0, 20) || el.className, left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
		const main = document.querySelector<HTMLElement>(".main")!;
		return {
			name: { width: name.width, top: name.top, bottom: name.bottom, text: row.querySelector<HTMLInputElement>('[aria-label="Thread title"]')?.value ?? "" },
			actions,
			// FormRow's reserve and the row's content width, in viewport px.
			reserve: parseFloat(getComputedStyle(field).flexBasis) * scale,
			content: (row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) * scale,
			field: field.getBoundingClientRect().width,
			folded: row.querySelector(".header-fold")?.hasAttribute("data-folded") ?? false,
			viewport: innerWidth,
			document: document.documentElement.scrollWidth - innerWidth,
			main: main.scrollWidth - main.clientWidth,
		};
	});
}

for (const [engine, type, path] of ENGINES) for (const zoom of [0.8, 1, 1.3]) {
	test(`session header ${engine} ${zoom * 100}%: the name keeps its slot; secondary actions fold into More`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { display: { overall: zoom }, route: ROUTE });
		page.setDefaultTimeout(4000);
		const closePanel = page.getByTitle("Close panel", { exact: true });
		if (await closePanel.isVisible()) await closePanel.click();
		const failures: string[] = [];
		const seen: Record<number, boolean> = {};
		for (const width of WIDTHS) {
			await size(page, width);
			const m = await header(page), at = `${width} px`;
			seen[width] = m.folded;
			if (m.name.width < 40) failures.push(`${at}: name is ${m.name.width.toFixed(1)} px wide`);
			if (m.field < Math.min(m.reserve, m.content) - 1) failures.push(`${at}: name slot ${m.field.toFixed(1)} px < reserve ${Math.min(m.reserve, m.content).toFixed(1)} px`);
			if (!m.name.text) failures.push(`${at}: name has no text`);
			if (m.document > 0) failures.push(`${at}: document scrolls sideways by ${m.document} px`);
			if (m.main > 0) failures.push(`${at}: main overflows by ${m.main} px`);
			const offLine = m.actions.filter((a) => !(a.top < m.name.bottom && a.bottom > m.name.top));
			for (const a of m.actions) if (a.left < -1 || a.right > m.viewport + 1) failures.push(`${at}: "${a.name}" [${a.left.toFixed(1)}, ${a.right.toFixed(1)}] leaves the viewport`);
			// A secondary action never wraps: the header folds first. A wrap of the primary actions leaves the name the row.
			if (offLine.length && !m.folded) failures.push(`${at}: ${offLine.map((a) => `"${a.name}"`).join(", ")} wrapped while unfolded`);
			if (offLine.length && m.field < m.content - 1) failures.push(`${at}: the actions wrapped but the name slot is ${m.field.toFixed(1)} of ${m.content.toFixed(1)} px`);
			const mode = page.getByRole("group", { name: "Transcript mode" });
			if (m.folded) {
				// The folded group is out of the accessibility tree; More holds its actions.
				if (await mode.count() !== 0) failures.push(`${at}: the folded mode control is still exposed`);
				const more = page.getByLabel("More actions", { exact: true });
				await more.click();
				const menu = page.locator(".t-more-menu");
				const shows = (l: ReturnType<Page["locator"]>) => l.waitFor({ timeout: 2000 }).then(() => true, () => false);
				for (const name of ["Timeline", "Arc"]) if (!await shows(menu.getByRole("button", { name, exact: true }))) failures.push(`${at}: More lacks ${name}`);
				if (!await shows(menu.getByRole("group", { name: "Transcript mode" }))) failures.push(`${at}: More lacks the mode control`);
				await more.click();
				await menu.waitFor({ state: "detached" });
			} else if (await mode.count() !== 1) failures.push(`${at}: the bar lacks the mode control`);
		}
		// The rule acts both ways: a desktop header keeps its actions in the bar, a phone header folds them.
		assert.equal(seen[1280], false, "a 1280 px header stays unfolded");
		assert.equal(seen[390], true, "a 390 px header folds");
		assert.deepEqual(failures, []);
	});
}

for (const [engine, type, path] of ENGINES) {
	test(`session header ${engine}: the transcript mode is one segmented choice in the bar and in More`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: ROUTE });
		page.setDefaultTimeout(4000);
		const closePanel = page.getByTitle("Close panel", { exact: true });
		if (await closePanel.isVisible()) await closePanel.click();
		await size(page, 1280);
		const mode = page.getByRole("group", { name: "Transcript mode" });
		const pressed = async (scope = mode) => scope.locator('button[aria-pressed="true"]').allInnerTexts();
		assert.deepEqual(await mode.getByRole("button").allInnerTexts(), ["Full", "Chat"]);
		assert.deepEqual(await pressed(), ["Full"]);
		await mode.getByRole("button", { name: "Chat", exact: true }).click();
		assert.deepEqual(await pressed(), ["Chat"]);
		// The chosen segment is drawn from aria-pressed alone.
		const look = (name: string) => mode.getByRole("button", { name, exact: true }).evaluate((el) => getComputedStyle(el).backgroundColor);
		assert.notEqual(await look("Chat"), await look("Full"));
		await size(page, 390);
		await page.getByLabel("More actions", { exact: true }).click();
		const menuMode = page.locator(".t-more-menu").getByRole("group", { name: "Transcript mode" });
		await menuMode.waitFor();
		assert.deepEqual(await pressed(menuMode), ["Chat"]);
		await menuMode.getByRole("button", { name: "Full", exact: true }).click();
		await page.locator(".t-more-menu").waitFor({ state: "detached" });
		await size(page, 1280);
		assert.deepEqual(await pressed(), ["Full"]);
	});

	test(`session header ${engine}: a coarse pointer gets 40 px header targets`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: ROUTE, context: { hasTouch: true } });
		assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), true, "the context has a coarse pointer");
		const closePanel = page.getByTitle("Close panel", { exact: true });
		if (await closePanel.isVisible()) await closePanel.click();
		for (const width of [1280, 390]) {
			await size(page, width);
			const small = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".thread-bar :is(.btn.small:not(.session-copy), .seg button)")]
				.filter((el) => el.getClientRects().length > 0 && !el.closest("[data-folded]"))
				.map((el) => { const r = el.getBoundingClientRect(); return { name: el.getAttribute("aria-label") || el.textContent!.trim(), w: r.width, h: r.height }; })
				.filter((b) => b.w < 39.5 || b.h < 39.5));
			assert.deepEqual(small, [], `${width} px: header targets under 40 px`);
		}
	});

	test(`session header ${engine}: a 375 px phone keeps the header one row, shows 15 characters of the name, and gives ☰ a full target with Find's icon size and centre`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: ROUTE, context: { ...devices["iPhone 13"], viewport: { width: 375, height: 667 } } });
		await settle(page);
		const m = await header(page);
		const offLine = m.actions.filter((a) => !(a.top < m.name.bottom && a.bottom > m.name.top)).map((a) => a.name);
		assert.deepEqual(offLine, [], "actions off the name's row");
		assert.ok(m.folded, "the secondary actions are in More");
		// The characters of the name the field shows before it truncates.
		const shown = await page.getByLabel("Thread title", { exact: true }).evaluate((el: HTMLInputElement) => {
			const style = getComputedStyle(el), context = document.createElement("canvas").getContext("2d")!;
			context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
			const room = el.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
			let n = 0;
			while (n < el.value.length && context.measureText(el.value.slice(0, n + 1)).width <= room) n++;
			return n;
		});
		assert.ok(shown >= 15, `the name shows ${shown} characters`);
		// ☰ is a full touch target, centred with the header's actions, and its icon matches Find's.
		const reveal = await revealBox(page);
		assert.ok(reveal.w >= 39.5 && reveal.h >= 39.5, `☰ is ${reveal.w}×${reveal.h} px`);
		assert.ok(Math.abs(reveal.off) <= 1, `☰ sits ${reveal.off} px off the actions' centre`);
		assert.deepEqual(reveal.icon, reveal.find, "☰'s icon is Find's size");
		assert.ok(Math.abs(reveal.iconOff) <= 2, `☰'s icon sits ${reveal.iconOff} px off Find's centre`);
		const wide = await open(t, engine, type, path(), { route: ROUTE });
		await wide.getByRole("button", { name: "Hide sidebar", exact: true }).click();
		await wide.locator(".sidebar-reveal").waitFor();
		await settle(wide);
		const desktop = await revealBox(wide);
		assert.deepEqual(desktop.icon, desktop.find, "a desktop: ☰'s icon is Find's size");
		assert.ok(Math.abs(desktop.iconOff) <= 2, `a desktop: ☰'s icon sits ${desktop.iconOff} px off Find's centre`);
	});

	test(`session header ${engine}: no text or control of any page sits under ☰: a 375 and a 390 px phone with a drawer closed or open, and a desktop`, { skip: engineSkip(engine), timeout: 120_000 }, async (t) => {
		const page = await open(t, engine, type, path(), { route: ROUTE, context: { ...devices["iPhone 13"], viewport: { width: 375, height: 667 } } });
		// Every page in the registry, the Overview, a Session, its Rarebit panel, and a terminal (an unknown id still draws its bar).
		const pages = [...readFileSync(new URL("../web/src/views/registry.ts", import.meta.url), "utf8").matchAll(/\{ name: "(\w+)", label: "[^"]*", section:/g)].map((m) => `#/v/${m[1]}`);
		assert.ok(pages.length >= 2, `pages from the registry: ${pages}`);
		const routes = [ROUTE, `${ROUTE}?p=rarebit`, "#/v/overview", ...pages, "#/h/devbox/x/demo-term"];
		/** Visible text and controls whose box meets ☰'s closed box, in the page or, while the drawer covers ☰, the main column. */
		const under = (page: Page, closed?: DOMRect) => page.evaluate((closed) => {
			const button = document.querySelector(".sidebar-reveal"), live = button?.getBoundingClientRect();
			const shown = Boolean(live && button!.contains(document.elementFromPoint((live.left + live.right) / 2, (live.top + live.bottom) / 2)));
			const reveal = shown ? live! : closed!;
			const root = shown ? document.body : document.querySelector(".main-slot")!;
			type Box = { left: number; right: number; top: number; bottom: number };
			// The part of a box a scrolling or clipping ancestor still shows.
			const clip = (r: Box, el: Element): Box => {
				for (let a = el.parentElement; a; a = a.parentElement) {
					const style = getComputedStyle(a);
					if (style.overflowX === "visible" && style.overflowY === "visible") continue;
					const c = a.getBoundingClientRect();
					r = { left: Math.max(r.left, c.left), right: Math.min(r.right, c.right), top: Math.max(r.top, c.top), bottom: Math.min(r.bottom, c.bottom) };
				}
				return r;
			};
			const meets = (r: Box) => r.right > r.left && r.bottom > r.top && r.left < reveal.right && r.right > reveal.left && r.top < reveal.bottom && r.bottom > reveal.top;
			const visible = (el: Element) => !button?.contains(el) && el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
			const out: string[] = [];
			const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			for (let node = walk.nextNode(); node; node = walk.nextNode()) {
				if (!node.textContent!.trim() || !visible(node.parentElement!)) continue;
				const range = document.createRange();
				range.selectNodeContents(node);
				if ([...range.getClientRects()].some((r) => meets(clip(r, node!.parentElement!)))) out.push(`text "${node.textContent!.trim().slice(0, 30)}"`);
			}
			for (const control of root.querySelectorAll<HTMLElement>("input, textarea, select, button, a[href], summary, [role=button], [tabindex]:not([tabindex^=\"-\"])")) {
				if (!visible(control)) continue;
				const r = control.getBoundingClientRect(), field = control.matches("input, textarea") ? Number.parseFloat(getComputedStyle(control).paddingLeft) : 0;
				if (meets(clip({ left: r.left + field, right: r.right, top: r.top, bottom: r.bottom }, control))) out.push(`${control.tagName.toLowerCase()} "${(control.getAttribute("aria-label") ?? control.textContent ?? "").trim().slice(0, 30)}"`);
			}
			return { shown, rect: JSON.parse(JSON.stringify(reveal)) as DOMRect, out };
		}, closed);
		const visit = async (page: Page, route: string) => {
			await page.evaluate((r) => { location.hash = r; }, route);
			await page.locator(".sidebar-reveal").waitFor();
			// The page has drawn its first row: some text sits in the top 60 px of the main column.
			await page.waitForFunction(() => {
				const walk = document.createTreeWalker(document.querySelector(".main-slot")!, NodeFilter.SHOW_TEXT);
				for (let node = walk.nextNode(); node; node = walk.nextNode()) if (node.textContent!.trim() && node.parentElement!.getBoundingClientRect().top < 60) return true;
				return false;
			});
			await settle(page);
		};
		for (const width of [375, 390]) {
			await page.setViewportSize({ width, height: 667 });
			for (const route of routes) {
				await visit(page, route);
				const label = `${width} px ${route}`;
				// An open right panel is a full-height drawer and covers ☰ (swipe-drawers.md rule 8); its ✕ is the way out.
				if (route.includes("?p=")) {
					await page.waitForFunction(() => document.querySelector(".app")!.classList.contains("has-panel"));
					await settle(page);
					assert.ok(await page.evaluate(() => { const r = document.querySelector(".sidebar-reveal")!.getBoundingClientRect(); return Boolean(document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2)?.closest(".panel-slot")); }), `${label}: the panel drawer covers ☰`);
					await page.getByTitle("Close panel", { exact: true }).click();
					await page.waitForFunction(() => !document.querySelector(".app")!.classList.contains("has-panel"));
					continue;
				}
				const closed = await under(page);
				assert.ok(closed.shown, `${label}: ☰ shows`);
				assert.deepEqual(closed.out, [], `${label}: under ☰`);
				await page.getByRole("button", { name: "Show sidebar" }).click();
				await page.waitForFunction(() => !document.querySelector(".app")!.classList.contains("sidebar-hidden"));
				await settle(page);
				assert.deepEqual((await under(page, closed.rect)).out, [], `${label}, sidebar drawer open: under ☰'s closed box`);
				await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
				await sidesSettled(page);
			}
		}
		// A desktop with its sidebar hidden draws ☰ at the same place.
		const desktop = await open(t, engine, type, path(), { route: ROUTE });
		await desktop.getByRole("button", { name: "Hide sidebar", exact: true }).click();
		for (const route of routes) {
			await visit(desktop, route);
			const closed = await under(desktop);
			assert.ok(closed.shown, `desktop ${route}: ☰ shows`);
			assert.deepEqual(closed.out, [], `desktop ${route}: under ☰`);
		}
	});

	test(`session header ${engine}: on a 390 px phone a drawer opens over the header and moves nothing under it`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: ROUTE, context: devices["iPhone 13"] });
		const title = async () => {
			await settle(page);
			return page.getByLabel("Thread title", { exact: true }).evaluate((el: HTMLInputElement) => {
				const r = el.getBoundingClientRect();
				return { left: r.left, top: r.top, width: r.width, height: r.height, text: el.value };
			});
		};
		const app = (name: string) => page.waitForFunction((name) => document.querySelector(".app")!.classList.contains(name), name);
		await page.locator(".sidebar-reveal").waitFor();
		const closed = await title();
		await page.getByRole("button", { name: "Show sidebar" }).click();
		await page.waitForFunction(() => !document.querySelector(".app")!.classList.contains("sidebar-hidden"));
		assert.deepEqual(await title(), closed, "the sidebar drawer is open");
		await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
		await app("sidebar-hidden");
		assert.deepEqual(await title(), closed, "the sidebar drawer closed again");
		await page.evaluate((route) => { location.hash = `${route}?p=arc`; }, ROUTE);
		await app("has-panel");
		assert.deepEqual(await title(), closed, "the panel drawer is open");
	});

	test(`session header ${engine}: under reduced motion a spinner pulses as a dot, never a frozen arc`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, type, path(), { route: ROUTE });
		// Every busy indicator is a .spinner; one in the header reads the stylesheet's rule for all of them.
		await page.locator(".thread-bar .form-actions").evaluate((el) => el.insertAdjacentHTML("afterbegin", '<span class="spinner" data-probe></span>'));
		const read = () => page.locator(".spinner[data-probe]").evaluate((el) => {
			const s = getComputedStyle(el);
			return { animation: s.animationName, right: s.borderRightColor, top: s.borderTopColor, background: s.backgroundColor };
		});
		const normal = await read();
		assert.equal(normal.animation, "spin");
		assert.notEqual(normal.right, normal.top, "normal motion draws a turning arc");
		await page.emulateMedia({ reducedMotion: "reduce" });
		const reduced = await read();
		assert.equal(reduced.animation, "pulse", "reduced motion pulses");
		assert.equal(reduced.right, reduced.top, "no gap in the ring: nothing reads as a letter");
		assert.notEqual(reduced.background, "rgba(0, 0, 0, 0)", "the dot is filled");
	});
}
