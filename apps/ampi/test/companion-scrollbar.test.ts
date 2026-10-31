import "./bound.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build } from "vite";
import react from "@vitejs/plugin-react";
// @ts-ignore: shared browser discovery is plain ESM.
import { findChrome } from "../scripts/perf/browser.mjs";

// Real ThreadView, stylesheet and hash navigation; synthetic hub snapshots.
const web = fileURLToPath(new URL("../web", import.meta.url));
const THREAD = "pi:s1";

async function componentScript(): Promise<string> {
	const entry = join(web, "companion-scrollbar-test-entry.js");
	const result = await build({
		configFile: false, root: web, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
			name: "companion-scrollbar-test",
			resolveId: (id) => id === entry ? `\0${entry}` : undefined,
			load: (id) => id === `\0${entry}` ? `
				import React from 'react';
				import { createRoot } from 'react-dom/client';
				import { ThreadView } from ${JSON.stringify(join(web, "src/components/ThreadView.tsx"))};
				import { arriveEntry, installNavLinks } from ${JSON.stringify(join(web, "src/nav.ts"))};
				// Like App: a route's entry is a reveal request (nav.ts).
				installNavLinks(); arriveEntry(); window.addEventListener('hashchange', arriveEntry);
				const summary = { id: ${JSON.stringify(THREAD)}, title: 'Scroll hold', createdAt: 0, updatedAt: 0, kind: 'thread', activity: 'idle', queued: 0, costUsd: 0 };
				const root = createRoot(document.getElementById('root'));
                const render = () => root.render(React.createElement('div', { className: 'main-slot', style: { height: '600px' } },
					React.createElement(ThreadView, { host: 'devbox', threadId: ${JSON.stringify(THREAD)}, summary, models: [], entry: new URLSearchParams(location.hash.split("?")[1] || "").get("e") || undefined, panel: undefined, setPanel() {} })));
                window.addEventListener('hashchange', render);render();
			` : undefined,
		}],
		build: { write: false, minify: false, lib: { entry, formats: ["iife"], name: "CompanionTest" } },
	});
	const output = (Array.isArray(result) ? result[0]! : result) as { output: { type: string; code?: string }[] };
	return output.output.find((item) => item.type === "chunk")!.code!;
}


const entries = (n:number) => Array.from({length:n},(_,i)=>i%2===0
 ? {id:'e'+i,kind:'user',text:'Question '+i+'\nMore detail',images:0}
 : {id:'e'+i,kind:'assistant',blocks:[{type:'text',text:'Answer '+i+' '+('details '.repeat(30))}]});
const view = (n:number) => ({conversationId:'s1',sourceVersion:'v'+n,hiddenBefore:true,entries:entries(n).slice(-200),live:{},inbox:{},agent:{cwd:'/work'},usage:{costUsd:0}});
const outline = (n:number) => ({version:'v'+n,totalEntries:n,truncated:false,users:entries(n).flatMap((e,i)=>e.kind==='user'?[{id:e.id,ordinal:i,firstLine:'Question '+i}]:[])});
let bundle:Promise<string>|undefined;
let chrome:ReturnType<typeof chromium.launch>|undefined;
after(async()=>{await(await chrome)?.close();});

for(const kind of ['pi-local','local']) test('companion '+kind+': whole-branch jump, idle cache, place hold and stale-reply fence',async t=>{
 const script=await(bundle??=componentScript());
 const browser=await(chrome??=chromium.launch({headless:true,executablePath:findChrome()}));
 const page=await browser.newPage({viewport:{width:1000,height:700}});t.after(()=>page.context().close());page.setDefaultTimeout(3000);
 await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<style>'+readFileSync(join(web,'src/styles.css'),'utf8')+'</style><div id="root"></div><script>'+script+'</script>'}));
 let publish!:(n:number)=>void, late!:()=>void;
 let requests=0, count=400;
 await page.routeWebSocket('**/ws',client=>{
  const send=(frame:unknown)=>client.send(JSON.stringify(frame));let sid:number;
  publish=n=>{count=n;send({t:'snap',sid,value:view(n)});};
  send({t:'hosts',hosts:[{id:'devbox',link:'devbox',label:'Demo',kind,status:'connected'}]});
  client.onMessage(message=>{
   const f=JSON.parse(String(message));
   if(f.t==='sub' && f.topic.kind==='thread'){sid=f.sid;send({t:'snap',sid,value:view(count)});}
   else if(f.t==='sub')send({t:'snap',sid:f.sid,value:f.topic.kind==='threads'?{threads:{}}:{}});
   else if(f.t==='req' && f.op==='thread.outline'){
    requests++;const value=outline(count);const reply=()=>send({t:'res',id:f.id,ok:true,value});
    if(count===402)late=reply;else reply();
   }else if(f.t==='req' && f.op==='thread.history')send({t:'res',id:f.id,ok:true,value:{entries:entries(40),more:false,version:'v'+count}});
   else if(f.t==='req'||f.t==='hub')send({t:'res',id:f.id,ok:false,error:{code:'unsupported',message:'fixture'}});
  });
 });
 await page.goto('http://localhost/');
 const marks=page.locator('[data-user-mark]');
 await page.locator('[data-outline-version="v400"]').waitFor();
 assert.equal(await marks.count(),200);
 assert.equal(await page.locator('[data-entry="e0"]').count(),0);
 // The rail stacks one dash per prompt in prompt order, with no track; prompts beyond its room are sampled, not piled.
 const rail=await page.locator('.companion-scrollbar').evaluate(el=>{
  const shown=[...el.querySelectorAll<HTMLElement>('[data-user-mark]')].filter(a=>a.getBoundingClientRect().height>0);
  const tops=shown.map(a=>a.getBoundingClientRect().top);
  return {bg:getComputedStyle(el).backgroundColor,shown:shown.length,room:Math.floor(el.clientHeight/6),ordered:tops.every((t,i)=>!i||t>tops[i-1]!),pitch:tops.length>1?Math.min(...tops.slice(1).map((t,i)=>t-tops[i]!)):6};
 });
 assert.equal(rail.bg,'rgba(0, 0, 0, 0)','the rail draws no track');
 assert.ok(rail.shown>0 && rail.shown<=rail.room+2,JSON.stringify(rail));
 assert.ok(rail.ordered && rail.pitch>=5.9,JSON.stringify(rail));
 assert.equal(await page.locator('[data-user-mark="e0"]').getAttribute('title'),'Question 0');
 await page.locator('[data-user-mark="e0"]').click();
 await page.waitForFunction(()=>document.querySelector('[data-entry="e0"]')?.classList.contains('flash'));
 assert.ok((await page.evaluate(()=>location.hash)).includes('e=e0'));
 const offset=()=>page.locator('[data-entry="e0"]').evaluate(el=>el.getBoundingClientRect().top);
 const before=await offset();
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(requests,1,'paint growth and idle do not refetch');
 publish(402);
 // The old outline stays in place, marked busy, until a current one replaces it.
 await page.waitForFunction(()=>document.querySelector('.companion-scrollbar')?.getAttribute('aria-busy')==='true');
 assert.equal(await page.locator('[data-outline-version="v400"]').count(),1);
 assert.equal(await marks.count(),200);
 // The second version answers first; a late old response must never replace it.
 publish(404);
 await page.locator('[data-outline-version="v404"]').waitFor();
 late();
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(await page.locator('[data-outline-version="v404"]').count(),1);
 assert.equal(await marks.count(),202);assert.equal(requests,3);
 assert.ok(Math.abs(await offset()-before)<=2,'outline refresh preserves the reader place');
});
