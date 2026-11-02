// One sidecar per Session. Reads project cached receipts; only triggers start model work.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { arcSettings, watchArcSettings } from "../../node/pi-config.ts";
import type { ArcReceipt, ArcValue, BuildRecord } from "../../shared/arc.ts";
import { constructArc, fingerprint } from "./arc-build.ts";
import { sourceStatus, type PiView, type PiViewContext, type PiViewSession } from "./types.ts";
// Sessions build independently. The only shared limit is model-call admission in ask.ts.
export const ARC_FLOOR = 4, DEBOUNCE_MS = 20_000, AUTO_INTERVAL_MS = 300_000, ADMISSION_WAIT_MS = 60_000, BUSY_RETRY_MS = 1000;
type Head = Pick<ArcReceipt, "asOfCount" | "fingerprint" | "selector" | "tier"> & { needsYou: number; oldestAt?: string };
type State = { ctx: PiViewContext; id: string; head?: Head; status: ArcValue["status"]; seen?: string; pending?: BuildRecord["trigger"]; retry?: boolean; busy?: boolean; timer?: ReturnType<typeof setTimeout>; running?: Promise<void>; failures: number; nextAt: number; lastAuto: number; opened: boolean; panel: boolean; closed: boolean; queuedAt?: number };
const states = new WeakMap<PiViewContext, Map<string, State>>();
let active = 0, completed = 0;
export const RECEIPT_CACHE = 32;
const receipts = new Map<State, ArcReceipt>();
const scheduled = new Set<State>();
let autoEnabled = true;
const settingsWatches = new WeakMap<PiViewContext, () => void>();
const headOf = (r: ArcReceipt): Head => { const points = r.points.filter(p => p.needsYou); return { asOfCount: r.asOfCount, fingerprint: r.fingerprint, selector: r.selector, tier: r.tier, needsYou: points.length, oldestAt: points.map(p => p.firstAt).filter(Boolean).sort()[0] }; };
function cache(s: State, r: ArcReceipt) { receipts.delete(s); receipts.set(s, r); while (receipts.size > RECEIPT_CACHE) receipts.delete(receipts.keys().next().value!); }
function load(s: State): ArcReceipt | undefined {
 let r = receipts.get(s);
 if (!r && s.head) try { r = JSON.parse(readFileSync(pathFor(s.ctx, `${s.ctx.host}/${s.id}`), "utf8")); } catch {}
 if (r && s.panel) cache(s, r); return r;
}
export function startArcs(ctx: PiViewContext): void {
 settingsWatches.get(ctx)?.();
 settingsWatches.set(ctx, watchArcSettings(auto => { autoEnabled = auto; if (!auto) for (const s of states.get(ctx)?.values() ?? []) cancelAutomatic(s); }));
 for (const name of readdirSync(ctx.stateDir("arc"))) {
  if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
  try { const r: ArcReceipt = JSON.parse(readFileSync(join(ctx.stateDir("arc"), name), "utf8")); if (r.v === 1 && r.session.startsWith(`${ctx.host}/`)) state(ctx, r.session.slice(ctx.host.length + 1)).head = headOf(r); } catch {}
 }
}
export const arcQueue = () => ({ pending: active + scheduled.size, done: completed });
const pathFor = (ctx: PiViewContext, ref: string) => join(ctx.stateDir("arc"), `${createHash("sha256").update(ref).digest("hex")}.json`);
function state(ctx: PiViewContext, id: string): State {
 let map = states.get(ctx); if (!map) states.set(ctx, map = new Map());
 let s = map.get(id);
 if (!s) {
  s = { ctx, id, status: { state: "idle" }, failures: 0, nextAt: 0, lastAuto: 0, opened: false, panel: false, closed: false };
  map.set(id, s);
 }
 return s;
}
// Only the Build that owns `timing` adds store time; a checkpoint without a new record times nothing.
function persist(s: State, receipt: ArcReceipt, timing?: BuildRecord["timing"]) {
 const path = pathFor(s.ctx, receipt.session), next = `${path}.${process.pid}.tmp`;
 const started = performance.now(), serialized = JSON.stringify(receipt);
 if (timing) timing.storeMs += performance.now() - started;
 writeFileSync(next, timing ? JSON.stringify(receipt) : serialized, { mode: 0o600 }); renameSync(next, path); s.head = headOf(receipt); if (receipts.has(s)) cache(s, receipt);
}
export function arcValue(ctx: PiViewContext, session: PiViewSession): ArcValue {
 const s = state(ctx, session.threadId), r = load(s), data = session.data;
 const sameSelection = !r || r.selector === data.rarebit.selector && r.tier === "b";
 return { ...(r ? { receipt: r } : {}), ...(sameSelection ? { sourceCount: data.rarebit.count } : {}), stale: stale(s, session), lastStopAt: data.rarebit.lastStopAt, branchChanged: Boolean(r && (!sameSelection || r.asOfCount > data.rarebit.count || r.asOfCount === data.rarebit.count && r.fingerprint !== data.rarebit.fingerprint)), status: { ...s.status }, series: { bucketMs: 900_000, start: data.timeline.start, end: data.timeline.end, buckets: data.timeline.buckets, priced: data.timeline.priced } };
}
function notify(s: State) { if (!s.closed) s.ctx.invalidate("arc"); }
function stale(s: State, session: PiViewSession): number {
 const r = s.head, data = session.data.rarebit;
 if (r && (r.selector !== data.selector || r.tier !== "b")) return Math.max(1, data.count - r.asOfCount);
 return Math.max(0, data.count - (r?.asOfCount ?? 0));
}
export function arcPanel(ctx: PiViewContext, id: string, subscribed: boolean): void {
 const s = state(ctx, id); s.panel = subscribed; if (!subscribed) receipts.delete(s);
}
const explicit = (t?: BuildRecord["trigger"]) => t === "manual" || t === "rebuild";
// Pending work keeps its strongest trigger: a Rebuild over a manual Build over an automatic trigger, and the latest
// automatic trigger among those. A later event therefore never turns explicit work into automatic work.
const stronger = (a: BuildRecord["trigger"] | undefined, b: BuildRecord["trigger"]) => [a, b].find(t => t === "rebuild") ?? [a, b].find(t => t === "manual") ?? b;
// Turning automatic Builds off cancels automatic work: automatic triggers and the failure retry of any Build. An explicit
// Build that waits for a model slot stays. No "next try" time stays on screen.
function cancelAutomatic(s: State) {
 if (s.running || !s.pending || explicit(s.pending) && (!s.retry || s.busy)) return;
 clearTimeout(s.timer); s.timer = undefined; scheduled.delete(s); s.pending = undefined; s.retry = false; s.busy = false;
 const error = s.status.state === "queued" || s.status.state === "failed" ? s.status.error : undefined;
 s.status = error ? { state: "failed", error } : { state: "idle" }; notify(s);
}
function schedule(s: State, trigger: BuildRecord["trigger"], debounce = DEBOUNCE_MS) {
 if (s.closed) return;
 s.pending = stronger(s.pending, trigger); s.queuedAt ??= Date.now();
 if (s.running) return;
 scheduled.add(s);
 clearTimeout(s.timer);
 // A retry of failed work waits for its backoff only; the cadence spaces Builds for new evidence.
 // A Build refused for capacity asks again after BUSY_RETRY_MS, whatever events arrive meanwhile: the refusal is neither
 // a failure nor new evidence, so backoff and cadence do not apply.
 const at = s.busy ? Date.now() + BUSY_RETRY_MS : Math.max(Date.now() + debounce, s.nextAt, s.retry ? 0 : s.lastAuto + AUTO_INTERVAL_MS);
 // A queued retry keeps the failure that caused it visible until a Build succeeds.
 const error = s.status.state === "failed" || s.status.state === "queued" ? s.status.error : undefined;
 s.status = { state: "queued", ...(s.status.state === "queued" && s.status.progress ? { progress: s.status.progress } : {}), ...(error ? { error } : {}), ...(at - Date.now() > BUSY_RETRY_MS ? { nextAt: new Date(at).toISOString() } : {}) }; notify(s);
 // `nextAt` names this timer only: it is published here and cleared when the timer fires.
 s.timer = setTimeout(() => {
  s.timer = undefined; delete s.status.nextAt; scheduled.delete(s);
  const trigger = s.pending; s.pending = undefined;
  if (!trigger || !s.ctx.session(s.id)) { notify(s); return; }
  // Automatic work needs automatic Builds on when it starts; a manual Build or its retry does not.
  if (!explicit(trigger) && !autoEnabled) { s.retry = false; s.busy = false; s.status = { state: "idle" }; notify(s); return; }
  void buildArc(s.ctx, s.id, { trigger, rebuild: trigger === "rebuild" }).catch(() => {});
 }, Math.max(0, at - Date.now())); s.timer.unref();
}
export async function buildArc(ctx: PiViewContext, id: string, options: { trigger: BuildRecord["trigger"]; rebuild?: boolean }): Promise<void> {
 const s = state(ctx, id);
 if (s.running) return s.running;
 const isManual = options.trigger === "manual" || options.trigger === "rebuild";
 clearTimeout(s.timer); scheduled.delete(s); s.pending = undefined; s.retry = false; s.busy = false;
 active++; if (!isManual) s.lastAuto = Date.now();
 s.status = { state: "building" }; notify(s);
 const release = ctx.lease(id);
 const record: BuildRecord = { trigger: options.rebuild ? "rebuild" : options.trigger, startedAt: new Date().toISOString(), endedAt: "", state: "done", calls: 0, windows: 0, model: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, repairs: [], timing: { queueMs: s.queuedAt ? Date.now() - s.queuedAt : 0, evidenceMs: 0, modelMs: 0, storeMs: 0 }, callUsage: [] };
 s.queuedAt = undefined;
 // Defer execution until running is assigned, including synchronous source/settings failures.
 s.running = Promise.resolve().then(async () => {
  let checkpoint: ArcReceipt | undefined;
  let checkSource = () => {};
  try {
   const settings = arcSettings(); record.model = settings.model; autoEnabled = settings.auto;
   const session = ctx.session(id);
   if (!session || sourceStatus(session).state !== "ready") throw Object.assign(new Error("Session has not loaded. Wait and retry."), { code: "source" });
   const readAt = performance.now();
   const source = ctx.snapshot(() => session.arcSource()); record.timing!.evidenceMs = performance.now() - readAt;
   const previous = load(s);
   checkSource = () => {
    const current = ctx.session(id);
    if (!current) throw Object.assign(new Error("Session is no longer available."), { code: "source" });
    if (current.data.rarebit.fingerprint !== source.fingerprint) {
     const checkedAt = performance.now();
     const latest = ctx.snapshot(() => current.arcSource()); record.timing!.evidenceMs += performance.now() - checkedAt;
     if (latest.selector !== source.selector || fingerprint(latest.items.slice(0, source.items.length)) !== source.fingerprint) throw Object.assign(new Error("Session branch changed during Build; retry."), { code: "source" });
     // Appends keep the snapshot valid. Pending work covers the newer evidence.
    }
   };
   const receipt = await constructArc(source, options.rebuild || previous?.selector !== source.selector || previous?.tier !== "b" ? undefined : previous, record, r => ctx.ask({ ...r, admission: "background", waitMs: ADMISSION_WAIT_MS }), (progress, work) => { s.status = { state: "building", progress, ...(work ? { work } : {}) }; notify(s); }, undefined, previous?.nextPointId ?? 1, receipt => {
    // Failure may advance the stored cursor, but must never replace fuller or differently selected evidence.
    if (previous && (receipt.selector !== previous.selector || receipt.tier !== previous.tier || receipt.asOfCount <= previous.asOfCount || fingerprint(source.items.slice(0, previous.asOfCount)) !== previous.fingerprint)) return;
    // A checkpoint becomes visible only when the Build ends. A crash can lose it.
    checkpoint = { ...receipt, builds: previous?.builds ?? [] };
   }, settings.retries);
   checkSource();
   record.endedAt = new Date().toISOString();
   receipt.builds = [...previous?.builds ?? [], record].slice(-30);
   persist(s, receipt, record.timing);
   s.status = { state: "idle" }; s.failures = 0; s.nextAt = 0;
  } catch (error) {
   if (checkpoint) try { checkSource(); } catch (sourceError) { checkpoint = undefined; error = sourceError; }
   const e = error as { code?: string; message?: string; resetAt?: number | string };
   record.state = "failed"; record.endedAt = new Date().toISOString();
   record.error = { code: ["model", "answer", "source", "settings", "busy"].includes(e.code ?? "") ? e.code as NonNullable<BuildRecord["error"]>["code"] : "internal", message: e.message ?? String(error) };
   s.status = { state: "failed", error: record.error };
   if (e.code === "busy") {
    // Keep accepted windows; the retry must not pay for them again. Busy adds no Build record.
    if (checkpoint) persist(s, checkpoint);
    // The Build asks for a slot again after BUSY_RETRY_MS, without backoff or cadence. A manual Build stays manual,
    // so turning automatic Builds off does not cancel it.
    s.status = { state: "queued", progress: "Waiting for a model slot" };
    s.pending = stronger(s.pending, options.trigger); s.busy = true; return;
   }
   const previous = checkpoint ?? load(s);
   if (previous) persist(s, { ...previous, builds: [...previous.builds, record].slice(-30) }, record.timing);
   s.failures++;
   const reset = typeof e.resetAt === "number" ? e.resetAt : Date.parse(e.resetAt ?? "");
   s.nextAt = Math.max(Date.now() + Math.min(60, 2 ** Math.min(6, s.failures - 1)) * 60_000 + Math.random() * 30_000, Number.isFinite(reset) ? reset : 0);
   // With automatic Builds on, every failure schedules a retry at the backoff time; schedule() publishes it.
   // With them off, nothing is scheduled, so no retry time shows; Build retries by hand.
   if (autoEnabled) { s.pending = stronger(s.pending, options.trigger); s.retry = true; }
  } finally {
   s.running = undefined; release(); completed++;
   active--; notify(s);
   // Automatic work that arrived while automatic Builds were turned off is dropped, so no retry time shows.
   if (!autoEnabled && s.pending && !explicit(s.pending)) { s.pending = undefined; s.retry = false; s.busy = false; }
   if (s.pending) schedule(s, s.pending, 0);
  }
 });
 return s.running;
}
export function arcOpened(ctx: PiViewContext, id: string, open: boolean): void {
 const s = state(ctx, id); s.opened = open;
 if (!open) return;
 const session = ctx.session(id);
 if (!session || s.running || session.data.rarebit.count < ARC_FLOOR) return;
 try { if (autoEnabled && stale(s, session) > 0) schedule(s, session.data.rarebit.trigger?.kind === "user" ? "owner" : "stop"); } catch {}
}
export function closeArcs(ctx: PiViewContext): void { settingsWatches.get(ctx)?.(); settingsWatches.delete(ctx); for (const s of states.get(ctx)?.values() ?? []) { s.closed = true; clearTimeout(s.timer); scheduled.delete(s); s.pending = undefined; receipts.delete(s); } }
export const arcView: PiView<"arc"> = {
 name: "arc",
 value(ctx, topic) { const session = ctx.session(topic.threadId); return session ? arcValue(ctx, session) : undefined; },
 summarize(ctx, session) {
  const r = state(ctx, session.threadId).head; if (!r) return undefined;
  return { arc: { needsYou: r.needsYou, ...(r.oldestAt ? { oldestAt: r.oldestAt } : {}), stale: stale(state(ctx, session.threadId), session) } };
 },
 changed(ctx, sessions) {
  for (const session of sessions) {
   const s = state(ctx, session.threadId), trigger = session.data.rarebit.trigger;
   if (!trigger || s.seen === trigger.id) continue;
   s.seen = trigger.id;
   if (session.data.rarebit.count < ARC_FLOOR || s.head?.fingerprint === session.data.rarebit.fingerprint) continue;
   try { if (autoEnabled) schedule(s, trigger.kind === "user" ? "owner" : "stop"); } catch {}
  }
 },
 evict(ctx, id) { const s = states.get(ctx)?.get(id); if (s && !s.running) { clearTimeout(s.timer); scheduled.delete(s); receipts.delete(s); states.get(ctx)?.delete(id); } },
 ops: { async build(ctx, args) {
  if (!ctx.session(args.threadId)) throw new Error("Unknown Session. Open it first.");
  void buildArc(ctx, args.threadId, { trigger: args.rebuild ? "rebuild" : "manual", rebuild: args.rebuild });
  return { started: true };
 } },
};
