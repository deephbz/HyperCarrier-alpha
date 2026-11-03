import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBuilder, fingerprint, type Admission, type BuilderOptions, type BuilderState, type ModelInput, type ModelResult, type SourceSnapshot, type Store } from "../src/arc/core/index.ts";
import { constructArc, storeAnswer, validateAnswer } from "../src/arc/core/construct.ts";
import { hostAdmission } from "../src/arc/service/admission.ts";
import type { ArcAnswer, BuildRecord } from "../src/shared/arc.ts";

const MODEL = "fixture/model";
function snapshot(count = 6): SourceSnapshot {
 const items = Array.from({ length: count }, (_, n) => ({ id: `e${n}`, kind: n === 2 ? "compaction" as const : "user" as const, owner: true, text: `Synthetic evidence ${n}.`, t: `2026-01-01T00:0${n}:00Z` }));
 return { session: "host/session", sourceVersion: `v${count}`, selector: "fixture", fingerprint: fingerprint(items), items, entries: items.map(i => ({ id: i.id, at: i.t, tokens: 10, cost: .1 })) };
}
function answer(input: ModelInput): ModelResult {
 const data = JSON.parse(input.prompt.split("\nAnswer rejected:")[0]!);
 const item = data.rarebits.at(-1), claim = { text: "Review the work.", cites: [{ id: item.id, quote: item.text }] };
 return { kind: "answer", answer: { model: MODEL, text: JSON.stringify({ goal: claim, now: claim, chapters: [{ firstId: data.rarebits[0].id, label: "Reviewing the work", closed: true, summary: { scope: claim, bullets: [] } }], points: [] }), usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: .01 } } };
}
class MemoryStore implements Store {
 data?: BuilderState;
 fail?: (state: BuilderState) => boolean;
 load() { return this.data ? structuredClone(this.data) : undefined; }
 save(value: BuilderState) { if (this.fail?.(value)) throw new Error("simulated process loss before commit"); this.data = structuredClone(value); }
}
function fixture(overrides: Partial<BuilderOptions> = {}) {
 const store = new MemoryStore(), calls: ModelInput[] = [], releases: string[] = [];
 let data = snapshot(), next = 0;
 const options: BuilderOptions = {
  store, settings: () => ({ model: MODEL, retries: 0 }), id: () => `id-${++next}`,
  source: { snapshot: async sessionRef => ({ ...structuredClone(data), session: sessionRef }), check: async s => s.selector === data.selector && fingerprint(data.items.slice(0, s.items.length)) === s.fingerprint ? { kind: "same-prefix" } : { kind: "history-changed", sourceVersion: data.sourceVersion, reason: "An authoritative entry was removed." } },
  model: { reconcile: async () => "gone", call: async (input, _model, _permit, context) => { context.started({ pid: 4242, startedAt: "synthetic-birth" }); calls.push(input); context.exited(); return answer(input); } },
  admission: { acquire: async () => ({ kind: "permit", permit: { id: `permit-${next}` } }), release: async (_permit, outcome) => { releases.push(outcome); } },
  ...overrides,
 };
 return { options, store, calls, releases, setSource: (s: SourceSnapshot) => { data = s; }, create: () => createBuilder(options) };
}
function buildId(result: Awaited<ReturnType<ReturnType<typeof createBuilder>["request"]>>) { assert.ok("buildId" in result); return result.buildId; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

test("Builder cancellation fences clients, shares completion, persists terminal records and retains paid-call uncertainty", async () => {
 const started = deferred<void>(), released = deferred<void>();
 const f = fixture({ model: { reconcile: async () => "gone", call: async (_input, _model, _permit, context) => {
  context.started({ pid: 4242, startedAt: "synthetic-birth" }); started.resolve();
  await new Promise<void>(resolve => context.signal!.addEventListener("abort", () => { void released.promise.then(resolve); }, { once: true }));
  context.exited(); return { kind: "measured-unknown", reason: "Interrupted after dispatch" };
 } } });
 const builder = f.create(), active = buildId(await builder.request("host/session", "first", "manual", "client-one"));
 const run = builder.run(); await started.promise;
 const pending = buildId(await builder.request("host/session", "queued", "rebuild", "client-two"));
 const cancel = builder.cancel(); assert.equal(builder.cancel(), cancel);
 for (const requester of ["client-one", "client-two"]) assert.equal((await builder.request("host/session", requester, "manual", requester)).outcome, "refused");
 assert.equal((await builder.request("host/session", "first", "manual", "client-one")).outcome, "accepted", "accepted ID knowledge survives the fence");
 released.resolve(); await cancel; await run;
 for (const id of [active, pending]) { assert.equal(f.store.data!.jobs[id]!.state, "cancelled"); assert.equal(f.store.data!.jobs[id]!.record.state, "cancelled"); }
 assert.deepEqual(f.releases, ["settled"], "the model exits before its permit is released once");
 assert.equal(f.store.data!.jobs[active]!.record.usage.cost, null);
 assert.equal(builder.status()[0]!.pause, "uncertain-call");
 f.options.model.call = async input => answer(input);
 const later = f.create();
 assert.deepEqual(await later.request("host/session", "automatic", "incremental", "source"), { outcome: "refused", code: "paused" });
 const retry = buildId(await later.request("host/session", "explicit", "manual", "client-two")); await later.run();
 assert.equal(f.store.data!.jobs[retry]!.state, "done"); assert.equal(f.store.data!.jobs[retry]!.record.possibleRepeatCost, true);
 assert.equal(f.store.data!.jobs[retry]!.record.retryOf, active);
});

test("Builder cancellation waits for every current call after one terminal save fails", async () => {
 const started = deferred<void>(), exits = [deferred<void>(), deferred<void>()], exited: number[] = [];
 let calls = 0;
 const f = fixture({ model: { reconcile: async () => "gone", call: async (_input, _model, _permit, context) => {
  const index = calls++; context.started({ pid: 4242 + index, startedAt: "synthetic-birth" });
  if (calls === 2) started.resolve();
  await exits[index]!.promise; exited.push(index); context.exited();
  return { kind: "measured-unknown", reason: "Interrupted after dispatch" };
 } } });
 const builder = f.create();
 await builder.request("host/one", "one", "manual", "client"); await builder.request("host/two", "two", "manual", "client");
 const run = builder.run(); void run.catch(() => {}); await started.promise;
 f.store.fail = () => true;
 let settled = false;
 const cancellation = builder.cancel(); void cancellation.finally(() => { settled = true; }).catch(() => {});
 exits[0]!.resolve(); await new Promise(resolve => setImmediate(resolve));
 assert.deepEqual(exited, [0]); assert.equal(settled, false, "another call still owns a child");
 exits[1]!.resolve(); await assert.rejects(cancellation, /simulated process loss/); await Promise.allSettled([run]);
 assert.deepEqual(exited, [0, 1]);
});

test("Builder cancellation cannot overwrite committed success or acknowledge a failed terminal save", async () => {
 const f = fixture(), builder = f.create();
 const done = buildId(await builder.request("host/session", "done", "manual", "client")); await builder.run();
 const receipt = builder.receipts(); await builder.cancel();
 assert.equal(f.store.data!.jobs[done]!.state, "done"); assert.deepEqual(builder.receipts(), receipt);
 const other = fixture(), queued = other.create(); await queued.request("host/session", "queued", "manual", "client");
 other.store.fail = state => Object.values(state.jobs).some(job => job.state === "cancelled");
 await assert.rejects(queued.cancel(), /simulated process loss/);
 assert.equal(Object.values(other.store.data!.jobs)[0]!.state, "queued", "a failed save never acknowledges cancellation");
});

test("Builder cancellation fences a request awaiting its source and a finishing model result", async () => {
 const source = deferred<SourceSnapshot>(), f = fixture();
 f.options.source.snapshot = () => source.promise;
 const builder = f.create(), request = builder.request("host/session", "late", "manual", "client");
 await builder.cancel(); source.resolve(snapshot());
 assert.equal((await request).outcome, "refused"); assert.equal(Object.keys(f.store.data!.jobs).length, 0);
 const started = deferred<void>(), reply = deferred<ModelResult>(), g = fixture({ model: { reconcile: async () => "gone", call: async input => { started.resolve(); await reply.promise; return answer(input); } } });
 const finishing = g.create(), id = buildId(await finishing.request("host/session", "race", "manual", "client"));
 const run = finishing.run(); await started.promise;
 const cancel = finishing.cancel(); reply.resolve({ kind: "measured-unknown", reason: "unused" }); await cancel; await run;
 assert.equal(g.store.data!.jobs[id]!.state, "cancelled"); assert.equal(g.store.data!.jobs[id]!.record.usage.cost, .01);
});

test("Arc chapter times use timestamped entries inside each chapter or null", () => {
 const source = snapshot(6);
 source.entries[0]!.at = "";
 source.entries[2]!.at = "not-a-time";
 for (const entry of source.entries.slice(3)) entry.at = "";
 const claim = { text: "Synthetic evidence", cites: [{ id: "e1", quote: "Synthetic evidence 1." }] };
 const chapter = (firstId: string) => ({ firstId, label: "Checking chapter times", closed: true, summary: { scope: claim, bullets: [] } });
 const result = storeAnswer({ goal: claim, now: claim, chapters: [chapter("e0"), chapter("e3")], points: [] }, source, undefined, "2026-01-01T01:00:00Z", MODEL, []);
 assert.deepEqual(result.chapters.map(c => ({ firstAt: c.firstAt, lastAt: c.lastAt, lastId: c.lastId, tokens: c.tokens })), [
  { firstAt: source.entries[1]!.at, lastAt: source.entries[1]!.at, lastId: "e2", tokens: 30 },
  { firstAt: null, lastAt: null, lastId: "e5", tokens: 30 },
 ]);
});

test("Builder: per-Session reconnect coordinates retain older missing receipts", async () => {
 const f = fixture(), builder = f.create();
 await builder.request("pi:earlier", "first", "manual", "hub"); await builder.run();
 await builder.request("pi:later", "second", "manual", "hub"); await builder.run();
 const [earlier, later] = builder.receipts();
 assert.ok(earlier && later); assert.ok(earlier.revision < later.revision);
 assert.deepEqual(builder.receipts({ "pi:later": later.revision }), [earlier]);
 assert.deepEqual(builder.receipts({ "pi:earlier": earlier.revision, "pi:later": later.revision }), []);
 assert.deepEqual(f.create().receipts({ "pi:later": later.revision }), [earlier]);
});

test("Builder: restart restores only live identities, frees pre-dispatch and proved-gone capacity", async () => {
 for (const cut of ["before-spawn", "before-start-record", "after-exit"] as const) {
  const f = fixture(); let builder = f.create(); await builder.request("host/session", "first", "manual", "client");
  let seed: BuilderState | undefined;
  f.store.fail = state => {
   const call = Object.values(state.jobs).flatMap(j => j.calls).at(-1);
   if (cut === "before-spawn" && call?.state === "intent" && !call.execution) { seed = structuredClone(state); return true; }
   if (cut === "before-start-record" && call?.execution) return true;
   if (cut === "after-exit" && call?.state === "answered") return true;
   return false;
  };
  await assert.rejects(builder.run(), /simulated/);
  if (seed) f.store.data = seed;
  f.store.fail = undefined;
  const admission = hostAdmission("synthetic", () => 1, f.store.data);
  assert.equal(admission.running(), 0, cut);
  let probes = 0;
  f.options.admission = admission; f.options.model.reconcile = async () => { probes++; return "gone"; };
  builder = f.create();
  if (cut === "after-exit") {
   assert.equal(builder.status()[0]!.pause, "uncertain-call");
   await builder.request("host/session", "explicit", "manual", "client");
  }
  await builder.run();
  assert.equal(builder.status()[0]!.state, "idle", cut);
  const records = builder.receipts()[0]!.receipt.builds;
  assert.equal(Boolean(records.at(-1)!.possibleRepeatCost), cut === "after-exit");
  if (cut === "after-exit") assert.equal(records[0]!.usage.cost, null);
  assert.equal(admission.running(), 0); assert.equal(probes, 0);
 }
});

test("Builder: wrong-model outcomes pause with their code and preserve measured usage across restart", async () => {
 for (const cost of [undefined, null, .02]) {
  const f = fixture({ model: { reconcile: async () => "gone", call: async (_input, _model, _permit, context) => {
   context.started({ pid: 4242, startedAt: "synthetic-birth" }); context.exited();
   return { kind: "measured-unknown", code: "model-mismatch", reason: "Another model answered", ...(cost === undefined ? {} : { usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, cost } }) };
  } } });
  const builder = f.create(); await builder.request("host/session", "first", "manual", "client"); await builder.run();
  for (const current of [builder, f.create()]) {
   const status = current.status()[0]!;
   assert.equal(status.pause, "uncertain-call"); assert.equal(status.record!.error!.code, "model-mismatch");
   assert.equal(status.record!.usage.cost, cost ?? null);
   assert.deepEqual(await current.request("host/session", "auto", "incremental", "source"), { outcome: "refused", code: "paused" });
  }
 }
});

test("Builder: accepted partial windows stay published with measured failure accounting", async () => {
 let paid = 0;
 const f = fixture({ settings: () => ({ model: MODEL, retries: 0, windowTokens: 45 }), model: { reconcile: async () => "gone", call: async input => {
  paid++; return paid === 1 ? answer(input) : { kind: "failed", code: "quota", message: "Measured refusal", usage: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, cost: null } };
 } } });
 const builder = f.create(); await builder.request("host/session", "first", "manual", "client"); await builder.run();
 const partial = builder.receipts()[0]!.receipt;
 assert.ok(partial.asOfCount > 0 && partial.asOfCount < 6);
 assert.equal(paid, 2); assert.equal(builder.status()[0]!.state, "failed");
 assert.equal(partial.builds.at(-1)!.state, "failed"); assert.equal(partial.builds.at(-1)!.calls, 2);
 assert.equal(partial.builds.at(-1)!.usage.cost, null);
 assert.deepEqual(f.create().receipts()[0]!.receipt, partial);
});

test("Builder: a failed Rebuild keeps six-message coverage across restart and retains its recovery checkpoint", async () => {
 let calls = 0, rebuild = false;
 const f = fixture({ settings: () => ({ model: MODEL, retries: 0, windowTokens: rebuild ? 45 : 6000 }),
  model: { reconcile: async () => "gone", call: async input => ++calls === 3 ? { kind: "failed", code: "model", message: "Synthetic second-window refusal" } : answer(input) } });
 let builder = f.create(); await builder.request("host/session", "initial", "manual", "synthetic"); await builder.run();
 const before = builder.receipts(); assert.equal(before[0]!.receipt.asOfCount, 6);
 rebuild = true; const rebuilt = buildId(await builder.request("host/session", "rebuild", "rebuild", "synthetic")); await builder.run();
 assert.equal(calls, 3); assert.deepEqual(builder.receipts(), before);
 assert.equal(f.store.data!.jobs[rebuilt]!.checkpoint!.asOfCount, 1);
 assert.equal(builder.status()[0]!.record!.state, "failed");
 builder = f.create(); assert.deepEqual(builder.receipts(), before); assert.equal(builder.status()[0]!.record!.state, "failed");
 await builder.request("host/session", "successful", "rebuild", "synthetic"); await builder.run();
 assert.equal(builder.receipts()[0]!.receipt.asOfCount, 6); assert.ok(builder.receipts()[0]!.revision > before[0]!.revision);
});

test("Builder: partial promotion extends only the published lineage; Rebuild never promotes early", async () => {
 for (const mode of ["initial-rebuild", "incremental", "history-changed"] as const) {
  let partial = false, calls = 0;
  const f = fixture({ settings: () => ({ model: MODEL, retries: 0, windowTokens: partial ? 45 : 6000 }),
   model: { reconcile: async () => "gone", call: async input => partial && ++calls > 1 ? { kind: "failed", code: "model", message: "Synthetic later-window refusal" } : answer(input) } });
  f.setSource(snapshot(2)); let builder = f.create();
  if (mode !== "initial-rebuild") { await builder.request("host/session", "first", "manual", "client"); await builder.run(); }
  const original = builder.receipts();
  const next = snapshot(6); if (mode === "history-changed") { next.items[0]!.text = "Replacement evidence."; next.fingerprint = fingerprint(next.items); }
  f.setSource(next); partial = true;
  const request = await builder.request("host/session", "partial", mode === "initial-rebuild" ? "rebuild" : "incremental", "client");
  await builder.run(); assert.ok(f.store.data!.jobs[buildId(request)]!.checkpoint);
  if (mode === "incremental") assert.ok(builder.receipts()[0]!.receipt.asOfCount > original[0]!.receipt.asOfCount);
  else assert.deepEqual(builder.receipts(), original);
  const published = builder.receipts(); builder = f.create(); assert.deepEqual(builder.receipts(), published);
 }
});

test("Builder: durable acceptance deduplicates retries and preserves the strongest queued intent after restart", async () => {
 const f = fixture(); let builder = f.create();
 const first = await builder.request("host/session", "request-a", "incremental", "client-a");
 const command = f.store.load()!.commands["request-a"]!; assert.notEqual(command.kind, "dismiss");
 assert.ok("buildId" in command); assert.equal(command.buildId, buildId(first));
 assert.deepEqual(await builder.request("host/session", "request-a", "incremental", "client-a"), first);
 assert.deepEqual(await builder.request("host/other", "request-a", "incremental", "client-a"), { outcome: "refused", code: "id-conflict" });
 assert.equal(buildId(await builder.request("host/session", "request-b", "rebuild", "client-b")), buildId(first));
 builder = f.create(); await builder.run();
 assert.equal(f.calls.length, 1);
 assert.equal(builder.receipts()[0]!.receipt.builds[0]!.trigger, "rebuild");
 assert.equal(builder.receipts()[0]!.receipt.builds[0]!.requester, "client-b");
 assert.deepEqual(builder.receipts({ "host/session": 1 }), []);
 assert.deepEqual(await builder.request("host/session", "request-a", "incremental", "client-a"), first);
});

test("Builder: a manual press joins the active Build; a queued Rebuild and incremental triggers do not overlap calls", async () => {
 const entered = deferred<void>(), release = deferred<void>(); let active = 0, peak = 0, count = 0;
 const f = fixture({ model: { reconcile: async () => "gone", call: async input => { count++; peak = Math.max(peak, ++active); if (count === 1) { entered.resolve(); await release.promise; } active--; return answer(input); } } });
 const builder = f.create();
 const first = await builder.request("host/session", "one", "manual", "client-a");
 const work = builder.run(); await entered.promise;
 assert.deepEqual(await builder.request("host/session", "two", "manual", "client-b"), first);
 const rebuild = await builder.request("host/session", "three", "rebuild", "client-b");
 assert.notEqual(buildId(rebuild), buildId(first));
 await builder.request("host/session", "four", "incremental", "watcher");
 release.resolve(); await Promise.all([work, builder.run()]);
 assert.equal(peak, 1); assert.equal(count, 2);
 assert.equal(builder.receipts()[0]!.receipt.builds.at(-1)!.trigger, "rebuild");
});

test("Builder: duplicate incremental targets pay once while different Sessions run independently", async () => {
 const entered = deferred<void>(), release = deferred<void>(); let active = 0, peak = 0, calls = 0;
 const f = fixture({ model: { reconcile: async () => "gone", call: async input => { calls++; peak = Math.max(peak, ++active); entered.resolve(); await release.promise; active--; return answer(input); } } });
 const builder = f.create(); const first = await builder.request("host/session", "one", "incremental", "client-a");
 const a = builder.run(); await entered.promise;
 assert.deepEqual(await builder.request("host/session", "two", "incremental", "client-b"), first);
 await builder.request("host/other", "three", "manual", "client-b");
 const b = builder.run("host/other");
 await new Promise<void>(resolve => setImmediate(resolve)); release.resolve(); await Promise.all([a,b]);
 assert.equal(calls, 2); assert.equal(peak, 2);
});

test("Builder: admission waits persist facts and acceptance without a call intent or failure", async () => {
 let capacity = false;
 const f = fixture({ admission: { acquire: async () => capacity ? { kind: "permit", permit: { id: "slot" } } : { kind: "wait", facts: { reason: "capacity", running: 8, limit: 8, scope: "fixture-host" } }, release: async () => {} } });
 let builder = f.create(); await builder.request("host/session", "one", "manual", "client"); await builder.run();
 assert.equal(f.calls.length, 0); assert.equal(Object.values(f.store.data!.jobs)[0]!.calls.length, 0);
 assert.deepEqual(builder.status()[0]!.wait, { reason: "capacity", running: 8, limit: 8, scope: "fixture-host" });
 builder = f.create(); await builder.run(); assert.equal(builder.status()[0]!.state, "waiting");
 capacity = true; await builder.run();
 assert.equal(f.calls.length, 1); assert.equal(builder.status()[0]!.state, "idle");
});

test("Builder: a stored model answer survives a crash before its window checkpoint without another charge", async () => {
 const f = fixture(); const builder = f.create(); await builder.request("host/session", "one", "manual", "client");
 f.store.fail = state => Object.values(state.jobs).some(j => Boolean(j.checkpoint));
 await assert.rejects(builder.run(), /simulated process loss/);
 assert.equal(f.calls.length, 1); assert.equal(Object.values(f.store.data!.jobs)[0]!.calls[0]!.state, "answered");
 f.store.fail = undefined; const recovered = f.create(); await recovered.run();
 assert.equal(f.calls.length, 1); assert.equal(recovered.receipts()[0]!.receipt.asOfCount, 6);
 assert.equal(recovered.receipts()[0]!.receipt.builds[0]!.usage.cost, .01);
});

test("Builder: recovery resumes a committed window and never repeats it", async () => {
 const f = fixture({ settings: () => ({ model: MODEL, retries: 0, windowTokens: 45 }) });
 const builder = f.create(); await builder.request("host/session", "one", "manual", "client");
 f.store.fail = state => Object.values(state.jobs).some(j => j.record.windows === 1 && j.calls.some(c => c.state === "intent"));
 await assert.rejects(builder.run(), /simulated process loss/);
 assert.equal(f.calls.length, 1); const covered = Object.values(f.store.data!.jobs)[0]!.checkpoint!.asOfCount;
 assert.ok(covered > 0 && covered < 6);
 f.store.fail = undefined; const recovered = f.create(); await recovered.run();
 assert.equal(recovered.receipts()[0]!.receipt.asOfCount, 6);
 const inputs = f.calls.map(input => JSON.parse(input.prompt).rarebits.map((i: { id: string }) => i.id));
 assert.equal(inputs.filter(ids => ids.includes("e0")).length, 1);
 assert.equal(recovered.receipts()[0]!.receipt.builds[0]!.calls, f.calls.length);
});

test("Builder: a crash after provider acceptance keeps the last Arc and pauses automatic work until an explicit retry", async () => {
 const f = fixture(); let builder = f.create(); await builder.request("host/session", "first", "manual", "client"); await builder.run();
 const lastGood = builder.receipts();
 f.setSource(snapshot(8)); await builder.request("host/session", "second", "manual", "client");
 f.store.fail = state => Object.values(state.jobs).some(j => j.buildId !== lastGood[0]!.receipt.builds[0]!.buildId && j.calls.some(c => c.state === "answered"));
 await assert.rejects(builder.run(), /simulated process loss/);
 assert.equal(f.calls.length, 2);
 f.store.fail = undefined; builder = f.create(); await builder.run();
 assert.equal(f.calls.length, 2); assert.equal(builder.status()[0]!.state, "uncertain");
 assert.deepEqual(builder.receipts(), lastGood);
 assert.deepEqual(await builder.request("host/session", "auto", "incremental", "watcher"), { outcome: "refused", code: "paused" }); await builder.run();
 assert.equal(f.calls.length, 2);
 await builder.request("host/session", "explicit-retry", "manual", "client"); await builder.run();
 assert.equal(f.calls.length, 3); assert.equal(builder.status()[0]!.state, "idle");
 assert.ok(builder.receipts()[0]!.receipt.builds.some(r => r.reason?.includes("may have been charged")));
 assert.equal(builder.receipts()[0]!.receipt.builds.at(-1)!.possibleRepeatCost, true);
 assert.ok(Object.values(f.store.data!.jobs).some(j => j.calls.some(c => c.state === "uncertain")));
});

test("Builder: a measured-unknown answer and a thrown provider error both retain uncertain permits", async () => {
 for (const throws of [false, true]) {
  const outcomes: string[] = [];
  const f = fixture({ model: { reconcile: async () => "gone", call: async () => { if (throws) throw new Error("lost connection"); return { kind: "measured-unknown", reason: "lost answer", usage: { input: 12, output: 0, cacheRead: 0, cacheWrite: 0, cost: null } }; } }, admission: { acquire: async () => ({ kind: "permit", permit: { id: "slot" } }), release: async (_permit, outcome) => { outcomes.push(outcome); } } });
  const builder = f.create(); await builder.request("host/session", "one", "manual", "client"); await builder.run();
  assert.equal(builder.status()[0]!.state, "uncertain"); assert.deepEqual(outcomes, ["uncertain"]);
  await f.create().run(); assert.equal(outcomes.length, 1);
 }
});

test("Builder: failed durable acceptance cannot acknowledge or start a model call", async () => {
 const f = fixture(); const builder = f.create(); f.store.fail = state => Object.keys(state.commands).length > 0;
 await assert.rejects(() => builder.request("host/session", "one", "manual", "client"), /simulated/);
 await assert.rejects(builder.run(), /simulated/); assert.equal(f.calls.length, 0);
 f.store.fail = undefined; await f.create().run(); assert.equal(f.calls.length, 0);
});

test("Builder: a history change during a call discards its result and records one automatic Rebuild", async () => {
 let calls = 0;
 const f = fixture({ model: { reconcile: async () => "gone", call: async input => {
  calls++; if (calls === 1) { const next = snapshot(4); next.items[0]!.text = "Replacement synthetic evidence."; next.fingerprint = fingerprint(next.items); next.sourceVersion = "branch-two"; f.setSource(next); }
  return answer(input);
 } } });
 const builder = f.create(); await builder.request("host/session", "one", "manual", "client"); await builder.run();
 assert.equal(calls, 2); const receipts = builder.receipts(); assert.equal(receipts[0]!.revision, 1);
 assert.equal(receipts[0]!.receipt.asOfCount, 4); assert.equal(receipts[0]!.receipt.builds.at(-1)!.trigger, "rebuild");
 assert.match(receipts[0]!.receipt.builds.at(-1)!.reason!, /removed/);
 assert.equal(Object.values(f.store.data!.jobs).filter(j => j.state === "obsolete").length, 1);
});

test("Builder: appends preserve snapshots and compaction entries; unavailable source does not authorize a Rebuild", async () => {
 const f = fixture({ model: { reconcile: async () => "gone", call: async input => { assert.ok(JSON.parse(input.prompt).rarebits.some((i: { kind: string }) => i.kind === "compaction")); f.setSource(snapshot(8)); return answer(input); } } });
 const builder = f.create(); await builder.request("host/session", "one", "manual", "client"); await builder.run();
 assert.equal(builder.receipts()[0]!.receipt.asOfCount, 6); assert.equal(Object.keys(f.store.data!.jobs).length, 1);
 const unavailable = fixture({ source: { snapshot: async () => snapshot(), check: async () => ({ kind: "unavailable", reason: "Source is offline" }) } });
 const waiting = unavailable.create(); await waiting.request("host/session", "one", "manual", "client"); await waiting.run();
 assert.equal(unavailable.calls.length, 0); assert.equal(Object.keys(unavailable.store.data!.jobs).length, 1);
 assert.equal(waiting.status()[0]!.state, "waiting"); assert.equal(waiting.receipts().length, 0);
});

const record = (): BuildRecord => ({ trigger: "manual", startedAt: "2026-01-01T00:00:00Z", endedAt: "", state: "done", calls: 0, windows: 0, model: MODEL, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, repairs: [] });
function arcAnswer(s: SourceSnapshot): ArcAnswer {
 const claim = { text: "Review the work.", cites: [{ id: s.items[0]!.id, quote: s.items[0]!.text }] };
 return { goal: claim, now: claim, chapters: [{ firstId: s.items[0]!.id, label: "Reviewing the work", closed: false, summary: { scope: claim, bullets: [] } }], points: [] };
}
test("Construction: only an identifiable new Needs you point retries within the configured budget", async () => {
 for (const retries of [0, 1, 2]) for (const waits of ["owner", "agent"] as const) {
  const s = snapshot(), raw = arcAnswer(s), r = record(); let calls = 0;
  raw.points = [{ kind: "request", state: "open", waits, by: "agent", title: "Check the result", text: "Review it.", cites: [{ id: "missing", quote: "Missing evidence" }] }];
  const receipt = await constructArc(s, undefined, r, async () => { calls++; return { model: MODEL, text: JSON.stringify(raw) }; }, undefined, undefined, 1, undefined, retries);
  assert.equal(calls, waits === "owner" && retries > 0 ? 2 : 1);
  assert.equal(receipt.drops?.length, 1); assert.equal(receipt.drops[0]!.needsYou, waits === "owner");
  assert.equal(r.drops?.length, 1);
 }
});

test("Construction: accepted deltas retain omitted points and kept marks; new drops persist across windows", async () => {
 const s = snapshot(), raw = arcAnswer(s);
 raw.points = [{ kind: "request", state: "open", waits: "owner", by: "agent", title: "Check the result", text: "Review it.", cites: raw.now.cites }];
 const previous = storeAnswer(raw, s, undefined, "2026-01-01T00:00:00Z", MODEL, []);
 const omitted = storeAnswer(validateAnswer(arcAnswer(s), s, s.items, previous, []), s, previous, "2026-01-01T00:01:00Z", MODEL, []);
 assert.deepEqual(omitted.points, previous.points);
 let calls = 0;
 const receipt = await constructArc(s, undefined, record(), async input => {
  calls++; const result = answer(input); assert.equal(result.kind, "answer");
  const raw = JSON.parse(result.answer.text);
  if (calls === 1) raw.points = [{ kind: "request", state: "open", waits: "agent", by: "agent", title: "Check the result", text: "Review it.", cites: [] }];
  return { ...result.answer, text: JSON.stringify(raw) };
 }, undefined, 45, 1, undefined, 0);
 assert.ok(calls > 1); assert.equal(receipt.drops?.length, 1);
});

test("Builder: a recorded survivor blocks recovery until PID and start identity are reconciled", async () => {
 let gone = false, paid = 0;
 const identity = { pid: 4242, startedAt: "synthetic-process-birth" };
 const f = fixture({ model: {
  reconcile: async found => { assert.deepEqual(found, identity); return gone ? "gone" : "running"; },
  call: async (input, _exact, _permit, context) => {
   context.started(identity);
   assert.deepEqual(Object.values(f.store.data!.jobs).flatMap(j => j.calls).find(c => c.id === context.callId)!.execution, identity);
   paid++; return answer(input);
  },
 } });
 let builder = f.create(); await builder.request("host/session", "one", "manual", "client");
 f.store.fail = state => Object.values(state.jobs).some(j => j.calls.some(c => c.state === "answered"));
 await assert.rejects(builder.run(), /simulated/); assert.equal(paid, 1);
 f.store.fail = undefined; builder = f.create();
 assert.equal(builder.status()[0]!.state, "uncertain");
 await builder.request("host/session", "retry", "manual", "client"); await builder.run();
 assert.equal(paid, 1); assert.equal(builder.status()[0]!.waitCause, "survivor");
 gone = true; await builder.run(); assert.equal(paid, 2);
 assert.equal(builder.receipts()[0]!.receipt.builds.at(-1)!.possibleRepeatCost, true);
 assert.ok(builder.receipts()[0]!.receipt.builds.some(r => r.reason?.includes("may have been charged")));
});

test("Builder: a failed spawn handshake cannot dispatch the model prompt", async () => {
 let paid = 0;
 const f = fixture({ model: { reconcile: async () => "gone", call: async (input, _model, _permit, context) => {
  context.started({ pid: 4242, startedAt: "synthetic-birth" });
  paid++; return answer(input);
 } } });
 const builder = f.create(); await builder.request("host/session", "one", "manual", "client");
 f.store.fail = state => Object.values(state.jobs).some(j => j.calls.some(c => Boolean(c.execution)));
 await assert.rejects(builder.run(), /simulated/); assert.equal(paid, 0);
 f.store.fail = undefined; const recovered = f.create(); await recovered.run();
 assert.equal(paid, 1); assert.equal(recovered.status()[0]!.state, "idle");
 assert.equal(recovered.receipts()[0]!.receipt.builds.at(-1)!.possibleRepeatCost, undefined);
});

test("Builder: uncertain work pauses only its Session and retains a queued Rebuild across restart", async () => {
 const entered = deferred<void>(), finish = deferred<void>(); let calls = 0;
 const f = fixture({ model: { reconcile: async () => "gone", call: async input => {
  calls++; if (calls === 1) { entered.resolve(); await finish.promise; return { kind: "measured-unknown", reason: "Missing result" }; }
  return answer(input);
 } } });
 let builder = f.create(); await builder.request("host/session", "one", "incremental", "client");
 const run = builder.run(); await entered.promise;
 const rebuild = await builder.request("host/session", "two", "rebuild", "client"); finish.resolve(); await run;
 builder = f.create(); await builder.run(); assert.equal(calls, 1);
 assert.deepEqual(await builder.request("host/session", "auto", "incremental", "watcher"), { outcome: "refused", code: "paused" });
 await builder.request("host/other", "other", "manual", "client"); await builder.run(); assert.equal(calls, 2);
 assert.deepEqual(await builder.request("host/session", "explicit", "manual", "client"), rebuild);
 await builder.run(); assert.equal(calls, 3);
 const receipt = builder.receipts().find(r => r.sessionRef === "host/session")!.receipt;
 assert.equal(receipt.builds.at(-1)!.trigger, "rebuild"); assert.equal(receipt.builds.at(-1)!.possibleRepeatCost, true);
});

test("Builder: idle, failed and uncertain projections stay stable when clocks advance", async t => {
 for (const terminal of ["idle", "failed", "uncertain"] as const) await t.test(terminal, async () => {
  let wall = "2026-01-01T00:00:00Z", mono = 0;
  const f = fixture({ now: () => wall, monotonic: () => mono, model: { reconcile: async () => "gone", call: async input => {
   mono = 250;
   if (terminal === "failed") return { kind: "failed", code: "model", message: "Synthetic refusal" };
   if (terminal === "uncertain") return { kind: "measured-unknown", reason: "Synthetic missing answer" };
   return answer(input);
  } } });
  const builder = f.create(); await builder.request("host/session", "one", "manual", "client");
  assert.equal(builder.status()[0]!.observedAt, wall, "queued projection retains a current clock sample");
  await builder.run();
  const ended = builder.status()[0]!;
  assert.equal(ended.state, terminal); assert.equal(ended.elapsedMs, 250);
  wall = "2026-01-01T02:00:00Z"; mono += 7_200_000;
  assert.deepEqual(builder.status()[0], ended, "stopped Build projection does not change on a status read");
  assert.equal(ended.observedAt, undefined, "stopped Build has no live clock sample");
  assert.deepEqual(f.create().status()[0], ended, "restart preserves the stable completed projection");
 });
});

test("Builder: elapsed time comes from the Host monotonic clock and freezes after completion", async () => {
 let mono = 100, wall = "2026-01-01T00:00:00Z";
 const entered = deferred<void>(), finish = deferred<void>();
 const f = fixture({ monotonic: () => mono, now: () => wall, model: { reconcile: async () => "gone", call: async input => { entered.resolve(); await finish.promise; return answer(input); } } });
 const builder = f.create(); await builder.request("host/session", "one", "manual", "client");
 const run = builder.run(); await entered.promise;
 mono = 400; wall = "2025-01-01T00:00:00Z";
 assert.equal(builder.status()[0]!.elapsedMs, 300);
 assert.equal(builder.status()[0]!.observedAt, wall, "building projection samples the current clock");
 finish.resolve(); await run; mono = 999;
 assert.equal(builder.status()[0]!.elapsedMs, 300); assert.equal(f.create().status()[0]!.elapsedMs, 300);
});

test("Builder: an engine update resumes accepted windows and preserves their provenance", async () => {
 const f = fixture({ engineVersion: "engine-one", settings: () => ({ model: MODEL, retries: 0, windowTokens: 45 }) });
 const builder = f.create(); await builder.request("host/session", "one", "manual", "client");
 f.store.fail = state => Object.values(state.jobs).some(j => j.record.windows === 1 && j.calls.some(c => c.state === "intent"));
 await assert.rejects(builder.run(), /simulated/); assert.equal(f.calls.length, 1);
 f.store.fail = undefined; f.options.engineVersion = "engine-two";
 const recovered = f.create(); await recovered.run();
 const record = recovered.receipts()[0]!.receipt.builds.at(-1)!;
 assert.equal(record.windowCheckpoints![0]!.engineVersion, "engine-one");
 assert.ok(record.windowCheckpoints!.slice(1).every(w => w.engineVersion === "engine-two"));
 assert.deepEqual(record.engineChanges, [{ from: "engine-one", to: "engine-two", afterCount: record.windowCheckpoints![0]!.count }]);
});

test("Builder: a failed Rebuild retains published losses; only a committed replacement clears them", async () => {
 let mode: "drop" | "fail" | "partial" | "clean" = "drop", partialCalls = 0;
 const f = fixture({ model: { reconcile: async () => "gone", call: async input => {
  const result = answer(input); assert.equal(result.kind, "answer");
  if (mode === "fail" || mode === "partial" && ++partialCalls > 1) return { kind: "answer", answer: { ...result.answer, text: "invalid" } };
  const raw = JSON.parse(result.answer.text);
  if (mode === "drop") raw.points = [{ kind: "request", state: "open", waits: "agent", by: "agent", title: "Check the work", text: "Review it.", cites: [] }];
  return { kind: "answer", answer: { ...result.answer, text: JSON.stringify(raw) } };
 } } });
 let builder = f.create(); await builder.request("host/session", "one", "manual", "client"); await builder.run();
 const original = builder.receipts(); assert.equal(original[0]!.receipt.drops?.length, 1);
 builder = f.create(); mode = "fail"; await builder.request("host/session", "two", "rebuild", "client"); await builder.run();
 assert.deepEqual(builder.receipts(), original);
 mode = "partial"; f.options.settings = () => ({ model: MODEL, retries: 0, windowTokens: 45 });
 await builder.request("host/session", "partial", "rebuild", "client"); await builder.run();
 assert.deepEqual(builder.receipts(), original);
 assert.equal(builder.status()[0]!.record!.state, "failed");
 assert.ok(Object.values(f.store.data!.jobs).some(j => j.kind === "rebuild" && j.checkpoint && j.checkpoint.asOfCount < 6));
 builder = f.create(); assert.deepEqual(builder.receipts(), original);
 mode = "clean"; await builder.request("host/session", "three", "rebuild", "client"); await builder.run();
 assert.deepEqual(builder.receipts()[0]!.receipt.drops, []);
});

test("Construction: rejected-attempt diagnostics do not become published losses after a corrected or omitted retry", async () => {
 for (const retry of ["corrected", "omitted"] as const) {
  const s = snapshot(), raw = arcAnswer(s), r = record(); let calls = 0;
  raw.points = [{ kind: "request", state: "open", waits: "owner", by: "agent", title: "Check the result", text: "Review it.", cites: [] }];
  const receipt = await constructArc(s, undefined, r, async () => {
   calls++; const next = structuredClone(raw);
   if (calls === 2) next.points = retry === "omitted" ? [] : [{ ...raw.points[0]!, cites: raw.now.cites }];
   return { model: MODEL, text: JSON.stringify(next) };
  }, undefined, undefined, 1, undefined, 2);
  assert.equal(calls, 2); assert.equal(r.rejectedAttempts?.length, 1);
  assert.equal(r.rejectedAttempts[0]!.drops.length, 1); assert.deepEqual(receipt.drops, []);
 }
 const s = snapshot(), raw = arcAnswer(s), r = record();
 raw.points = [{ kind: "request", state: "open", by: "agent", title: "Check the result", text: "Review it.", cites: raw.now.cites }];
 const receipt = await constructArc(s, undefined, r, async () => ({ model: MODEL, text: JSON.stringify(raw) }));
 assert.equal(r.calls, 1); assert.equal(receipt.drops?.length, 1); assert.equal(receipt.drops[0]!.needsYou, false);
});

test("Builder: completed automatic cursors deduplicate across restart", async () => {
 const f = fixture(); let builder = f.create();
 const first = await builder.request("host/session", "one", "incremental", "watcher"); await builder.run();
 builder = f.create(); assert.deepEqual(await builder.request("host/session", "two", "incremental", "watcher"), first);
 await builder.run(); assert.equal(f.calls.length, 1);
});

test("Builder: delayed source snapshots cannot move queued append targets backwards", async () => {
 const stale = deferred<SourceSnapshot>(); let reads = 0;
 const latest = snapshot(8), f = fixture({ source: {
  snapshot: async () => ++reads === 1 ? stale.promise : structuredClone(latest),
  check: async () => ({ kind: "same-prefix" }),
 } });
 const builder = f.create(); const older = builder.request("host/session", "older", "incremental", "watcher");
 const newer = await builder.request("host/session", "newer", "incremental", "watcher");
 stale.resolve(snapshot(4)); assert.deepEqual(await older, newer);
 await builder.run(); assert.equal(builder.receipts()[0]!.receipt.asOfCount, 8); assert.equal(f.calls.length, 1);
});

test("Builder: re-acquisition keeps wait facts visible until a permit arrives", async () => {
 let attempt = 0; const acquire = deferred<Awaited<ReturnType<Admission["acquire"]>>>();
 const f = fixture({ admission: {
  acquire: async () => ++attempt === 1 ? { kind: "wait", facts: { reason: "capacity", running: 8, limit: 8, scope: "fixture" } } : acquire.promise,
  release: async () => {},
 } });
 const builder = f.create(); await builder.request("host/session", "one", "manual", "client"); await builder.run();
 const waiting = builder.status()[0]!.wait, run = builder.run();
 await new Promise<void>(resolve => setImmediate(resolve));
 assert.equal(builder.status()[0]!.state, "waiting"); assert.deepEqual(builder.status()[0]!.wait, waiting);
 acquire.resolve({ kind: "permit", permit: { id: "slot" } }); await run;
 assert.equal(builder.status()[0]!.state, "idle");
});

test("Builder: failed publication cannot expose an uncommitted receipt and recovery reuses the final checkpoint", async () => {
 const f = fixture(); const builder = f.create(); await builder.request("host/session", "one", "manual", "client");
 f.store.fail = state => state.revision > 0;
 await assert.rejects(builder.run(), /simulated/);
 assert.throws(() => builder.receipts(), /simulated/); assert.throws(() => builder.status(), /simulated/);
 assert.equal(f.calls.length, 1); assert.equal(f.store.data!.revision, 0);
 f.store.fail = undefined; const recovered = f.create(); await recovered.run();
 assert.equal(f.calls.length, 1); assert.equal(recovered.receipts()[0]!.revision, 1);
});

test("Builder: a history-change successor survives a transient replacement read failure and restart", async () => {
 let changed = false, offline = false;
 const f = fixture({ source: {
  snapshot: async () => { if (offline) throw new Error("Synthetic source offline"); return snapshot(changed ? 3 : 6); },
  check: async s => changed && s.sourceVersion === "v6" ? { kind: "history-changed", sourceVersion: "v3", reason: "Authoritative history changed" } : { kind: "same-prefix" },
 } });
 let builder = f.create(); await builder.request("host/session", "one", "manual", "client");
 changed = true; offline = true; await builder.run();
 assert.equal(f.calls.length, 0); assert.equal(builder.status()[0]!.waitCause, "source-unavailable");
 assert.equal(Object.values(f.store.data!.jobs).filter(j => j.state === "obsolete").length, 1);
 assert.ok(f.store.data!.sessions["host/session"]!.active);
 builder = f.create(); offline = false; await builder.run();
 assert.equal(f.calls.length, 1); assert.equal(builder.receipts()[0]!.receipt.asOfCount, 3);
 assert.equal(builder.receipts()[0]!.receipt.builds.at(-1)!.trigger, "rebuild");
 assert.equal(builder.receipts()[0]!.receipt.builds.at(-1)!.reason, "Authoritative history changed");
});

test("Builder: an answered call keeps its exact cost when recovery finds obsolete evidence", async () => {
 const f = fixture(); let builder = f.create();
 await builder.request("host/session", "one", "manual", "client");
 f.store.fail = state => Object.values(state.jobs).some(j => Boolean(j.checkpoint));
 await assert.rejects(builder.run(), /simulated process loss/); assert.equal(f.calls.length, 1);
 f.store.fail = undefined; f.setSource(snapshot(3)); builder = f.create(); await builder.run();
 assert.equal(f.calls.length, 2);
 const records = builder.receipts()[0]!.receipt.builds;
 assert.deepEqual(records.map(r => [r.calls, r.usage.cost]), [[1, .01], [1, .01]]);
 await f.create().run(); assert.equal(f.calls.length, 2);
});

test("Builder: in-process survivors block only their Session, release on exit, and preserve unknown billing", async () => {
 for (const limit of [1, 8]) {
  let live = true, calls = 0, serial = 0, reconciles = 0;
  const held = new Set<string>();
  const f = fixture({ admission: {
   acquire: async () => {
    if (held.size >= limit) return { kind: "wait", facts: { reason: "capacity", running: held.size, limit, scope: "fixture" } };
    const id = `slot-${++serial}`; held.add(id); return { kind: "permit", permit: { id } };
   },
   release: async (p, outcome) => { if (outcome === "settled") held.delete(p.id); },
  }, model: {
   reconcile: async () => { reconciles++; return live ? "running" : "gone"; },
   call: async (input, _model, _permit, context) => {
    calls++;
    if (calls === 1) { context.started({ pid: 4242, startedAt: "synthetic-birth" }); return { kind: "measured-unknown", reason: "Missing result" }; }
    return answer(input);
   },
  } });
  const builder = f.create(); await builder.request("host/session", "one", "manual", "client"); await builder.run();
  assert.equal(builder.status()[0]!.pause, "uncertain-call");
  await builder.request("host/session", "retry", "manual", "client"); await builder.run();
  assert.equal(calls, 1); assert.equal(builder.status()[0]!.waitCause, "survivor");
  await builder.request("host/other", "other", "manual", "client"); await builder.run("host/other");
  assert.equal(calls, limit === 1 ? 1 : 2);
  live = false; await builder.run(); await builder.run();
  assert.ok(reconciles > 0); assert.equal(calls, 3); assert.equal(held.size, 0);
  const receipt = builder.receipts().find(r => r.sessionRef === "host/session")!.receipt;
  assert.equal(receipt.builds[0]!.usage.cost, null); assert.equal(receipt.builds.at(-1)!.possibleRepeatCost, true);
 }
});

test("Builder: a paused Session reconciles an exited child without clearing its charge warning", async () => {
 let live = true, settled = 0;
 const f = fixture({ admission: { acquire: async () => ({ kind: "permit", permit: { id: "slot" } }), release: async (_p, outcome) => { if (outcome === "settled") settled++; } }, model: {
  reconcile: async () => live ? "running" : "gone",
  call: async (_i, _m, _p, context) => { context.started({ pid: 4242, startedAt: "synthetic" }); return { kind: "measured-unknown", reason: "Lost response" }; },
 } });
 const builder = f.create(); await builder.request("host/session", "one", "manual", "client"); await builder.run();
 live = false; await builder.run(); await builder.run();
 assert.equal(settled, 1); assert.equal(builder.status()[0]!.pause, "uncertain-call");
});

test("Builder: proven model failures back off without a charge pause; only an unknown call pauses", async () => {
 const reset = "2026-01-01T01:00:00Z";
 const cases: ModelResult[] = [
  { kind: "failed", code: "settings", message: "Synthetic auth.json has no sign-in" },
  { kind: "failed", code: "model", message: "Synthetic executable missing" },
  { kind: "failed", code: "quota", message: "Quota exhausted", retryAt: reset },
  { kind: "failed", code: "model", message: "Answered with another model", usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: .02 } },
  { kind: "measured-unknown", reason: "Timeout after dispatch" },
 ];
 for (const result of cases) {
  const f = fixture({ now: () => "2026-01-01T00:00:00Z", model: { reconcile: async () => "gone", call: async () => result } });
  const builder = f.create(); await builder.request("host/session", "one", "manual", "client"); await builder.run();
  const status = builder.status()[0]!;
  if (result.kind === "failed") {
   assert.equal(status.state, "failed"); assert.equal(status.pause, undefined);
   assert.equal(status.record!.error!.code, result.code);
   assert.equal(status.record!.usage.cost, result.usage?.cost ?? 0);
   assert.equal(status.nextAt, result.retryAt ?? "2026-01-01T00:01:00.000Z");
   assert.ok("buildId" in await builder.request("host/session", "auto", "incremental", "watcher"));
   await builder.run(); assert.equal(builder.status()[0]!.state, "queued");
  } else { assert.equal(status.pause, "uncertain-call"); assert.equal(status.record!.usage.cost, null); }
 }
});

test("Builder: owner triggers and scheduled starts persist; admission waiting does not increase elapsed time", async () => {
 let wall = "2026-01-01T00:00:00Z", mono = 0, capacity = false;
 const f = fixture({ now: () => wall, monotonic: () => mono, admission: {
  acquire: async () => capacity ? { kind: "permit", permit: { id: "slot" } } : { kind: "wait", facts: { reason: "capacity", running: 8, limit: 8, scope: "shared", byHost: { first: 5, second: 3 } } },
  release: async () => {},
 }, model: { reconcile: async () => "gone", call: async input => { mono += 100; return answer(input); } } });
 let builder = f.create();
 await builder.request("host/session", "one", "incremental", "watcher", { trigger: "owner", nextAt: "2026-01-01T00:01:00Z" });
 await builder.run(); assert.equal(builder.status()[0]!.state, "queued");
 builder = f.create(); assert.equal(builder.status()[0]!.nextAt, "2026-01-01T00:01:00Z");
 wall = "2026-01-01T00:01:00Z"; await builder.run();
 mono = 60_000; await builder.run();
 assert.equal(builder.status()[0]!.elapsedMs, 0); assert.equal(builder.status()[0]!.waitCause, "capacity");
 assert.deepEqual(builder.status()[0]!.wait!.byHost, { first: 5, second: 3 });
 capacity = true; await builder.run();
 assert.equal(builder.status()[0]!.elapsedMs, 100); assert.equal(builder.receipts()[0]!.receipt.builds[0]!.trigger, "owner");
});

test("Builder: repeated losses deduplicate by kind and title, narrow to cites, and dismiss durably", async () => {
 const f = fixture({ model: { reconcile: async () => "gone", call: async input => {
  const result = answer(input); assert.equal(result.kind, "answer");
  const raw = JSON.parse(result.answer.text);
  raw.points = [{ kind: "request", state: "open", by: "agent", waits: "owner", title: "Check the work", text: "Review it.", cites: [{ id: "e2", quote: "not a real quote" }, { id: "e4", quote: "not a real quote" }] }];
  return { kind: "answer", answer: { ...result.answer, text: JSON.stringify(raw) } };
 } } });
 let builder = f.create();
 for (let n = 0; n < 3; n++) { f.setSource(snapshot(6 + n)); await builder.request("host/session", `build-${n}`, "manual", "client"); await builder.run(); }
 const receipt = builder.receipts()[0]!, drop = receipt.receipt.drops![0]!;
 assert.equal(receipt.receipt.drops!.length, 1); assert.deepEqual([drop.from, drop.to, drop.fromPosition, drop.toPosition], ["e2", "e4", 3, 5]);
 const dismissed = builder.dismiss("host/session", "dismiss", drop.id, drop.toPosition);
 assert.deepEqual(dismissed, { outcome: "dismissed", revision: receipt.revision + 1 });
 builder = f.create(); assert.deepEqual(builder.dismiss("host/session", "dismiss", drop.id, drop.toPosition), dismissed);
 assert.deepEqual(builder.receipts({ [receipt.sessionRef]: receipt.revision })[0]!.receipt.drops, []);
 assert.deepEqual(builder.dismiss("host/session", "dismiss", "other", drop.toPosition), { outcome: "refused", code: "id-conflict" });
 f.setSource(snapshot(10)); await builder.request("host/session", "later", "manual", "client"); await builder.run();
 assert.deepEqual(builder.receipts()[0]!.receipt.drops, []);
});

test("Construction: a cited replacement assessment clears the matching loss without a Rebuild", async () => {
 const s = snapshot(), raw = arcAnswer(s);
 raw.points = [{ kind: "request", state: "open", waits: "owner", by: "agent", title: "Check the work", text: "Review it.", cites: [] }];
 const dropped = await constructArc(s, undefined, record(), async () => ({ model: MODEL, text: JSON.stringify(raw) }), undefined, undefined, 1, undefined, 0);
 assert.equal(dropped.drops?.length, 1);
 const next = snapshot(8), replacement = arcAnswer(next); replacement.points = [{ ...raw.points[0]!, cites: replacement.now.cites }];
 const receipt = await constructArc(next, dropped, record(), async () => ({ model: MODEL, text: JSON.stringify(replacement) }), undefined, undefined, 1, undefined, 0);
 assert.deepEqual(receipt.drops, []); assert.equal(receipt.points[0]!.title, "Check the work");
});

test("Builder: a lost answer after verified child exit frees capacity but keeps charge uncertainty", async () => {
 const releases: string[] = [];
 const f = fixture({ admission: { acquire: async () => ({ kind: "permit", permit: { id: "slot" } }), release: async (_p, outcome) => { releases.push(outcome); } }, model: {
  reconcile: async () => { throw new Error("An exited child must not need another probe"); },
  call: async (_i, _m, _p, context) => { context.started({ pid: 4242, startedAt: "synthetic" }); context.exited(); return { kind: "measured-unknown", reason: "Lost result after exit" }; },
 } });
 const builder = f.create(); await builder.request("host/session", "one", "manual", "client"); await builder.run(); await builder.run();
 assert.deepEqual(releases, ["settled"]); assert.equal(builder.status()[0]!.pause, "uncertain-call");
 assert.equal(builder.status()[0]!.record!.usage.cost, null);
});

test("Builder: a known answer does not authorize the next window while its child still runs", async () => {
 let live = true, calls = 0;
 const f = fixture({ settings: () => ({ model: MODEL, retries: 0, windowTokens: 45 }), model: {
  reconcile: async () => live ? "running" : "gone",
  call: async (input, _m, _p, context) => { calls++; if (calls === 1) context.started({ pid: 4242, startedAt: "synthetic" }); return answer(input); },
 } });
 const builder = f.create(); await builder.request("host/session", "one", "manual", "client"); await builder.run();
 assert.equal(calls, 1); assert.equal(builder.status()[0]!.waitCause, "survivor");
 live = false; await builder.run();
 assert.ok(calls > 1); assert.equal(builder.status()[0]!.state, "idle");
 assert.equal(builder.receipts()[0]!.receipt.builds[0]!.calls, calls);
});

test("Builder: a dismiss during construction cannot be overwritten by its later publication", async () => {
 const entered = deferred<void>(), finish = deferred<void>(); let calls = 0;
 const f = fixture({ model: { reconcile: async () => "gone", call: async input => {
  const result = answer(input); assert.equal(result.kind, "answer");
  if (++calls === 2) { entered.resolve(); await finish.promise; }
  const raw = JSON.parse(result.answer.text);
  raw.points = [{ id: "unknown-point-id", kind: "request", state: "open", by: "agent", waits: "owner", title: "Check the work", text: "Review it.", cites: [{ id: "e2", quote: "not a real quote" }] }];
  return { kind: "answer", answer: { ...result.answer, text: JSON.stringify(raw) } };
 } } });
 const builder = f.create(); await builder.request("host/session", "one", "manual", "client"); await builder.run();
 const drop = builder.receipts()[0]!.receipt.drops![0]!; assert.equal(drop.title, "Check the work");
 f.setSource(snapshot(8)); await builder.request("host/session", "two", "manual", "client");
 const run = builder.run(); await entered.promise; builder.dismiss("host/session", "dismiss", drop.id, drop.toPosition); finish.resolve(); await run;
 assert.deepEqual(builder.receipts()[0]!.receipt.drops, []);
});

test("Builder: a dismissal covers only the seen loss range; a committed Rebuild clears its bounds", async () => {
 let cites = ["e2", "e4"], fail = false;
 const f = fixture({ model: { reconcile: async () => "gone", call: async input => {
  if (fail) return { kind: "failed", code: "model", message: "Synthetic failure before dispatch" };
  const result = answer(input); assert.equal(result.kind, "answer"); const raw = JSON.parse(result.answer.text);
  raw.points = [{ kind: "request", state: "open", by: "agent", waits: "owner", title: "Review the changes", text: "Review it.", cites: cites.map(id => ({ id, quote: "not a real quote" })) }];
  return { kind: "answer", answer: { ...result.answer, text: JSON.stringify(raw) } };
 } } });
 let builder = f.create(); await builder.request("host/session", "first", "manual", "client"); await builder.run();
 const drop = builder.receipts()[0]!.receipt.drops![0]!;
 const dismissed = builder.dismiss("host/session", "dismiss-first", drop.id, 5);
 assert.deepEqual(builder.replay({ sessionRef: "host/session", requestId: "dismiss-first", kind: "dismiss", dropId: drop.id, toPosition: 5 }), dismissed);
 assert.deepEqual(builder.replay({ sessionRef: "host/session", requestId: "dismiss-first", kind: "dismiss", dropId: drop.id, toPosition: 6 }), { outcome: "refused", code: "id-conflict" });
 assert.deepEqual(builder.receipts()[0]!.receipt.dismissedDrops, [{ id: drop.id, toPosition: 5 }]);
 builder = f.create(); cites = ["e9", "e11"]; f.setSource(snapshot(12));
 await builder.request("host/session", "later", "manual", "client"); await builder.run();
 let receipt = builder.receipts()[0]!.receipt;
 assert.equal(receipt.drops!.length, 1); assert.deepEqual([receipt.drops![0]!.fromPosition, receipt.drops![0]!.toPosition], [10, 12]);
 assert.deepEqual(builder.dismiss("host/session", "dismiss-first", drop.id, 12), { outcome: "refused", code: "id-conflict" });
 assert.equal(builder.dismiss("host/session", "stale-view", drop.id, 5).outcome, "dismissed");
 assert.equal(builder.receipts()[0]!.receipt.drops!.length, 1);
 assert.deepEqual(builder.dismiss("host/session", "beyond-receipt", drop.id, 13), { outcome: "refused", code: "invalid" });
 builder.dismiss("host/session", "dismiss-later", drop.id, 12);
 fail = true; await builder.request("host/session", "failed-rebuild", "rebuild", "client"); await builder.run();
 assert.deepEqual(builder.receipts()[0]!.receipt.dismissedDrops, [{ id: drop.id, toPosition: 12 }]);
 fail = false; await builder.request("host/session", "rebuild", "rebuild", "client"); await builder.run();
 receipt = builder.receipts()[0]!.receipt; assert.deepEqual(receipt.dismissedDrops, []); assert.equal(receipt.drops!.length, 1);
 cites = ["e2", "e4"]; f.setSource(snapshot(13)); await builder.request("host/session", "older-repeat", "manual", "client"); await builder.run();
 assert.equal(builder.receipts()[0]!.receipt.drops![0]!.toPosition, 12, "a repeated older loss cannot replace a newer loss");
});

test("Construction: an older same-title point cannot clear a later loss", async () => {
 const s = snapshot(), raw = arcAnswer(s);
 raw.points = [{ kind: "request", state: "open", waits: "owner", by: "agent", title: "Review the changes", text: "Review it.", cites: [{ id: "e4", quote: "not a real quote" }, { id: "e5", quote: "not a real quote" }] }];
 const dropped = await constructArc(s, undefined, record(), async () => ({ model: MODEL, text: JSON.stringify(raw) }), undefined, undefined, 1, undefined, 0);
 const next = snapshot(8), old = arcAnswer(next); old.points = [{ ...raw.points[0]!, cites: [{ id: "e1", quote: "Synthetic evidence 1." }] }];
 const retained = await constructArc(next, dropped, record(), async () => ({ model: MODEL, text: JSON.stringify(old) }), undefined, undefined, 1, undefined, 0);
 assert.equal(retained.drops!.length, 1); assert.equal(retained.points.length, 1);
 const later = snapshot(10), replacement = arcAnswer(later); replacement.points = [{ ...raw.points[0]!, cites: [{ id: "e8", quote: "Synthetic evidence 8." }] }];
 const cleared = await constructArc(later, retained, record(), async () => ({ model: MODEL, text: JSON.stringify(replacement) }), undefined, undefined, 1, undefined, 0);
 assert.deepEqual(cleared.drops, []);
});

test("Builder: wait-start time survives polling and restart; a changed cause starts a new wait", async () => {
 let wall = "2026-01-01T00:00:00Z", live = true, available = true, calls = 0;
 const f = fixture({ now: () => wall, settings: () => ({ model: MODEL, retries: 0, windowTokens: 45 }),
  source: { snapshot: async () => snapshot(), check: async () => available ? { kind: "same-prefix" } : { kind: "unavailable", reason: "Synthetic file unavailable" } },
  model: { reconcile: async () => live ? "running" : "gone", call: async (input, _model, _permit, context) => { if (++calls === 1) context.started({ pid: 4242, startedAt: "synthetic" }); return answer(input); } },
 });
 let builder = f.create(); await builder.request("host/session", "first", "manual", "client"); await builder.run();
 assert.equal(builder.status()[0]!.waitCause, "survivor"); assert.equal(builder.status()[0]!.waitingSince, wall);
 wall = "2026-01-01T00:01:00Z"; builder = f.create(); await builder.run(); assert.equal(builder.status()[0]!.waitingSince, "2026-01-01T00:00:00Z");
 wall = "2026-01-01T00:02:00Z"; live = false; available = false; await builder.run();
 assert.equal(builder.status()[0]!.waitCause, "source-unavailable"); assert.equal(builder.status()[0]!.waitingSince, wall);
 wall = "2026-01-01T00:03:00Z"; builder = f.create(); await builder.run(); assert.equal(builder.status()[0]!.waitingSince, "2026-01-01T00:02:00Z");
 available = true; await builder.run(); assert.equal(builder.status()[0]!.state, "idle"); assert.equal(builder.status()[0]!.waitingSince, undefined);
});

test("Builder: a joined owner trigger strengthens a queued stop and survives restart", async () => {
 let wall = "2026-01-01T00:00:00Z";
 const f = fixture({ now: () => wall }); let builder = f.create();
 const first = await builder.request("host/session", "stop", "incremental", "watcher", { trigger: "stop", nextAt: "2026-01-01T00:01:00Z" });
 assert.deepEqual(await builder.request("host/session", "owner", "incremental", "watcher", { trigger: "owner" }), first);
 assert.deepEqual(await builder.request("host/session", "stop", "incremental", "watcher", { trigger: "stop", nextAt: "2026-01-01T00:01:00Z" }), first);
 builder = f.create(); assert.equal(builder.status()[0]!.record!.trigger, "owner");
 wall = "2026-01-01T00:01:00Z"; await builder.run(); assert.equal(builder.receipts()[0]!.receipt.builds[0]!.trigger, "owner");
});
