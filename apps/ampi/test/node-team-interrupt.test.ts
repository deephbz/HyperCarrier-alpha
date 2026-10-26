import './bound.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { TeamDoc,open } from '@hypercarrier/pi-team-durable/authority';
import { runDaemon } from '../src/node/daemon.ts';
import { hydrate } from '../src/plugins.ts';
import { TestClient,tempHome } from './helpers.ts';

const SIM={provider:'ampi-sim',modelId:'sim-1'};
test('node interrupt port stops the captured Worker run and preserves queued owner admission',async()=>{
 const home=tempHome(),daemon=await runDaemon({home,simTokensPerSecond:1000,plugins:await hydrate()});
 const client=await TestClient.connect(daemon.socket);
 try{
  const {threadId}=await client.req('thread.create',{cwd:home,model:SIM,prompt:'/sim tool team_create {"name":"interrupt-demo","purpose":"Check host interruption"}\n/sim tool ensure_worker {"name":"builder","scope":"Build"}'});
  const leadView=client.sub({kind:'thread',threadId}),threads=client.sub({kind:'threads'});
  await client.until<any>(leadView,v=>v.entries.filter((e:any)=>e.kind==='tool-result').length>=2&&!v.live?.run,15000);
  const thread=await daemon.runtime.thread(threadId),team=await thread.store.harness.snapshot(TeamDoc,context) as any;
  const worker=team.current.workers.builder,workerId=thread.store.threadKey(worker.conversationId);
  const original=await client.req('thread.submit',{threadId:workerId,content:'/sim long 4000'});
  await client.until<any>(threads,v=>v.threads[workerId]?.activity==='streaming');
  const queued=await client.req('thread.submit',{threadId:workerId,content:'Keep this owner message',whenBusy:'followUp',requestId:'queued-owner'});
  await client.req('thread.submit',{threadId,content:'/sim tool alert_send {"to":"builder","kind":"attention","text":"Interrupt the original run","interrupt":true}'});
  await client.until<any>(leadView,v=>v.entries.filter((e:any)=>e.kind==='tool-result').length>=3&&!v.live?.run,15000);
  const old=await thread.store.harness.submission(original.submission,context),pending=await thread.store.harness.submission(queued.submission,context);
  assert.equal((await old!.wait(context)).status,'unanswered');
  assert.equal((await pending!.wait(context)).status,'done');
  const outbox=await thread.store.harness.commit(async tx=>(await open(tx)).outbox,context);
  const alert=Object.values(outbox.obligations).find((o:any)=>o.kind==='alert') as any;
  assert.equal(alert.interruption,'interrupted');
  await client.req('thread.close',{threadId});
  await assert.rejects(client.req('thread.submit',{threadId,content:'Must stay closed'}),(e:any)=>e.code==='closed');
 }finally{client.close();await daemon.stop();}
});
