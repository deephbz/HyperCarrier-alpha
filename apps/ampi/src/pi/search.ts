// Search owns extraction, tokenizer policy, and scope labels. The hub retains no
// text corpus. Fleet reads FTS; in-Session find scans one native entry at a time.
import type { DatabaseSync } from "node:sqlite";
// @ts-ignore shared reader is plain ESM
import { openPiSessionRange } from "../../../trace-analytics/src/sources/transcript-range.mjs";
// @ts-ignore shared native extraction is plain ESM
import { mirrorEntryText } from "../../../trace-analytics/src/sources/transcript.mjs";
import { DERIVATION_VERSION, indexFile, type Source } from "./working-set-types.ts";
import type { PiReaderEntry } from "./views/types.ts";

export const PROSE_KINDS = ["human", "assistant", "compaction"] as const;
export const FLEET_SCOPE = "Indexed active branches retained by this hub (96 h by default, plus live/open Sessions). Unindexed copies and invalid records are not searched. Searches human turns, agent replies and compaction summaries. Excludes thinking, tools, injected messages, branch summaries and uncopied history. Word matching; indexed CJK bigrams. Use K5 tools for older history; K5 search is not full-transcript search.";
export const FIND_SCOPE = "This Session’s copied active branch. Case-insensitive substring search covers user text, replies, thinking, tool calls/results, bash command/output, custom messages and summaries. Excludes images, non-text metadata, inactive branches and uncopied bytes.";
export type SearchHit = { entry: string; ref: string; threadId: string; snippet: string; kind?: string; title?: string; version: string };
export type SearchResult = { hits: SearchHit[]; more: boolean; scope: string; asOf: number | null; total?: number; scanned?: number; invalidLines?: number; coverage?: { indexed: number; notIndexed: number; stale: number; invalidLines: number } };
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const encoded = (a: string, b: string) => `u${a.codePointAt(0)!.toString(16)}u${b.codePointAt(0)!.toString(16)}`;
function grams(run: string) { const c = Array.from(run); return c.slice(1).map((b, i) => encoded(c[i]!, b)); }
export function cjkBigrams(text: string): string { return [...text.matchAll(CJK)].flatMap(([run]) => grams(run)).join(" "); }
export function queryText(query: string): string {
 const q = query.trim();
 if (!q || q.length > 500) throw new Error("Enter 1–500 search characters.");
 return q;
}
// FTS5 cannot index an UNINDEXED column, so `path=?` scans every row. prose_path
// maps path to FTS rowids; forgetting a path costs only that path's rows.
// A cache written before prose_path records a backfill cursor. Only the derive
// Worker advances it, in bounded steps; until it finishes, forgetting scans.
export function searchSchema(db: DatabaseSync) {
 db.exec('BEGIN IMMEDIATE');
 try {
  const upgrade = !db.prepare("SELECT 1 FROM sqlite_master WHERE name='prose_path'").get() && !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='prose'").get();
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS prose USING fts5(path UNINDEXED, id UNINDEXED, text, cjk, tokenize='unicode61');
  CREATE TABLE IF NOT EXISTS prose_path (rowid INTEGER PRIMARY KEY, path TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS prose_path_path ON prose_path(path);
  CREATE TABLE IF NOT EXISTS prose_path_backfill (after INTEGER NOT NULL);`);
  if (upgrade && db.prepare('SELECT 1 FROM prose LIMIT 1').get()) db.exec('INSERT INTO prose_path_backfill VALUES (0)');
  db.exec('COMMIT');
 } catch (error) { db.exec('ROLLBACK'); throw error; }
}
/** Maps at most `limit` older prose rows. Returns true when no backfill remains. */
export function backfillSearch(db: DatabaseSync, limit = 2000): boolean {
 db.exec('BEGIN IMMEDIATE');
 try {
  const cursor = db.prepare('SELECT after FROM prose_path_backfill').get();
  let done = !cursor;
  if (cursor) {
   // FTS5 rowid ranges took 44 s per 2000 rows at 598k rows. The content shadow
   // table is an ordinary B-tree whose c0 column holds path.
   const after = Number(cursor.after), last = db.prepare('SELECT max(id) AS last FROM (SELECT id FROM prose_content WHERE id>? ORDER BY id LIMIT ?)').get(after, limit)!.last;
   if (last == null) { db.exec('DELETE FROM prose_path_backfill'); done = true; }
   else {
    db.prepare('INSERT OR IGNORE INTO prose_path(rowid,path) SELECT id,c0 FROM prose_content WHERE id>? AND id<=?').run(after, last);
    db.prepare('UPDATE prose_path_backfill SET after=?').run(last);
   }
  }
  db.exec('COMMIT');
  return done;
 } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function forgetSearch(db: DatabaseSync, path: string) {
 if (db.prepare('SELECT 1 FROM prose_path_backfill').get()) db.prepare('DELETE FROM prose WHERE path=?').run(path);
 else if (!db.prepare('SELECT 1 FROM prose_path WHERE path=? LIMIT 1').get(path)) return;
 else db.prepare('DELETE FROM prose WHERE rowid IN (SELECT rowid FROM prose_path WHERE path=?)').run(path);
 db.prepare('DELETE FROM prose_path WHERE path=?').run(path);
}
/**
 * Retention bounds each write transaction; the Worker owns these calls. Both deletes pick the same lowest rowids
 * through prose_path_path inside the caller's transaction, so neither table keeps orphans.
 */
export function forgetSearchBatch(db: DatabaseSync, path: string, limit: number): number {
 // Until the backfill maps every older row, only one scan finds them all.
 if (db.prepare('SELECT 1 FROM prose_path_backfill').get()) { forgetSearch(db, path); return 0; }
 const batch = 'SELECT rowid FROM prose_path WHERE path=? ORDER BY rowid LIMIT ?';
 db.prepare(`DELETE FROM prose WHERE rowid IN (${batch})`).run(path, limit);
 return Number(db.prepare(`DELETE FROM prose_path WHERE rowid IN (${batch})`).run(path, limit).changes);
}
export function indexProse(db: DatabaseSync, path: string, e: PiReaderEntry) {
 if (!(PROSE_KINDS as readonly string[]).includes(e.kind)) return;
 const text = e.kind === "compaction" ? e.summary ?? "" : (e.blocks ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
 if (!text) return;
 const { lastInsertRowid } = db.prepare('INSERT INTO prose(path,id,text,cjk) VALUES (?,?,?,?)').run(path, e.id, text, cjkBigrams(text));
 db.prepare('INSERT INTO prose_path(rowid,path) VALUES (?,?)').run(lastInsertRowid, path);
}
function expression(query: string): string {
 const q = queryText(query), parts: string[] = [];
 for (const [run] of q.matchAll(CJK)) {
  const tokens = grams(run);
  if (!tokens.length) throw new Error("Use at least two adjacent CJK characters for fleet search. Session find supports one character.");
  parts.push(`cjk : "${tokens.join(" ")}"`);
 }
 const rest = q.replace(CJK, " ").match(/[\p{L}\p{N}_]+/gu) ?? [];
 parts.push(...rest.map((word) => `text : "${word.replaceAll('"', '""')}"`));
 if (!parts.length) throw new Error("Enter a word or at least two CJK characters.");
 return parts.join(" AND ");
}
export function fleetSearch(db: DatabaseSync, query: string): SearchResult {
 const match = expression(query);
 const cjk = [...query.matchAll(CJK)][0]?.[0] ?? "";
 const rows = db.prepare(`SELECT prose.id,
  CASE WHEN ? <> '' THEN substr(prose.text,max(1,instr(prose.text,?)-80),320)
  ELSE snippet(prose,2,'','','…',40) END AS excerpt,
  json_extract(s.data,'$.session.id') AS thread, json_extract(s.data,'$.session.ref') AS ref,
  json_extract(s.data,'$.session.title') AS title, json_extract(s.data,'$.version') AS version,
  json_extract(s.data,'$.asOf') AS asof
  FROM prose JOIN sessions s ON s.path=prose.path WHERE prose MATCH ? ORDER BY rank LIMIT 101`).all(cjk, cjk, match);
 const coverage = db.prepare("SELECT count(*) AS indexed, min(json_extract(data,'$.asOf')) AS asof, coalesce(sum(json_extract(data,'$.invalidLines')),0) AS invalid FROM sessions").get()!;
 const asOf = coverage.asof == null ? null : Number(coverage.asof);
 const hits = rows.slice(0, 100).map((row) => {
  return { entry: String(row.id), threadId: String(row.thread), ref: `${row.ref}#${row.id}`, snippet: String(row.excerpt), title: String(row.title ?? row.thread), version: String(row.version) };
 });
 return { hits, more: rows.length > 100, scope: FLEET_SCOPE, asOf, coverage: { indexed: Number(coverage.indexed), notIndexed: 0, stale: 0, invalidLines: Number(coverage.invalid) } };
}
export function findInSession(source: Source, query: string, version: string): SearchResult {
 const q = queryText(query).toLowerCase(), reader = openPiSessionRange(source.file, { host: source.host, indexPath: indexFile(source) });
 try {
  const info = reader.info();
  if (`${DERIVATION_VERSION}:${info.version}` !== version) throw new Error("Session changed. Retry Find on the current copy.");
  const hits: SearchHit[] = []; let total = 0, scanned = 0;
  reader.visit(({ native, entry }: { native: unknown; entry: PiReaderEntry }) => {
   scanned++;
   const text: string = mirrorEntryText(native), at = text.toLowerCase().indexOf(q);
   if (at < 0) return;
   total++;
   if (hits.length < 200) hits.push({ entry: entry.id, threadId: reader.session().id, ref: entry.ref, snippet: text.slice(Math.max(0, at - 80), at + q.length + 160), kind: entry.kind, version });
  });
  return { hits, more: total > hits.length, total, scanned, scope: FIND_SCOPE, asOf: Date.now(), invalidLines: info.invalidLines };
 } finally { reader.close(); }
}
