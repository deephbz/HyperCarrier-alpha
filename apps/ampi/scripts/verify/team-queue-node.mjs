// Test-only native Team fixture. Simulator tools create the Team and deliveries; no real agent or provider runs.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { awaitWithContext, BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { TeamDoc, GraphDoc, JournalDoc, OutboxDoc, ObservationDoc } from '@hypercarrier/pi-team-durable/authority';
import { createModels } from '@earendil-works/pi-ai/models';
import { runDaemon } from '../../src/node/daemon.ts';
import { simProvider } from '../../src/node/sim.ts';
import { teamPlugin } from '../../src/plugins/team.ts';
import { TestClient } from '../../test/helpers.ts';
const [,dir] = process.argv.slice(2), home=join(dir,'home'); mkdirSync(home,{recursive:true});
const send=(type,value,name)=>process.send({type,value,name});
let held=false;
const Hold=defineTool({name:'team_hold',description:'Hold the synthetic Worker before queued Team delivery',replay:'unsafe',parameters:Type.Object({}),execute:async(_,api,context)=>{
 held=true; try { await awaitWithContext(new Promise(()=>{}),context); } finally { held=false; }
 return {output:[{type:'text',text:'aborted fixture hold'}]};
}});
const models=createModels();models.setProvider(simProvider({tokensPerSecond:1e9}));
const daemon=await runDaemon({home,models,plugins:[teamPlugin(),{extensions:[defineExtension({name:'queue-fixture',tools:[Hold]})],settings:{retry:{maxRetries:0}}}]});
const client=await TestClient.connect(daemon.socket), model={provider:'ampi-sim',modelId:'sim-1'};
const {threadId:lead}=await client.req('thread.create',{cwd:home,model,prompt:'/sim tool team_create {"name":"queue-demo","purpose":"Independent browser proof"}\n/sim tool ensure_worker {"name":"alice","scope":"Read queued Team work"}'});
const teamSid=client.sub({kind:'team',teamId:lead});
await client.until(teamSid,v=>v.workers?.length===1,15000);
const bound=await daemon.runtime.thread(lead), team=await bound.store.harness.snapshot(TeamDoc,BACKGROUND_CONTEXT);
const worker=bound.store.threadKey(team.current.workers.alice.conversationId);
await client.req('thread.rename',{threadId:lead,title:'Queue lead'});await client.req('thread.rename',{threadId:worker,title:'Queue Worker'});
const view=client.sub({kind:'thread',threadId:worker});
await client.req('thread.submit',{threadId:worker,content:'/sim tool team_hold {}'});
const wait=async(fn,label)=>{const end=Date.now()+15000;while(!await fn()){assert.ok(Date.now()<end,label);await new Promise(r=>setTimeout(r,25));}};
await wait(()=>held,'Worker tool barrier');
await client.req('thread.submit',{threadId:lead,content:'/sim tool task_graph_apply {"operation_id":"queue-plan","tasks":[{"key":"ship","title":"Ship the endpoint","goal":"Read this synthetic Task","assignee":"alice"}]}\n/sim tool alert_send {"kind":"attention","to":"alice","text":"Check the gate\\nSynthetic detail"}'});
const queued=await client.until(view,v=>v.inbox?.items?.some(i=>i.origin?.delivery==='task')&&v.inbox.items.some(i=>i.origin?.delivery==='alert'),15000);
const read=async()=>({view:await client.until(view,()=>true),authority:await Promise.all([TeamDoc,GraphDoc,JournalDoc,OutboxDoc,ObservationDoc].map(doc=>bound.store.harness.snapshot(doc,BACKGROUND_CONTEXT))),held});
process.on('message',m=>{void(async()=>{
 if(m.command==='snapshot')send('snapshot',await read(),m.name);
 if(m.command==='finish'){client.close();await daemon.stop();send('result',{stopped:true});process.disconnect();}
})().catch(e=>send('failure',String(e),m.name));});
process.once('disconnect',()=>process.exit());
send('ready',{home,lead,worker,queued,taskId:queued.inbox.items.find(i=>i.origin?.delivery==='task').origin.taskId});
