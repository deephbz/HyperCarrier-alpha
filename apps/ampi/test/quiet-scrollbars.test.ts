import "./bound.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { build } from "vite";
// @ts-ignore: shared browser discovery is plain ESM.
import { findChrome } from "../scripts/perf/browser.mjs";
import { engineSkip } from "./engines.ts";

// Quiet scrollbars (styles.css, quiet-scroll.ts) with the real stylesheet, in Chromium with visible classic scrollbars
// and in WebKit, at display size 1 and 1.3. A .quiet-scroll region whose content fits shows no bar and no gutter; the sidebar list keeps a transparent track (invariant row a). An
// overflowing one paints its thumb only while the pointer or focus is inside it, or about 1 s after it scrolls, and the
// reveal moves nothing. A data-scrollbar="none" input shows no bar, wraps, and still scrolls. The transcript keeps its
// own scroller (Task ui-transcript-strip).

const web = fileURLToPath(new URL("../web", import.meta.url));
const ORIGIN = "http://localhost";

/**
 * Every scroll rule in the stylesheets and its treatment. A quiet or bare region names the JSX that renders it; that
 * element carries quiet-scroll (and data-scrollbar="none" for a bare one). A new overflow rule must be added here.
 */
const REGIONS: Record<string, RegExp | string> = {
	".side": /<aside className="side /, ".side-scroll": /<div className="side-scroll /, ".panel-tabs > .seg": /<div className="seg quiet/,
	".panel-body": /<div className="panel-body /, ".modal": /className="modal /, ".dirlist": /<div className="dirlist /,
	".slash-menu": /<div className="slash-menu /, ".accounts .provider-list": /<div className="provider-list /,
	".session-metadata": /<section className="session-metadata /, ".tool-body": /<div className="tool-body /,
	".rb-header": /<header className="rb-header /, ".rb-scroll": /<div className="rb-scroll /, ".rb-band": /<div className="rb-band /,
	".rb-tools summary": /<summary className="quiet-scroll">\{run\.entries/, ".cos-scroll": /<div className="cos-scroll /,
	".cos-models ul": /models Pi lists<\/summary><ul /, ".ptb-graph-scroll": /<div className="ptb-graph-scroll /,
	".composer textarea": /^\t+ref=\{ref\}\n\t+className="quiet-scroll"\n\t+data-scrollbar="none"/m, ".queue": /<div className="queue /,
	".composer-feedback": /composer-feedback/,
	".scroll": "transcript: owned by Task ui-transcript-strip",
	".main": "page column: its children scroll, it does not",
	".md pre": "generated Markdown: inherits its region's bar in Chromium, native in WebKit",
	".md table": "generated Markdown: inherits its region's bar in Chromium, native in WebKit",
	".rb-message .md pre": "generated Markdown: inherits its region's bar in Chromium, native in WebKit",
	".graph": "unused selector",
};
const BARE = new Set([".composer textarea", ".queue", ".composer-feedback"]);
/** Scrollers styled inline, not by a stylesheet rule. */
const INLINE = [/<section className="session-find quiet-scroll"/, /<details className="fleet-search quiet-scroll"/, /<div className="quiet-scroll" style=\{\{ marginTop: 8, maxHeight: "50vh", overflowY: "auto" \}\}>/];

test("every scroll rule in the stylesheets has a treatment, and each treated region renders with it", () => {
	const sheets = [join(web, "src/styles.css"), ...["rarebit", "cos", "team"].flatMap((v) => readdirSync(join(web, "src/views", v)).filter((f) => f.endsWith(".css")).map((f) => join(web, "src/views", v, f)))];
	const found = new Set<string>();
	for (const sheet of sheets) {
		const css = readFileSync(sheet, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
		for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
			if (!/overflow(-[xy])?\s*:\s*[^;]*\b(auto|scroll)\b/.test(body!)) continue;
			for (const selector of selectors!.split(",").map((s) => s.trim()).filter(Boolean)) found.add(selector);
		}
	}
	assert.deepEqual([...found].filter((selector) => !(selector in REGIONS)), [], "a scroll region without a treatment in REGIONS");
	const sources = readdirSync(join(web, "src"), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".tsx")).map((f) => readFileSync(join(web, "src", f), "utf8"));
	for (const [selector, renders] of Object.entries(REGIONS)) {
		if (typeof renders === "string") continue;
		if (renders.multiline) { assert.ok(sources.some((source) => renders.test(source)), `${selector}: not rendered bare`); continue; }
		const lines = sources.flatMap((source) => source.split("\n")).filter((line) => renders.test(line));
		assert.ok(lines.length > 0, `${selector}: no element renders it`);
		for (const line of lines) {
			assert.match(line, /quiet-scroll/, `${selector}: rendered without quiet-scroll: ${line.trim().slice(0, 120)}`);
			if (BARE.has(selector)) assert.match(line, /data-scrollbar="none"/, `${selector}: rendered with a bar: ${line.trim().slice(0, 120)}`);
		}
	}
	for (const inline of INLINE) assert.ok(sources.some((source) => inline.test(source)), `${inline}: an inline scroller without quiet-scroll`);
});

async function revealScript(): Promise<string> {
	const entry = join(web, "src/quiet-scroll.ts");
	const result = await build({
		configFile: false, root: web, logLevel: "silent",
		build: { write: false, minify: false, lib: { entry, formats: ["iife"], name: "QuietScroll" } },
	});
	const output = (Array.isArray(result) ? result[0]! : result) as { output: { type: string; code?: string }[] };
	return `${output.output.find((item) => item.type === "chunk")!.code!}\nQuietScroll.installQuietScroll();`;
}

// Chromium hides scrollbars in headless mode unless told not to; the owner's app shows classic bars.
// macOS gives overlay (0 px) bars when "Show scroll bars" is Automatic without a mouse. An argument default applies to
// this process only; Playwright rejects an argument without a leading dash, so a wrapper appends it.
function classicChrome(): string | undefined {
	const chrome = findChrome();
	if (!chrome || process.platform !== "darwin") return chrome;
	const dir = mkdtempSync(join(tmpdir(), "ampi-quiet-scroll-")), wrapper = join(dir, "chrome");
	after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(chrome)} "$@" -AppleShowScrollBars Always\n`, { mode: 0o755 });
	return wrapper;
}
async function launchChromium(): Promise<Browser> {
	const browser = await chromium.launch({ headless: true, executablePath: classicChrome(), ignoreDefaultArgs: ["--hide-scrollbars"] });
	const page = await browser.newPage();
	await page.setContent('<div id="probe" style="height:100px;width:100px;overflow-y:auto"><div style="height:900px"></div></div>');
	const bar = await page.evaluate(() => { const el = document.getElementById("probe")!; return el.offsetWidth - el.clientWidth; });
	await page.close();
	assert.ok(bar > 0, "Chromium shows overlay scrollbars: the host's scroll bar setting reached the test");
	return browser;
}
const ENGINES = {
	chromium: launchChromium,
	webkit: () => webkit.launch({ headless: true }),
};
type Engine = keyof typeof ENGINES;
const browsers: Partial<Record<Engine, Promise<Browser>>> = {};
after(async () => { for (const browser of Object.values(browsers)) await (await browser)?.close(); });
let script: Promise<string> | undefined;

const LONG = Array.from({ length: 40 }, (_, i) => `Line ${i}: a long Composer draft ${"wrapping".repeat(20)} that wraps`).join("\n");
const FIXTURE = `
<div id="fixture" style="display:flex;flex-wrap:wrap;gap:24px;padding:24px;align-items:flex-start">
	<style>#fixture > * { flex: none; }</style>
	<div id="tall" class="quiet-scroll" style="height:200px;width:220px;overflow-y:auto;background:var(--bg)"><div style="height:900px"></div><button id="inner">inner</button></div>
	<div id="fits" class="quiet-scroll" style="height:200px;width:220px;overflow-y:auto;background:var(--bg)"><div style="height:40px"></div></div>
	<div id="list" class="side-scroll quiet-scroll" style="height:200px;width:220px;background:var(--bg)"><div style="height:40px"></div></div>
	<div id="outer" class="quiet-scroll" style="height:260px;width:260px;overflow-y:auto;background:var(--bg)"><div id="nested" class="quiet-scroll" style="height:120px;width:200px;overflow-y:auto;background:var(--bg)"><div style="height:600px"></div></div><div style="height:600px"></div></div>
	<div class="composer" style="width:320px"><textarea id="input" class="quiet-scroll" data-scrollbar="none"></textarea></div>
	<div class="main" style="height:200px;width:220px"><div id="transcript" class="scroll" style="background:var(--bg)"><div style="height:900px"></div></div></div>
</div>
<button id="away">away</button>`;

async function open(t: TestContext, engine: Engine, zoom: number): Promise<Page> {
	const code = await (script ??= revealScript());
	const browser = await (browsers[engine] ??= ENGINES[engine]());
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	t.after(() => page.context().close());
	page.setDefaultTimeout(3000);
	const css = readFileSync(join(web, "src/styles.css"), "utf8");
	await page.route("**/*", (route) => {
		const url = new URL(route.request().url());
		if (url.origin !== ORIGIN) return route.abort();
		if (url.pathname === "/reveal.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: code });
		if (url.pathname === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<meta charset="utf-8"><style>${css}</style>${FIXTURE}<script src="/reveal.js"></script>` });
		return route.abort();
	});
	await page.goto(`${ORIGIN}/`);
	await page.evaluate(([zoom, text]) => {
		document.documentElement.style.zoom = String(zoom);
		document.body.style.overflow = "auto";
		(document.getElementById("input") as HTMLTextAreaElement).value = text;
	}, [zoom, LONG] as const);
	await page.mouse.move(1430, 990);
	return page;
}

const settle = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
/** The region's geometry that a reveal must not change. */
const geometry = (page: Page, id: string) => page.evaluate((id) => {
	const el = document.getElementById(id)!;
	const anchor = el.firstElementChild!.getBoundingClientRect();
	return { bar: el.offsetWidth - el.clientWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, anchor: [anchor.left, anchor.top, anchor.width] };
}, id);
/** Whether the region's bar strip paints anything: it is compared with an empty strip of the same region. */
async function painted(page: Page, id: string) {
	const box = await page.evaluate((id) => {
		const el = document.getElementById(id)!;
		const r = el.getBoundingClientRect();
		// clientWidth rounds to whole CSS px; the content box's right edge does not.
		const scale = r.width / el.offsetWidth;
		const style = getComputedStyle(el);
		const inner = r.left + (Number.parseFloat(style.borderLeftWidth) + el.clientWidth) * scale;
		const probe = document.createElement("div");
		probe.style.cssText = "height:0;margin:0";
		el.append(probe);
		const content = probe.getBoundingClientRect().right + Number.parseFloat(style.paddingRight) * scale;
		probe.remove();
		const bar = r.right - Number.parseFloat(style.borderRightWidth) * scale - Math.max(inner, content);
		return { x: r.right - bar, y: r.top + 4, width: bar, height: r.height - 8, left: r.left + 40 };
	}, id);
	assert.ok(box.width >= 4, `${id}: the bar has a width of ${box.width.toFixed(1)} px`);
	const clip = { y: Math.round(box.y), width: Math.floor(box.width), height: Math.floor(box.height) };
	const strip = await page.screenshot({ clip: { ...clip, x: Math.ceil(box.x) } });
	const empty = await page.screenshot({ clip: { ...clip, x: Math.round(box.left) } });
	return !strip.equals(empty);
}

for (const engine of Object.keys(ENGINES) as Engine[]) for (const zoom of [1, 1.3]) {
	test(`${engine} at ${zoom}: a region that fits shows no bar and no gutter; the sidebar list's gutter paints nothing and keeps its rows`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, zoom);
		assert.equal((await geometry(page, "fits")).bar, 0, "a region that fits keeps a gutter");
		const fits = await geometry(page, "list");
		assert.equal(await painted(page, "list"), false, "the sidebar list's gutter paints");
		await page.evaluate(() => { (document.getElementById("list")!.firstElementChild as HTMLElement).style.height = "900px"; });
		await settle(page);
		const over = await geometry(page, "list");
		assert.deepEqual([over.anchor[0], over.anchor[2]], [fits.anchor[0], fits.anchor[2]], "the sidebar list's row moves or narrows when the list overflows");
		assert.equal(await painted(page, "list"), false, "the sidebar list's bar paints with the pointer outside");
	});

	test(`${engine} at ${zoom}: the bar shows only while the pointer or focus is inside its region, and nothing moves`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, zoom);
		await page.evaluate(() => { document.getElementById("tall")!.scrollTop = 120; });
		await page.waitForTimeout(1300);
		const rest = await geometry(page, "tall");
		assert.equal(await painted(page, "tall"), false, "the bar shows with the pointer outside");
		const box = (await page.locator("#tall").boundingBox())!;
		await page.mouse.move(box.x + 40, box.y + 60);
		await settle(page);
		assert.equal(await painted(page, "tall"), true, "the bar is hidden with the pointer inside");
		assert.deepEqual(await geometry(page, "tall"), rest, "the reveal moved the region");
		// The pointer on the bar itself is inside the region: the thumb stays.
		await page.mouse.move(box.x + box.width - 3, box.y + 30);
		await settle(page);
		assert.equal(await painted(page, "tall"), true, "the thumb fades under the pointer");
		await page.mouse.move(1430, 990);
		await settle(page);
		assert.equal(await painted(page, "tall"), false, "the bar stays after the pointer leaves");
		await page.focus("#inner");
		await page.evaluate(() => { document.getElementById("tall")!.scrollTop = 120; });
		await page.waitForTimeout(1300);
		assert.equal(await painted(page, "tall"), true, "keyboard focus inside does not show the bar");
		assert.deepEqual(await geometry(page, "tall"), rest, "the focus reveal moved the region");
		await page.focus("#away");
		await settle(page);
		assert.equal(await painted(page, "tall"), false, "the bar stays after focus leaves");
	});

	test(`${engine} at ${zoom}: a scroll shows the bar for about a second; a nested region shows only its own`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, zoom);
		await page.evaluate(() => { document.getElementById("tall")!.scrollTop = 200; });
		await settle(page);
		assert.equal(await painted(page, "tall"), true, "a scroll does not show the bar");
		await page.waitForTimeout(1300);
		assert.equal(await painted(page, "tall"), false, "the bar stays after the scroll reveal ends");
		const outer = (await page.locator("#outer").boundingBox())!;
		await page.mouse.move(outer.x + 40, outer.y + 200);
		await page.evaluate(() => { document.getElementById("nested")!.scrollTop = 0; });
		await page.waitForTimeout(1300);
		assert.equal(await painted(page, "outer"), true, "the outer region's bar is hidden with the pointer inside");
		assert.equal(await painted(page, "nested"), false, "the nested region's bar shows with the pointer outside it");
	});

	test(`${engine} at ${zoom}: the Composer input shows no bar, wraps, and still scrolls by wheel and caret`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, zoom);
		const input = page.locator("#input");
		const m = await input.evaluate((el: HTMLTextAreaElement) => ({ bar: el.offsetWidth - el.clientWidth, overflowX: el.scrollWidth - el.clientWidth, overflows: el.scrollHeight > el.clientHeight + 1 }));
		assert.equal(m.bar, 0, "the Composer input shows a bar");
		assert.ok(m.overflowX <= 1, `the Composer input scrolls ${m.overflowX} px sideways`);
		assert.ok(m.overflows, "the fixture overflows its height cap");
		const box = (await input.boundingBox())!;
		await page.mouse.move(box.x + 40, box.y + 20);
		await page.mouse.wheel(0, 200);
		await page.waitForFunction(() => document.getElementById("input")!.scrollTop > 0);
		await input.evaluate((el: HTMLTextAreaElement) => { el.scrollTop = 0; el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
		await page.keyboard.type("x");
		// WebKit scrolls the caret line into view and may stop inside the bottom padding.
		const caretInView = () => { const el = document.getElementById("input")!; return el.scrollTop + el.clientHeight >= el.scrollHeight - parseFloat(getComputedStyle(el).paddingBottom) - 2; };
		await page.waitForFunction(caretInView, undefined, { timeout: 3000 }).catch(async () => {
			const end = await input.evaluate((el: HTMLTextAreaElement) => ({ scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, paddingBottom: getComputedStyle(el).paddingBottom }));
			assert.fail(`typing at the end does not scroll the caret into view: ${JSON.stringify(end)}`);
		});
	});

	test(`${engine} at ${zoom}: the transcript scroller keeps its own bar`, { skip: engineSkip(engine) }, async (t) => {
		const page = await open(t, engine, zoom);
		// WebKit has no scrollbar-color; it reads ::-webkit-scrollbar, which only .quiet-scroll styles.
		const style = await page.evaluate(() => { const s = getComputedStyle(document.getElementById("transcript")!); return [s.scrollbarWidth, s.scrollbarColor ?? "auto"]; });
		assert.deepEqual(style, ["auto", "auto"], "a quiet style reached the transcript");
	});
}
