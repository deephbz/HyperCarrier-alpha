// Owner-facing reads of the bound Team. Authority owns cards and update pages; this adapter only formats them.
// Never call the lead tool: an owner read cannot reserve, present, or acknowledge its observation page.
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { TeamDoc, openAuthority, taskCards, readObservationCursor, snapshotResult, updates, pageEvents, UPDATE_PAGE_EVENTS, UPDATE_SCAN_ENTRIES,
 projectGraphTaskCards, type Team, type TeamState } from '@hypercarrier/pi-team-durable/authority';
import type { CommandAck } from '../shared/protocol.ts';
import { NodeError, type NodeRuntime } from './runtime.ts';

type Thread=Awaited<ReturnType<NodeRuntime['thread']>>;
type Card=ReturnType<typeof projectGraphTaskCards>[number];
type Reply=CommandAck;
const reply=(notice:string,body?:string):Reply=>({via:'node',disposition:'handled',notice,...(body?{body}:{})});
const role=(team:Team|undefined,id:string)=>{
 if(!team)return undefined;
 if(String(team.lead)===id)return 'lead';
 const worker=Object.values(team.workers).find(w=>String(w.conversationId)===id);
 return worker?`Worker ${worker.name}`:undefined;
};
const HELP=[
 '/ptb help — Show this help',
 '/ptb status — Show the bound Team, this thread’s role, Task states, Workers and blockers',
 `/ptb sync — Show current Team updates (they stay unread for the lead): one page of at most ${UPDATE_PAGE_EVENTS} events or ${UPDATE_SCAN_ENTRIES} native entries`,
 '/ptb graph [25|50|100|200|all] — Open the Team panel with the whole graph',
 'Pi pane only: doctor, settings. Durable uses node supervision and the lead’s model-role catalog.',
].join('\n');
const taskLine=(task:Card)=>`${task.id}: ${task.title} — ${task.status} · ${task.assignee??'unassigned'}${task.state.kind==='blocked'?` · ${task.state.evidence}`:task.state.kind==='dependency_waiting'?` · waiting for ${task.state.prerequisite_task_ids.join(', ')}`:''}`;

export async function ptbCommand(runtime:NodeRuntime,thread:Thread,args:string):Promise<Reply> {
 const [command='help',...options]=args?args.split(/\s+/):[];
 // doctor and settings exist on the Pi pane only; every other unknown subcommand or option is a typo or a misuse.
 if(['doctor','settings'].includes(command)&&options.length)
  throw new NodeError('bad_args',`${args}: not on durable threads. Durable provides read-only Team commands. Use /ptb help.`);
 if(!['help','status','sync','graph','doctor','settings'].includes(command)||
  (command==='graph'?options.length>1||options.length===1&&!['25','50','100','200','all'].includes(options[0]!):options.length>0))
  throw new NodeError('bad_args',`Unknown: ${args}. Use /ptb help.`);
 const teamState=await thread.store.harness.snapshot(TeamDoc,BACKGROUND_CONTEXT) as unknown as TeamState|undefined;
 if(!role(teamState?.current,thread.conversationId))return reply('No Team is bound to this thread.');
 if(command==='help')return reply('Durable Team commands',HELP);
 if(command==='graph')return {...reply(options.length?'Opened the Team panel; it shows the whole graph':'Opened the Team panel'),panel:'team'};
 if(command==='doctor')return reply('doctor: not on durable threads. Durable runs Workers as node-owned conversations with supervised recovery.');
 if(command==='settings')return reply('settings: not on durable threads. Durable uses the lead’s model-role catalog and node configuration.');
 return thread.store.harness.commit(async tx=>{
  const s=await openAuthority(tx),team=s.team.current,who=role(team,thread.conversationId);
  if(!team||!who)return reply('No Team is bound to this thread.');
  if(s.head.epoch!==team.epoch||!s.head.graph)throw new NodeError('unavailable','The bound Team graph is unavailable; nothing changed.');
  const cards=await taskCards(s);
  const heading=`Team: ${team.name} · ${team.lifecycle}\nRole: ${who}`;
  const workers=Object.values(team.workers).map(w=>`${w.name}: ${w.state} · activity ${runtime.threads.value.threads[thread.store.threadKey(w.conversationId)]?.activity??'unknown'} · ${w.scope}`);
  if(command==='status'){
   const states=['ready','dependency_waiting','in_progress','blocked','goal_achieved','goal_failed','cancelled'];
   const counts=states.map(state=>`${state}: ${cards.filter(c=>c.status===state).length}`).join(' · ');
   const blockers=cards.filter(c=>['blocked','dependency_waiting','goal_failed'].includes(c.status)).map(taskLine);
   return reply(`Team ${team.name}: ${who}`, [heading,`Tasks: ${counts}`,'Workers:',...workers.length?workers:['None.'],'Blocked or waiting:',...blockers.length?blockers:['None.']].join('\n'));
  }
  const observation=await readObservationCursor(tx,team.epoch);
  const from=observation.acknowledged;
  const label='Owner read: updates stay unread for the lead.';
  if(from===0){
   const snapshot=await snapshotResult(s,[]);
   const tasks=snapshot.tasks as Card[];
   const alerts=snapshot.alerts as {from:string;text:string}[];
   return reply(`Team ${team.name}: owner read`,[heading,label,`No lead baseline: current snapshot (${tasks.length} Tasks, ${workers.length} Workers; at most 10 accepted Alerts).`,...tasks.map(taskLine),...workers,...alerts.map(a=>`Accepted Alert from ${a.from}: ${a.text}`)].join('\n'));
  }
  const after=observation.scanThrough;
  const page=from>=s.journal.seq?{events:[]}:await pageEvents(tx,s,from,after);
  const result=await updates(s,page.events);
  const teamChanges=result.team_changes as {text:string}[],workerChanges=result.worker_changes as {worker:string;text:string}[];
  const taskChanges=result.task_changes as {current:Card;journal_entries:{actor:string;text:string}[]}[];
  const through=page.events.at(-1)?.seq??from;
  const more=through<s.journal.seq;
  const range=page.events.length?`Updates ${page.events[0]!.seq}–${through}; ${more?'more remain':'no more'}.`:more?'No updates on this page; more remain.':'No new Team updates.';
  return reply(`Team ${team.name}: owner read`,[heading,label,range,
   ...teamChanges.map(c=>c.text),...workerChanges.map(c=>`${c.worker}: ${c.text}`),...taskChanges.flatMap(c=>[taskLine(c.current),...c.journal_entries.map(j=>`${j.actor}: ${j.text}`)]),
   ...more?['The Team panel shows current state.']:[]].join('\n'));
 },BACKGROUND_CONTEXT);
}
