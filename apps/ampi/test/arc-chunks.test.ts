import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { areaOf, chunkSession } from "../src/pi/views/cos-arc-chunks.ts";
import type { PiReaderEntry } from "../src/pi/views/types.ts";

const T = Date.parse("2026-10-19T08:00:00.000Z");
let clock = 0;
// Synthetic reader records carry only the fields the chunker reads.
const entry = (fields: object) => fields as unknown as PiReaderEntry;
const at = (gap = 60_000) => new Date(T + (clock += gap)).toISOString();
const owner = (id: string, text = `owner ask ${id}`, gap?: number) => entry({ id, t: at(gap), kind: "human", role: "user", text, blocks: [{ type: "text", text }] });
const wake = (id: string) => owner(id, "New intercom message above.");
const work = (id: string, path: string) => entry({ id, t: at(), kind: "assistant", role: "assistant", blocks: [{ type: "toolCall", name: "read", args: { path } }] });
const compaction = (id: string) => entry({ id, t: at(), kind: "compaction", summary: "Earlier work on the reader" });
const stop = (id: string, text: string) => entry({ id, t: at(), kind: "assistant", role: "assistant", stop: "stop", text, blocks: [{ type: "text", text }] });
const chunk = (records: PiReaderEntry[], rarebitChars?: Map<string, number>) => {
	const occurrences = records.filter((e) => e.text && (e.role === "user" || e.role === "assistant")).map((e) => ({ sourceEntryId: e.id, outcome: e.role === "user" ? "user" : "stop", text: e.text ?? "" }));
	return chunkSession(records, { selection: { occurrences }, imported: new Set(), inheritedBefore: NaN, rarebitChars: rarebitChars ?? new Map(occurrences.map((o) => [o.sourceEntryId, o.text.length])) }, "/work");
};
const starts = (records: PiReaderEntry[], rarebitChars?: Map<string, number>) => chunk(records, rarebitChars).chunks.map((c) => c.firstEntryId);

test("arc chunks: a move to another directory does not cut a chunk; it only describes it", () => {
	const skeleton = chunk([owner("u1"), work("a1", "/work/apps/reader/index.ts"), owner("u2"), work("a2", "/work/apps/gui/index.ts"), work("a3", "/work/apps/gui/view.ts")]);
	assert.deepEqual(skeleton.chunks.map((c) => [c.firstEntryId, c.where]), [["u1", "apps/gui"]]);
});

test("arc chunks: a compaction stays inside its chunk as an EARLIER-CONTEXT line", () => {
	const skeleton = chunk([owner("u1"), work("a1", "/work/apps/reader/index.ts"), compaction("k1"), owner("u2")]);
	assert.deepEqual(skeleton.chunks.map((c) => [c.firstEntryId, c.lastEntryId, c.compactionEntryId]), [["u1", "u2", "k1"]]);
	assert.match(skeleton.evidence.get("c0")!, /^\[k1\] EARLIER-CONTEXT/m);
});

test("arc chunks: an intercom wake neither starts a chunk nor counts as an owner turn", () => {
	const records = [owner("u1"), work("a1", "/work/apps/reader/index.ts"), wake("w1"), work("a2", "/work/apps/gui/index.ts"), owner("u2")];
	const skeleton = chunk(records);
	assert.deepEqual(skeleton.chunks.map((c) => [c.firstEntryId, c.ownerTurns, c.lastOwnerEntryId]), [["u1", 2, "u2"]]);
});

test("arc chunks: the owner-turn cap counts real owner turns and cuts at the thirteenth", () => {
	const records: PiReaderEntry[] = [];
	for (let i = 0; i < 13; i++) records.push(owner(`u${i}`), ...(i === 5 ? [wake("w5")] : []));
	assert.deepEqual(starts(records), ["u0", "u12"]);
});

test("arc chunks: the Rarebit-chars cap cuts at the next owner turn, not at harness text", () => {
	const records = [owner("u1"), entry({ id: "s1", t: at(), kind: "assistant", role: "assistant", text: "long stop", blocks: [{ type: "text", text: "long stop" }] }), wake("w1"), owner("u2")];
	assert.deepEqual(starts(records, new Map([["u1", 12], ["s1", 40_000]])), ["u1", "u2"]);
	assert.deepEqual(starts(records, new Map([["u1", 12], ["s1", 39_000]])), ["u1"]);
});

test("arc chunks: an idle gap over two hours cuts only where an owner turn starts", () => {
	assert.deepEqual(starts([owner("u1"), owner("u2", "back", 3 * 3600_000)]), ["u1", "u2"]);
});

test("arc chunks: a harness wake inside a long gap does not erase it (failure: the wake's work reset the idle clock)", () => {
	assert.deepEqual(starts([owner("u1"), wake("w1"), owner("u2")]), ["u1"]);
	clock = 0;
	const records = [owner("u1"), stop("s1", "Done."), entry({ ...wake("w1"), t: at(3 * 3600_000) }), stop("s2", "Read the inbox."), owner("u2")];
	assert.deepEqual(starts(records), ["u1", "u2"], "3 h without owner-driven activity, though the wake's stop came 1 min before u2");
	assert.ok(chunk(records).chunks[1]!.idleBeforeMs! > 3 * 3600_000);
});

test("arc chunks: a user message the reader marks injected is no owner turn (failure: chunker and Rarebit disagreed)", () => {
	const injected = entry({ id: "i1", t: at(), kind: "injected", role: "user", text: "Review this plan", blocks: [{ type: "text", text: "Review this plan" }] });
	assert.deepEqual(chunk([owner("u1"), injected, owner("u2")]).chunks.map((c) => c.ownerTurns), [2]);
});

test("arc where: only a path inside a repository cwd names an area; /dev, /tmp, ~ and outside paths name none (failure: pseudo-areas)", () => {
	for (const [path, cwd, area] of [
		["/dev/null", "/work", null], ["/tmp/x/y.log", "/work", null], ["~", "/root/work", null], ["~/.config/x", "/root/work", null],
		["dev/null", "/work", "dev"], ["/elsewhere/repo/a.ts", "/work", null], ["/root/notes/a.md", "/root", null], ["/x/a.ts", "/", null],
		["../other/a.ts", "/work", null], ["README.md", "/work", null], ["/work/apps/reader/index.ts", "/work", "apps/reader"], ["src/a.ts", "/work", "src"],
		["~/work/docs/guide/a.md", "/root/work", "docs/guide"],
	] as const) assert.equal(areaOf(path, cwd), area, `${path} in ${cwd}`);
	const skeleton = chunk([owner("u1"), work("a1", "/dev/null"), work("a2", "/tmp/build/out.txt"), work("a3", "~/")]);
	assert.equal(skeleton.chunks[0]!.where, null, "no area when no path lies in the repository");
});

// Eight owner turns, each answered by six stops with a read between them; 104 entries of 380 Rarebit chars stay one chunk.
function bigChunk() {
	const records: PiReaderEntry[] = [];
	for (let t = 0; t < 8; t++) {
		records.push(owner(`u${t}`, `owner ask ${t} ${"x".repeat(200)}`));
		for (let k = 0; k < 6; k++) records.push(stop(`s${t}.${k}`, `stop ${t}.${k} ${"y".repeat(500)}`), work(`a${t}.${k}`, `/work/apps/reader/file-${t}-${k}-${"z".repeat(100)}.ts`));
	}
	return chunk(records, new Map(records.map((e) => [e.id, 380])));
}

test("arc excerpt: a 40k chunk keeps every USER line, the stop before each owner turn and the final stop", () => {
	const skeleton = bigChunk(), excerpt = skeleton.evidence.get("c0")!;
	assert.equal(skeleton.chunks.length, 1);
	assert.ok(excerpt.length <= 7000 + Math.floor((104 * 380 - 7000) / 4), `${excerpt.length} chars`);
	for (let t = 0; t < 8; t++) assert.ok(excerpt.includes(`[u${t}] USER: owner ask ${t} ${"x".repeat(200)}\n`), `USER u${t} whole`);
	for (let t = 0; t < 8; t++) assert.match(excerpt, new RegExp(`^\\[s${t}\\.5\\] AGENT: stop ${t}\\.5`, "m"), `last stop of turn ${t}`);
	assert.match(excerpt, /^… \d+ lines omitted$/m);
	assert.match(excerpt, /^\[s0\.0\] AGENT/m, "the first turn's run keeps its head");
	assert.match(excerpt, /^\[s7\.0\] AGENT/m, "the last turn's run keeps its head");
});

test("arc excerpt: the budget grows with Rarebit chars up to 16000", () => {
	const records = [owner("u1")];
	for (let k = 0; k < 200; k++) records.push(stop(`s${k}`, `stop ${k} ${"y".repeat(500)}`));
	const excerpt = chunk(records, new Map(records.map((e) => [e.id, 500]))).evidence.get("c0")!;
	assert.ok(excerpt.length > 15_000 && excerpt.length <= 16_000, `${excerpt.length} chars`);
	assert.match(excerpt, /^\[s199\] AGENT/m);
});

test("arc excerpt: kept lines over budget shorten AGENT lines first, keep the final stop whole and fit the budget (failure: excerpt over budget)", () => {
	const records: PiReaderEntry[] = [];
	for (let i = 0; i < 12; i++) records.push(owner(`u${i}`, `ask ${i} ${"x".repeat(592)}`), stop(`s${i}`, `stop ${i} ${"y".repeat(412)}`));
	const skeleton = chunk(records, new Map([["u0", 7000]])), excerpt = skeleton.evidence.get("c0")!;
	assert.equal(skeleton.chunks.length, 1);
	assert.ok(excerpt.length <= 7000, `${excerpt.length} chars`);
	assert.ok(excerpt.includes(`[s11] AGENT: stop 11 ${"y".repeat(412)}`), "the final stop stays whole");
	for (let i = 0; i < 12; i++) assert.match(excerpt, new RegExp(`^\\[u${i}\\] USER: ask ${i} x`, "m"), `owner u${i} stays`);
});

test("arc excerpt: harness USER lines are sampled with the runs, so each run keeps a stop (failure: wakes crowded out every stop)", () => {
	const records: PiReaderEntry[] = [owner("u0")];
	for (let i = 0; i < 20; i++) {
		if (i === 10) records.push(owner("u1"));
		records.push(wake(`w${i}`), stop(`s${i}`, `stop ${i} ${"y".repeat(412)}`));
	}
	const skeleton = chunk(records, new Map([["u0", 7000]])), excerpt = skeleton.evidence.get("c0")!;
	assert.ok(excerpt.length <= 7000, `${excerpt.length} chars`);
	const kept = [...excerpt.matchAll(/^\[s(\d+)\] AGENT/gm)].map((m) => Number(m[1]));
	assert.ok(kept.some((i) => i < 9), `the run before u1 keeps a stop besides s9: ${kept}`);
	assert.ok(kept.some((i) => i >= 10 && i < 19), `the run after u1 keeps a stop besides s19: ${kept}`);
	assert.ok(kept.includes(9) && kept.includes(19), "the stop before u1 and the final stop stay");
});
