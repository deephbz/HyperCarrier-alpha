import './bound.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { TeamDoc,HeadDoc,open,plain,observations } from '@hypercarrier/pi-team-durable/authority';
import { openAuthority,openObservations } from '@hypercarrier/pi-team-durable/authority';
import { graphCommand,taskRecord,flushAuthority,ObservationHeadDoc,reserve,savePage } from '@hypercarrier/pi-team-durable/testing';
import { runDaemon } from '../src/node/daemon.ts';
import { hydrate } from '../src/plugins.ts';
import { teamPlugin } from '../src/plugins/team.ts';
import type { ThreadSummary } from '../src/shared/protocol.ts';
import { TestClient, tempHome } from './helpers.ts';

const SIM={provider:'ampi-sim',modelId:'sim-1'};
test('/ptb keyed graph replay survives restart without navigation or transcript entries',async t=>{
 const home=tempHome();let daemon=await runDaemon({home,simTokensPerSecond:20000,plugins:await hydrate()});
 t.after(()=>daemon.stop());let client=await TestClient.connect(daemon.socket);t.after(()=>client.close());
 const {threadId}=await client.req('thread.create',{cwd:home,model:SIM,prompt:'/sim tool team_create {"name":"retry-demo","purpose":"Check command replay"}'});
 const view=client.sub({kind:'thread',threadId});
 await client.until<any>(view,v=>v.entries.some((e:any)=>e.kind==='tool-result')&&!v.live?.run,15000);
 const thread=await daemon.runtime.thread(threadId);
 const entries=await thread.conversation.entries({},100,undefined,context);
 const command={threadId,name:'ptb',args:'graph',key:'graph-key'};
 assert.equal((await client.req('thread.command',command)).panel,'team');
 assert.equal((await client.req('thread.command',command)).panel,undefined);
 assert.deepEqual(await thread.conversation.entries({},100,undefined,context),entries);
 client.close();await daemon.stop();
 daemon=await runDaemon({home,simTokensPerSecond:200,plugins:await hydrate()});client=await TestClient.connect(daemon.socket);
 const replay=await client.req('thread.command',command);
 assert.equal(replay.panel,undefined);assert.equal(replay.notice,'Opened the Team panel');
 const threads=client.sub({kind:'threads'});
 await client.req('thread.submit',{threadId,content:'/sim long 200'});
 await client.until<any>(threads,v=>v.threads[threadId]?.activity==='streaming');
 assert.equal((await client.req('thread.command',{threadId,name:'ptb',args:'status'})).disposition,'handled');
 assert.equal((await client.req('thread.command',{threadId,name:'ptb',args:'graph'})).panel,'team');
 await client.req('thread.abort',{threadId});
 await client.req('thread.close',{threadId});
 await assert.rejects(client.req('thread.command',{threadId,name:'ptb',args:'status'}),(e:any)=>e.code==='closed');
});
test('/ptb: bound lead and Worker read the same authority without changing it', async t=>{
 const home=tempHome(),daemon=await runDaemon({home,simTokensPerSecond:20000,plugins:await hydrate()});
 t.after(()=>daemon.stop());
 const client=await TestClient.connect(daemon.socket);t.after(()=>client.close());
 const created=await client.req('thread.create',{cwd:home,model:SIM,prompt:[
  '/sim tool team_create {"name":"command-demo","purpose":"Check read-only commands"}',
  '/sim tool ensure_worker {"name":"alice","scope":"Build the sample"}',
  '/sim tool task_graph_apply {"operation_id":"plan","tasks":[{"key":"ready","title":"Ready work","goal":"Works","assignee":"alice"},{"key":"wait","title":"Waiting work","goal":"Works","assignee":"alice","needs":["ready"]}]}'
 ].join('\n')});
 const lead=created.threadId, view=client.sub({kind:'thread',threadId:lead});
 await client.until<any>(view,v=>v.entries.filter((e:any)=>e.kind==='tool-result').length>=3&&!v.live?.run,15000);
 const thread=await daemon.runtime.thread(lead),store=thread.store;
 const team=await store.harness.snapshot(TeamDoc,context) as any;
 assert.equal(team.current.name,'command-demo');
 const worker=store.threadKey(team.current.workers.alice.conversationId);
 const read=()=>store.harness.commit(async tx=>plain({authority:await open(tx),observation:await observations(tx),head:await tx.doc(HeadDoc),observationHead:await tx.doc(ObservationHeadDoc)}),context);
 // Settle independent notifier work before comparing read-only command effects.
 let before=JSON.stringify(await read());
 for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,20));const next=JSON.stringify(await read());if(next===before&&daemon.runtime.threads.value.threads[worker]?.activity==='idle')break;before=next;}
 // Install a stable synthetic graph after the real simulated Worker completes its tasks.
 // graphCommand reconciles but does not schedule delivery, so the Worker cannot race the read assertions.
 await store.harness.commit(async tx=>{
  const s=await openAuthority(tx);
  await graphCommand(s,{kind:'apply',input:{operationId:'fixture-clear',expectedGraphVersion:s.head.graph!.revision!.version,tasks:[{key:'fixture-reset',title:'Reset',goal:'Synthetic reset',assignee:'alice'}]}},()=>0);
  await graphCommand(s,{kind:'apply',input:{operationId:'fixture',expectedGraphVersion:s.head.graph!.revision!.version,tasks:[{key:'ready',title:'Ready work',goal:'Works',assignee:'alice'},{key:'wait',title:'Waiting work',goal:'Works',assignee:'alice',needs:['ready']}]}},()=>0);
  flushAuthority(s);
 },context);
 for(const [role,threadId] of [['lead',lead],['Worker',worker]]) {
  await t.test(`${role} discovers /ptb`,async()=>{
   const list=await client.req('thread.commands',{threadId});
   assert.equal(list.commands.find((c:any)=>c.name==='ptb')?.supported,true);
  });
  for(const subcommand of ['help','status','sync','graph','graph 25','graph 50','graph 100','graph 200','graph all','doctor','settings'])await t.test(`${role} /ptb ${subcommand}`,async()=>{
   const prior=await read();
   const reply=await client.req('thread.command',{threadId,name:'ptb',args:subcommand});
   assert.equal(reply.disposition,'handled');assert.equal(reply.via,'node');
   const text=[reply.notice,reply.body].filter(Boolean).join('\n');
   if(subcommand==='help'){assert.match(text,/Show current Team updates \(they stay unread for the lead\)/);assert.match(text,/at most 50 events or 100 native entries/);}
   if(subcommand==='status'){
    assert.match(text,/command-demo/);assert.match(text,role==='lead'?/Role: lead/:/Role: Worker alice/);
    assert.match(text,/ready: 1/);assert.match(text,/dependency_waiting: 1/);assert.match(text,/alice.*idle/);
    assert.match(text,/wait.*ready/);assert.match(text,/\nBlocked or waiting:\n/);assert.doesNotMatch(text,/Blockers:/);assert.equal(reply.panel,undefined);assert.ok(reply.body);
   }
   if(subcommand==='sync'){assert.match(text,/owner read/i);assert.match(text,/snapshot|50 events/i);assert.match(text,/Ready work/);assert.ok(reply.body);assert.equal(reply.panel,undefined);}
   if(subcommand.startsWith('graph')){assert.equal(reply.panel,'team');assert.match(reply.notice,/Opened the Team panel/);if(subcommand!=='graph')assert.match(reply.notice,/whole graph/);}
   if(subcommand==='doctor')assert.match(text,/doctor: not on durable threads\. Durable/);
   if(subcommand==='settings')assert.match(text,/settings: not on durable threads\. Durable/);
   assert.deepEqual(await read(),prior,'command changes no Team, Task, delivery or observation document');
  });
  await t.test(`${role} refuses unsupported options`,async()=>{
   for(const args of ['graph 7','status --json','sync --wait','create','stauts'])await assert.rejects(client.req('thread.command',{threadId,name:'ptb',args}),(e:any)=>e.code==='bad_args'&&e.message===`Unknown: ${args}. Use /ptb help.`);
   // Only the Pi-pane commands name durable threads.
   for(const args of ['doctor repair','settings model'])await assert.rejects(client.req('thread.command',{threadId,name:'ptb',args}),(e:any)=>e.code==='bad_args'&&e.message.startsWith(`${args}: not on durable threads.`));
  });
 }
 await t.test('status distinguishes claimed, blocked and finished Tasks',async()=>{
  await store.harness.commit(async tx=>{
   const s=await openAuthority(tx);
   await graphCommand(s,{kind:'apply',input:{operationId:'states',expectedGraphVersion:s.head.graph!.revision!.version,tasks:[{key:'ready',title:'Ready work',goal:'Works',assignee:'alice'},{key:'wait',title:'Waiting work',goal:'Works',assignee:'alice',needs:['ready']},...['claimed','blocked','finished'].map(key=>({key,title:key,goal:'Works',assignee:'alice'}))]}},()=>0);
   for(const key of ['finished','blocked','claimed']){
    await graphCommand(s,{kind:'transition',input:{taskId:key,operationId:`claim-${key}`,expectedVersion:(await taskRecord(s,key))!.card.version as `v_${string}`,transition:'claim',worker:'alice'}},()=>0);
    if(key!=='claimed')await graphCommand(s,{kind:'transition',input:{taskId:key,operationId:`end-${key}`,expectedVersion:(await taskRecord(s,key))!.card.version as `v_${string}`,transition:key==='blocked'?'block':'goal_achieved',worker:'alice',evidence:key==='blocked'?'Needs owner credential.':'Verified sample.'}},()=>0);
   }
   flushAuthority(s);
  },context);
  const prior=await read();
  for(const threadId of [lead,worker]){
   const reply=await client.req('thread.command',{threadId,name:'ptb',args:'status'});
   for(const state of ['ready','dependency_waiting','in_progress','blocked','goal_achieved'])assert.ok(reply.body.includes(`${state}: 1`),reply.body);
   assert.match(reply.body,/Needs owner credential/);assert.equal(reply.panel,undefined);
  }
  const summary={id:lead,title:'Team lead',activity:'idle',queued:0} as ThreadSummary;
  await teamPlugin().summarize!(store,thread.conversationId,summary);
  assert.equal(summary.team?.role,'lead');
  assert.deepEqual(summary.attention??[],[],'blocked Tasks stay in Team authority without producing Needs-you attention');
  assert.deepEqual(await read(),prior);
 });
 await t.test('sync reads one bounded page from acknowledged baseline, never a reserved head',async()=>{
  await store.harness.commit(async tx=>{
   const authority=await openAuthority(tx),journal=authority.journal,observation=await openObservations(tx);
   journal.seq=61;journal.acknowledged=1;
   journal.events=Array.from({length:60},(_,i)=>({seq:i+2,epoch:team.current.epoch,actor:'alice',kind:'task_transitioned',taskId:'ready',at:'2030-01-01T00:00:00Z',text:`Update ${i+2}`}));
   observation.head.epoch=team.current.epoch;observation.head.acknowledged=1;observation.head.ackByEpoch[team.current.epoch]=1;
   // A synthetic unobserved page proves that owner reads ignore the reserved head.
   await reserve(observation,{id:'reserved',epoch:team.current.epoch,lead:team.current.lead,run:0 as any,from:1,through:61,carrier:{kind:'tool',callId:'synthetic'}},{kind:'caught_up'});
   flushAuthority(authority);
  },context);
  const prior=await read();
  for(const threadId of [lead,worker])for(let repeat=0;repeat<2;repeat++){
   const reply=await client.req('thread.command',{threadId,name:'ptb',args:'sync'});
   assert.match(reply.body,/\nUpdates 2–51; more remain\./);assert.doesNotMatch(reply.body,/acknowledged|read through|50 events/);
   assert.match(reply.body,/alice: Update 2\n/);assert.match(reply.body,/alice: Update 51\n/);
   assert.doesNotMatch(reply.body,/Update 52/);
   assert.deepEqual(await read(),prior);
  }
 });
 await t.test('sync native fallback stops at 100 entries without advancing its cursor',async()=>{
  await store.harness.commit(async tx=>{
   const marker=await tx.appendEntry(team.current.lead,{kind:'fixture.marker',data:{}});
   for(let i=0;i<100;i++)await tx.appendEntry(team.current.lead,{kind:'fixture.noise',data:{}});
   await tx.appendEntry(team.current.lead,{kind:'ptb.event',data:{seq:2,epoch:team.current.epoch,actor:'alice',kind:'task_transitioned',taskId:'ready',at:'2030-01-01T00:00:00Z',text:'Beyond native bound'}});
   const authority=await openAuthority(tx),journal=authority.journal,observation=await openObservations(tx);
   journal.events=[];journal.seq=2;
   // Seed an already-retired baseline; owner reads cannot reserve or acknowledge it.
   await savePage(observation,{id:'baseline',epoch:team.current.epoch,lead:team.current.lead,run:0 as any,from:0,through:1,scanThrough:marker.id,digest:'synthetic',carrier:{kind:'tool',callId:'baseline'},state:'acknowledged',pruned:true});
   flushAuthority(authority);
  },context);
  const prior=await read();
  const reply=await client.req('thread.command',{threadId:lead,name:'ptb',args:'sync'});
  assert.match(reply.body,/\nNo updates on this page; more remain\./);assert.doesNotMatch(reply.body,/acknowledged|read through/);
  assert.doesNotMatch(reply.body,/Beyond native bound/);assert.deepEqual(await read(),prior);
 });
 await t.test('unbound thread, including a fork in the Team store, has no Team',async()=>{
  const plain=await client.req('thread.create',{cwd:home,model:SIM});
  const page=await thread.conversation.entries({},1,undefined,context);
  const fork=await thread.conversation.fork(page.items[0]!.id,{ownership:{kind:'ownerless'}},context);
  for(const threadId of [plain.threadId,store.threadKey(fork.id)])for(const args of ['help','status','sync','graph','doctor','settings']){
   const reply=await client.req('thread.command',{threadId,name:'ptb',args});
   assert.equal(reply.notice,'No Team is bound to this thread.');assert.equal(reply.panel,undefined);
  }
 });
});
