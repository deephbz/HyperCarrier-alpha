import './bound.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { Harness,MemoryStorage,createRegistry,type TaskId,type SubmissionId,type EntryId } from '@earendil-works/pi-durable';
import { plain,openAuthority,openObservations,observations,pageEvents,updates } from '@hypercarrier/pi-team-durable/authority';
import { createAuthorityTools,type CoreApi,flushAuthority,reserve,savePage,page,advanceAcknowledged,retireBody,startObservationEpoch } from '@hypercarrier/pi-team-durable/testing';
import { ptbCommand } from '../src/node/ptb-command.ts';
import type { NodeRuntime } from '../src/node/runtime.ts';

// The package's cursor-parity test proves the indexed cursor, page and updates against P. This test owns the owner text.
const line=(task:any)=>`${task.id}: ${task.title} — ${task.status} · ${task.assignee??'unassigned'}${task.state.kind==='blocked'?` · ${task.state.evidence}`:task.state.kind==='dependency_waiting'?` · waiting for ${task.state.prerequisite_task_ids.join(', ')}`:''}`;
for(const seed of Array.from({length:200},(_,i)=>i+1))test(`/ptb sync renders the update page as owner text and changes no observation state, seed ${seed}`,async()=>{
 const h=await Harness.open(new MemoryStorage(),{models:createModels(),registry:createRegistry(),now:()=>1000,setTimer:()=>()=>{}},context);
 try{
  const root=await h.root(context);let id=1000000;
  const core=createAuthorityTools({modelRoles:[{name:'builder',use:'Build',model:{provider:'fake',modelId:'fake'}}],defaultModelRole:'builder',stopWorker:async()=>true,createWorker:async tx=>({conversationId:(await tx.createConversation({ownership:{kind:'ownerless'}})).id,anchorId:9000000 as TaskId})});
  const call=(name:any,input:unknown)=>core.execute(name,'lead',input,{taskId:++id as TaskId,conversationId:root.id,commit:root.commit.bind(root),now:()=>1000} as CoreApi,context);
  await call('team_create',{name:'cursor-demo',purpose:'Read without consuming'});
  await call('ensure_worker',{name:'alice',scope:'Build'});
  let plan=await call('task_graph_apply',{operation_id:'plan',tasks:[{key:'sample',title:'Exact owner text',goal:'Works',assignee:'alice'}]});
  let epoch=await h.commit(async tx=>(await openAuthority(tx)).team.current!.epoch,context);
  const store={harness:h,threadKey:(n:unknown)=>`synthetic.${n}`};
  const thread={store,conversationId:String(root.id)} as unknown as Parameters<typeof ptbCommand>[1];
  const runtime={threads:{value:{threads:{}}}} as unknown as NodeRuntime;
  const seedPages=()=>h.commit(async tx=>{
   const s=await openAuthority(tx),o=await openObservations(tx);startObservationEpoch(o,epoch);
   const anchors:EntryId[]=[];
   for(let seq=1;seq<=80;seq++){
    const entry=await tx.appendEntry(root.id,{kind:'ptb.event',data:{seq,epoch,actor:'alice',kind:'task_transitioned',taskId:'sample',at:'2030-01-01T00:00:00Z',text:`Update ${seq} · 保留`}});
    anchors.push(entry.id);
   }
   s.journal.seq=80;s.journal.events=[];flushAuthority(s);
   for(let n=0;n<=12;n++)await reserve(o,{id:`${epoch}:page-${n}`,epoch,lead:root.id,run:0 as SubmissionId,from:n,through:n+1,scanThrough:anchors[(n*37)%80],carrier:{kind:'tool',callId:`page-${n}`}},{kind:'caught_up'});
   const baseline=(await page(o,`${epoch}:page-0`))!;baseline.state='acknowledged';await savePage(o,baseline);await advanceAcknowledged(o);
  },context);
  await seedPages();
  let random=seed>>>0;const next=()=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return random;};
  const order=Array.from({length:11},(_,i)=>i+2);
  for(let n=order.length-1;n>0;n--){const at=next()%(n+1);[order[n],order[at]]=[order[at],order[n]];}
  // A page beyond the gap always acknowledges first. The missing bridge arrives partway through.
  order.splice(5,0,1);
  const sequence=[...order.slice(0,6),...order];let previousEpoch:string|undefined;
  for(let step=0;step<sequence.length;step++){
   const n=sequence[step];
   if(step===6){
    previousEpoch=epoch;
    await call('task_update',{task_id:'sample',operation_id:'cancel',expected_version:(plan.tasks_by_key as any).sample.version,transition:'cancel'});
    await call('team_shutdown',{});
    await call('team_create',{name:'cursor-demo',purpose:'Read without consuming'});
    await call('ensure_worker',{name:'alice',scope:'Build'});
    plan=await call('task_graph_apply',{operation_id:'plan',tasks:[{key:'sample',title:'Exact owner text',goal:'Works',assignee:'alice'}]});
    epoch=await h.commit(async tx=>(await openAuthority(tx)).team.current!.epoch,context);
    await seedPages();
   }
   await h.commit(async tx=>{
    const o=await openObservations(tx),p=(await page(o,`${epoch}:page-${n}`))!;p.state='acknowledged';await savePage(o,p);
    if(previousEpoch&&step<12){const old=(await page(o,`${previousEpoch}:page-${order[step]}`))!;old.state='acknowledged';await savePage(o,old);}
    await advanceAcknowledged(o);
    // Body retirement must leave only the scalar anchor and retained page metadata.
    for(const retired of Object.values((await observations(tx)).pages))if(retired.state==='acknowledged'&&retired.through<=(o.head.ackByEpoch[retired.epoch]??0)&&!retired.pruned)await retireBody(o,retired);
   },context);
   const expected=await h.commit(async tx=>{
    const s=await openAuthority(tx),o=await observations(tx),from=o.acknowledged;
    const after=Object.values(o.pages).filter(p=>p.epoch===epoch&&p.state==='acknowledged'&&p.through<=from&&p.scanThrough!==undefined).sort((a,b)=>Number(b.scanThrough)-Number(a.scanThrough))[0]?.scanThrough;
    const change=from>=s.journal.seq?{events:[]}:await pageEvents(tx,s,from,after);
    const result=await updates(s,change.events),through=change.events.at(-1)?.seq??from,more=through<s.journal.seq;
    const range=change.events.length?`Updates ${change.events[0]!.seq}–${through}; ${more?'more remain':'no more'}.`:more?'No updates on this page; more remain.':'No new Team updates.';
    return {body:[`Team: cursor-demo · active`,'Role: lead','Owner read: updates stay unread for the lead.',range,
     ...(result.team_changes as any[]).map(c=>c.text),...(result.worker_changes as any[]).map(c=>`${c.worker}: ${c.text}`),...(result.task_changes as any[]).flatMap(c=>[line(c.current),...c.journal_entries.map((j:any)=>`${j.actor}: ${j.text}`)]),...more?['The Team panel shows current state.']:[]].join('\n'),head:plain((await openObservations(tx)).head)};
   },context);
   const actual=await ptbCommand(runtime,thread,'sync');
   assert.equal(actual.body,expected.body);
   assert.equal(actual.notice,'Team cursor-demo: owner read');
   assert.deepEqual(await h.commit(async tx=>plain((await openObservations(tx)).head),context),expected.head,'owner reads change no observation state');
  }
 }finally{await h.close(context);}
});
