import "./bound.ts";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiHost } from "../src/pi/host.ts";
import { workingSetActivity } from "../src/pi/working-set.ts";
import { setup, user } from "./pi-host-fixtures.ts";

test("ingestion: N rapid appends to one Session cause at most two recomputes", async (t) => {
 const dir = mkdtempSync(join(tmpdir(), "ampi-ingestion-"));
 const node = join(dir, "frame-source");
 const records: unknown[] = [{ type: "session", id: "burst", timestamp: new Date().toISOString(), cwd: "/synthetic" }];
 for (let i = 0; i < 30; i++) records.push({ type: "message", id: "e"+i, parentId: i ? "e"+(i-1) : null, timestamp: new Date().toISOString(), message: { role: "user", content: "append "+i } });
 const frames: unknown[] = [{ t: "hello", host: "fixture" }];
 let offset = 0;
 for (const record of records) {
  const data = JSON.stringify(record)+"\n";
  frames.push({ t: "chunk", path: "/synthetic/burst.jsonl", offset, data });
  offset += Buffer.byteLength(data);
 }
 writeFileSync(node, "#!"+process.execPath+"\nprocess.stdin.resume();\nconst frames="+JSON.stringify(frames)+";\nfor (const frame of frames) process.stdout.write(JSON.stringify(frame)+'\\n');\n");
 chmodSync(node, 0o755);
 const before = workingSetActivity().ingestions;
 const host = new PiHost({ id: "fixture", label: "fixture", kind: "pi-local", remoteNode: node, cacheDir: join(dir, "cache") });
 t.after(async () => { await host.stop(); rmSync(dir, { recursive: true, force: true }); });
 const ready = new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("burst not indexed")), 10_000);
  host.on("frame", (frame: any) => { if (frame.t === "snap" && frame.value?.entries?.length === 30) { clearTimeout(timeout); resolve(); } });
 });
 host.start();
 // Subscribe after all source bytes have crossed the pipe. Polling probes only publication.
 const probe = setInterval(() => host.send({ t: "sub", sid: 1, topic: { kind: "thread", threadId: "pi:burst" } }), 40);
 t.after(() => clearInterval(probe));
 await ready; clearInterval(probe);
 const end = Date.now()+5000;
 while (workingSetActivity().pending && Date.now() < end) await new Promise(r=>setTimeout(r,10));
 assert.equal(workingSetActivity().pending, 0);
 const jobs = workingSetActivity().ingestions-before;
 assert.ok(jobs >= 1 && jobs <= 2, "30 appends queued "+jobs+" recomputes");
});

test("ingestion source size: a copy behind the size its agent reports reads stale, and an agent that reports no size keeps today's ready (failure: an Arc Build covered 2 of 12 chunks during ingest)", async (t) => {
 const dir = mkdtempSync(join(tmpdir(), "ampi-ingestion-size-"));
 const node = join(dir, "frame-source");
 const frames: unknown[] = [{ t: "hello", host: "fixture" }];
 // Old agent: no size. Whole: size equals the bytes sent. Behind: the file holds 4096 bytes more than sent.
 const cases = { old: undefined, whole: 0, behind: 4096 } as const;
 for (const [id, extra] of Object.entries(cases)) {
  const data = [{ type: "session", id, timestamp: new Date().toISOString(), cwd: "/synthetic" }, { type: "message", id: "e0", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "hello "+id } }].map((r) => JSON.stringify(r)+"\n").join("");
  frames.push({ t: "chunk", path: "/synthetic/"+id+".jsonl", offset: 0, data, ...(extra === undefined ? {} : { size: Buffer.byteLength(data)+extra }) });
 }
 writeFileSync(node, "#!"+process.execPath+"\nprocess.stdin.resume();\nconst frames="+JSON.stringify(frames)+";\nfor (const frame of frames) process.stdout.write(JSON.stringify(frame)+'\\n');\n");
 chmodSync(node, 0o755);
 const host = new PiHost({ id: "fixture", label: "fixture", kind: "pi-local", remoteNode: node, cacheDir: join(dir, "cache") });
 t.after(async () => { await host.stop(); rmSync(dir, { recursive: true, force: true }); });
 const ids = Object.keys(cases), states = new Map<string, string>();
 const indexed = new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("sessions not indexed: "+JSON.stringify([...states]))), 10_000);
  // A Rarebit item shows the copy is derived, so bytes equal derived bytes and only the reported size can make it stale.
  host.on("frame", (frame: any) => {
   if (frame.t !== "snap" || !frame.value?.items?.length) return;
   states.set(ids[frame.sid - 1]!, frame.value.source.state);
   if (states.size === ids.length) { clearTimeout(timeout); resolve(); }
  });
 });
 host.start();
 const probe = setInterval(() => ids.forEach((id, i) => host.send({ t: "sub", sid: i + 1, topic: { kind: "view", view: "rarebit", threadId: "pi:"+id } })), 40);
 t.after(() => clearInterval(probe));
 await indexed; clearInterval(probe);
 assert.deepEqual(Object.fromEntries(states), { old: "ready", whole: "ready", behind: "stale" });
});

test("ingestion whole-line size: the agent reports the file up to its last complete line, so an unfinished tail keeps a loaded Session ready (failure: a crash-cut tail read stale forever)", async (t) => {
 const { f, browser } = await setup(t);
 const rarebit = browser.sub("devbox", { kind: "view", view: "rarebit", threadId: "pi:sess-a" });
 await browser.until<any>(rarebit, (v) => v.source?.state === "ready");
 appendFileSync(f.sessionA, user("u2", "r1", 4, "check the tail") + '{"type":"message","id":"cut"');
 const v = await browser.until<any>(rarebit, (v) => v.items?.some((i: any) => i.text === "check the tail") && v.source?.state === "ready", 5000);
 assert.equal(v.source.state, "ready");
});
