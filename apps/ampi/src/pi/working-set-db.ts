// Private, rebuildable materializations. Transactions publish one content-keyed head.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { searchSchema } from "./search.ts";
import { span, traceDb } from "../trace.ts";

// The Worker's last close checkpoints the WAL under an exclusive lock. Every open
// waits out such locks from its first statement instead of failing with SQLITE_BUSY.
const BUSY_MS = 5000;

/** Hub connections cannot mutate working-set state, including schema. */
export function readWorkingSet(cacheDir: string): DatabaseSync {
 const db = traceDb(span("sqlite-open", "sqlite", () => new DatabaseSync(join(cacheDir, "working-set.sqlite"), { readOnly: true, timeout: BUSY_MS }), { db: "read" }), "read");
 db.exec("PRAGMA cache_size=-2048; PRAGMA mmap_size=0; PRAGMA query_only=ON;");
 return db;
}

/** The derive Worker owns schema and every working-set write. */
export function openWorkingSet(cacheDir: string): DatabaseSync {
 mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
 const path = join(cacheDir, "working-set.sqlite");
 const db = traceDb(span("sqlite-open", "sqlite", () => new DatabaseSync(path, { timeout: BUSY_MS }), { db: "write" }), "write");
 chmodSync(path, 0o600);
 db.exec(`PRAGMA journal_mode=WAL; PRAGMA cache_size=-2048; PRAGMA mmap_size=0;
 CREATE TABLE IF NOT EXISTS sessions (path TEXT PRIMARY KEY, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS evicted (path TEXT PRIMARY KEY, id TEXT, ref TEXT, watermark TEXT);
 CREATE TABLE IF NOT EXISTS entries (
  path TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, t REAL,
  ui TEXT, feature TEXT NOT NULL, occurrence TEXT, native_meta TEXT NOT NULL,
  rarebit TEXT, totalchars INTEGER NOT NULL, rarechars INTEGER NOT NULL, kinds TEXT NOT NULL,
  PRIMARY KEY(path,id));
 CREATE INDEX IF NOT EXISTS entry_order ON entries(path,position);
 CREATE INDEX IF NOT EXISTS entry_time ON entries(path,t);
 CREATE TABLE IF NOT EXISTS arc_evidence (path TEXT NOT NULL, id TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY(path,id));`);
 searchSchema(db);
 return db;
}
