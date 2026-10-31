import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CompactionTask, type ConversationId, defineExtension, GenerationTask, hook, type TaskId } from "@earendil-works/pi-durable";
import { runDaemon } from "../src/node/daemon.ts";
import { type NodePlugin, parseThreadKey } from "../src/node/runtime.ts";
import { hydrate } from "../src/plugins.ts";
import { RarebitDoc } from "@hypercarrier/rarebit-durable";
import { TestClient, tempHome, writePiSettings } from "./helpers.ts";

import { Type } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage as answer, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineTask, defineTool, ToolTask } from "@earendil-works/pi-durable";
import { createTeamRuntime, abortExpectedRun, open } from "@hypercarrier/pi-team-durable/authority";
import { EscDoc, MetaDoc } from "../src/node/runtime.ts";
import { teamPlugin } from "../src/plugins/team.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };
const PROMPT = "Draft the migration plan for the orders table\n/sim long 4";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * First in the plugin set: its `beforeCompact` hook runs before the HC hook, so when armed it holds a compaction
 * before either summary request (HC or native). While counting, it counts completions that reach the models.
 */
function compactionHold() {
	const state = { armed: false, counting: false, calls: 0, release: () => {} };
	let reached = () => {};
	const arm = () =>
		new Promise<void>((resolve) => {
			state.armed = true;
			reached = resolve;
		});
	const plugin: NodePlugin = {
		extensions: [
			defineExtension({
				name: "test-compaction-hold",
				hooks: [
					hook(CompactionTask, {
						async beforeCompact() {
							if (!state.armed) return undefined;
							state.armed = false;
							const released = new Promise<void>((resolve) => (state.release = resolve));
							reached();
							await released;
							return undefined;
						},
					}),
				],
			}),
		],
		attach(_store, runtime) {
			const models = runtime.models as typeof runtime.models & { counted?: boolean };
			if (models.counted) return;
			const complete = models.completeSimple.bind(models);
			Object.assign(models, {
				counted: true,
				completeSimple: (...args: Parameters<typeof complete>) => {
					if (state.counting) state.calls++;
					return complete(...args);
				},
			});
		},
	};
	return { state, arm, plugin };
}

/**
 * Holds an admitted compaction before its summary request, commits Close, and never marks (the test-only kill point
 * of crash-e holds the abort mark indefinitely), then releases the compaction.
 */
async function closeDuringCompaction(withHc: boolean) {
	const home = tempHome();
	const hold = compactionHold();
	// Without the HC extension, durable's native summary compacts; the compact plugin's settings still apply.
	const production = (await hydrate()).map((plugin) => (withHc ? plugin : { ...plugin, extensions: plugin.extensions.filter((extension) => extension.name !== "hc-compact") }));
	writePiSettings({ compaction: { keepRecentTokens: 20 } });
	const daemon = await runDaemon({ home, simTokensPerSecond: 50000, plugins: [hold.plugin, ...production] });
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: PROMPT });
		await client.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId]?.contextTokens);
		const held = hold.arm();
		const compacting = client.req("thread.compact", { threadId });
		await held;
		process.env.AMPI_FAULT = "close-intent-only";
		try {
			assert.equal((await client.req("thread.close", { threadId })).evidence, "closed");
		} finally {
			delete process.env.AMPI_FAULT;
		}
		hold.state.counting = true;
		hold.state.release();
		await sleep(300);
		assert.equal(hold.state.calls, 0, `no ${withHc ? "HC" : "native"} summary request starts after the Close commit`);
		assert.ok((await compacting)?.taskId, "the compaction was admitted");
		client.close();
	} finally {
		await daemon.stop();
		writePiSettings(undefined);
	}
}

test("Close: an admitted HC compaction held before its request starts no request after the Close commit", async () => {
	await closeDuringCompaction(true);
});

test("Close: an admitted native compaction held before its request starts no request after the Close commit", async () => {
	await closeDuringCompaction(false);
});

/**
 * Holds each armed generation in `beforeRequest`, after its admission and before its stream, until `release`; counts
 * the run streams that reach the models while counting.
 */
function generationHold() {
	const held: (() => void)[] = [];
	const state = { armed: false, counting: false, streams: 0, release: () => held.splice(0).forEach((resume) => resume()) };
	let reached = () => {};
	const arm = () =>
		new Promise<void>((resolve) => {
			state.armed = true;
			reached = resolve;
		});
	const plugin: NodePlugin = {
		extensions: [
			defineExtension({
				name: "test-generation-hold",
				hooks: [
					hook(GenerationTask, {
						async beforeRequest() {
							if (!state.armed) return undefined;
							state.armed = false;
							const released = new Promise<void>((resolve) => held.push(resolve));
							reached();
							await released;
							return undefined;
						},
					}),
				],
			}),
		],
		attach(_store, runtime) {
			const models = runtime.models as typeof runtime.models & { streamed?: boolean };
			if (models.streamed) return;
			const stream = models.streamSimple.bind(models);
			Object.assign(models, {
				streamed: true,
				streamSimple: (...args: Parameters<typeof stream>) => {
					// A thread's run names its provider session; a plugin completion streams without one.
					if (state.counting && args[2]?.sessionId) state.streams++;
					return stream(...args);
				},
			});
		},
	};
	return { state, arm, plugin };
}

test("Close: admitted generations of the thread and of a conversation it owns, held before their streams, start none after the Close commit; an open thread still answers", async () => {
	const home = tempHome();
	const hold = generationHold();
	const daemon = await runDaemon({ home, simTokensPerSecond: 50000, plugins: [...(await hydrate()), hold.plugin] });
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		const held = hold.arm();
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: PROMPT });
		await held;
		// A subagent: a conversation owned by the held run's task, with its own held run.
		const { store, conversationId } = await daemon.runtime.thread(threadId);
		const inspection = await store.harness.inspect(BACKGROUND_CONTEXT);
		const generation = inspection.tasks.find((t) => String(t.record.conversationId) === conversationId && t.record.state.status !== "terminal");
		assert.ok(generation, "the held run has a live task");
		const owned = await store.harness.commit((tx) => tx.createConversation({ ownership: { kind: "task", taskId: generation.record.id as TaskId } }), BACKGROUND_CONTEXT);
		const ownedHeld = hold.arm();
		await client.req("thread.submit", { threadId: store.threadKey(owned.id), content: PROMPT });
		await ownedHeld;
		process.env.AMPI_FAULT = "close-intent-only";
		try {
			assert.equal((await client.req("thread.close", { threadId })).evidence, "closed");
		} finally {
			delete process.env.AMPI_FAULT;
		}
		hold.state.counting = true;
		hold.state.release();
		await sleep(300);
		assert.equal(hold.state.streams, 0, "no generation stream of the thread or its subagent starts after the Close commit");

		// Control: an open thread's generation streams and answers through the same gate.
		const open = await client.req("thread.create", { cwd: home, model: SIM, prompt: "Name three rollback risks" });
		const answered = await client.until<any>(threads, (v) => v.threads[open.threadId]?.activity === "idle" && /rollback|risk/i.test(v.threads[open.threadId]?.preview ?? "") && v.threads[open.threadId]?.contextTokens);
		assert.equal(answered.threads[open.threadId].lastError, undefined);
		assert.ok(hold.state.streams > 0, "the open thread's generation streamed");
		client.close();
	} finally {
		await daemon.stop();
	}
});

test("a failed Close commit: the stream it held starts after the failure and the run answers, never aborted", async () => {
	const home = tempHome();
	const hold = generationHold();
	const daemon = await runDaemon({ home, simTokensPerSecond: 50000, plugins: [...(await hydrate()), hold.plugin] });
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		const held = hold.arm();
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "Name three rollback risks" });
		await held;
		const { store, conversationId } = await daemon.runtime.thread(threadId);
		// The Close commit releases the run, so its stream reaches the gate while Close is in progress, then fails.
		// Other commits share the store (Team state, the thread record), so the fault picks Close's commit by its
		// write: the one commit that marks this conversation closed. It rolls that commit back; every other passes.
		const commit = store.harness.commit.bind(store.harness);
		const closing = Symbol("Close commit");
		let heldAtCommit: number | undefined;
		store.harness.commit = (async (work: Parameters<typeof commit>[0], context: Parameters<typeof commit>[1]) => {
			try {
				return await commit(async (tx) => {
					const result = await work(tx);
					if ((await tx.doc(MetaDoc)).convs[conversationId]?.closed) throw closing;
					return result;
				}, context);
			} catch (error) {
				if (error !== closing) throw error;
				store.harness.commit = commit;
				hold.state.counting = true;
				hold.state.release();
				await sleep(300);
				heldAtCommit = hold.state.streams;
				throw new Error("injected Close commit failure");
			}
		}) as typeof store.harness.commit;
		// A commit that runs before Close's commit passes through and leaves the fault for Close.
		await store.harness.commit(async () => undefined, BACKGROUND_CONTEXT);
		await assert.rejects(client.req("thread.close", { threadId }), /injected Close commit failure/);
		assert.equal(heldAtCommit, 0, "the stream waits while Close is in progress");
		const done = await client.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && /rollback|risk/i.test(v.threads[threadId]?.preview ?? ""));
		const row = done.threads[threadId];
		assert.equal(row.closed, undefined, "the thread stays open");
		assert.equal(row.lastError, undefined, "the run committed no aborted answer");
		assert.equal(hold.state.streams, 1, "the held stream started once after the failure");
		client.close();
	} finally {
		await daemon.stop();
	}
});

test("a provider stream that throws behind the gate ends the run with an error answer, never a hang", async () => {
	const home = tempHome();
	let fail = true;
	const plugin: NodePlugin = {
		extensions: [],
		attach(_store, runtime) {
			const models = runtime.models as typeof runtime.models & { throwing?: boolean };
			if (models.throwing) return;
			const stream = models.streamSimple.bind(models);
			Object.assign(models, {
				throwing: true,
				streamSimple: (...args: Parameters<typeof stream>) => {
					if (fail && args[2]?.sessionId) {
						fail = false;
						throw new Error("injected provider failure");
					}
					return stream(...args);
				},
			});
		},
	};
	const daemon = await runDaemon({ home, simTokensPerSecond: 50000, plugins: [...(await hydrate()), plugin] });
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "Name three rollback risks" });
		const done = await client.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId]?.lastError, 5000);
		assert.match(String(done.threads[threadId].lastError), /injected provider failure/);
		client.close();
	} finally {
		await daemon.stop();
	}
});

test("a stop that aborts a running Title on an open thread does not block the next Title", async () => {
	const home = tempHome();
	// While holding, every plugin completion waits for its abort, so the Title job is in flight when the stop lands.
	const hold = { on: true, entered: 0 };
	const fence: NodePlugin = {
		extensions: [],
		attach(_store, runtime) {
			const models = runtime.models as typeof runtime.models & { held?: boolean };
			if (models.held) return;
			const complete = models.completeSimple.bind(models);
			Object.assign(models, {
				held: true,
				completeSimple: async (...args: Parameters<typeof complete>) => {
					const signal = args[2]?.signal;
					if (hold.on && signal) {
						hold.entered++;
						await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
						throw signal.reason;
					}
					return complete(...args);
				},
			});
		},
		stops: () => [],
		confirmStop: () => {},
	};
	const daemon = await runDaemon({ home, simTokensPerSecond: 50000, plugins: [...(await hydrate()), fence] });
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: PROMPT });
		const { storeId, conversationId } = parseThreadKey(threadId);
		const store = daemon.runtime.store(storeId);
		const rarebit = () => store.harness.snapshot(RarebitDoc, Number(conversationId) as ConversationId, BACKGROUND_CONTEXT);
		for (const deadline = Date.now() + 5000; hold.entered === 0; await sleep(20))
			assert.ok(Date.now() < deadline, "the Title job starts");
		hold.on = false;
		const [outcome] = await daemon.runtime.stop(store, [{ id: "test-fence", conversations: [conversationId] }], fence);
		assert.equal(outcome?.status, "settled");
		const view = client.sub({ kind: "rarebit", threadId });
		await client.until<any>(view, v => Boolean(v.state.title), 5000);
		const done = await client.until<any>(threads, v => Boolean(v.threads[threadId]), 5000);
		assert.equal(done.threads[threadId].closed, undefined, "the thread stays open");
		assert.ok((await rarebit())?.title, "the redone Title stored its receipt");
		client.close();
	} finally {
		await daemon.stop();
	}
});

/**
 * While `on`, holds each plugin completion past its abort until `release`, then settles it with a stub answer that
 * never reaches the model: a provider result that arrives late. Counts completions that reach the model.
 */
function lateSettle() {
	const held: (() => void)[] = [];
	const state = { on: true, calls: 0, entered: 0, release: () => held.splice(0).forEach((resume) => resume()) };
	const plugin: NodePlugin = {
		extensions: [],
		attach(_store, runtime) {
			const models = runtime.models as typeof runtime.models & { late?: boolean };
			if (models.late) return;
			const complete = models.completeSimple.bind(models);
			Object.assign(models, {
				late: true,
				completeSimple: async (...args: Parameters<typeof complete>) => {
					if (state.on && args[2]?.signal) {
						state.entered++;
						await new Promise<void>((resolve) => held.push(resolve));
						const [model] = args;
						return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
					}
					state.calls++;
					return complete(...args);
				},
			});
		},
		stops: () => [],
		confirmStop: () => {},
	};
	return { state, plugin };
}

async function withLateTitle(run: (args: { daemon: Awaited<ReturnType<typeof runDaemon>>; client: TestClient; threads: number; threadId: string; conversationId: string; hold: ReturnType<typeof lateSettle> }) => Promise<void>) {
	const home = tempHome();
	const hold = lateSettle();
	const daemon = await runDaemon({ home, simTokensPerSecond: 50000, plugins: [...(await hydrate()), hold.plugin] });
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: PROMPT });
		const { storeId, conversationId } = parseThreadKey(threadId);
		const store = daemon.runtime.store(storeId);
		for (let deadline = Date.now() + 5000; hold.state.entered === 0; await sleep(20))
			assert.ok(Date.now() < deadline, "the Title job starts");
		hold.state.on = false;
		await run({ daemon, client, threads, threadId, conversationId, hold });
		client.close();
	} finally {
		hold.state.release();
		await daemon.stop();
	}
}

test("an aborted Title that settles after the fence lift is redone without other activity", async () => {
	await withLateTitle(async ({ daemon, client, threads, threadId, conversationId, hold }) => {
		const store = daemon.runtime.store(parseThreadKey(threadId).storeId);
		const [outcome] = await daemon.runtime.stop(store, [{ id: "test-fence", conversations: [conversationId] }], hold.plugin);
		assert.equal(outcome?.status, "settled");
		// The lift's refresh runs while the aborted job still awaits its provider result.
		await sleep(300);
		hold.state.release();
		const view = client.sub({ kind: "rarebit", threadId });
		await client.until<any>(view, v => Boolean(v.state.title), 5000);
		const done = await client.until<any>(threads, v => Boolean(v.threads[threadId]), 5000);
		assert.equal(done.threads[threadId].closed, undefined, "the thread stays open");
	});
});

test("an aborted Title that settles after Close schedules no model call", async () => {
	await withLateTitle(async ({ client, threadId, hold }) => {
		assert.equal((await client.req("thread.close", { threadId })).evidence, "closed");
		await sleep(300);
		hold.state.calls = 0;
		hold.state.release();
		await sleep(500);
		assert.equal(hold.state.calls, 0, "no model call after the late result");
	});
});

// Hold a busy Worker response across the owner boundary, then count actual tool execution.
const context = BACKGROUND_CONTEXT;
const latch=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
const bounded=async<T>(promise:Promise<T>,label:string)=>{let timer: ReturnType<typeof setTimeout> | undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(`matrix deadline: ${label}`)),5000);})]);}finally{clearTimeout(timer);}};
const cases = [['interrupt','before-abort'],['ordinary','after-check'],['replay','settle']] as const;
for(const boundary of ['close','stop'] as const)for(const [kind,stage] of cases)test(`tool owner guard: ${boundary}/${kind}/${stage}`,{timeout:15000},async()=>{
 const go=latch(),busyStarted=latch(),releaseBusy=latch(),fenced=latch(),attempted=latch(),finished=latch(),releaseMarks=latch(),markEntered=latch();
 let daemon:any,client:any,thread:any,leadId='',targetId='',worker:any,node:any,doneFence=false,modelAfterFence=0,toolAfterFence=0,stopPromise:Promise<unknown>|undefined;
 let heldInspect=false,actualInspect:any,originalAdmission:number|undefined,replayAdmission:number|undefined;
 const fence=async()=>{
  if(doneFence)return;
  if(boundary==='close'){
   process.env.AMPI_FAULT='close-intent-only';await node.closeThread(leadId);delete process.env.AMPI_FAULT;
   doneFence=true;
  }else{
   const intent={id:'matrix-stop',conversations:[String(worker.conversationId)]};
   await thread.store.harness.commit(async(tx:any)=>{(await tx.doc(EscDoc)).intents[intent.id]=intent;},context);
   const h=thread.store.harness;actualInspect=h.inspect.bind(h);heldInspect=true;
   h.inspect=async(c:any)=>{if(heldInspect){heldInspect=false;markEntered.resolve();await releaseMarks.promise;}return actualInspect(c);};
   const confirmer={confirmStop:async(store:any,id:string)=>store.harness.commit(async(tx:any)=>{delete (await tx.doc(EscDoc)).intents[id];},context)};
   stopPromise=node.stop(thread.store,[intent],confirmer);await markEntered.promise;doneFence=true;
   await assert.rejects(node.admit(targetId,async()=>undefined),(e:any)=>e.code==='stopped');
  }
  fenced.resolve();
 };
 const proxyRuntime=(runtime:any,phase:string,taskKind:string)=>new Proxy(runtime,{get(target,key){
  if(key==='conversation')return async(...args:any[])=>{
   const conversation=await target.conversation(...args);if(!conversation)return conversation;
   return new Proxy(conversation,{get(c,k){if(k==='submit')return async(draft:any,ctx:any)=>{
    const selected=taskKind==='ptb.deliver';
    if(selected&&((stage==='after-check'&&phase==='submit')||(stage==='settle'&&phase==='settle'))){await go.promise;await fence();}
    const result=await c.submit(draft,ctx);
    if(selected){if(phase==='submit')originalAdmission=result.id;else if(phase==='settle')replayAdmission=result.id;if(doneFence){attempted.resolve();}}
    return result;
   };const v=Reflect.get(c,k,c);return typeof v==='function'?v.bind(c):v;}});
  };
  const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;
 }});
 const runtime=createTeamRuntime({modelRoles:[{name:'builder',use:'Build',model:{provider:'ampi-sim',modelId:'sim-1'}}],defaultModelRole:'builder',
  observationPort:async()=>({commit:(fn:any,c:any)=>thread.store.harness.commit(fn,c)}),stop:async()=>[],
  abortRun:async(_api:any,target:any,c:any)=>{await go.promise;if(stage==='before-abort')await fence();await node.admit(thread.store.threadKey(target.conversationId),async()=>undefined);return abortExpectedRun(thread.store.harness,target,c);}});
 const plugin=teamPlugin(),attach=plugin.attach!.bind(plugin);
 plugin.attach=(store:any,n:any)=>{node=n;attach(store,n);};
 plugin.extensions=runtime.extensions.map((extension:any)=>extension.name!=='ptb.mechanics'?extension:{...extension,tasks:extension.tasks.map((token:any)=>{
  if(token.definition.name!=='ptb.deliver')return token;
  const phases=Object.fromEntries(Object.entries(token.definition.phases).map(([name,fn]:any)=>[name,async(task:any,r:any,c:any)=>{return fn(task,proxyRuntime(r,name,token.definition.name),c);} ]));
  return defineTask({...token.definition,phases});
 })});
 plugin.optIn=[runtime.worker];
 const probe=defineTool({name:'matrix_probe',description:'Synthetic fence probe',parameters:Type.Object({}),execute:async()=>{if(doneFence)toolAfterFence++;return {output:[{type:'text',text:'probe'}]};}});
 try{
  const home=tempHome();daemon=await runDaemon({home,plugins:[plugin,{extensions:[{name:'matrix.probe',tools:[probe]}]}]});
  const faux=fauxProvider({provider:'ampi-sim',api:'ampi-sim',models:[{id:'sim-1'}],tokensPerSecond:0});daemon.runtime.models.setProvider(faux.provider);
  let started=false;
  faux.setResponses(Array.from({length:50},()=>async(messages:any,options:any)=>{
   if(doneFence)modelAfterFence++;
   if(!started&&JSON.stringify(messages).includes('matrix busy')){started=true;busyStarted.resolve();options?.signal?.addEventListener('abort',releaseBusy.resolve,{once:true});await releaseBusy.promise;return options?.signal?.aborted?answer([],{stopReason:'aborted'}):answer(fauxToolCall('matrix_probe',{}),{stopReason:'toolUse'});}
   return answer('Synthetic response');
  }));
  client=await TestClient.connect(daemon.socket);const created=await client.req('thread.create',{cwd:home,model:{provider:'ampi-sim',modelId:'sim-1'}});leadId=created.threadId;
  thread=await node.thread(leadId);let serial=9000000;const api=()=>({taskId:++serial,conversationId:thread.conversation.id,commit:thread.store.harness.commit.bind(thread.store.harness),now:Date.now});
  await runtime.core.execute('team_create','lead',{name:'matrix',purpose:'Admission boundary'},api() as any,context);
  await runtime.core.execute('ensure_worker','lead',{name:'builder',scope:'Build'},api() as any,context);
  worker=await thread.store.harness.commit(async(tx:any)=>JSON.parse(JSON.stringify((await open(tx)).team.current!.workers.builder)),context);
  targetId=thread.store.threadKey(worker.conversationId);
  const target=(await node.thread(targetId)).conversation;
  thread.store.harness.subscribeCommits((p:any)=>{
   for(const c of p.changes)
    if(c.type==='task'&&doneFence&&c.value.kind==='ptb.deliver'&&
      (['terminal','sleeping','waiting'].includes(c.value.state.status)||c.value.state.checkpoint?.phase==='settle'))
     finished.resolve();
  });
  await target.submit({type:'input',content:'matrix busy'},context);await bounded(busyStarted.promise,'busy provider');
  await runtime.core.execute('alert_send','lead',{to:'builder',kind:'attention',text:'Matrix Alert',...(kind==='interrupt'?{interrupt:true}:{})},api() as any,context);
  go.resolve();thread.store.harness.resume();await bounded(fenced.promise,'fence');await bounded(Promise.race([attempted.promise,finished.promise]),'delivery outcome');
  releaseBusy.resolve();await new Promise(r=>setTimeout(r,100));
  const record={boundary,kind,stage,replayStable:kind==='replay'?originalAdmission===replayAdmission:null,modelAfterFence,toolAfterFence};console.log(JSON.stringify(record));
  assert.equal(modelAfterFence,0);assert.equal(toolAfterFence,0);if(kind==='replay')assert.equal(originalAdmission,replayAdmission);
  // A distinct open thread must still reach the real tool body through this guard.
  const beforeControl=toolAfterFence;
  faux.setResponses([answer(fauxToolCall('matrix_probe',{}),{stopReason:'toolUse'}),answer('Control finished')]);
  const control=await client.req('thread.create',{cwd:home,model:{provider:'ampi-sim',modelId:'sim-1'},prompt:'Unrelated control'});
  await client.until(client.sub({kind:'threads'}),(v:any)=>v.threads[control.threadId]?.activity==='idle');
  assert.equal(toolAfterFence,beforeControl+1,'an unrelated thread still executes tools');
  // Native input admission is a separate boundary; this regression asserts execution only.
 }finally{
  delete process.env.AMPI_FAULT;go.resolve();releaseBusy.resolve();releaseMarks.resolve();if(stopPromise)await stopPromise.catch(()=>{});
  if(thread&&actualInspect)thread.store.harness.inspect=actualInspect;
  client?.close();await daemon?.stop();
 }
});

for (const nested of [false, true]) test(`tool owner guard window: ${nested ? "nested executeTool" : "direct tool"} after a later hook`, async () => {
	const home = tempHome();
	const held = latch(), release = latch(), settled = latch(), sweepAfterLeaf = latch();
	let executions = 0, ownerClosed = false, holdArmed = false, controlExecutions = 0;
	let leafResult: unknown;
	const leaf = defineTool({
		name: "window_leaf", description: "Count actual tool execution", parameters: Type.Object({}),
		execute: async () => {
			if (holdArmed) {
				assert.equal(ownerClosed, true, "the owner Close precedes the leaf body");
				executions++;
			} else controlExecutions++;
			return { output: [{ type: "text", text: "leaf executed" }] };
		},
	});
	const outer = defineTool({
		name: "window_outer", description: "Call a nested tool", parameters: Type.Object({}),
		execute: async (_args, api, ctx) => {
			await api.executeTool("window_leaf", {}, ctx);
			return { output: [{ type: "text", text: "outer finished" }] };
		},
	});
	// NodeRuntime installs nodeGuard before plugin hooks. This latch is after its check.
	const later = defineExtension({
		name: "window.later-hook", tools: [leaf, outer],
		hooks: [hook(ToolTask, {
			beforeTool: async (call) => {
				if (holdArmed && call.name === "window_leaf") {
					held.resolve();
					await release.promise;
				}
				return undefined;
			},
			afterTool: async (call, result) => {
				if (holdArmed && call.name === "window_leaf") {
					leafResult = { output: result.output, isError: result.isError, diagnostics: result.diagnostics };
					settled.resolve();
				}
				return undefined;
			},
		})],
	});
	const daemon = await runDaemon({ home, simTokensPerSecond: 1e9, plugins: [teamPlugin(), { extensions: [later] }] });
	const client = await TestClient.connect(daemon.socket);
	try {
		const { threadId } = await client.req("thread.create", {
			cwd: home, model: SIM,
			prompt: '/sim tool team_create {"name":"window","purpose":"Check tool dispatch"}\n/sim tool ensure_worker {"name":"builder","scope":"Build"}',
		});
		const lead = await daemon.runtime.thread(threadId);
		const threads = client.sub({ kind: "threads" });
		await client.until<any>(threads, v => Object.keys(v.threads).length === 2 && Object.values(v.threads).every((t: any) => t.activity === "idle"));
		const worker = await lead.store.harness.commit(async tx => {
			const team = await open(tx);
			return JSON.parse(JSON.stringify(team.team.current!.workers.builder));
		}, BACKGROUND_CONTEXT);
		for (const target of [threadId, lead.store.threadKey(worker.conversationId!)]) {
			const before = controlExecutions;
			await client.req("thread.submit", { threadId: target, content: "/sim tool window_leaf {}" });
			await client.until<any>(threads, v => controlExecutions === before + 1 && v.threads[target]?.activity === "idle");
		}
		assert.equal(controlExecutions, 2, "a root and a Worker with a live owner execute tools");
		holdArmed = true;
		// Close's commit schedules a refresh at once, and its sweep marks the closed chain. That stop aborts the held
		// tool before the hook releases, so the execute check never runs. The window under test is the time before any
		// stop marks: every inspection after Close's commit, as the sweep and the refresh make, waits until the leaf
		// settles. Close inspects before its commit, so Close itself does not wait.
		const inspect = lead.store.harness.inspect.bind(lead.store.harness);
		lead.store.harness.inspect = (async (context: Parameters<typeof inspect>[0]) => {
			if ((await lead.store.harness.snapshot(MetaDoc, BACKGROUND_CONTEXT))?.convs[lead.conversationId]?.closed) await sweepAfterLeaf.promise;
			return inspect(context);
		}) as typeof inspect;
		await client.req("thread.submit", {
			threadId: lead.store.threadKey(worker.conversationId!),
			content: `/sim tool ${nested ? "window_outer" : "window_leaf"} {}`,
		});
		await bounded(held.promise, "later beforeTool hook");
		process.env.AMPI_FAULT = "close-intent-only";
		try {
			await client.req("thread.close", { threadId });
			ownerClosed = true;
		} finally {
			delete process.env.AMPI_FAULT;
		}
		release.resolve();
		let settledBeforeDeadline = true;
		try { await bounded(settled.promise, "leaf afterTool"); }
		catch { settledBeforeDeadline = false; }
		sweepAfterLeaf.resolve();
		lead.store.harness.inspect = inspect;
		console.log(JSON.stringify({ window: nested ? "nested" : "direct", executionsAfterOwnerClose: executions, controlExecutions, settledBeforeDeadline }));
		if (!settledBeforeDeadline) {
			const inspection = await lead.store.harness.inspect(BACKGROUND_CONTEXT);
			console.log(JSON.stringify({ tasks: inspection.tasks.map(t => ({ kind: t.record.kind, state: t.record.state })) }));
		}
		assert.equal(settledBeforeDeadline, true, "leaf settles after releasing the later hook");
		assert.equal(executions, 0, "no tool body starts after its owner Close");
		assert.deepEqual(leafResult, {
			output: [], isError: true,
			diagnostics: [{ severity: "error", code: "blocked", message: "Tool call blocked: This thread is closed." }],
		}, "the execute refusal has the same model-facing shape as beforeTool's block");
	} finally {
		delete process.env.AMPI_FAULT;
		release.resolve();
		sweepAfterLeaf.resolve();
		client.close();
		await daemon.stop();
	}
});
