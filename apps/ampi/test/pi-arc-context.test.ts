import assert from "node:assert/strict";
import { test } from "node:test";
import type { Chunk } from "../src/pi/views/cos-arc-chunks.ts";
import { askCandidates } from "../src/pi/views/cos-arc-asks.ts";
import { TITLE_LIMITS, normalizeContext } from "../src/pi/views/cos-arc-context.ts";
import { arcHead, headOf } from "../src/pi/views/cos-arc.ts";
import type { RarebitItem } from "../src/pi/views/rarebit.ts";

const SESSION = "devbox/pi:sess-a";
const chunk = (id: string, hash: string) => ({ id, hash }) as Chunk;
const chunks = [chunk("c0", "h0"), chunk("c1", "h1")];
// Synthetic Rarebit items: two agent stops ask the owner; u2 answers the first stop's question; a2 restates the cap ask.
const items: RarebitItem[] = [
	{ id: "u1", kind: "user", t: null, text: "Cap the reader cache." },
	{ id: "a1", kind: "stop", t: null, text: "Proposed an LRU cache with a size cap.\n\nShould I cap it at 64 MB?" },
	{ id: "u2", kind: "user", t: null, text: "Yes, cap it at 64 MB and approve the deploy." },
	{ id: "a2", kind: "stop", t: null, text: "Cap set to 64 MB. May I deploy to the second Host? Tell me if the alias changed." },
];
const evidence = new Map([
	["c0", "[u1] USER: Cap the reader cache.\n[a1] AGENT: Proposed an LRU cache with a size cap. Should I cap it at 64 MB?\n[a1] TOOL bash: {}"],
	["c1", "[k1] EARLIER-CONTEXT (model-written compaction): old summary\n[u2] USER: Yes, cap it at 64 MB and approve the deploy.\n[a2] AGENT: Cap set to 64 MB. May I deploy to the second Host? Tell me if the alias changed."],
]);
const support = { texts: new Map(items.map((i) => [i.id, i.text])), ...askCandidates(items) };
const times = new Map<string, number | null>([["u1", 1000], ["a1", 2000], ["u2", 3000], ["a2", 4000]]);
const build = (raw: unknown, s = support) => normalizeContext(raw, chunks, evidence, SESSION, times, "2026-10-19T00:00:00.000Z", "m", 4, "f".repeat(64), "a2", s);
const ids = Object.fromEntries(support.candidates.map((c) => [c.text, c.id]));

test("arc context citations: only this Session's Rarebit message entries survive, Session-qualified and dated", () => {
	const c = build({ unassigned: { progress: [{ text: "Cap landed", quote: "cap set to 64  MB", citations: ["a2", "invented", "k1", "other-session-u9", "u1"] }] } });
	const cited = c.unassigned.progress[0]!.citations;
	assert.deepEqual(cited.map((x) => x.entryId), ["a2", "u1"], "invented, compaction-only, and cross-Session IDs are rejected");
	assert.deepEqual(cited[0], { session: SESSION, entryId: "a2", chunkHash: "h1", at: 4000 });
	assert.equal(build({ unassigned: { progress: [{ text: "No valid evidence", quote: "Cap set", citations: ["other-session-u9"] }] } }).unassigned.progress.length, 0, "a leaf without a valid citation is dropped");
	assert.deepEqual(c.coverage, { evidenceEntries: 4, citedEntries: 4, omittedEntries: 0 }, "the candidate asks add a1, and the owner turn u2 that overtakes it");
});

test("arc context quote: a real ID with a quote absent from the cited message is dropped (failure: unsupported leaves survived)", () => {
	const c = build({ unassigned: { progress: [
		{ text: "Cap landed", quote: "Cap set to 64 MB.", citations: ["a2"] },
		{ text: "Cache evicts by age", quote: "evicts entries older than a day", citations: ["a2"] },
		{ text: "No quote", citations: ["a2"] },
		{ text: "Quote from an uncited message", quote: "Proposed an LRU cache", citations: ["a2"] },
	] } });
	assert.deepEqual(c.unassigned.progress.map((l) => l.text), ["Cap landed"]);
	assert.equal(c.unassigned.progress[0]!.quote, "Cap set to 64 MB.");
});

test("arc context resolution: an ask is answered only by its cited later owner turn, otherwise the first later owner turn overtakes it; kind and state fall back (failure: an answered ask stayed open, or a wrong cite answered it)", () => {
	const q = ids["Should I cap it at 64 MB?"]!;
	const c = build({ asks: [{ candidates: [q], text: "Cap the cache at 64 MB?", kind: "nonsense", answeredBy: "u2" }], threads: [{ label: "Deploy", state: "waiting" }] });
	assert.deepEqual(c.answered!.map((l) => [l.text, l.closed, l.resolvedBy[0]!.entryId, l.citations[0]!.entryId]), [["Cap the cache at 64 MB?", "answered", "u2", "a1"]]);
	assert.deepEqual(c.overtaken, []);
	assert.ok(!c.needsYou.some((l) => l.citations[0]!.entryId === "a1"));
	assert.equal(c.answered![0]!.kind, "decision", "an unknown kind falls back to decision");
	assert.equal(c.threads[0]!.state, "unclear", "an unknown thread state is unclear");
	for (const answeredBy of ["a2", "u1", "invented", null]) {
		const o = build({ asks: [{ candidates: [q], text: "Cap?", kind: "decision", answeredBy }] });
		assert.deepEqual([o.answered, o.overtaken!.map((l) => [l.text, l.closed, l.resolvedBy[0]!.entryId])], [[], [["Cap?", "overtaken", "u2"]]], `answeredBy ${answeredBy} is not an owner turn after the ask`);
		assert.ok(!o.needsYou.some((l) => l.text === "Cap?"));
	}
});

test("arc context candidates: the model never adds or silently drops an ask (failure: model-invented asks, or an omitted candidate vanished)", () => {
	const c = build({ needsYou: [{ text: "Invented ask", kind: "decision", citations: ["u1"], quote: "Cap the reader cache." }], asks: [{ candidates: ["q99"], text: "Invented too" }] });
	assert.deepEqual(c.needsYou.map((l) => l.quote).sort(), ["May I deploy to the second Host?", "Tell me if the alias changed."], "every candidate after the last owner turn stays open, quoted verbatim");
	assert.deepEqual(c.overtaken!.map((l) => l.quote), ["Should I cap it at 64 MB?"], "an earlier candidate is overtaken, never dropped");
	assert.ok(c.needsYou.every((l) => l.ask && l.resolvedBy.length === 0 && !l.closed));
});

test("arc context carry-forward: a restatement reopens an ask, and only an owner turn after the restatement overtakes it (failure: an earlier owner turn closed it, or a later one dropped it)", () => {
	const restated: RarebitItem[] = [...items, { id: "u3", kind: "user", t: null, text: "Unrelated: rename the module." }, { id: "a3", kind: "stop", t: null, text: "Renamed.\n\nShould I cap it at 64 MB?" }, { id: "u4", kind: "user", t: null, text: "Also tidy the docs." }];
	const { candidates, owners } = askCandidates(restated);
	const cap = candidates.find((x) => x.text === "Should I cap it at 64 MB?")!;
	assert.deepEqual([cap.entryId, cap.entries], ["a3", ["a1", "a3"]], "the candidate follows its latest statement");
	const more = new Map([...evidence, ["c1", `${evidence.get("c1")}\n[u3] USER: Unrelated: rename the module.\n[a3] AGENT: Renamed. Should I cap it at 64 MB?\n[u4] USER: Also tidy the docs.`]]);
	const c = normalizeContext({ asks: [{ candidates: [cap.id], text: "Cap at 64 MB?", answeredBy: "u2" }] }, chunks, more, SESSION, times, "t", "m", 7, "f", "u4", { texts: new Map(restated.map((i) => [i.id, i.text])), candidates, owners });
	const leaf = c.overtaken!.find((l) => l.text === "Cap at 64 MB?")!;
	assert.equal(leaf.citations[0]!.entryId, "a3", "one leaf cites the latest ask entry");
	assert.equal(c.answered!.length, 0, "u2 precedes the restatement, so it cannot answer it");
	assert.deepEqual(c.overtaken!.map((l) => [l.quote, l.resolvedBy[0]!.entryId]), [[cap.text, "u4"], ["May I deploy to the second Host?", "u3"], ["Tell me if the alias changed.", "u3"]], "u4 follows the restatement and overtakes it, newest first; u3 precedes it and overtakes only a2's asks");
	const before = askCandidates(restated.slice(0, -1));
	assert.equal(normalizeContext({}, chunks, more, SESSION, times, "t", "m", 7, "f", "a3", { texts: new Map(), candidates: before.candidates, owners: before.owners }).needsYou.filter((l) => l.quote === cap.text).length, 1, "without u4 the restated ask is open, although u2 and u3 came after its first statement");
});

test("arc context dedupe: asks with the same gist merge into one leaf and the head counts after dedupe (failure: duplicate Needs-you rows)", () => {
	const c = build({ asks: [
		{ candidates: [ids["May I deploy to the second Host?"]], text: "Approve the deploy", kind: "approval" },
		{ candidates: [ids["Should I cap it at 64 MB?"]], text: "approve  the **deploy**", kind: "approval" },
		{ candidates: [ids["May I deploy to the second Host?"]], text: "Claimed twice", kind: "approval" },
	] });
	assert.deepEqual(c.needsYou.map((l) => l.text).sort(), ["Approve the deploy", "Tell me if the alias changed."]);
	assert.equal(c.needsYou.find((l) => l.text === "Approve the deploy")!.citations[0]!.entryId, "a2", "the merged leaf cites the latest ask");
	const head = headOf({ version: 4, sourceVersion: "v", builtAt: c.builtAt, labels: {}, headline: "", projects: [], transitions: [], model: null, context: c });
	assert.equal(head.open.reduce((a, b) => a + b, 0), 2);
});

test("arc context Needs you: grouped by kind, oldest ask first, never truncated", () => {
	const many: RarebitItem[] = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, kind: "stop" as const, t: null, text: `Should I take option ${i}?` }));
	const ev = new Map([["c0", many.map((i) => `[${i.id}] AGENT: ${i.text}`).join("\n")]]);
	const at = new Map(many.map((i, n) => [i.id, 1000 + n]));
	const { candidates, owners } = askCandidates(many);
	const c = normalizeContext({ asks: candidates.map((x, i) => ({ candidates: [x.id], text: x.text, kind: i % 2 ? "input" : "decision" })) }, [chunks[0]!], ev, SESSION, at, "t", "m", 12, "f", "s11", { texts: new Map(), candidates, owners });
	assert.equal(c.needsYou.length, 12, "Needs you is never truncated");
	assert.deepEqual(c.needsYou.map((l) => l.kind), [...Array(6).fill("decision"), ...Array(6).fill("input")]);
	const decisions = c.needsYou.filter((l) => l.kind === "decision").map((l) => l.citations[0]!.at!);
	assert.deepEqual(decisions, [...decisions].sort((a, b) => a - b), "within a kind the oldest ask comes first");
});

test("arc context titles: asks, thread labels and leaves are cut to their limits at a word boundary, with the full text kept (failure: long titles reached the tree)", () => {
	const q = ids["Should I cap it at 64 MB?"]!;
	const longAsk = "Choose whether the overtaken asks should go to the Needs you list or be dropped entirely";
	const longLeaf = "Implemented the snapshot read so that every Build reads its Session once inside one store transaction and checks versions";
	const c = build({
		asks: [{ candidates: [q], text: longAsk, kind: "decision", answeredBy: null }],
		threads: [{ label: "Build arc snapshot so a Build survives appends during long Sessions", state: "active", progress: [{ text: longLeaf, quote: "Cap set to 64 MB.", citations: ["a2"] }] }],
	});
	// The owner turn u2 overtakes the ask in a1; titles apply to every ask list.
	const ask = [...c.needsYou, ...c.overtaken!].find((l) => l.citations[0]!.entryId === "a1")!;
	assert.equal(ask.text, "Choose whether the overtaken asks should go to the Needs…");
	assert.equal(ask.full, longAsk);
	assert.ok(ask.text.length <= TITLE_LIMITS.ask);
	assert.equal(c.threads[0]!.label, "Build arc snapshot so a Build survives…");
	assert.ok(c.threads[0]!.label.length <= TITLE_LIMITS.thread);
	const leaf = c.threads[0]!.progress[0]!;
	assert.ok(leaf.text.length <= TITLE_LIMITS.leaf && leaf.text.endsWith("…") && !leaf.text.endsWith(" …"), leaf.text);
	assert.ok(longLeaf.startsWith(leaf.text.slice(0, -1)), "cut at a word boundary of the original");
	assert.equal(leaf.full, longLeaf);
	assert.equal(build({ unassigned: { progress: [{ text: "Fixed the cap", quote: "Cap set to 64 MB.", citations: ["a2"] }] } }).unassigned.progress[0]!.full, undefined, "a short title keeps no full text");
	// An unlabelled candidate falls back to its own sentence, cut to the ask limit.
	const unlabelled = build({ asks: [] });
	const fallback = [...unlabelled.needsYou, ...unlabelled.overtaken!].find((l) => l.citations[0]!.entryId === "a2")!;
	assert.ok(fallback.text.length <= TITLE_LIMITS.ask, fallback.text);
});

test("arc context titles: a state written into a thread label moves out of it, and a decision leaf starts with Decided: (failure: state inside the label)", () => {
	const leaf = (text: string) => ({ text, quote: "Cap set to 64 MB.", citations: ["a2"] });
	const c = build({ threads: [
		{ label: "Done: Cache cap", state: "done", decisions: [leaf("Use LRU eviction"), leaf("Decided to cap at 64 MB"), leaf("Decision: no TTL")] },
		{ label: "Deploy to second Host (paused)", state: "paused" },
		{ label: "[active] Reader cache", state: "active" },
		{ label: "Release — done", state: "done" },
	] });
	assert.deepEqual(c.threads.map((t) => [t.label, t.state]), [["Cache cap", "done"], ["Deploy to second Host", "paused"], ["Reader cache", "active"], ["Release", "done"]]);
	assert.deepEqual(c.threads[0]!.decisions.map((l) => l.text), ["Decided: Use LRU eviction", "Decided: cap at 64 MB", "Decided: no TTL"]);
});

test("arc receipt head: per-kind open counts and stale inputs fit in 200 bytes", () => {
	// The largest head: every kind has an open ask, so every age is set and `fin` is absent.
	const now = new Map([...times].map(([id, t]) => [id, 1_792_000_000_000 + t!]));
	const four: RarebitItem[] = ["Should I pick A?", "May I deploy?", "Tell me if the alias changed.", "To unblock it, add disk."].map((text, i) => ({ id: ["u1", "a1", "u2", "a2"][i]!, kind: "stop", t: null, text }));
	const ev = new Map([["c0", four.map((i) => `[${i.id}] AGENT: ${i.text}`).join("\n")]]);
	const { candidates, owners } = askCandidates(four);
	const context = normalizeContext({ asks: candidates.map((c, i) => ({ candidates: [c.id], text: c.text, kind: ["decision", "approval", "input", "blocker"][i] })) }, chunks, ev, SESSION, now, "2026-10-19T00:00:00.000Z", "m", 4, "f".repeat(64), "a2", { texts: new Map(), candidates, owners });
	const sourceVersion = `2:2:${"e".repeat(64)}:123456789`;
	const head = headOf({ version: 4, sourceVersion, builtAt: context.builtAt, labels: {}, headline: "", projects: [], transitions: [], model: null, context });
	assert.deepEqual(head.open, [1, 1, 1, 1], "open follows NEEDS_YOU_KINDS order");
	assert.equal(head.n, 4);
	assert.ok(Buffer.byteLength(JSON.stringify(head)) <= 200, `head is ${Buffer.byteLength(JSON.stringify(head))} bytes`);
	assert.ok(head.old!.every((m) => m > 0) && !("fin" in head), "every kind dates its oldest ask; an open ask is never finished");
	const s = { data: { rarebit: { count: 4, fingerprint: context.rarebitFingerprint } } } as never;
	const projected = arcHead(s, head);
	assert.equal(projected.oldest.decision, head.old![0]! * 60_000);
	const v1 = arcHead(s, { v: 1, sv: "2:2:e", at: head.at, n: 4, fp: head.fp, open: head.open });
	assert.deepEqual([v1.built, v1.finished, Object.values(v1.oldest)], [true, false, [null, null, null, null]], "a v1 head still reads, with unknown ages");
});

test("arc context overtaken: a 'status?' turn overtakes an earlier ask, an agent restatement reopens it, and the head counts overtaken asks (failure: overtaken asks stayed in Needs you)", () => {
	const stop = (id: string, text: string): RarebitItem => ({ id, kind: "stop", t: null, text });
	const run: RarebitItem[] = [stop("a1", "Tests pass.\n\nShould I tag the release?"), { id: "u2", kind: "user", t: null, text: "status?" }, stop("a3", "The build is green.")];
	const evOf = (items: RarebitItem[]) => new Map([["c0", items.map((i) => `[${i.id}] ${i.kind === "user" ? "USER" : "AGENT"}: ${i.text.replace(/\n+/g, " ")}`).join("\n")]]);
	const at = new Map([["a1", 1_792_000_060_000], ["u2", 1_792_000_120_000], ["a3", 1_792_000_180_000], ["a4", 1_792_000_240_000]]);
	const ctx = (items: RarebitItem[], raw: unknown = {}, evidence = evOf(items)) => normalizeContext(raw, [chunks[0]!], evidence, SESSION, at, "2026-10-19T00:00:00.000Z", "m", items.length, "f".repeat(64), items.at(-1)!.id, { texts: new Map(), ...askCandidates(items) });
	const c = ctx(run);
	assert.deepEqual(c.needsYou, [], "the owner moved on without answering");
	assert.deepEqual(c.overtaken!.map((l) => [l.quote, l.closed, l.resolvedBy.map((x) => x.entryId), l.citations[0]!.at]), [["Should I tag the release?", "overtaken", ["u2"], 1_792_000_060_000]]);
	const head = headOf({ version: 4, sourceVersion: "v", builtAt: c.builtAt, labels: {}, headline: "", projects: [], transitions: [], model: null, context: c });
	assert.deepEqual([head.open, head.ov, "fin" in head], [[0, 0, 0, 0], 1, false]);
	assert.equal(arcHead({ data: { rarebit: { count: 3, fingerprint: c.rarebitFingerprint } } } as never, head).overtaken, 1);
	const reopened = ctx([...run, stop("a4", "Still waiting on you.\n\nShould I tag the release?")]);
	assert.deepEqual([reopened.needsYou.map((l) => l.citations[0]!.entryId), reopened.overtaken], [["a4"], []], "the agent restated the ask after the owner turn");
	const outside = ctx(run, {}, new Map([["c0", `[a1] AGENT: ${run[0]!.text.replace(/\n+/g, " ")}`]]));
	assert.deepEqual(outside.overtaken!.map((l) => l.resolvedBy), [[]], "an owner turn outside the build evidence still closes the ask, without a link");
});
