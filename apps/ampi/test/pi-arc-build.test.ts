import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cosDemo } from "../scripts/demo/cos.ts";
import type { DemoContext } from "../scripts/demo/index.ts";
import { ask } from "../src/pi/ask.ts";
import type { Chunk } from "../src/pi/views/cos-arc-chunks.ts";
import { LABEL_SYSTEM } from "../src/pi/views/cos-arc-model.ts";
import { ARC_ASK_CONCURRENCY, LABEL_VERSION, bounded, buildArc, buildLog, cosArc, json, type ArcValue } from "../src/pi/views/cos-arc.ts";
import type { PiViewContext, PiViewSession } from "../src/pi/views/types.ts";

// Build arc through the real ask runner and the offline demo model, with a fake view context that counts calls in
// flight and delays answers so that they complete out of order.

const root = mkdtempSync(join(tmpdir(), "ampi-arc-build-"));
cosDemo({ dir: root, agentDir: join(root, "agent") } as DemoContext);
const model = [process.execPath, join(root, "cos-model.cjs")];
const T = Date.parse("2026-10-19T00:00:00.000Z");
// 20 chunks: four label batches of six, then synthesis and context.
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
	const ctx = { host: "devbox", stateDir: () => dir, session: () => session, lease: () => () => {}, invalidate() {}, snapshot: <T>(read: () => T) => read(),
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
	assert.equal(v.buildEstimate.calls, 2, "after a full Build only synthesis and the tree remain");
	assert.equal(v.job?.done, v.job?.total, "progress reaches its total");
	const sequential = context("sequential", () => 10);
	const w = await build(sequential.ctx, 1);
	assert.equal(w.job?.state, "done", w.job?.lastError?.message ?? "");
	assert.equal(sequential.run.maxInFlight, 1);
	assert.equal(w.buildEstimate.calls, v.buildEstimate.calls);
	assert.equal(w.buildEstimate.inputTokens, v.buildEstimate.inputTokens);
	assert.equal(JSON.stringify(receipt(parallel.dir)), JSON.stringify(receipt(sequential.dir)), "same bytes, key order included");
});

test("arc build failure: a failed synthesis call cancels the Build, settles in-flight calls, and writes no receipt", async () => {
	// Calls 0-3 label; call 4 is synthesis and fails while the context call 5 is in flight.
	const failing = context("failing", (call) => (call === 4 ? 5 : call === 5 ? 80 : 10), (call) => call === 4);
	const v = await build(failing.ctx);
	assert.equal(v.job?.state, "error");
	assert.match(v.job?.lastError?.message ?? "", /synthetic failure/);
	assert.equal(failing.run.startedAfterFailure, 0, "no model call starts after the failure");
	assert.equal(failing.run.inFlight, 0, "the job ends only after in-flight calls settle");
	assert.deepEqual(readdirSync(failing.dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/^[0-9a-f]{64}/, "")), [".builds.json"], "no receipt or head is written; the Build log records the failure");
});

const labelled = (req: Req) => req.system !== LABEL_SYSTEM ? [] : [...req.prompt.matchAll(/"chunk":"(c\d+)"/g)].map((m) => m[1]);

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

test("arc build partial: a label batch that fails twice leaves its chunks unlabelled and tier 2 still builds (failure: tier-1 loss aborted tier 2)", async () => {
	const p = context("partial", () => 10, (_call, req) => labelled(req).includes("c7"));
	const estimate = estimateOf(p.ctx);
	const v = await build(p.ctx);
	assert.equal(v.job?.state, "done", v.job?.lastError?.message ?? "");
	assert.equal(v.coverage.unmappedChunks, 6, "batch c6-c11 stays unlabelled");
	assert.ok(v.chunks.filter((c) => !c.label).every((c) => Number(c.id.slice(1)) >= 6 && Number(c.id.slice(1)) <= 11));
	assert.ok(v.context, "the tier-2 tree is built from the available labels");
	assert.equal(p.run.started, estimate.calls + 1);
	const log = buildLog(p.ctx, session.threadId).at(-1)!;
	assert.equal(log.state, "done"); assert.equal(log.retries, 1); assert.equal(log.unlabelledChunks, 6);
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
	assert.equal(before.buildEstimate.calls, 3, "one label batch plus synthesis and tree");
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

test("arc build v3 receipt: a stored v3 receipt parses and renders, and reuses no label (failure: labels of another prompt counted as current)", async () => {
	const v3 = JSON.parse(readFileSync(new URL("./fixtures/arc-receipt-v3.json", import.meta.url), "utf8"));
	assert.equal(v3.version, 3);
	const r = seeded("v3", v3, session);
	const before = arcOf(r.ctx);
	assert.equal(before.synthesis?.headline, v3.headline);
	assert.deepEqual(before.cards.map((c) => c.name), ["demo", "release"]);
	assert.equal(before.transitions.length, 1);
	assert.equal(before.coverage.labelledChunks, 0);
	assert.equal(before.buildEstimate.calls, 6, "every chunk is labelled again");
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
