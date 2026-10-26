// Hub working set: compact materializations plus bounded live/LRU windows. Worker
// ingestion owns full scans; navigation reads local indexed pages, never full files.
import { fleetSearch, type SearchResult } from "./search.ts";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getCompileCacheDir } from "node:module";
import { Worker } from "node:worker_threads";
import type { StatementSync } from "node:sqlite";
// @ts-ignore: shared reader is plain ESM.
import { openPiSessionRange } from "../../../trace-analytics/src/sources/transcript-range.mjs";
import { readWorkingSet } from "./working-set-db.ts";
import { counter, tracing } from "../trace.ts";
import { trackDerive } from "./derive-queue.ts";
import { derivedVersion, WINDOW_BYTES, WINDOW_ENTRIES, ENTRY_PAGE_BYTES, type Source, type Derived, type WorkerJob } from "./working-set-types.ts";
import type { PiEntry, ThreadOutline } from "../shared/protocol.ts";
import { projectEntry, wireEntry } from "./projection.ts";
import type { RarebitItem, RarebitValue } from "./views/rarebit.ts";

let worker: Worker | undefined, owners = 0, serial = 0, ingestions = 0;
const pending = new Map<number, { job: WorkerJob | { op: "close"; cacheDir: string }; started?: boolean; resolve: (value: any) => void; reject: (error: Error) => void; onStart?: () => void }>();
// Open stores per cache directory. The last one to close tells the Worker to stop writing there.
const opened = new Map<string, number>();
const jobDir = (job: WorkerJob | { op: "close"; cacheDir: string }) => "cacheDir" in job ? job.cacheDir : job.source.cacheDir;
function ensureWorker() {
 if (worker) return;
 // A worker does not inherit the main thread's compile cache (bin/ampi.mjs); the variable gives it the same directory.
 const cache = getCompileCacheDir?.();
 const current = new Worker(new URL("./derive-worker.ts", import.meta.url), cache ? { env: { ...process.env, NODE_COMPILE_CACHE: cache } } : {});
 worker = current;
 current.on("message", (m: { id: number; data?: unknown; error?: string; started?: boolean }) => {
  if (worker !== current) return;
  const p = pending.get(m.id); if (!p) return;
  if (m.started) { p.started = true; p.onStart?.(); return; }
  pending.delete(m.id);
  if (tracing) counter("derive-queue", { pending: pending.size });
  if (!pending.size) current.unref();
  if (m.error) p.reject(new Error(m.error)); else p.resolve(m.data);
 });
 const failed = (error: unknown) => {
  if (worker !== current) return;
  worker = undefined;
  for (const p of pending.values()) p.reject(error instanceof Error ? error : new Error(String(error)));
  pending.clear();
 };
 current.on("error", failed);
 current.on("exit", (code) => failed(new Error(`Ingestion worker exited (${code}); retry the read`)));
 current.unref();
}
function request<T>(job: WorkerJob | { op: "close"; cacheDir: string }, capture?: (id: number) => void, onStart?: () => void): Promise<T> {
 ensureWorker(); worker!.ref();
 const id = ++serial; capture?.(id);
 return new Promise((resolve, reject) => {
  pending.set(id, { job, resolve, reject, onStart }); worker!.postMessage({ id, ...job });
  if (tracing) counter("derive-queue", { pending: pending.size });
 });
}
function acquire() { owners++; ensureWorker(); }
async function release() {
 if (--owners > 0) return;
 const current = worker; worker = undefined;
 for (const p of pending.values()) p.reject(new Error("Working set stopped")); pending.clear();
 await current?.terminate();
}

type Window = { value: { entries: PiEntry[]; more: boolean; version: string }; bytes: number; live: boolean };
const windows = new Map<string, Window>();
const LIVE_BYTES = 64 * 1024 * 1024, LRU_BYTES = 64 * 1024 * 1024, LRU_SLOTS = 20;
const cacheKey = (s: Source) => `${s.host}\0${s.path}`;
function trim() {
 let live = 0, lru = 0, slots = 0;
 for (const w of windows.values()) { if (w.live) live += w.bytes; else { lru += w.bytes; slots++; } }
 for (const [key, w] of windows) {
  if (w.live ? live <= LIVE_BYTES : lru <= LRU_BYTES && slots <= LRU_SLOTS) continue;
  windows.delete(key);
  if (w.live) live -= w.bytes; else { lru -= w.bytes; slots--; }
 }
}

/** Numbers-only diagnostics for cache-budget verification. No source identifiers. */
export function workingSetActivity() { return { ingestions, pending: pending.size }; }
export function workingSetUsage() {
 let liveBytes = 0, lruBytes = 0, liveSlots = 0, lruSlots = 0;
 for (const w of windows.values()) { if (w.live) { liveBytes += w.bytes; liveSlots++; } else { lruBytes += w.bytes; lruSlots++; } }
 return { liveBytes, lruBytes, liveSlots, lruSlots };
}

export class WorkingSet {
 db!: ReturnType<typeof readWorkingSet>;
 readonly ready: Promise<void>;
 /** Resolves once saved heads are readable, while the Worker initializes: a saved database opens at once, and with none, `load` and `snapshot` answer empty. */
 readonly readable: Promise<void>;
 readonly host: string;
 readonly cacheDir: string;
 #closed = false;
 #closing?: Promise<void>;
 #head?: StatementSync;
 #forgetIds = new Map<string, number>();
 constructor(host: string, cacheDir: string) {
  this.host = host; this.cacheDir = cacheDir; acquire(); opened.set(cacheDir, (opened.get(cacheDir) ?? 0) + 1);
  // Init only creates missing tables, so a saved sessions table needs no Worker before the first read.
  if (existsSync(join(cacheDir, "working-set.sqlite"))) {
   try { this.db = readWorkingSet(cacheDir); this.#head = this.db.prepare('SELECT data FROM sessions WHERE path=?'); }
   catch { this.db?.close(); this.db = undefined!; this.#head = undefined; }
  }
  this.ready = request<void>({ op: "init", cacheDir }).then(() => {
   if (this.#closed) throw new Error("Working set stopped");
   this.db ??= readWorkingSet(cacheDir);
  });
  // Without a saved database nothing is derived yet: reads before init answer empty instead of waiting for the Worker.
  this.readable = Promise.resolve();
  // close() may cancel initialization before a caller waits for readiness.
  void this.ready.catch(() => {});
 }
 #reading = false;
 // Publication can compose several reads under one WAL snapshot. Nested pages
 // share it, so a worker commit cannot pair a new page with an old derived head.
 snapshot<T>(run: () => T): T {
  if (this.#reading || !this.db) return run();
  this.db.exec("BEGIN"); this.#reading = true;
  try { return run(); } finally { this.#reading = false; this.db.exec("ROLLBACK"); }
 }
 load(path: string): Derived | undefined { if (!this.db) return undefined; const row = (this.#head ??= this.db.prepare('SELECT data FROM sessions WHERE path=?')).get(path); return row ? JSON.parse(String(row.data)) : undefined; }
 refresh(source: Source, onStart?: () => void, urgent = false): Promise<Derived | null> {
  return trackDerive(async () => {
   await this.ready;
   if (this.#closed) throw new Error("Working set stopped");
   ingestions++;
   return request<Derived | null>({ op: "derive", source, ...(urgent ? { urgent } : {}) }, undefined, onStart);
  });
 }
 /** Moves a queued derivation of this Session ahead of the cold backlog. */
 urgent(source: Source): void { worker?.postMessage({ op: "urgent", cacheDir: source.cacheDir, path: source.path }); }
 search(query: string) { return fleetSearch(this.db, query); }
 async find(source: Source, query: string, version: string): Promise<SearchResult> {
  await this.ready;
  if (this.#closed) throw new Error("Working set stopped");
  return request<SearchResult>({ op: "find", source, query, version });
 }
 invalidate(source: Source) { windows.delete(cacheKey(source)); }
 live(source: Source, live: boolean) { const w = windows.get(cacheKey(source)); if (w) { w.live = live; trim(); } }
 tail(source: Source, data: Derived, live: boolean) {
  const key = cacheKey(source), hit = windows.get(key);
  if (hit?.value.version === data.version) { windows.delete(key); hit.live = live; windows.set(key, hit); trim(); return hit.value; }
  const value = this.page(source.path, { version: data.version });
  windows.delete(key); windows.set(key, { value, bytes: Buffer.byteLength(JSON.stringify(value)), live }); trim();
  return value;
 }
 page(path: string, args: { before?: string; around?: string; limit?: number; version?: string } = {}) { return this.snapshot(() => this.#page(path, args)); }
 #page(path: string, { before, around, limit = WINDOW_ENTRIES, version }: { before?: string; around?: string; limit?: number; version?: string } = {}) {
  const data = this.load(path);
  if (!data) throw new Error("This Session is not indexed yet");
  if (version && version !== data.version) throw new Error("History changed; refresh this Session");
  let end = Number.MAX_SAFE_INTEGER;
  if (before || around) {
   const row = this.db.prepare('SELECT position FROM entries WHERE path=? AND id=?').get(path, (before ?? around)!);
   if (!row) throw new Error("Entry is not on the current branch");
   end = Number(row.position) + (around ? 21 : 0);
  }
  limit = Math.max(1, Math.min(WINDOW_ENTRIES, limit));
  const rows = this.db.prepare("SELECT ui FROM entries WHERE path=? AND position < ? AND ui <> 'null' ORDER BY position DESC LIMIT ?").all(path, end, limit + 1);
  const entries: PiEntry[] = []; let size = 0;
  for (const row of rows.slice(0, limit)) {
   const text = String(row.ui), bytes = Buffer.byteLength(text);
   if (size + bytes > WINDOW_BYTES - 1024) break;
   entries.push(JSON.parse(text)); size += bytes;
  }
  return { entries: entries.reverse(), more: rows.length > entries.length, version: data.version };
 }
 #outlines = new Map<string, ThreadOutline>();
 /** Navigation reads compact indexed rows once per version, never transcript bodies or paint windows. */
 outline(path: string): ThreadOutline {
  return this.snapshot(() => {
   const data = this.load(path);
   if (!data) throw new Error("This Session is not indexed yet");
   const cached = this.#outlines.get(path);
   if (cached?.version === data.version) return cached;
   const totalEntries = Number(this.db.prepare("SELECT count(*) AS n FROM entries WHERE path=? AND ui IS NOT NULL AND ui <> 'null'").get(path)!.n);
   const rows = this.db.prepare(`WITH ordered AS (
    SELECT id, ui, row_number() OVER (ORDER BY position)-1 AS ordinal FROM entries WHERE path=? AND ui IS NOT NULL AND ui <> 'null'
   ) SELECT id, ordinal, substr(json_extract(ui,'$.text'),1,120) AS text FROM ordered
   WHERE json_extract(ui,'$.kind')='user' ORDER BY ordinal DESC LIMIT 2001`).all(path);
   const value: ThreadOutline = { version: data.version, totalEntries, truncated: rows.length > 2000,
    users: rows.slice(0,2000).reverse().map(row => ({id:String(row.id),ordinal:Number(row.ordinal),firstLine:String(row.text ?? "").split(/\r?\n/,1)[0]!.slice(0,120)})) };
   this.#outlines.delete(path);this.#outlines.set(path,value);
   if (this.#outlines.size > 32) this.#outlines.delete(this.#outlines.keys().next().value!);
   return value;
  });
 }
 nearest(path: string, at: number): string | undefined {
  const row = this.db.prepare("SELECT id FROM entries WHERE path=? AND t IS NOT NULL AND ui <> 'null' ORDER BY abs(t - ?) LIMIT 1").get(path, at);
  return row ? String(row.id) : undefined;
 }
 rarebits(path: string, revision: number, before?: string, fullText = false): RarebitValue { return this.snapshot(() => this.#rarebits(path, revision, before, fullText)); }
 #rarebits(path: string, revision: number, before?: string, fullText = false): RarebitValue {
  const data = this.load(path); if (!data) throw new Error("This Session is not indexed yet");
  if (data.invalidLines) throw new Error("The local Session copy could not be read. Reconnect the Host to receive new Session bytes.");
  const position = before ? this.db.prepare('SELECT position FROM entries WHERE path=? AND id=?').get(path, before)?.position : undefined;
  const items: RarebitItem[] = []; let chars = 0;
  for (const row of this.db.prepare('SELECT rarebit FROM entries WHERE path=? AND position < ? AND rarebit IS NOT NULL ORDER BY position DESC LIMIT 401').iterate(path, position ?? Number.MAX_SAFE_INTEGER)) {
   if (items.length >= 400 || chars >= 200_000) break;
   const item = JSON.parse(String(row.rarebit)) as RarebitItem;
   if (!fullText && item.text.length > 8192) { item.text = item.text.slice(0, 8192); item.truncated = true; }
   items.push(item); chars += item.text.length;
  }
  items.reverse();
  const first = items[0]?.id;
  const more = Boolean(first && this.db.prepare('SELECT 1 FROM entries WHERE path=? AND rarebit IS NOT NULL AND position < (SELECT position FROM entries WHERE path=? AND id=?) LIMIT 1').get(path, path, first));
  return { ...data.rarebit, items, revision, more, sourceVersion: data.version };
 }
 rarebitSnapshot(path: string, maxChars: number) { return this.snapshot(() => this.#rarebitSnapshot(path, maxChars)); }
 #rarebitSnapshot(path: string, maxChars: number) {
  const data = this.load(path); if (!data || data.invalidLines) throw new Error("The local Session copy could not be read");
  const names = { user: "USER", continuation: "AGENT-NOTE", stop: "AGENT-FINAL" };
  const hash = createHash("sha256");
  let context = "", total = 0, count = 0, included = 0, entry: string | undefined;
  for (const row of this.db.prepare('SELECT rarebit FROM entries WHERE path=? AND rarebit IS NOT NULL ORDER BY position DESC').iterate(path)) {
   const item = JSON.parse(String(row.rarebit)) as RarebitItem;
   if (!(item.kind in names)) continue;
   count++; entry ??= item.id;
   const line = JSON.stringify({ entry: item.id, kind: names[item.kind as keyof typeof names], text: item.text });
   hash.update(`${Buffer.byteLength(line)}:`).update(line);
   total += line.length + (count > 1 ? 1 : 0);
   if (context.length < maxChars) { context = `${line}${context ? `\n${context}` : ""}`.slice(-maxChars); included++; }
  }
  if (!count) throw new Error("No Rarebits yet. Wait for a human message or agent prose, then retry.");
  return { context, evidenceHash: hash.digest("hex"), count, included, omittedChars: Math.max(0, total - maxChars), entry };
 }
 entryTimes(path: string, ids: string[]): Map<string, number | null> {
  const get = this.db.prepare("SELECT t FROM entries WHERE path=? AND id=?");
  return new Map(ids.map((id) => { const t = get.get(path, id)?.t; return [id, typeof t === "number" ? t : null]; }));
 }
 arcEvidence(path: string, ids: string[], version?: string): Map<string, string> {
  return this.snapshot(() => {
   if (version && this.load(path)?.version !== version) throw new Error("Arc source changed; retry Build");
   const get = this.db.prepare("SELECT text FROM arc_evidence WHERE path=? AND id=?");
   return new Map(ids.map((id) => [id, String(get.get(path, id)?.text ?? "")]));
  });
 }
 // The full entry is decoded through the shared reader by its exact source offset in the
 // index and leaves the hub only as its projected, allow-listed view: JSON text in UTF-8
 // pages of ENTRY_PAGE_BYTES. The caller joins the pages of one version and parses them.
 entry(source: Source, id: string, offset = 0, version?: string): { text: string; next: number; more: boolean; version: string } {
  // The reader below writes the copy's index file in this cache, so a closed store must not reach it.
  if (this.#closed) throw new Error("Working set stopped");
  const data = this.load(source.path); if (!data) throw new Error("Session unavailable");
  if (version && version !== data.version) throw new Error("Entry changed; refresh this Session");
  const row = this.db.prepare('SELECT id FROM entries WHERE path=? AND id=?').get(source.path, id);
  if (!row) throw new Error("Entry is not on the current branch");
  const reader = openPiSessionRange(source.file, { host: source.host, indexPath: `${source.file}.index.sqlite` });
  try {
   if (derivedVersion(reader.info().version) !== data.version) throw new Error("Source changed; retry after indexing completes");
   const projected = projectEntry(reader.entry(id, { full: true }));
   if (!projected) throw new Error("Entry has no transcript view");
   const bytes = Buffer.from(JSON.stringify(wireEntry(projected)));
   let start = Math.min(bytes.length, Math.max(0, Math.floor(offset))), end = Math.min(bytes.length, start + ENTRY_PAGE_BYTES);
   while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
   while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
   return { text: bytes.subarray(start, end).toString("utf8"), next: end, more: end < bytes.length, version: data.version };
  }
  finally { reader.close(); }
 }
 forgotten(): Record<string, unknown> { return Object.fromEntries(this.db.prepare("SELECT path,watermark FROM evicted WHERE watermark IS NOT NULL").all().map((r) => [String(r.path), JSON.parse(String(r.watermark))])); }
 expired(id: string): string | undefined { const row = this.db.prepare("SELECT ref FROM evicted WHERE id=?").get(id); return row ? String(row.ref) : undefined; }
 async forget(source: Source, watermark?: unknown): Promise<boolean> {
  if (this.#closed) throw new Error("Working set stopped");
  const data = this.load(source.path);
  if (!data) return false;
  try {
   const removed = await request<boolean>({ op: "forget", source, version: data.version, watermark }, (id) => this.#forgetIds.set(source.path, id));
   if (removed) this.invalidate(source);
   return removed;
  } finally { this.#forgetIds.delete(source.path); }
 }
 cancelForget(source: Source): void {
  const id = this.#forgetIds.get(source.path);
  if (id !== undefined) worker?.postMessage({ op: "cancel", id });
 }
 /**
  * How long a close waits for the Worker's active job on this cache before it stops waiting.
  * terminate() cannot cut a native SQLite call, so a last close can take CLOSE_MS plus the
  * busy timeout (8 s), under the deploy script's 10 s stop check.
  */
 static CLOSE_MS = 3000;
 /** A close that waits longer than this logs one line. */
 static SLOW_CLOSE_MS = 1000;
 /**
  * Resolves when no thread in this process writes this cache: the Worker has dropped the
  * cache's queued jobs and backfill, and its active job there has closed its database.
  * The read handle closes first, so the Worker's last close can remove the WAL files.
  * After CLOSE_MS the last owner terminates the Worker. A store that shares the Worker
  * stops waiting instead; the Worker takes no new job for the cache, but a job that is
  * still running can write to its open database until it ends.
  */
 close(): Promise<void> { return this.#closing ??= this.#close(); }
 async #close() {
  this.#closed = true;
  for (const key of windows.keys()) if (key.startsWith(`${this.host}\0`)) windows.delete(key);
  this.db?.close();
  const left = opened.get(this.cacheDir)! - 1, started = performance.now();
  if (left) opened.set(this.cacheDir, left); else opened.delete(this.cacheDir);
  let timer: NodeJS.Timeout | undefined, expired = false, job: string | null = null;
  try {
   // The answer names the job the Worker waited for.
   if (!left && worker) job = await Promise.race([
    request<string | null>({ op: "close", cacheDir: this.cacheDir }).catch(() => null),
    new Promise<string | null>((resolve) => { timer = setTimeout(() => { expired = true; resolve(null); }, WorkingSet.CLOSE_MS); }),
   ]);
  } finally {
   clearTimeout(timer);
   if (expired) job = [...pending.values()].find((p) => p.started && jobDir(p.job) === this.cacheDir)?.job.op ?? null;
   await release();
   const waited = performance.now() - started;
   if (waited > WorkingSet.SLOW_CLOSE_MS) console.error(`working set: close waited ${Math.round(waited)} ms for ${this.cacheDir}, ${job ?? "no"} job${expired ? ", stopped waiting" : ""}`);
  }
 }
}
