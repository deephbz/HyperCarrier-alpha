import "./bound.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build } from "vite";
import react from "@vitejs/plugin-react";
// @ts-ignore: browser discovery is shared ESM.
import { findChrome } from "../scripts/perf/browser.mjs";

// Real Host sections and keyboard handler; no Host connection or owner data.
test("sidebar fold: only team/count fold, titles navigate, keys and Worker contrast hold on both backends", async () => {
 const web = fileURLToPath(new URL("../web", import.meta.url));
 const entry = join(web, "sidebar-fold-test.js");
 const result = await build({ configFile: false, root: web, logLevel: "silent", define: { "process.env.NODE_ENV": '"production"' }, plugins: [react(), {
  name: "sidebar-fold-test", resolveId: id => id === entry ? `\0${entry}` : undefined,
  load: id => id === `\0${entry}` ? `
   import React from 'react'; import {createRoot} from 'react-dom/client';
   import {PiHostSection} from ${JSON.stringify(join(web, "src/components/PiSidebar.tsx"))};
   import {handleSidebarKeyDown} from ${JSON.stringify(join(web, "src/components/sidebar-keys.ts"))};
   const kind = new URLSearchParams(location.search).get('kind');
   const host = {id:'demo',link:'demo',kind,status:'disconnected',label:'Demo'};
   const base = {cwd:'/work',createdAt:Date.now(),updatedAt:Date.now(),kind:'thread',activity:'idle',queued:0,costUsd:0};
   const threads = [{...base,id:'lead',title:'Lead',attention:[{source:'test',reason:'Needs input'}],team:{role:'lead',teamId:'team1'}}, {...base,id:'worker',title:'Worker session',team:{role:'worker',teamId:'team1',worker:'Builder'}}];
   createRoot(document.getElementById('root')).render(React.createElement('aside',{className:'side',onKeyDown:e=>handleSidebarKeyDown(e.nativeEvent,e.currentTarget)},React.createElement(PiHostSection,{data:{host,threads,stale:false},hosts:[host],route:{},filter:'',showArchived:false})));
  ` : undefined,
 }], build: { write:false,minify:false,lib:{entry,formats:["iife"],name:"SidebarFoldTest"} } });
 const output = (Array.isArray(result) ? result[0]! : result) as {output:{type:string;code?:string}[]};
 const script = output.output.find(x=>x.type === "chunk")!.code!;
 const browser = await chromium.launch({headless:true,executablePath:findChrome()});
 try {
  for (const kind of ["pi-local", "local"]) {
   const page = await browser.newPage();
   page.setDefaultTimeout(2000);
   await page.route("**/*", route => route.fulfill({contentType:"text/html",body:`<style>${readFileSync(join(web,"src/styles.css"),"utf8")}</style><div id="root"></div><script>${script}</script>`}));
   await page.routeWebSocket("**/ws", () => {});
   await page.goto(`http://localhost/?kind=${kind}`);
   await page.locator('[data-sidebar-toggle="unplaced"]').click();
   const lead = page.locator('.row[data-thread="lead"]');
   const title = lead.locator('a.title');
   const workers = page.locator('.row[data-thread="worker"]');
   const folded = async () => { assert.equal(await workers.count(),0); };
   await title.click(); await folded();
   assert.ok((await page.evaluate(()=>location.hash)).includes('lead'));
   await lead.locator('.sub').click(); await folded();
   assert.equal(await lead.locator('.team-fold .twisty').count(),1);
   await lead.locator('.team-fold .twisty').click(); await workers.waitFor();
   await lead.locator('.team-fold .twisty').click(); await folded();
   await lead.click({position:{x:2,y:2}}); await folded();
   await lead.locator('[data-worker-count]').click();
   await workers.waitFor();
   const toggle = lead.locator('[data-collapse-toggle]');
   assert.match(await toggle.innerText(),/team/);
   await toggle.click(); await folded();
   await toggle.click(); await workers.waitFor();
   await title.focus(); await page.keyboard.press('h'); await folded();
   await page.keyboard.press('l'); await workers.waitFor();
   await page.keyboard.press('l');
   assert.equal(await page.locator(':focus').innerText(),'Builder');
   await page.keyboard.press('h');
   assert.equal(await page.locator(':focus').innerText(),'Lead');
   await page.keyboard.press('Enter'); await workers.waitFor();
   for (const theme of ['light','dark']) {
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    const colors = await workers.locator('.title').evaluate(el=>({color:getComputedStyle(el).color,token:getComputedStyle(el).getPropertyValue('--text-2').trim(),weight:getComputedStyle(el).fontWeight,bold:!!el.querySelector('b')}));
    assert.equal(colors.bold,false); assert.equal(colors.weight,'400');
    const backgrounds = await workers.evaluate(el => ['--bg-side','--bg-soft','--accent-soft'].map(key => getComputedStyle(el).getPropertyValue(key).trim()));
    const luminance = (rgb: number[]) => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum,v,i) => sum + v * [.2126,.7152,.0722][i]!,0);
    const ink = luminance(colors.color.match(/\d+/g)!.map(Number));
    for (const bg of backgrounds) {
     const paper = luminance(bg.slice(1).match(/../g)!.map(v => parseInt(v,16)));
     assert.ok((Math.max(ink,paper)+.05)/(Math.min(ink,paper)+.05) >= 4.5, theme + ' Worker contrast');
    }
    assert.equal(colors.color,await workers.evaluate((el,token)=>{ const probe=document.createElement('span');probe.style.color=token;el.append(probe);const color=getComputedStyle(probe).color;probe.remove();return color;},colors.token));
   }
   await page.close();
  }
 } finally { await browser.close(); }
});
