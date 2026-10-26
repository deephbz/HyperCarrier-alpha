// One hub owns a durable cache directory: its copy bundles, working-set heads and view state. The cache
// files are a multi-file transaction (reader-design.md, "Hub copy") that no SQLite lock of their own
// protects, so a second hub on the same AMPI home fails at start instead of sharing them.
//
// The lock is an exclusive SQLite lock on `owner.lock` (locking_mode=EXCLUSIVE). The kernel drops it
// when the owning process exits, however it exits, so a crashed hub leaves no stale lock to take over.
// A second connection fails at once, in another process or in this one. `owner.json` names the holder
// for the error message only; it grants nothing. `held` keeps each open handle reachable until release:
// garbage collection finalizes an unreachable DatabaseSync and so drops the lock while the process lives.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type CacheOwner = { release(): void };

const held = new Set<DatabaseSync>();

/** Take sole ownership of `dir`, or throw with code `cache_owned` when another hub holds it. */
export function claimCacheDir(dir: string): CacheOwner {
 const db = new DatabaseSync(join(dir, "owner.lock"), { timeout: 0 });
 try {
  db.exec(`PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS owner(pid INTEGER, at INTEGER);
   BEGIN EXCLUSIVE; DELETE FROM owner; INSERT INTO owner VALUES (${process.pid}, ${Date.now()}); COMMIT;`);
 } catch (error) {
  db.close();
  if (!/locked|busy/i.test((error as Error).message)) throw error;
  let holder = "";
  try { const o = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")); holder = ` (pid ${o.pid}, since ${new Date(o.at).toISOString()})`; } catch {}
  throw Object.assign(new Error(`Another AmPi hub${holder} owns the durable cache ${dir}. One hub serves one AMPI home: stop the other hub, or give this one its own AMPI_HOME.`), { code: "cache_owned" });
 }
 writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
 held.add(db);
 let released = false;
 return { release() { if (!released) { released = true; held.delete(db); db.close(); } } };
}
