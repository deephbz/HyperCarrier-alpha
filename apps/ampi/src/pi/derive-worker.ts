// One bounded ingestion worker for the hub. No source bodies cross its message port.
import { createHash } from "node:crypto";
import { parentPort } from "node:worker_threads";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { selectRarebits, measureRarebits } from "@hypercarrier/rarebit/core";
import { getImportedRarebitEntryIds } from "@hypercarrier/rarebit/fork-lineage";
// @ts-ignore: shared reader is plain ESM.
import { openPiSessionRange } from "../../../trace-analytics/src/sources/transcript-range.mjs";
import { indexProse, forgetSearch, forgetSearchBatch, findInSession, backfillSearch } from "./search.ts";
import { openWorkingSet } from "./working-set-db.ts";
import { derivedVersion, sameIndex, SUMMARY_VERSION, PROSE_CHARS, MESSAGE_CHARS, TOOL_CHARS, TOOL_ARGS_CHARS, indexFile, type Source, type Derived, type WorkerJob } from "./working-set-types.ts";
import { projectEntry } from "./projection.ts";
import { boundToolArgs, clipInjected } from "../shared/entry-shapes.ts";
import type { ToolArgsPreview } from "../shared/protocol.ts";
import { OpenCalls } from "../shared/tool-state.ts";
import { chunkSession } from "./views/cos-arc-chunks.ts";
import type { PiReaderEntry } from "./views/types.ts";
import type { Kinds, RarebitItem } from "./views/rarebit.ts";
import { complete, flushTrace, nameThread, nowUs, tracing } from "../trace.ts";

const kinds = (): Kinds => ({ user: 0, continuation: 0, stop: 0, toolCalls: 0, toolResults: 0, thinking: 0, summary: 0, other: 0 });
const positive = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
// The reader sets a missing price to null; a cost object or number may also arrive, and totals skip anything else.
const costOf = (u: PiReaderEntry["usage"]) => positive(typeof u?.cost === "number" ? u.cost : u?.cost?.total);
const hasPrice = (u: PiReaderEntry["usage"]) => { const c = typeof u?.cost === "number" ? u.cost : u?.cost?.total; return typeof c === "number" && Number.isFinite(c); };
const parse = <T,>(x: unknown): T => JSON.parse(String(x));
const body = (e: PiReaderEntry) => e.blocks?.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n") ?? e.text ?? "";

// Path and command keys name a tool call's target; a bounded value keeps only them.
function targetArgs(raw: Record<string, unknown>) {
 const args: Record<string, unknown> = {};
 for (const key of ["path", "file_path", "filePath", "file", "target", "dir", "directory", "cwd", "command"]) {
  if (typeof raw[key] === "string") args[key] = raw[key].slice(0, key === "command" ? 2000 : 220);
 }
 if (Array.isArray(raw.paths)) args.paths = raw.paths.filter((p) => typeof p === "string").map((p: string) => p.slice(0, 220));
 return args;
}

function compact(e: PiReaderEntry): PiReaderEntry {
 const value = { ...e, bodyChars: body(e).length };
 value.text = e.text?.slice(0, 700); value.summary = e.summary?.slice(0, 700); value.error = e.error?.slice(0, 140);
 if (e.result) value.result = { ...e.result, text: e.result.text.slice(0, 140) };
 if (e.blocks) value.blocks = e.blocks.map((b) => {
  if (b.type !== "toolCall") return { ...b, text: b.text?.slice(0, 700) };
  return { ...b, args: targetArgs((b.args ?? {}) as Record<string, unknown>) };
 });
 return value;
}

// A tool result, custom entry or compaction summary is one card with its own bound.
const OWN_BOUND: Record<string, [key: string, limit: number]> = { "tool-result": ["text", TOOL_CHARS], compaction: ["summary", PROSE_CHARS] };

// The entry disclosure means visible prose was cut. Tool arguments, thinking and
// own-bound cards shorten in place and mark themselves, so the UI offers the source there.
function preview(e: PiReaderEntry) {
 const p = projectEntry(e as never);
 if (!p) return null;
 if (p.kind === "custom") {
  const { message, clipped } = clipInjected(p.message, PROSE_CHARS);
  return clipped ? { ...p, message, clipped: true, clippedBytes: Buffer.byteLength(e.text ?? body(e)) } : p;
 }
 const own = OWN_BOUND[p.kind];
 if (own) {
  const [key, limit] = own, out = { ...p } as Record<string, any>;
  const full: unknown = p.kind === "tool-result" ? e.result?.text ?? e.text : out[key];
  if (typeof full === "string" && full.length > limit) Object.assign(out, { [key]: full.slice(0, limit), clipped: true, clippedBytes: Buffer.byteLength(full) });
  if (p.kind === "tool-result") out.truncated = Boolean(out.clipped);
  return out;
 }
 let budget = MESSAGE_CHARS, shortened = false;
 const clip = (s: string) => { const out = s.slice(0, budget); budget -= out.length; shortened ||= out.length < s.length; return out; };
 const out = { ...p } as Record<string, any>;
 for (const key of ["text", "summary", "error"]) if (typeof out[key] === "string") out[key] = clip(out[key]);
 if (Array.isArray(out.blocks)) {
  shortened ||= out.blocks.length > 16;
  out.blocks = out.blocks.slice(0, 16).map((b: Record<string, any>) => {
   if (b.type === "tool") {
    const { args, clipped } = boundToolArgs(b.args as ToolArgsPreview, TOOL_ARGS_CHARS);
    return clipped ? { ...b, args, argsClipped: true } : b;
   }
   if (b.type === "thinking") return b.text.length <= PROSE_CHARS ? b : { ...b, text: b.text.slice(0, PROSE_CHARS), clipped: true };
   return typeof b.text === "string" ? { ...b, text: clip(b.text) } : b;
  });
 }
 out.bodyAvailable = shortened || Boolean(out.truncated);
 if (out.bodyAvailable) out.truncated = true;
 return out;
}

/**
 * The positive token budget of one native `auto-compact.budget` entry, else undefined. The override is optional, so a
 * failed read (no offset, a changed source) gives the default budget and does not fail the derive.
 */
export function overrideTokens(reader: any, id: string): number | undefined {
 try {
  const chunk = reader.entryBytes(id) as { text: string; more: boolean };
  if (chunk.more) return undefined;
  const tokens = JSON.parse(chunk.text)?.data?.tokens;
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
 } catch { return undefined; }
}

function derive(source: Source, reader: any, db: ReturnType<typeof openWorkingSet>, version: string, started: number): Derived {
 const session = reader.session();
 const records: PiReaderEntry[] = [], nativeMeta: any[] = [], occurrences: any[] = [], rarebitChars = new Map<string, number>();
 const buckets = new Map<number, [number, number, number]>(), hints: [number, string][] = [], marks: [number, string, "stop" | "error"][] = [];
 let whole = kinds(), live = kinds(), totalChars = 0, rareChars = 0, count = 0, cost = 0, staleItems = 0, priced = false;
 const rarebitHash = createHash("sha256");
 let model: string | undefined, budgetEntry: string | undefined, contextTokens: number | undefined, cacheHit: number | undefined, lastPreview: string | undefined;
 let lastUser = -1, lastStop = -1, selector = "", title = session.title;
 const open = new OpenCalls();
 const counts = { user: 0, continuation: 0, stop: 0, compactions: 0 };
 for (const row of db.prepare('SELECT * FROM entries WHERE path=? ORDER BY position').iterate(source.path)) {
  const e = parse<PiReaderEntry>(row.feature), occurrence = row.occurrence ? parse<any>(row.occurrence) : null;
  const meta = parse<{ type?: string; model?: string; customType?: string }>(row.native_meta);
  records.push(e); nativeMeta.push(meta); count++;
  // Pi's setModel (`/model`) writes model_change before any turn uses it; the latest of either names the model.
  if (meta.type === "model_change" && meta.model) model = meta.model;
  // hc-auto-compact reads the latest `auto-compact.budget` entry on the branch; its value is read once after the loop.
  if (meta.customType === "auto-compact.budget") budgetEntry = e.id;
  if (occurrence) {
   occurrences.push(occurrence);
   if (occurrence.outcome === "user") lastUser = count;
   if (occurrence.outcome === "stop") lastStop = count;
  }
  // Pi's getContextUsage: a compaction makes the context size unknown until a later response measures it.
  if (e.kind === "compaction") { counts.compactions++; live = kinds(); contextTokens = undefined; }
  const chars = parse<Kinds>(row.kinds);
  for (const key of Object.keys(whole) as (keyof Kinds)[]) { whole[key] += chars[key]; live[key] += chars[key]; }
  totalChars += Number(row.totalchars); rareChars += Number(row.rarechars);
  if (Number(row.rarechars) > 0) rarebitChars.set(e.id, Number(row.rarechars));
  if (row.rarebit) {
   const r = parse<RarebitItem>(row.rarebit);
   if (r.kind === "user" || r.kind === "stop" || r.kind === "continuation") counts[r.kind]++;
   // A compaction restarts the agent's context, so it makes a built Arc stale like a new message does.
   if (r.kind !== "error") { staleItems++; rarebitHash.update(JSON.stringify([r.id, r.kind, r.text])); }
  }
  cost += positive(costOf(e.usage)); priced ||= hasPrice(e.usage);
  // The reader's names for the turn, call and result evidence that projectEntry maps to user, tool and tool-result.
  if (e.kind === "human") open.add({ kind: "user" });
  else if (e.kind === "assistant") open.add({ kind: "assistant", stop: e.stop, blocks: (e.blocks ?? []).map((b) => b.type === "toolCall" ? { type: "tool", callId: String(b.id) } : b) });
  else if (e.kind === "tool" && e.result) open.add({ kind: "tool-result", callId: e.result.callId });
  if (e.kind === "assistant") {
   // Provider-qualified, as the pi-durable projection and hc-hud's alias keys name a model.
   if (e.model) model = e.provider ? `${e.provider}/${e.model}` : e.model;
   // Aborted, failed and all-zero responses measure nothing, as Pi skips them.
   const usage = e.stop === "aborted" || e.stop === "error" ? undefined : e.usage;
   const measured = usage ? positive(usage.input) + positive(usage.output) + positive(usage.cacheRead) + positive(usage.cacheWrite) : 0;
   if (usage && measured > 0) {
    contextTokens = measured;
    const prompt = positive(usage.input) + positive(usage.cacheRead) + positive(usage.cacheWrite);
    cacheHit = prompt > 0 ? 100 * positive(usage.cacheRead) / prompt : undefined;
   }
  }
  if (e.kind === "human" || e.kind === "assistant") { const text = body(e); if (text) lastPreview = text.slice(0, 160); }
  const t = Number(row.t);
  if (row.t != null && Number.isFinite(t)) {
   hints.push([t, e.id]);
   const time = Math.floor(t / 900_000) * 900_000, b = buckets.get(time) ?? [time, 0, 0];
   b[1] += positive(e.usage?.input) + positive(e.usage?.output) + positive(e.usage?.cacheRead) + positive(e.usage?.cacheWrite);
   b[2] += positive(costOf(e.usage)); buckets.set(time, b);
   if (occurrence?.outcome === "stop") marks.push([t, e.id, "stop"]);
   if (e.role === "assistant" && e.stop === "error") marks.push([t, e.id, "error"]);
  }
 }
 // The index keeps no custom data, so read the one override entry; `tokens: null` restores the default.
 const budgetOverride = budgetEntry ? overrideTokens(reader, budgetEntry) : undefined;
 // The published selector decides occurrence semantics; this probe supplies its version.
 selector = String(selectRarebits([]).manifest.selectorVersion);
 const imported = getImportedRarebitEntryIds(nativeMeta);
 const inheritedBefore = session.header?.parentSession ? Date.parse(session.header.timestamp ?? "") - 1000 : NaN;
 const arc = chunkSession(records, { selection: { occurrences }, imported, inheritedBefore, rarebitChars }, session.cwd ?? "");
 db.prepare('DELETE FROM arc_evidence WHERE path=?').run(source.path);
 const putEvidence = db.prepare('INSERT INTO arc_evidence VALUES (?,?,?)');
 let inputChars = 0;
 for (const [id, text] of arc.evidence) { putEvidence.run(source.path, id, text); inputChars += text.length; }
 hints.sort((a, b) => a[0] - b[0]); marks.sort((a, b) => a[0] - b[0]);
 const sampled = hints.length <= 64 ? hints : Array.from({ length: 64 }, (_, i) => hints[Math.round(i * (hints.length - 1) / 63)]!);
 const tokens = (value: Kinds) => Object.fromEntries(Object.entries(value).map(([key, n]) => [key, Math.ceil(n / 4)])) as Kinds;
 return {
  version, summaryVersion: SUMMARY_VERSION, bytes: reader.info().bytes, asOf: Date.now(), invalidLines: reader.info().invalidLines, count, tip: session.tip,
  session: { id: session.id, session: session.id.slice(3), ref: session.ref, cwd: session.cwd, started: session.started, updated: session.updated, title },
  cost, priced, ...(model ? { model } : {}), ...(budgetOverride ? { budgetOverride } : {}), ...(contextTokens ? { contextTokens } : {}), ...(cacheHit !== undefined ? { cacheHit } : {}), ...(lastPreview ? { preview: lastPreview } : {}),
  ...(open.ids.size ? { openCalls: open.ids.size } : {}),
  timeline: { start: hints[0]?.[0] ?? 0, end: hints.at(-1)?.[0] ?? 0, entries: sampled, entryCount: count,
   omittedHints: hints.length - sampled.length, marks: marks.slice(-256), omittedMarks: Math.max(0, marks.length - 256),
   stopped: marks.at(-1)?.[2] === "stop" && lastStop > lastUser, priced, buckets: [...buckets.values()].sort((a, b) => a[0] - b[0]) },
  arc: { chunks: arc.chunks, excludedEntries: arc.excludedEntries, shortenedChunks: arc.shortenedChunks, inputChars },
  rarebit: { stats: { ...counts, rarebitTokens: Math.ceil(rareChars / 4), totalTokens: Math.ceil(totalChars / 4), ratio: totalChars ? rareChars / totalChars : null },
   diagnosis: { session: tokens(whole), live: tokens(live), entries: count, ms: Math.round(performance.now() - started) }, selector,
   count: staleItems, fingerprint: rarebitHash.digest("hex") },
 };
}

export async function materialize(source: Source): Promise<Derived | null> {
 const started = performance.now(), reader = openPiSessionRange(source.file, { host: source.host, indexPath: indexFile(source) });
 const db = openWorkingSet(source.cacheDir);
 try {
  const previousRow = db.prepare('SELECT data FROM sessions WHERE path=?').get(source.path);
  const previous = previousRow ? parse<Derived>(previousRow.data) : null;
  const change = await reader.refresh();
  if (!reader.session()) return null;
  const version = derivedVersion(change.version);
  if (previous?.version === version && previous.summaryVersion === SUMMARY_VERSION) return previous;
  const rebuild = change.reset || !previous || !sameIndex(previous.version);
  db.exec('BEGIN IMMEDIATE');
  try {
   if (rebuild) { db.prepare('DELETE FROM entries WHERE path=?').run(source.path); forgetSearch(db, source.path); }
   const put = db.prepare('INSERT OR REPLACE INTO entries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
   reader.visit(({ native, entry: e, position }: { native: any; entry: PiReaderEntry; position: number }) => {
    indexProse(db, source.path, e);
    const selection = selectRarebits([native]);
    const occurrence = selection.occurrences[0];
    if (occurrence?.outcome === "user" && e.kind !== "human") selection.occurrences = [];
    const chosen = selection.occurrences[0];
    const measurement = measureRarebits([native], selection) as { totalMessageProseChars: number; rarebitChars: number };
    let item: RarebitItem | null = chosen?.sourceEntryId ? { id: chosen.sourceEntryId, kind: chosen.outcome, t: chosen.timestamp, text: chosen.text } as RarebitItem : null;
    if (e.kind === "compaction") item = { id: e.id, kind: "compaction", t: native.timestamp ?? null, text: "Context restarts here" };
    if (e.role === "assistant" && e.stop === "error") item = { id: e.id, kind: "error", t: native.timestamp ?? null, text: e.error || "The agent reported a terminal error." };
    const chars = kinds();
    if (native.type === "compaction") chars.summary += String(native.summary ?? "").length;
    const m = native.message;
    for (const b of typeof m?.content === "string" ? [{ type: "text", text: m.content }] : m?.content ?? []) {
     if (b.type === "thinking") chars.thinking += String(b.thinking ?? b.text ?? "").length;
     else if (b.type === "toolCall") chars.toolCalls += JSON.stringify(b.arguments ?? b.args ?? {}).length + String(b.name ?? "").length;
     else if (b.type === "text") chars[m.role === "toolResult" ? "toolResults" : chosen?.outcome as keyof Kinds ?? "other"] += String(b.text ?? "").length;
    }
    const metadata = { id: native.id, type: native.type,
     ...(native.type === "model_change" && native.modelId ? { model: native.provider ? `${native.provider}/${native.modelId}` : String(native.modelId) } : {}),
     ...(native.rarebitFork ? { rarebitFork: { version: native.rarebitFork.version, kind: native.rarebitFork.kind } } : {}),
     ...(native.type === "custom" ? { customType: native.customType, data: { schemaVersion: native.data?.schemaVersion,
      opening: { seedEntryId: native.data?.opening?.seedEntryId }, importedEntryIds: native.data?.importedEntryIds } } : {}) };
    put.run(source.path, e.id, position, e.t, JSON.stringify(preview(e)), JSON.stringify(compact(e)),
     occurrence ? JSON.stringify({ sourceEntryId: occurrence.sourceEntryId, outcome: occurrence.outcome, timestamp: occurrence.timestamp, text: occurrence.text.slice(0, 700) }) : null,
     JSON.stringify(metadata), item ? JSON.stringify(item) : null, measurement.totalMessageProseChars, measurement.rarebitChars, JSON.stringify(chars));
   }, rebuild ? {} : { after: previous.tip });
   const derived = derive(source, reader, db, version, started);
   db.prepare('DELETE FROM evicted WHERE path=?').run(source.path);
   db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?)').run(source.path, JSON.stringify(derived));
   db.exec('COMMIT'); return derived;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
 } finally { reader.close(); db.close(); }
}

async function forget(source: Source, version: string, watermark?: unknown): Promise<boolean> {
 const db = openWorkingSet(source.cacheDir);
 const transaction = <T,>(run: () => T): T => {
  db.exec("BEGIN IMMEDIATE");
  try { const value = run(); db.exec("COMMIT"); return value; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
 };
 try {
  const row = db.prepare("SELECT data FROM sessions WHERE path=?").get(source.path);
  const data = row ? parse<Derived>(row.data) : null;
  if (!data || data.version !== version) return false;
  // Unpublish atomically. Partial physical cleanup cannot leave searchable heads.
  transaction(() => {
   db.prepare("INSERT OR REPLACE INTO evicted VALUES (?,?,?,?)").run(source.path, data.session.id, data.session.ref, watermark ? JSON.stringify(watermark) : null);
   db.prepare("DELETE FROM sessions WHERE path=?").run(source.path);
  });
  const batch = 128;
  while (transaction(() => forgetSearchBatch(db, source.path, batch))) await yieldLoop();
  for (const table of ["entries", "arc_evidence"]) {
   const remove = db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE path=? LIMIT ?)`);
   while (transaction(() => Number(remove.run(source.path, batch).changes))) await yieldLoop();
  }
  return true;
 } finally { db.close(); }
}

if (parentPort) {
 nameThread("derive-worker");
 type Job = WorkerJob & { id: number };
 const queue: Job[] = [];
 let active = false;
 // Lowest rank first, FIFO within a rank. A cold backlog never delays a search, a
 // changed, live or open Session, or the retirement of eligible heads.
 const rank = (job: Job) => job.op === "init" ? 0 : job.op === "find" ? 1 : job.op === "derive" ? job.urgent ? 2 : 4 : 3;
 // Each cache's prose_path backfill runs one bounded step between jobs, so jobs
 // keep moving and no write transaction outlasts one step.
 const backfills = new Set<string>(), seen = new Set<string>(), retries = new Map<string, NodeJS.Timeout>();
 // A closed cache takes no new job or backfill step until a later init reopens it. Its close
 // answers once the active job for that cache has closed its database.
 const closed = new Set<string>(), waiting = new Map<string, number[]>();
 const dirOf = (job: Job) => job.op === "init" ? job.cacheDir : job.source.cacheDir;
 let stepNext = false, activeDir: string | undefined;
 const step = (cacheDir: string) => {
  try { const db = openWorkingSet(cacheDir); try { if (backfillSearch(db)) backfills.delete(cacheDir); } finally { db.close(); } }
  // forgetSearch keeps the scan path while the cursor remains, so a failed step only waits.
  catch {
   backfills.delete(cacheDir);
   retries.set(cacheDir, setTimeout(() => { retries.delete(cacheDir); backfills.add(cacheDir); void pump(); }, 5000).unref());
  }
 };
 const pump = async () => {
  if (active || !queue.length && !backfills.size) return;
  active = true;
  if (backfills.size && (stepNext || !queue.length)) {
   stepNext = false;
   const start = tracing ? nowUs() : 0;
   try { step(backfills.values().next().value!); } finally {
    active = false; setImmediate(() => void pump());
    if (tracing) { complete("backfill-step", "derive", start, { queued: queue.length }); flushTrace(); }
   }
   return;
  }
  stepNext = true;
  let at = 0;
  for (let i = 1; i < queue.length; i++) if (rank(queue[i]) < rank(queue[at])) at = i;
  const [message] = queue.splice(at, 1);
  const start = tracing ? nowUs() : 0;
  const dir = activeDir = dirOf(message);
  try {
   parentPort!.postMessage({ id: message.id, started: true });
   let data: unknown;
   switch (message.op) {
    case "init": openWorkingSet(message.cacheDir).close(); break;
    case "derive": data = await materialize(message.source); break;
    case "find": data = findInSession(message.source, message.query, message.version, message.ask); break;
    case "forget": data = await forget(message.source, message.version, message.watermark); break;
   }
   parentPort!.postMessage({ id: message.id, data });
  } catch (error) { parentPort!.postMessage({ id: message.id, error: (error as Error).message }); }
  finally {
   const answers = waiting.get(dir); waiting.delete(dir);
   for (const id of answers ?? []) parentPort!.postMessage({ id, data: message.op });
   active = false; activeDir = undefined; setImmediate(() => void pump());
   // The hub terminates this Worker without notice, so each job's events leave at once.
   if (tracing) { complete(message.op, "derive", start, { job: message.id, queued: queue.length }); flushTrace(); }
  }
 };
 parentPort.on("message", (message: Job | { op: "cancel"; id: number } | { op: "urgent"; cacheDir: string; path: string } | { op: "close"; id: number; cacheDir: string }) => {
  if (message.op === "close") {
   const dir = message.cacheDir;
   closed.add(dir); seen.delete(dir); backfills.delete(dir);
   clearTimeout(retries.get(dir)); retries.delete(dir);
   for (let i = queue.length; i--;) if (dirOf(queue[i]!) === dir) { parentPort!.postMessage({ id: queue[i]!.id, error: "Working set stopped" }); queue.splice(i, 1); }
   if (activeDir === dir) waiting.set(dir, [...waiting.get(dir) ?? [], message.id]);
   else parentPort!.postMessage({ id: message.id, data: null });
   return;
  }
  if (message.op === "urgent") {
   for (const job of queue) if (job.op === "derive" && job.source.cacheDir === message.cacheDir && job.source.path === message.path) job.urgent = true;
   return;
  }
  if (message.op === "cancel") {
   const at = queue.findIndex((job) => job.id === message.id && job.op === "forget");
   if (at >= 0) { queue.splice(at, 1); parentPort!.postMessage({ id: message.id, data: false }); }
   return;
  }
  const cacheDir = dirOf(message);
  if (message.op === "init") closed.delete(cacheDir);
  else if (closed.has(cacheDir)) { parentPort!.postMessage({ id: message.id, error: "Working set stopped" }); return; }
  if (!seen.has(cacheDir)) { seen.add(cacheDir); backfills.add(cacheDir); }
  queue.push(message);
  setImmediate(() => void pump());
 });
}
