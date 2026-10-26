// Test-only pending-delivery barrier and native stop ledger. One process owns every store.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { awaitWithContext, BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { open as readTeamState, plain } from '@hypercarrier/pi-team-durable/authority';
import { Deliver } from '@hypercarrier/pi-team-durable/testing';
import { runDaemon } from '../../src/node/daemon.ts';
import { simProvider } from '../../src/node/sim.ts';
import { teamPlugin } from '../../src/plugins/team.ts';
import { TestClient } from '../helpers.ts';
const [,dir,mode]=process.argv.slice(2),home=join(dir,'home'),ledger=join(dir,`${mode}-ledger.jsonl`);
assert.equal(process.env.AMPI_SOCKET,undefined);
process.env.AMPI_ENTRY_LOG=ledger;process.env.AMPI_STOP_LOG=ledger;
if(mode==='seed')process.env.AMPI_STOP_LATCH=join(dir,'release-stop');else delete process.env.AMPI_STOP_LATCH;
const log=(value:unknown)=>appendFileSync(ledger,JSON.stringify(value)+'\n');
const send=(type:string,value:unknown,name?:string)=>process.send!({type,value,name});
const pending:any[]=[];const gates:(()=>void)[]=[];
// Wrap only the real phase's resolved recipient. The authority still performs its validity commit.
const submit=Deliver.definition.phases.submit;
if(mode==='seed')(Deliver.definition.phases as any).submit=(task:any,runtime:any,context:any)=>submit(task,new Proxy(runtime,{get(r,k){
 if(k==='conversation')return async(...args:any[])=>{const c=await r.conversation(...args);return c&&new Proxy(c,{get(target,key){
  if(key==='submit')return async(...draft:any[])=>{const row={kind:'delivery-before-submit',taskId:task.id,input:task.input,requestId:draft[0].requestId};pending.push(row);log(row);send('pending',row);const gate=new Promise<void>(resolve=>gates.push(resolve));await (process.env.AMPI_PENDING_NONCOOPERATIVE==='1'?gate:awaitWithContext(gate,context));log({kind:'delivery-submit',taskId:task.id});return target.submit(...draft);};
  const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;
 }});};const v=Reflect.get(r,k,r);return typeof v==='function'?v.bind(r):v;
}}),context);
const reports:string[]=[];const models=createModels();models.setProvider(simProvider({tokensPerSecond:1e9}));
const daemon=await runDaemon({home,models,report:error=>reports.push(String(error)),plugins:[teamPlugin(),{extensions:[],attach(store){
 const attachedAt=performance.now();
 const resume=store.harness.resume.bind(store.harness);store.harness.resume=()=>{log({kind:'scheduler-start',store:store.id,recoveryMarksMs:performance.now()-attachedAt});return resume();};
}}]});
const client=await TestClient.connect(daemon.socket),model={provider:'ampi-sim',modelId:'sim-1'};
const until=async(fn:()=>boolean,label:string)=>{const end=Date.now()+15000;while(!fn()){if(Date.now()>end)throw new Error(label);await new Promise(r=>setTimeout(r,10));}};
let ids:any;
async function snapshot(){
 const {store}=await daemon.runtime.thread(ids.lead);const {team,outbox,journal}=await store.harness.commit(async tx=>plain(await readTeamState(tx)),ctx),inspection=await store.harness.inspect(ctx);
 const admissions=[];for(const row of ids.pending??pending){const c=await store.conversation(row.input.conversationId,ctx);admissions.push({key:row.input.key,requestId:row.requestId,submission:await c.commit(tx=>tx.submissionByRequest(c.id,row.requestId),ctx)});}
 const workerEntries=[];for(const threadId of ids.workers){const {conversation}=await daemon.runtime.thread(threadId);workerEntries.push({threadId,entries:await conversation.entries({order:'ascending'},1000,undefined,ctx)});}
 const deliveryTasks=await store.harness.commit(tx=>Promise.all((ids.pending??pending).map((row:any)=>tx.task(row.taskId))),ctx);
 const tasks=await store.harness.commit(tx=>tx.scanTasks({},1000),ctx);assert.equal(tasks.next,undefined);
 return{team,outbox,journal,inspection,deliveryTasks,taskIds:tasks.items.map(t=>t.id),admissions,workerEntries,reports};
}
async function finish(){client.close();await daemon.stop();send('result',{stopped:true,reports});process.disconnect!();}
async function command(message:any){
 if(message.command==='seed'){
  const unrelated=(await client.req('thread.create',{requestId:'pending-unrelated',cwd:home,model,prompt:'Unrelated before crash'})).threadId;
  const lead=(await client.req('thread.create',{requestId:'pending-lead',cwd:home,model,prompt:['/sim tool team_create {"name":"pending","purpose":"Crash pending deliveries"}','/sim tool ensure_worker {"name":"alice","scope":"A"}','/sim tool ensure_worker {"name":"bob","scope":"B"}'].join('\n')})).threadId;
  const sid=client.sub({kind:'team',teamId:lead});const team=await client.until<any>(sid,v=>v.workers?.length===2,15000);const {conversation}=await daemon.runtime.thread(lead);await conversation.waitForIdle(ctx);
  ids={lead,unrelated,workers:team.workers.map((w:any)=>w.threadId)};writeFileSync(join(dir,'ids.json'),JSON.stringify(ids));
  await client.req('thread.submit',{threadId:lead,requestId:'pending-graph',content:'/sim tool task_graph_apply '+JSON.stringify({operation_id:'pending-graph',tasks:['alice','bob'].map(name=>({key:name,title:name,goal:'Never run after shutdown',assignee:name}))})});
  await until(()=>pending.length===2,'two pending Deliver submits');await conversation.waitForIdle(ctx);ids.pending=pending;writeFileSync(join(dir,'ids.json'),JSON.stringify(ids));send('seeded',{ids,before:await snapshot()});
 }else if(message.command==='shutdown'){
  await client.req('thread.submit',{threadId:ids.lead,requestId:'pending-shutdown',content:'/sim tool team_shutdown {}'});send('shutdown-admitted',{},message.name);
 }else if(message.command==='close-intent'){
  process.env.AMPI_FAULT='close-intent-only';
  try{send('close-intent',await client.req('thread.close',{threadId:ids.lead}),message.name);}
  finally{delete process.env.AMPI_FAULT;}
 }else if(message.command==='archive-intent'){
  process.env.AMPI_FAULT='archive-intent-only';
  try{send('archive-intent',await client.req('thread.archive',{threadId:ids.lead,archived:true}),message.name);}
  finally{delete process.env.AMPI_FAULT;}
 }else if(message.command==='snapshot')send('snapshot',await snapshot(),message.name);
 else if(message.command==='continuity'){
  const ack=await client.req('thread.submit',{threadId:ids.unrelated,requestId:'pending-unrelated-after',content:'Unrelated after crash'});const {conversation}=await daemon.runtime.thread(ids.unrelated);await conversation.waitForIdle(ctx);const native=await conversation.commit(tx=>tx.submissionByRequest(conversation.id,'pending-unrelated-after'),ctx);send('continuity',{ack,native,entries:await conversation.entries({order:'ascending'},1000,undefined,ctx)},message.name);
 }else if(message.command==='finish')await finish();
}
process.on('message',(message:any)=>{void command(message).catch(error=>{send('failure',String(error));console.error(error);});});
process.once('disconnect',()=>process.exit());
if(mode!=='seed')ids=JSON.parse(readFileSync(join(dir,'ids.json'),'utf8'));
send('ready',{home,mode});
