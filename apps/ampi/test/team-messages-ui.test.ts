import "./bound.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";
import { build } from "vite";
import react from "@vitejs/plugin-react";
// @ts-ignore: shared verification helpers are plain ESM.
import { messageFixture, checkMessageFilters } from "../scripts/verify/team-messages.mjs";
// @ts-ignore: plain ESM browser discovery.
import { findChrome } from "../scripts/perf/browser.mjs";

test("Team messages UI: exact sender/recipient filters preserve fan-out, bounded history and epoch changes", async t => {
 const root=fileURLToPath(new URL("../web",import.meta.url)),entry=join(root,"team-messages-test.js");
 const built=await build({configFile:false,root,logLevel:"silent",define:{"process.env.NODE_ENV":JSON.stringify("production")},plugins:[react(),{
  name:"team-messages-test",resolveId:id=>id===entry?`\0${entry}`:undefined,
  load:id=>id===`\0${entry}`?`
   import React from 'react';import {createRoot} from 'react-dom/client';
   import {TeamPanel} from ${JSON.stringify(join(root,"src/views/team/TeamPanel.tsx"))};
   import ${JSON.stringify(join(root,"src/styles.css"))};
   createRoot(document.getElementById('root')).render(React.createElement(TeamPanel,{host:'devbox',threadId:'store.1'}));
  `:undefined,
 }],build:{write:false,minify:false,lib:{entry,formats:["iife"],name:"TeamMessagesTest"}}});
 const output=(Array.isArray(built)?built[0]:built) as {output:{type:string;code?:string;source?:string;fileName:string}[]};
 const script=output.output.find(i=>i.type==="chunk")!.code!;
 const css=output.output.filter(i=>i.fileName.endsWith(".css")).map(i=>i.source).join("\n");
 const browser=await chromium.launch({headless:true,executablePath:findChrome()});
 t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1024,height:700}});page.setDefaultTimeout(5000);
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
 await page.route("**/*",route=>{
  const url=new URL(route.request().url());
  if(url.origin!=="http://localhost")return route.abort();
  return route.fulfill({contentType:url.pathname==="/component.js"?"text/javascript":"text/html",body:url.pathname==="/component.js"?script:`<meta charset="utf-8"><style>${css}</style><main class="panel" style="width:380px;height:100vh;overflow:auto;padding:16px"><div id="root"></div></main><script src="/component.js"></script>`});
 });
 let publish:(messages:any)=>void=()=>{throw new Error("No Team subscription");};
 await page.routeWebSocket("**/ws",ws=>{
  ws.send(JSON.stringify({t:"hosts",hosts:[{id:"devbox",label:"Workbench",kind:"local",status:"connected",attempts:0}]}));
  ws.onMessage(raw=>{
   const f=JSON.parse(String(raw));
   if(f.t==="sub"&&f.topic.kind==="view"&&f.topic.view==="team"){
    publish=messages=>ws.send(JSON.stringify({t:"snap",sid:f.sid,value:{availability:"available",teams:[{name:"Reused Team",members:[],tasks:[],issues:[],messages}]}}));
    publish(messageFixture());
   }
  });
 });
 await page.goto("http://localhost/");
 const result=await checkMessageFilters(page);
 const region=page.getByRole("region",{name:"Messages",exact:true});
 const proof=process.env.AMPI_TEAM_MESSAGES_PROOF;
 if(proof){mkdirSync(proof,{recursive:true});writeFileSync(join(proof,"filters.json"),JSON.stringify(result));await page.screenshot({path:join(proof,"narrow.png")});}
 await page.emulateMedia({colorScheme:"dark"});
 if(proof)await page.screenshot({path:join(proof,"dark.png")});
 assert.equal(await page.locator("main").evaluate(e=>e.scrollWidth<=e.clientWidth),true,"long text cannot widen the panel");
 await region.getByLabel("Message sender").selectOption("builder");
 await region.locator("summary").click();
 const next=messageFixture();next.epoch="epoch-two";next.records=[{...next.records[0],text:"New epoch, same record id",from:"new-lead",to:["new-worker"]}];
 publish(next);
 await region.getByRole("status").getByText(/1 of 1 rows/).waitFor();
 assert.equal(await region.getByLabel("Message sender").inputValue(),"","filters reset when Team epoch changes");
 assert.equal(await region.locator("details[open]").count(),0,"disclosures do not carry across record identity");
 const many=messageFixture();
 many.epoch="epoch-three";many.records=Array.from({length:35},(_,i)=>({...many.records[0],id:String(i),text:`Page record ${i}`}));
 publish(many);
 await region.getByRole("status").getByText(/35 of 35 rows/).waitFor();
 assert.equal(await region.locator("[data-message-kind]").count(),30);
 await region.getByRole("button",{name:"Next",exact:true}).click();
 await region.getByText("31–35 of 35",{exact:true}).waitFor();
 assert.equal(await region.locator("[data-message-kind]").count(),5);
 many.records=[];publish(many);
 await region.getByText("No messages in this recent history.",{exact:true}).waitFor();
 const mixed=messageFixture();
 mixed.epoch="epoch-four";
 mixed.records=[mixed.records[3],mixed.records[4],
  {...mixed.records[3],id:"task-delivery",deliveryKind:"task",ref:"work"},
  {...mixed.records[4],id:"stop-delivery",deliveryKind:"stop",ref:"work"},mixed.records[5]];
 publish(mixed);
 await region.getByRole("status").getByText(/3 of 3 rows/).waitFor();
 assert.match(await region.getByRole("status").innerText(),/Alert texts outside history: 1/);
 assert.equal(await region.locator('[data-message-kind="alert"]').count(),1,"orphan deliveries group by Alert ref");
 assert.equal(await region.locator('[data-message-kind="delivery"]').count(),2,"Task and stop deliveries stay separate");
 const orphan=region.locator('[data-message-kind="alert"]');
 assert.match(await orphan.locator("summary").innerText(),/Sender unavailable/);
 assert.match(await orphan.locator("summary").innerText(),/Alert text outside recent history/);
 assert.equal(await orphan.locator(".ptb-delivery-status").innerText(),"builder: received · builder-two: submitted");
 await region.getByLabel("Message recipient").selectOption("builder");
 await region.getByRole("status").getByText(/2 of 3 rows/).waitFor();
 publish({availability:"unavailable",reason:"Messages unavailable for Pi Teams: this Host publishes membership and Tasks only."});
 await region.getByText(/Messages unavailable for Pi Teams/).waitFor();
 assert.equal(await region.getByRole("combobox").count(),0);
 assert.doesNotMatch(await region.innerText(),/No messages/);
 if(proof){await page.setViewportSize({width:1440,height:900});await page.screenshot({path:join(proof,"pi-unavailable.png")});}
 assert.deepEqual(errors,[]);
});
