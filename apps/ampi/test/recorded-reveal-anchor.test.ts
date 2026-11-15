import './bound.ts';
import { engineSkip } from './engines.ts';
import { ENGINES, open as openThread, settled, frames, anchor, view, entries } from './thread-scroll-fixture.ts';
import assert from 'node:assert/strict';
import {after,test,type TestContext} from 'node:test';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium,webkit,type Browser} from 'playwright';
// @ts-ignore: shared browser discovery is plain ESM.
import {findChrome} from '../scripts/perf/browser.mjs';
const web=fileURLToPath(new URL('../web',import.meta.url));
const entry=join(web,'systems-anchor.js');
const browsers:Browser[]=[];
after(async()=>{for(const b of browsers)await b.close()});
const built=await build({configFile:false,root:web,logLevel:'silent',define:{'process.env.NODE_ENV':JSON.stringify('production')},plugins:[react(),{name:'systems-anchor',resolveId:(id)=>id===entry?'\0'+entry:undefined,load:(id)=>id==='\0'+entry?`
import React,{useRef,useLayoutEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {useKeepPlace} from ${JSON.stringify(join(web,'src/keep-place.ts'))};
function App(){const ref=useRef(null),pinned=useRef(false);const keep=useKeepPlace(ref,'[data-row]','data-row',pinned,2,()=>window.tail!==false,window.policy);useLayoutEffect(()=>{window.keep=keep;});return React.createElement('div',{ref,onScroll:keep.onScroll,id:'scroll',style:{height:300,width:500,overflow:'auto'}},React.createElement('div',null,...Array.from({length:15},(_,i)=>React.createElement('div',{'data-row':'r'+i,style:{height:100}},'row '+i))))}createRoot(document.getElementById('root')).render(React.createElement(App));
`:undefined}],build:{write:false,minify:false,lib:{entry,formats:['iife'],name:'AnchorProbe'}}});
const output=(Array.isArray(built)?built[0]:built) as {output:{type:string;code?:string}[]};
const code=output.output.find(o=>o.type==='chunk')!.code!;
for(const engine of ['chromium','webkit'] as const){
 let browser:Browser;
 const open=async(t:TestContext,policy:string)=>{
  browser??=await (engine==='chromium'?chromium.launch({headless:true,executablePath:findChrome()}):webkit.launch({headless:true}));if(!browsers.includes(browser))browsers.push(browser);
  const page=await browser.newPage();t.after(()=>page.close());
  await page.route('**/*',(route)=>route.fulfill({contentType:'text/html',body:`<div id="root"></div><script>window.policy=${JSON.stringify(policy)};window.errors=[];addEventListener('error',e=>window.errors.push(e.message));</script><script>${code}</script>`}));
  await page.goto('http://localhost/');await page.locator('[data-row=r14]').waitFor();
  await page.evaluate(()=>{const el=document.querySelector('#scroll')!;el.scrollTop=250;el.dispatchEvent(new Event('scroll'));});
  const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await settle();
  const top=(id:string)=>page.locator(`[data-row=${id}]`).evaluate(el=>el.getBoundingClientRect().top);
  const grow=async(id:string,height:number)=>{await page.locator(`[data-row=${id}]`).evaluate((el:HTMLElement,h:number)=>{el.style.height=h+'px';},height);await settle();};
  return{page,settle,top,grow};
 };
 for(const policy of ['first-visible','reading-line'])test(`anchor policy ${engine}: ${policy} anchor and reader input reset`,{skip:engineSkip(engine)},async t=>{
  const {page,settle,top,grow}=await open(t,policy);const first=await top('r2'),middle=await top('r4');
  await grow('r3',150);
  assert.equal(await top(policy==='reading-line'?'r4':'r2'),policy==='reading-line'?middle:first);
  await page.evaluate(()=>{(window as any).keep.action()});await settle();
  const selected=await top('r2');await grow('r3',180);assert.equal(await top('r2'),selected,'action selects first visible');
  await grow('r3',200);assert.equal(await top('r2'),selected,'action survives another child resize');
  await page.evaluate(()=>{const el=document.querySelector('#scroll')!;el.scrollTop+=10;el.dispatchEvent(new Event('scroll'));});await settle();
  const current=await page.evaluate(()=>{const el=document.querySelector('#scroll')!,b=el.getBoundingClientRect(),line=(window as any).policy==='reading-line'?b.top+b.height/2:b.top;const row=[...el.querySelectorAll<HTMLElement>('[data-row]')].find(r=>r.getBoundingClientRect().bottom>line)!;return {id:row.dataset.row!,top:row.getBoundingClientRect().top};});
  await grow('r1',130);assert.equal(await top(current.id),current.top,'reader scroll resets the action policy');
  assert.deepEqual(await page.evaluate(()=>(window as any).errors),[]);
 });
 test(`anchor policy ${engine}: a new recorded reveal replaces the prior action anchor`,{skip:engineSkip(engine)},async t=>{
  const {page,settle,top,grow}=await open(t,'reading-line');
  await page.evaluate(()=>{(window as any).keep.action()});await settle();
  await page.evaluate(()=>{const el=document.querySelector('#scroll')!;el.scrollTop=650;(window as any).keep.record();});await settle();
  const before=await top('r7');await grow('r4',150);const after=await top('r7');
  t.diagnostic(JSON.stringify({engine,before,after,drift:after-before}));
  assert.equal(after,before,'late geometry below the previous action must preserve the new revealed reading place');
 });
 test(`anchor policy ${engine}: a successful trim restore ends the old clamp before the next reader scroll`,{skip:engineSkip(engine)},async t=>{
  const {page,settle,top,grow}=await open(t,'reading-line');
  await page.evaluate(()=>{
   (window as any).tail=false;
   const el=document.querySelector<HTMLElement>('#scroll')!;
   el.scrollTop=1200;el.dispatchEvent(new Event('scroll'));
  });
  await settle();
  await page.evaluate(()=>{
   (window as any).keep.action();
   const el=document.querySelector<HTMLElement>('#scroll')!, rows=el.firstElementChild!;
   for(let i=0;i<4;i++) rows.firstElementChild!.remove();
   void el.scrollHeight; // The browser clamps before the replacement tail arrives.
   for(let i=15;i<19;i++){
    const row=document.createElement('div');row.dataset.row='r'+i;row.style.height=(i===18?101:100)+'px';row.textContent='row '+i;rows.append(row);
   }
  });
  await settle();
  assert.equal(await page.locator('#scroll').evaluate(el=>el.scrollTop),800,'the surviving action row restores at the new coordinate');
  await page.evaluate(()=>{
   const el=document.querySelector<HTMLElement>('#scroll')!;
   el.dispatchEvent(new WheelEvent('wheel',{deltaY:300,bubbles:true}));
   el.scrollTop=1100;el.dispatchEvent(new Event('scroll'));
  });
  await settle();
  const before=await top('r15');
  await grow('r8',150);
  const after=await top('r15');
  t.diagnostic(JSON.stringify({engine,scenario:'trim-clamp-reader',before,after,drift:after-before}));
  assert.equal(after,before,'a previous clamp cannot restore an anchor from before the reader moved');
 });
}

for(const engine of ENGINES)test(`recorded reveal ${engine}: native fold then rail jump replaces action anchor`,{skip:engineSkip(engine)},async t=>{
 const fixture=await openThread(t,201,'pi',engine),{page}=fixture;
 fixture.answer((f,reply)=>{if(f.op!=='thread.outline')return false;reply({ok:true,value:{version:'policy',totalEntries:201,truncated:false,users:entries(201).flatMap((e,i)=>e.kind==='user'?[{id:e.id,ordinal:i,firstLine:e.text}]:[])}});return true;});
 fixture.send({...view(201),sourceVersion:'policy'});
 await page.locator('.companion-scrollbar').waitFor();
 await page.locator('[data-region=transcript]').hover();await page.mouse.wheel(0,-1200);await settled(page);await frames(page);
 const first=await anchor(page);
 // Synthetic content provides a native summary; ThreadView owns the real action capture.
 await page.locator(`[data-entry="${first.id}"]`).first().evaluate(el=>{const fold=document.createElement('details');fold.innerHTML='<summary>Synthetic fold</summary>';el.append(fold);});
 await frames(page);await page.getByText('Synthetic fold',{exact:true}).click();await frames(page);
 await page.locator('.companion-scrollbar').hover();await page.locator('[data-outline-item=e160]').click();
 await page.locator('[data-entry=e160].flash').waitFor();
 await page.waitForFunction(()=>document.querySelector('[data-region=transcript]')?.getAttribute('aria-busy')!=='true');
 await settled(page);await frames(page);
 const target=page.locator('[data-entry=e160]').first(),before=await target.evaluate(el=>el.getBoundingClientRect().top);
 await page.locator('[data-entry=e175]').first().evaluate(el=>{const image=document.createElement('img');image.id='late-after-jump';image.style.display='block';image.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="blue"/></svg>');el.append(image)});
 await page.evaluate(()=>(document.querySelector('#late-after-jump') as HTMLImageElement).decode());await frames(page);await settled(page);
 const after=await target.evaluate(el=>el.getBoundingClientRect().top);
 t.diagnostic(JSON.stringify({engine,oldAction:first.id,newReveal:'e160',resized:'e175',before,after,drift:after-before}));
 assert.equal(after,before,'a later explicit rail jump owns the anchor');
});
