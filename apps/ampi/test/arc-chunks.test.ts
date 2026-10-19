import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkSession } from "../src/pi/views/cos-arc-chunks.ts";
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
const chunk = (records: PiReaderEntry[], rarebitChars?: Map<string, number>) => {
	const occurrences = records.filter((e) => e.role === "user").map((e) => ({ sourceEntryId: e.id, outcome: "user", text: e.text ?? "" }));
	return chunkSession(records, { selection: { occurrences }, imported: new Set(), inheritedBefore: NaN, rarebitChars }, "/work");
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
	assert.deepEqual(starts([owner("u1"), owner("w1", "New intercom message above.", 3 * 3600_000), owner("u2")]), ["u1"], "a wake after the gap starts agent work; the owner replies 1 min later");
});
