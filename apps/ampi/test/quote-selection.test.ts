import "./bound.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { build } from "vite";
import react from "@vitejs/plugin-react";
// @ts-ignore: shared browser discovery is plain ESM.
import { findChrome } from "../scripts/perf/browser.mjs";
import { engineSkip } from "./engines.ts";

// Real ThreadView, Composer, selection API and stylesheet; the hub sends synthetic snapshots.

const web = fileURLToPath(new URL("../web", import.meta.url));
const ORIGIN = "http://localhost";
const THREAD = "pi:s1";

async function componentScript(): Promise<string> {
	const entry = join(web, "quote-selection-test-entry.js");
	const result = await build({
		configFile: false, root: web, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
			name: "quote-selection-test",
			resolveId: (id) => id === entry ? `\0${entry}` : undefined,
			load: (id) => id === `\0${entry}` ? `
				import React from 'react';
				import { createRoot } from 'react-dom/client';
				import { ThreadView } from ${JSON.stringify(join(web, "src/components/ThreadView.tsx"))};
				const summary = { control: true, id: ${JSON.stringify(THREAD)}, title: 'Quote test', createdAt: 0, updatedAt: 0, kind: 'thread', activity: 'idle', queued: 0, costUsd: 0 };
				const root = createRoot(document.getElementById('root'));
                const render = (state = {}) => root.render(React.createElement('div', { className: 'main-slot', style: { height: '600px' } },
                    React.createElement(ThreadView, { host: 'devbox', threadId: state.threadId || ${JSON.stringify(THREAD)}, summary: {...summary, ...state}, models: [], panel: undefined, setPanel() {} })));
                window.addEventListener('test-state', event => render(event.detail));
                render();
			` : undefined,
		}],
		build: { write: false, minify: false, lib: { entry, formats: ["iife"], name: "QuoteSelectionTest" } },
	});
	const output = (Array.isArray(result) ? result[0]! : result) as { output: { type: string; code?: string }[] };
	return output.output.find((item) => item.type === "chunk")!.code!;
}


const entries = [
 {id:"e0",kind:"assistant",blocks:[{type:"text",text:"First selected paragraph."}]},
 {id:"e1",kind:"assistant",blocks:[{type:"text",text:"Second selected paragraph."}]},
 {id:"user",kind:"user",text:"Only the body.",ts:1700000000000,images:0},
 {id:"tool",kind:"assistant",blocks:[{type:"tool",callId:"call1",name:"bash",args:{summary:"echo output",command:"echo output"}}]},
 {id:"result",kind:"tool-result",callId:"call1",name:"bash",text:"Only tool output.",isError:true}
];
const view = (records = entries) => ({conversationId:"s1",hiddenBefore:false,entries:records,live:{},inbox:{},agent:{cwd:"/work"},usage:{costUsd:0}});
let bundle: Promise<string> | undefined;
const browsers = new Map<string, Promise<Browser>>();
after(async () => { await Promise.all([...browsers.values()].map(async (browser) => (await browser).close())); });

// Composer.quote focuses the draft one frame after the quote lands, and that moves the page selection into the
// draft. Wait for that focus before the next transcript selection, or the focus clears the new selection.
const quoted = (page: Page) => page.waitForFunction(() => {
 const draft = document.querySelector<HTMLTextAreaElement>('[data-region="composer"] textarea');
 return !!draft && draft === document.activeElement && draft.selectionStart === draft.value.length;
});

async function open(t: TestContext, kind: string, engine: "chromium" | "webkit" = "chromium"): Promise<{ page: Page; update: (value: unknown) => void }> {
	const script = await (bundle ??= componentScript());
	let browser = browsers.get(engine);
	if (!browser) {
		browser = engine === "chromium" ? chromium.launch({ headless: true, executablePath: findChrome() }) : webkit.launch({ headless: true });
		browsers.set(engine, browser);
	}
	const activeBrowser = await browser;
	const page = await activeBrowser.newPage({ viewport: { width: 1000, height: 700 } });
	t.after(() => page.context().close());
	page.setDefaultTimeout(3000);
	const css = readFileSync(join(web, "src/styles.css"), "utf8");
	await page.route("**/*", (route) => {
		const url = new URL(route.request().url());
		if (url.origin !== ORIGIN) return route.abort();
		if (url.pathname === "/component.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: script });
		if (url.pathname === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<meta charset="utf-8"><style>${css}</style><div id="root"></div><script src="/component.js"></script>` });
		return route.abort();
	});
	let send: ((frame: unknown) => void) | undefined;
	let sid: number | undefined;
	await page.routeWebSocket("**/ws", (client) => {
		send = (frame) => client.send(JSON.stringify(frame));
		send({ t: "hosts", hosts: [{ id: "devbox", label: "devbox", kind, status: "connected" }] });
		client.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (frame.t === "sub" && frame.topic?.kind === "thread") { sid = frame.sid; send!({ t: "snap", sid, value: view() }); }
			else if (frame.t === "sub") send!({ t: "snap", sid: frame.sid, value: frame.topic?.kind === "threads" ? { threads: {} } : {} });
			else if (frame.t === "req" || frame.t === "hub") send!({ t: "res", id: frame.id, ok: false, error: { code: "unsupported", message: "not in this test" } });
		});
	});
	await page.goto(`${ORIGIN}/`);
	await page.locator('[data-entry="e0"]').waitFor();
	return { page, update: (value) => { if (sid === undefined || !send) throw new Error("thread snapshot is not ready"); send({ t: "snap", sid, value }); } };
}


for (const kind of ["pi-local", "local"]) test(`Quote (${kind}): select, annotate, append, cancel, and reject cross-entry selection`, async (t) => {
 const {page} = await open(t,kind);
 const select = async (cross=false) => page.evaluate(cross=>{
  const start=document.querySelector('[data-entry="e0"] .md p')!;
  const end=cross ? document.querySelector('[data-entry="e1"] .md p')! : start;
  const range=document.createRange();range.setStart(start.firstChild!,0);range.setEnd(end.firstChild!,end.textContent!.length);
  document.querySelector<HTMLElement>('[data-region="transcript"]')!.focus();
  const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
 },cross);
 const draft=page.locator('[data-region="composer"] textarea');
 await select();
 await page.getByRole('button',{name:'Quote q'}).click();
 await page.getByRole('textbox',{name:'Quote note (optional)'}).fill('My note');
 await page.keyboard.press('Enter');
 await page.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>('[data-region="composer"] textarea')?.value.includes('My note'));
 assert.equal(await draft.inputValue(),'> First selected paragraph.\n\nMy note\n\n');
 await quoted(page);
 await select();await page.keyboard.press('q');
 await page.getByRole('textbox',{name:'Quote note (optional)'}).waitFor();
 await page.keyboard.press('Escape');
 assert.equal(await draft.inputValue(),'> First selected paragraph.\n\nMy note\n\n');
 await select();await page.keyboard.press('q');
 await page.getByRole('textbox',{name:'Quote note (optional)'}).waitFor();
 await page.keyboard.press('Enter');
 await page.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>('[data-region="composer"] textarea')?.value.endsWith('> First selected paragraph.\n\n'));
 assert.equal(await draft.inputValue(),'> First selected paragraph.\n\nMy note\n\n> First selected paragraph.\n\n');
 await quoted(page);
 await select(true);
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(await page.getByRole('button',{name:'Quote q'}).count(),0);
 await draft.focus();await page.keyboard.press('q');
 assert.ok((await draft.inputValue()).endsWith('q'));
});

test("Quote follows a visible selection while scrolling and hides out of view", async t => {
 const {page} = await open(t,"local");
 await page.evaluate(() => {
  const root=document.querySelector<HTMLElement>('[data-region="transcript"]')!;
  root.style.height='180px';root.style.flex='none';
  const entry=document.querySelector<HTMLElement>('[data-entry="e0"]')!;
  entry.style.marginTop='80px';
  const filler=document.createElement('div');filler.style.height='1000px';root.append(filler);root.scrollTop=0;
   });
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await page.evaluate(()=>{document.querySelector<HTMLElement>('[data-region="transcript"]')!.scrollTop=0;});
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await page.evaluate(()=>{
  const range=document.createRange();range.selectNodeContents(document.querySelector('[data-entry="e0"] .md p')!);
  const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
 });
 const pill=page.getByRole('button',{name:'Quote q'});
 await pill.waitFor();const before=await pill.boundingBox();
 await page.evaluate(()=>{document.querySelector<HTMLElement>('[data-region="transcript"]')!.scrollTop=30;});
 await page.waitForFunction(()=>{const pill=document.querySelector('.quote-selection');return !!pill && pill.getBoundingClientRect().top>0;});
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(await pill.count(),1);
 assert.ok(Math.abs((await pill.boundingBox())!.y-before!.y+30)<2);
 await page.evaluate(()=>{document.querySelector<HTMLElement>('[data-region="transcript"]')!.scrollTop=500;});
 await pill.waitFor({state:'detached'});
});

test("Quote is unavailable for Pi pane fallback without a control socket", async t => {
 const {page} = await open(t,"pi-local");
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('test-state',{detail:{control:undefined}})));
 await page.evaluate(()=>{
  const range=document.createRange();range.selectNodeContents(document.querySelector('[data-entry="e0"] .md p')!);
  const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
 });
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(await page.getByRole('button',{name:'Quote q'}).count(),0);
});

async function beginQuote(page: Page) {
 await page.evaluate(() => {
  const range = document.createRange();range.selectNodeContents(document.querySelector('[data-entry="e0"] .md p')!);
  const selection = window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
 });
 await page.getByRole('button',{name:'Quote q'}).click();
 await page.getByRole('textbox',{name:'Quote note (optional)'}).fill('Uncommitted');
}

for (const engine of ["chromium", "webkit"] as const) test(`Quote note survives transcript replacement and scroll correction (${engine})`, { skip: engineSkip(engine) }, async t => {
 const {page} = await open(t,"local",engine);
 await beginQuote(page);
 await page.evaluate(() => {
  const root=document.querySelector<HTMLElement>('[data-region="transcript"]')!;
  const replacement=document.createElement('div');replacement.className='msg assistant';replacement.dataset.entry='e0';replacement.innerHTML='<div data-quote-body>Updated streamed reply.</div>';
  document.querySelector('[data-entry="e0"]')!.replaceWith(replacement);
  const arrival=document.createElement('div');arrival.className='msg assistant';arrival.dataset.entry='e2';arrival.innerHTML='<div data-quote-body>New message.</div>';
  root.append(arrival);
  root.dispatchEvent(new Event('scroll'));
 });
 const note=page.getByRole('textbox',{name:'Quote note (optional)'});
 assert.equal(await note.inputValue(),'Uncommitted');
 assert.equal(await note.count(),1);
});

for (const engine of ["chromium", "webkit"] as const) test(`Quote note submits original quote after React replaces and evicts its anchor (${engine})`, { skip: engineSkip(engine) }, async t => {
 const {page,update} = await open(t,"local",engine);
 await beginQuote(page);
 const note=page.getByRole('textbox',{name:'Quote note (optional)'});
 update(view([
  {id:"e0",kind:"assistant",blocks:[{type:"text",text:"Streamed replacement text."}]},
  entries[1]!,
 ]));
 await page.getByText('Streamed replacement text.').waitFor();
 update(view([
  entries[1]!,
  {id:"e2",kind:"assistant",blocks:[{type:"text",text:"A new transcript message."}]},
 ]));
 await page.getByText('A new transcript message.').waitFor();
 await page.evaluate(()=>document.dispatchEvent(new Event('selectionchange')));
 await page.locator('[data-region="transcript"]').click({position:{x:20,y:20}});
 await note.focus();
 await note.press('Enter');
 const draft=page.getByRole('textbox',{name:'Message the agent'});
 await page.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>('[data-region="composer"] textarea')?.value.includes('Uncommitted'));
 assert.equal(await draft.inputValue(),'> First selected paragraph.\n\nUncommitted\n\n');
 assert.equal((await draft.inputValue()).split('> First selected paragraph.').length-1,1);
});

for (const engine of ["chromium", "webkit"] as const) test(`Quote note follows its anchor through reflow, resize, zoom and a streamed anchor, and stays visible after eviction (${engine})`, { skip: engineSkip(engine) }, async t => {
 const {page,update} = await open(t,"local",engine);
 const words = (n: number) => Array.from({length:n},(_,i)=>`word${i}`).join(' ');
 const anchor = {id:"e1",kind:"assistant",blocks:[{type:"text",text:`${words(40)} anchor end.`}]};
 update(view([entries[0]!, anchor]));
 await page.getByText('anchor end.',{exact:false}).waitFor();
 await page.evaluate(() => {
  const range=document.createRange();range.selectNodeContents(document.querySelector('[data-entry="e1"] .md p')!);
  const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
 });
 await page.getByRole('button',{name:'Quote q'}).click();
 const note=page.getByRole('textbox',{name:'Quote note (optional)'});
 await note.fill('Typed note');
 const frames = () => page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 // The anchor is the end of the selected words "anchor end.", wherever the transcript renders them now.
 const state = () => page.evaluate(() => {
  const p=document.querySelector('[data-entry="e1"] .md p');
  const text=p && [...p.childNodes].find((node): node is Text => node instanceof Text && node.data.includes('anchor end.'));
  let end: DOMRect | undefined;
  if (text) {const range=document.createRange();const at=text.data.indexOf('anchor end.');range.setStart(text,at);range.setEnd(text,at+'anchor end.'.length);end=[...range.getClientRects()].at(-1);}
  const pill=document.querySelector<HTMLElement>('.quote-selection')!, input=pill.querySelector('input')!;
  return {end:end?.toJSON() as DOMRect | undefined, pill:pill.getBoundingClientRect().toJSON() as DOMRect, transcript:document.querySelector('[data-region="transcript"]')!.getBoundingClientRect().toJSON() as DOMRect,
   scale:Number(document.documentElement.style.zoom||1), width:window.innerWidth, height:window.innerHeight, value:input.value, focused:document.activeElement===input};
 });
 const follows = async (label: string) => {
  await frames();
  const got = await state();
  assert.ok(got.end, `${label}: the anchor renders`);
  assert.ok(got.end!.bottom < got.transcript.bottom - 60*got.scale, `${label}: the anchor sits clear of the transcript bottom`);
  // The pill starts at the anchor's right, or ends there when the viewport has no room; it stays inside the viewport.
  assert.ok(Math.min(Math.abs(got.pill.left-got.end!.right),Math.abs(got.pill.right-got.end!.right))<2 && got.pill.left>=0 && got.pill.right<=got.width, `${label}: pill ${got.pill.left}-${got.pill.right} at anchor right ${got.end!.right}, viewport ${got.width}`);
  assert.ok(Math.abs(got.pill.top-(got.end!.bottom+4*got.scale))<2, `${label}: pill top ${got.pill.top} 4 px below anchor bottom ${got.end!.bottom}`);
  assert.equal(got.value,'Typed note',`${label}: draft kept`);
  assert.equal(got.focused,true,`${label}: focus kept`);
 };
 await follows('opened');
 update(view([{id:"e0",kind:"assistant",blocks:[{type:"text",text:`${words(60)} grew.`}]}, anchor]));
 await page.getByText('grew.',{exact:false}).waitFor();
 await follows('reflow above the anchor');
 await page.setViewportSize({width:760,height:700});
 await follows('resize');
 await page.evaluate(()=>{document.documentElement.style.zoom='1.3';window.dispatchEvent(new Event('ampi:display'));});
 await follows('zoom 1.3');
 update(view([{id:"e0",kind:"assistant",blocks:[{type:"text",text:`${words(60)} grew.`}]}, {...anchor,blocks:[{type:"text",text:`${words(40)} anchor end. More streamed words.`}]}]));
 await page.getByText('More streamed words.',{exact:false}).waitFor();
 await follows('streamed anchor');
 await page.setViewportSize({width:900,height:700});
 await follows('resize after the anchor re-rendered');
 await page.evaluate(()=>{document.documentElement.style.zoom='1';window.dispatchEvent(new Event('ampi:display'));});
 await follows('zoom 1 after the anchor re-rendered');
 // Evicted: the box keeps a visible place inside the transcript and the window, with its draft and focus.
 update(view([{id:"e2",kind:"assistant",blocks:[{type:"text",text:"A new transcript message."}]}]));
 await page.getByText('A new transcript message.').waitFor();
 await page.setViewportSize({width:640,height:420});
 await page.evaluate(()=>{document.documentElement.style.zoom='1.3';window.dispatchEvent(new Event('ampi:display'));});
 await frames();
 const gone = await state();
 assert.equal(gone.end,undefined);
 assert.ok(gone.pill.left>=gone.transcript.left-1 && gone.pill.top>=gone.transcript.top-1 && gone.pill.bottom<=Math.min(gone.transcript.bottom,gone.height)+1 && gone.pill.left<gone.width, `evicted: pill ${JSON.stringify(gone.pill)} inside transcript ${JSON.stringify(gone.transcript)}`);
 assert.equal(gone.value,'Typed note');
 assert.equal(gone.focused,true);
 await note.press('Enter');
 const draft=page.getByRole('textbox',{name:'Message the agent'});
 await page.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>('[data-region="composer"] textarea')?.value.includes('Typed note'));
 assert.equal(await draft.inputValue(),`> ${words(40)} anchor end.\n\nTyped note\n\n`);
});

test("Quote Escape leaves Composer Escape ownership intact", async t => {
 const {page} = await open(t,"local");
 const draft = page.getByRole('textbox',{name:'Message the agent'});
 await draft.fill('/ren');
 await beginQuote(page);
 await draft.focus();
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('.slash-menu').count(),0);
 assert.equal(await page.getByRole('textbox',{name:'Quote note (optional)'}).count(),1);
 assert.equal(await draft.inputValue(),'');
});

// A triple-click selects a paragraph and its break, so the range ends at offset 0 of the next entry; that entry adds no
// text, and the selection still quotes the one entry.
for (const engine of ["chromium", "webkit"] as const) test(`Quote offers a triple-clicked paragraph (${engine})`, { skip: engineSkip(engine) }, async t => {
 const {page} = await open(t,"pi-local",engine);
 await page.locator('[data-entry="e0"] .md p').click({clickCount:3});
 const ends = await page.evaluate(() => { const r = window.getSelection()!.getRangeAt(0); const e = (n: Node) => (n instanceof Element ? n : n.parentElement)!.closest('[data-entry]')?.getAttribute('data-entry'); return [e(r.startContainer), e(r.endContainer)]; });
 await page.getByRole('button',{name:'Quote q'}).click();
 await page.getByRole('textbox',{name:'Quote note (optional)'}).press('Enter');
 assert.equal(await page.locator('[data-region="composer"] textarea').inputValue(),'> First selected paragraph.\n\n', `selection ends ${ends.join(" → ")}`);
});

test("Quote includes body text but excludes selected entry chrome", async t => {
 const {page} = await open(t,"local");
 await page.evaluate(() => {
  const range = document.createRange();range.selectNodeContents(document.querySelector('[data-entry="user"]')!);
  const selection = window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
 });
 await page.getByRole('button',{name:'Quote q'}).click();
 await page.getByRole('textbox',{name:'Quote note (optional)'}).press('Enter');
 assert.equal(await page.getByRole('textbox',{name:'Message the agent'}).inputValue(),'> Only the body.\n\n');
 await quoted(page);
 await page.evaluate(() => {
  document.querySelector('[data-entry="tool"]')!.scrollIntoView();
  const range=document.createRange();range.selectNodeContents(document.querySelector('[data-entry="tool"]')!);
  const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
 });
 await page.getByRole('button',{name:'Quote q'}).click();
 await page.getByRole('textbox',{name:'Quote note (optional)'}).press('Enter');
 assert.equal(await page.getByRole('textbox',{name:'Message the agent'}).inputValue(),'> Only the body.\n\n> Only tool output.\n\n');
});

test("Quote drops an open note on Close and navigation without changing drafts", async t => {
 const {page} = await open(t,"local");
 const draft = page.getByRole('textbox',{name:'Message the agent'});
 await draft.fill('Kept');
 await beginQuote(page);
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('test-state',{detail:{closed:true}})));
 await page.getByRole('textbox',{name:'Quote note (optional)'}).waitFor({state:'detached'});
 assert.equal(await draft.inputValue(),'Kept');
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('test-state',{detail:{closed:false}})));
 await beginQuote(page);
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('test-state',{detail:{threadId:'pi:other'}})));
 await page.getByRole('textbox',{name:'Quote note (optional)'}).waitFor({state:'detached'});
 assert.equal(await draft.inputValue(),'');
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('test-state',{detail:{threadId:'pi:s1'}})));
 await page.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>('[data-region="composer"] textarea')?.value==='Kept');
});
