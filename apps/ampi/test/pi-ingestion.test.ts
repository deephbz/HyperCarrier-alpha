import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiHost } from "../src/pi/host.ts";
import { workingSetActivity } from "../src/pi/working-set.ts";

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
