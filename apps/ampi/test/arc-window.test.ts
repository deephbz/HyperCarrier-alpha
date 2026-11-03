import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createConnection, createServer } from "node:net";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { boundedMessage, chapterWeight, constructArc, fingerprint, storeAnswer, validateAnswer, SYSTEM, WINDOW_TOKENS, CALL_INPUT_TOKENS, OPEN_TAIL_TOKENS, PREV_ARC_TOKENS } from "../src/arc/core/construct.ts";
import type { ArcSource } from "../src/arc/core/types.ts";
import type { ArcReceipt, BuildRecord } from "../src/shared/arc.ts";
const record = (): BuildRecord => ({ trigger: "manual", startedAt: "2026-01-01T00:00:00Z", endedAt: "", state: "done", calls: 0, windows: 0, model: "fixture/model", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, repairs: [] });
function source(count: number): ArcSource {
 const items = Array.from({ length: count }, (_, n) => ({ id: `e${n}`, kind: "user" as const, owner: n % 3 === 0, t: null, text: `Synthetic evidence ${n}: ` + "a\\\"\n".repeat(20) }));
 const entries = items.flatMap((item, n) => {
  const entry = { id: item.id, at: n % 17 ? new Date(Date.UTC(2026, 0, 1, 0, n * 7)).toISOString() : "invalid", tokens: n % 11, cost: n * .001 };
  return n < 600 ? [entry, { ...entry, id: `extra${n}` }] : [entry];
 });
 return { session: "fixture/pi:window", selector: "synthetic", items, entries, fingerprint: fingerprint(items) };
}
// Independent baseline: the original growing-prefix algorithm defines exact prompt bytes and cuts.
function legacyPrompt(s: ArcSource, previous?: ArcReceipt, limit = WINDOW_TOKENS) {
 const cursor = previous?.asOfCount ?? 0, current = previous;
 const prior = previous ? { chapters: previous.chapters.map(c => c.closed ? { n: c.n, label: c.label, firstId: c.firstId, scope: c.summary.scope.text } : c), points: previous.points.map(p => ({ id: p.id, kind: p.kind, state: p.state, by: p.by, title: p.title, firstCite: p.cites[0]?.id })) } : null;
 if (prior) {
  const settled = new Set(["done", "dropped", "accepted", "reversed", "lifted", "resolved"]);
  for (const point of previous!.points) {
   if (JSON.stringify(prior).length <= PREV_ARC_TOKENS * 4) break;
   if (settled.has(point.state) && previous!.chapters.find(c => c.n === point.chapter)?.closed) {
    const at = prior.points.findIndex(p => p.id === point.id); if (at >= 0) prior.points.splice(at, 1);
   }
  }
  if (JSON.stringify(prior).length > PREV_ARC_TOKENS * 4) return undefined;
 }
 const openStart = current?.chapters.at(-1)?.closed === false ? s.items.findIndex(i => i.id === current.chapters.at(-1)!.firstId) : cursor;
 let tail = s.items.slice(Math.max(0, openStart), cursor).map(boundedMessage), chars = 0, start = tail.length;
 while (start > 0 && chars + JSON.stringify(tail[start - 1]).length <= OPEN_TAIL_TOKENS * 4) chars += JSON.stringify(tail[--start]).length;
 const shortened = start > 0; tail = tail.slice(start);
 const make = (end: number) => JSON.stringify({ previous: prior, openChapterShortened: shortened, instruction: shortened ? "Close the long open chapter at a natural break; preserve its earlier facts from its full summary." : undefined, rarebits: [...tail, ...s.items.slice(cursor, end).map(boundedMessage)], weight: chapterWeight({ ...s, items: s.items.slice(0, end), entries: s.entries.slice(0, end < s.items.length ? s.entries.findIndex(e => e.id === s.items[end]!.id) : undefined) }, s.items[Math.max(0, openStart)]?.id, current) });
 let end = cursor, newChars = 0, prompt = "";
 while (end < s.items.length) {
  const size = JSON.stringify(boundedMessage(s.items[end]!)).length;
  if (newChars + size > limit * 4) break;
  const candidate = make(end + 1);
  if (SYSTEM.length + candidate.length + 2000 > CALL_INPUT_TOKENS * 4) break;
  prompt = candidate; newChars += size; end++;
 }
 if (end === cursor && cursor !== s.items.length) return undefined;
 return prompt || make(end);
}
async function firstPrompt(s: ArcSource, previous?: ArcReceipt, limit?: number) {
 let prompt: string | undefined;
 await assert.rejects(constructArc(s, previous, record(), async input => { prompt = input.prompt; throw Object.assign(new Error("capture"), { code: "busy" }); }, undefined, limit), e => ["busy", "source"].includes((e as {code: string}).code));
 return prompt;
}
test("Arc window: prompt bytes and boundaries match the baseline", async () => {
 for (const count of [0, 1, 8, 1808]) {
  const s = source(count);
  assert.equal(await firstPrompt(s), count ? legacyPrompt(s) : undefined);
 }
 const s = source(1), size = JSON.stringify(boundedMessage(s.items[0]!)).length;
 for (const limit of [0, size / 4, (size - 1) / 4]) assert.equal(await firstPrompt(s, undefined, limit), legacyPrompt(s, undefined, limit));
 const base = source(1000), claim = { text: "Review the evidence.", cites: [{ id: "e0", quote: base.items[0]!.text }] };
 const chapter = { firstId: "e0", label: "Reviewing the evidence", closed: false, summary: { scope: claim, bullets: [] } };
 const previous = storeAnswer({ goal: claim, now: claim, chapters: [chapter, { ...chapter, firstId: "e333" }], points: [] }, base, undefined, "2026-01-01T00:00:00Z", "fixture/model", []);
 previous.chapters[0]!.closed = true;
 for (const next of [base, source(1001), source(1808)]) assert.equal(await firstPrompt(next, previous), legacyPrompt(next, previous));
 previous.chapters.at(-1)!.firstId = "e0"; // The full open chapter exceeds the retained tail bound.
 assert.equal(await firstPrompt(source(1808), previous), legacyPrompt(source(1808), previous));
 previous.chapters.at(-1)!.closed = true;
 assert.equal(await firstPrompt(base, previous), legacyPrompt(base, previous));
});
test("Arc previous compaction: exact bytes, cuts and checkpoints match the baseline", async () => {
 const base = source(8), next = source(9), claim = { text: "Review evidence.", cites: [{ id: "e0", quote: base.items[0]!.text }] };
 const chapter = { firstId: "e0", label: "Reviewed evidence", closed: true, summary: { scope: claim, bullets: [] } };
 const receipt = storeAnswer({ goal: claim, now: claim, chapters: [chapter, { ...chapter, firstId: "e4", closed: false }], points: [] }, base, undefined, "2026-01-01T00:00:00Z", "fixture/model", []);
 const states = ["done", "dropped", "accepted", "reversed", "lifted", "resolved", "open"] as const;
 for (const count of [0, 1, 300, 1200]) {
  const previous = structuredClone(receipt);
  previous.points = Array.from({ length: count }, (_, i) => ({ id: `K${i}`, kind: "request", state: states[i % states.length]!, by: "owner", title: `Review ${i} ` + 'a\\"\n😀'.repeat(6), text: claim.text, cites: claim.cites, chapter: i % 5 === 0 ? 2 : 1, firstAt: "", stateAt: "", needsYou: false }));
  for (const limit of [0, 70, WINDOW_TOKENS]) assert.equal(await firstPrompt(next, previous, limit), legacyPrompt(next, previous, limit));
  // Duplicate IDs and chapter numbers preserve the original first-match behavior.
  if (count) {
   previous.points.at(-1)!.id = previous.points[0]!.id;
   previous.chapters.push({ ...previous.chapters[0]!, closed: false });
   assert.equal(await firstPrompt(next, previous), legacyPrompt(next, previous));
   previous.chapters.pop();
  }
  const checkpoint = structuredClone(previous), actual: ArcReceipt[] = [];
  const answer = { goal: claim, now: claim, chapters: [{ ...chapter, firstId: "e4", closed: false }], points: [] };
  const ask = async (input: { prompt: string }) => {
   assert.equal(input.prompt, legacyPrompt(next, previous));
   return { model: "fixture/model", text: JSON.stringify(answer), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } };
  };
  if (legacyPrompt(next, previous) !== undefined) {
   const original = await constructArc(next, previous, record(), ask, undefined, undefined, 1, r => { actual.push(structuredClone(r)); });
   const expected = { ...storeAnswer(validateAnswer(answer, next, next.items, checkpoint, []), next, checkpoint, original.builtAt, original.model, original.builds), drops: [], dismissedDrops: [] };
   assert.deepEqual(original, expected); assert.deepEqual(actual, [expected]);
  }
  assert.deepEqual(previous, checkpoint);
  if (count === 1200) {
   for (const point of previous.points) point.state = "open";
   assert.equal(legacyPrompt(next, previous), undefined);
   assert.equal(await firstPrompt(next, previous), undefined);
  }
 }
 // The exact bound retains a point; one extra character removes it.
 for (const extra of [0, 1]) {
  const previous = structuredClone(receipt);
  previous.points = [{ id: "K1", kind: "request", state: "done", by: "owner", title: "", text: claim.text, cites: claim.cites, chapter: 1, firstAt: "", stateAt: "", needsYou: false }];
  const prompt = JSON.parse(legacyPrompt(next, previous)!);
  previous.points[0]!.title = "x".repeat(PREV_ARC_TOKENS * 4 - JSON.stringify(prompt.previous).length + extra);
  assert.equal(await firstPrompt(next, previous), legacyPrompt(next, previous));
 }
});
test("Arc window: status answers within 100 ms during large prompt preparation", async t => {
 const server = createServer(socket => socket.on("data", () => socket.write('{"state":"running"}\n')));
 server.listen(0, "127.0.0.1"); await once(server, "listening");
 t.after(() => server.close());
 const socket = createConnection((server.address() as {port: number}).port, "127.0.0.1");
 t.after(() => socket.destroy()); await once(socket, "connect");
 const s = source(1808), response = once(socket, "data"), start = performance.now();
 socket.write("status\n");
 const building = firstPrompt(s);
 assert.match(String((await response)[0]), /running/);
 const elapsed = performance.now() - start;
 await building;
 t.diagnostic(`status during preparation: ${elapsed.toFixed(1)} ms`);
 assert.ok(elapsed < 100, `status took ${elapsed.toFixed(1)} ms; deadline is 100 ms`);
});
