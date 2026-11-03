import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArcReplica } from "../src/hub/arc-replica.ts";
import { createBuilder, fingerprint } from "../src/arc/core/index.ts";
import { Hub } from "../src/hub/hub.ts";
import { Browser } from "./helpers.ts";
import type { ArcCommand, ArcFrame } from "../src/arc/link.ts";
import { serviceRelay } from "../src/arc/service/relay.ts";
import { serviceStatus } from "../src/arc/service/status.ts";
import { answer, cite, point, setup, waitFor } from "./arc-v2-fixture.ts";
import { arcValue } from "../src/pi/views/arc.ts";
import type { PiViewContext, PiViewSession } from "../src/pi/views/types.ts";
import { controlRequest } from "../src/arc/service/connection.ts";
import { maintainHost } from "../src/arc/service/client.ts";
// @ts-expect-error Build script runs as native ESM.
import { buildArcService } from "../scripts/build-arc-service.mjs";

const stamp = { id: "engine-a", order: 1, line: null };
const hello = (generation = "one", extra = {}): Extract<ArcFrame, { t: "arc.hello" }> => ({ t: "arc.hello", stamp, generation, service: serviceStatus("remote", { stamp, state: "running", running: true, serviceVersion: "engine-a", releaseLine: null, ...extra }), expected: stamp });
const status = (seq: number, state = "building", generation = "one"): Extract<ArcFrame, { t: "arc.status" }> => ({ t: "arc.status", generation, seq, service: hello().service, scheduled: [], statuses: [{ sessionRef: "pi:s", buildId: "b", state: state as "building", elapsedMs: seq * 1000 }] });
function replica(t: any) {
 const dir = mkdtempSync(join(tmpdir(), "arc-link-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const sent: ArcCommand[] = [], options = { dir: join(dir, "arc-replica"), host: "remote", requester: "hub", send: (c: ArcCommand) => { sent.push(c); return true; }, changed() {}, timeoutMs: 100 };
 const r = new ArcReplica(options); t.after(() => r.disconnect()); return { r, options, dir, sent };
}

test("Arc replica: equal status heartbeat is quiet; changed status still invalidates", t => {
 const { r, options } = replica(t);
 let changes = 0; options.changed = () => { changes++; };
 r.receive(hello());
 const frame = { ...status(1), statuses: [] };
 r.receive(frame); const initial = changes;
 r.receive({ ...structuredClone(frame), seq: 2 });
 console.log("heartbeat trace", JSON.stringify({ seq: [1, 2], initial, afterEqual: changes }));
 assert.equal(changes, initial, "equal heartbeat must not invalidate the Arc view");
 r.receive({ ...frame, seq: 3, statuses: status(3).statuses });
 assert.equal(changes, initial + 1, "a real Build status change invalidates the Arc view");
 assert.equal(r.value("pi:s").status.state, "building");
 r.receive({ ...frame, seq: 2, statuses: status(2, "failed").statuses });
 assert.equal(r.value("pi:s").status.state, "building", "a quiet heartbeat still advances the sequence fence");
});

test("Arc replica: post-Build idle heartbeats stay quiet as wall time advances", async t => {
 const { r, options } = replica(t);
 let wall = "2026-01-01T00:00:00Z", mono = 0, changes = 0;
 options.changed = () => { changes++; };
 const items = [{ id: "u1", kind: "user" as const, owner: true, text: "Synthetic evidence u1.", t: wall }];
 const builder = createBuilder({
  now: () => wall, monotonic: () => mono, store: { load: () => undefined, save() {} }, settings: () => ({ model: "fixture/model", retries: 0 }),
  source: { snapshot: async session => ({ session, sourceVersion: "one", selector: "fixture", fingerprint: fingerprint(items), items, entries: [{ id: "u1", at: wall, tokens: 10, cost: 0 }] }), check: async () => ({ kind: "same-prefix" }) },
  admission: { acquire: async () => ({ kind: "permit", permit: { id: "slot" } }), release: async () => {} },
  model: { reconcile: async () => "gone", call: async () => { mono += 250; return { kind: "answer", answer: { model: "fixture/model", text: JSON.stringify(answer()) } }; } },
 });
 await builder.request("pi:s", "request", "manual", "hub"); await builder.run();
 const idle = builder.status();
 assert.equal(idle[0]!.state, "idle", "the status is retained after a real Build");
 assert.equal(idle[0]!.elapsedMs, 250);
 r.receive(hello()); r.receive({ ...status(1), statuses: idle });
 const initial = changes;
 wall = "2026-01-01T01:00:00Z"; mono += 3_600_000;
 r.receive({ ...status(2), statuses: builder.status() });
 assert.equal(changes, initial, "an unchanged completed Build must not invalidate the replica on a heartbeat");
 assert.deepEqual(r.value("pi:s").status.elapsedMs, 250, "completed elapsed time remains frozen");
});

test("Arc relay: close drains an in-flight ensure before its caller exits", async () => {
 let release!: (value: ReturnType<typeof serviceStatus>) => void;
 let ensured = false, controls = 0;
 const held = new Promise<ReturnType<typeof serviceStatus>>(resolve => { release = resolve; });
 const relay = serviceRelay({ host: "remote", known: {}, stamp, emit() {}, ensure: () => held, control: async () => { controls++; return {}; } });
 const close = Promise.resolve(relay.close()).then(() => { ensured = true; });
 await new Promise(resolve => setImmediate(resolve));
 const closedEarly = ensured;
 release(serviceStatus("remote", { running: true, state: "running", stamp }));
 await close;
 assert.equal(closedEarly, false, "close cannot leave an unresolved launcher ensure behind");
 assert.equal(controls, 0, "closed relay must not start another control call");
});

test("Arc relay: replacement races and control failures cannot settle pending IDs", async () => {
 const frames: ArcFrame[] = [];
 let reply: unknown = { outcome: "refused", code: "build-mismatch", detail: "Synthetic replacement race" };
 const relay = serviceRelay({ host: "remote", known: {}, stamp, emit: f => frames.push(f), ensure: async () => serviceStatus("remote", {state:"stopped"}), control: async () => reply });
 try {
  const command: ArcCommand = {t:"arc.request",requestId:"pending",sessionRef:"pi:s",kind:"manual",requester:"hub"};
  await relay.command(command);
  assert.deepEqual(frames.findLast(f => f.t === "arc.ack"), {t:"arc.ack",requestId:"pending",result:{outcome:"refused",code:"service",transient:true,detail:"Synthetic replacement race"}});
  reply = {error:"Synthetic failed save"}; await relay.command(command);
  assert.deepEqual(frames.findLast(f => f.t === "arc.ack"), {t:"arc.ack",requestId:"pending",result:{outcome:"unknown"}});
 } finally { relay.close(); }
});

test("Arc replica: crash replay keeps the exact owner ID and payload; acceptance and status never regress", async t => {
 const { r, options, sent } = replica(t);
 assert.deepEqual(await r.build("pi:s", "offline"), { outcome: "refused", code: "service", detail: "The Arc service cannot accept commands now." }); assert.equal(sent.length, 0);
 r.receive(hello());
 const first = r.build("pi:s", "owner-1");
 assert.equal(sent.length, 1); const command = sent[0]!;
 r.disconnect(); assert.equal((await first).outcome, "unknown");
 const restarted = new ArcReplica(options); t.after(() => restarted.disconnect());
 restarted.receive(hello("two")); assert.deepEqual(sent.at(-1), command);
 restarted.receive({ t: "arc.ack", requestId: "owner-1", result: { outcome: "accepted", buildId: "b" } });
 restarted.receive({ t: "arc.ack", requestId: "owner-1", result: { outcome: "unknown" } });
 assert.equal(restarted.value("pi:s").request?.outcome, "accepted");
 const later = restarted.build("pi:s", "owner-2");
 restarted.receive({ t: "arc.ack", requestId: "owner-1", result: { outcome: "accepted", buildId: "b" } });
 assert.equal(restarted.value("pi:s").request?.requestId, "owner-2"); assert.equal(restarted.value("pi:s").request?.outcome, "unknown");
 restarted.receive(status(2, "building", "two")); restarted.receive(hello("two")); restarted.receive(status(1, "idle", "two")); restarted.receive(status(99, "idle", "one"));
 assert.equal(restarted.value("pi:s").status.state, "building"); assert.equal(restarted.value("pi:s").status.elapsedMs, 2000);
 restarted.disconnect(); await later;
 assert.equal(restarted.value("pi:s").status.state, "building"); assert.equal(restarted.value("pi:s").statusStale, true);
 const third = new ArcReplica(options); t.after(() => third.disconnect()); third.receive(hello("three"));
 assert.equal(sent.filter(c => c.requestId === "owner-1").length, 2, "a committed ack is not resent after restart");
 assert.deepEqual(sent.at(-1), { ...command, requestId: "owner-2" });
});

test("Arc replica: transient refusals preserve Build and Dismiss outboxes across restart", async t => {
 const { r, options, sent } = replica(t); r.receive(hello());
 const build = r.build("pi:s", "draining-build"), dismiss = r.dismiss("pi:s", "drop", 4);
 const commands = sent.slice();
 for (const command of commands) r.receive({ t: "arc.ack", requestId: command.requestId, result: { outcome: "refused", code: "service", transient: true } });
 assert.deepEqual(await build, { outcome: "unknown", requestId: "draining-build", waitFor: "service" }); await dismiss;
 assert.deepEqual(r.value("pi:s").request, { outcome: "unknown", requestId: "draining-build", waitFor: "service" });
 r.disconnect();
 assert.deepEqual(r.value("pi:s").request, { outcome: "unknown", requestId: "draining-build" }, "link loss replaces the transient service wait");
 const restarted = new ArcReplica(options); t.after(() => restarted.disconnect()); restarted.receive(hello("new-service"));
 assert.deepEqual(sent.slice(-2), commands);
 restarted.receive({ t: "arc.ack", requestId: commands[0]!.requestId, result: { outcome: "accepted", buildId: "original" } });
 restarted.receive({ t: "arc.ack", requestId: commands[1]!.requestId, result: { outcome: "dismissed", revision: 2 } });
 assert.equal(restarted.value("pi:s").request?.outcome, "accepted");
 restarted.disconnect();
 const third = new ArcReplica(options); t.after(() => third.disconnect()); third.receive(hello("third"));
 assert.equal(sent.length, 4, "both durable outcomes stop replay");
});

test("Arc replica: monotone receipts lead transcript copies; obsolete v2 receipts are removed once", t => {
 const { r, options, dir } = replica(t), old = join(dir, "views", "arc"); mkdirSync(old, { recursive: true });
 const original = '{"synthetic":"v2 receipt"}\n'; writeFileSync(join(old, "old.json"), original);
 r.receive(hello());
 const receipt = { ...answer(), v: 1 as const, session: "pi:s", asOf: "u2", asOfCount: 4, fingerprint: "full", builtAt: "2026-01-01", model: "fixture/model", promptVersion: "test", tier: "b" as const, selector: "selection", nextPointId: 1, builds: [], chapters: [], points: [] };
 r.receive({ t: "arc.receipt", revision: 2, sessionRef: "pi:s", receipt }); r.receive({ t: "arc.receipt", revision: 1, sessionRef: "pi:s", receipt: { ...receipt, asOfCount: 1 } });
 r.receive({ ...status(1, "idle"), statuses: [] });
 const session = { threadId: "pi:s", data: { rarebit: { selector: "selection", count: 2, fingerprint: "partial" }, timeline: { start: 0, end: 1, buckets: [], priced: true } } } as unknown as PiViewSession;
 const value = arcValue({ arc: r } as PiViewContext, session);
 assert.equal(value.receipt?.asOfCount, 4); assert.equal(value.sourceCount, undefined); assert.equal(value.branchChanged, false);
 assert.equal(value.request, undefined, "automatic status does not invent an owner press");
 r.disconnect(); const restarted = new ArcReplica(options); t.after(() => restarted.disconnect());
 assert.equal(r.value("pi:s").v2Removed, undefined, "receipt suppresses cutover notice");
 assert.equal(restarted.value("pi:s").receipt?.asOfCount, 4); assert.deepEqual(restarted.known(), { "pi:s": 2 });
 assert.equal(readFileSync(join(old, "old.json"), "utf8"), original);
});

test("Arc replica: first use removes v2 receipts and records completion", t => {
 const dir = mkdtempSync(join(tmpdir(), "arc-v2-cut-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const old = join(dir, "views", "arc"); mkdirSync(old, { recursive: true }); writeFileSync(join(old, "old.json"), "obsolete");
 const options = { dir: join(dir, "arc-replica"), host: "remote", requester: "hub", send: () => false, changed() {} };
 const first = new ArcReplica(options); assert.equal(first.value("pi:s").v2Removed, true); first.disconnect();
 assert.throws(() => readFileSync(join(old, "old.json")), /ENOENT/);
 mkdirSync(old, { recursive: true }); writeFileSync(join(old, "new.json"), "not a repeated deletion");
 const second = new ArcReplica(options); assert.equal(second.value("pi:s").v2Removed, undefined); second.disconnect();
 assert.equal(readFileSync(join(old, "new.json"), "utf8"), "not a repeated deletion");
});

test("Arc replica: Host settings and new service states reach the panel without transport text inference", async t => {
 const { r } = replica(t);
 assert.equal(r.stamp, null);
 r.receive(hello()); assert.deepEqual(r.stamp, stamp);
 r.receive({ ...status(1), service: serviceStatus("remote", { state: "stopped", running: false, stamp }) }); assert.equal(r.stamp, null);
 r.receive(hello("reachable-again")); assert.deepEqual(r.stamp, stamp);
 r.disconnect(); assert.equal(r.stamp, null);
 r.receive(hello("auth", { state: "no-sign-in", model: "fixture/model", authPath: "/synthetic/auth.json" }));
 assert.equal((r.value("pi:s").services![0] as any).path, "/synthetic/auth.json");
 r.receive(hello("settings", { state: "invalid-settings", settingsPath: "/synthetic/settings.json", settingsKey: "ampi_arc.model" }));
 assert.equal((r.value("pi:s").services![0] as any).key, "ampi_arc.model");
 for (const state of ["stopped", "fault", "stopping", "busy", "error", "cannot-start", "unreachable"]) {
  r.receive(hello(state, { state })); const service = r.value("pi:s").services![0]!;
  assert.equal(service.state, state); assert.ok(service.text?.includes("remote:")); assert.equal(service.version, "engine-a");
  assert.deepEqual(await r.build("pi:s", state), {outcome:"refused",code:"service",detail:"The Arc service cannot accept commands now."});
 }
 r.receive({ ...hello("future"), stamp: { ...stamp, id: "newer", order: 2 } });
 assert.equal(r.value("pi:s").canDismiss, false); assert.match(r.value("pi:s").services![0]!.text!, /This AmPi is older than remote. Update it./);
 assert.equal((await r.build("pi:s", "hub-old")).outcome, "refused");
 r.receive({ ...hello("past", { serviceLogPath: "/synthetic/service.log" }), stamp: { ...stamp, id: "older", order: 0 } });
 assert.match(r.value("pi:s").services![0]!.text!, /could not replace the older Arc service.*the older service is still running.*\/synthetic\/service.log/);
 r.disconnect(); assert.equal(r.value("pi:s").services![0]!.text, "remote: Host is unreachable. Check the SSH connection, then run ampi arc status --host remote.");
});

test("Arc replica: failed durable save cannot send a command or expose an uncommitted request", async t => {
 const { r, options, sent } = replica(t); r.receive(hello());
 rmSync(options.dir, { recursive: true }); writeFileSync(options.dir, "synthetic non-directory");
 await assert.rejects(r.build("pi:s", "cannot-save"));
 assert.equal(sent.length, 0); assert.equal(r.value("pi:s").request, undefined); assert.equal(r.value("pi:s").canDismiss, false);
 assert.match(r.value("pi:s").services![0]!.text!, /could not be saved/);
});

// Prediction: two delayed links join one paid Build. Losing the ack and the
// initiating hub cannot create another call when its durable command is resent.
test("Arc real link: two hubs share one Host through 300 ms delay; restart replay and dismissal are durable", { timeout: 45000 }, async t => {
 const h = await setup(t, { delayMs: 300, arc: { auto: false, retries: 0 }, steps: [{ answer: answer({ points: [point({ cites: [cite("missing")] })] }) }] });
 const second = new Hub({ hosts: h.config.hosts.map(c => ({ ...c, cacheDir: join(h.f.dir, "cache-two") })) }, { token: "e".repeat(64) });
 const p2 = await second.listen(0), b2 = await Browser.open(p2, undefined, `ampi_k_${p2}=${"e".repeat(64)}`);
 const sid2 = b2.sub("devbox", { kind: "view", view: "arc", threadId: "pi:sess-a" });
 let third: Hub | undefined, b3: Browser | undefined;
 t.after(async () => { b2.ws.close(); b3?.ws.close(); await second.close(); await third?.close(); });
 await b2.until<any>(sid2, v => v.canDismiss);
 const gate = h.gate("shared-call"); h.plan([{ answer: answer({ points: [point({ cites: [cite("missing")] })] }), gate }]);
 const args = { threadId: "pi:sess-a" };
 const results = await Promise.all([h.browser.req("devbox", "view.arc.build", { ...args, requestId: "hub-one" }), b2.req("devbox", "view.arc.build", { ...args, requestId: "hub-two" })]);
 assert.ok(results.every(r => r.outcome === "accepted")); assert.equal(results[0].buildId, results[1].buildId);
 await waitFor(() => h.starts().length === 1, "one shared model call"); h.release(gate);
 const first = await h.browser.until<any>(h.sid, v => v.receipt?.drops?.length > 0 && v.status.state === "idle");
 const other = await b2.until<any>(sid2, v => v.receipt?.builtAt === first.receipt.builtAt);
 assert.deepEqual(other.receipt, first.receipt); assert.equal(h.starts().length, 1);
 const drop = first.receipt.drops[0];
 assert.equal((await b2.req("devbox", "view.arc.dismiss", { ...args, dropId: drop.id, toPosition: drop.toPosition })).outcome, "dismissed");
 await h.browser.until<any>(h.sid, v => !v.receipt?.drops?.length); await b2.until<any>(sid2, v => !v.receipt?.drops?.length);
 writeFileSync(h.holdAcks, "hold");
 const lost = h.browser.req("devbox", "view.arc.build", { ...args, requestId: "durable-rebuild", rebuild: true }).catch(() => undefined);
 await waitFor(() => h.starts().length === 2, "accepted Rebuild before lost ack");
 h.browser.ws.close(); await h.hub.close(); rmSync(h.holdAcks);
 third = new Hub(h.config, { token: "d".repeat(64) }); const p3 = await third.listen(0); b3 = await Browser.open(p3, undefined, `ampi_k_${p3}=${"d".repeat(64)}`);
 const sid3 = b3.sub("devbox", { kind: "view", view: "arc", threadId: "pi:sess-a" });
 const replayed = await b3.until<any>(sid3, v => v.request?.requestId === "durable-rebuild" && v.request.outcome === "accepted" && v.status.state === "idle");
 assert.equal(h.starts().length, 2, "replay does not pay for the accepted Rebuild again");
 const commands = readFileSync(h.relayLog, "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(c => c.requestId === "durable-rebuild");
 assert.ok(commands.length >= 2); assert.deepEqual(commands[0], commands.at(-1));
 const finalOther = await b2.until<any>(sid2, v => v.receipt?.builtAt === replayed.receipt.builtAt); assert.deepEqual(replayed.receipt, finalOther.receipt);
 b2.ws.close(); b3.ws.close(); await second.close(); await third.close(); void lost;
});

// Prediction: a lost acceptance remains replayable while a newer offering drains
// the paid call. Restarting the initiating hub must not turn acceptance into a
// permanent refusal. Two hubs share one call; replacement must retain it.
test('Arc real link: lost acceptance replays during replacement and both hub restarts', {timeout:65000}, async t => {
 const h = await setup(t,{delayMs:300,arc:{auto:false,retries:0}});
 const store=join(h.f.agentDir,'ampi-arc');
 const initial=await controlRequest(store,{op:'status',refreshAuth:false});
 const nextFile=join(h.f.dir,'next-service.mjs');
 const built=await buildArcService(nextFile,{buildOrder:initial.stamp.order+1,releaseLine:'stable'});
 const nextBody=readFileSync(nextFile,'utf8');
 const links: {hub:Hub,browser:Browser,sid:number}[]=[];
 async function open(config:any){
  const hub=new Hub(config,{token:'f'.repeat(64)}),port=await hub.listen(0);
  const browser=await Browser.open(port,undefined,`ampi_k_${port}=${'f'.repeat(64)}`);
  const sid=browser.sub('devbox',{kind:'view',view:'arc',threadId:'pi:sess-a'});
  const link={hub,browser,sid}; links.push(link); return {...link,port};
 }
 t.after(async()=>{for(const link of links){link.browser.ws.close();await link.hub.close();}});
 const second=await open({hosts:h.config.hosts.map(c=>({...c,cacheDir:join(h.f.dir,'cache-two')}))});
 await second.browser.until<any>(second.sid,v=>v.canDismiss);
 const health = async () => (await (await fetch(`http://127.0.0.1:${second.port}/api/health`, {headers:{authorization:`Bearer ${"f".repeat(64)}`}})).json()) as any;
 assert.deepEqual((await health()).hosts[0].arcStamp, initial.stamp);
 assert.equal("hosts" in await (await fetch(`http://127.0.0.1:${second.port}/api/health`)).json(), false);
 const gate=h.gate('held-running-call');h.plan([{answer:answer(),gate}]);
 writeFileSync(h.holdAcks,'hold');
 const args={threadId:'pi:sess-a',requestId:'lost-before-upgrade'};
 const lost=h.browser.req('devbox','view.arc.build',args).catch(()=>undefined);
 await waitFor(()=>h.starts().length===1,'first paid call');
 h.browser.ws.close();await h.hub.close();rmSync(h.holdAcks);
 const surviving = await controlRequest(store, { op: 'status', refreshAuth: false });
 assert.equal(surviving.pid, initial.pid, 'closing one hub must keep the other hub on the same resident service');
 const joined=await second.browser.req('devbox','view.arc.build',{...args,requestId:'second-hub'});
 assert.equal(joined.outcome,'accepted');assert.equal(h.starts().length,1);
 await second.browser.until<any>(second.sid, v=>v.status.state==="building");
 assert.ok((await health()).builds.pending >= 1, "health counts Host-reported Builds after removal of the hub Builder");
 const replacement=maintainHost({...h.config.hosts[0]!,remoteNode:process.execPath},{op:'ensure',timeoutMs:30000},nextBody);
 const until=async(check:()=>Promise<boolean>,label:string)=>{const end=Date.now()+15000;while(!await check()){if(Date.now()>end)throw new Error(label);await new Promise(r=>setTimeout(r,30));}};
 await until(async()=> (await controlRequest(store,{op:'status',refreshAuth:false})).state==='updating','no drain');
 const rejected = await controlRequest(store, {op:"request", stamp:initial.stamp, sessionRef:"pi:sess-a", requestId:"new-during-drain", kind:"manual", requester:"probe"});
 assert.deepEqual(rejected, {outcome:"refused", code:"service", transient:true, detail:"Arc service is draining or fenced"});
 assert.equal(JSON.parse(readFileSync(join(store,"builder.json"),"utf8")).commands["new-during-drain"], undefined);
 const restart=await open(h.config);
 const replayDuringDrain=await restart.browser.until<any>(restart.sid,v=>v.request?.requestId===args.requestId && v.request.outcome!=='unknown',15000);
 assert.equal(replayDuringDrain.request.outcome, 'accepted');
 assert.equal(replayDuringDrain.request.buildId, joined.buildId);
 assert.equal(h.starts().length,1,'replacement did not overlap the held paid call');
 restart.browser.ws.close();await restart.hub.close();
 h.release(gate);
 const replaced=await replacement;assert.equal(replaced.serviceVersion,built.version);
 const current=await controlRequest(store,{op:'snapshot',stamp:replaced.stamp});
 const command=JSON.parse(readFileSync(join(store,'builder.json'),'utf8')).commands[args.requestId];
 const authoritative=await controlRequest(store,{op:'request',stamp:replaced.stamp,sessionRef:'pi:sess-a',requestId:args.requestId,kind:'manual',requester:command.requester});
 const updatedConfig={hosts:h.config.hosts.map(c=>({...c,agentConfig:{...c.agentConfig,arcBundle:nextBody}}))};
 const updated=await open(updatedConfig);
 const final=await updated.browser.until<any>(updated.sid,v=>v.receipt && v.services?.[0]?.state==='running',15000);
 const exactReplay=await updated.browser.req('devbox','view.arc.build',args);
 assert.equal(final.receipt.asOfCount, 4); assert.equal(current.receipts.length, 1);
 assert.equal(final.request.buildId, joined.buildId); assert.equal(exactReplay.buildId, joined.buildId);
 assert.equal(h.starts().length,1);assert.equal(authoritative.outcome,'accepted');
 assert.equal(exactReplay.outcome,'accepted','hub must report the durable Host acceptance after replay, not preserve a transient drain refusal');
 void lost;
});
