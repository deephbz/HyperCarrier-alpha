import "./bound.ts";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openWorkingSet } from "../src/pi/working-set-db.ts";
import { WorkingSet } from "../src/pi/working-set.ts";
import { DurableViews } from "../src/durable/reader-side.ts";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
// @ts-ignore: real synthetic durable store fixture.
import { ask, buildFixture, openFixtureStore } from "../../trace-analytics/test/fixtures/durable-store.mjs";
// @ts-ignore: reader service over a JSON wire round-trip.
import { serviceNode } from "../../trace-analytics/test/fixtures/durable-node.mjs";

test("outline: whole-branch ordinals, bounded newest users, version replacement and cache", async t => {
 const dir=mkdtempSync(join(tmpdir(),'ampi-outline-'));
 const db=openWorkingSet(dir);
 db.prepare('INSERT INTO sessions VALUES (?,?)').run('thread',JSON.stringify({version:'v1'}));
 const put=db.prepare('INSERT INTO entries(path,id,position,ui,feature,native_meta,totalchars,rarechars,kinds) VALUES (?,?,?,?,?,?,?,?,?)');
 db.exec('BEGIN');
 for(let i=0;i<4202;i++) put.run('thread',`e${i}`,i,JSON.stringify({kind:i%2?'assistant':'user',text:i===4200?'x'.repeat(140)+'\nignored':`Message ${i}\nsecond line`}), '{}','{}',0,0,'{}');
 put.run('thread','hidden',-1,'null','{}','{}',0,0,'{}');
 db.exec('COMMIT');
 const store=new WorkingSet('fixture',dir);await store.ready;
 t.after(async()=>{await store.close();db.close();rmSync(dir,{recursive:true,force:true});});
 const outline=store.outline('thread');
 assert.equal(outline.totalEntries,4202);assert.equal(outline.truncated,true);assert.equal(outline.users.length,2000);
 assert.deepEqual(outline.users[0],{id:'e202',ordinal:202,firstLine:'Message 202'});
 assert.equal(outline.users.at(-1)!.firstLine.length,120);
 assert.equal(store.outline('thread'),outline,'same version reuses compact outline');
 db.exec("DELETE FROM entries WHERE path='thread' AND (position>2 OR position<0)");
 db.prepare('UPDATE sessions SET data=? WHERE path=?').run(JSON.stringify({version:'v2'}),'thread');
 const replaced=store.outline('thread');
 assert.equal(replaced.version,'v2');assert.equal(replaced.totalEntries,3);assert.equal(replaced.truncated,false);
 assert.deepEqual(replaced.users.map(x=>x.id),['e0','e2']);
});

test("outline: Pi covers users beyond the tail and replaces the selected branch", async t => {
 const dir=mkdtempSync(join(tmpdir(),'ampi-outline-pi-'));
 const source={host:'demo',cacheDir:join(dir,'cache'),path:'/synthetic/session.jsonl',file:join(dir,'copy.jsonl')};
 mkdirSync(source.cacheDir);
 const message=(i:number,parentId:string|null)=>({type:'message',id:'e'+i,parentId,message:{role:i%2?'assistant':'user',content:[{type:'text',text:'Line '+i}]}});
 writeFileSync(source.file,[{type:'session',id:'demo'},...Array.from({length:650},(_,i)=>message(i,i?'e'+(i-1):null))].map(x=>JSON.stringify(x)).join('\n')+'\n');
 const store=new WorkingSet('demo',source.cacheDir);
 t.after(async()=>{await store.close();rmSync(dir,{recursive:true,force:true});});
 const data=(await store.refresh(source))!;
 assert.ok(store.tail(source,data,false).more);
 const first=store.outline(source.path);
 assert.equal(first.totalEntries,650);assert.equal(first.users[0]!.id,'e0');assert.equal(first.users.length,325);
 appendFileSync(source.file,JSON.stringify(message(700,'e0'))+'\n');
 await store.refresh(source);
 const branch=store.outline(source.path);
 assert.notEqual(branch.version,first.version);assert.equal(branch.totalEntries,2);
 assert.deepEqual(branch.users.map(x=>x.id),['e0','e700']);
});

test("outline: durable fork includes inherited prefix once and excludes suffix and siblings", async t => {
 const dir=mkdtempSync(join(tmpdir(),'ampi-outline-durable-'));
 const {harness,root}=await openFixtureStore(join(dir,'store.sqlite'));
 const {fork,cutoff}=await buildFixture(harness,root);
 const sibling=await root.fork(cutoff,{ownership:{kind:'ownerless'}},context);
 await ask(sibling,'sibling only');
 const node=serviceNode(harness);
 const views=new DurableViews({host:'demo',cacheDir:join(dir,'cache'),node:()=>node as never});
 t.after(async()=>{await views.close();await harness.close(context);rmSync(dir,{recursive:true,force:true});});
 const threadId=`tree-a.${fork.id}`;
 await views.track(threadId);
 const outline=await views.ops['thread.outline']({threadId});
 const entries=views.threadValue(threadId)!.entries;
 assert.equal(outline.totalEntries,entries.length);
 assert.deepEqual(outline.users,entries.flatMap((e,ordinal)=>e.kind==='user'?[{id:e.id,ordinal,firstLine:e.text.split('\n')[0]}]:[]));
 assert.deepEqual(outline.users.map(x=>x.firstLine),['use echo please','fork question']);
 assert.equal(outline.version,views.threadValue(threadId)!.sourceVersion);
});
