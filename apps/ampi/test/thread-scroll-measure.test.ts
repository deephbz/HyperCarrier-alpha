import "./bound.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Page } from "playwright";
import { engineSkip } from "./engines.ts";
import { ENGINES, anchor, componentScript, entries, frames, grown, open as openBase, settled, view as baseView, type Engine } from "./thread-scroll-fixture.ts";

const view = (n: number, tail = "") => ({ ...baseView(n, tail), sourceVersion: "measure-v1" });
const outline = (n: number) => ({ version: "measure-v1", totalEntries: n, truncated: false, users: entries(n).flatMap((e, i) => e.kind === "user" ? [{ id: e.id, ordinal: i, firstLine: e.text }] : []) });
async function open(t: TestContext, count: number, backend: "pi", engine: Engine, zoom = 1) {
	const fixture = await openBase(t, count, backend, engine, zoom);
	fixture.answer((frame, reply) => {
		if (frame.op !== "thread.outline") return false;
		reply({ ok: true, value: outline(count) }); return true;
	});
	fixture.send(view(count));
	await fixture.page.locator(".companion-scrollbar").waitFor();
	return fixture;
}

const output = process.env.AMPI_SCROLL_MEASURE_DIR;
type Frame = { at: number; top: number; row: number | null; viewportTop: number; height: number; content: number; client: number; width: number; fonts: string; images: number; composer: number; textarea: number; status: string };
async function record(page: Page, id: string) {
	await page.evaluate(id => {
		const el = document.querySelector<HTMLElement>("[data-region=transcript]")!;
		const state = { frames: [] as unknown[], events: [] as unknown[], active: true };
		(window as any).scrollMeasure = state;
		const note = (kind: string, value: unknown) => state.events.push({ at: performance.now(), kind, value });
		const observer = new ResizeObserver(records => note("resize", records.map(r => ({ class: (r.target as HTMLElement).className, width: r.contentRect.width, height: r.contentRect.height }))));
		observer.observe(el); for (const child of el.children) observer.observe(child);
		const composer = document.querySelector<HTMLElement>(".composer-wrap")!;
		observer.observe(composer);
		const mutations = new MutationObserver(records => note("mutation", records.map(r => ({ type: r.type, class: (r.target as HTMLElement).className }))));
		mutations.observe(el.parentElement!.parentElement!, { subtree: true, childList: true, characterData: true, attributes: true });
		const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
		Object.defineProperty(el, "scrollTop", { configurable: true, get() { return descriptor.get!.call(el); }, set(value) { note("scrollTop-write", { value, stack: new Error().stack }); descriptor.set!.call(el, value); } });
		const scrollTo = el.scrollTo.bind(el);
		el.scrollTo = ((...args: any[]) => { note("scrollTo", args); return (scrollTo as any)(...args); }) as typeof el.scrollTo;
		const tick = () => {
			const row = el.querySelector<HTMLElement>(`[data-entry="${id}"]`), rect = el.getBoundingClientRect();
			state.frames.push({ at: performance.now(), top: el.scrollTop, row: row?.getBoundingClientRect().top ?? null, viewportTop: rect.top, height: rect.height, content: el.scrollHeight, client: el.clientHeight, width: el.clientWidth, fonts: document.fonts.status, images: [...el.querySelectorAll("img")].filter(i => !i.complete).length, composer: composer.getBoundingClientRect().height, textarea: document.querySelector(".composer textarea")?.getBoundingClientRect().height ?? 0, status: el.querySelector(".status-line")?.textContent?.trim() ?? "" });
			if (state.active) requestAnimationFrame(tick); else { observer.disconnect(); mutations.disconnect(); }
		};
		tick();
	}, id);
}
async function finish(page: Page, name: string) {
	const data = await page.evaluate(() => { const state = (window as any).scrollMeasure; state.active = false; return state; }) as { frames: Frame[]; events: any[] };
	const span = (values: number[]) => Math.max(...values) - Math.min(...values);
	const rows = data.frames.flatMap(f => f.row === null ? [] : [f.row]);
	const summary = { name, frames: data.frames.length, scrollDrift: span(data.frames.map(f => f.top)), rowDrift: span(rows), viewportDrift: span(data.frames.map(f => f.viewportTop)), heightDrift: span(data.frames.map(f => f.height)), contentDrift: span(data.frames.map(f => f.content)), missingRow: rows.length !== data.frames.length,
		reverseSteps: data.frames.slice(1).filter((f, i) => f.top < data.frames[i].top).length,
		overshoot: Math.max(...data.frames.map(f => Math.max(0, f.top - (f.content - f.client), -f.top))),
		composerDrift: span(data.frames.map(f => f.composer)), textareaDrift: span(data.frames.map(f => f.textarea)),
		writes: data.events.filter(e => e.kind === "scrollTop-write" || e.kind === "scrollTo").length };
	if (output) { mkdirSync(output, { recursive: true }); writeFileSync(join(output, name + ".json"), JSON.stringify({ summary, ...data }, null, 2)); }
	console.log("scroll-measure " + JSON.stringify(summary));
	return summary;
}
async function sample(page: Page, count = 45) {
	await page.evaluate(count => new Promise<void>(resolve => {
		let left = count; const tick = () => --left <= 0 ? resolve() : requestAnimationFrame(tick); requestAnimationFrame(tick);
	}), count);
}

// The shared fixture keeps summary static. This projection lets status updates reach the real Composer and ThreadView.
let activeScript: Promise<string> | undefined;
async function activeOpen(t: TestContext, engine: Engine, width: number) {
	const fixture = await openBase(t, 201, "pi", engine, 1, 1, { width, height: 700 });
	const script = await (activeScript ??= componentScript().then(code => {
		const before = /activity:\s*"idle"/g;
		const matches = [...code.matchAll(before)];
		const summaryAt = code.indexOf('title: "Scroll hold"');
		assert.ok(summaryAt >= 0, "The fixture summary must remain identifiable");
		const activityAt = matches.find(match => match.index! > summaryAt);
		assert.ok(activityAt && activityAt.index! - summaryAt < 300, "The fixture summary activity must follow its title");
		return code.slice(0, activityAt.index) + 'get activity() { return window.measureActivity || "thinking"; }, control: true' + code.slice(activityAt.index! + activityAt[0].length);
	}));
	await fixture.page.route("**/component.js", route => route.fulfill({ contentType: "text/javascript", body: script }));
	fixture.answer((frame, reply) => {
		if (frame.op !== "thread.outline") return false;
		reply({ ok: true, value: outline(201) }); return true;
	});
	fixture.hold({ ...view(201), live: { run: { startedAt: 1 } } });
	await fixture.page.reload();
	await fixture.page.locator(".companion-scrollbar").waitFor();
	await fixture.page.getByRole("button", { name: "■ Stop", exact: true }).waitFor();
	await fixture.page.evaluate(() => { (window as any).parentTicks = true; });
	await settled(fixture.page); await sample(fixture.page, 30);
	return fixture;
}
async function statusUpdates(page: Page) {
	for (const activity of ["tools", "streaming", "waiting", "thinking", "tools", "waiting", "streaming", "thinking"]) {
		await page.evaluate(activity => { (window as any).measureActivity = activity; }, activity);
		await page.locator(".status-line").filter({ hasText: activity === "tools" ? "running tools" : activity === "streaming" ? "writing" : activity === "waiting" ? "waiting on subthreads" : "thinking" }).waitFor();
		await sample(page, 20);
	}
}

for (const engine of ENGINES) {
	for (const width of [1000, 390]) test(`scroll measure (${engine}): active status updates keep the tail and composer still at width ${width}`, { skip: engineSkip(engine) }, async t => {
		const { page } = await activeOpen(t, engine, width);
		await record(page, "e200"); await statusUpdates(page);
		const result = await finish(page, `${engine}-tail-active-${width}`);
		assert.equal(result.missingRow, false); assert.equal(result.rowDrift, 0); assert.equal(result.scrollDrift, 0);
		assert.equal(result.contentDrift, 0); assert.equal(result.heightDrift, 0); assert.equal(result.composerDrift, 0); assert.equal(result.textareaDrift, 0);
	});

	test(`scroll measure (${engine}): active tail stays still with loaded font, code and image`, { skip: engineSkip(engine) }, async t => {
		const fixture = await activeOpen(t, engine, 1000), { page, send } = fixture;
		const fontPath = process.env.AMPI_SCROLL_MEASURE_FONT || ["/System/Library/Fonts/SFNSMono.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "C:/Windows/Fonts/consola.ttf"].find(existsSync);
		assert.ok(fontPath, "Set AMPI_SCROLL_MEASURE_FONT to an installed TTF font");
		await page.route("**/measure-font.ttf", route => route.fulfill({ contentType: "font/ttf", body: readFileSync(fontPath) }));
		const image = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="steelblue"/></svg>').toString("base64");
		let releaseImage: (() => void) | undefined;
		await page.route("**/measure-image.svg", route => { releaseImage = () => { void route.fulfill({contentType:"image/svg+xml",body:Buffer.from(image,"base64")}); }; });
		const rich = view(201);
		(rich.entries[198] as any).images = 1;
		rich.entries[199] = { id: "e199", kind: "assistant", blocks: [{ type: "text", text: "Synthetic code sample\n\n```ts\nconst total = [1, 2, 3].reduce((a, b) => a + b, 0);\nconsole.log(total);\n```" }] };
		send({ ...rich, live: { run: { startedAt: 1 } } });
		await page.locator('[data-entry="e199"] pre').waitFor({ state: "attached" });
		// Pi now renders an image count. Inject only synthetic asset geometry into the real row for this load test.
		await page.locator('[data-entry="e198"]').evaluate(el=>{const image=document.createElement("img");image.src="/measure-image.svg";el.append(image);});
		await sample(page, 30);
		await record(page, "e200");
		await page.addStyleTag({ content: '@font-face { font-family: MeasureFont; src: url("/measure-font.ttf"); } .thread-view { font-family: MeasureFont; } .transcript, .composer, .transcript pre, .transcript code { font-family: MeasureFont !important; }' });
		await page.evaluate(() => document.fonts.load("14px MeasureFont"));
		assert.ok(releaseImage, "The synthetic image read is pending"); releaseImage();
		await page.locator('[data-entry="e198"] img').waitFor({ state: "attached" });
		await page.evaluate(() => Promise.all([...document.images].map(image => image.decode())));
		await settled(page); await sample(page, 30);
		const loading = await finish(page, `${engine}-tail-assets-loading`);
		assert.equal(loading.reverseSteps,0,"asset growth must never reverse the tail");
		assert.equal(loading.overshoot,0);
		await record(page, "e200"); await statusUpdates(page);
		const result = await finish(page, `${engine}-tail-active-assets`);
		assert.equal(result.missingRow, false); assert.equal(result.rowDrift, 0); assert.equal(result.scrollDrift, 0);
		assert.equal(result.contentDrift, 0); assert.equal(result.heightDrift, 0); assert.equal(result.composerDrift, 0); assert.equal(result.textareaDrift, 0);
	});

	for (const arrival of ["stream", "tool", "message"] as const) test(`scroll measure (${engine}): away row stays at zero drift during ${arrival}`, { skip: engineSkip(engine) }, async t => {
		const { page, send } = await open(t, 201, "pi", engine);
		await page.locator("[data-region=transcript]").hover();
		await page.mouse.wheel(0, -900); await settled(page); await frames(page);
		const read = await anchor(page);
		await record(page, read.id);
		for (let n = 1; n <= 8; n++) {
			const current = view(201, arrival === "stream" ? grown(n) : "");
			if (arrival === "tool") current.entries.push({ id: "tool-call", kind: "assistant", blocks: [{ type: "tool", callId: "synthetic-call", name: "bash", args: { command: "synthetic" } }] }, { id: "tool-result", kind: "tool-result", callId: "synthetic-call", name: "bash", text: "Synthetic output\n".repeat(n * 5), truncated: false, isError: false });
			if (arrival === "message") current.entries.push({ id: `new-message-${n}`, kind: "user", text: `New synthetic message ${n}`, images: 0 });
			send(current); await sample(page, 4);
		}
		await sample(page);
		const result = await finish(page, `${engine}-away-${arrival}`);
		assert.equal(result.missingRow, false); assert.equal(result.rowDrift, 0, "The on-screen reference row must not move");
	});

	for (const zoom of [0.7, 0.8, 1, 1.3, 1.6]) test(`scroll measure (${engine}): unchanged tail has zero movement through parent renders at zoom ${zoom}`, { skip: engineSkip(engine) }, async t => {
		const { page } = await open(t, 201, "pi", engine, zoom);
		await settled(page); await sample(page, 30);
		await page.evaluate(() => { (window as any).parentTicks = true; });
		await record(page, "e200"); await sample(page, zoom === 1 ? 600 : 90);
		const result = await finish(page, `${engine}-tail-idle-${zoom}`);
		assert.equal(result.missingRow, false); assert.equal(result.rowDrift, 0); assert.equal(result.scrollDrift, 0); assert.equal(result.heightDrift, 0); assert.equal(result.contentDrift, 0);
		assert.equal(result.writes,0,"unchanged content must produce no follow writes");
	});

	for (const line of ["top+40", "middle"]) test(`scroll measure (${engine}): a delayed image above the away ${line} anchor keeps its screen position`, { skip: engineSkip(engine) }, async t => {
		const { page } = await open(t, 201, "pi", engine);
		await page.locator("[data-region=transcript]").hover(); await page.mouse.wheel(0, -1200); await settled(page); await frames(page);
		const read = line === "top+40" ? await anchor(page) : await page.locator("[data-region=transcript]").evaluate(el => {
			const box = el.getBoundingClientRect(), middle = box.top + box.height / 2;
			const row = [...el.querySelectorAll<HTMLElement>("[data-entry]")].find(node => !node.closest("summary") && node.getBoundingClientRect().bottom > middle)!;
			return { id: row.dataset.entry! };
		});
		const position = () => page.locator(`[data-entry="${read.id}"]`).first().evaluate(el => el.getBoundingClientRect().top);
		const before = await position();
		await page.evaluate(id => {
			const root = document.querySelector<HTMLElement>("[data-region=transcript]")!;
			const row = root.querySelector<HTMLElement>(`[data-entry="${id}"]`)!;
			const above = [...root.querySelectorAll<HTMLElement>("[data-entry]")].filter(el => el.getBoundingClientRect().bottom < row.getBoundingClientRect().top).at(-1)!;
			const image = document.createElement("img"); image.id = "delayed-synthetic"; image.style.display = "block"; above.append(image);
		}, read.id);
		await frames(page);
		await page.evaluate(() => { (document.querySelector("#delayed-synthetic") as HTMLImageElement).src = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="blue"/></svg>'); });
		await page.evaluate(() => (document.querySelector("#delayed-synthetic") as HTMLImageElement).decode()); await frames(page); await settled(page);
		const after = await position();
		t.diagnostic(JSON.stringify({ engine, line, before, after, drift: after - before }));
		assert.equal(after, before, "late geometry above the anchor cannot move the away reader");
	});

	test(`scroll measure (${engine}): tail growth has no reverse steps or overshoot`, { skip: engineSkip(engine) }, async t => {
		const { page, send } = await open(t, 201, "pi", engine);
		send(view(201, grown(10))); await sample(page, 30); await settled(page);
		await record(page, "e200");
		for (let n = 11; n <= 24; n++) { send(view(201, grown(n))); await sample(page, 4); }
		await sample(page, 30);
		const result = await finish(page, `${engine}-tail-growth`);
		assert.equal(result.missingRow, false); assert.equal(result.reverseSteps, 0); assert.equal(result.overshoot, 0);
	});

	test(`scroll measure (${engine}): Composer growth and shrink keep the tail pinned`, { skip: engineSkip(engine) },async t=>{
        const {page}=await activeOpen(t,engine,1000);
        const draft=page.getByRole('textbox',{name:'Message the agent'});
        await record(page,'e200');
        const gaps:number[]=[];
        const heights:number[]=[];
        for(const lines of [1,2,4,8,24,48,8,2,0]){
            await draft.fill('Typed line.\n'.repeat(lines));
            await frames(page);await frames(page);
            const value=await page.locator('[data-region=transcript]').evaluate(el=>({gap:el.scrollHeight-el.clientHeight-el.scrollTop,height:el.clientHeight}));
            gaps.push(value.gap);heights.push(value.height);
        }
        const result=await finish(page,`${engine}-tail-composer-resize`);
        assert.ok(result.composerDrift>0&&result.textareaDrift>0,'the Composer really grows and shrinks');
        assert.ok(gaps.every(gap=>Math.abs(gap)<=1),`tail gaps ${gaps}`);
        assert.equal(result.overshoot,0);
        t.diagnostic(JSON.stringify({engine,gaps,heights}));
    });

	test(`scroll measure (${engine}): canceled history cue cannot move the away reference row`, { skip: engineSkip(engine) }, async t => {
		const fixture = await open(t, 401, "pi", engine), { page, send } = fixture;
		send({ ...view(401), entries: entries(401).slice(-200), hiddenBefore: true });
		await frames(page);
		let replyHistory: (() => void) | undefined;
		fixture.answer((frame, reply) => {
			if (frame.op === "thread.outline") { reply({ ok: true, value: outline(401) }); return true; }
			if (frame.op === "thread.history") { replyHistory = () => reply({ ok: true, value: { entries: [], more: true, version: "measure-v1" } }); return true; }
			return false;
		});
		await page.evaluate(() => { (window as any).ENTRY = "e0"; (window as any).parentTicks = true; });
		await page.locator("[data-history-cue]").waitFor();
		await page.locator("[data-region=transcript]").hover(); await page.mouse.wheel(0, -900); await settled(page);
		const read = await anchor(page);
		await record(page, read.id); await sample(page, 10);
		assert.ok(replyHistory, "The synthetic history request is in flight"); replyHistory();
		await page.locator("[data-history-cue]").waitFor({ state: "detached" }); await sample(page, 30);
		const result = await finish(page, `${engine}-away-cue-removal`);
		assert.equal(result.rowDrift, 0, "A canceled history cue must not move the on-screen row");
	});
}
