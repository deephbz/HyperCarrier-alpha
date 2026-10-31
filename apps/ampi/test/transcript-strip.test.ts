import "./bound.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { ENGINES, entries, frames, view, type Engine } from "./thread-scroll-fixture.ts";
// @ts-ignore: shared browser discovery is plain ESM.
import { findChrome } from "../scripts/perf/browser.mjs";
import { engineSkip } from "./engines.ts";

// The transcript's one strip (CompanionScrollbar): no native bar beside it, no estimated position cue, and dashes that
// keep their nodes, inert, while a new outline loads. The real ThreadView and stylesheet run in Chromium
// and WebKit; the hub is a script on the page's WebSocket. `MODE=strip` renders the strip alone, so a test can switch
// its Host, thread and version directly.

const web = fileURLToPath(new URL("../web", import.meta.url));
// A secure context: the Composer draws its send IDs from crypto.randomUUID.
const ORIGIN = "http://localhost";

async function stripScript(): Promise<string> {
	const entry = join(web, "transcript-strip-test-entry.js");
	const result = await build({
		configFile: false, root: web, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
			name: "transcript-strip-test",
			resolveId: (id) => id === entry ? `\0${entry}` : undefined,
			load: (id) => id === `\0${entry}` ? `
				import React from 'react';
				import { createRoot } from 'react-dom/client';
				import { ThreadView } from ${JSON.stringify(join(web, "src/components/ThreadView.tsx"))};
				import { CompanionScrollbar, NO_PLACE, usePromptRail, useThreadOutline } from ${JSON.stringify(join(web, "src/components/CompanionScrollbar.tsx"))};
				import { hub } from ${JSON.stringify(join(web, "src/client.ts"))};
				const root = createRoot(document.getElementById('root'));
				const h = React.createElement;
				// The strip as ThreadView mounts it: one outline request per thread version, no rendered prompts, and a rail
				// only when usePromptRail gives a layout.
				const Strip = ({ host, threadId, version }) => {
					const state = useThreadOutline(host, threadId, version), rail = usePromptRail(state.outline, NO_PLACE, undefined);
					return rail.layout ? h(CompanionScrollbar, { host, threadId, state, place: NO_PLACE, layout: rail.layout, strip: rail.strip }) : null;
				};
				if (window.MODE === 'strip') {
					const render = () => root.render(h('div', { style: { display: 'flex', height: '400px' } }, h(Strip, window.PROPS)));
					window.setProps = (props) => { window.PROPS = props; render(); };
					// ThreadView passes a version only from a snapshot, so the strip never asks before the hub connects.
					const start = setInterval(() => { if (hub.connected) { clearInterval(start); render(); } }, 10);
				} else {
					const summary = { id: 'pi:s1', title: 'Strip', createdAt: 0, updatedAt: 0, kind: 'thread', activity: 'idle', queued: 0, costUsd: 0 };
					const main = h('div', { className: 'main-slot', style: { height: '600px', flex: '1 1 auto', minWidth: 0 } },
						h(ThreadView, { host: 'devbox', threadId: 'pi:s1', summary, models: [], panel: window.PANEL ? 'team' : undefined, setPanel() {} }));
					// An open panel narrows the main slot beside it, as App lays it out.
					root.render(window.PANEL ? h('div', { style: { display: 'flex' } }, main, h('div', { className: 'panel-slot', style: { flex: '0 0 360px', height: '600px' } })) : main);
				}
			` : undefined,
		}],
		build: { write: false, minify: false, lib: { entry, formats: ["iife"], name: "TranscriptStripTest" } },
	});
	const output = (Array.isArray(result) ? result[0]! : result) as { output: { type: string; code?: string }[] };
	return output.output.find((item) => item.type === "chunk")!.code!;
}

/** Users at even ordinals of an n-entry branch; `prefix` renames all but e0, as another branch would. */
const outline = (n: number, version = `v${n}`, prefix = "e") => ({ version, totalEntries: n, truncated: false, users: entries(n).flatMap((e, i) => e.kind === "user" ? [{ id: i === 0 ? "e0" : `${prefix}${i}`, ordinal: i, firstLine: `Question ${i}` }] : []) });
const snap = (n: number, from = 0, extra: object = {}) => ({ ...view(n, "", from), sourceVersion: `v${n}`, ...extra });

let bundle: Promise<string> | undefined;
const browsers = new Map<Engine, Promise<Browser>>();
after(async () => { for (const b of browsers.values()) await (await b).close(); });

type Hub = {
	page: Page;
	/** A new thread snapshot; its outline reply waits while `hold` names its version. */
	publish: (value: object) => void;
	outlines: Map<string, object>;
	hold: Set<string>;
	release: (key: string) => void;
};

async function open(t: TestContext, engine: Engine, opts: { zoom?: number; region?: number; strip?: object; initial?: object; panel?: boolean } = {}): Promise<Hub> {
	const script = await (bundle ??= stripScript());
	if (!browsers.has(engine)) browsers.set(engine, engine === "webkit" ? webkit.launch({ headless: true }) : chromium.launch({ headless: true, executablePath: findChrome() }));
	const browser = await browsers.get(engine)!;
	const zoom = opts.zoom ?? 1, region = opts.region ?? 1;
	const page = await browser.newPage({ viewport: { width: Math.round((opts.panel ? 1360 : 1000) * zoom), height: Math.round(700 * zoom) } });
	t.after(() => page.context().close());
	page.setDefaultTimeout(4000);
	const css = readFileSync(join(web, "src/styles.css"), "utf8");
	const globals = opts.strip ? `window.MODE='strip';window.PROPS=${JSON.stringify(opts.strip)};` : `window.PANEL=${Boolean(opts.panel)};`;
	await page.route("**/*", (route) => {
		const url = new URL(route.request().url());
		if (url.origin !== ORIGIN) return route.abort();
		if (url.pathname === "/component.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: script });
		return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<meta charset="utf-8"><style>${css}${region === 1 ? "" : `[data-region=transcript]{zoom:${region}}`}</style><div id="root"></div><script>document.documentElement.style.zoom=${JSON.stringify(String(zoom))};${globals}</script><script src="/component.js"></script>` });
	});
	const outlines = new Map<string, object>(opts.initial ? [["", opts.initial]] : []), hold = new Set<string>(), held = new Map<string, () => void>();
	let current: object = snap(200);
	// The ThreadView tests key outlines by the current snapshot's version; the strip-alone tests by `publish` keys.
	let send!: (frame: unknown) => void, sid: number | undefined;
	await page.routeWebSocket("**/ws", (client) => {
		send = (frame) => client.send(JSON.stringify(frame));
		send({ t: "hosts", hosts: [{ id: "devbox", label: "devbox", kind: "pi-local", status: "connected" }, { id: "other", label: "other", kind: "pi-local", status: "connected" }] });
		client.onMessage((message) => {
			const f = JSON.parse(String(message));
			if (f.t === "sub" && f.topic?.kind === "thread") { sid = f.sid; send({ t: "snap", sid, value: current }); }
			else if (f.t === "sub") send({ t: "snap", sid: f.sid, value: f.topic?.kind === "threads" ? { threads: {} } : {} });
			else if (f.t === "req" && f.op === "thread.outline") {
				const version = (current as { sourceVersion?: string }).sourceVersion!;
				const key = version;
				const holdKey = opts.strip ? nextKey : key;
				const reply = () => send({ t: "res", id: f.id, ok: true, value: outlines.get(holdKey) ?? outline(Number(version.slice(1))) });
				if (hold.has(holdKey)) held.set(holdKey, reply); else reply();
			} else if (f.t === "req" || f.t === "hub") send({ t: "res", id: f.id, ok: false, error: { code: "unsupported", message: "not in this test" } });
		});
	});
	// The strip asks with {threadId} only; the test names which outline the next request receives.
	let nextKey = "";
	await page.goto(`${ORIGIN}/`);
	return {
		page,
		publish: (value) => {
			if (opts.strip) { nextKey = (value as { key: string }).key; return void page.evaluate((props) => (window as any).setProps(props), (value as { props: object }).props); }
			current = value; send({ t: "snap", sid, value });
		},
		outlines, hold,
		release: (key) => { const reply = held.get(key); held.delete(key); hold.delete(key); reply?.(); },
	};
}

/** Tags every dash node and samples each frame: the fewest dashes seen and how many tagged nodes left the page. */
const sample = (page: Page) => page.evaluate(() => {
	const w = window as any;
	w.__tagged = [...document.querySelectorAll("[data-user-mark]")];
	w.__s = { min: Infinity, lost: 0, frames: 0, run: true };
	const loop = () => {
		const s = w.__s;
		s.min = Math.min(s.min, document.querySelectorAll("[data-user-mark]").length);
		s.lost = Math.max(s.lost, w.__tagged.filter((a: Element) => !a.isConnected).length);
		s.frames++;
		if (s.run) requestAnimationFrame(loop);
	};
	requestAnimationFrame(loop);
	return w.__tagged.length as number;
});
const sampled = (page: Page) => page.evaluate(() => { const w = window as any; w.__s.run = false; return w.__s as { min: number; lost: number; frames: number }; });
const busy = (page: Page) => page.locator(".companion-scrollbar").getAttribute("aria-busy");
const waitFrames = async (page: Page, n: number) => { for (let i = 0; i < n; i++) await frames(page); };

for (const engine of ENGINES) test(`${engine}: a new message keeps every dash node while its outline loads; no opacity transition`, { skip: engineSkip(engine) }, async (t) => {
	const { page, publish, hold, release } = await open(t, engine);
	await page.locator('[data-outline-version="v200"]').waitFor();
	const tagged = await sample(page);
	assert.equal(tagged, 100);
	hold.add("v202");
	publish(snap(202));
	await page.locator('[data-entry="e201"]').waitFor({ state: "attached" });
	await waitFrames(page, 4);
	assert.equal(await page.locator("[data-user-mark]").count(), 100, "the old dashes stay while the reply is held");
	assert.equal(await busy(page), "true", "the strip says its outline is behind");
	assert.equal(await page.locator("[data-user-mark][href]").count(), 0, "kept dashes do not link while busy");
	release("v202");
	await page.locator('[data-outline-version="v202"]').waitFor();
	await frames(page);
	const s = await sampled(page);
	assert.ok(s.frames >= 4, `sampled ${s.frames} frames`);
	assert.equal(s.min, 100, "no frame showed fewer dashes");
	assert.equal(s.lost, 0, "every old dash kept its node");
	assert.equal(await page.locator('[data-user-mark="e200"]').count(), 1);
	assert.equal(await busy(page), "false");
	const transitions = await page.locator(".companion-scrollbar").evaluate((nav) => [...nav.querySelectorAll("a, a span")].map((n) => getComputedStyle(n).transitionDuration));
	assert.ok(transitions.every((d) => d.split(",").every((x) => parseFloat(x) === 0)), `transitions: ${[...new Set(transitions)]}`);
});

for (const engine of ENGINES) test(`${engine}: stream, append and window slide with the panel open keep dash nodes, width and the hidden bar`, { skip: engineSkip(engine) }, async (t) => {
	const { page, publish } = await open(t, engine, { zoom: 1.3, region: 1.2, panel: true });
	await page.locator('[data-outline-version="v200"]').waitFor();
	const scroller = page.locator("[data-region=transcript]");
	const width = () => scroller.evaluate((el) => ({ client: el.clientWidth, bar: (el as HTMLElement).offsetWidth - el.clientWidth }));
	const before = await width();
	assert.equal(before.bar, 0, "no native bar or gutter");
	await sample(page);
	const live = (lines: number) => ({ run: { activity: "streaming" }, generation: { message: { role: "assistant", content: [{ type: "text", text: Array.from({ length: lines }, (_, i) => `Streamed line ${i + 1}.`).join("\n\n") }] } } });
	for (const lines of [2, 8, 20]) { publish(snap(200, 0, { live: live(lines) })); await waitFrames(page, 2); }
	publish(snap(202)); await page.locator('[data-outline-version="v202"]').waitFor();
	publish(snap(204)); await page.locator('[data-outline-version="v204"]').waitFor();
	// A capped tail slides its window: the oldest served entries leave the page, the branch outline keeps them.
	publish(snap(206, 40)); await page.locator('[data-outline-version="v206"]').waitFor();
	await frames(page);
	const s = await sampled(page);
	assert.equal(s.min, 100);
	assert.equal(s.lost, 0);
	assert.equal(await page.locator("[data-user-mark]").count(), 103);
	assert.deepEqual(await width(), before);
	assert.equal(await page.locator(".companion-scrollbar").count(), 1);
});

/** The strip's parts: anything besides dashes would be a position cue; dash ids in DOM order; dashes with an inline position. */
const stripParts = (page: Page) => page.locator(".companion-scrollbar").evaluate((nav) => {
	const dashes = [...nav.querySelectorAll<HTMLElement>("a[data-user-mark]")];
	return {
		others: [...nav.children].filter((c) => !c.matches("a[data-user-mark]")).length,
		ids: dashes.map((a) => a.dataset.userMark!),
		placed: dashes.filter((a) => a.style.top !== "").length,
	};
});
const ordinal = (id: string) => id === "e0" ? 0 : Number(id.slice(1));
const ascending = (ids: string[]) => ids.every((id, i) => i === 0 || ordinal(ids[i - 1]!) < ordinal(id));

for (const engine of ENGINES) for (const [zoom, region] of [[1, 1], [1.3, 1], [1.3, 1.2]] as const) test(`${engine} ${zoom}/${region}: one strip; hover, focus and wheel keep layout`, { skip: engineSkip(engine) }, async (t) => {
	const { page } = await open(t, engine, { zoom, region });
	await page.locator('[data-outline-version="v200"]').waitFor();
	const scroller = page.locator("[data-region=transcript]");
	assert.equal(await page.locator(".companion-scrollbar").count(), 1);
	assert.equal(await scroller.evaluate((el) => (el as HTMLElement).offsetWidth - el.clientWidth), 0, "no native bar or gutter");
	assert.equal((await stripParts(page)).others, 0, "the strip holds dashes only");
	await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight * 0.5; });
	await waitFrames(page, 2);
	const frame = (await page.locator(".transcript-frame").boundingBox())!;
	await page.mouse.move(1, 1);
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	const measure = () => scroller.evaluate((el) => {
		const top = el.getBoundingClientRect().top;
		const node = [...el.querySelectorAll<HTMLElement>("[data-entry]")].find((n) => n.getBoundingClientRect().bottom > top + 40)!;
		return { client: el.clientWidth, height: el.scrollHeight, id: node.dataset.entry, offset: Math.round((node.getBoundingClientRect().top - top) * 100) / 100 };
	});
	const rest = await measure();
	await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2);
	await frames(page);
	assert.deepEqual(await measure(), rest, "hover keeps layout");
	await page.mouse.move(1, 1);
	await scroller.evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));
	await frames(page);
	assert.deepEqual(await measure(), rest, "focus keeps layout");
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	// A wheel over the strip scrolls the transcript, as it did over the native bar.
	const strip = (await page.locator(".companion-scrollbar").boundingBox())!;
	const top = await scroller.evaluate((el) => el.scrollTop);
	await page.mouse.move(strip.x + strip.width / 2, strip.y + strip.height / 2);
	await page.mouse.wheel(0, -300);
	await page.waitForFunction((top) => document.querySelector<HTMLElement>("[data-region=transcript]")!.scrollTop < top - 50, top);
	assert.equal((await stripParts(page)).others, 0);
});

for (const engine of ENGINES) test(`${engine}: widely separated omitted segments: dashes keep outline order and no position is estimated`, { skip: engineSkip(engine) }, async (t) => {
	const { page, publish } = await open(t, engine);
	await page.locator('[data-outline-version="v200"]').waitFor();
	// An 1100-entry branch served as e0..e58 and e999..e1099: the assistant e999 renders right after the user e58.
	publish({ ...snap(1100), entries: view(1100).entries.filter((_, i) => i < 59 || i >= 999) });
	await page.locator('[data-outline-version="v1100"]').waitFor();
	await page.locator('[data-entry="e999"]').evaluate((node) => node.scrollIntoView({ block: "start" }));
	await waitFrames(page, 2);
	const frame = (await page.locator(".transcript-frame").boundingBox())!;
	await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2);
	await frames(page);
	const visible = await page.evaluate(() => {
		const el = document.querySelector<HTMLElement>("[data-region=transcript]")!, box = el.getBoundingClientRect();
		return [...el.querySelectorAll<HTMLElement>("[data-entry]")].filter((n) => { const r = n.getBoundingClientRect(); return r.bottom > box.top && r.top < box.bottom; }).map((n) => n.dataset.entry);
	});
	assert.ok(visible.includes("e999"), `visible: ${visible}`);
	const parts = await stripParts(page);
	assert.equal(parts.others, 0, "no band or other position cue");
	assert.equal(parts.ids.length, 550);
	assert.ok(ascending(parts.ids), "dashes follow outline order");
	for (const id of ["e58", "e1000", "e1098"]) assert.ok(parts.ids.includes(id), `${id} has a dash`);
	assert.equal(parts.placed, 0, "no dash carries an estimated position");
});

for (const engine of ENGINES) test(`${engine}: a window with no rendered user entry keeps every dash and shows no position cue`, { skip: engineSkip(engine) }, async (t) => {
	const { page, publish } = await open(t, engine);
	await page.locator('[data-outline-version="v200"]').waitFor();
	publish({ ...snap(200), entries: view(200).entries.filter((_, i) => i % 2 === 1) });
	await page.waitForFunction(() => document.querySelector("[data-region=transcript] .msg.user") === null && document.querySelector('[data-entry="e199"]') !== null);
	const frame = (await page.locator(".transcript-frame").boundingBox())!;
	await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2);
	await frames(page);
	const parts = await stripParts(page);
	assert.equal(parts.others, 0, "no band or other position cue");
	assert.equal(parts.ids.length, 100);
	assert.ok(ascending(parts.ids), "dashes follow outline order");
	assert.equal(parts.placed, 0, "no dash carries an estimated position");
	assert.equal(await busy(page), "false");
});

for (const engine of ENGINES) test(`${engine}: a branch replaced while its outline is held: old dashes are inert, a click goes nowhere, new dashes link`, { skip: engineSkip(engine) }, async (t) => {
	const { page, publish, outlines, hold, release } = await open(t, engine);
	await page.locator('[data-outline-version="v200"]').waitFor();
	const hash = await page.evaluate(() => location.hash);
	outlines.set("b202", outline(202, "b202", "f")); hold.add("b202");
	publish({ ...snap(202), sourceVersion: "b202", entries: view(202).entries.map((e, i) => i === 0 ? e : { ...e, id: `f${i}` }) });
	await page.locator('[data-entry="f201"]').waitFor({ state: "attached" });
	assert.equal(await busy(page), "true");
	// A sampled-in dash of the old branch; the rail hides the others (railLayout). The reader's place settles first,
	// because the prompts on screen move the sample.
	await waitFrames(page, 3);
	const id = (await page.locator('[data-user-mark^="e"]:not(.skip):not([data-user-mark="e0"])').last().getAttribute("data-user-mark"))!;
	const old = page.locator(`[data-user-mark="${id}"]`);
	assert.equal(await old.getAttribute("href"), null);
	assert.equal(await old.getAttribute("aria-disabled"), "true");
	assert.equal(await old.evaluate((a) => getComputedStyle(a).pointerEvents), "none");
	const paint = (id: string) => page.locator(`[data-user-mark="${id}"] span`).evaluate((n) => { const s = getComputedStyle(n); return `${s.backgroundColor} ${s.opacity}`; });
	const dim = await paint(id);
	const box = (await old.boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	assert.equal(await old.evaluate((a) => a.matches(":hover")), false, "a kept dash takes no hover");
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
	await old.evaluate((a) => (a as HTMLElement).click());
	await waitFrames(page, 3);
	assert.equal(await page.evaluate(() => location.hash), hash, "a click on a kept dash navigates nowhere");
	release("b202");
	await page.locator('[data-outline-version="b202"]').waitFor();
	assert.equal(await old.count(), 0);
	assert.notEqual(await paint("e0"), dim, "a busy dash paints dimmer than a linked one");
	// The new branch has one more prompt, so its sample can differ: click an idle dash it shows.
	const fresh = (await page.locator('[data-user-mark^="f"]:not(.skip):not(.in)').last().getAttribute("data-user-mark"))!;
	assert.equal(await paint("e0"), await paint(fresh));
	await page.locator(`[data-user-mark="${fresh}"]`).click();
	await page.waitForFunction((id) => location.hash.includes(`e=${id}`), fresh);
});

for (const engine of ENGINES) test(`${engine}: strip identity: branch switch keeps dashes until replaced; thread switch drops them; late replies are ignored`, { skip: engineSkip(engine) }, async (t) => {
	const props = (threadId: string, version: string, host = "devbox") => ({ host, threadId, version });
	const { page, publish, outlines, hold, release } = await open(t, engine, { strip: props("t1", "v10"), initial: outline(20, "v10") });
	// The users of outline(n, ·, prefix): a rail needs at least 8, so these outlines hold 8 to 14.
	const ids = (n: number, prefix = "e") => outline(n, "", prefix).users.map((u) => u.id);
	const dashes = () => page.locator("[data-user-mark]").evaluateAll((all) => all.map((a) => (a as HTMLElement).dataset.userMark));
	await page.locator('[data-outline-version="v10"]').waitFor();
	assert.deepEqual(await dashes(), ids(20));
	await sample(page);
	// Branch switch: the same thread at a new version with other users. The old dashes stay until the reply.
	outlines.set("b12", outline(24, "b12", "f")); hold.add("b12");
	publish({ key: "b12", props: props("t1", "b12") });
	await waitFrames(page, 3);
	assert.deepEqual(await dashes(), ids(20));
	assert.equal(await busy(page), "true");
	release("b12");
	await page.locator('[data-outline-version="b12"]').waitFor();
	assert.deepEqual(await dashes(), ids(24, "f"));
	const s = await sampled(page);
	assert.equal(s.min, 10, "no empty frame across the branch switch");
	assert.equal(await page.evaluate(() => ((window as any).__tagged as Element[]).filter((a) => a.isConnected).map((a) => (a as HTMLElement).dataset.userMark)).then((ids) => ids.join()), "e0", "the shared user keeps its node");
	// A request for t1 is in flight when the thread changes: the dashes go at once, and the late t1 reply never lands.
	outlines.set("t1-14", outline(28, "v14")); hold.add("t1-14");
	publish({ key: "t1-14", props: props("t1", "v14") });
	outlines.set("t2", outline(16, "w8", "g")); hold.add("t2");
	publish({ key: "t2", props: props("t2", "w8") });
	await frames(page);
	assert.deepEqual(await dashes(), [], "a thread switch drops the old thread's dashes");
	release("t1-14");
	await waitFrames(page, 3);
	assert.deepEqual(await dashes(), []);
	release("t2");
	await page.locator('[data-outline-version="w8"]').waitFor();
	assert.deepEqual(await dashes(), ids(16, "g"));
	// Out of order on one thread: the newer reply wins and the older one is ignored.
	outlines.set("w10", outline(20, "w10", "g")); hold.add("w10");
	publish({ key: "w10", props: props("t2", "w10") });
	outlines.set("w12", outline(24, "w12", "g"));
	publish({ key: "w12", props: props("t2", "w12") });
	await page.locator('[data-outline-version="w12"]').waitFor();
	release("w10");
	await waitFrames(page, 3);
	assert.equal(await page.locator('[data-outline-version="w12"]').count(), 1);
	// A Host change with the same thread id is another thread.
	outlines.set("other", outline(16, "x8", "h")); hold.add("other");
	publish({ key: "other", props: props("t2", "x8", "other") });
	await frames(page);
	assert.deepEqual(await dashes(), []);
	release("other");
	await page.locator('[data-outline-version="x8"]').waitFor();
	assert.deepEqual(await dashes(), ids(16, "h"));
});

for (const engine of ENGINES) test(`${engine}: the header names the Find icon`, { skip: engineSkip(engine) }, async (t) => {
	const idle = (await open(t, engine)).page;
	const find = idle.getByRole("button", { name: "Find in this Session", exact: true });
	await find.waitFor();
	assert.equal((await find.innerText()).trim(), "", "the Find button shows an icon, not a word");
	assert.equal(await find.getAttribute("aria-expanded"), "false");
	await find.click();
	await idle.getByRole("search", { name: "Find in this Session" }).waitFor();
	assert.equal(await find.getAttribute("aria-expanded"), "true");
});
