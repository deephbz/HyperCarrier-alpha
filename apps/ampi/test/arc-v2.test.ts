import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ask } from "../src/pi/ask.ts";
import { arcSettings } from "../src/shared/pi-config.ts";
import { constructArc, fingerprint, storeAnswer, validateAnswer, type ArcSource } from "../src/arc/core/construct.ts";
import type { ArcAnswer, BuildRecord } from "../src/shared/arc.ts";
import { selectTierB } from "../src/pi/rarebit-selection.ts";
const MODEL = "fixture/model";
const command = [process.execPath, fileURLToPath(new URL("./fixtures/arc-model.cjs", import.meta.url))];
const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
function source(n = 8): ArcSource {
 const items = Array.from({ length: n }, (_, i) => ({ id: `e${i}`, kind: i % 2 ? "stop" as const : "user" as const, owner: i % 2 === 0, text: `Synthetic evidence ${i}.`, t: at(i) }));
 return { session: "fixture/pi:one", selector: "test-1", fingerprint: fingerprint(items), items, entries: items.map((i, n) => ({ id: i.id, at: i.t, tokens: n % 2 ? 170 : 0, cost: n % 2 ? .25 : 0 })) };
}
const record = (): BuildRecord => ({ trigger: "manual", startedAt: at(0), endedAt: at(1), state: "done", calls: 0, windows: 0, model: MODEL, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, repairs: [] });
const answer = (s: ArcSource): ArcAnswer => {
 const claim = { text: "Review the work.", cites: [{ id: s.items[0]!.id, quote: s.items[0]!.text }] };
 return { goal: claim, now: claim, chapters: [{ firstId: s.items[0]!.id, label: "Reviewing the current work", closed: false, summary: { scope: claim, bullets: [claim] } }], points: [] };
};
test("Arc: offline askCommand builds windows, freezes chapters, carries point IDs, and sums exact spend", async () => {
 const s = source(), r = record();
 const receipt = await constructArc(s, undefined, r, req => ask(req, command), undefined, 110);
 assert.ok(r.windows > 1); assert.equal(receipt.asOfCount, 8); assert.equal(receipt.chapters.reduce((n,c) => n + c.cost, 0), 1);
 assert.equal(receipt.chapters.reduce((n,c) => n + c.tokens, 0), 680);
 const next = source(10), run = record();
 const updated = await constructArc(next, receipt, run, req => ask(req, command));
 assert.deepEqual(updated.chapters.slice(0, receipt.chapters.length), receipt.chapters);
 assert.deepEqual(updated.points.slice(0, receipt.points.length), receipt.points);
 assert.equal(run.windows, 1); assert.equal(updated.chapters.at(-1)!.cost, .25);
});
// Contract: arc.md / View: progress names the whole job, and its part estimate never falls below the current part.
test("Arc: progress reports message range, part of estimated parts and try", async () => {
 const s = source(), works: any[] = [], replies = ["invalid"];
 await constructArc(s, undefined, record(), req => replies.length ? Promise.resolve({ text: replies.shift()!, model: MODEL }) : ask(req, command), (_text, work) => { if (work) works.push(work); }, 110);
 assert.ok(works.length > 2);
 assert.deepEqual([works[0].from, works[0].part, works[0].attempt], [1, 1, 1]);
 assert.equal(works[1].attempt, 2); assert.match(works[1].reason, /JSON/);
 assert.ok(works.every(w => w.parts >= w.part && w.to <= w.total && w.from <= w.to && w.attempts === 3));
 assert.equal(works.at(-1).to, s.items.length);
 for (let i = 1; i < works.length; i++) if (works[i].part > works[i - 1].part) assert.equal(works[i].from, works[i - 1].to + 1, "windows are consecutive");
});
test("Arc: each call allows five minutes while retaining the output cap", async () => {
 const requests: { timeoutMs?: number; maxOutputTokens?: number }[] = [];
 await constructArc(source(), undefined, record(), async req => {
  requests.push(req);
  return { text: requests.length === 1 ? "invalid" : JSON.stringify(answer(source())), model: MODEL };
 });
 assert.deepEqual(requests.map(r => [r.timeoutMs, r.maxOutputTokens]), [[300_000, 16000], [300_000, 16000]]);
});
test("Arc: sixteen-thousand-token answers fit, while truncation and oversized answers still retry", async () => {
 // Unknown fields are ignored, so they pad the answer between the old and new caps.
 const s = source(), a = { ...answer(s), padding: "Synthetic progress. ".repeat(2000) };
 const receipt = await constructArc(s, undefined, record(), async () => ({ text: JSON.stringify(a), model: MODEL }));
 assert.equal(receipt.now.text, a.now.text, "answers between the old and new caps are accepted");
 for (const result of [{ text: JSON.stringify(a), model: MODEL, truncated: true }, { text: "x".repeat(64_001), model: MODEL }]) {
  const r = record();
  await assert.rejects(constructArc(s, undefined, r, async () => result), { code: "answer" });
  assert.equal(r.calls, 3);
 }
});
// Contract: arc.md / Incremental by default / Chapter grain: chapter cuts are judgement, with no count rule.
test("Arc: chapter cuts follow judgement, and the Build record counts new chapters per window without a repair", async () => {
 const s = source(), a = answer(s), r = record();
 a.chapters = s.items.slice(0, 7).map((item, i) => ({ ...a.chapters[0]!, firstId: item.id, closed: i !== 6 }));
 const receipt = await constructArc(s, undefined, r, async req => {
  assert.doesNotMatch(req.system, /new chapters per/);
  assert.match(req.system, /Start a new chapter where the work.s goal or theme changes/);
  assert.match(req.system, /approval or a single check stays in the chapter where it happened/);
  return { text: JSON.stringify(a), model: MODEL };
 });
 assert.equal(r.calls, 1); assert.equal(receipt.chapters.length, 7);
 assert.deepEqual(r.newChapters, [7]); assert.deepEqual(r.repairs, []);
});
test("Arc: a point without required waits is dropped, and the stored point stays", () => {
 for (const state of ["open", "in progress", "blocked"]) {
  const invalid = answer(source()), repairs: string[] = [];
  invalid.points = [{ kind: "request", state, by: "agent", title: "Check the next step", text: "Open: check the step.", cites: invalid.now.cites }];
  assert.equal(validateAnswer(invalid, source(), source().items, undefined, repairs).points.length, 0);
  assert.ok(repairs.some(note => /Dropped point Check the next step:.*waits/.test(note)));
 }
 const s = source(), first = answer(s);
 first.points = [{ kind: "confusion", state: "open", by: "agent", waits: "owner", title: "Check the next step", text: "Open: check the step.", cites: first.now.cites }];
 const base = storeAnswer(validateAnswer(first, s, s.items, undefined, []), s, undefined, at(8), MODEL, []);
 const edit = answer(s); edit.points = [{ ...base.points[0]!, waits: undefined }];
 const kept = storeAnswer(validateAnswer(edit, s, s.items, base, []), s, base, at(9), MODEL, []);
 assert.deepEqual(kept.points[0], base.points[0], "a dropped edit keeps the stored point");
});
// Contract: arc.md / Validation and retry: boundaries code owns, and closed chapters never cover new messages.
test("Arc: boundary repair moves only the first new chapter and never advances over unread messages", async () => {
 const s = source(), first = answer(s);
 first.chapters = [{ ...first.chapters[0]!, closed: true }];
 const previous = storeAnswer(first, { ...s, items: s.items.slice(0, 4), entries: s.entries.slice(0, 4), fingerprint: fingerprint(s.items.slice(0, 4)) }, undefined, at(9), MODEL, []);
 const claim = { text: "Review e5.", cites: [{ id: "e5", quote: "Synthetic evidence 5." }] };
 const snap = { ...answer(s), now: claim, chapters: [{ firstId: "e6", label: "Later work", closed: false, summary: { scope: claim, bullets: [] } }] }, repairs: string[] = [];
 assert.deepEqual(validateAnswer(snap, s, s.items, previous, repairs).chapters.map(c => c.firstId), ["e4"]);
 assert.ok(repairs.includes("Moved the first chapter start from e6 to e4"));
 const frozenOnly = { ...snap, chapters: [first.chapters[0]] };
 assert.throws(() => validateAnswer(frozenOnly, s, s.items, previous, []), /No chapter covers the new messages/);
 const inside = { ...snap, chapters: [{ ...snap.chapters[0]!, firstId: "e1" }, { ...snap.chapters[0]!, firstId: "e4" }] };
 assert.deepEqual(validateAnswer(inside, s, s.items, previous, []).chapters.map(c => c.firstId), ["e4"], "a later chapter at the boundary is dropped, not duplicated");
 // An explicit Build without new messages after a closed chapter keeps the stored chapters.
 const head = { ...s, items: s.items.slice(0, 4), entries: s.entries.slice(0, 4), fingerprint: previous.fingerprint };
 assert.deepEqual(validateAnswer({ ...answer(s), chapters: [] }, head, head.items, previous, []).chapters, []);
});
// Contract: arc.md / Validation and retry: an uncited Now retries first; only the last try keeps the previous Now.
test("Arc: an uncited now retries before the previous now is kept and marked", async () => {
 const s = source(4), previous = await constructArc(s, undefined, record(), async () => ({ text: JSON.stringify(answer(s)), model: MODEL }));
 const next = source(), uncited = { ...answer(next), now: { text: "Unsupported.", cites: [{ id: "e9", quote: "missing" }] } };
 const replies = [uncited, uncited, uncited], r = record();
 const receipt = await constructArc(next, previous, r, async () => ({ text: JSON.stringify(replies.shift()), model: MODEL }));
 assert.equal(r.calls, 3); assert.deepEqual(receipt.now, previous.now); assert.deepEqual(receipt.kept, ["now"]);
 const fixed = await constructArc(source(10), receipt, record(), async () => ({ text: JSON.stringify(answer(source(10))), model: MODEL }));
 assert.equal(fixed.kept, undefined, "the next Build that updates Now clears the mark");
});
// Contract: arc.md / Validation and retry: a dropped update keeps the complete stored point, marked as kept.
test("Arc: a rejected point update keeps the stored point and records it as kept", async () => {
 const s = source(4), a = answer(s);
 a.points = [{ kind: "request", state: "open", by: "agent", waits: "owner", title: "Check the next step", text: "Open: check the step.", cites: a.now.cites }];
 const previous = await constructArc(s, undefined, record(), async () => ({ text: JSON.stringify(a), model: MODEL }));
 const stored = previous.points[0]!, next = source(), b = answer(next);
 b.points = [{ id: stored.id, kind: "request", state: "imaginary", by: "agent", title: "Check", text: "Bad.", cites: b.now.cites }];
 const receipt = await constructArc(next, previous, record(), async () => ({ text: JSON.stringify(b), model: MODEL }));
 assert.deepEqual(receipt.points.find(p => p.id === stored.id), stored); assert.deepEqual(receipt.kept, [stored.id]);
 const later = await constructArc(source(10), receipt, record(), async () => ({ text: JSON.stringify(answer(source(10))), model: MODEL }));
 assert.deepEqual(later.kept, [stored.id], "a Build that omits the point does not clear its mark");
 const updated = answer(source(12)); updated.points = [{ ...a.points[0]!, id: stored.id, state: "done", cites: [{ id: "e10", quote: "Synthetic evidence 10." }] }];
 const fixed = await constructArc(source(12), later, record(), async () => ({ text: JSON.stringify(updated), model: MODEL }));
 assert.equal(fixed.kept, undefined, "an update clears the mark");
});
// Contract: arc.md / Validation and retry: invalid cites are dropped before the three-cite limit applies.
test("Arc: a valid fourth cite survives three invalid cites, and an owner cite stays inside the three", () => {
 const s = source(), a = answer(s), repairs: string[] = [];
 a.goal = { text: "Review the work.", cites: [{ id: "x1", quote: "no" }, { id: "x2", quote: "no" }, { id: "x3", quote: "no" }, a.goal.cites[0]!] };
 assert.deepEqual(validateAnswer(a, s, s.items, undefined, repairs).goal.cites, a.goal.cites.slice(3));
 // Three agent cites before the only owner cite: the owner cite stays inside the three.
 const agent = (n: number) => ({ id: `e${n}`, quote: `Synthetic evidence ${n}.` });
 a.points = [{ kind: "rule", state: "in force", by: "owner", title: "Keep the synthetic rule", text: "Keep it.", cites: [agent(1), agent(3), agent(5), { id: "e2", quote: "Synthetic evidence 2." }] }];
 assert.deepEqual(validateAnswer(a, s, s.items, undefined, []).points[0]!.cites.map(c => c.id), ["e1", "e3", "e2"]);
});
test("Arc: unusable answers retry up to the retries setting, model errors never retry immediately", async () => {
 let calls = 0;
 await assert.rejects(constructArc(source(), undefined, record(), async () => { calls++; return { text: "bad", model: MODEL }; }), { code: "answer" });
 assert.equal(calls, 3, "default retries 2 give three calls"); calls = 0;
 await assert.rejects(constructArc(source(), undefined, record(), async () => { calls++; return { text: "bad", model: MODEL }; }, undefined, undefined, undefined, undefined, 0), { code: "answer" });
 assert.equal(calls, 1, "retries 0 gives one call"); calls = 0;
 const fenced = await constructArc(source(), undefined, record(), async () => { calls++; return { text: `Here is the Arc:\n\`\`\`json\n${JSON.stringify(answer(source()))}\n\`\`\``, model: MODEL }; });
 assert.equal(calls, 1, "prose or a fence around the JSON object is not a defect"); assert.ok(fenced.chapters.length); calls = 0;
 await assert.rejects(constructArc(source(), undefined, record(), async () => { calls++; throw new Error("quota"); }), { code: "model" }); assert.equal(calls, 1);
 await assert.rejects(constructArc(source(), undefined, record(), async () => ({ text: "{}", model: "other/model" })), { code: "model" });
});
test("Arc: citation repair, owner provenance, point ID repair, bullet bounds and state-change proof", () => {
 const s = source(), a = answer(s), repairs: string[] = [];
 a.chapters[0]!.summary.bullets.push({ text: "Invented.", cites: [{ id: "outside", quote: "no" }] });
 a.points = [{ kind: "rule", by: "owner", state: "in force", title: "Keep the limits", text: "Keep the limit.", cites: [{ id: "e1", quote: s.items[1]!.text }] }];
 const valid = validateAnswer(a, s, s.items, undefined, repairs);
 assert.equal(valid.points.length, 0); assert.equal(valid.chapters[0]!.summary.bullets.length, 1); assert.ok(repairs.length >= 3);
 const nested = answer(s), bullet = nested.chapters[0]!.summary.bullets[0]!;
 bullet.children = [{ ...bullet, children: [{ ...bullet, children: [{ ...bullet }] }] }];
 const nestedRepairs: string[] = [];
 assert.equal(validateAnswer(nested, s, s.items, undefined, nestedRepairs).chapters[0]!.summary.bullets[0]!.children![0]!.children![0]!.children, undefined);
 assert.ok(nestedRepairs.includes("Dropped bullets past depth 3"));
 const base = storeAnswer(valid, s, undefined, at(8), MODEL, []);
 const changed = answer(s); changed.points = [{ id: "unknown", kind: "decision", state: "confirm", by: "agent", title: "Choose the next step", text: "Choose a step.", cites: [{ id: "e1", quote: s.items[1]!.text }] }];
 const normalized = validateAnswer(changed, s, s.items.slice(-1), base, []);
 assert.equal(normalized.points[0]!.id, undefined);
 const withPoint = storeAnswer(normalized, s, base, at(9), MODEL, []);
 changed.points = [{ ...withPoint.points[0]!, state: "accepted" }];
 const unproven: string[] = [];
 assert.equal(validateAnswer(changed, s, s.items, withPoint, unproven).points.length, 0, "an unproven state change is dropped; the stored point stays");
 assert.ok(unproven.some(note => /supporting citation/.test(note)));
 const lost = answer(s); lost.goal = { text: "Uncited.", cites: [] }; const kept: string[] = [];
 assert.deepEqual(validateAnswer(lost, s, s.items, withPoint, kept).goal, withPoint.goal); assert.ok(kept.includes("Kept the previous goal"));
 assert.throws(() => validateAnswer(lost, s, s.items, undefined, []), /Goal and now/, "a first Build has no previous goal to keep");
});
test("Arc settings: stamp reload applies edits and malformed settings fail before a model call", t => {
 const dir = mkdtempSync(join(tmpdir(), "arc-settings-")); t.after(() => rmSync(dir, { recursive: true, force: true })); const file = join(dir, "settings.json");
 assert.equal(arcSettings(file).model, "anthropic/claude-haiku-5-5");
 writeFileSync(file, JSON.stringify({ ampi_arc: { model: "magpie/claude/test", auto: false } }));
 assert.deepEqual(arcSettings(file), { model: "magpie/claude/test", auto: false, retries: 2 });
 writeFileSync(file, JSON.stringify({ ampi_arc: { retries: 6 } })); assert.throws(() => arcSettings(file), e => String(e).includes("ampi_arc.retries"));
 writeFileSync(file, JSON.stringify({ ampi_arc: { model: "bare" } })); assert.throws(() => arcSettings(file), e => String(e).includes(file) && String(e).includes("ampi_arc.model"));
});
// Builder persistence, checkpoint recovery and admission now run at the Host.
// arc-core.test.ts and arc-service-runtime.test.ts verify those owning boundaries.
test("Tier-b selection excludes relay and injected user messages and retains direct owner provenance", () => {
 for (const text of ["[agent] Do work", "# Rarebit Recall\nRemember", "ptb.task-update: a task"]) {
  assert.equal(selectTierB({ type: "message", id: "u", message: { role: "user", content: text } }, { id: "u", kind: "human" } as any).item, null);
 }
 const selected = selectTierB({ type: "message", id: "u", message: { role: "user", content: "Please continue" } }, { id: "u", kind: "human" } as any).item;
 assert.equal(selected?.owner, true);
});
