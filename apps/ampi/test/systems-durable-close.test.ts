import "./bound.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { DurableViews } from "../src/durable/reader-side.ts";
import { buildArc } from "../src/durable/arc-sidecar.ts";
import { writePiSettings } from "./helpers.ts";
// @ts-ignore: plain ESM test fixtures over a real pi-durable 1.4.0 store.
import { ask, buildFixture, buildTeam, openFixtureStore } from "../../trace-analytics/test/fixtures/durable-store.mjs";
// @ts-ignore: the real reader service behind a JSON round-trip, as on the wire.
import { serviceNode } from "../../trace-analytics/test/fixtures/durable-node.mjs";

const HOST = "demo";
const GOLDEN = new URL("./fixtures/durable-views-golden.json", import.meta.url);

/** The synthetic store: a root with tool use, custom entries, a compaction and a reset; a fork; an oversized entry; a Team Worker. */
async function synthetic(t: any) {
 const dir = mkdtempSync(join(tmpdir(), "ampi-durable-views-"));
 const { harness, root } = await openFixtureStore(join(dir, "store.sqlite"));
 const { fork } = await buildFixture(harness, root);
 const blob = await root.submit({ type: "write", entry: { kind: "fixture.blob", data: { blob: "x".repeat(300_000) } } }, context);
 await blob.wait(context);
 const worker = await buildTeam(harness, root);
 const node = serviceNode(harness);
 // Hooks run in order: every DurableViews closes (and its derive jobs end) before the store and directory go.
 const views: DurableViews[] = [];
 t.after(async () => {
  for (const v of views) await v.close();
  await node.harness.close(context); rmSync(dir, { recursive: true, force: true });
 });
 const key = (c: { id: number }) => `tree-a.${c.id}`;
 const open = (extra: Partial<ConstructorParameters<typeof DurableViews>[0]> = {}) => { const v = new DurableViews({ host: HOST, cacheDir: join(dir, "cache"), node: () => node as never, maxEntryBytes: 64 * 1024, ...extra }); views.push(v); return v; };
 return { dir, harness, node, root, fork, worker, open, threads: { root: key(root), fork: key(fork), worker: key(worker) } };
}
const changed = (views: DurableViews, threadId: string) => new Promise<void>((resolve) => {
 const on = (e: { threadId?: string }) => { if (e.threadId === threadId) { views.off("changed", on); resolve(); } };
 views.on("changed", on);
});


for (const rejected of [false, true]) test(`systems durable Arc: close drains an uncooperative ${rejected ? "rejecting" : "answering"} call under ownership`, {timeout:30000}, async t => {
 writePiSettings({ampi_arc:{model:"synthetic/model",auto:false,retries:0}});
 t.after(()=>writePiSettings(undefined));
 const s=await synthetic(t);
 let release!:()=>void, started!:()=>void;
 const held=new Promise<void>(r=>release=r), entered=new Promise<void>(r=>started=r);
 t.after(()=>release());
 const answer=(request:any,label:string)=>{
  const data=JSON.parse(request.prompt),item=data.rarebits.at(-1);
  const claim={text:label,cites:[{id:item.id,quote:item.text}]};
  return {text:JSON.stringify({goal:claim,now:claim,chapters:[{firstId:data.rarebits[0].id,label:"Synthetic work",closed:true,summary:{scope:claim,bullets:[]}}],points:[]}),model:request.model};
 };
 const old=s.open({ask:async request=>{started();await held;if(rejected)throw new Error("Synthetic rejected call");return answer(request,"Old owner receipt");}});
 await old.track(s.threads.root);
 const pending=buildArc(old.context,s.threads.root,{trigger:"manual"});
 await entered;
 let closed = false;
 const closing = old.close().then(() => { closed = true; });
 try {
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false, "close must await the active call");
  assert.throws(() => s.open(), { code: "cache_owned" }, "the old owner keeps its lock while draining");
  await assert.rejects(buildArc(old.context,s.threads.root,{trigger:"manual"}), /closed/);
 } finally { release(); await pending; await closing; }
 const arcDir = join(s.dir,"cache","views","arc");
 assert.equal(readdirSync(arcDir).filter(n => n.endsWith(".json")).length, 0, "neither success nor failure may publish after close starts");
 const next=s.open({ask:async request=>answer(request,"New owner receipt")});
 await next.track(s.threads.root);await buildArc(next.context,s.threads.root,{trigger:"manual"});
 const dir=join(s.dir,"cache","views","arc"),file=join(dir,readdirSync(dir).find(n=>n.endsWith(".json"))!);
 const before=JSON.parse(readFileSync(file,"utf8"));assert.equal(before.goal.text,"New owner receipt");
 const after=JSON.parse(readFileSync(file,"utf8"));
 assert.equal(after.goal.text,"New owner receipt","a closed owner must not overwrite the current owner's committed receipt");
 await assert.rejects(buildArc(old.context,s.threads.root,{trigger:"manual"}), /closed/);
});

test("systems durable Arc: close aborts a cooperative call without a release or a receipt", {timeout:10000}, async t => {
 writePiSettings({ampi_arc:{model:"synthetic/model",auto:false,retries:0}});
 t.after(()=>writePiSettings(undefined));
 const s=await synthetic(t);
 let entered!:()=>void, aborted=false;
 const started=new Promise<void>(resolve=>entered=resolve);
 const views=s.open({ask:request=>new Promise((_resolve,reject)=>{
  assert.ok(request.signal);
  request.signal.addEventListener("abort",()=>{aborted=true;reject(request.signal!.reason);},{once:true});
  entered();
 })});
 await views.track(s.threads.root);
 const pending=buildArc(views.context,s.threads.root,{trigger:"manual"});
 await started;
 await views.close(); await pending;
 assert.equal(aborted,true);
 assert.equal(readdirSync(join(s.dir,"cache","views","arc")).filter(n=>n.endsWith(".json")).length,0);
 const next=s.open(); await next.close();
});
