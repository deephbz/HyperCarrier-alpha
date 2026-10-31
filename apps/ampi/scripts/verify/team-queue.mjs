// Browser contract for queued durable Team deliveries and owner /ptb reports. Uses the lane-1 browser.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { CrashChild } from '../../test/durable-l2/process.ts';
import { href } from '../../web/src/util.ts';
import { target, submodulesPinned } from './hub.mjs';
import { webDistCurrent } from '../web-inputs.mjs';
import { topicSnapshot } from './live-rows.mjs';
const until=async(fn,label)=>{const end=Date.now()+15000;while(!await fn()){assert.ok(Date.now()<end,label);await new Promise(r=>setTimeout(r,30));}};
export async function teamQueue(j){
 const p=j.page,context=p.context(),run=mkdtempSync(join(tmpdir(),'ampi-team-queue-')),proof=join(j.state.proof,'D-team-owner');mkdirSync(proof,{recursive:true});
 const receipt={prediction:'Native queued Task and Alert show exact badges, sender and summary with no edit or withdraw. Esc preserves only owner draft and returns Team rows with no text. Task outcome names its readable ID. Bound /ptb help/status/sync return read-only reports; graph opens Team; typo names stauts. Reports survive thread switches and Dismiss removes them.',spendUsd:0,rows:[]},failures=[],children=[];
 const save=()=>writeFileSync(join(proof,'team-owner.json'),JSON.stringify(receipt,null,2)+'\n'); save();
 let node,hub,pattern,seq=0;
 const ipc=async(command)=>{const name='q'+ ++seq;node.child.send({command,name});return(await node.wait(command,name,15000)).value;};
 const step=async(name,action,fn)=>{const row={name};receipt.rows.push(row);try{await j.step(name,action,async()=>{row.observed=await fn();row.status='passed';return row.observed;});}catch(e){row.status='failed';row.error=String(e);failures.push(name+': '+e);}finally{save();}};
 try{
  assert.ok(submodulesPinned(target).ok);assert.ok(webDistCurrent(target).ok);
  const dir=join(run,'node');mkdirSync(dir);node=new CrashChild(dir,'team-queue','node',new URL('./team-queue-node.mjs',import.meta.url));children.push(node);
  const ready=(await node.wait('ready',undefined,30000)).value;receipt.seed=ready;
  writeFileSync(join(run,'hub-config.json'),JSON.stringify({nodes:[ready.home]}));hub=new CrashChild(run,'team-queue','hub',pathToFileURL(join(target,'apps/ampi/test/durable-l3/round2-hub.ts')));children.push(hub);
  const {port}=(await hub.wait('ready',undefined,20000)).value;assert.ok(port<7879||port>7895);
  const wire=[];p.on('websocket',ws=>ws.on('framereceived',({payload})=>{const frame=JSON.parse(String(payload));if(frame.t==='res')wire.push(frame);}));
  const origin='http://127.0.0.1:'+port,auth={cookie:'ampi_k_'+port+'='+'e'.repeat(64)};
  await until(async()=>{const health=await fetch(origin+'/api/health',{headers:auth}).then(r=>r.json());return health.hosts.some(h=>h.link==='devbox#durable'&&h.status==='connected');},'connected durable host');
  pattern=origin+'/**';await context.route(pattern,r=>r.continue());await context.addCookies([{name:'ampi_k_'+port,value:'e'.repeat(64),url:origin}]);
  receipt.doctor={port,submodules:submodulesPinned(target),web:webDistCurrent(target)};
  const goto=async id=>{await p.goto(origin+'/'+href.thread('devbox#durable',id));await p.getByRole('textbox',{name:'Thread title',exact:true}).waitFor();};
  const input=()=>p.getByRole('textbox',{name:'Message the agent',exact:true});
  const source=()=>topicSnapshot({port,host:'devbox#durable',auth,topic:{kind:'thread',threadId:ready.worker},timeoutMs:15000});
  const report=()=>p.locator('[data-command-result]');
  const command=async value=>{const at=wire.length;await input().fill('/ptb '+value);await input().press('Enter');await until(()=>wire.slice(at).some(f=>value==='stauts'?f.error?.message==='Unknown: stauts. Use /ptb help.':f.ok&&f.value?.disposition==='handled'),'command response');};
  await goto(ready.worker);
  await step('queue-read-only','Read native queued Task and Alert on a durable Worker',async()=>{
   const rows=[];
   for(const [kind,sender,summary]of [['task','team-lead','Ship the endpoint'],['alert','team-lead','Check the gate']]){
    const row=p.locator('.queue-item[data-origin="'+kind+'"]');await row.waitFor();assert.equal(await row.locator('.badge').innerText(),kind);assert.equal(await row.locator('.notice-sender').innerText(),sender);assert.equal(await row.locator('.text').innerText(),summary);assert.equal(await row.getByRole('button').count(),0);rows.push({kind,sender,summary,text:await row.innerText()});
   }
   return {rows,native:await source()};
  });
  for(const [sub,expected]of [['help','/ptb status'],['status','Role: Worker alice'],['sync','updates stay unread for the lead']])await step('ptb-'+sub,'Run /ptb '+sub+' on the bound Worker',async()=>{
   const before=await ipc('snapshot');await command(sub);await report().waitFor();const disclosure=report().locator('summary');if(await disclosure.count())await disclosure.click();await until(async()=>(await report().innerText()).includes(expected),'command report '+expected);const after=await ipc('snapshot');assert.deepEqual(after.authority,before.authority,'owner command mutated Team authority');assert.deepEqual(after.view.entries,before.view.entries,'owner command became agent text');return {text:await report().innerText(),nativeUnchanged:true};
  });
  await step('ptb-report-switch-dismiss','Switch to the lead and back; read the same report, then Dismiss',async()=>{
   const before=await report().innerText();await goto(ready.lead);assert.equal(await report().count(),0);await goto(ready.worker);await report().waitFor();const disclosure=report().locator('summary');if(await disclosure.count())await disclosure.click();assert.equal(await report().innerText(),before);await report().getByRole('button',{name:'Dismiss',exact:true}).click();assert.equal(await report().count(),0);return {before,afterSwitch:before,dismissed:true};
  });
  await step('ptb-graph','Run /ptb graph and read the Team panel',async()=>{await command('graph');await p.locator('[data-panel-name="team"]').waitFor();return {panel:await p.locator('[data-panel-name="team"]').innerText(),report:await report().innerText()};});
  await step('ptb-typo','Run /ptb stauts and read the exact correction',async()=>{await command('stauts');const error=p.getByRole('alert').filter({hasText:'Unknown: stauts. Use /ptb help.'});await error.waitFor();const reply=wire.findLast(f=>f.error?.message==='Unknown: stauts. Use /ptb help.');assert.ok(reply,'exact native typo correction');const text=await error.locator('span').first().innerText();assert.equal(text,'Not sent: Unknown: stauts. Use /ptb help. Your draft is kept; fix it and send again.');assert.equal(await error.getByRole('button',{name:'Dismiss',exact:true}).count(),1,'outcome offers Dismiss');return {error:text,reply};});
  await step('queue-escape','Keep an owner draft, press Esc, and inspect returned Team rows',async()=>{
   await input().fill('OWNER_DRAFT_ONLY');await input().press('Escape');
   const task=p.locator('.queue-item[data-origin="task"].settled');await task.waitFor();await p.locator('.queue-item[data-origin="alert"].settled').waitFor();
   assert.equal(await input().inputValue(),'OWNER_DRAFT_ONLY');const literal='the Worker can still read Task '+ready.taskId;assert.ok((await task.innerText()).includes(literal));
   const native=await source();const team=native.inbox.items.filter(i=>i.origin);assert.equal(team.length,2);assert.ok(team.every(i=>i.state==='returned'));const ack=wire.findLast(f=>f.value?.submissions?.some(s=>s.origin));assert.ok(ack);assert.ok(ack.value.submissions.filter(s=>s.origin).every(s=>s.text===undefined),'Team text must never enter the draft restore payload');return {draft:await input().inputValue(),taskText:await task.innerText(),literal,ack,native};
  });
  await step('queue-dismiss','Dismiss returned Team records without inserting Team text',async()=>{
   for(const kind of ['task','alert'])await p.locator('.queue-item[data-origin="'+kind+'"]').getByTitle('Dismiss',{exact:true}).click();
   await until(async()=>await p.locator('.queue-item.team').count()===0,'Team records dismissed');assert.equal(await input().inputValue(),'OWNER_DRAFT_ONLY');return {draft:await input().inputValue(),native:await source()};
  });
 }finally{
  for(const child of [hub,node])if(child?.child.connected){child.child.send({command:'finish'});await child.result().catch(()=>child.cleanup());}
  for(const child of children){child.cleanup();await child.exited;}
  receipt.cleanup=children.map(c=>({exit:c.child.exitCode,signal:c.child.signalCode}));
  for(const [name,dir]of [['node',join(run,'node')],['hub',run]])try{writeFileSync(join(proof,name+'.log'),readFileSync(join(dir,name+'.log')));}catch{}
  rmSync(run,{recursive:true,force:true});receipt.runRemoved=true;if(pattern)await context.unroute(pattern);save();
 }
 assert.deepEqual(failures,[],failures.join('; '));
}
