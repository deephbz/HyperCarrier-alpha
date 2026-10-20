// Child process fixture: exercise actual SQLite page reads and the shared LRU.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkingSet, workingSetUsage } from "../src/pi/working-set.ts";
import { openWorkingSet } from "../src/pi/working-set-db.ts";
const dir = mkdtempSync(join(tmpdir(), "ampi-churn-"));
const seed = openWorkingSet(dir);
let store: WorkingSet | undefined;
try {
 const data: any = { version: "fixture", count: 400 };
 const insert = seed.prepare("INSERT INTO entries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
 seed.exec("BEGIN");
 for (let session = 0; session < 32; session++) {
  const path = "/synthetic/" + session;
  seed.prepare("INSERT INTO sessions VALUES (?,?)").run(path, JSON.stringify(data));
  for (let i = 0; i < 400; i++) insert.run(path, String(i), i, i, JSON.stringify({ id: String(i), kind: "user", images: 0, text: String(session) + "x".repeat(1024) }), "{}", null, "{}", null, 0, 0, "{}");
 }
 seed.exec("COMMIT"); seed.close();
 store = new WorkingSet("fixture", dir); await store.ready;
 const samples: { heapUsed: number; external: number }[] = [];
 for (let cycle = 0; cycle < 7; cycle++) {
  for (let session = 0; session < 32; session++) store.tail({ host: "fixture", cacheDir: dir, path: "/synthetic/" + session, file: "" }, data, false);
  (globalThis as any).gc();
  const { heapUsed, external } = process.memoryUsage(); samples.push({ heapUsed, external });
 }
 const usage = workingSetUsage(); store.close(); (globalThis as any).gc();
 console.log(JSON.stringify({ samples, usage, closed: workingSetUsage() }));
} finally { await store?.close(); rmSync(dir, { recursive: true, force: true }); }
