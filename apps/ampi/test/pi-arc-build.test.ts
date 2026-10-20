import "./bound.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cosDemo } from "../scripts/demo/cos.ts";
import type { DemoContext } from "../scripts/demo/index.ts";
import { useHubConfig, type ModelPurpose, resolveHelperModel } from "../src/hub/helper-models.ts";
import { ask } from "../src/pi/ask.ts";
import { piModelRegistry } from "../src/pi/model-registry.ts";
import type { Chunk } from "../src/pi/views/cos-arc-chunks.ts";
import { normalizeLabel, normalizeProjects } from "../src/pi/views/cos-arc-format.ts";
import { LABEL_SYSTEM, STEP2_SYSTEM } from "../src/pi/views/cos-arc-prompts.ts";
import { ARC_ASK_CONCURRENCY, EMPTY_ANSWER, LABEL_VERSION, arcClock, bounded, buildArc, buildLog, cosArc, json, type ArcFailure, type ArcValue } from "../src/pi/views/cos-arc.ts";
import * as arcModule from "../src/pi/views/cos-arc.ts";
import { rarebitView } from "../src/pi/views/rarebit.ts";
import type { PiViewContext, PiViewSession } from "../src/pi/views/types.ts";

// Build arc through the real ask runner and the offline demo model, with a fake view context that counts calls in
// flight and delays answers so that they complete out of order.

const root = mkdtempSync(join(tmpdir(), "ampi-arc-build-"));
// Every helper model is explicit; tests that need another set write their own hub.json, then return to this one.
const MODELS = { arcLabels: "anthropic/claude-haiku-5-5", arcSynthesis: "anthropic/claude-sonnet-5-5", rarebitRecap: "anthropic/claude-haiku-5-5", rarebitAsk: "anthropic/claude-sonnet-5-5" };
const HUB = join(root, "models-hub.json");
writeFileSync(HUB, JSON.stringify({ hosts: [], models: MODELS }));
useHubConfig(HUB);
cosDemo({ dir: root, agentDir: join(root, "agent") } as DemoContext);
const model = [process.execPath, join(root, "cos-model.cjs")];
const T = Date.parse("2026-10-19T00:00:00.000Z");
// 20 chunks: four label batches of six, then one step-2 call.
const chunks: Chunk[] = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, index: i, hash: `h${i}`, startAt: new Date(T + i * 60_000).toISOString(), endAt: new Date(T + i * 60_000 + 30_000).toISOString(), firstEntryId: `u${i}`, lastEntryId: `a${i}`, firstAsk: `Step ${i}`, lastOwnerEntryId: `u${i}`, ownerTurns: 1, entries: 2, toolCalls: i % 3, where: null, idleBeforeMs: null, compactionEntryId: null }));
const session = { threadId: "pi:sess-a", ref: "devbox/pi:sess-a", sourceVersion: "v1", summary: { cwd: "/work/demo" }, data: { arc: { chunks }, rarebit: { count: 40, fingerprint: "f".repeat(64) }, timeline: { stopped: true, marks: [] } },
	arcEvidence: (ids: string[]) => new Map(ids.map((id) => { const i = id.slice(1); return [id, `[u${i}] USER: Run step ${i}.\n[a${i}] AGENT: Step ${i} landed and tests pass.`]; })),
	entryTimes: (ids: string[]) => new Map(ids.map((id) => [id, T + Number(id.slice(1)) * 60_000])),
	// Two Rarebit pages, newest first, cut at 8 KiB unless full text is asked for. Stop a3 asks after 9000 chars.
	rarebits(this: { sourceVersion: string }, before?: string, fullText?: boolean) {
		const page = (before ? chunks.slice(0, 10) : chunks.slice(10)).flatMap((c) => { const i = c.id.slice(1); return [
			{ id: `u${i}`, kind: "user", t: null, text: `Run step ${i}.` },
			{ id: `a${i}`, kind: "stop", t: null, text: i === "3" ? `Step 3 landed and tests pass.\n\n${"x".repeat(9000)}\n\nShould I keep step 3 behind a flag?` : `Step ${i} landed and tests pass.` }]; });
		return { items: page.map((item) => (fullText ? item : { ...item, text: item.text.slice(0, 8192) })), more: !before, sourceVersion: this.sourceVersion };
	} } as unknown as PiViewSession;

type Run = { inFlight: number; maxInFlight: number; started: number; startedAfterFailure: number; failed: boolean };
type Req = Parameters<PiViewContext["ask"]>[0];
function context(name: string, delay: (call: number) => number, fail?: (call: number, req: Req) => boolean, edit?: (call: number, req: Req, text: string) => string) {
	const run: Run = { inFlight: 0, maxInFlight: 0, started: 0, startedAfterFailure: 0, failed: false };
	const dir = join(root, name); mkdirSync(dir, { recursive: true });
	const ctx = { host: "devbox", stateDir: () => dir, session: () => session, lease: () => () => {}, invalidate() {}, snapshot: <T>(read: () => T) => read(), model: (p: ModelPurpose, o?: string) => resolveHelperModel(p, o),
		async ask(req: Parameters<PiViewContext["ask"]>[0]) {
			const call = run.started++;
			if (run.failed) run.startedAfterFailure++;
			run.inFlight++; run.maxInFlight = Math.max(run.maxInFlight, run.inFlight);
			try {
				await new Promise((r) => setTimeout(r, delay(call)));
				if (fail?.(call, req)) { run.failed = true; throw Object.assign(new Error("model_error: synthetic failure"), { code: "model_error" }); }
				const answer = await ask(req, model);
				return edit ? { ...answer, text: edit(call, req, answer.text) } : answer;
			} finally { run.inFlight--; }
		} } as unknown as PiViewContext;
	return { ctx, run, dir };
}
async function build(ctx: PiViewContext, limit?: number) {
	buildArc(ctx, session, {}, { limit });
	for (let i = 0; i < 400; i++) {
		const v = cosArc.value(ctx, { kind: "view", view: "cos.arc", threadId: session.threadId }) as ArcValue;
		if (v.job?.state !== "running") return v;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("Build arc did not finish");
}
const estimateOf = (ctx: PiViewContext) => (cosArc.value(ctx, { kind: "view", view: "cos.arc", threadId: session.threadId }) as ArcValue).buildEstimate;
const receipt = (dir: string) => {
	const r = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((f) => /^[0-9a-f]{64}\.json$/.test(f))!), "utf8"));
	return { ...r, builtAt: "", context: { ...r.context, builtAt: "" } };
};

const labelled = (req: Req) => req.system !== LABEL_SYSTEM ? [] : [...req.prompt.matchAll(/"chunk":"(c\d+)"/g)].map((m) => m[1]);
const stored = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/^[0-9a-f]{64}/, ""));

test("arc build bounded: results keep item order, at most the limit runs, and the first failure stops new starts", async () => {
	let inFlight = 0, max = 0;
	const out = await bounded([50, 10, 30, 0, 20, 5], 3, async (ms, i) => { inFlight++; max = Math.max(max, inFlight); await new Promise((r) => setTimeout(r, ms)); inFlight--; return i; });
	assert.deepEqual(out, [0, 1, 2, 3, 4, 5]);
	assert.equal(max, 3);
	const started: number[] = [];
	await assert.rejects(bounded([0, 1, 2, 3, 4, 5], 2, async (i) => { started.push(i); await new Promise((r) => setTimeout(r, 10)); if (i === 1) throw new Error("first"); if (i === 2) throw new Error("second"); return i; }), /first/);
	assert.ok(!started.includes(4) && !started.includes(5), `no start after the failure: ${started}`);
	assert.equal(inFlight, 0);
});

test("arc build concurrent: calls run up to the bound, and the receipt equals a sequential Build on the demo model", async () => {
	// Earlier calls answer later, so concurrent label batches complete in reverse order.
	const parallel = context("parallel", (call) => (call < 4 ? 120 - call * 30 : 10));
	const estimate = estimateOf(parallel.ctx);
	const v = await build(parallel.ctx);
	assert.equal(v.job?.state, "done", v.job?.lastError?.message ?? "");
	assert.equal(parallel.run.maxInFlight, ARC_ASK_CONCURRENCY);
	assert.equal(parallel.run.started, estimate.calls, "the call count matches the estimate");
	assert.equal(v.buildEstimate.calls, 1, "after a full Build only step 2 remains");
	assert.equal(v.job?.done, v.job?.total, "progress reaches its total");
	const sequential = context("sequential", () => 10);
	const w = await build(sequential.ctx, 1);
	assert.equal(w.job?.state, "done", w.job?.lastError?.message ?? "");
	assert.equal(sequential.run.maxInFlight, 1);
	assert.equal(w.buildEstimate.calls, v.buildEstimate.calls);
	assert.equal(w.buildEstimate.inputTokens, v.buildEstimate.inputTokens);
	assert.equal(JSON.stringify(receipt(parallel.dir)), JSON.stringify(receipt(sequential.dir)), "same bytes, key order included");
});

test("arc build failure: a failed step-2 call fails the Build, and a failed label call fails it after in-flight calls settle; neither writes a receipt", async () => {
	// Calls 0-3 label; call 4 is step 2 and fails.
	const synth = context("failing", () => 10, (call) => call === 4);
	const v = await build(synth.ctx);
	assert.equal(v.job?.state, "error");
	assert.match(v.job?.lastError?.message ?? "", /synthetic failure/);
	assert.equal(synth.run.started, 5, "no model call starts after the failure");
	assert.deepEqual(stored(synth.dir), [".builds.json"], "no receipt or head is written; the Build log records the failure");
	// Label call 0 and its retry fail while label call 3 is still in flight; step 2 never starts.
	const label = context("failing-label", (call) => (call === 3 ? 120 : 10), (call, req) => labelled(req).includes("c0"));
	const w = await build(label.ctx);
	assert.equal(w.job?.state, "error");
	assert.equal(label.run.inFlight, 0, "the job ends only after in-flight calls settle");
	assert.equal(label.run.started, 4 + 1, "four label batches and one retry; no step-2 call");
	assert.deepEqual(stored(label.dir), [".builds.json"]);
});

test("arc build json: the first object of a concatenated answer parses (failure: two appended objects failed the Build)", () => {
	assert.deepEqual(json('{"chunks":[{"chunk":"c0","note":"a } in a string"}]}\n{"chunks":[]}'), { chunks: [{ chunk: "c0", note: "a } in a string" }] });
	assert.deepEqual(json('```json\n{"a":1}\n```'), { a: 1 });
	assert.throws(() => json("no object here"), /did not return an Arc JSON object/);
});

test("arc build retry: a label answer that misses a chunk repeats once for only that chunk (failure: one omitted label failed the Build)", async () => {
	const prompts: string[][] = [];
	const r = context("retry", () => 10, undefined, (call, req, text) => {
		if (labelled(req).length) prompts.push(labelled(req));
		if (call !== 0) return text;
		const raw = JSON.parse(text); raw.chunks = raw.chunks.filter((l: any) => l.chunk !== "c2"); return JSON.stringify(raw);
	});
	const estimate = estimateOf(r.ctx);
	const v = await build(r.ctx);
	assert.equal(v.job?.state, "done", v.job?.lastError?.message ?? "");
	assert.ok(prompts.some((p) => p.length === 1 && p[0] === "c2"), `a retry asks for c2 alone: ${JSON.stringify(prompts)}`);
	assert.equal(r.run.started, estimate.calls + 1, "calls stay within the estimate plus retries");
	assert.equal(v.coverage.unmappedChunks, 0);
	assert.equal(v.job?.done, v.job?.total);
	const log = buildLog(r.ctx, session.threadId).at(-1)!;
	assert.equal(log.retries, 1); assert.equal(log.unlabelledChunks, undefined); assert.equal(log.calls, r.run.started);
});

test("arc build asks: Needs-you candidates come from every Rarebit page at full length (failure: an ask after 8 KiB or on an older page was lost)", async () => {
	const r = context("asks", () => 10);
	const v = await build(r.ctx);
	assert.equal(v.job?.state, "done", v.job?.lastError?.message ?? "");
	// The owner turn u4 moves on without answering, so the ask is overtaken; it is found either way.
	assert.deepEqual(v.context!.overtaken!.map((l) => [l.quote, l.citations[0]!.entryId, l.resolvedBy[0]?.entryId]), [["Should I keep step 3 behind a flag?", "a3", "u4"]]);
});

// The Session after four Rarebit messages land in the open last chunk and start one more chunk.
const appended = { ...session, sourceVersion: "v2", data: { ...session.data, arc: { chunks: [...chunks.slice(0, 19), { ...chunks[19]!, hash: "h19b", entries: 3 },
	{ ...chunks[19]!, id: "c20", index: 20, hash: "h20", firstEntryId: "u20", lastEntryId: "a20" }] }, rarebit: { count: 44, fingerprint: "e".repeat(64) } } } as unknown as PiViewSession;
async function settle(ctx: PiViewContext) {
	for (let i = 0; i < 400; i++) {
		const v = cosArc.value(ctx, { kind: "view", view: "cos.arc", threadId: session.threadId }) as ArcValue;
		if (v.job?.state !== "running") return v;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("Build arc did not finish");
}

test("arc build snapshot: appends during a Build commit its start snapshot, and the next Build labels only changed chunks (failure: an append aborted the Build)", async () => {
	const r = context("snapshot", () => 10);
	let live = session;
	const labelCalls: string[][] = [], ask = r.ctx.ask;
	Object.assign(r.ctx, { session: () => live, ask: (req: Req) => { if (req.system === LABEL_SYSTEM) { labelCalls.push(labelled(req)); live = appended; } return ask(req); } });
	buildArc(r.ctx, session);
	const v = await settle(r.ctx);
	assert.equal(v.job?.state, "done", v.job?.lastError?.message ?? "");
	assert.equal(receipt(r.dir).sourceVersion, "v1");
	assert.equal(v.context!.asOfRarebitCount, 40, "the receipt covers the start snapshot");
	assert.equal(v.contextStatus.newMessages, 4, "the appended messages make the head stale");
	assert.equal(labelCalls.flat().length, 20);
	labelCalls.length = 0;
	buildArc(r.ctx, appended);
	const again = await settle(r.ctx);
	assert.equal(again.job?.state, "done", again.job?.lastError?.message ?? "");
	assert.deepEqual(labelCalls, [["c19", "c20"]], "only the changed and the new chunk are labelled");
	assert.deepEqual([again.job?.toLabel, again.job?.chunks], [2, 21]);
	assert.equal(again.coverage.unmappedChunks, 0);
	assert.equal(again.contextStatus.newMessages, 0);
	assert.equal(buildLog(r.ctx, session.threadId).at(-1)!.reusedLabels, 19);
});

const receiptFile = (dir: string) => readdirSync(dir).find((f) => /^[0-9a-f]{64}\.json$/.test(f))!;
const arcOf = (ctx: PiViewContext) => cosArc.value(ctx, { kind: "view", view: "cos.arc", threadId: session.threadId }) as ArcValue;
/** A context whose receipt file is `receipt`, with label calls recorded and `current` as its Session. */
function seeded(name: string, receipt: unknown, current: PiViewSession) {
	const r = context(name, () => 10);
	writeFileSync(join(r.dir, receiptFile(first.dir)), JSON.stringify(receipt));
	const labelCalls: string[][] = [], ask = r.ctx.ask;
	Object.assign(r.ctx, { session: () => current, ask: (req: Req) => { if (req.system === LABEL_SYSTEM) labelCalls.push(labelled(req)); return ask(req); } });
	return { ...r, labelCalls };
}
const first = context("reuse-first", () => 10);

test("arc build reuse: labels are reused by chunk hash after chunk ids shift, and only under the same label version (failure: reuse ignored what the label means)", async () => {
	await build(first.ctx);
	const built = JSON.parse(readFileSync(join(first.dir, receiptFile(first.dir)), "utf8"));
	assert.equal(built.labelVersion, LABEL_VERSION);
	// A compaction renumbers chunks: every id moves by one and a new chunk c0 leads.
	const shifted = { ...session, sourceVersion: "v3", data: { ...session.data, arc: { chunks: [{ ...chunks[0]!, id: "c0", hash: "hnew" }, ...chunks.map((c, i) => ({ ...c, id: `c${i + 1}`, index: i + 1 }))] } } } as unknown as PiViewSession;
	const same = seeded("reuse-same", built, shifted);
	const before = arcOf(same.ctx);
	assert.equal(before.coverage.labelledChunks, 20, "labels match by hash");
	assert.equal(before.buildEstimate.calls, 2, "one label batch plus step 2");
	buildArc(same.ctx, shifted);
	const v = await settle(same.ctx);
	assert.equal(v.job?.state, "done", v.job?.lastError?.message ?? "");
	assert.deepEqual(same.labelCalls, [["c0"]]);
	assert.equal(v.coverage.unmappedChunks, 0);

	const other = seeded("reuse-other", { ...built, labelVersion: "0".repeat(16) }, session);
	const stale = arcOf(other.ctx);
	assert.equal(stale.coverage.labelledChunks, 0, "another label version reuses no label");
	assert.equal(stale.chunks[0]!.label?.project, built.labels.c0.project, "its labels still render");
	buildArc(other.ctx, session);
	assert.equal((await settle(other.ctx)).job?.state, "done");
	assert.equal(other.labelCalls.flat().length, 20);
});


test("arc build partial: a label batch that fails twice fails the Build before step 2 and writes only the Build log (failure: a Build with 6 unlabelled chunks read done)", async () => {
	for (const count of [40, 2]) await withCount(count, async () => {
		const p = context(`partial-${count}`, () => 10, (_call, req) => labelled(req).includes("c7"));
		const v = await build(p.ctx);
		assert.equal(v.job?.state, "error", `${count} messages: never done, never done and empty`);
		assert.equal(v.job?.empty, undefined);
		assert.deepEqual({ purpose: v.job?.lastError?.purpose, code: v.job?.lastError?.code }, { purpose: "label", code: "model" });
		assert.match(v.job?.lastError?.message ?? "", /^6 of 20 chunks failed to label/);
		assert.equal(p.run.started, 4 + 1, "four label batches and one retry of the failed one; no step-2 call");
		assert.deepEqual(stored(p.dir), [".builds.json"], "no receipt and no head; the Build log records the failure");
		const log = buildLog(p.ctx, session.threadId).at(-1)!;
		assert.deepEqual([log.state, log.retries, log.unlabelledChunks, log.labelErrorCode, log.freshChunks], ["error", 1, 6, "model", 20]);
		assert.deepEqual(log.failedChunks, [6, 7, 8, 9, 10, 11].map((i) => ({ id: `c${i}`, hash: `h${i}` })));
	});
});

test("arc build partial kept: a partial Build keeps the last complete Arc; the next Build relabels only chunks that Arc lacks (failure: a label gap replaced the Arc)", async () => {
	let omit = false, live = session;
	const r = context("partial-kept", () => 5, undefined, (_call, req, text) => {
		if (!omit || !labelled(req).includes("c20")) return text;
		const raw = JSON.parse(text); raw.chunks = raw.chunks.filter((l: { chunk: string }) => l.chunk !== "c20"); return JSON.stringify(raw);
	});
	const labelCalls: string[][] = [], ask = r.ctx.ask;
	Object.assign(r.ctx, { session: () => live, ask: (req: Req) => { if (req.system === LABEL_SYSTEM) labelCalls.push(labelled(req)); return ask(req); } });
	const good = await build(r.ctx);
	assert.equal(good.job?.state, "done", good.job?.lastError?.message ?? "");
	const kept = receipt(r.dir);
	omit = true; live = appended; labelCalls.length = 0;
	buildArc(r.ctx, appended);
	const v = await settle(r.ctx);
	assert.equal(v.job?.state, "error");
	assert.match(v.job?.lastError?.message ?? "", /^1 of 21 chunks failed to label/);
	assert.deepEqual(labelCalls, [["c19", "c20"], ["c20"]], "the missed chunk is asked once more");
	assert.deepEqual(receipt(r.dir), kept, "the last complete Arc stays stored");
	assert.equal(v.synthesis?.headline, good.synthesis?.headline, "and stays shown");
	assert.ok(v.keptAt, "the view names the kept Arc's time");
	omit = false; labelCalls.length = 0;
	buildArc(r.ctx, appended);
	assert.equal((await settle(r.ctx)).job?.state, "done");
	assert.deepEqual(labelCalls, [["c19", "c20"]], "labels come only from the last complete receipt");
	assert.equal(buildLog(r.ctx, session.threadId).at(-1)!.reusedLabels, 19);
});

test("arc step 2: one arcSynthesis call reads labels, Rarebit evidence and ask candidates, and writes tier 1 and tier 2 (failure: a separate context call ran on the label model)", async () => {
	const r = context("step2", () => 5), reqs: Req[] = [], ask = r.ctx.ask;
	Object.assign(r.ctx, { ask: (req: Req) => { reqs.push(req); return ask(req); } });
	const v = await build(r.ctx);
	assert.equal(v.job?.state, "done", v.job?.lastError?.message ?? "");
	const step2 = reqs.filter((q) => q.system !== LABEL_SYSTEM);
	assert.equal(step2.length, 1, "one step-2 call");
	assert.equal(step2[0]!.purpose, "arcSynthesis");
	assert.ok(!("shape" in JSON.parse(step2[0]!.prompt)), "the user prompt carries data only; the answer shape is in the system prompt");
	assert.match(step2[0]!.prompt, /\[u3\] USER: Run step 3\./, "Rarebit evidence");
	assert.match(step2[0]!.prompt, /keep step 3 behind a flag/, "ask candidates");
	assert.ok(v.synthesis?.headline, "tier 1");
	assert.ok(v.context?.threads.length, "tier 2");
	assert.equal(v.buildEstimate.calls, 1, "after a full Build only step 2 remains");
	const log = buildLog(r.ctx, session.threadId).at(-1)!;
	assert.equal(log.calls, 5);
	assert.deepEqual(Object.keys(log.usageByPurpose ?? {}), ["labels", "synthesis"]);
	assert.deepEqual(Object.keys(log.models ?? {}), ["labels", "synthesis"]);
	const built = JSON.parse(readFileSync(join(r.dir, receiptFile(r.dir)), "utf8"));
	assert.equal(built.version, 5);
	assert.equal(typeof built.step2Version, "string");
	assert.equal(built.model, MODELS.arcSynthesis, "the receipt model is the synthesis model");
});

test("arc build v3 receipt: a stored v3 receipt parses and renders, and reuses no label (failure: labels of another prompt counted as current)", async () => {
	const v3 = JSON.parse(readFileSync(new URL("./fixtures/arc-receipt-v3.json", import.meta.url), "utf8"));
	assert.equal(v3.version, 3);
	const r = seeded("v3", v3, session);
	const before = arcOf(r.ctx);
	assert.equal(before.synthesis?.headline, v3.headline);
	assert.deepEqual(before.cards, [], "labels of other chunk rules make no Projects card");
	assert.ok(before.chunks.some((c) => c.relabel) && before.chunks.every((c) => !c.label), "they show as relabel pending");
	assert.equal(before.relabelChunks, before.chunks.length);
	assert.equal(before.transitions.length, 1);
	assert.equal(before.coverage.labelledChunks, 0);
	assert.equal(before.buildEstimate.calls, 5, "every chunk is labelled again");
	assert.equal(before.coverage.synthesisCurrent, false, "a v3 receipt has no tree");
	buildArc(r.ctx, session);
	const v = await settle(r.ctx);
	assert.equal(v.job?.state, "done", v.job?.lastError?.message ?? "");
	assert.equal(r.labelCalls.flat().length, 20);
	assert.equal(buildLog(r.ctx, session.threadId).at(-1)!.reusedLabels, undefined);
});

test("arc build source: a Rarebit page from another Session version fails the Build with code source (failure: a mixed read built a receipt)", async () => {
	const r = context("source", () => 10);
	const mixed = { ...session, rarebits(before?: string, fullText?: boolean) { return { ...session.rarebits(before, fullText), ...(before ? { sourceVersion: "v2" } : {}) }; } } as unknown as PiViewSession;
	Object.assign(r.ctx, { session: () => mixed });
	buildArc(r.ctx, mixed);
	const v = await settle(r.ctx);
	assert.equal(v.job?.state, "error");
	assert.equal(v.job?.lastError?.code, "source");
	assert.equal(r.run.started, 0, "no model call on a mixed read");
	assert.match(v.job?.lastError?.message ?? "", /A Rarebit page has version v2; the snapshot has v1\./, "the message names both versions");
	assert.doesNotMatch(v.job?.lastError?.message ?? "", /Build arc could not load the whole Session/, "the prefix sentence is not repeated");
	assert.equal(readdirSync(r.dir).filter((f) => /^[0-9a-f]{64}\.json$/.test(f)).length, 0, "no receipt");
});

test("arc build currency: a tool-only append keeps the Arc current, a message append makes both lines stale, and a chunk to label is shown apart (failure: two currency rules)", async () => {
	const r = context("currency", () => 10);
	await build(r.ctx);
	// Tool calls change the source version and the last chunk's hash, but no Rarebit message.
	const tools = { ...session, sourceVersion: "v7", data: { ...session.data, arc: { chunks: [...chunks.slice(0, 19), { ...chunks[19]!, hash: "h19t", toolCalls: 9 }] } } } as unknown as PiViewSession;
	Object.assign(r.ctx, { session: () => tools });
	const v = arcOf(r.ctx);
	assert.deepEqual([v.coverage.synthesisCurrent, v.contextStatus.newMessages, v.contextStatus.branchChanged], [true, 0, false]);
	assert.equal(v.coverage.unmappedChunks, 1, "label freshness is separate");
	Object.assign(r.ctx, { session: () => appended });
	const w = arcOf(r.ctx);
	assert.deepEqual([w.coverage.synthesisCurrent, w.contextStatus.newMessages], [false, 4]);
	assert.equal(typeof w.contextStatus.coveredAt, "number", "the copy can say what time the tree covers");
});

test("arc build errors: only a model failure asks to check Pi's model configuration (failure: every error blamed the model)", async () => {
	const m = context("err-model", () => 1, () => true);
	const model = await build(m.ctx);
	assert.equal(model.job?.lastError?.code, "model");
	const a = context("err-answer", () => 1, undefined, () => "no json here");
	const answer = await build(a.ctx);
	assert.equal(answer.job?.lastError?.code, "answer");
	assert.equal(buildLog(a.ctx, session.threadId).at(-1)!.errorCode, "answer");
});

test("arc build model: labels use models.arcLabels, step 2 uses models.arcSynthesis, unset keys fail the Build before any call, and the Build log names the model per purpose (failure: synthesis ran on the label model, or a built-in default answered)", async () => {
	const builtWith = async (name: string) => {
		// The Build asks by purpose and holds no model id; the ask runner resolves it and the answer names it.
		const r = context(name, () => 1), asked: string[] = [], inner = r.ctx.ask;
		Object.assign(r.ctx, { ask: (req: Req) => { asked.push(`${req.purpose}:${req.model ?? ""}`); return inner(req); } });
		const v = await build(r.ctx);
		const log = buildLog(r.ctx, session.threadId).at(-1)!;
		if (v.job?.state !== "done") return { error: v.job?.lastError, calls: log.calls, asked };
		return { asked: [...new Set(asked)].sort(), synthesis: v.synthesis?.model, models: log.models, calls: Object.values(log.usageByPurpose!).map((u) => u.calls) };
	};
	const haiku = "anthropic/claude-haiku-5-5", sonnet = "anthropic/claude-sonnet-5-5", opus = "anthropic/claude-opus-5-5";
	assert.deepEqual(await builtWith("model-explicit"), { asked: [`arcLabels:${haiku}`, `arcSynthesis:${sonnet}`], synthesis: sonnet, models: { labels: haiku, synthesis: sonnet }, calls: [4, 1] });
	const file = join(root, "hub.json");
	writeFileSync(file, JSON.stringify({ hosts: [], models: { arcLabels: opus, arcSynthesis: opus } }));
	useHubConfig(file);
	try {
		assert.deepEqual(await builtWith("model-hub"), { asked: [`arcLabels:${opus}`, `arcSynthesis:${opus}`], synthesis: opus, models: { labels: opus, synthesis: opus }, calls: [4, 1] });
		writeFileSync(file, JSON.stringify({ hosts: [], models: { arcLabels: opus, arcSynthesis: sonnet } }));
		assert.deepEqual((await builtWith("model-split")).models, { labels: opus, synthesis: sonnet });
		// A stale models.arc sets nothing; both keys read as unset, once, with the note.
		writeFileSync(file, JSON.stringify({ hosts: [], models: { arc: opus } }));
		const warn = console.warn;
		console.warn = () => {};
		const unset = await builtWith("model-unset").finally(() => { console.warn = warn; }) as { error: ArcFailure; calls: number; asked: string[] };
		assert.deepEqual([unset.calls, unset.asked, unset.error.code, unset.error.preflight, unset.error.model], [0, [], "model", true, null]);
		assert.equal(unset.error.message, "No model set for Arc labels and synthesis.");
		assert.equal(unset.error.hint, `Set models.arcLabels and models.arcSynthesis in ${file}. models.arc is no longer read; set models.arcLabels and models.arcSynthesis. Use a provider/model-id from pi --list-models on the hub.`);
	}
	finally { useHubConfig(HUB); }
});

test("arc build ask model: an answer from another model or a failed sign-in rejects with the requested model's name (failure: Pi's custom-model fallback answered silently)", async () => {
	// A fake Pi that answers as FAKE_ANSWER (default: the requested --model), or fails with FAKE_ERROR.
	const bin = join(root, "fake-pi.cjs");
	writeFileSync(bin, `#!${process.execPath}
const argv = process.argv, arg = (flag) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined;
if (argv.includes("--list-models")) { console.log(process.env.FAKE_LIST ?? "provider model context\\nanthropic claude-haiku-5-5 1M\\nanthropic claude-sonnet-5-5 1M\\nanthropic claude-opus-5-5 1M"); process.exit(0); }
const requested = arg("--provider") ? arg("--provider") + "/" + arg("--model") : arg("--model") ?? "";
const [provider, ...rest] = (process.env.FAKE_ANSWER || requested).split("/"), model = rest.join("/");
process.stdin.resume(); process.stdin.on("end", () => console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", provider, model,
	stopReason: process.env.FAKE_ERROR ? "error" : "stop", errorMessage: process.env.FAKE_ERROR, content: [{ type: "text", text: "ok" }] } })));
`);
	chmodSync(bin, 0o755);
	const saved = { PI_BIN: process.env.PI_BIN, FAKE_ANSWER: process.env.FAKE_ANSWER, FAKE_ERROR: process.env.FAKE_ERROR, FAKE_LIST: process.env.FAKE_LIST };
	const haiku = "anthropic/claude-haiku-5-5";
	process.env.PI_BIN = bin;
	try {
		assert.equal((await ask({ system: "s", prompt: "p", purpose: "arcLabels" })).model, haiku, "the purpose resolves through Pi's list to --provider and --model, and the answer names it");
		const echo = [process.execPath, "-e", "process.stdout.write(process.env.AMPI_ASK_MODEL ?? 'none')"];
		assert.deepEqual(await ask({ system: "s", prompt: "p", purpose: "arcLabels" }, echo), { text: haiku, model: haiku }, "a command gets and reports the model name as written");
		await assert.rejects(ask({ system: "s", prompt: "p", purpose: "arcSynthesis", model: "anthropic/claude-nope-9" }), (e: Error & { code?: string }) => e.code === "model_not_found" && e.message === "No model named anthropic/claude-nope-9 (per-Build model, Arc synthesis). Change or clear the per-Build model. Available: anthropic/claude-haiku-5-5, anthropic/claude-opus-5-5, anthropic/claude-sonnet-5-5.");
		const bad = join(root, "bad-hub.json");
		writeFileSync(bad, JSON.stringify({ models: { arcLabels: "" } }));
		useHubConfig(bad);
		try { await assert.rejects(ask({ system: "s", prompt: "p", purpose: "arcLabels" }, echo), (e: Error & { code?: string }) => e.code === "no_model" && e.message.includes(bad) && e.message.includes("models.arcLabels")); }
		finally { useHubConfig(HUB); }
		process.env.FAKE_ANSWER = haiku;
		assert.equal((await ask({ system: "s", prompt: "p", model: "claude-haiku-5-5" })).model, haiku, "a call without a purpose passes its model to Pi as written");
		process.env.FAKE_ANSWER = "anthropic/claude-opus-5-5";
		await assert.rejects(ask({ system: "s", prompt: "p", model: haiku }), (e: Error & { code?: string }) => e.code === "model_error" && /anthropic\/claude-haiku-5-5 was requested, but anthropic\/claude-opus-5-5 answered/.test(e.message));
		// An unreadable model list fails the Build before any call and is not cached: the next call reads Pi again.
		// A second path for the same fake Pi starts with no cached list.
		process.env.FAKE_LIST = "Usage: pi [options]"; process.env.PI_BIN = `${bin}-fresh`; symlinkSync(bin, process.env.PI_BIN);
		const r = context("unreadable", () => 0);
		Object.assign(r.ctx, { model: (p: ModelPurpose, o?: string) => resolveHelperModel(p, o, piModelRegistry) });
		const v = await build(r.ctx);
		assert.deepEqual([v.job?.state, v.job?.lastError?.code, r.run.started, buildLog(r.ctx, session.threadId).at(-1)!.calls], ["error", "model", 0, 0]);
		assert.match(v.job!.lastError!.message, /^Pi's model list format changed/);
		assert.equal(v.job!.lastError!.message.split("Pi's model list").length, 2, "both Arc purposes failed alike; the message says it once");
		delete process.env.FAKE_ANSWER;
		const sonnet = "anthropic/claude-sonnet-5-5";
		assert.equal((await ask({ system: "s", prompt: "p", purpose: "arcSynthesis", model: sonnet, resolved: true })).model, sonnet, "a resolved model skips the unreadable list");
		delete process.env.FAKE_LIST;
		assert.equal((await ask({ system: "s", prompt: "p", purpose: "arcSynthesis" })).model, "anthropic/claude-sonnet-5-5", "the next call reads the list again");
		delete process.env.FAKE_ANSWER; process.env.FAKE_ERROR = "No API key found for anthropic";
		await assert.rejects(ask({ system: "s", prompt: "p", model: haiku }), (e: Error & { code?: string }) => e.code === "model_error" && e.message === `${haiku}: No API key found for anthropic`);
	} finally {
		for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
	}
});


// Real Pi calls go to a local Anthropic Messages endpoint (models.json sets only baseUrl, so built-in models stay). It
// records the model of every outgoing request and answers with the offline demo model. A two-chunk Arc Build (labels,
// step 2), one Rarebit recap and one side ask cover every purpose in four Pi calls. `providers` adds
// models.json providers on the same endpoint; settings.json names magpie as Pi's defaultProvider, which the hub ignores.
// `hubModels` is the whole hub.json models block. With `fails`, the
// Build must fail and the Rarebit calls are skipped. `providerRun` keeps the Build's job and log record.
let providerRun: { job: ArcValue["job"]; build: ReturnType<typeof buildLog>[number] | undefined } | undefined;
async function providerModels(name: string, hubModels: Record<string, string>, { providers = {}, fails = false }: { providers?: Record<string, object>; fails?: boolean } = {}) {
	const requests: { purpose: string; model: string }[] = [];
	const purposeOf = (system: string) => system.startsWith("You label") ? "labels" : system.includes("chief of staff") ? "synthesis" : system.includes("re-entry sentence") ? "rarebitRecap" : "rarebitAsk";
	const text = (v: unknown): string => typeof v === "string" ? v : Array.isArray(v) ? v.map((b: { text?: string }) => b.text ?? "").join("") : "";
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (d) => (body += d)).on("end", () => {
			const b = JSON.parse(body) as { model: string; system?: unknown; messages: { role: string; content: unknown }[] };
			requests.push({ purpose: purposeOf(text(b.system)), model: b.model });
			const answer = spawnSync(model[0]!, model.slice(1), { input: text(b.messages.findLast((m) => m.role === "user")?.content), encoding: "utf8" }).stdout.trim();
			const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
			res.writeHead(200, { "content-type": "text/event-stream" });
			ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: b.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
			ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
			ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: answer } });
			ev("content_block_stop", { index: 0 });
			ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
			ev("message_stop", {});
			res.end();
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const agentDir = join(root, `${name}-agent`); mkdirSync(agentDir, { recursive: true });
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { anthropic: { baseUrl, apiKey: "test-key" }, ...Object.fromEntries(Object.entries(providers).map(([k, v]) => [k, { baseUrl, api: "anthropic-messages", ...v }])) } }));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "magpie" }));
	const saved = { PI_BIN: process.env.PI_BIN, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE, PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK };
	Object.assign(process.env, { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" });
	delete process.env.PI_BIN;
	const small = { ...session, data: { ...session.data, arc: { chunks: chunks.slice(0, 2) } } } as PiViewSession;
	const rarebit = { threadId: "pi:sess-r", revision: 1, rarebitSnapshot: () => ({ context: "[u1] USER: Ship the cache cap?", count: 1, included: 1, omittedChars: 0, evidenceHash: "e".repeat(64), entry: "u1" }) } as unknown as PiViewSession;
	try {
		const file = join(root, `${name}-hub.json`);
		writeFileSync(file, JSON.stringify({ hosts: [], models: hubModels }));
		useHubConfig(file);
		const r = context(name, () => 0);
		Object.assign(r.ctx, { ask: (req: Req) => ask(req), model: (p: ModelPurpose, o?: string) => resolveHelperModel(p, o, piModelRegistry), session: (id: string) => (id === rarebit.threadId ? rarebit : small) });
		buildArc(r.ctx, small);
		let v: ArcValue | undefined;
		for (let i = 0; i < 2400 && (!v || v.job?.state === "running"); i++) {
			await new Promise((res) => setTimeout(res, 25));
			v = cosArc.value(r.ctx, { kind: "view", view: "cos.arc", threadId: small.threadId }) as ArcValue;
		}
		providerRun = { job: v?.job ?? null, build: buildLog(r.ctx, small.threadId).at(-1) };
		assert.equal(v?.job?.state, fails ? "error" : "done", JSON.stringify(v?.job?.lastError));
		if (fails) return { requests: requests.length };
		assert.ok((await rarebitView.ops!.recap!(r.ctx, { threadId: rarebit.threadId }) as { text: string }).text);
		const side = await rarebitView.ops!.ask!(r.ctx, { threadId: rarebit.threadId, question: "Is the cap set?" }) as { side: { turns: { error?: string }[] } };
		assert.equal(side.side.turns[0]!.error, undefined);
		return Object.fromEntries(["labels", "synthesis", "rarebitRecap", "rarebitAsk"].map((p) => [p, [...new Set(requests.filter((q) => q.purpose === p).map((q) => q.model))]]));
	} finally {
		useHubConfig(HUB);
		server.close();
		for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
	}
}

test("arc build provider model: each purpose's outgoing provider request carries its hub.json model (failure: Arc calls went out on Pi's default model)", async () => {
	assert.deepEqual(await providerModels("provider-explicit", MODELS), { labels: ["claude-haiku-5-5"], synthesis: ["claude-sonnet-5-5"], rarebitRecap: ["claude-haiku-5-5"], rarebitAsk: ["claude-sonnet-5-5"] });
	assert.deepEqual(providerRun!.build!.models, { labels: "anthropic/claude-haiku-5-5", synthesis: "anthropic/claude-sonnet-5-5" });
});

test("arc build provider model override: hub.json models.<purpose> changes that purpose's outgoing provider request (failure: a call site lost its purpose)", async () => {
	assert.deepEqual(await providerModels("provider-hub", { arcLabels: "anthropic/claude-sonnet-5-5", arcSynthesis: "anthropic/claude-sonnet-5-5", rarebitRecap: "anthropic/claude-opus-5-5", rarebitAsk: "anthropic/claude-haiku-5-5" }),
		{ labels: ["claude-sonnet-5-5"], synthesis: ["claude-sonnet-5-5"], rarebitRecap: ["claude-opus-5-5"], rarebitAsk: ["claude-haiku-5-5"] });
});

// A local gateway provider, as on the owner's hub: its ids carry a route prefix.
const MAGPIE = { magpie: { apiKey: "test-key", models: [{ id: "claude/claude-haiku-5-5" }, { id: "claude/claude-sonnet-5-5" }] } };

test("arc build provider alias: a gateway provider/id reaches the provider as configured and the Build log names provider/id per purpose (failure: Pi's fuzzy --model or a custom-model fallback picked the route)", async () => {
	assert.deepEqual(await providerModels("provider-alias", { ...MODELS, arcLabels: "magpie/claude/claude-haiku-5-5", rarebitRecap: "magpie/claude/claude-haiku-5-5" }, { providers: MAGPIE }),
		{ labels: ["claude/claude-haiku-5-5"], synthesis: ["claude-sonnet-5-5"], rarebitRecap: ["claude/claude-haiku-5-5"], rarebitAsk: ["claude-sonnet-5-5"] });
	assert.deepEqual(providerRun!.build!.models, { labels: "magpie/claude/claude-haiku-5-5", synthesis: "anthropic/claude-sonnet-5-5" });
});

test("arc build missing model: an unknown, bare, signed-out or unset model fails the Build with model, purpose, hub.json key and the listed rows before any provider call (failure: the Build spent labels, then fell back, guessed a provider, or failed late)", async () => {
	// Each case: hub.json models, the key and name that fail, the failed Build purpose, the purposes the message names, and the Try rows.
	const nope = "anthropic/claude-nope-9";
	for (const [name, hub, key, model, purpose, words, tried] of [["missing", { ...MODELS, arcSynthesis: nope }, "arcSynthesis", nope, "synthesis", "Arc synthesis", ""],
		["bare", { ...MODELS, arcSynthesis: "claude-sonnet-5-5" }, "arcSynthesis", "claude-sonnet-5-5", "synthesis", "Arc synthesis", " Try: anthropic/claude-sonnet-5-5."],
		["signed-out", { ...MODELS, arcLabels: "locked/claude-haiku-5-5" }, "arcLabels", "locked/claude-haiku-5-5", "label", "Arc labels", " Try: anthropic/claude-haiku-5-5."]] as const) {
		// `locked` has models but no credential, so Pi does not list it.
		assert.deepEqual(await providerModels(`provider-${name}`, hub, { providers: { locked: { models: [{ id: "claude-haiku-5-5" }] } }, fails: true }), { requests: 0 }, name);
		const err = providerRun!.job!.lastError!;
		assert.deepEqual([err.code, err.purpose, err.model, err.preflight], ["model", purpose, model, true], name);
		assert.equal(err.message, `No model named ${model} (hub.json, ${words}).`, name);
		assert.ok(err.hint!.startsWith(`Edit models.${key} in ${join(root, `provider-${name}-hub.json`)}.${tried} Available: anthropic/claude-`), `${name}: ${err.hint}`);
		assert.ok(err.available!.includes("anthropic/claude-sonnet-5-5") && !err.available!.some((m) => m.startsWith("locked/")), name);
		assert.deepEqual([providerRun!.build!.state, providerRun!.build!.errorCode, providerRun!.build!.calls, providerRun!.build!.models], ["error", "model", 0, undefined], name);
		assert.equal(providerRun!.build!.missingModel, model, name);
	}
	// Two bad keys: one Build failure names both, labels first, with one Available list.
	await providerModels("provider-both", { ...MODELS, arcLabels: "anthropic/claude-nope-8", arcSynthesis: nope }, { fails: true });
	const err = providerRun!.job!.lastError!;
	assert.deepEqual([err.purpose, err.model], ["label", "anthropic/claude-nope-8"]);
	assert.equal(err.message, "No model named anthropic/claude-nope-8 (hub.json, Arc labels). No model named anthropic/claude-nope-9 (hub.json, Arc synthesis).");
	assert.match(err.hint!, /^Edit models\.arcLabels in [^ ]*\. Edit models\.arcSynthesis in [^ ]*\. Available: anthropic\/claude-.*, \+\d+ more\.$/);
	// An unset key names the key and file, and the Build makes no provider call.
	await providerModels("provider-unset", { arcSynthesis: MODELS.arcSynthesis }, { fails: true });
	assert.equal(providerRun!.job!.lastError!.message, "No model set for Arc labels.");
	assert.equal(providerRun!.job!.lastError!.hint, `Set models.arcLabels in ${join(root, "provider-unset-hub.json")}. Use a provider/model-id from pi --list-models on the hub.`);
	assert.equal(providerRun!.build!.calls, 0);
});

test("arc build label gaps: a model answer that omits or nulls chunks fails the Build with code answer, not internal (failure: an answered call was logged as internal)", async () => {
	for (const [name, drop] of [["omit", (raw: any) => { raw.chunks = raw.chunks.filter((l: any) => l.chunk !== "c2"); }], ["null", (raw: any) => { raw.chunks = raw.chunks.map((l: any) => (l.chunk === "c2" ? null : l)); }]] as const) {
		const r = context(`gap-${name}`, () => 1, undefined, (_call, req, text) => {
			if (!labelled(req).includes("c2")) return text;
			const raw = JSON.parse(text); drop(raw); return JSON.stringify(raw);
		});
		const v = await build(r.ctx);
		assert.deepEqual([v.job?.state, v.job?.lastError?.code, v.job?.lastError?.purpose], ["error", "answer", "label"], name);
		const log = buildLog(r.ctx, session.threadId).at(-1)!;
		assert.equal(log.unlabelledChunks, 1, name);
		assert.equal(log.labelErrorCode, "answer", name);
	}
});

// Synthetic copies of recorded Haiku synthesis replies that echo the prompt: every key, bracket and chunk id is kept and
// the text is invented. 81634 and 90081 drop a brace, 36032 nests the result under "shape".
const recorded = (id: string) => readFileSync(new URL(`./fixtures/arc-replies/haiku-synthesis-${id}.txt`, import.meta.url), "utf8");
const HAIKU = "anthropic/claude-haiku-4-5";
/** A context whose reply for the nth call of a purpose is `pick`'s text, or the demo model's when `pick` returns null. */
function replying(name: string, pick: (system: string, nth: number) => string | null) {
	const r = context(name, () => 0), inner = r.ctx.ask.bind(r.ctx), calls = new Map<string, number>();
	Object.assign(r.ctx, { ask: async (req: Req) => {
		const base = [LABEL_SYSTEM, STEP2_SYSTEM].find((system) => req.system.startsWith(system))!;
		const nth = calls.get(base) ?? 0; calls.set(base, nth + 1);
		const answer = await inner(req);
		return { ...answer, model: HAIKU, text: pick(base, nth) ?? answer.text };
	} });
	return { ...r, calls };
}

test("arc reply recorded echoes: each recorded Haiku echo fails its call visibly after one retry (failure: 36032 built 'done' with an empty headline)", async () => {
	for (const [purpose, system, id] of [["synthesis", STEP2_SYSTEM, "81634"], ["synthesis", STEP2_SYSTEM, "90081"], ["synthesis", STEP2_SYSTEM, "36032"]] as const) {
		const r = replying(`echo-${purpose}-${id}`, (s) => (s === system ? recorded(id) : null));
		const v = await build(r.ctx);
		assert.equal(v.job?.state, "error", `${purpose} ${id}`);
		assert.equal(r.calls.get(system), 2, `${purpose} ${id}: one retry`);
		assert.equal(v.job?.lastError?.purpose, purpose);
		assert.equal(v.job?.lastError?.model, HAIKU);
		assert.match(v.job?.lastError?.message ?? "", new RegExp(`^${purpose} reply invalid: `));
		assert.ok(Date.parse(v.job?.lastError?.at ?? ""), "the failure has a time");
		assert.equal(v.synthesis, null, "no receipt");
		assert.ok(!readdirSync(r.dir).some((f) => /^[0-9a-f]{64}\.json$/.test(f)));
	}
});

test("arc reply exhausted retry: the last valid stored Arc stays unchanged and the failure names purpose and model (failure: an echo replaced the headline with an empty one)", async () => {
	let echo = false;
	const r = replying("echo-kept", (s) => (echo && s === STEP2_SYSTEM ? recorded("36032") : null));
	const first = await build(r.ctx);
	assert.equal(first.job?.state, "done");
	assert.ok(first.synthesis?.headline);
	const stored = receipt(r.dir);
	echo = true;
	const v = await build(r.ctx);
	assert.deepEqual(receipt(r.dir), stored, "the stored receipt is unchanged");
	assert.equal(v.synthesis?.headline, first.synthesis?.headline, "the Arc value still shows the last valid headline");
	assert.equal(v.job?.state, "error");
	assert.deepEqual({ purpose: v.job?.lastError?.purpose, model: v.job?.lastError?.model, code: v.job?.lastError?.code }, { purpose: "synthesis", model: HAIKU, code: "answer" });
	assert.match(v.job?.lastError?.message ?? "", /headline/);
	assert.deepEqual(buildLog(r.ctx, session.threadId).map((b) => b.state), ["done", "error"]);
});

test("arc reply invalid then valid: the retry's valid reply commits exactly one result (failure: one dropped brace failed the Build)", async () => {
	const r = replying("echo-then-valid", (s, nth) => (s === STEP2_SYSTEM && nth === 0 ? recorded("81634") : null));
	const v = await build(r.ctx);
	assert.equal(v.job?.state, "done");
	assert.equal(r.calls.get(STEP2_SYSTEM), 2);
	assert.ok(v.synthesis?.headline, "the retry's headline");
	const log = buildLog(r.ctx, session.threadId);
	assert.equal(log.length, 1);
	assert.equal(log[0]!.retries, 1);
	assert.equal(readdirSync(r.dir).filter((f) => /^[0-9a-f]{64}\.json$/.test(f)).length, 1, "one receipt");
	assert.equal(receipt(r.dir).headline, v.synthesis?.headline);
});

// Hub ingest: a Session copy that lags its file (bytes < sourceBytes) is a partial Session. Read the bound through the
// module namespace so these tests also load, and fail, on a tree without it.
const ingest = (arcModule as { INGEST?: { waitMs: number; pollMs: number } }).INGEST ?? { waitMs: 0, pollMs: 0 };
const partial = { ...session, bytes: 100, sourceBytes: 500, data: { ...session.data, bytes: 100, arc: { chunks: chunks.slice(0, 2) } } } as unknown as PiViewSession;
const whole = { ...session, bytes: 500, sourceBytes: 500, data: { ...session.data, bytes: 500 } } as unknown as PiViewSession;
async function buildFrom(ctx: PiViewContext, first: PiViewSession) {
	buildArc(ctx, first);
	for (let i = 0; i < 400; i++) {
		const v = cosArc.value(ctx, { kind: "view", view: "cos.arc", threadId: session.threadId }) as ArcValue;
		if (v.job?.state !== "running") return v;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("Build arc did not finish");
}

test("arc build during ingest: the Build waits for the hub to read the whole Session, then labels every chunk (failure: a Build covered 2 of 12 chunks and read done)", async () => {
	const r = context("ingest-wait", () => 0);
	let current = partial;
	setTimeout(() => { current = whole; }, 600);
	const ctx = { ...r.ctx, session: () => current } as PiViewContext;
	buildArc(ctx, partial);
	await new Promise((res) => setTimeout(res, 200));
	const early = cosArc.value(ctx, { kind: "view", view: "cos.arc", threadId: session.threadId }) as ArcValue;
	const waited = early.job?.state === "running" && /^Waiting for this Session to finish loading: loaded 20% \(100 of 500 B\)\. Build starts when loading finishes; it stops after 2 min\.$/.test(early.job?.waitingFor ?? "");
	const v = await buildFrom(ctx, current);
	assert.equal(v.job?.state, "done");
	assert.equal(Object.keys(receipt(r.dir).labels).length, 20, "every chunk of the whole Session is labelled");
	assert.ok(waited, "the job says it waits for the hub");
});

test("arc build during endless ingest: past the bound the Build fails with a source error, makes no model call, and keeps the last valid Arc", async () => {
	const saved = { ...ingest };
	Object.assign(ingest, { waitMs: 1000, pollMs: 25 });
	try {
		const r = context("ingest-endless", () => 0);
		let current = whole;
		const ctx = { ...r.ctx, session: () => current } as PiViewContext;
		const first = await buildFrom(ctx, whole);
		assert.equal(first.job?.state, "done");
		const stored = receipt(r.dir), calls = r.run.started;
		current = partial;
		const v = await buildFrom(ctx, partial);
		assert.equal(v.job?.state, "error");
		assert.equal(v.job?.lastError?.code, "source");
		assert.equal(v.job?.lastError?.message, "Loaded 20% (100 of 500 B) of the Session in 1 s");
		assert.equal(r.run.started, calls, "no model call");
		assert.deepEqual(receipt(r.dir), stored, "the stored receipt is unchanged");
		assert.equal(readdirSync(r.dir).filter((f) => /^[0-9a-f]{64}\.json$/.test(f)).length, 1, "one receipt");
		assert.equal(v.synthesis?.headline, first.synthesis?.headline, "the Arc value still shows the last valid headline");
	} finally { Object.assign(ingest, saved); }
});

test("arc build models: the receipt records the label and step-2 models apart (failure: the synthesis model showed the context model)", async () => {
	const r = context("models-apart", () => 0), inner = r.ctx.ask.bind(r.ctx);
	const names = new Map([[LABEL_SYSTEM, "m-labels"], [STEP2_SYSTEM, "m-synthesis"]]);
	Object.assign(r.ctx, { ask: async (req: Req) => ({ ...await inner(req), model: [...names].find(([system]) => req.system.startsWith(system))![1] }) });
	const v = await build(r.ctx);
	assert.equal(v.job?.state, "done");
	assert.deepEqual(receipt(r.dir).models, { labels: "m-labels", synthesis: "m-synthesis" });
	assert.equal(v.synthesis?.model, "m-synthesis");
	assert.equal(receipt(r.dir).context.model, "m-synthesis", "the tree comes from the same call");
});

// A step-2 answer with a valid tier 1 and an empty tier-2 tree: no threads and no unassigned leaves. The second form is
// non-empty JSON whose only leaf cites nothing the Build saw, so it normalizes to the same empty tree.
const TIER1 = { headline: "Synthetic headline", projects: [], transitions: [] };
const EMPTY_TREE = JSON.stringify({ ...TIER1, asks: [], threads: [], unassigned: {} });
const UNCITED_TREE = JSON.stringify({ ...TIER1, asks: [], threads: [], unassigned: { progress: [{ text: "Work happened", citations: ["nope"], quote: "Work happened" }], decisions: [], blockers: [] } });
const treeSize = (v: ArcValue) => (v.context?.threads.length ?? 0) + Object.values(v.context?.unassigned ?? {}).flat().length;
const headFile = (dir: string) => join(dir, readdirSync(dir).find((f) => f.endsWith(".head.json"))!);

test("arc empty result: a step-2 tree with no threads and no unassigned items fails the Build after one retry and keeps the last good Arc (failure: a Build stored an empty tree as done)", async () => {
	let empty = false;
	const r = replying("empty-tree", (s, nth) => (empty && s === STEP2_SYSTEM ? (nth % 2 ? EMPTY_TREE : UNCITED_TREE) : null));
	const first = await build(r.ctx);
	assert.equal(first.job?.state, "done");
	assert.ok(treeSize(first) > 0, "the first Build has a tree");
	const stored = receipt(r.dir), head = readFileSync(headFile(r.dir), "utf8"), step2Calls = r.calls.get(STEP2_SYSTEM) ?? 0;
	empty = true;
	const v = await build(r.ctx);
	assert.equal(v.job?.state, "error");
	assert.deepEqual({ purpose: v.job?.lastError?.purpose, model: v.job?.lastError?.model, code: v.job?.lastError?.code }, { purpose: "synthesis", model: HAIKU, code: "answer" });
	assert.equal(v.job?.lastError?.message, EMPTY_ANSWER);
	assert.equal((r.calls.get(STEP2_SYSTEM) ?? 0) - step2Calls, 2, "step 2 is asked twice: one retry");
	assert.deepEqual(receipt(r.dir), stored, "the stored receipt is unchanged");
	assert.equal(readFileSync(headFile(r.dir), "utf8"), head, "the head is unchanged");
	assert.equal(treeSize(v), treeSize(first), "the Arc value still shows the last good tree");
	assert.equal(v.keptAt, first.keptAt, "the shown Arc is the first Build's");
	assert.ok(v.keptAt);
	const log = buildLog(r.ctx, session.threadId);
	assert.deepEqual(log.map((b) => b.state), ["done", "error"]);
	assert.deepEqual({ error: log[1]!.error, purpose: log[1]!.errorPurpose, errorModel: log[1]!.errorModel, model: log[1]!.model }, { error: EMPTY_ANSWER, purpose: "synthesis", errorModel: HAIKU, model: HAIKU });
	// The last answer (UNCITED_TREE) had one leaf; the citation filter dropped it.
	assert.deepEqual(log[1]!.tree, { raw: { threads: 0, leaves: 1, asks: 0 }, kept: { threads: 0, leaves: 0, asks: 0 } });
	assert.ok(log[0]!.tree!.kept.threads > 0, "a done Build records its counts too");
});

test("arc stored empty tree: a receipt from before the rule reads as not built, rebuilds once on view, and a failed rebuild neither claims a kept Arc nor runs again (failure: an empty tree read as a valid Arc)", async () => {
	let empty = false;
	const pick = (s: string, nth: number) => (empty && s === STEP2_SYSTEM ? (nth % 2 ? EMPTY_TREE : UNCITED_TREE) : null);
	const r = replying("empty-stored", pick);
	assert.equal((await build(r.ctx)).job?.state, "done");
	// Rewrite the receipt as an older Build stored it: an empty tree under a v2 head that has no empty flag.
	const file = join(r.dir, receiptFile(r.dir)), raw = JSON.parse(readFileSync(file, "utf8"));
	raw.context = { ...raw.context, threads: [], needsYou: [], unassigned: { progress: [], decisions: [], blockers: [] } };
	writeFileSync(file, JSON.stringify(raw));
	const legacy = JSON.parse(readFileSync(headFile(r.dir), "utf8")); legacy.v = 2; delete legacy.e;
	writeFileSync(headFile(r.dir), JSON.stringify(legacy));
	// A fresh hub on the same state directory.
	empty = true;
	const again = replying("empty-stored", pick), now = arcClock.now, later = arcClock.later;
	let clock = Date.now() + 11 * 60_000;
	const timers: (() => void)[] = [];
	assert.equal(cosArc.summarize!(again.ctx, session), undefined, "the legacy head of an empty tree is not built");
	assert.equal(JSON.parse(readFileSync(headFile(r.dir), "utf8")).e, 1, "readHead rewrote the head with the empty flag");
	Object.assign(arcClock, { now: () => clock, later: (fn: () => void) => timers.push(fn) });
	try {
		const opened = arcOf(again.ctx);
		assert.equal(opened.keptAt, null, "an empty stored tree is no kept Arc");
		assert.equal(opened.synthesis, null, "nor does its headline show");
		assert.equal(opened.job?.state, "running", "viewing it starts one rebuild");
		assert.deepEqual([opened.context?.threads.length, opened.context?.needsYou.length], [0, 0], "the stored empty tree stays drawn while the rebuild runs");
		let v = opened;
		for (let i = 0; i < 400 && v.job?.state === "running"; i++) { await new Promise((res) => setTimeout(res, 25)); v = arcOf(again.ctx); }
		assert.equal(v.job?.state, "error");
		assert.equal(v.job?.lastError?.message, EMPTY_ANSWER);
		assert.equal(v.keptAt, null, "no Arc claims to be kept");
		assert.equal(cosArc.summarize!(again.ctx, session), undefined, "still not built");
		const calls = again.calls.get(STEP2_SYSTEM);
		assert.equal(calls, 2);
		// Past the 10 min bound, so only the answer rule holds the rebuild back.
		clock += 11 * 60_000;
		await new Promise((res) => setTimeout(res, 50));
		const after = arcOf(again.ctx);
		assert.notEqual(after.job?.state, "running", "a failed rebuild does not run again on view");
		assert.equal(again.calls.get(STEP2_SYSTEM), calls);
		assert.equal(timers.length, 0, "no automatic rebuild waits either");
		assert.deepEqual(buildLog(again.ctx, session.threadId).map((b) => [b.trigger, b.state, b.cause]), [["manual", "done", undefined], ["auto", "error", "rebuilt: the stored Arc was empty"]]);
	} finally { Object.assign(arcClock, { now, later }); }
});

// Runs `fn` with the shared test Session at `count` Rarebit messages.
async function withCount<T>(count: number, fn: () => Promise<T>): Promise<T> {
	const saved = session.data.rarebit.count;
	session.data.rarebit.count = count;
	try { return await fn(); } finally { session.data.rarebit.count = saved; }
}

test("arc floor: a manual Build below 4 messages whose answer is empty ends done and empty, asks once, and writes no receipt or head (failure: a one-prompt Session read as a failed Build)", async () => {
	const r = replying("floor-manual", (s) => (s === STEP2_SYSTEM ? EMPTY_TREE : null));
	await withCount(2, async () => {
		const v = await build(r.ctx);
		assert.deepEqual([v.job?.state, v.job?.empty], ["done", true]);
		assert.equal(v.job?.lastError, null, "no failure");
		assert.equal(r.calls.get(STEP2_SYSTEM), 1, "an empty answer below the floor is not retried");
		assert.deepEqual(readdirSync(r.dir).filter((f) => /^[0-9a-f]{64}(\.head)?\.json$/.test(f)), [], "no receipt and no head");
		assert.deepEqual(v.floor, { min: 4, messages: 2 });
		assert.equal(v.keptAt, null);
		assert.equal(cosArc.summarize!(r.ctx, session), undefined, "the Session still reads as not built");
		const [record] = buildLog(r.ctx, session.threadId);
		assert.deepEqual([record!.trigger, record!.state, record!.empty, record!.error], ["manual", "done", true, undefined]);
	});
	// At the floor an empty answer stays an error.
	await withCount(4, async () => {
		const v = await build(r.ctx);
		assert.equal(v.job?.lastError?.message, EMPTY_ANSWER);
		assert.equal(v.floor, null);
	});
});

test("arc floor: a stored empty tree below 4 messages neither rebuilds on view nor draws a hollow tree (failure: viewing a one-prompt Session spent a Build)", async () => {
	let empty = false;
	const pick = (s: string) => (empty && s === STEP2_SYSTEM ? EMPTY_TREE : null);
	const r = replying("floor-stored", pick);
	assert.equal((await build(r.ctx)).job?.state, "done");
	const file = join(r.dir, receiptFile(r.dir)), raw = JSON.parse(readFileSync(file, "utf8"));
	raw.context = { ...raw.context, threads: [], needsYou: [], unassigned: { progress: [], decisions: [], blockers: [] } };
	writeFileSync(file, JSON.stringify(raw));
	await withCount(2, async () => {
		const again = replying("floor-stored", pick), now = arcClock.now, later = arcClock.later, timers: (() => void)[] = [];
		Object.assign(arcClock, { now: () => Date.now() + 11 * 60_000, later: (fn: () => void) => timers.push(fn) });
		try {
			const v = arcOf(again.ctx);
			assert.notEqual(v.job?.state, "running", "no rebuild on view");
			assert.equal(timers.length, 0, "none waits either");
			assert.equal(v.context, null, "the empty tree is not drawn");
			assert.deepEqual(v.floor, { min: 4, messages: 2 });
			assert.equal(again.calls.size, 0, "no model call");
		} finally { Object.assign(arcClock, { now, later }); }
		// A manual Build whose answer is empty ends done and empty; the stored receipt and head stay.
		empty = true;
		const stored = readFileSync(file, "utf8"), head = readFileSync(headFile(r.dir), "utf8");
		const v = await build(again.ctx);
		assert.deepEqual([v.job?.state, v.job?.empty, v.job?.lastError], ["done", true, null]);
		assert.equal(readFileSync(file, "utf8"), stored, "the receipt is unchanged");
		assert.equal(readFileSync(headFile(r.dir), "utf8"), head, "the head is unchanged");
	});
});

test("arc empty result then a tree: the retry's non-empty tree commits (failure: one empty reply failed the Build)", async () => {
	const r = replying("empty-then-tree", (s, nth) => (s === STEP2_SYSTEM && nth === 0 ? EMPTY_TREE : null));
	const v = await build(r.ctx);
	assert.equal(v.job?.state, "done");
	assert.equal(r.calls.get(STEP2_SYSTEM), 2);
	assert.ok(treeSize(v) > 0);
	assert.equal(buildLog(r.ctx, session.threadId)[0]!.retries, 1);
});

test("arc upgrade after a transient failure: an outdated receipt whose rebuild failed with a model error rebuilds on a view past the 10 min bound (failure: a transient failure stopped the upgrade for good)", async () => {
	let failing = false, clock = Date.now() + 11 * 60_000;
	const r = context("upgrade-transient", () => 0, () => failing);
	assert.equal((await build(r.ctx)).job?.state, "done");
	const file = join(r.dir, receiptFile(r.dir)), raw = JSON.parse(readFileSync(file, "utf8"));
	writeFileSync(file, JSON.stringify({ ...raw, chunkerVersion: "older-rules" }));
	const again = context("upgrade-transient", () => 0, () => failing), now = arcClock.now, later = arcClock.later, timers: (() => void)[] = [];
	Object.assign(arcClock, { now: () => clock, later: (fn: () => void) => timers.push(fn) });
	const settle = async () => { let v = arcOf(again.ctx); for (let i = 0; i < 400 && v.job?.state === "running"; i++) { await new Promise((res) => setTimeout(res, 25)); v = arcOf(again.ctx); } return v; };
	try {
		failing = true;
		assert.equal(arcOf(again.ctx).job?.state, "running", "the view starts the upgrade");
		assert.equal((await settle()).job?.lastError?.code, "model");
		// The view after the failure set the pending flag; the bound's timer runs it once the 10 min pass.
		assert.equal(timers.length, 1, "one pending upgrade waits for the bound");
		failing = false; clock += 11 * 60_000;
		const started = again.run.started;
		timers[0]!();
		assert.equal(arcOf(again.ctx).job?.state, "running", "the upgrade runs once more past the bound");
		assert.equal((await settle()).job?.state, "done");
		assert.ok(again.run.started > started);
		assert.deepEqual(buildLog(again.ctx, session.threadId).map((b) => [b.trigger, b.state, b.errorCode, b.cause]),
			[["manual", "done", undefined, undefined], ["auto", "error", "model", "rebuilt: chunk rules changed"], ["auto", "done", undefined, "rebuilt: chunk rules changed"]]);
	} finally { Object.assign(arcClock, { now, later }); }
});

test("arc build steps: the job names step 1 with its labelled chunks, then step 2, and the record keeps each step's wall time (failure: progress counted calls only)", async () => {
	const r = context("steps", () => 60);
	buildArc(r.ctx, session, {});
	const seen: string[] = [];
	let v = cosArc.value(r.ctx, { kind: "view", view: "cos.arc", threadId: session.threadId }) as ArcValue;
	for (let i = 0; i < 400 && v.job?.state === "running"; i++) {
		if (v.job.step) { const at = v.job.step === "labels" ? `labels ${v.job.labelled}/${v.job.toLabel}` : "arc"; if (seen.at(-1) !== at) seen.push(at); }
		await new Promise((res) => setTimeout(res, 5));
		v = cosArc.value(r.ctx, { kind: "view", view: "cos.arc", threadId: session.threadId }) as ArcValue;
	}
	assert.equal(v.job?.state, "done", v.job?.lastError?.message ?? "");
	assert.equal(seen[0], "labels 0/20");
	assert.equal(seen.at(-1), "arc");
	const counts = seen.slice(0, -1).map((at) => Number(/^labels (\d+)\/20$/.exec(at)?.[1] ?? NaN));
	assert.ok(counts.length > 1 && counts.every((n, i) => n >= (counts[i - 1] ?? 0)), `step 1 counts labelled chunks up, then step 2 starts: ${seen}`);
	const { ms } = buildLog(r.ctx, session.threadId).at(-1)!;
	assert.ok(ms && ms.labels! >= 60 && ms.arc! >= 60, `per-step wall time: ${JSON.stringify(ms)}`);
});

test("arc format: label topics and card text cut at a word boundary with a mark and keep the full text (failure: 11 of 13 topics ended mid-word)", () => {
	const long = "Rebuilt the arc snapshot reader so that every chunk keeps its hash across compactions and the verification lane stays green";
	const cutAtWord = (cut: string, max: number) => {
		assert.ok(cut.length <= max && cut.endsWith("…"), cut);
		assert.ok(long.startsWith(cut.slice(0, -1)) && long[cut.length - 1] === " ", `cut at a word boundary: ${cut}`);
	};
	const l = normalizeLabel({ project: "AmPi", topic: long }, "") as ReturnType<typeof normalizeLabel> & { full?: { topic?: string } };
	cutAtWord(l.topic, 90);
	assert.equal(l.full?.topic, long, "the full topic stays one hover away");
	const text = `${long} ${long} ${long}`;
	const [p] = normalizeProjects([{ name: "AmPi", summary: text, lastState: text }], new Set()) as (ReturnType<typeof normalizeProjects>[number] & { full?: { summary?: string; lastState?: string } })[];
	for (const [cut, max] of [[p!.summary, 220], [p!.lastState, 240]] as const) assert.ok(cut.length <= max && cut.endsWith("…") && text.startsWith(cut.slice(0, -1)) && text[cut.length - 1] === " ", cut);
	assert.deepEqual(p!.full, { summary: text, lastState: text });
	assert.equal(normalizeLabel({ project: "AmPi", topic: "Short topic" }, "").topic, "Short topic", "a short field is not marked");
});

test("arc copy: the empty-answer error says what happened in plain words (failure: \"answer\" twice and the internal word \"floor\")", () => {
	assert.equal(EMPTY_ANSWER, "The model returned an empty Arc, even after one retry.");
});

test("arc evidence option: hub.json arcEvidence \"labels\" sends step 2 the labels, ask candidates and owner turns only; the default sends the full Rarebit evidence; a bad value fails the Build before any call and names the file (failure: no cheaper step-2 input to measure)", async () => {
	const builtWith = async (name: string) => {
		const r = context(name, () => 1), shown: string[] = [], inner = r.ctx.ask;
		Object.assign(r.ctx, { ask: (req: Req) => { if (req.system === STEP2_SYSTEM) shown.push(...(JSON.parse(req.prompt) as { arcs: { rarebitEvidence: string }[] }).arcs.map((a) => a.rarebitEvidence)); return inner(req); } });
		const v = await build(r.ctx);
		return { v, shown, log: buildLog(r.ctx, session.threadId).at(-1)! };
	};
	const full = await builtWith("evidence-default");
	assert.equal(full.v.job?.state, "done");
	assert.ok(full.shown.length === 20 && full.shown.every((e) => /AGENT: Step \d+ landed/.test(e)), "the default shows every Rarebit line");
	assert.equal(full.log.arcEvidence, undefined, "the default leaves the record unchanged");
	const file = join(root, "evidence-hub.json");
	writeFileSync(file, JSON.stringify({ hosts: [], models: MODELS, arcEvidence: "labels" }));
	useHubConfig(file);
	try {
		const labels = await builtWith("evidence-labels");
		assert.equal(labels.v.job?.state, "done", JSON.stringify(labels.v.job?.lastError));
		assert.ok(labels.shown.length === 20 && labels.shown.every((e, i) => e === `[u${i}] USER: Run step ${i}.`), `only owner turns: ${labels.shown[0]}`);
		assert.equal(labels.log.arcEvidence, "labels", "the record names the reduced input");
		writeFileSync(file, JSON.stringify({ hosts: [], models: MODELS, arcEvidence: "some" }));
		const bad = await builtWith("evidence-bad");
		assert.deepEqual([bad.v.job?.state, bad.log.calls, bad.shown.length], ["error", 0, 0]);
		assert.match(bad.v.job?.lastError?.message ?? "", new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: arcEvidence must be "full" or "labels"`));
	}
	finally { useHubConfig(HUB); }
});
