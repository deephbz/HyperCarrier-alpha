// One authority constructs each Session Arc. The service supplies exclusion, ports and wakeups.
// Scheduling obligations, paid calls and accepted windows survive independently.
import { randomUUID } from "node:crypto";
import { constructArc, fingerprint, PROMPT_VERSION } from "./construct.ts";
import type { BuildRecord, RequestResult, DismissResult, BuildStatus } from "../../shared/arc.ts";
import type { Admission, Builder, BuilderState, BuildJob, BuildKind, BuildSettings, CallRecord, ModelInput, ModelPort, SourcePort, Store, RequestOptions, BuilderCommand } from "./types.ts";

const rank = { incremental: 0, manual: 1, rebuild: 2 };
const copy = <T>(value: T): T => structuredClone(value);
const error = (code: string, message: string) => Object.assign(new Error(message), { code });
export type BuilderOptions = { source: SourcePort; model: ModelPort; admission: Admission; store: Store; settings: () => BuildSettings; now?: () => string; id?: () => string; engineVersion?: string; monotonic?: () => number; changed?: () => void };

export function createBuilder(options: BuilderOptions): Builder {
 const { source, model, admission, store } = options;
 const engineVersion = options.engineVersion ?? PROMPT_VERSION;
 const now = options.now ?? (() => new Date().toISOString()), id = options.id ?? randomUUID;
 const state: BuilderState = store.load() ?? { schema: 1, revision: 0, commands: {}, jobs: {}, sessions: {} };
 for (const records of [state.commands, state.jobs, state.sessions]) Object.setPrototypeOf(records, null);
 const running = new Map<string, Promise<void>>(), inFlight = new Set<string>();
 const cancellation = new AbortController();
 let cancelled: Promise<void> | undefined;
 const checkCancellation = () => { if (cancellation.signal.aborted) throw error("cancelled", "Arc service stop cancelled this Build."); };
 let reconciliation: Promise<Set<string>> | undefined;
 const clocks = new Map<string, { start: number; elapsed: number }>();
 const monotonic = options.monotonic ?? (() => performance.now());
 let fault: unknown;
 function save() {
  if (fault) throw fault;
  for (const [buildId, clock] of clocks) {
   const job = state.jobs[buildId]!; job.elapsedMs = clock.elapsed + Math.max(0, monotonic() - clock.start);
   if (state.sessions[job.sessionRef]?.status?.state !== "building" || ["done", "failed", "uncertain", "obsolete", "cancelled"].includes(job.state)) clocks.delete(buildId);
  }
  try { store.save(copy(state)); } catch (e) { fault = e; throw e; }
  try { options.changed?.(); } catch { /* A projection cannot undo a committed write. */ }
 }
 function pauseClock(job: BuildJob) {
  const clock = clocks.get(job.buildId);
  if (clock) job.elapsedMs = clock.elapsed + Math.max(0, monotonic() - clock.start);
  clocks.delete(job.buildId);
 }
 // Derive paid use from the call journal on every checkpoint and terminal path.
 // Construction can replay an answer without charging or counting it twice.
 function account(job: BuildJob, record: BuildRecord) {
  const calls = [...job.callHistory, ...job.calls];
  record.calls = calls.length;
  record.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  record.callUsage = calls.map((call, index) => {
   const usage = call.answer?.usage ?? call.usage ?? (call.state === "failed" ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } : undefined);
   if (usage) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) record.usage[key] += usage[key];
    record.usage.cost = record.usage.cost === null || usage.cost === null ? null : record.usage.cost + usage.cost;
   } else record.usage.cost = null;
   return { usage: usage ?? null, ms: call.ms ?? 0, failed: call.state !== "answered" || record.callUsage?.[index]?.failed === true };
  });
 }
 for (const job of Object.values(state.jobs)) {
  if (job.state !== "running") continue;
  // The stdin barrier proves that an intent without a recorded child sent no prompt.
  job.calls = job.calls.filter(call => call.state !== "intent" || call.execution);
  for (const call of job.calls) if (call.state === "intent") { call.state = "uncertain"; call.reason = "The service stopped before the model answer was stored."; }
  if (job.calls.some(call => call.state === "uncertain")) {
   job.state = "uncertain"; account(job, job.record);
   job.record.state = "failed"; job.record.endedAt = now(); job.record.reason = "The last model call may have been charged.";
   const mismatch = job.calls.find(c => c.uncertaintyCode === "model-mismatch");
   if (mismatch) job.record.error = { code: "model-mismatch", message: mismatch.reason! };
   state.sessions[job.sessionRef]!.status = { sessionRef: job.sessionRef, buildId: job.buildId, state: "uncertain", pause: "uncertain-call" };
  }
 }
 save();
 function makeJob(sessionRef: string, kind: BuildKind, requester: string, requestOptions: RequestOptions = {}, captured?: BuildSettings): BuildJob {
  const settings = copy(captured ?? options.settings());
  if (!settings.model || !Number.isInteger(settings.retries) || settings.retries < 0 || settings.retries > 5 || settings.windowTokens !== undefined && (!Number.isFinite(settings.windowTokens) || settings.windowTokens <= 0)) throw new Error("Invalid Arc model or retry setting");
  const buildId = id();
  const record: BuildRecord = { trigger: kind === "incremental" ? requestOptions.trigger ?? "stop" : kind, startedAt: now(), endedAt: "", state: "done", model: settings.model, calls: 0, windows: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, repairs: [], callUsage: [], buildId, requester };
  return { buildId, sessionRef, kind, requester, settings, state: "queued", record, calls: [], callHistory: [], engineVersion, nextAt: requestOptions.nextAt };
 }
 function replay(command: BuilderCommand): RequestResult | DismissResult | undefined {
  if (fault) throw fault;
  const old = Object.hasOwn(state.commands, command.requestId) ? state.commands[command.requestId] : undefined;
  if (!old) return;
  if (old.sessionRef === command.sessionRef) {
   if (old.kind === "dismiss" && command.kind === "dismiss" && old.dropId === command.dropId && old.toPosition === command.toPosition) return { outcome: "dismissed", revision: old.revision };
   if (old.kind !== "dismiss" && command.kind !== "dismiss" && old.kind === command.kind && old.requester === command.requester && old.options?.trigger === command.options?.trigger && old.options?.nextAt === command.options?.nextAt) return { outcome: "accepted", buildId: old.buildId };
  }
  return { outcome: "refused", code: "id-conflict" };
 }
 function priorRequest(sessionRef: string, requestId: string, kind: BuildKind, requester: string, options: RequestOptions): RequestResult | undefined {
  return replay({ sessionRef, requestId, kind, requester, options }) as RequestResult | undefined;
 }
 async function request(sessionRef: string, requestId: string, kind: BuildKind, requester: string, requestOptions: RequestOptions = {}): Promise<RequestResult> {
  if (fault) throw fault;
  const prior = priorRequest(sessionRef, requestId, kind, requester, requestOptions); if (prior) return prior;
  if (!sessionRef || !requestId || !requester || !Object.hasOwn(rank, kind) || requestOptions.trigger !== undefined && !["stop", "owner"].includes(requestOptions.trigger) || requestOptions.nextAt !== undefined && !Number.isFinite(Date.parse(requestOptions.nextAt))) return { outcome: "refused", code: "invalid" };
  if (cancellation.signal.aborted) return { outcome: "refused", code: "service", transient: true, detail: "Arc service is stopping" };
  let target;
  try { target = copy(await source.snapshot(sessionRef)); } catch (e) { return { outcome: "refused", code: "source", detail: (e as Error).message }; }
  if (fault) throw fault;
  if (cancellation.signal.aborted) return { outcome: "refused", code: "service", transient: true, detail: "Arc service is stopping" };
  const accepted = priorRequest(sessionRef, requestId, kind, requester, requestOptions); if (accepted) return accepted;
  const session = Object.hasOwn(state.sessions, sessionRef) ? state.sessions[sessionRef]! : (state.sessions[sessionRef] = {});
  const oldActive = session.active ? state.jobs[session.active] : undefined;
  const paused = session.status?.pause === "uncertain-call" ? state.jobs[session.status.buildId] : undefined;
  const uncertain = oldActive?.state === "uncertain" ? oldActive : paused;
  if (uncertain && kind === "incremental") return { outcome: "refused", code: "paused" };
  const active = uncertain ? undefined : oldActive;
  let job = session.pending ? state.jobs[session.pending] : undefined;
  if (!job && active?.snapshot?.sourceVersion === target.sourceVersion && (kind === "rebuild") === (active.kind === "rebuild")) job = active;
  if (!job && !uncertain && kind === "incremental" && session.completedTarget?.sourceVersion === target.sourceVersion) job = state.jobs[session.completedTarget.buildId];
  if (!job) {
   try { job = makeJob(sessionRef, kind, requester, { ...requestOptions, nextAt: requestOptions.nextAt ?? (kind === "incremental" ? session.status?.nextAt : undefined) }); }
   catch (e) { return { outcome: "refused", code: "settings", detail: (e as Error).message }; }
   job.snapshot = target;
   if (uncertain && kind !== "rebuild") job.checkpoint = copy(uncertain.checkpoint);
   state.jobs[job.buildId] = job; session.pending = job.buildId;
  } else if (job.state === "queued") {
   if (rank[kind] > rank[job.kind]) {
    let replacement;
    try { replacement = makeJob(sessionRef, kind, requester, requestOptions); } catch (e) { return { outcome: "refused", code: "settings", detail: (e as Error).message }; }
    job.kind = kind; job.requester = requester; job.settings = replacement.settings; job.nextAt = replacement.nextAt;
    job.record.trigger = replacement.record.trigger; job.record.requester = requester; job.record.model = job.settings.model;
   }
   if (job.kind === "incremental" && requestOptions.trigger === "owner") job.record.trigger = "owner";
   const queued = job.snapshot;
   if (!queued || queued.selector !== target.selector || queued.items.length <= target.items.length || fingerprint(queued.items.slice(0, target.items.length)) !== target.fingerprint) job.snapshot = target;
  }
  if (uncertain) {
   session.active = undefined;
   job.record.possibleRepeatCost = true; job.record.retryOf = uncertain.buildId;
   job.record.reason = "This explicit retry may repeat the cost of an uncertain model call.";
  }
  state.commands[requestId] = { sessionRef, requestId, kind, requester, buildId: job.buildId, options: copy(requestOptions) };
  if (!active) session.status = { sessionRef, buildId: job.buildId, state: job.state === "done" ? "idle" : "queued", nextAt: job.nextAt };
  save();
  return { outcome: "accepted", buildId: job.buildId };
 }
 function dismiss(sessionRef: string, requestId: string, dropId: string, toPosition: number): DismissResult {
  if (fault) throw fault;
  const old = replay({ sessionRef, requestId, kind: "dismiss", dropId, toPosition }) as DismissResult | undefined;
  if (old) return old;
  if (cancellation.signal.aborted) return { outcome: "refused", code: "service", transient: true, detail: "Arc service is stopping" };
  const receipt = state.sessions[sessionRef]?.receipt;
  if (!requestId || !dropId || !receipt || !Number.isSafeInteger(toPosition) || toPosition < 1 || toPosition > receipt.receipt.asOfCount || !receipt.receipt.drops?.some(d => d.id === dropId) && !receipt.receipt.dismissedDrops?.some(d => d.id === dropId)) return { outcome: "refused", code: "invalid" };
  const previous = receipt.receipt.dismissedDrops ?? [];
  receipt.receipt.dismissedDrops = [...previous.filter(d => d.id !== dropId), { id: dropId, toPosition: Math.max(toPosition, previous.find(d => d.id === dropId)?.toPosition ?? 0) }];
  receipt.receipt.drops = receipt.receipt.drops?.filter(d => d.id !== dropId || d.toPosition > toPosition);
  receipt.revision = ++state.revision;
  state.commands[requestId] = { sessionRef, requestId, kind: "dismiss", dropId, toPosition, revision: receipt.revision };
  save(); return { outcome: "dismissed", revision: receipt.revision };
 }
 function waiting(job: BuildJob, cause: NonNullable<BuildStatus["waitCause"]>, extra: Partial<BuildStatus> = {}) {
  const session = state.sessions[job.sessionRef]!, prior = session.status;
  session.status = { sessionRef: job.sessionRef, buildId: job.buildId, state: "waiting", waitCause: cause,
   waitingSince: prior?.state === "waiting" && prior.buildId === job.buildId && prior.waitCause === cause ? prior.waitingSince ?? now() : now(), ...extra };
 }
 async function check(job: BuildJob) {
  checkCancellation();
  const checked = await source.check(job.snapshot!);
  checkCancellation();
  if (checked.kind === "unavailable") throw error("unavailable", checked.reason);
  if (checked.kind === "history-changed") {
   const session = state.sessions[job.sessionRef]!;
   // Persist the replacement obligation atomically. Its source read can wait.
   const next = session.pending ? state.jobs[session.pending]! : makeJob(job.sessionRef, "rebuild", "source", {}, job.settings);
   next.kind = "rebuild"; next.record.trigger = "rebuild"; next.snapshot = undefined; next.checkpoint = undefined;
   next.reason = checked.reason; next.record.reason = checked.reason;
   state.jobs[next.buildId] = next; session.pending = next.buildId;
   job.state = "obsolete"; job.reason = checked.reason;
   job.record.reason = checked.reason; job.record.endedAt = now(); account(job, job.record);
   session.active = undefined;
   session.status = { sessionRef: job.sessionRef, buildId: next.buildId, state: "queued", nextAt: next.nextAt };
   save(); throw error("obsolete", checked.reason);
  }
 }
 async function execute(job: BuildJob): Promise<void> {
  const session = state.sessions[job.sessionRef]!;
  let record = copy(job.record);
  try {
   checkCancellation();
   if (job.engineVersion !== engineVersion) {
    (record.engineChanges ??= []).push({ from: job.engineVersion, to: engineVersion, afterCount: job.checkpoint?.asOfCount ?? 0 });
    account(job, record);
    job.callHistory.push(...job.calls); job.calls = []; job.engineVersion = engineVersion;
    job.record = copy(record); save();
   }
   if (!job.snapshot) {
    try { job.snapshot = copy(await source.snapshot(job.sessionRef)); } catch (e) { throw error("unavailable", (e as Error).message); }
    save();
   }
   await check(job);
   let snapshot = job.snapshot;
   let previous = job.checkpoint ?? session.receipt?.receipt;
   if (previous && previous.asOfCount > snapshot.items.length) {
    try { snapshot = copy(await source.snapshot(job.sessionRef)); } catch (e) { throw error("unavailable", (e as Error).message); }
    job.snapshot = snapshot; save(); await check(job);
   }
   if (previous && (previous.selector !== snapshot.selector || snapshot.items[previous.asOfCount - 1]?.id !== previous.asOf || fingerprint(snapshot.items.slice(0, previous.asOfCount)) !== previous.fingerprint)) {
    job.kind = "rebuild"; job.reason = "Authoritative Session history changed.";
    record.trigger = "rebuild"; record.reason = job.reason; job.checkpoint = undefined;
    job.record.trigger = record.trigger; job.record.reason = record.reason; save();
   }
   if (!job.checkpoint && job.kind === "rebuild") previous = undefined;
   if (job.kind === "incremental" && !job.checkpoint && previous?.fingerprint === snapshot.fingerprint) {
    job.state = "done"; session.active = undefined; job.snapshot = undefined;
    session.status = { sessionRef: job.sessionRef, buildId: job.buildId, state: "idle" }; save(); return;
   }
   let callIndex = 0;
   const call = async (input: ModelInput) => {
    const { onWait: _onWait, ...plain } = input;
    const existing = job.calls[callIndex++];
    if (existing) {
     if (JSON.stringify(existing.input) !== JSON.stringify(plain)) throw error("version", "Stored call input changed. Build again to retry.");
     if (existing.state === "failed") throw Object.assign(error(existing.failure!.code, existing.failure!.message), { usage: existing.usage, retryAt: existing.failure!.retryAt });
     if (existing.state !== "answered") throw error("uncertain", existing.reason ?? "The last model call is uncertain.");
     return copy(existing.answer!);
    }
    await check(job); pauseClock(job);
    if ((await reconcileSurvivors()).has(job.sessionRef)) {
     waiting(job, "survivor"); save();
     throw error("busy", "An earlier model process is still running.");
    }
    const acquired = await admission.acquire(job.kind);
    if (acquired.kind === "wait") {
     waiting(job, acquired.facts.reason === "capacity" ? "capacity" : "admission-unavailable", { wait: acquired.facts, startedAt: record.startedAt }); save();
     throw error("busy", "Waiting for model admission.");
    }
    const entry: CallRecord = { id: id(), input: plain, permit: acquired.permit, state: "intent" };
    let settled = false;
    try {
     await check(job); job.calls.push(entry);
     session.status = { ...session.status!, state: "building", wait: undefined, waitCause: undefined, waitingSince: undefined, detail: undefined, nextAt: undefined };
     clocks.set(job.buildId, { start: monotonic(), elapsed: job.elapsedMs ?? 0 }); save();
     let result; const calledAt = monotonic(); inFlight.add(entry.id);
     try { result = await model.call(plain, job.settings.model, acquired.permit, {
      signal: cancellation.signal, callId: entry.id,
      started: identity => { entry.execution = copy(identity); entry.executionState = "running"; save(); },
      exited: () => { entry.executionState = "gone"; save(); },
     }); }
     catch (e) { result = { kind: "measured-unknown" as const, reason: (e as Error).message }; }
     finally { inFlight.delete(entry.id); }
     entry.ms = Math.max(0, monotonic() - calledAt);
     if (result.kind === "failed") {
      entry.state = "failed"; entry.failure = copy(result); entry.usage = result.usage; save(); settled = true;
      throw Object.assign(error(result.code, result.message), { usage: result.usage, retryAt: result.retryAt });
     }
     if (result.kind === "measured-unknown") {
      entry.state = "uncertain"; entry.reason = result.reason; entry.uncertaintyCode = result.code; entry.usage = result.usage; save();
      throw Object.assign(error("uncertain", result.reason), { usage: result.usage });
     }
     entry.state = "answered"; entry.answer = copy(result.answer); save(); settled = true;
     checkCancellation();
     return result.answer;
    } finally {
     const live = entry.execution && entry.executionState !== "gone";
     await admission.release(acquired.permit, !job.calls.includes(entry) || !live && (settled || entry.executionState === "gone") ? "settled" : "uncertain");
    }
   };
   const receipt = job.complete ? job.checkpoint! : await constructArc(snapshot, previous, record, call, (progress, work) => {
    session.status = session.status?.state === "waiting" ? { ...session.status, progress, work } : { sessionRef: job.sessionRef, buildId: job.buildId, state: "building", progress, work, startedAt: record.startedAt };
   }, job.settings.windowTokens, session.receipt?.receipt.nextPointId ?? 1, async receipt => {
    await check(job); account(job, record);
    (record.windowCheckpoints ??= []).push({ asOf: receipt.asOf, count: receipt.asOfCount, sourceVersion: snapshot.sourceVersion, engineVersion, promptVersion: receipt.promptVersion, model: record.model, usage: copy(record.usage) });
    job.checkpoint = copy(receipt); job.record = copy(record);
    job.complete = receipt.asOfCount === snapshot.items.length;
    job.callHistory.push(...job.calls); job.calls = []; callIndex = 0;
    if (!job.complete) publish(job, receipt, record, false);
    save();
   }, job.settings.retries, cancellation.signal);
   await check(job); account(job, record);
   record.endedAt = now(); record.state = "done";
   job.record = record; job.state = "done"; session.failures = 0;
   publish(job, receipt, record, true);
   session.completedTarget = { sourceVersion: snapshot.sourceVersion, buildId: job.buildId };
   job.snapshot = undefined; job.checkpoint = undefined;
   job.callHistory = job.callHistory.filter(call => call.execution && call.executionState !== "gone");
   session.active = undefined; session.status = { sessionRef: job.sessionRef, buildId: job.buildId, state: "idle" }; save();
  } catch (e) {
   if (fault) throw fault;
   const code = (e as { code?: string }).code, reason = (e as Error).message;
   account(job, record);
   if (cancellation.signal.aborted && !["done", "obsolete"].includes(job.state)) { cancelJob(job, record); save(); return; }
   if (job.state === "obsolete") {
    record.state = "failed"; record.endedAt = now(); record.reason = job.reason; job.record = record; save(); return;
   }
   if (code === "busy") { save(); return; }
   if (job.calls.some(c => c.state === "uncertain" || c.state === "intent")) {
    job.state = "uncertain"; record.state = "failed"; record.endedAt = now(); record.reason = "The last model call may have been charged."; job.record = record;
    const mismatch = job.calls.find(c => c.uncertaintyCode === "model-mismatch");
    if (mismatch) record.error = { code: "model-mismatch", message: mismatch.reason! };
    session.status = { sessionRef: job.sessionRef, buildId: job.buildId, state: "uncertain", pause: "uncertain-call" };
   } else if (code === "unavailable") {
    waiting(job, "source-unavailable", { detail: reason });
   } else {
    job.state = "failed"; session.active = undefined;
    const failed = job.calls.findLast(c => c.state === "failed")?.failure;
    record.state = "failed"; record.endedAt = now(); record.error = { code: failed?.code ?? (code === "model" || code === "answer" ? code : "internal"), message: reason }; job.record = record;
    session.failures = (session.failures ?? 0) + 1;
    const retryAt = failed?.retryAt;
    const nextAt = retryAt && Number.isFinite(Date.parse(retryAt)) ? retryAt : new Date(Date.parse(now()) + Math.min(60, 2 ** Math.min(6, session.failures - 1)) * 60_000).toISOString();
    session.status = { sessionRef: job.sessionRef, buildId: job.buildId, state: "failed", detail: reason, nextAt };
   }
   if (session.receipt?.receipt.builds.some(b => b.buildId === job.buildId)) {
    session.receipt.receipt.builds = session.receipt.receipt.builds.map(b => b.buildId === job.buildId ? copy(record) : b);
    session.receipt.revision = ++state.revision;
   }
   save();
  }
 }
 function cancelJob(job: BuildJob, record = job.record) {
  const session = state.sessions[job.sessionRef]!;
  account(job, record); record.state = "cancelled"; record.endedAt = now(); record.reason = "Arc service stop cancelled this Build.";
  job.record = record; job.state = "cancelled"; pauseClock(job);
  if (session.active === job.buildId) session.active = undefined;
  if (session.pending === job.buildId) session.pending = undefined;
  const uncertain = job.calls.some(call => call.state === "intent" || call.state === "uncertain");
  if (uncertain || session.status?.pause !== "uncertain-call") session.status = { sessionRef: job.sessionRef, buildId: job.buildId, state: uncertain ? "uncertain" : "idle", ...(uncertain ? { pause: "uncertain-call" as const } : {}), detail: record.reason };
  if (session.receipt?.receipt.builds.some(build => build.buildId === job.buildId)) {
   session.receipt.receipt.builds = session.receipt.receipt.builds.map(build => build.buildId === job.buildId ? copy(record) : build);
   session.receipt.revision = ++state.revision;
  }
 }
 function cancel(): Promise<void> {
  if (cancelled) return cancelled;
  cancellation.abort(error("cancelled", "Arc service stop cancelled this Build."));
  return cancelled = (async () => {
   const outcomes = await Promise.allSettled([...running.values()]);
   const rejected = outcomes.find(outcome => outcome.status === "rejected");
   if (rejected?.status === "rejected") throw rejected.reason;
   if (fault) throw fault;
   for (const job of Object.values(state.jobs)) if (job.state === "queued" || job.state === "running") cancelJob(job);
   save();
  })();
 }
 function publish(job: BuildJob, checkpoint: import("../../shared/arc.ts").ArcReceipt, record: BuildRecord, complete: boolean) {
  const session = state.sessions[job.sessionRef]!, prior = session.receipt?.receipt;
  if (!complete) {
   if (job.kind === "rebuild") return;
   if (prior && (checkpoint.asOfCount <= prior.asOfCount || prior.selector !== checkpoint.selector ||
       fingerprint(job.snapshot!.items.slice(0, prior.asOfCount)) !== prior.fingerprint)) return;
  }
  const receipt = copy(checkpoint), clearDismissals = complete && job.kind === "rebuild";
  const dismissals = new Map<string, number>();
  if (!clearDismissals) for (const d of [...(receipt.dismissedDrops ?? []), ...(session.receipt?.receipt.dismissedDrops ?? [])]) dismissals.set(d.id, Math.max(d.toPosition, dismissals.get(d.id) ?? 0));
  receipt.dismissedDrops = [...dismissals].map(([id, toPosition]) => ({ id, toPosition }));
  receipt.drops = receipt.drops?.filter(drop => drop.toPosition > (dismissals.get(drop.id) ?? 0));
  receipt.builds = [...Object.values(state.jobs).filter(prior => prior.sessionRef === job.sessionRef && prior.buildId !== job.buildId && Boolean(prior.record.endedAt)).map(prior => prior.record), copy(record)].slice(-30);
  session.receipt = { revision: ++state.revision, sessionRef: job.sessionRef, receipt };
 }
 function reconcileSurvivors(): Promise<Set<string>> {
  if (reconciliation) return reconciliation;
  reconciliation = (async () => {
   const blocked = new Set<string>();
   for (const job of Object.values(state.jobs)) for (const call of [...job.calls, ...job.callHistory]) {
    if (inFlight.has(call.id) || !call.execution || call.executionState === "gone") continue;
    if (await model.reconcile(call.execution) === "running") { blocked.add(job.sessionRef); continue; }
    call.executionState = "gone"; save(); await admission.release(call.permit, "settled");
   }
   return blocked;
  })().finally(() => { reconciliation = undefined; });
  return reconciliation;
 }
 async function drain(sessionRef: string) {
  const session = state.sessions[sessionRef]; if (!session) return;
  while (true) {
   if (cancellation.signal.aborted) return;
   const blocked = (await reconcileSurvivors()).has(sessionRef);
   // Poll a paused Session too. Local liveness and charge uncertainty are separate.
   if (session.status?.pause === "uncertain-call") return;
   const buildId = session.active ?? session.pending; if (!buildId) return;
   const job = state.jobs[buildId]!;
   if (blocked) { waiting(job, "survivor"); save(); return; }
   if (job.nextAt && Date.parse(job.nextAt) > Date.parse(now())) {
    session.status = { sessionRef, buildId, state: "queued", nextAt: job.nextAt }; save(); return;
   }
   if (!session.active) { session.active = session.pending; session.pending = undefined; job.state = "running"; save(); }
   await execute(job);
   if (session.active) return;
  }
 }
 function runOne(sessionRef: string): Promise<void> {
  const active = running.get(sessionRef); if (active) return active;
  const promise = Promise.resolve().then(() => { if (fault) throw fault; return drain(sessionRef); }).finally(() => running.delete(sessionRef));
  running.set(sessionRef, promise); return promise;
 }
 return {
  request, dismiss, replay, cancel,
  receipts: (knownRevisions = {}) => {
   if (fault) throw fault;
   return copy(Object.values(state.sessions).flatMap(s => s.receipt && s.receipt.revision > (knownRevisions[s.receipt.sessionRef] ?? 0) ? [s.receipt] : []).sort((a,b) => a.revision - b.revision));
  },
  status: () => {
   if (fault) throw fault;
   return copy(Object.values(state.sessions).flatMap(s => {
    if (!s.status) return [];
    const clock = clocks.get(s.status.buildId), job = state.jobs[s.status.buildId];
    const live = ["queued", "waiting", "building"].includes(s.status.state);
    const elapsedMs = live && clock && s.active === job?.buildId ? clock.elapsed + Math.max(0, monotonic() - clock.start) : job?.elapsedMs ?? 0;
    return [{ ...s.status, elapsedMs, ...(live ? { observedAt: now() } : {}), ...(job ? { record: job.record } : {}) }];
   }));
  },
  run: async sessionRef => { if (cancellation.signal.aborted) return; await Promise.all((sessionRef ? [sessionRef] : Object.keys(state.sessions)).map(runOne)); },
 };
}
