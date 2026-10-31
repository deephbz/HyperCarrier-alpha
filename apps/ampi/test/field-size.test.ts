import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { devices, type Page } from "playwright";
import { ENGINES, open } from "./resize-edges-fixture.ts";
import { engineSkip } from "./engines.ts";
import { composerHint } from "../web/src/composer-keys.ts";

// Owner task: iOS WebKit zooms the page when a focused field renders under 16 px. On a touch device every editable
// field renders at 16 px or more at every display size, and the text around it grows with it: body 16 px, code 14 px.
// A desktop keeps its own sizes. On every device a hint renders smaller than the text typed over it
// (docs/ux/field-size.md).
// Rendered size = computed font-size times the zoom of the field and each ancestor: both engines report the computed
// size before zoom.
const SESSION = "#/h/devbox/t/pi%3Asess-lead";
const COMPOSER = '[data-region="composer"] textarea';
/** Every empty-composer hint for a desktop (false) or a touch device (true). */
const hints = (touch: boolean) => [true, false].flatMap(busy => [true, false].flatMap(pi => [true, false].flatMap(control => [true, false]
	.map(images => composerHint({ busy, pi, control, images, touch })))));
/**
 * The hints that wrap in the composer of the engine under test. The textarea lays each one out as typed text at the
 * placeholder's size, so the engine's own font and line breaking decide.
 */
const wrapped = (page: Page, texts: string[]) => page.locator(COMPOSER).evaluate((el: HTMLTextAreaElement, texts) => {
	const { value, style } = el, size = style.fontSize;
	style.fontSize = getComputedStyle(el, "::placeholder").fontSize;
	el.value = "x";
	const line = el.scrollHeight;
	const out = texts.filter(text => { el.value = text; return el.scrollHeight > line + 1; });
	el.value = value;
	style.fontSize = size;
	return out;
}, texts);
/**
 * The hints that fill more than `share` of the composer's text width in the placeholder's font. macOS draws system-ui
 * in SF, the iPhone's font; the margin covers the iPhone's own text rendering.
 */
const crowded = (page: Page, texts: string[], share: number) => page.locator(COMPOSER).evaluate((el, [texts, share]) => {
	const style = getComputedStyle(el), hint = getComputedStyle(el, "::placeholder"), context = document.createElement("canvas").getContext("2d")!;
	context.font = `${hint.fontStyle} ${hint.fontWeight} ${hint.fontSize} ${hint.fontFamily}`;
	const room = el.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
	return texts.map(text => ({ text, share: context.measureText(text).width / room })).filter(hint => hint.share > share)
		.map(hint => `${hint.text} (${Math.round(hint.share * 100)}%)`);
}, [texts, share] as const);
const frames = (p: Page) => p.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
type Field = { name: string; kind: string; css: number; rendered: number };

/** Every editable field in the page: this test's own definition, kept apart from the stylesheet's selector. */
const fields = (page: Page) => page.evaluate(() => {
	const textless = new Set(["checkbox", "radio", "range", "button", "submit", "reset", "color", "file", "image", "hidden"]);
	return [...document.querySelectorAll<HTMLElement>("textarea, select, input, [contenteditable]")]
		.filter(el => el instanceof HTMLInputElement ? !textless.has(el.type) : el.getAttribute("contenteditable") !== "false")
		.map(el => {
			let zoom = 1;
			for (let a: Element | null = el; a; a = a.parentElement) zoom *= Number.parseFloat(getComputedStyle(a).zoom) || 1;
			const css = Number.parseFloat(getComputedStyle(el).fontSize);
			const name = el.getAttribute("aria-label") ?? (el as HTMLInputElement).labels?.[0]?.textContent?.trim() ?? el.className;
			return { name, kind: el instanceof HTMLInputElement ? `input[${el.type}]` : el.tagName.toLowerCase(), css, rendered: css * zoom };
		});
});

/**
 * One field of each editable kind in each zoom root: a field no component has yet still meets the floor. macOS WebKit
 * draws an unstyled select or search field as a native control of fixed size and ignores its font-size; every AmPi
 * field is styled, so the probe fields drop the native look.
 */
async function probe(page: Page) {
	await page.evaluate(() => {
		for (const root of [document.body, ...document.querySelectorAll<HTMLElement>("[data-region]")]) {
			for (const kind of ["textarea", "select", "div", "input", "input[search]", "input[number]", "input[email]"]) {
				const [tag, type] = kind.replace("]", "").split("[");
				const el = root.appendChild(document.createElement(tag!));
				if (type) el.setAttribute("type", type);
				if (tag === "div") el.contentEditable = "true";
				el.style.appearance = "none";
				el.setAttribute("aria-label", `probe ${kind} in ${root.dataset.region ?? "body"}`);
			}
		}
	});
	const list = (await fields(page)).filter(f => f.name.startsWith("probe "));
	await page.evaluate(() => document.querySelectorAll('[aria-label^="probe "]').forEach(el => el.remove()));
	return list;
}

/** The fields of each surface a phone owner opens: the Session, Find, ⌘K, the command palette, New Session, Rarebit. */
async function surfaces(page: Page): Promise<Map<string, Field>> {
	const seen = new Map<string, Field>();
	const take = async (where: string, expect: string[]) => {
		await frames(page);
		const list = await fields(page);
		for (const name of expect) assert.ok(list.some(f => f.name === name), `${where}: field "${name}" is on the page`);
		for (const f of list) seen.set(f.name, f);
	};
	await take("Session", ["Message the agent", "Thread title"]);
	for (const [where, key, expect] of [
		["Find", "ControlOrMeta+f", ["Find in Session"]],
		["⌘K", "ControlOrMeta+k", ["Find a Session"]],
		["command palette", "ControlOrMeta+Shift+k", ["Find a command"]],
		["New Session", "ControlOrMeta+n", ["First message", "Host", "Name", "Working directory"]],
	] as const) {
		await page.keyboard.press(key);
		await page.getByLabel(expect[0], { exact: true }).waitFor();
		await take(where, [...expect]);
		await page.keyboard.press("Escape");
		await page.getByLabel(expect[0], { exact: true }).waitFor({ state: "detached" }).catch(() => {});
	}
	await page.evaluate(route => { location.hash = route; }, `${SESSION}?p=rarebit`);
	await page.getByRole("button", { name: "Models", exact: true }).click();
	await page.getByLabel("Side ask model").waitFor();
	await take("Rarebit", ["Ask on the side", "Side ask model"]);
	for (const f of await probe(page)) seen.set(f.name, f);
	return seen;
}

const DISPLAYS: Record<string, number>[] = [{}, { overall: 0.7 }, { overall: 1.6 }, { overall: 0.7, composer: 0.7 }];
for (const [engine, type, path] of ENGINES) {
	test(`field size: every editable field renders at 16 px or more on a phone, at every display size, ${engine}`, { skip: engineSkip(engine), timeout: 180_000 }, async t => {
		const desktop = await open(t, engine, type, path(), { display: { overall: 1.6 }, route: SESSION });
		assert.equal(await desktop.evaluate(() => matchMedia("(pointer: coarse)").matches), false, "a desktop pointer is fine");
		assert.ok(hints(false).includes((await desktop.locator(COMPOSER).getAttribute("placeholder"))!), "a desktop shows the full composer hint");
		const own = await surfaces(desktop);
		assert.ok(Math.abs(own.get("Message the agent")!.css - 13) < 0.01, "a desktop keeps the composer's own 13 px");
		await desktop.context().close();
		for (const display of DISPLAYS) {
			const label = JSON.stringify(display);
			// 375 px: the narrowest phone the owner's hints must fit.
			const page = await open(t, engine, type, path(), { display, route: SESSION, context: { ...devices["iPhone 13"], viewport: { width: 375, height: 667 } } });
			assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), true, "the phone profile is a touch device");
			// A region root that mounts after App's first apply gets its zoom on the next ampi:display, as from the Display dialog.
			await page.evaluate(() => window.dispatchEvent(new Event("ampi:display")));
			if (display.composer) assert.equal(await page.locator('[data-region="composer"]').evaluate(el => getComputedStyle(el).zoom), "0.7", `${label}: the composer region takes its own zoom`);
			assert.ok(hints(true).includes((await page.locator(COMPOSER).getAttribute("placeholder"))!), `${label}: a phone shows a short composer hint`);
			const composer = await page.locator(COMPOSER).evaluate(el => Number.parseFloat(getComputedStyle(el).fontSize));
			if (Math.abs(composer * (display.overall ?? 1) * (display.composer ?? 1) - 16) < 0.1) {
				// The guard: a hint too long for one line measures as wrapped, also at the smaller placeholder size.
				assert.deepEqual(await wrapped(page, [hints(false)[0]!]), [hints(false)[0]], `${label}: a desktop hint wraps on 375 px`);
				assert.deepEqual(await wrapped(page, hints(true)), [], `${label}: short hints that wrap on 375 px`);
				if (process.platform === "darwin") assert.deepEqual(await crowded(page, hints(true), 0.85), [], `${label}: short hints over 85% of the composer's width in SF on 375 px`);
			}
			const seen = await surfaces(page);
			assert.deepEqual([...seen.keys()].sort(), [...own.keys()].sort(), `${label}: the phone and the desktop reach the same fields`);
			const small = [...seen.values()].filter(f => f.rendered < 15.99).map(f => `${f.name} (${f.kind}) ${f.rendered.toFixed(2)} px`);
			assert.deepEqual(small, [], `${label}: fields rendered under 16 px`);
			// A nested zoom counted twice raises a field past the floor: a field above the body size renders at 16 px.
			const body = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--font-body")));
			assert.equal(body, 16, `${label}: the touch body size`);
			const over = [...seen.values()].filter(f => f.css > body + 0.01 && Math.abs(f.rendered - 16) > 0.1).map(f => `${f.name} (${f.kind}) ${f.rendered.toFixed(2)} px`);
			assert.deepEqual(over, [], `${label}: fields raised past the 16 px floor`);
			if (display.overall === 1.6) {
				const shrunk = [...seen.values()].filter(f => f.css < own.get(f.name)!.css - 0.01).map(f => `${f.name} ${f.css} < ${own.get(f.name)!.css}`);
				assert.deepEqual(shrunk, [], `${label}: fields smaller on the phone than on a desktop`);
			}
			await page.context().close();
		}
	});
}


/** Computed sizes in CSS px: transcript prose, the composer and its hint, code, a tool's head and output, a label. */
const sizes = async (page: Page) => {
	await page.locator(".tool-head").first().click();
	await page.locator(".tool-body pre").first().waitFor();
	return page.evaluate(() => {
		const size = (selector: string, pseudo?: string) => Math.round(Number.parseFloat(getComputedStyle(document.querySelector(selector)!, pseudo).fontSize) * 100) / 100;
		return {
			body: size(".md p"), composer: size('[data-region="composer"] textarea'), hint: size('[data-region="composer"] textarea', "::placeholder"),
			code: size(".md pre"), toolName: size(".tool-head .name"), toolArg: size(".tool-head .arg"), toolOutput: size(".tool-body pre"),
		};
	});
};

for (const [engine, type, path] of ENGINES) {
	test(`field size: touch text is body 16 px and code 14 px; a hint renders under its field; a desktop keeps 13 and 12, ${engine}`, { skip: engineSkip(engine), timeout: 60_000 }, async t => {
		const desktop = await open(t, engine, type, path(), { route: SESSION });
		assert.deepEqual(await sizes(desktop), { body: 13, composer: 13, hint: 11.05, code: 12, toolName: 12, toolArg: 12, toolOutput: 12 }, "desktop sizes");
		await desktop.context().close();
		const page = await open(t, engine, type, path(), { route: SESSION, context: { ...devices["iPhone 13"], viewport: { width: 375, height: 667 } } });
		assert.deepEqual(await sizes(page), { body: 16, composer: 16, hint: 13.6, code: 14, toolName: 14, toolArg: 14, toolOutput: 14 }, "touch sizes on 375 px");
		// A long code line scrolls inside its block; the page does not scroll sideways.
		const code = await page.locator(".md pre").first().evaluate(pre => {
			pre.textContent = `const line = "${"x".repeat(200)}";`;
			pre.scrollLeft = 40;
			return { scrolled: pre.scrollLeft, right: pre.getBoundingClientRect().right - innerWidth, page: document.documentElement.scrollWidth - innerWidth };
		});
		assert.ok(code.scrolled > 0, "the block scrolls sideways");
		assert.ok(code.right <= 0, "the block stays inside the viewport");
		assert.equal(code.page, 0, "the page keeps its width");
	});
}

for (const [engine, type, path] of ENGINES) {
	test(`field size: the composer hint follows a late touch rule and a pointer media change, ${engine}`, { skip: engineSkip(engine), timeout: 60_000 }, async t => {
		const page = await open(t, engine, type, path(), { route: SESSION, context: { ...devices["iPhone 13"], viewport: { width: 375, height: 667 } } });
		// The touch rule reads as off at mount; the pointer media's change listeners are recorded.
		await page.addInitScript(() => {
			// An adopted sheet needs no element, so it applies before <html> parses.
			const off = new CSSStyleSheet();
			off.replaceSync(":root { --touch-fields: 0 !important; }");
			document.adoptedStyleSheets = [off];
			const seen: EventListener[] = (window as unknown as { __coarse: EventListener[] }).__coarse = [];
			const add = MediaQueryList.prototype.addEventListener;
			MediaQueryList.prototype.addEventListener = function (this: MediaQueryList, type: string, listener: EventListener, ...rest: unknown[]) {
				if (type === "change" && this.media === "(pointer: coarse)") seen.push(listener);
				return (add as (...args: unknown[]) => void).call(this, type, listener, ...rest);
			} as typeof add;
		});
		await page.reload();
		await page.locator(".transcript [data-entry]").first().waitFor({ state: "attached" });
		assert.ok(hints(false).includes((await page.locator(COMPOSER).getAttribute("placeholder"))!), "the touch rule off at mount: the full hint");
		await page.evaluate(() => {
			document.adoptedStyleSheets = [];
			for (const listener of (window as unknown as { __coarse: EventListener[] }).__coarse) listener(new Event("change"));
		});
		await page.waitForFunction(([selector, short]) => short.includes(document.querySelector(selector)!.getAttribute("placeholder")!), [COMPOSER, hints(true)] as const, { timeout: 2000 }).catch(() => {});
		assert.ok(hints(true).includes((await page.locator(COMPOSER).getAttribute("placeholder"))!), "a pointer media change reads the touch rule again: the short hint");
	});
}
