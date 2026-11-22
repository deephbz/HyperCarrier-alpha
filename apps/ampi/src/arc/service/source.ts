// Original Session bytes stay in the published reader. Arc owns only compact
// selection, retention and verification obligations. External use always proves a prefix.
import { createHash } from "node:crypto";
import { readdir, stat, rename, rm } from "node:fs/promises";
import { openSync, closeSync, fsyncSync } from "node:fs";
import { join, dirname } from "node:path";
import { selectRarebits } from "@hypercarrier/rarebit/core";
import { selectTierB, OWNER_SELECTOR_VERSION } from "../../pi/rarebit-selection.ts";
import type { PiReaderEntry } from "../../pi/views/types.ts";
// @ts-ignore: the published reader is plain ESM.
import { openPiSessionRange } from "../../../../trace-analytics/src/sources/transcript-range.mjs";
import { fingerprint, type SourcePort, type SourceSnapshot, type ArcItem, type ArcEntry } from "../core/index.ts";
import { sourceVerification, sourceStamp, stampKey, type SourceStamp, type SourceVerificationState, type VerificationSettings } from "./source-verification.ts";
export type { SourceStamp, SourceVerificationState } from "./source-verification.ts";

const positive = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
export function canonicalSessionRef(ref: string): string {
 const id = /(?:^|\/)pi:([A-Za-z0-9_.-]+)$/.exec(ref)?.[1];
 if (!id) throw new Error("Invalid Pi Session reference");
 return "pi:" + id;
}
type Projection = { version: string; tip: string | null; snapshot: SourceSnapshot; bytes: number };
type Visit = { native: unknown; entry: PiReaderEntry };
export function piSource(options: {
 sessionsDir: string; storeDir: string; now?: () => number;
 verification?: { load(): unknown; save(state: SourceVerificationState): void };
 verificationSettings?: () => VerificationSettings; log?: (message: string) => void;
}) {
 const now = options.now ?? Date.now, log = options.log ?? (() => {});
 const ledger = sourceVerification({ now, persistence: options.verification, settings: options.verificationSettings ?? (() => ({ bytesPerMinute: 64_000_000, intervalMs: 1_800_000 })) });
 const paths = new Map<string, string>(), stamps = new Map<string, string>();
 const reads = new Map<string, Promise<SourceSnapshot>>(), projections = new Map<string, Projection>(), evicted = new Map<string, number>();
 const proofs = new Map<string, { cursor: any; stamp: SourceStamp; version: string }>();
 const lastQuantum = new Map<string, number>(), yielded = new Set<string>();
 let quantum = 0, retainedBytes = 0, closed = false, periodic: Promise<boolean> | undefined, steppingFile: string | undefined;
 let repair: { file: string; stage: string; reader: any; cursor: any; stamp: SourceStamp; items: ArcItem[]; entries: ArcEntry[] } | undefined;
 const selector = `${selectRarebits([]).manifest.selectorVersion}/${OWNER_SELECTOR_VERSION}`;
 const index = (file: string) => join(options.storeDir, "indexes", hash(file) + ".sqlite");
 function drop(file: string, eviction = false) {
  const old = projections.get(file); if (old) retainedBytes -= old.bytes;
  projections.delete(file);
  if (old && eviction) evicted.set(file, now());
 }
 function retain(file: string, value: Projection) {
  drop(file);
  for (const [key, at] of evicted) if (now() - at > 600000) evicted.delete(key);
  if (evicted.has(file)) { log(`Arc source cache churn: ${value.snapshot.session} projected again within 10 minutes of eviction`); evicted.delete(file); }
  if (value.bytes > 16 * 1024 * 1024) return;
  projections.set(file, value); retainedBytes += value.bytes;
  while (projections.size > 16 || retainedBytes > 16 * 1024 * 1024) drop(projections.keys().next().value!, true);
 }
 function visit(items: ArcItem[], entries: ArcEntry[]) {
  return ({ native, entry }: Visit) => {
   const { item } = selectTierB(native, entry); if (item) items.push(item);
   const u = entry.kind === "assistant" ? entry.usage : undefined;
   entries.push({ id: entry.id, at: entry.t == null ? "" : new Date(entry.t).toISOString(),
    tokens: positive(u?.input) + positive(u?.output) + positive(u?.cacheRead) + positive(u?.cacheWrite),
    cost: positive(typeof u?.cost === "number" ? u.cost : u?.cost?.total) });
  };
 }
 function project(reader: any, ref: string, items: ArcItem[], entries: ArcEntry[]): Projection {
  const version = reader.info().version;
  const snapshot = { session: ref, selector, prefixWitness: JSON.stringify({ selector, session: ref, reader: reader.witness() }), sourceVersion: hash(JSON.stringify([version, selector, fingerprint(items), entries])), fingerprint: fingerprint(items), items, entries };
  return { version, tip: reader.session().tip, snapshot, bytes: Buffer.byteLength(JSON.stringify(snapshot)) };
 }
 function verified(file: string, ref: string, version: string, stamp: SourceStamp, observed = stamp) {
  const fact = ledger.state.sources[hash(file)] ??= { sessionRef: ref }, previous = structuredClone(fact);
  Object.assign(fact, { sessionRef: ref, verifiedVersion: version, verifiedAt: now(), verifiedStamp: stamp, observedStamp: observed, repairPending: false });
  delete fact.overdueLoggedAt;
  try { ledger.save(); } catch (error) { ledger.state.sources[hash(file)] = previous; throw error; }
 }
 async function discardRepair() {
  const pending = repair; repair = undefined;
  if (!pending) return;
  try { await pending.cursor.close(); } finally {
   pending.reader.close();
   await rm(pending.stage, { force: true }); await rm(pending.stage + "-journal", { force: true });
  }
 }
 async function cancelFor(file: string, deferRepair: boolean) {
  if (steppingFile === file) await periodic;
  // The joined quantum can discover a mismatch. Admission must recheck its result.
  if (deferRepair && ledger.state.sources[hash(file)]?.repairPending) throw Object.assign(new Error("Source repair is pending"), { code: "source-repair-pending" });
  proofs.get(file)?.cursor.close(); proofs.delete(file);
  if (repair?.file === file) await discardRepair();
 }
 function read(file: string, expected?: string, verify: "boundary" | "full" = "full", expectedPrefix?: string, deferRepair = verify === "boundary"): Promise<SourceSnapshot> {
  const prior = reads.get(file);
  const pending = (prior ?? Promise.resolve()).catch(() => {}).then(async () => {
   if (closed) throw new Error("Source is closed");
   if (deferRepair && ledger.state.sources[hash(file)]?.repairPending) throw Object.assign(new Error("Source repair is pending"), { code: "source-repair-pending" });
   await cancelFor(file, deferRepair);
   return readFile(file, expected, verify, expectedPrefix);
  });
  reads.set(file, pending);
  return pending.finally(() => { if (reads.get(file) === pending) reads.delete(file); });
 }
 async function readFile(file: string, expected: string | undefined, verify: "boundary" | "full", expectedPrefix?: string): Promise<SourceSnapshot> {
  const reader = openPiSessionRange(file, { host: "source", indexPath: index(file) });
  try {
   const before = sourceStamp(await stat(file)), cached = projections.get(file), previousVersion = reader.info().version;
   const condition = expectedPrefix === undefined ? undefined : JSON.parse(expectedPrefix) as { selector: string; session: string; reader: string };
   const baseline = !ledger.state.sources[hash(file)]?.verifiedVersion;
   const changed = await reader.refresh({ verify, force: baseline, expectedPrefix: condition?.reader });
   const session = reader.session(); if (!session) throw new Error("Session header is unavailable");
   const ref = canonicalSessionRef(session.id);
   if (expected && expected !== ref) throw new Error("Session file identity changed");
   const reuse = cached && !changed.reset && cached.version === previousVersion && cached.snapshot.selector === selector && cached.snapshot.session === ref;
   const items: ArcItem[] = reuse ? [...cached.snapshot.items] : [], entries: ArcEntry[] = reuse ? [...cached.snapshot.entries] : [];
   reader.visit(visit(items, entries), { after: reuse ? cached.tip : undefined });
   const value = project(reader, ref, items, entries), after = sourceStamp(await stat(file));
   paths.set(ref, file);
   const fact = ledger.state.sources[hash(file)] ??= { sessionRef: ref };
   fact.observedStamp = after;
   if (verify === "full" || changed.replayed) verified(file, ref, changed.version, before, after);
   else ledger.save();
   if (condition && (condition.selector !== selector || condition.session !== ref || changed.extendsExpected !== true)) {
    throw Object.assign(new Error("Authoritative Session no longer extends the expected prefix"), { code: "source-prefix", sourceVersion: value.snapshot.sourceVersion });
   }
   const result = structuredClone(value.snapshot);
   retain(file, value);
   return result;
  } catch (error) { drop(file); throw error; }
  finally { reader.close(); }
 }
 async function files(dir: string, signal?: AbortSignal): Promise<string[]> {
  if (signal?.aborted) return [];
  let names;
  try { names = await readdir(dir, { withFileTypes: true }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const out: string[] = [];
  for (const name of names) {
   if (signal?.aborted) break;
   const file = join(dir, name.name);
   if (name.isDirectory()) out.push(...await files(file, signal));
   else if (name.isFile() && name.name.endsWith(".jsonl")) out.push(file);
  }
  return out;
 }
 async function scan(signal?: AbortSignal): Promise<SourceSnapshot[]> {
  if (closed || ledger.fault) return [];
  const changed: SourceSnapshot[] = [];
  for (const file of await files(options.sessionsDir, signal)) {
   if (signal?.aborted || closed) break;
   const s = sourceStamp(await stat(file)), stamp = stampKey(s)!;
   if (signal?.aborted) break;
   const fact = ledger.state.sources[hash(file)];
   if (fact?.repairPending) {
    paths.set(fact.sessionRef, file); fact.observedStamp = s;
    continue;
   }
   if (stamps.get(file) === stamp) continue;
   try { changed.push(await read(file, undefined, "boundary")); stamps.set(file, stamp); }
   catch { /* A failed read returns no projection and advances no scan stamp. */ }
  }
  return changed;
 }
 function candidates() {
  return [...paths].map(([ref, file]) => ({ ref, file, fact: ledger.state.sources[hash(file)]! }))
   .filter(c => c.fact && !reads.has(c.file) && (c.fact.repairPending || stampKey(c.fact.observedStamp) !== stampKey(c.fact.verifiedStamp)));
 }
 function runnable(signal?: AbortSignal) { return !closed && !signal?.aborted && !ledger.fault && ledger.available() > 0 && candidates().length > 0; }
 async function periodicStep(signal?: AbortSignal): Promise<boolean> {
  if (closed || signal?.aborted || ledger.fault) return false;
  const settings = ledger.settings();
  const queue = candidates();
  for (const { ref, fact } of queue) {
   const age = now() - (fact.verifiedAt ?? 0);
   if (age >= settings.intervalMs && now() - (fact.overdueLoggedAt ?? -Infinity) >= settings.intervalMs) {
    log(`Arc source verification overdue: ${ref}; ageMs=${age}; bytesPending=${fact.observedStamp?.size ?? 0}`);
    fact.overdueLoggedAt = now(); ledger.save();
   }
  }
  queue.sort((a, b) => Number(yielded.has(a.file)) - Number(yielded.has(b.file)) || Number(!!b.fact.repairPending) - Number(!!a.fact.repairPending) || (a.fact.verifiedAt ?? 0) - (b.fact.verifiedAt ?? 0) || (lastQuantum.get(a.file) ?? 0) - (lastQuantum.get(b.file) ?? 0));
  const candidate = repair ? queue.find(c => c.file === repair!.file) : queue[0];
  if (!candidate) return false;
  const { file, ref, fact } = candidate;
  const charge = ledger.reserve(); if (!charge) return false;
  steppingFile = file; lastQuantum.set(file, ++quantum);
  try {
   if (fact.repairPending) {
    if (!repair) {
     const stage = index(file) + ".repair.sqlite";
     await rm(stage, { force: true }); await rm(stage + "-journal", { force: true });
     const reader = openPiSessionRange(file, { host: "source", indexPath: stage }), items: ArcItem[] = [], entries: ArcEntry[] = [];
     repair = { file, stage, reader, stamp: sourceStamp(await stat(file)), items, entries, cursor: reader.startRepair(visit(items, entries)) };
    }
    if (closed || signal?.aborted || reads.has(file)) { ledger.reconcile(charge, 0); return false; }
    const pending = repair, result = await pending.cursor.step(charge.bytes);
    ledger.reconcile(charge, result.bytesRead);
    if (result.kind !== "done") return runnable(signal);
    const session = pending.reader.session();
    if (!session || canonicalSessionRef(session.id) !== ref) throw new Error("Session identity changed during repair");
    const value = project(pending.reader, ref, pending.items, pending.entries);
    // A crash before the durable fact keeps repair pending. The main index never sees a partial replay.
    pending.reader.close();
    await rename(pending.stage, index(file));
    const fd = openSync(dirname(index(file)), "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    verified(file, ref, value.version, pending.stamp);
    retain(file, value); stamps.set(file, stampKey(pending.stamp)!);
    repair = undefined; yielded.delete(file);
   } else {
    let proof = proofs.get(file);
    if (!proof) {
     const reader = openPiSessionRange(file, { host: "source", indexPath: index(file) });
     try { proof = { cursor: reader.startVerification(), stamp: sourceStamp(await stat(file)), version: reader.info().version }; proofs.set(file, proof); }
     finally { reader.close(); }
    }
    if (closed || signal?.aborted || reads.has(file)) { ledger.reconcile(charge, 0); return false; }
    const result = proof.cursor.step(charge.bytes);
    ledger.reconcile(charge, result.bytesRead);
    if (result.kind === "pending") return runnable(signal);
    proofs.delete(file); proof.cursor.close();
    if (result.kind === "matched") { verified(file, ref, proof.version, proof.stamp); yielded.delete(file); }
    else {
     const current = sourceStamp(await stat(file)); fact.observedStamp = current;
     if (stampKey(current) === stampKey(proof.stamp)) {
      fact.repairPending = true; ledger.save(); drop(file);
      log(`Arc source changed: ${ref}; its published receipt is older than its source; budgeted repair pending`);
     } else yielded.add(file);
    }
   }
  } catch (error) {
   // Unknown I/O outcomes keep their full reservation. Repairs remain durable obligations.
   proofs.get(file)?.cursor.close(); proofs.delete(file); drop(file); yielded.add(file);
   if (repair?.file === file) await discardRepair();
   log(`Arc source verification failed: ${ref}; ${(error as Error).message}`);
   return false;
  } finally { steppingFile = undefined; }
  return runnable(signal);
 }
 function verifyStep(signal?: AbortSignal) {
  return periodic ??= periodicStep(signal).catch(error => { log(`Arc source verification paused: ${(error as Error).message}`); return false; }).finally(() => { periodic = undefined; });
 }
 const port: SourcePort = {
  async snapshot(ref, condition) {
   const canonical = canonicalSessionRef(ref);
   if (condition?.deferRepair && Object.values(ledger.state.sources).some(fact => fact.sessionRef === canonical && fact.repairPending)) throw Object.assign(new Error("Source repair is pending"), { code: "source-repair-pending" });
   if (!paths.has(canonical)) await scan();
   const file = paths.get(canonical); if (!file) throw new Error("Session file is unavailable");
   if (condition?.deferRepair && ledger.state.sources[hash(file)]?.repairPending) throw Object.assign(new Error("Source repair is pending"), { code: "source-repair-pending" });
   return read(file, canonical, "full", condition?.expectedPrefix, condition?.deferRepair);
  },
  async check(snapshot) {
   try {
    const current = await port.snapshot(snapshot.session, { expectedPrefix: snapshot.prefixWitness });
    const prefix = current.items.slice(0, snapshot.items.length), entries = current.entries.slice(0, snapshot.entries.length);
    return current.selector === snapshot.selector && fingerprint(prefix) === snapshot.fingerprint && JSON.stringify(entries) === JSON.stringify(snapshot.entries)
     ? { kind: "same-prefix" }
     : { kind: "history-changed", sourceVersion: current.sourceVersion, reason: "Authoritative Session history changed" };
   } catch (e) {
    const error = e as Error & { code?: string; sourceVersion?: string };
    return error.code === "source-prefix" ? { kind: "history-changed", reason: error.message, sourceVersion: error.sourceVersion! } : { kind: "unavailable", reason: error.message };
   }
  },
 };
 return { ...port, scan, verifyStep, async close() {
  closed = true; await periodic;
  for (const proof of proofs.values()) proof.cursor.close(); proofs.clear();
  await discardRepair();
 } };
}
