import "./bound.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { type ModelPurpose, resolveHelperModel, useHubConfig } from "../src/hub/helper-models.ts";
import { cosDemo } from "../scripts/demo/cos.ts";
import type { DemoContext } from "../scripts/demo/index.ts";
import { ask } from "../src/pi/ask.ts";
import { WorkingSet } from "../src/pi/working-set.ts";
import type { Source } from "../src/pi/working-set-types.ts";
import { askCandidates } from "../src/pi/views/cos-arc-asks.ts";
import { arcClock, cosArc, type ArcValue } from "../src/pi/views/cos-arc.ts";
import type { PiViewContext, PiViewSession } from "../src/pi/views/types.ts";
import { HELPER_MODELS } from "./pi-host-fixtures.ts";

useHubConfig(undefined, HELPER_MODELS);

// The chunk and excerpt rules are part of a derived Session's version. A row derived under older rules re-chunks at
// its next derive with byte-identical Session input, and the Arc view shows no label of the older rules on the new
// chunks. Opening that Arc asks for one Build through the pending path; an unviewed Session asks for none.

const line = (o: unknown) => JSON.stringify(o) + "\n";
const T = 1_770_000_000_000, H = 3600_000;
const at = (ms: number) => new Date(T + ms).toISOString();
const user = (id: string, parentId: string | null, text: string, ms: number) => ({ type: "message", id, parentId, timestamp: at(ms), message: { role: "user", content: [{ type: "text", text }] } });
const stop = (id: string, parentId: string, text: string, ms: number) => ({ type: "message", id, parentId, timestamp: at(ms), message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { input: 20, output: 10, cost: { total: 0.1 } } } });

/** Owner turns more than 2 h apart; an intercom wake 3 h after u0 lies inside the gap before u1. */
function fixture(file: string) {
	const rows = [
		{ type: "session", id: "fixture-session", cwd: "/synthetic/repo", timestamp: at(0) },
		user("u0", null, "Fix the parser.", 1000), stop("a0", "u0", "Fixed the parser.", 60_000),
		{ type: "custom_message", id: "m1", parentId: "a0", timestamp: at(3 * H), customType: "intercom_message", content: "[from worker] parser tests pass", display: true },
		user("w1", "m1", "New intercom message above.", 3 * H + 1000), stop("a1", "w1", "Noted the worker's result.", 3 * H + 60_000),
		user("u1", "a1", "Now the cache.", 4.5 * H), stop("a2", "u1", "Cached the parse tree.", 4.5 * H + 60_000),
		user("r1", "a2", "[from reviewer] the cache key misses the locale", 7 * H), stop("a3", "r1", "Added the locale to the key.", 7 * H + 60_000),
		user("o1", "a3", "[owner] ship it", 9.5 * H), stop("a4", "o1", "Shipped.", 9.5 * H + 60_000),
	];
	writeFileSync(file, rows.map(line).join(""));
}

function setup(t: { after: (fn: () => void) => void }) {
	const dir = mkdtempSync(join(tmpdir(), "ampi-arc-upgrade-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	cosDemo({ dir, agentDir: join(dir, "agent") } as DemoContext);
	const model = [process.execPath, join(dir, "cos-model.cjs")];
	const source: Source = { host: "fixture", cacheDir: join(dir, "cache"), path: "/synthetic/session.jsonl", file: join(dir, "copy.jsonl") };
	mkdirSync(source.cacheDir);
	fixture(source.file);
	const store = new WorkingSet(source.host, source.cacheDir);
	t.after(() => store.close());
	const session = (): PiViewSession => {
		const data = store.load(source.path)!;
		return { threadId: "fixture-session", ref: "fixture/fixture-session", sourceVersion: data.version, data, bytes: data.bytes, summary: { cwd: "/synthetic/repo", live: false },
			rarebits: (before?: string, fullText?: boolean) => store.rarebits(source.path, 1, before, fullText),
			arcEvidence: (ids: string[]) => store.arcEvidence(source.path, ids, data.version),
			entryTimes: (ids: string[]) => store.entryTimes(source.path, ids) } as unknown as PiViewSession;
	};
	const state = join(dir, "state"); mkdirSync(state);
	const asks: unknown[] = [];
	const ctx = { host: "fixture", stateDir: () => state, session, lease: () => () => {}, invalidate() {}, snapshot: <T>(read: () => T) => store.snapshot(read), model: (p: ModelPurpose, o?: string) => resolveHelperModel(p, o),
		ask: (req: Parameters<PiViewContext["ask"]>[0]) => { asks.push(req); return ask(req, model); } } as unknown as PiViewContext;
	return { dir, source, store, session, ctx, state, asks };
}

/** Stands in for a row the int derive wrote under the older rules: its version key and its chunks. */
function ageRow(cacheDir: string, path: string, old: { version: string; chunks: unknown[] }) {
	const writer = new DatabaseSync(join(cacheDir, "working-set.sqlite"), { timeout: 5000 });
	try {
		writer.prepare("UPDATE sessions SET data=json_set(data,'$.version',?,'$.arc.chunks',json(?)) WHERE path=?").run(old.version, JSON.stringify(old.chunks), path);
		writer.prepare("UPDATE arc_evidence SET text='excerpt/1 evidence' WHERE path=?").run(path);
	} finally { writer.close(); }
}

const label = (project: string) => ({ project, topic: "parser", subproject: null, mode: "build", ideas: [], work: [], outcome: null });
const oldReceipt = (sourceVersion: string, chunks: number) => ({
	version: 4, labelVersion: "old-labels", sourceVersion, builtAt: at(10 * H), headline: "Older arc", transitions: [], model: null,
	labels: Object.fromEntries(Array.from({ length: chunks }, (_, i) => [`c${i}`, { ...label("Parser"), hash: `old-h${i}` }])),
	projects: [{ name: "Parser", aliases: [], summary: "", status: "active", lastState: "" }],
});
const arcValue = (ctx: PiViewContext) => cosArc.value(ctx, { kind: "view", view: "cos.arc", threadId: "fixture-session" }) as ArcValue;
async function settle(ctx: PiViewContext) {
	for (let i = 0; i < 800; i++) {
		const v = arcValue(ctx);
		if (v.job?.state !== "running") return v;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("Build arc did not finish");
}

test("arc chunker upgrade: a row derived under older chunk and excerpt rules re-chunks with byte-identical input, and its old labels stay hidden (failure: old chunks or old labels survived)", async (t) => {
	const { source, store, ctx, state } = setup(t);
	const fresh = (await store.refresh(source))!;
	const sourceVersion = fresh.version.slice(fresh.version.indexOf(":") + 1);
	const newChunks = fresh.arc.chunks.map((c) => [c.firstEntryId, c.hash]);
	assert.ok(newChunks.length >= 3, `the 2 h gaps cut chunks: ${JSON.stringify(newChunks)}`);
	assert.equal(fresh.arc.chunks[1]!.firstEntryId, "u1", "the wake inside the gap does not erase it");
	const evidence = store.arcEvidence(source.path, ["c0"]).get("c0")!;
	assert.ok(evidence.length > 20, evidence);
	const bytes = readFileSync(source.file);

	// The older rules: one chunk over the whole Session, under the index-only version key.
	const merged = { ...fresh.arc.chunks[0]!, hash: "old-h0", lastEntryId: "a4", ownerTurns: 4 };
	ageRow(source.cacheDir, source.path, { version: `5:${sourceVersion}`, chunks: [merged] });
	assert.equal(store.load(source.path)!.arc.chunks.length, 1);
	writeFileSync(join(state, `${createHash("sha256").update("fixture-session").digest("hex")}.json`), JSON.stringify(oldReceipt(`5:${sourceVersion}`, 3)));

	const again = (await store.refresh(source))!;
	assert.deepEqual(readFileSync(source.file), bytes, "the native Session input is byte-identical");
	assert.equal(again.version, fresh.version, "the derive wrote the current rules' version key");
	assert.deepEqual(again.arc.chunks.map((c) => [c.firstEntryId, c.hash]), newChunks, "the derive re-chunked the Session");
	assert.equal(store.arcEvidence(source.path, ["c0"]).get("c0"), evidence, "the derive rewrote the excerpt evidence");

	// Open the Arc: chunk ids c0..c2 match the old receipt's labels, but those came from other chunk rules.
	const c = { t: Date.parse(at(10 * H)) + 60_000, scheduled: [] as number[] }, saved = { ...arcClock };
	Object.assign(arcClock, { now: () => c.t, later: (_run: () => void, ms: number) => { c.scheduled.push(ms); } });
	t.after(() => Object.assign(arcClock, saved));
	writeFileSync(join(state, `${createHash("sha256").update("fixture-session").digest("hex")}.builds.json`), JSON.stringify([{ trigger: "auto", startedAt: new Date(c.t - 60_000).toISOString(), endedAt: new Date(c.t - 30_000).toISOString(), state: "done", calls: 1, model: null, usage: { input: 100, output: 10, cost: null } }]));
	const v = arcValue(ctx);
	assert.equal(v.chunks.length, newChunks.length);
	assert.deepEqual(v.chunks.map((x) => [x.label, x.labelCurrent, x.relabel ?? false]), v.chunks.map((_, i) => [null, false, i < 3]), "no chunk shows a label of the older rules");
	assert.deepEqual(v.cards, [], "Projects count only labels of the current rules");
	assert.equal(v.relabelChunks, newChunks.length);
	assert.equal(v.job?.state ?? null, null, "the 10 min bound holds the upgrade Build");
	assert.deepEqual(c.scheduled.length, 1, "one pending Build at the bound's end");
	assert.ok(v.nextAutoAt, "the panel shows when the upgrade Build runs");
	arcValue(ctx); arcValue(ctx);
	assert.equal(c.scheduled.length, 1, "reopening asks for no second Build");
});

test("arc chunker upgrade: a row derived under older excerpt rules alone re-derives its evidence with byte-identical input (failure: excerpt/1 evidence survived)", async (t) => {
	const { source, store } = setup(t);
	const fresh = (await store.refresh(source))!;
	const evidence = store.arcEvidence(source.path, ["c0"]).get("c0")!;
	const [, chunker, excerpt] = /^(\d+\/[^/]+\/\d+)\/([^:]+):/.exec(fresh.version) ?? [];
	assert.ok(chunker && excerpt && excerpt !== "ampi-arc-excerpt/1", fresh.version);
	ageRow(source.cacheDir, source.path, { version: fresh.version.replace(`/${excerpt}:`, "/ampi-arc-excerpt/1:"), chunks: fresh.arc.chunks });
	assert.equal(store.arcEvidence(source.path, ["c0"]).get("c0"), "excerpt/1 evidence");
	const again = (await store.refresh(source))!;
	assert.equal(again.version, fresh.version);
	assert.equal(store.arcEvidence(source.path, ["c0"]).get("c0"), evidence);
});

test("arc chunker upgrade: opening the Arc of an outdated receipt runs one Build that relabels every chunk; an unviewed Session asks for none (failure: no upgrade, or a Build for an unviewed Session)", async (t) => {
	const { source, store, ctx, state, asks, session } = setup(t);
	const fresh = (await store.refresh(source))!;
	const receiptFile = join(state, `${createHash("sha256").update("fixture-session").digest("hex")}.json`);
	writeFileSync(receiptFile, JSON.stringify(oldReceipt(fresh.version, fresh.arc.chunks.length)));
	cosArc.changed?.(ctx, [session()]);
	assert.equal(asks.length, 0, "an unviewed, idle Session with no new messages starts no Build");
	const first = arcValue(ctx);
	assert.equal(first.job?.state, "running", "opening the Arc started the upgrade Build");
	const v = await settle(ctx);
	assert.equal(v.job?.state, "done", v.job?.lastError?.message ?? "");
	const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
	assert.equal(typeof receipt.chunkerVersion, "string");
	assert.equal(typeof receipt.excerptVersion, "string");
	assert.equal(v.relabelChunks, null);
	assert.ok(v.chunks.every((c) => c.labelCurrent), "every chunk has a label of the current rules");
	const calls = asks.length;
	arcValue(ctx);
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(asks.length, calls, "a current receipt asks for no further Build");
});

test("arc chunker upgrade: the chunker and askCandidates find the same owner turns (failure: the two owner rules diverged)", async (t) => {
	const { source, store } = setup(t);
	const data = (await store.refresh(source))!;
	const items = store.rarebits(source.path, 1).items;
	assert.ok(data.arc.chunks.every((c) => c.ownerTurns <= 1), "each owner turn is its own chunk in this fixture");
	const chunker = data.arc.chunks.filter((c) => c.ownerTurns > 0).map((c) => c.lastOwnerEntryId).sort();
	const asks = [...askCandidates(items).owners.keys()].sort();
	assert.deepEqual(chunker, asks);
	assert.ok(!asks.includes("w1"), "the intercom wake is no owner turn");
});
