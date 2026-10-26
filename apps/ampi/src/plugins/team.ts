// Node carrier ports for PTB authority. The node alone owns stop reconciliation.
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { AgentDoc, LiveDoc, type ConversationId } from '@earendil-works/pi-durable';
import type { JsonValue } from '@earendil-works/chord';
import { homedir } from 'node:os';
import { createTeamRuntime, abortExpectedRun, pendingStops, confirmStop, closing, observe, openObservations, TeamDoc, HeadDoc, openAuthority, readTeamSummary, type State, type ModelRole } from '@hypercarrier/pi-team-durable/authority';
import type { ModelRolePort } from '../node/model-roles.ts';
import { MetaDoc, NodeError, type NodePlugin, type NodeRuntime, type Store, parseThreadKey } from '../node/runtime.ts';
import { type TopicSource, topics } from '../node/server.ts';
import { teamView } from './team-view.ts';
export { teamView } from './team-view.ts';

async function state(store:Store) {
 return store.harness.commit(tx=>readTeamSummary(tx),BACKGROUND_CONTEXT);
}
const INHERIT:ModelRole={name:'default',use:'Use the lead model selected when this Worker is created',model:{provider:'inherit',modelId:'inherit'}};
const NO_ROLES:ModelRolePort={modelRoles:()=>({roles:[],invalidDefault:false,invalid:[],diagnostics:[]})};
/**
 * Each lead selects from the catalog of its own cwd, read when a command needs it. AmPi's `default` role inherits the
 * lead model and is the default unless the settings name another valid role; an invalid configured default leaves
 * no default, so ensure_worker without model_role refuses with the valid roles.
 */
export function teamPlugin(modelRoles:ModelRolePort=NO_ROLES):NodePlugin {
 let node:NodeRuntime;
 const runtime=createTeamRuntime({modelRoles:[INHERIT],defaultModelRole:'default',
  catalog:async(tx,lead)=>{
   const c=modelRoles.modelRoles((await tx.doc(AgentDoc,lead)).cwd??homedir());
   const roles=[INHERIT,...c.roles.filter(r=>r.name!=='default')];
   const defaultModelRole=c.invalidDefault?undefined:c.defaultRole&&roles.some(r=>r.name===c.defaultRole)?c.defaultRole:'default';
   return {modelRoles:roles,...(defaultModelRole?{defaultModelRole}:{})};
  },
  resolveModelRole:async(tx,role)=>{
   if(role.name!=='default')return role;
   const team=(await openAuthority(tx)).team.current!;
   const agent=await tx.doc(AgentDoc,team.lead);
   if(!agent.model)throw new Error('The lead has no configured model');
   return {...role,model:agent.model,...(agent.thinkingLevel?{thinking:agent.thinkingLevel}:{})};
  },
  observationPort:async(api,ctx)=>{
   const meta=await api.snapshot(MetaDoc,ctx);if(!meta?.store)throw new Error('PTB store binding is missing');
   const harness=node.store(meta.store).harness;return {commit:(fn,context)=>harness.commit(fn,context)};
  },
  abortRun:async(api,target,ctx)=>{
   const meta=await api.snapshot(MetaDoc,ctx);if(!meta?.store)throw new Error('PTB store binding is missing');
   const store=node.store(meta.store);
   // Do not hold the admission lock while waiting: Close must be able to cancel this delivery.
   await node.admit(store.threadKey(target.conversationId),async()=>undefined);
   return abortExpectedRun(store.harness,target,ctx);
  },
  stop:async(api,plans,ctx)=>{
   // Read the binding inside the commit: the document overlay is unusable once it settles.
   const store=await api.commit(async tx=>(await tx.doc(MetaDoc)).store,ctx);if(!store)throw new Error('PTB store binding is missing');
   return node.stop(node.store(store),plans,plugin);
  },
 });
 topics.set('team',async(topic,node)=>{
  if(topic.kind!=='team')throw new NodeError('bad_request','team topic');
  const {storeId}=parseThreadKey(topic.teamId),store=node.store(storeId);
  let current:JsonValue={team:null},disposed=false,refreshing=false,dirty=false;
  const listeners=new Set<(value:JsonValue)=>void>();
  const refresh=async()=>{
   dirty=true;if(refreshing)return;refreshing=true;
   try{while(dirty&&!disposed){dirty=false;const next=await store.harness.commit(tx=>teamView(tx,storeId),BACKGROUND_CONTEXT) as unknown as JsonValue;if(JSON.stringify(next)!==JSON.stringify(current)){current=next;for(const listener of listeners)listener(current);}}}
   finally{refreshing=false;}
  };
  const unsubscribe=store.harness.subscribeCommits(p=>{if(p.changes.some(c=>c.type==='document'&&c.record.kind.startsWith('ptb.')))void refresh();});
  await refresh();
  return {get value(){return current;},subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},dispose(){disposed=true;unsubscribe();listeners.clear();}} satisfies TopicSource;
 });
 const plugin:NodePlugin={extensions:runtime.extensions,optIn:[runtime.worker],
  attach(_store,runtime){node=runtime;},
  async internal(store,id){
   const value=await store.harness.snapshot(HeadDoc,BACKGROUND_CONTEXT);
   const log=typeof value?.value==='string'?JSON.parse(value.value).log:undefined;
   return log!==undefined&&String(log)===id;
  },
  stops:store=>pendingStops(store.harness,BACKGROUND_CONTEXT),
  confirmStop:(store,id,outcome)=>confirmStop(store.harness,id,outcome,BACKGROUND_CONTEXT),
  closing:(store,id)=>closing(store.harness,id,BACKGROUND_CONTEXT),
  touches(kind,value){if(kind!==TeamDoc.definition.kind)return [];const current=(value as State['team']|undefined)?.current;return current?[String(current.lead),...Object.values(current.workers).map(w=>String(w.conversationId))]:[];},
  async react(store,id){
   const s=await state(store);if(!s.team.current||String(s.team.current.lead)!==id)return;
   await observe(store.harness,BACKGROUND_CONTEXT);
   const live=await store.harness.snapshot(LiveDoc,Number(id) as ConversationId,BACKGROUND_CONTEXT);
   const run=live?.run?.inputs[0];if(run===undefined)return;
   for(const input of live?.run?.inputs??[]){
    const submission=await store.harness.submission(input,BACKGROUND_CONTEXT),record=await submission?.status(BACKGROUND_CONTEXT);
    if(record?.entry===undefined)continue;
    await store.harness.commit(async tx=>{const entry=await tx.entry(record.entry!);if(entry?.kind!=='pi.user')return;const o=(await openObservations(tx)).head;if(o.paused&&o.resumedOwnerRun!==run){o.paused=false;o.resumedOwnerRun=run;}},BACKGROUND_CONTEXT);
   }
  },
  async ownership(store,id){const team=(await state(store)).team.current;return team&&Object.values(team.workers).some(w=>String(w.conversationId)===id)?{thread:'Worker',owner:'lead'}:undefined;},
  async summarize(store,id,summary){
   const s=await state(store),team=s.team.current;if(!team)return;
   if(String(team.lead)===id){
    summary.team={teamId:store.threadKey(team.lead),role:'lead'};
   }else for(const w of Object.values(team.workers))if(String(w.conversationId)===id){summary.kind='worker';summary.team={teamId:store.threadKey(team.lead),role:'worker',worker:w.name};if(!summary.title||summary.title==='New thread'||summary.title.startsWith('[Team'))summary.title=w.scope;}
  },
 };
 return plugin;
}
