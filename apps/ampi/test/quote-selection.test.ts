import "./bound.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { loadBudget, PAGE_LOAD_MS } from "./page-load.ts";
import { build } from "vite";
import react from "@vitejs/plugin-react";
// @ts-ignore: shared browser discovery is plain ESM.
import { findChrome } from "../scripts/perf/browser.mjs";
import { engineSkip } from "./engines.ts";
import { track } from "@earendil-works/chord/delta";
import type { SlashCommands } from "../src/shared/protocol.ts";
// @ts-ignore: pi-hc-control is plain ESM.
import { IMAGE_LIMITS } from "@hypercarrier/pi-hc-control/control";

// Real ThreadView, Composer, selection API and stylesheet; the hub sends synthetic snapshots.

test("Phone idle Send has a contrasting label chip without clipping in light and dark", async t => {
 const {page}=await open(t,"pi-local","chromium",true);
 await page.setViewportSize({width:375,height:700});
 await page.getByRole("textbox",{name:"Message the agent",exact:true}).fill("A phone draft");
 for(const theme of ["light","dark"]) {
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  const send=page.getByRole("button",{name:"Send ↵",exact:true});
  assert.ok(await send.isEnabled());
  const chip=await send.locator(".action-label").evaluate(el=>{
   const style=getComputedStyle(el),r=el.getBoundingClientRect();
   const channel=(v:number)=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;};
   const luminance=(color:string)=>{const c=color.match(/[\d.]+/g)!.map(Number);return .2126*channel(c[0]!)+.7152*channel(c[1]!)+.0722*channel(c[2]!);};
   const a=luminance(style.color),b=luminance(style.backgroundColor);
   const range=document.createRange();range.selectNodeContents(el);const text=range.getBoundingClientRect();
   return {height:r.height,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),fits:text.left>=r.left&&text.right<=r.right,coarse:matchMedia("(pointer:coarse)").matches};
  });
  assert.ok(chip.coarse);
  assert.ok(chip.height>=28,theme+" label height");
  assert.ok(chip.fits,theme+" label is not clipped");
  assert.ok(chip.contrast>=3,theme+" label contrast "+chip.contrast);
 }
});


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
                    React.createElement(ThreadView, { host: state.host || 'devbox', threadId: state.threadId || ${JSON.stringify(THREAD)}, summary: {...summary, ...state}, panel: undefined, setPanel() {} })));
                window.addEventListener('test-state', event => render(event.detail));
                window.addEventListener('test-unmount', () => root.render(null));
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
const view = (records: readonly unknown[] = entries) => ({conversationId:"s1",hiddenBefore:false,entries:records,live:{},inbox:{},agent:{cwd:"/work"},usage:{costUsd:0}});
let bundle: Promise<string> | undefined;
const browsers = new Map<string, Promise<Browser>>();
after(async () => { await Promise.all([...browsers.values()].map(async (browser) => (await browser).close())); });

// Composer.quote focuses the draft one frame after the quote lands, and that moves the page selection into the
// draft. Wait for that focus before the next transcript selection, or the focus clears the new selection.
const quoted = (page: Page) => page.waitForFunction(() => {
 const draft = document.querySelector<HTMLTextAreaElement>('[data-region="composer"] textarea');
 return !!draft && draft === document.activeElement && draft.selectionStart === draft.value.length;
});

async function open(t: TestContext, kind: string, engine: "chromium" | "webkit" = "chromium", touch = false) {
	const script = await (bundle ??= componentScript());
	let browser = browsers.get(engine);
	if (!browser) {
		browser = engine === "chromium" ? chromium.launch({ headless: true, executablePath: findChrome() }) : webkit.launch({ headless: true });
		browsers.set(engine, browser);
	}
	const activeBrowser = await browser;
	const page = await activeBrowser.newPage({ viewport: { width: 1000, height: 700 }, hasTouch: touch });
	t.after(() => page.context().close());
	page.setDefaultTimeout(3000);
	loadBudget(page);
	const css = readFileSync(join(web, "src/styles.css"), "utf8");
	await page.route("**/*", (route) => {
		const url = new URL(route.request().url());
		if (url.origin !== ORIGIN) return route.abort();
		if (url.pathname === "/component.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: script });
		if (url.pathname === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><div id="root"></div><script src="/component.js"></script>` });
		return route.abort();
	});
	let send: ((frame: unknown) => void) | undefined;
	let sid: number | undefined;
	let snapshot: unknown = view();
	const held: (()=>void)[] = [];
	const commands = { value: {commands:[],models:[],model:'anthropic/claude-opus-5-5',thinking:'high',thinkingLevels:['off','high']} as SlashCommands, reads:0, subscriptions:0, hold:false, release:()=>{commands.hold=false;for(const reply of held.splice(0)) reply();} };
	await page.routeWebSocket("**/ws", (client) => {
		send = (frame) => client.send(JSON.stringify(frame));
		send({ t: "hosts", hosts: [{ id: "devbox", label: "devbox", kind, status: "connected" }] });
		client.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (frame.t === "sub" && frame.topic?.kind === "thread") {
				if (frame.topic.threadId === THREAD && frame.host === "devbox") { sid = frame.sid; commands.subscriptions++; }
				send!({ t: "snap", sid: frame.sid, value: frame.topic.threadId === THREAD ? snapshot : view() });
			}
			else if (frame.t === "sub") send!({ t: "snap", sid: frame.sid, value: frame.topic?.kind === "threads" ? { threads: {} } : {} });
			else if (frame.t === "req" && frame.op === "thread.commands") {
				commands.reads++;const value=commands.value;
				const reply=()=>send!({t:'res',id:frame.id,ok:true,value});
				if(commands.hold) held.push(reply);else reply();
			}
            else if (frame.t === "req" && frame.op === "thread.command") {
                commands.value={...commands.value,thinking:frame.args.args};
                send!({t:"res",id:frame.id,ok:true,value:{disposition:"handled"}});
            }
			else if (frame.t === "req" || frame.t === "hub") send!({ t: "res", id: frame.id, ok: false, error: { code: "unsupported", message: "not in this test" } });
		});
	});
	await page.goto(`${ORIGIN}/`);
	await page.locator('[data-entry="e0"]').waitFor({ timeout: PAGE_LOAD_MS });
	return { page, commands, frame: (frame:Record<string,unknown>) => { if (!send || sid === undefined) throw new Error("no subscription"); send({...frame,sid}); }, update: (value:unknown) => { snapshot = value; if (sid === undefined || !send) throw new Error("thread snapshot is not ready"); send({ t: "snap", sid, value }); } };
}


test("Quote: select, annotate, append, cancel, and reject cross-entry selection", async (t) => {
 const {page} = await open(t,"pi-local");
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
 const {page} = await open(t,"pi-local");
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
 const {page} = await open(t,"pi-local",engine);
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
 const {page,update} = await open(t,"pi-local",engine);
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

// WebKit with the Pi Composer: after a display zoom the note can sit 34 px below its anchor until the next reposition.
// The durable Composer's taller bar hid this; the same case fails on fa3c51e3 with a pi-local Host. Open defect.
const ZOOM_TODO = "WebKit: the note lags its anchor after a display zoom with the Pi Composer (open defect)";
for (const engine of ["chromium", "webkit"] as const) test(`Quote note follows its anchor through reflow, resize, zoom and a streamed anchor, and stays visible after eviction (${engine})`, { skip: engineSkip(engine), todo: engine === "webkit" ? ZOOM_TODO : undefined }, async t => {
 const {page,update} = await open(t,"pi-local",engine);
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
 const {page} = await open(t,"pi-local");
 const draft = page.getByRole('textbox',{name:'Message the agent'});
 await draft.fill('/sto');
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
 const {page} = await open(t,"pi-local");
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

for (const engine of ["chromium", "webkit"] as const) test(`Quote draft survives tail updates, control flicker, view reload and Session switch (${engine})`, { skip: engineSkip(engine) }, async t => {
 const {page,update} = await open(t,"pi-local",engine);
 const records = [...entries.slice(0,2), ...Array.from({length:24},(_,i)=>({id:`message${i}`,kind:'assistant',blocks:[{type:'text',text:`Message ${i}. ${'Synthetic transcript text. '.repeat(16)}`}]})), ...entries.slice(3)];
 update(view(records));
 await page.locator('[data-entry="message23"]').waitFor({state:'attached'});
 await page.evaluate(()=>document.querySelector('[data-entry="e0"]')!.scrollIntoView());
 const frames = () => page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await frames();
 assert.ok(await page.locator('[data-region="transcript"]').evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop>100),'the owner reads above the tail');
 const draft = page.getByRole('textbox',{name:'Message the agent'});
 await draft.fill('Kept');
 await beginQuote(page);
 const note = page.getByRole('textbox',{name:'Quote note (optional)'});
 const kept = async (why: string) => {
  await frames();
  assert.equal(await note.inputValue(),'Uncommitted',why);
  assert.equal(await note.isVisible(),true,why);
 };
 update({...view([...records.slice(0,-1),{...entries[4]!,text:'Only tool output. Streamed tail update.'}]),live:{tools:[{callId:'call1',name:'bash',status:'running',text:'Streamed tail update.'}]}});
 await page.getByText('Only tool output. Streamed tail update.',{exact:true}).waitFor({state:'attached'});
 await kept('streamed tool update keeps note');
 update(view([...records,{id:'arrival',kind:'assistant',blocks:[{type:'text',text:'New tail message.'}]}]));
 await page.getByRole('button',{name:'↓ 1 new message',exact:true}).waitFor();
 await kept('new message keeps note');
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('test-state',{detail:{control:undefined}})));
 await kept('control flicker keeps visible note');
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('test-state',{detail:{closed:true}})));
 await kept('Close does not discard input');
 await page.evaluate(()=>window.dispatchEvent(new Event('test-unmount')));
 await note.waitFor({state:'detached'});
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('test-state',{detail:{}})));
 await kept('view reload restores quote draft');
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('test-state',{detail:{threadId:'pi:other'}})));
 await note.waitFor({state:'detached'});
 assert.equal(await draft.inputValue(),'','another Session has its own draft');
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('test-state',{detail:{threadId:'pi:s1'}})));
 await kept('return to Session restores quote draft');
 assert.equal(await draft.inputValue(),'Kept');
 update(view([{id:'only',kind:'assistant',blocks:[{type:'text',text:'The quoted entry has left the view.'}]}]));
 await page.getByText('The quoted entry has left the view.').waitFor();
 await kept('missing anchor keeps note pinned');
 assert.equal(await page.locator('.quote-selection blockquote').innerText(),'First selected paragraph.','pinned note exposes the original quote');
 await note.press('Enter');
 await quoted(page);
 assert.equal(await draft.inputValue(),'Kept\n\n> First selected paragraph.\n\nUncommitted\n\n');
 await page.evaluate(()=>window.dispatchEvent(new Event('test-unmount')));
 await draft.waitFor({state:'detached'});
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('test-state',{detail:{}})));
 await draft.waitFor();
 assert.equal(await note.count(),0,'Enter ends the pending quote');
});

test('Quote pick survives a collapsed DOM selection until the owner selects different text', async t => {
 const {page,update} = await open(t,'pi-local');
 await page.evaluate(()=>{
  const range=document.createRange();range.selectNodeContents(document.querySelector('[data-entry="e0"] .md p')!);
  const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
 });
 const pill=page.getByRole('button',{name:'Quote q'});
 await pill.waitFor();
 update(view([{...entries[0]!,blocks:[{type:'text',text:'Replaced transcript text.'}]},entries[1]!]));
 await page.getByText('Replaced transcript text.').waitFor();
 await page.evaluate(()=>{window.getSelection()!.removeAllRanges();document.dispatchEvent(new Event('selectionchange'));document.querySelector('[data-region="transcript"]')!.dispatchEvent(new Event('scroll'));});
 await pill.waitFor();
 await page.locator('[data-region="transcript"]').focus();
 await page.keyboard.press('q');
 await page.getByRole('textbox',{name:'Quote note (optional)'}).press('Enter');
 await quoted(page);
 const draft=page.getByRole('textbox',{name:'Message the agent'});
 assert.equal(await draft.inputValue(),'> First selected paragraph.\n\n');
 await page.evaluate(()=>{
  const range=document.createRange();range.selectNodeContents(document.querySelector('[data-entry="e1"] .md p')!);
  const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
 });
 await pill.click();
 await page.getByRole('textbox',{name:'Quote note (optional)'}).press('Enter');
 await quoted(page);
 assert.equal(await draft.inputValue(),'> First selected paragraph.\n\n> Second selected paragraph.\n\n','a new selection replaces the last pick');
});

for (const action of ['Cancel','Escape']) test(`Quote ${action} ends saved note custody`, async t => {
 const {page} = await open(t,'pi-local');
 await beginQuote(page);
 const note=page.getByRole('textbox',{name:'Quote note (optional)'});
 if (action==='Cancel') await page.getByRole('button',{name:'Cancel',exact:true}).click();
 else await note.press('Escape');
 await note.waitFor({state:'detached'});
 await page.evaluate(()=>window.dispatchEvent(new Event('test-unmount')));
 const draft=page.getByRole('textbox',{name:'Message the agent'});
 await draft.waitFor({state:'detached'});
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('test-state',{detail:{}})));
 await draft.waitFor();
 assert.equal(await note.count(),0,'explicit cancel ends the quote across view reload');
 assert.equal(await draft.inputValue(),'','cancel appends nothing');
});

// The same real ThreadView fixture checks Composer layout under independent transcript and summary updates.
for (const engine of ['chromium','webkit'] as const) for (const attached of [false,true]) test(`Composer controls stay put during streamed tools and textarea growth (${engine}, attachment=${attached})`, {skip:engineSkip(engine)}, async t => {
 const {page,update}=await open(t,'pi-local',engine);
 const summary={control:true,images:IMAGE_LIMITS,model:'claude-sonnet-5-5',contextTokens:12000,contextWindow:200000,activity:'tool'};
 const state=async (value:unknown)=>page.evaluate(detail=>window.dispatchEvent(new CustomEvent('test-state',{detail})),value);
 await state(summary);
 await page.setViewportSize({width:550,height:700});
 const running=(n:number)=>({...view([...entries.slice(0,-1),{...entries[4]!,text:`Tool stream ${n}`}]),live:{run:{id:'run1'},tools:[{callId:'call1',name:'bash',status:'running',text:`Tool stream ${n}`}]}});
 update(running(0));
 await page.getByRole('button',{name:'Steer ↵',exact:true}).waitFor();
 await page.getByRole('button',{name:'Composer help',exact:true}).waitFor();
 const draft=page.getByRole('textbox',{name:'Message the agent'});
 await draft.fill('Keep this draft');
 if(attached){
  await page.locator('.composer input[type="file"]').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')});
  await page.locator('.attachment').waitFor();
 }
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 if(process.env.AMPI_COMPOSER_SHOTS) await page.screenshot({path:join(process.env.AMPI_COMPOSER_SHOTS,`${engine}-${attached?'image':'empty'}.png`)});
 await page.evaluate(()=>{
  const selectors=['.composer-bar','.composer-help button','.model-hud-trigger','.composer .meter',...Array.from({length:3},(_,i)=>`.composer-actions button:nth-child(${i+1})`)];
  const nodes=selectors.map(selector=>document.querySelector(selector));
  const frames:unknown[]=[];
  const sample=()=>selectors.map((selector,i)=>{
   const el=document.querySelector(selector),rect=el?.getBoundingClientRect();
   return {selector,same:el===nodes[i],box:rect ? [rect.x,rect.y,rect.width,rect.height] : null};
  });
  let active=true;
  const record=()=>{frames.push(sample());if(active)requestAnimationFrame(record);};
  record();
  Object.assign(window,{composerTrace:{frames,stop:()=>{active=false;frames.push(sample());}}});
 });
 for(let i=1;i<=6;i++){
  update(running(i));
  await page.getByText(`Tool stream ${i}`,{exact:true}).waitFor({state:'attached'});
  // Availability is rechecked independently of streamed output. It must not select another layout.
  await state(i%2 ? {...summary,control:false,images:undefined} : summary);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.getByRole('button',{name:'＋ Image',exact:true}).count(),0,'image admission uses paste and drop without a layout control');
  if(i%2===0) { await draft.fill('Keep this draft\n'+'Typed line.\n'.repeat(i*8)); await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))); }
  assert.equal(await page.locator('.attachment').count(),attached?1:0,'tool updates do not change attachment state');
 }
 const frames=await page.evaluate(()=>{const trace=Reflect.get(window,'composerTrace');trace.stop();return trace.frames;}) as {selector:string;same:boolean;box:number[]|null}[][];
 const baseline=frames[0]!;
 const moved=frames.flatMap((frame,at)=>frame.flatMap((control,i)=>{
  const original=baseline[i]!;
  const delta=control.box && original.box ? Math.max(...control.box.map((value,j)=>Math.abs(value-original.box![j]!))) : control.box===original.box ? 0 : Infinity;
  return delta || !control.same ? [{frame:at,selector:control.selector,delta,same:control.same,before:original.box,after:control.box}] : [];
 }));
 t.diagnostic(JSON.stringify({engine,attached,frames:frames.length,maxMovement:Math.max(0,...moved.map(value=>Number.isFinite(value.delta)?value.delta:0)),missingFrames:moved.filter(value=>!value.after).length,baseline,firstMoved:moved.find(value=>value.delta>0&&Number.isFinite(value.delta))??null}));
 assert.deepEqual(moved,[],'every control keeps its DOM node and bounding box in every frame');
 assert.equal(await draft.inputValue(),'Keep this draft\n'+'Typed line.\n'.repeat(48));
 assert.equal(await page.locator('.attachment').count(),attached?1:0);
});

const settle = (page:Page) => page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const composerState = (page:Page,value:unknown) => page.evaluate(detail=>window.dispatchEvent(new CustomEvent('test-state',{detail})),value);
for(const engine of ['chromium','webkit'] as const) test(`Compact Composer cards support hover, keyboard and touch (${engine})`,{skip:engineSkip(engine)},async t=>{
 const {page}=await open(t,'pi-local',engine,true);
 await composerState(page,{model:'anthropic/claude-opus-5-5',images:IMAGE_LIMITS,contextTokens:75000,contextWindow:300000,workingBudget:240000});
 const help=page.getByRole('button',{name:'Composer help',exact:true});
 const model=page.getByRole('button',{name:'Model details',exact:true});
 const context=page.getByRole('button',{name:'Context details',exact:true});
 assert.equal(await page.getByRole('region',{name:'Composer help',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'＋ Image',exact:true}).count(),0);
 await page.waitForFunction(()=>document.querySelector('.model-hud-trigger')?.textContent==='opus-5.5 · high');
 assert.equal(await context.innerText(),'240k');
 assert.equal(await page.locator('.composer .bar > div').evaluate(el=>(el as HTMLElement).style.width),'31.25%');
 for(const mode of ['hover','focus','tap'] as const) {
  for(const [button,label,text] of [[help,'Composer help','This model accepts images'],[model,'Session HUD','anthropic/claude-opus-5-5'],[context,'Context details','75,000 tokens used · 31%']] as const) {
   await page.mouse.move(900,20);
   if(mode==='hover') await button.hover();else if(mode==='focus') await button.focus();else await button.tap();
   const card=page.getByRole('region',{name:label,exact:true});
   await card.waitFor();
   assert.ok((await card.innerText()).includes(text),`${mode} opens ${label}`);
   if(label==='Composer help') assert.equal(await card.locator('p').first().evaluate(el=>getComputedStyle(el).marginTop),'0px','help starts at its padding without a blank band');
   assert.equal(await button.getAttribute('aria-expanded'),'true');
   if(mode==='focus') {await page.keyboard.press('Escape');await card.waitFor({state:'detached'});}
   else {await page.touchscreen.tap(900,20);await card.waitFor({state:'detached'});}
  }
 }
 await help.tap();
 const chooser=page.waitForEvent('filechooser');
 await page.getByRole('button',{name:'Choose images…',exact:true}).tap();
 assert.ok(await chooser,'help opens the native image chooser');
 await page.touchscreen.tap(900,20);
 await composerState(page,{model:'openai/gpt-5',images:undefined});
 await help.tap();
 assert.match(await page.getByRole('region',{name:'Composer help',exact:true}).innerText(),/Images unavailable: this model does not accept images/);
});

for(const engine of ['chromium','webkit'] as const) test(`Composer growth keeps the transcript tail pinned (${engine})`,{skip:engineSkip(engine)},async t=>{
 const {page,update}=await open(t,'pi-local',engine);
 update(view(Array.from({length:32},(_,i)=>({id:'long'+i,kind:'assistant',blocks:[{type:'text',text:'Synthetic paragraph '+i+'\n\n'+'Transcript line. '.repeat(30)}]}))));
 await page.locator('[data-entry="long31"]').waitFor();
 const draft=page.getByRole('textbox',{name:'Message the agent'});
 const height=()=>draft.evaluate(el=>el.getBoundingClientRect().height);
 const empty=await height();
 assert.ok(empty<=48,`empty textarea height ${empty}`);
 await page.locator('.scroll').evaluate(el=>{el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll'));});
 await settle(page);
 const gaps:number[]=[];
 for(const n of [2,4,8,24,48]) {
  await draft.fill('Typed line.\n'.repeat(n));
  await settle(page);
  gaps.push(await page.locator('.scroll').evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop));
 }
 assert.ok(await height()>empty,'textarea grows');
 assert.ok(await height()<=200,'textarea keeps its existing maximum');
 assert.ok(gaps.every(gap=>Math.abs(gap)<=1),`tail gaps: ${gaps}`);
 t.diagnostic(JSON.stringify({engine,empty,grown:await height(),tailGaps:gaps}));
});

for(const engine of ['chromium','webkit'] as const) test(`Quote keys keep IME input and Escape outside the note (${engine})`,{skip:engineSkip(engine)},async t=>{
 const {page}=await open(t,'pi-local',engine);
 await beginQuote(page);
 const note=page.getByRole('textbox',{name:'Quote note (optional)'});
 for(const key of ['Enter','Escape']) for(const ime of [{isComposing:true},{keyCode:229}]) {
  const prevented=await note.evaluate((el,{key,ime})=>{
   const event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...ime});
   el.dispatchEvent(event);return event.defaultPrevented;
  },{key,ime});
  assert.equal(await note.inputValue(),'Uncommitted');
  if(key==='Enter') assert.equal(prevented,true,'IME Enter cannot submit the native form');
 }
 await page.locator('[data-entry="e0"]').evaluate(el=>{el.setAttribute('tabindex','0');(el as HTMLElement).focus();});
 await page.keyboard.press('Escape');
 assert.equal(await note.inputValue(),'Uncommitted','Escape in transcript keeps typed input');
 await page.locator('.composer textarea').focus();await page.keyboard.press('Escape');
 assert.equal(await note.inputValue(),'Uncommitted','Escape in Composer keeps typed input');
 await note.focus();await note.press('Escape');
 assert.equal(await note.count(),0,'Escape in the note cancels');
});

for(const engine of ['chromium','webkit'] as const) test(`Quote custody handles real delta batches, stale and stream restart (${engine})`,{skip:engineSkip(engine)},async t=>{
 const {page,frame,commands}=await open(t,'pi-local',engine);
 await beginQuote(page);
 const note=page.getByRole('textbox',{name:'Quote note (optional)'});
 const tracker=track(view());
 const append=tracker.beginChange();
 append.state.entries.push({id:'new-tail',kind:'assistant',blocks:[{type:'text',text:'Real delta tail.'}]});
 let batch=append.prepare();tracker.adopt(batch);
 frame({t:'ops',n:1,ops:batch.ops});
 await page.getByText('Real delta tail.',{exact:true}).waitFor();
 assert.equal(await note.inputValue(),'Uncommitted');
 const edit=tracker.beginChange();
 edit.state.entries[0]={...entries[0]!,blocks:[{type:'text',text:'First selected paragraph. Streamed anchor.'}]};
 batch=edit.prepare();tracker.adopt(batch);
 frame({t:'ops',n:2,ops:batch.ops});
 await page.getByText('First selected paragraph. Streamed anchor.',{exact:true}).waitFor();
 assert.equal(await note.inputValue(),'Uncommitted');
 frame({t:'stale'});
 await settle(page);
 assert.equal(await note.inputValue(),'Uncommitted','stale retains input');
 const subscriptions=commands.subscriptions;
 frame({t:'ops',n:4,ops:[]});
 await page.waitForFunction(()=>document.querySelector('[data-entry="e0"]')?.textContent?.includes('First selected paragraph.'));
 assert.ok(commands.subscriptions>subscriptions,'a sequence gap resubscribes for a snapshot');
 assert.equal(await note.inputValue(),'Uncommitted','restart snapshot retains input');
});

for(const engine of ['chromium','webkit'] as const) test(`Quote Enter without Composer appends once; same thread on another Host has separate custody (${engine})`,{skip:engineSkip(engine)},async t=>{
 const {page,update}=await open(t,'pi-local',engine);
 await beginQuote(page);
 const note=page.getByRole('textbox',{name:'Quote note (optional)'});
 await composerState(page,{host:'another-host'});
 await note.waitFor({state:'detached'});
 assert.equal(await page.getByRole('textbox',{name:'Message the agent'}).inputValue(),'');
 await composerState(page,{host:'devbox'});
 await note.waitFor();
 assert.equal(await note.inputValue(),'Uncommitted');
 await settle(page);
 update(undefined);
 await page.locator('.composer').waitFor({state:'detached'});
 await note.press('Enter');
 assert.equal(await note.count(),0);
 update(view());
 const draft=page.getByRole('textbox',{name:'Message the agent'});
 await draft.waitFor();
 const expected='> First selected paragraph.\n\nUncommitted\n\n';
 assert.equal(await draft.inputValue(),expected);
 await page.evaluate(()=>window.dispatchEvent(new Event('test-unmount')));
 await composerState(page,{});
 await draft.waitFor();
 assert.equal(await draft.inputValue(),expected,'remount does not append the quote twice');
});

for(const engine of ['chromium','webkit'] as const) test(`Phone pinned quote keeps quote start, note and Cancel visible (${engine})`,{skip:engineSkip(engine)},async t=>{
 const {page,update}=await open(t,'pi-local',engine,true);
 await page.setViewportSize({width:390,height:844});
 await beginQuote(page);
 const note=page.getByRole('textbox',{name:'Quote note (optional)'});
 update(view([{id:'replacement',kind:'assistant',blocks:[{type:'text',text:'Anchor removed.'}]}]));
 const quote=page.locator('.quote-selection blockquote');
 await quote.waitFor();
 for(const height of [844,500]) {
  await page.setViewportSize({width:390,height});
  await note.focus();await settle(page);
  for(const el of [quote,note,page.getByRole('button',{name:'Cancel',exact:true})]) {
   const box=(await el.boundingBox())!;
   assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=390&&box.y+box.height<=height,`control inside 390x${height}: ${JSON.stringify(box)}`);
  }
  if(process.env.AMPI_QUOTE_SHOTS) await page.screenshot({path:join(process.env.AMPI_QUOTE_SHOTS,`quote-phone-${engine}-${height}.png`)});
 }
 assert.equal(await note.inputValue(),'Uncommitted');
});

for(const engine of ['chromium','webkit'] as const) for(const phone of [false,true]) test(`Battery keeps its box across idle/busy and low/budget use (${engine}, phone=${phone})`,{skip:engineSkip(engine)},async t=>{
 const {page,update,commands}=await open(t,'pi-local',engine,phone);
 await page.setViewportSize({width:phone?390:1000,height:phone?844:700});
 const summary={model:'anthropic/claude-opus-5-5',contextTokens:6000,contextWindow:300000,images:IMAGE_LIMITS};
 await composerState(page,summary);
 await settle(page);
 const battery=page.locator('.composer .meter');
 const box=await battery.boundingBox();
 const model=page.getByRole('button',{name:'Model details'});
 const frame=()=>page.locator('.composer-bar').evaluate(el=>{
  const r=el.getBoundingClientRect();return {width:r.width,scrollWidth:el.scrollWidth};
 });
 const capture=async(name:string)=>{
  if(process.env.AMPI_COMPOSER_SHOTS) await page.screenshot({path:join(process.env.AMPI_COMPOSER_SHOTS,`${engine}-${phone?'phone':'desktop'}-${name}.png`)});
 };
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  await capture('2percent-'+theme+'-idle');
  const fill=page.locator('.composer .bar > div');
  assert.ok((await fill.boundingBox())!.width>=2,'non-zero usage remains at least 2 CSS px at 1x');
  assert.equal(await battery.innerText(),'300k');
  commands.hold=true;
  update({...view(),live:{run:{id:'run1'}}});
  await page.getByRole('button',{name:'■ Stop',exact:true}).waitFor();
  await settle(page);
  assert.deepEqual(await battery.boundingBox(),box,'run start keeps battery position and dimensions');
  if(phone) {
   assert.ok((await model.boundingBox())!.width>=90,'phone model chip keeps 90px');
   const actions=page.locator('.composer-actions');
   assert.deepEqual(await actions.locator('.action-label').allTextContents(),['Queue','Steer','Stop'],'phone actions remain readable');
   const width=(await actions.boundingBox())!.width;
   assert.ok(width>=135&&width<=140,'three phone actions use 135–140px');
   for(const button of await actions.locator('button').all()) {
    assert.ok((await button.boundingBox())!.height>=40,'each action has a 40px hit area');
    const chip=await button.locator('.action-label').evaluate(el=>({height:el.getBoundingClientRect().height,font:Number.parseFloat(getComputedStyle(el).fontSize)}));
    assert.ok(chip.height>=26&&chip.height<=28&&chip.font>=11&&chip.font<=12,'visible chip is 26–28px with 11–12px text');
   }
  }
  const bar=await frame();assert.ok(bar.scrollWidth<=bar.width+1,'toolbar fits the viewport');
  await capture('2percent-'+theme+'-busy');
  commands.release();
  for(const [used,level] of [[230000,'warn'],[240000,'err']] as const) {
   await composerState(page,{...summary,contextTokens:used,contextWindow:1000000,workingBudget:240000});
   await settle(page);
   assert.equal(await battery.innerText(),'240k');
   assert.equal(await page.locator('.composer .bar.'+level).count(),1,'working budget owns warning threshold');
   assert.deepEqual(await battery.boundingBox(),box,'budget and warning preserve the box');
   const colors=await fill.evaluate(el=>[getComputedStyle(el).backgroundColor,getComputedStyle(el.closest('.composer')!).backgroundColor]);
   const luminance=(color:string)=>color.match(/[\d.]+/g)!.slice(0,3).map(Number).map(n=>{const v=n/255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;}).reduce((sum,n,i)=>sum+n*[0.2126,0.7152,0.0722][i]!,0);
   const a=luminance(colors[0]!),b=luminance(colors[1]!);
   assert.ok((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)>=3,'warning fill has at least 3:1 contrast against the body in each theme');
   await capture('budget-'+level+'-'+theme);
  }
  await composerState(page,summary);
  update(view());
  await page.getByRole('button',{name:'Send ↵',exact:true}).waitFor();
  await settle(page);
  assert.deepEqual(await battery.boundingBox(),box,'run end keeps battery position and dimensions');
 }
});

test('Model metadata refreshes on model, run start, HUD open and UI thinking, never tool deltas',async t=>{
 const {page,commands,update}=await open(t,'pi-local');
 const model=page.getByRole('button',{name:'Model details',exact:true});
 const label=async(value:string)=>page.waitForFunction(value=>document.querySelector('.model-hud-trigger')?.textContent===value,value);
 await composerState(page,{model:'anthropic/claude-opus-5-5'});
 await label('opus-5.5 · high');
 commands.value={...commands.value,thinking:'low'};
 commands.hold=true;
 await model.focus();
 await settle(page);
 assert.equal(await model.innerText(),'opus-5.5 · high','refresh keeps the known effort');
 commands.release();
 await label('opus-5.5 · low');
 await page.keyboard.press('Escape');
 commands.value={...commands.value,thinking:'medium'};
 commands.hold=true;
 await composerState(page,{model:'anthropic/claude-sonnet-5-5'});
 await label('sonnet-5.5');
 commands.release();
 await label('sonnet-5.5 · medium');
 commands.value={...commands.value,thinking:'high'};
 update({...view(),live:{run:{id:'run1'}}});
 await label('sonnet-5.5 · high');
 const reads=commands.reads;
 for(let i=0;i<3;i++){update({...view(),live:{run:{id:'run1'},tools:[{callId:'t',name:'bash',status:'running',text:'delta '+i}]}});await settle(page);}
 assert.equal(commands.reads,reads,'tool deltas do not reload model metadata');
 commands.value={...commands.value,commands:[{name:'thinking',source:'builtin',supported:true}]};
 await page.locator('.composer textarea').focus();await model.focus();await settle(page);await page.keyboard.press('Escape');
 const draft=page.getByRole('textbox',{name:'Message the agent'});
 await draft.fill('/thinking low');
 await draft.press('Enter');
 await label('sonnet-5.5 · low');
 assert.ok(commands.reads>reads,'the UI command refreshes current metadata');
});
