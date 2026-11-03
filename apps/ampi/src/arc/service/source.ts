// Read original Session files through the published reader and Rarebit selector.
// Indexes are private and rebuildable. Only this Host proves a history change.
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { selectRarebits } from "@hypercarrier/rarebit/core";
import { selectTierB, OWNER_SELECTOR_VERSION } from "../../pi/rarebit-selection.ts";
import type { PiReaderEntry } from "../../pi/views/types.ts";
// @ts-ignore: the published reader is plain ESM.
import { openPiSessionRange } from "../../../../trace-analytics/src/sources/transcript-range.mjs";
import { fingerprint, type SourcePort, type SourceSnapshot, type ArcItem, type ArcEntry } from "../core/index.ts";

const positive = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
export function canonicalSessionRef(ref: string): string {
 const id = /(?:^|\/)pi:([A-Za-z0-9_.-]+)$/.exec(ref)?.[1];
 if (!id) throw new Error("Invalid Pi Session reference");
 return "pi:" + id;
}
export function piSource(options: { sessionsDir: string; storeDir: string }) {
 const paths = new Map<string, string>(), stamps = new Map<string, string>();
 const reads = new Map<string, Promise<SourceSnapshot>>();
 const selector = `${selectRarebits([]).manifest.selectorVersion}/${OWNER_SELECTOR_VERSION}`;
 function read(file: string, expected?: string): Promise<SourceSnapshot> {
  const prior = reads.get(file);
  const pending = (prior ?? Promise.resolve()).catch(() => {}).then(() => readFile(file, expected));
  reads.set(file, pending);
  return pending.finally(() => { if (reads.get(file) === pending) reads.delete(file); });
 }
 async function readFile(file: string, expected?: string): Promise<SourceSnapshot> {
  const reader = openPiSessionRange(file, { host: "source", indexPath: join(options.storeDir, "indexes", hash(file) + ".sqlite") });
  try {
   // Force validates interior rewrites, including same-length edits to old evidence.
   const changed = await reader.refresh({ force: true });
   const session = reader.session(); if (!session) throw new Error("Session header is unavailable");
   const ref = canonicalSessionRef(session.id);
   if (expected && expected !== ref) throw new Error("Session file identity changed");
   const items: ArcItem[] = [], entries: ArcEntry[] = [];
   reader.visit(({ native, entry }: { native: unknown; entry: PiReaderEntry }) => {
    const { item } = selectTierB(native, entry); if (item) items.push(item);
    const u = entry.kind === "assistant" ? entry.usage : undefined;
    entries.push({ id: entry.id, at: entry.t == null ? "" : new Date(entry.t).toISOString(),
     tokens: positive(u?.input) + positive(u?.output) + positive(u?.cacheRead) + positive(u?.cacheWrite),
     cost: positive(typeof u?.cost === "number" ? u.cost : u?.cost?.total) });
   });
   paths.set(ref, file);
   return { session: ref, selector, sourceVersion: hash(JSON.stringify([changed.version, selector, fingerprint(items), entries])), fingerprint: fingerprint(items), items, entries };
  } finally { reader.close(); }
 }
 async function files(dir: string): Promise<string[]> {
  let names;
  try { names = await readdir(dir, { withFileTypes: true }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const out: string[] = [];
  for (const name of names) {
   const file = join(dir, name.name);
   if (name.isDirectory()) out.push(...await files(file));
   else if (name.isFile() && name.name.endsWith(".jsonl")) out.push(file);
  }
  return out;
 }
 async function scan(): Promise<SourceSnapshot[]> {
  const changed: SourceSnapshot[] = [];
  for (const file of await files(options.sessionsDir)) {
   const s = await stat(file), stamp = `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
   if (stamps.get(file) === stamp) continue;
   try { changed.push(await read(file)); stamps.set(file, stamp); }
   catch { /* A partial write retries at the next poll. No cursor advances. */ }
  }
  return changed;
 }
 const port: SourcePort = {
  async snapshot(ref) {
   const canonical = canonicalSessionRef(ref);
   if (!paths.has(canonical)) await scan();
   const file = paths.get(canonical); if (!file) throw new Error("Session file is unavailable");
   return read(file, canonical);
  },
  async check(snapshot) {
   try {
    const current = await port.snapshot(snapshot.session);
    const prefix = current.items.slice(0, snapshot.items.length);
    const entries = current.entries.slice(0, snapshot.entries.length);
    return current.selector === snapshot.selector && fingerprint(prefix) === snapshot.fingerprint && JSON.stringify(entries) === JSON.stringify(snapshot.entries)
     ? { kind: "same-prefix" }
     : { kind: "history-changed", sourceVersion: current.sourceVersion, reason: "Authoritative Session history changed" };
   } catch (e) { return { kind: "unavailable", reason: (e as Error).message }; }
  },
 };
 return { ...port, scan };
}
