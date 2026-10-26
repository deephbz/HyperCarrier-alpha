// The hub's reader side for one durable node: what Pi Sessions derive from their copy, durable
// threads derive from a hub copy of node history. Contract: docs/durable/reader-design.md, "Hub copy".
//
//   node reader wire ──► openDurableSession({ retain: false }).refresh({ sink })
//        ──► writeDurableCopy, one wire page at a time (disk, per thread)
//        ──► WorkingSet.refresh (the derive Worker Pi uses) ──► views, Find, search, history, entry
//
// The copy is a derived cache. It holds no source fact and rebuilds from the node when it is deleted
// or damaged. A sync holds one wire page of history in hub memory at a time, plus one oversized body
// up to maxEntryBytes. One hub owns the cache directory (cache-owner.ts). Live state, the inbox and
// control come only from the node: threadValue leaves `live` and `inbox` to DurableHost, which merges
// the node's values.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
// @ts-ignore: shared reader is plain ESM.
import { openDurableSession, parseThread, sessionIdOf } from "../../../trace-analytics/src/sources/durable.mjs";
// @ts-ignore: shared reader is plain ESM.
import { durableCopyCheckpoint, durableCopyFiles, removeDurableCopy, writeDurableCopy } from "../../../trace-analytics/src/sources/durable-copy.mjs";
// @ts-ignore: shared reader is plain ESM.
import { durableSpend } from "../../../trace-analytics/src/sources/spend.mjs";
import { historySpend, spendLabel, type Spend } from "../shared/spend.ts";
import type { FleetSearchResult, OpHandlers, PiThreadView, ThreadSummary, Topic, UsageBucket, ViewOps } from "../shared/protocol.ts";
import type { SearchResult } from "../pi/search.ts";
import { PI_VIEWS, viewOps } from "../pi/views/index.ts";
import type { HostedView, PiRecordedMember, PiTeamsFrame, PiViewContext, PiViewSession } from "../pi/views/types.ts";
import type { Derived, Source } from "../pi/working-set-types.ts";
import { WorkingSet } from "../pi/working-set.ts";
import { claimCacheDir, type CacheOwner } from "./cache-owner.ts";

/** The thread's readError while a damaged or partial copy rebuilds from the node. */
export const REBUILDING = "The hub copy is damaged; rebuilding it from the node";
/** The node docs the copy keeps: the Session head (pi.agent) and spend (pi.usage). */
const COPY_DOCS = ["pi.agent", "pi.usage"] as const;

/**
 * The thread's current model, provider-qualified: the node's pi.agent choice, which configure sets before any answer
 * names it, else the model the latest history entry names (pi.agent leaves it unset to follow the node default).
 */
/** The pi.usage model buckets the Info panel lists; a missing or malformed document has none. */
function usageModels(doc: any): NonNullable<DurableThreadValue["usage"]["models"]> {
 const models = doc?.models;
 if (!models || typeof models !== "object" || Array.isArray(models)) return {};
 return Object.fromEntries(Object.entries(models).filter(([key, u]) => key.includes("/") && u && typeof u === "object")) as Record<`${string}/${string}`, UsageBucket>;
}

function currentModel(copy: { docs: Record<string, any>; data?: { model?: string } }): string | undefined {
 const chosen = copy.docs["pi.agent"]?.model;
 return chosen?.provider && chosen.modelId ? `${chosen.provider}/${chosen.modelId}` : copy.data?.model;
}

/** One connection of the node's reader service (trace-analytics durable-wire.mjs). */
export type DurableReaderNode = Record<"open" | "entries" | "fence" | "raw" | "cancel" | "watch" | "close", (...args: any[]) => Promise<any>>;
/** The summary fields this side derives; DurableHost adds identity, liveness, layout and control from the node. */
export type DurableSummaryFields = Pick<ThreadSummary, "costUsd" | "spend" | "spendLabel" | "contextTokens" | "cacheHit" | "preview" | "model" | "ref"> & { cwd?: string; createdAt?: number; updatedAt?: number; team?: ThreadSummary["team"] };
export type DurableThreadValue = Omit<PiThreadView, "live" | "inbox">;
export type DurableViewsConfig = {
 host: string;
 cacheDir: string;
 /** A reader connection to the node. A transport loss gives a new connection; reads then reopen their handles. */
 node: () => DurableReaderNode;
 /** The node's Team frame when it serves one; otherwise Team membership is read from conversation ownership. */
 teamsFrame?: () => PiTeamsFrame | undefined;
 /** Node-owned summary fields (live, activity, attention) that views such as Team read. */
 nodeSummary?: (threadId: string) => Partial<ThreadSummary> | undefined;
 command?: PiViewContext["command"];
 ask?: PiViewContext["ask"];
 model?: PiViewContext["model"];
 views?: HostedView[];
 /** Records larger than this reach the copy as stubs; their bytes stay on the node (raw export). */
 maxEntryBytes?: number;
 /** The raw export URL of a thread (Trace Viewer `/raw/pi-durable:<threadId>`); entries past maxEntryBytes link to it. */
 rawExportUrl?: (threadId: string) => string;
 /** The Host's connection state; fleet search reports it as PiHost does. */
 hostStatus?: () => FleetSearchResult["hostStatus"];
};
type Copy = {
 threadId: string; sessionId: string; file: string;
 reader?: any; data?: Derived; readError?: string;
 conversation?: { parent?: unknown; owner?: { conversationId: number | string; taskId?: string } } | null;
 docs: Record<string, any>;
 revision: number; leases: number; syncing?: Promise<void>; again?: boolean;
 /** Hold leases: while any is out, the reader keeps its node handle and watch; otherwise each sync closes it. */
 holds: number;
};

const digest = (s: string) => createHash("sha256").update(s).digest("hex");
/** The node thread key in a durable Session ID (`pi-durable:<threadKey>`). */
export const threadKeyOf = (sessionId: string) => sessionId.slice(sessionId.indexOf(":") + 1);

export class DurableViews extends EventEmitter {
 readonly host: string;
 readonly cacheDir: string;
 #config: DurableViewsConfig;
 #store: WorkingSet;
 #copies = new Map<string, Copy>();
 #views: Map<string, HostedView>;
 #stopped = false;
 #owner: CacheOwner;
 readonly context: PiViewContext;
 /** Session search, thread navigation, and every view op. */
 readonly ops: OpHandlers<"sessions.search" | "thread.outline" | "thread.find" | "thread.history" | "thread.entry" | keyof ViewOps>;

 constructor(config: DurableViewsConfig) {
  super();
  this.#config = config; this.host = config.host; this.cacheDir = config.cacheDir;
  mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
  // A second hub on this cache throws here, before it reads or writes any cache file.
  this.#owner = claimCacheDir(this.cacheDir);
  this.#store = new WorkingSet(config.host, config.cacheDir);
  this.#views = new Map((config.views ?? PI_VIEWS).map((v) => [v.name, v]));
  const unavailable = () => Promise.reject(Object.assign(new Error("Not available on this node"), { code: "unavailable" }));
  this.context = {
   host: config.host,
   stateDir: (view) => { const dir = join(this.cacheDir, "views", view); mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; },
   sessions: () => [...this.#copies.values()].map((c) => this.#viewSession(c)).filter((s): s is PiViewSession => Boolean(s)),
   session: (threadId) => { const c = this.#copies.get(threadId); return c ? this.#viewSession(c) : undefined; },
   snapshot: (read) => this.#store.snapshot(read),
   lease: (threadId) => { const c = this.#copies.get(threadId); if (!c) return () => {}; c.leases++; return () => { c.leases--; }; },
   teams: () => [],
   teamsFrame: () => config.teamsFrame ? config.teamsFrame() : this.#ownershipTeams(),
   rolesKnown: () => true,
   command: config.command ?? unavailable,
   ask: config.ask ?? unavailable,
   model: config.model ?? unavailable,
   invalidate: (view) => this.emit("changed", { view }),
  };
  this.ops = { ...this.#readOps(), ...viewOps(this.context) };
 }

 /** Start reading `threadId` (`<storeId>.<conversationId>`) into its copy; resolves after the first sync. */
 async track(threadId: string): Promise<void> {
  if (this.#stopped) throw new Error("Durable views stopped");
  let copy = this.#copies.get(threadId);
  if (!copy) {
   parseThread(threadId);
   copy = { threadId, sessionId: sessionIdOf(threadId), file: join(this.cacheDir, `${digest(threadId).slice(0, 32)}.jsonl`), docs: {}, revision: 0, leases: 0, holds: 0 };
   // A derived head from an earlier run serves views at once; the first sync validates it against the node.
   copy.data = this.#store.load(copy.sessionId);
   this.#copies.set(threadId, copy);
  }
  return this.sync(threadId);
 }

 /**
  * Keep `threadId`'s node handle and watch open until the lease is released, so the copy follows the node live.
  * Leases count: each holder releases once. An unheld thread syncs only when asked, and closes its handle after
  * each sync, because a pi-durable 1.4.0 handle keeps the whole conversation in node memory.
  */
 hold(threadId: string): () => void {
  const copy = this.#copies.get(threadId);
  if (!copy) return () => {};
  copy.holds++;
  if (copy.holds === 1) void this.sync(threadId);
  let released = false;
  return () => {
   if (released) return;
   released = true;
   copy.holds--;
   if (copy.holds === 0 && !copy.syncing) { copy.reader?.close(); copy.reader = undefined; }
  };
 }

 /** Stop reading `threadId`; its copy stays on disk for the next track. */
 untrack(threadId: string): void {
  const copy = this.#copies.get(threadId);
  if (!copy) return;
  copy.reader?.close(); this.#copies.delete(threadId);
  for (const view of this.#views.values()) view.evict?.(this.context, threadId);
  this.emit("changed", { threadId });
 }

 /** Delete the copy and its derived rows. The node keeps the history; a later track rebuilds them. */
 async forget(threadId: string): Promise<void> {
  const copy = this.#copies.get(threadId);
  const file = copy?.file ?? join(this.cacheDir, `${digest(threadId).slice(0, 32)}.jsonl`);
  await copy?.syncing;
  if (copy) await this.#store.forget(this.#source(copy));
  this.untrack(threadId);
  removeDurableCopy(file);
 }

 /** Catch the copy up to the node, then derive it. A burst of watch changes coalesces into one trailing sync. */
 sync(threadId: string): Promise<void> {
  const copy = this.#copies.get(threadId);
  if (!copy) return Promise.resolve();
  if (copy.syncing) { copy.again = true; return copy.syncing; }
  copy.syncing = (async () => {
   let damaged = false;
   try {
    if (!copy.reader) {
     const restore = durableCopyCheckpoint(copy.file, { host: this.host, threadId });
     // A copy that served views before but has no whole bundle now: say so, and serve nothing from it until it is rebuilt.
     if (!restore && copy.data !== undefined) { copy.data = undefined; copy.readError = REBUILDING; this.emit("changed", { threadId }); }
     copy.reader = openDurableSession({ node: this.#config.node(), threadId, host: this.host, retain: false,
      ...(this.#config.maxEntryBytes ? { maxEntryBytes: this.#config.maxEntryBytes } : {}),
      restore: restore ?? undefined,
      onChange: () => { if (!this.#stopped && this.#copies.get(threadId) === copy) void this.sync(threadId); } });
    }
    const reader = copy.reader;
    // Each page goes to disk before the reader fetches the next; the copy keeps the docs the hub derives from.
    let wrote = false;
    const docsOf = () => { const all = reader.docs().docs ?? {}; return Object.fromEntries(COPY_DOCS.flatMap((kind) => kind in all ? [[kind, all[kind]]] : [])); };
    const commit = (reset: boolean, records: unknown[]) => {
     // An append continues the whole committed copy; one that lost a file meanwhile rebuilds instead.
     if (!reset && reader.snapshot() !== null && !durableCopyCheckpoint(copy.file, { host: this.host, threadId })) { damaged = true; throw new Error(REBUILDING); }
     const conversation = reader.conversation(), docs = docsOf();
     writeDurableCopy(copy.file, { host: this.host, threadId, reset, records, checkpoint: reader.snapshot(), conversation, docs });
     copy.conversation = conversation; copy.docs = docs; wrote = true;
    };
    const change = await reader.refresh({ sink: ({ reset, records }: { reset: boolean; records: unknown[] }) => commit(reset, records) });
    // Closed or untracked during the refresh: the reader closed its handle, and nothing here changes.
    if (this.#stopped || this.#copies.get(threadId) !== copy) return;
    if (damaged) return this.#rebuild(copy);
    if (change.status !== "ready" && change.status !== "stale") {
     copy.readError = change.error?.message ?? (change.status === "not_found" ? "Thread is not on the node" : "Node unavailable");
     // A transport loss closes the connection's handles; the next sync opens a new reader.
     if (change.status === "unavailable") { reader.close(); copy.reader = undefined; }
     this.emit("changed", { threadId }); return;
    }
    // Live state and the inbox come from the node only; a docs change without new records still commits.
    if (!wrote && (copy.data === undefined || JSON.stringify([reader.conversation(), docsOf()]) !== JSON.stringify([copy.conversation, copy.docs]))) commit(false, []);
    const data = await this.#store.refresh(this.#source(copy), undefined, true);
    if (this.#stopped || this.#copies.get(threadId) !== copy) return;
    copy.readError = undefined;
    if (data && data.version !== copy.data?.version) { copy.data = data; copy.revision++; this.#store.invalidate(this.#source(copy)); }
    this.#notify([copy]);
    this.emit("changed", { threadId });
   } catch (error) {
    if (this.#stopped) return;
    if (damaged) return this.#rebuild(copy);
    copy.readError = (error as Error).message;
    this.emit("changed", { threadId });
   } finally {
    copy.syncing = undefined;
    // An unheld sync opens, refreshes and closes its handle, on error too.
    if (copy.holds === 0) { copy.reader?.close(); copy.reader = undefined; }
    if (copy.again && !this.#stopped) { copy.again = false; void this.sync(threadId); }
   }
  })();
  return copy.syncing;
 }

 /** A view topic's value; undefined when the view or its thread is unknown here. */
 value(topic: Topic): unknown {
  if (topic.kind !== "view") return undefined;
  const view = this.#views.get(topic.view);
  if (!view) return undefined;
  return this.#store.snapshot(() => {
   try { return view.value(this.context, topic as never); }
   catch (error) { return { error: { code: "view_failed", message: `The ${view.name} view failed: ${(error as Error).message}` } }; }
  });
 }

 /** The thread topic's reader part. DurableHost adds `live` and `inbox` from the node. */
 threadValue(threadId: string): DurableThreadValue | undefined {
  const copy = this.#copies.get(threadId);
  if (!copy) return undefined;
  const data = copy.data;
  const page = data ? this.#store.tail(this.#source(copy), data, false) : { entries: [], more: false };
  const fields = this.summaryFields(threadId);
  return {
   conversationId: threadId,
   ...(data ? { sourceVersion: data.version } : {}),
   hiddenBefore: page.more,
   entries: page.entries,
   // The node's choices (pi.agent) come first; configure writes them without a history entry.
   agent: { cwd: fields?.cwd ?? "", asOf: data?.asOf ?? null, readError: copy.readError ?? null, ...(currentModel(copy) ? { model: currentModel(copy) } : {}),
    ...(typeof copy.docs["pi.agent"]?.thinkingLevel === "string" ? { thinkingLevel: copy.docs["pi.agent"].thinkingLevel } : {}) },
   // The node's pi.usage by model, as the node's own projection sends it (node/projection.ts); cost follows the spend rule.
   usage: { models: usageModels(copy.docs["pi.usage"]), costUsd: fields?.costUsd ?? 0 },
  };
 }

 /** Reader-derived summary fields. Spend follows the one spend rule: the node's pi.usage document is its authority. */
 summaryFields(threadId: string): DurableSummaryFields | undefined {
  const copy = this.#copies.get(threadId), data = copy?.data;
  if (!copy || !data) return undefined;
  const usage = copy.docs["pi.usage"] ? durableSpend(copy.docs["pi.usage"]) : null;
  // A pi.usage document that records no request states no cost fact. Then, as without the document, the history
  // entries are the figure: an unpriced history reads "no price reported", never a priced $0.
  const recorded = usage && (usage.tokens > 0 || usage.usd !== null);
  const spend: Spend = recorded ? { usd: usage.usd, covers: usage.covers } : historySpend(data.priced === false ? null : data.cost);
  const member = this.#ownershipTeams().recorded?.find((m) => m.session === copy.sessionId);
  return {
   costUsd: spend.usd ?? 0, spend, spendLabel: spendLabel(spend), ref: data.session.ref,
   ...(currentModel(copy) ? { model: currentModel(copy) } : {}),
   ...(data.contextTokens ? { contextTokens: data.contextTokens } : {}),
   ...(data.cacheHit !== undefined ? { cacheHit: data.cacheHit } : {}),
   ...(data.preview ? { preview: data.preview } : {}),
   ...(data.session.cwd ? { cwd: data.session.cwd } : {}),
   ...(data.session.started ? { createdAt: data.session.started } : {}),
   ...(data.session.updated ? { updatedAt: data.session.updated } : {}),
   ...(member ? { team: { teamId: member.team, role: member.role === "lead" ? "lead" : "worker", ...(member.role === "lead" ? {} : { worker: member.member }) } } : {}),
  } as DurableSummaryFields;
 }

 /** Per-thread copy cost for the L4 budget: disk bytes of the copy and its working-set head, and hub heap held for it. */
 cost(threadId: string): { copyBytes: number; indexBytes: number; entries: number } | undefined {
  const copy = this.#copies.get(threadId);
  if (!copy) return undefined;
  const size = (f: string | null) => { try { return f ? statSync(f).size : 0; } catch { return 0; } };
  const files = durableCopyFiles(copy.file);
  return { copyBytes: size(files.data), indexBytes: size(files.index) + size(files.meta), entries: copy.data?.count ?? 0 };
 }

 threads(): string[] { return [...this.#copies.keys()]; }
 /** Whether a copy of `threadId` exists: track() registers it before its first sync. */
 has(threadId: string): boolean { return this.#copies.has(threadId); }

 #closing?: Promise<void>;
 close(): Promise<void> { return (this.#closing ??= this.#close()); }
 async #close(): Promise<void> {
  this.#stopped = true;
  for (const copy of this.#copies.values()) copy.reader?.close();
  await Promise.allSettled([...this.#copies.values()].map((c) => c.syncing));
  await this.#store.close();
  this.#owner.release();
 }

 /** The copy lost a file: drop its reader and derived head, show REBUILDING, and sync again from no checkpoint. */
 #rebuild(copy: Copy): void {
  copy.reader?.close(); copy.reader = undefined;
  copy.data = undefined; copy.readError = REBUILDING; copy.again = true;
  this.emit("changed", { threadId: copy.threadId });
 }

 #source(copy: Copy): Source {
  const rawExport = this.#config.rawExportUrl?.(copy.threadId);
  return { host: this.host, cacheDir: this.cacheDir, file: copy.file, path: copy.sessionId, harness: "pi-durable", ...(rawExport ? { rawExport } : {}) };
 }

 #viewSession(copy: Copy): PiViewSession | undefined {
  const data = copy.data;
  if (!data) return undefined;
  const fields = this.summaryFields(copy.threadId);
  const node = this.#config.nodeSummary?.(copy.threadId);
  const summary = { id: copy.threadId, title: data.session.title ?? "", cwd: fields?.cwd ?? "", createdAt: fields?.createdAt ?? 0, updatedAt: fields?.updatedAt ?? 0,
   kind: fields?.team?.role === "worker" ? "worker" : "thread", activity: "idle", queued: 0, ...fields, ...node } as ThreadSummary;
  return {
   threadId: copy.threadId, ref: data.session.ref, path: copy.sessionId, copyFile: copy.file,
   revision: copy.revision, bytes: data.bytes, sourceVersion: data.version, data, readError: copy.readError, summary,
   window: () => this.#store.tail(this.#source(copy), data, false).entries,
   rarebits: (before, fullText) => this.#store.rarebits(copy.sessionId, copy.revision, before, fullText),
   rarebitSnapshot: (maxChars) => this.#store.rarebitSnapshot(copy.sessionId, maxChars),
   arcEvidence: (ids) => this.#store.arcEvidence(copy.sessionId, ids, data.version),
   nearest: (at) => this.#store.nearest(copy.sessionId, at),
   entryTimes: (ids) => this.#store.entryTimes(copy.sessionId, ids),
  };
 }

 /**
  * Team membership from conversation ownership, for a reader with no Team frame source: a conversation owned
  * by another conversation's Task is that conversation's Worker. Provisional (K5.I4): the Team is named by
  * its lead's thread, and Tasks are not read. A host with `teamsFrame` never uses it.
  */
 #ownershipTeams(): PiTeamsFrame {
  const recorded: PiRecordedMember[] = [], leads = new Set<string>();
  for (const copy of this.#copies.values()) {
   const owner = copy.conversation?.owner;
   if (!owner) continue;
   const { storeId } = parseThread(copy.threadId), lead = `${storeId}.${owner.conversationId}`;
   leads.add(lead);
   recorded.push({ team: lead, member: copy.threadId, role: "worker", session: copy.sessionId });
  }
  for (const lead of leads) recorded.push({ team: lead, member: lead, role: "lead", session: sessionIdOf(lead) });
  return { t: "teams", status: "available", recorded, tasks: {} };
 }

 #notify(copies: Copy[]): void {
  const sessions = copies.map((c) => this.#viewSession(c)).filter((s): s is PiViewSession => Boolean(s));
  for (const view of this.#views.values()) {
   try { view.changed?.(this.context, sessions); } catch (error) { console.error(`durable views ${this.host}: view ${view.name} failed:`, error); }
  }
 }

 #readOps(): OpHandlers<"sessions.search" | "thread.outline" | "thread.find" | "thread.history" | "thread.entry"> {
  // A hit names its thread by the hub thread ID; an untitled Session's title falls back to that ID, as on Pi.
  const thread = <H extends { threadId: string; title?: string }>(hit: H): H => ({ ...hit, threadId: threadKeyOf(hit.threadId),
   ...(hit.title === hit.threadId ? { title: threadKeyOf(hit.threadId) } : {}) });
  const known = (threadId: unknown) => {
   const copy = this.#copies.get(String(threadId));
   if (!copy) throw Object.assign(new Error("Unknown thread on this node"), { code: "not_found" });
   return copy;
  };
  return {
   "sessions.search": async (args) => this.#store.snapshot(() => {
    let notIndexed = 0, stale = 0;
    for (const copy of this.#copies.values()) { if (!copy.data) notIndexed++; else if (copy.readError) stale++; }
    const value = this.#store.search(String(args.query ?? "")) as SearchResult;
    const hostStatus = this.#config.hostStatus?.();
    return { ...value, hits: value.hits.map(thread), coverage: { ...value.coverage!, notIndexed, stale }, ...(hostStatus ? { hostStatus } : {}) };
   }) as never,
   "thread.outline": async (args) => this.#store.outline(known(args.threadId).sessionId),
   "thread.find": async (args) => {
    const copy = known(args.threadId);
    if (!copy.data) throw new Error("Thread is not indexed yet");
    const release = this.context.lease(copy.threadId);
    try { const value = await this.#store.find(this.#source(copy), String(args.query ?? ""), copy.data.version); return { ...value, hits: value.hits.map(thread) } as never; }
    finally { release(); }
   },
   "thread.history": async (args) => this.#store.page(known(args.threadId).sessionId, { limit: Number(args.limit ?? 200), before: typeof args.before === "string" ? args.before : undefined,
    around: typeof args.around === "string" ? args.around : undefined, version: typeof args.version === "string" ? args.version : undefined }) as never,
   "thread.entry": async (args) => this.#store.entry(this.#source(known(args.threadId)), String(args.entry), Number(args.offset ?? 0), typeof args.version === "string" ? args.version : undefined) as never,
  };
 }
}
