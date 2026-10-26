import './bound.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { teamView } from '../src/plugins/team-view.ts';
import { openAuthority } from '@hypercarrier/pi-team-durable/authority';
import { addAlert,addObligation,obligation,setObligationState,type Authority,type Obligation } from '@hypercarrier/pi-team-durable/testing';
import { runtimeFixture,context } from './team-runtime-fixture.ts';

type Fixture=Awaited<ReturnType<typeof runtimeFixture>>;
const readPanel=(f:Fixture)=>f.harness.commit(tx=>teamView(tx,'store'),context);
const seed=(f:Fixture,write:(s:Authority)=>Promise<void>|void)=>f.harness.commit(async tx=>{
 const s=await openAuthority(tx);await write(s);s.flush();
},context);
const recordDelivery=(f:Fixture,value:Obligation)=>seed(f,async native=>{
 const stored=(await obligation(native,value.key))!;Object.assign(stored,value);
 if(value.submittedAt===undefined)delete stored.submittedAt;
 await setObligationState(native,stored,value.state);
});

// Synthetic fixture of the legacy teamView fields read by TeamPanel. Native IDs and versions are opaque.
const legacyPanelFixture={
 team:{name:'demo',purpose:'Test',status:'active'},leadThreadId:'store.1',
 workers:[{name:'builder',scope:'Build',threadId:'store.worker',membership:{active:true}}],
 tasks:[{key:'api',title:'API',goal:'Works',assignee:'builder',needs:[],current_context:'Work has not started.',derived:'goal_achieved',evidence:'tested',attempts:[{ordinal:1,startedAt:1000,endedAt:1000,outcome:'goal_achieved',evidence:'tested'}]}],
};
test('native Team projection preserves the legacy panel fields and recorded attempt times',async()=>{
 const f=await runtimeFixture();
 try{
  await f.runtime.core.execute('ensure_worker','lead',{name:'builder',scope:'Build'},f.api(),context);
  const applied=await f.runtime.core.execute('task_graph_apply','lead',{operation_id:'plan',tasks:[{key:'api',title:'API',goal:'Works',assignee:'builder'}]},f.api(),context) as any;
  const s=await f.state(),worker=s.team.current!.workers.builder;
  const workerApi=()=>({...f.api(),conversationId:worker.conversationId});
  const claimed=await f.runtime.core.execute('task_update','worker',{task_id:'api',operation_id:'claim',expected_version:applied.tasks_by_key.api.version,transition:'claim'},workerApi(),context) as any;
  await f.runtime.core.execute('task_update','worker',{task_id:'api',operation_id:'done',expected_version:claimed.task.version,transition:'goal_achieved',evidence:'tested'},workerApi(),context);
  const view=await f.harness.commit(tx=>teamView(tx,'store'),context) as any;
  assert.deepEqual({team:{name:view.team.name,purpose:view.team.purpose,status:view.team.status},leadThreadId:`store.${view.team.leadConversationId}`,workers:view.workers.map((w:any)=>({name:w.name,scope:w.scope,threadId:'store.worker',membership:{active:w.membership.active}})),tasks:view.tasks.map(({version,status,...t}:any)=>({...t,attempts:t.attempts.map(({id,...a}:any)=>a)}))},legacyPanelFixture);
  assert.match(view.tasks[0].version,/^v_[0-9a-f]{16}$/);
  assert.equal(view.deliveries[0].acceptedAt,1000);
  assert.equal(view.workers[0].threadId,`store.${worker.conversationId}`);
  assert.ok(view.events.every((e:any)=>typeof e.ts==='number'));
 }finally{await f.close();}
});

test('Team messages isolate reused names by epoch and preserve fan-out and delivery identity', async () => {
 const f=await runtimeFixture();
 try{
  for(const name of ['builder','builder-two'])await f.runtime.core.execute('ensure_worker','lead',{name,scope:'Build'},f.api(),context);
  await f.runtime.core.execute('alert_send','lead',{to:'*',kind:'announcement',text:'Review the change'},f.api(),context);
  const s=await f.state(),epoch=s.team.current!.epoch,old='epoch-old';
  const a=Object.values(s.outbox.alerts)[0]!,stale={...a,id:`${old}:alert:1`};
  const current=Object.values(s.outbox.obligations),first=current[0]!;
  const obligations=[{...first,key:`${old}:alert:1:builder:g1`,epoch:old,alertId:stale.id},...current,{...first,key:`${a.id}:builder:g2`,generation:2}];
  await seed(f,async native=>{
   // Tools cannot append foreign-epoch records or a historical recipient generation to a current Alert.
   await addAlert(native,stale);await addObligation(native,obligations[0]!);await addObligation(native,obligations[3]!);
   // This legacy inline journal window contains a foreign epoch and has no tool constructor.
   native.journal.events=[{seq:1,epoch:old,actor:'builder',kind:'task_transitioned',text:'old secret'},
    {seq:2,epoch,actor:'builder',kind:'task_transitioned',taskId:'work',text:'Current evidence'}];
  });
  const view=await readPanel(f) as any;
 assert.deepEqual(view.alerts.map((a:any)=>a.id),[a.id], 'native projection must not leak another epoch');
 const messages=view.messages;
 assert.equal(messages.availability,'available');
 assert.equal(messages.source,'durable:store');
 assert.equal(messages.epoch,epoch);
 assert.deepEqual(messages.records.filter((r:any)=>r.kind==='alert').map((r:any)=>[r.id,r.from,r.to,r.status]),[[a.id,'team-lead',['builder','builder-two'],'accepted']]);
 const deliveries=messages.records.filter((r:any)=>r.kind==='delivery');
 assert.equal(deliveries.length,3, 'fan-out and a later generation remain separate obligations');
 assert.equal(new Set(deliveries.map((r:any)=>r.id)).size,3);
 assert.ok(deliveries.every((r:any)=>r.status==='accepted'));
 assert.deepEqual(messages.records.filter((r:any)=>r.kind==='lead-update').map((r:any)=>[r.from,r.to,r.text,r.status]),[['builder',['team-lead'],'Current evidence','recorded']]);
 const live=obligations[1]!;
 // Delivery receipts have no model-facing mutation tool; seed their recorded states directly.
 live.submittedAt=2000; live.submissionId=5 as never;
 await recordDelivery(f,live);
 const replay=(await readPanel(f) as any).messages.records.filter((r:any)=>r.kind==='delivery');
 assert.equal(replay.length,3,'a submission retry updates its obligation instead of inventing a message');
 assert.equal(replay.find((r:any)=>r.id===live.key).status,'submitted');
 // Current delivery code always records submittedAt; only old records can omit it.
 delete live.submittedAt;
 await recordDelivery(f,live);
 assert.equal((await readPanel(f) as any).messages.records.find((r:any)=>r.id===live.key).status,'submitted','older records with a submission ID still prove submission');
 live.state='settled';live.outcome='answered';live.settledAt=3000;
 await recordDelivery(f,live);
 const settled=(await readPanel(f) as any).messages.records.find((r:any)=>r.id===live.key);
 assert.equal(settled.status,'settled');
 assert.equal(settled.outcome,'answered');
 }finally{await f.close();}
});

test('Team messages bound each current-epoch source before filtering in the client',async()=>{
 const f=await runtimeFixture();
 try{
  await f.runtime.core.execute('ensure_worker','lead',{name:'builder',scope:'Build'},f.api(),context);
  for(let i=0;i<35;i++)await f.runtime.core.execute('alert_send','lead',{to:'builder',kind:'clarification',text:`alert ${i}`},f.api(),context);
  const s=await f.state(),epoch=s.team.current!.epoch,worker=s.team.current!.workers.builder!;
  await seed(f,async native=>{
   // Legacy keys and absent acceptedAt values cannot be produced by current tools.
   for(let i=0;i<65;i++)await addObligation(native,{key:`d${i}`,epoch,kind:'task',taskId:'work',recipient:'builder',conversationId:worker.conversationId,generation:1,state:'pending'} as Obligation);
   // Tools cannot emit a zero-based legacy journal or graph_applied.worker.
   native.journal.seq=85;
   native.journal.events=[...Array.from({length:85},(_,seq)=>({epoch,seq,actor:'builder',kind:'task_transitioned',text:`event ${seq}`})),
    {epoch,seq:85,actor:'team-lead',kind:'graph_applied',taskIds:['one','two'],worker:'builder'}];
  });
  const m=(await readPanel(f) as any).messages;
 assert.deepEqual(m.records.find((r:any)=>r.id==='85').tasks,['one','two']);
 assert.equal(m.records.find((r:any)=>r.id==='85').worker,'builder');
 assert.deepEqual(m.limits,{alerts:30,deliveries:60,events:80});
 assert.equal(m.records.filter((r:any)=>r.kind==='alert').length,30);
 assert.equal(m.records.filter((r:any)=>r.kind==='delivery').length,60);
 assert.equal(m.records.filter((r:any)=>r.kind==='lead-update').length,80);
 assert.ok(!m.records.some((r:any)=>r.text==='event 0'||r.text==='alert 0'||r.id==='d0'));
 }finally{await f.close();}
});
