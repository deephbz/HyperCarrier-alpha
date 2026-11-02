import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { answer, chapter, cite, claim, done, evidence, initial, point, setup } from "./arc-v2-fixture.ts";

// Contract: arc.md / Build / Input bound per call: 80k total, 20k tail, full previous open chapter.
// Detect an incremental input that grows with Session age instead of its bounded tail.
test("Arc v2: large first and incremental Builds keep every call under eighty thousand input tokens", async t => {
	const entries = Array.from({ length: 28 }, (_, i) => {
		const e = evidence(i === 0 ? "u1" : `large${i}`, i % 2 ? "assistant" : "user");
		return { ...e, text: `${e.text}\n${`BOUNDARY_${i}_`}`.padEnd(40_000, "x") };
	});
	const a = answer();
	a.chapters[0].summary.bullets = [claim("The open chapter retains an earlier fact.")];
	const h = await setup(t, { entries, steps: [{ answer: a }] });
	done(await h.build());
	const firstCalls = h.starts().length;
	assert.ok(firstCalls >= 5, "280k source tokens cannot fit one 60k window");
	const more = Array.from({ length: 8 }, (_, i) => evidence(`next${i}`, i % 2 ? "assistant" : "user", `NEW_BOUNDARY_${i}.`.padEnd(40_000, "y")));
	h.append(...more);
	await h.browser.until<any>(h.sid, v => v.stale === more.length);
	done(await h.build());
	const incremental = h.starts().slice(firstCalls);
	assert.ok(incremental.length >= 2, "new evidence overflows into more windows");
	for (const c of h.starts()) assert.ok((c.prompt!.length + c.system!.length) / 4 <= 80_000, "fixed instructions count toward the per-call bound");
	assert.ok(incremental[0]!.prompt!.includes("The open chapter retains an earlier fact."), "the previous open summary travels in full");
	assert.ok(!incremental[0]!.prompt!.includes("BOUNDARY_1_"), "old open-chapter evidence falls outside the tail");
	assert.ok(incremental[0]!.prompt!.includes("BOUNDARY_27_"), "the newest open-chapter evidence survives");
});

// Contract: arc.md / Build / Input bound per call: one message keeps first/last 6k, marked cut.
// Detect unbounded individual messages and citations fabricated from text omitted from the actual input.
test("Arc v2: a huge Rarebit keeps both ends, marks its cut, and cannot cite its omitted middle", async t => {
	const text = "VISIBLE_HEAD. " + "h".repeat(30_000) + " HIDDEN_MIDDLE_QUOTE. " + "t".repeat(30_000) + " VISIBLE_TAIL.";
	const a = answer({ goal: { text: "You requested synthetic work.", cites: [cite("u1", "VISIBLE_HEAD.")] }, chapters: [{ ...chapter(), summary: { scope: { text: "You requested synthetic work.", cites: [cite("u1", "VISIBLE_HEAD.")] }, bullets: [{ text: "Both ends are visible.", cites: [cite("u1", "VISIBLE_TAIL.")] }, { text: "The middle was omitted.", cites: [cite("u1", "HIDDEN_MIDDLE_QUOTE.")] }] } }], points: [] });
	a.now = a.goal;
	const h = await setup(t, { entries: [evidence("u1", "user", text), ...initial.slice(1)], steps: [{ answer: a }] });
	const r = done(await h.build());
	const input = h.starts()[0]!.prompt!;
	assert.ok(input.includes("VISIBLE_HEAD.")); assert.ok(input.includes("VISIBLE_TAIL."));
	assert.ok(!input.includes("HIDDEN_MIDDLE_QUOTE.")); assert.match(input, /cut|truncat|omitt/i);
	assert.equal(r.chapters[0].summary.bullets.length, 1);
	assert.equal(r.chapters[0].summary.bullets[0].text, "Both ends are visible.");
});

// Contract: arc.md / Validation and retry / cites on any active-branch Rarebit; unknown/kind-changed ID repair.
// Detect dropping carried citations solely because their evidence was compacted out of this call.
test("Arc v2: carried closed-chapter cites survive later Builds; unknown or kind-changed IDs become new points", async t => {
	const first = answer({ chapters: [chapter("u1", true), chapter("u2")], points: [point()] });
	const h = await setup(t, { steps: [{ answer: first }] });
	const r = done(await h.build()); const carried = r.points[0];
	h.append(evidence("u3")); await h.browser.until<any>(h.sid, v => v.stale === 1);
	h.plan([{ answer: first }, { answer: answer({ chapters: [chapter("u2")], points: [point({ id: carried.id }), point({ id: "K99999", kind: "decision", state: "confirm", by: "agent", waits: undefined, title: "Agent chose the parser", cites: [cite("a1")] }), point({ id: carried.id, kind: "rule", state: "in force", waits: undefined, title: "Keep the source private" })] }) }]);
	const next = done(await h.build());
	assert.equal(h.starts().length, 2, "ID repairs do not reject the answer");
	assert.deepEqual(next.points.find((p: any) => p.id === carried.id), carried);
	assert.deepEqual(next.chapters[0], r.chapters[0]);
	assert.equal(next.points.length, 3);
	assert.equal(new Set(next.points.map((p: any) => p.id)).size, 3);
	assert.ok(next.points.every((p: any) => p.id !== "K99999"));
	assert.ok(next.builds.some((b: any) => b.repairs.length > 0));
});

// Contract: arc.md / Build / Output bound: quotes at most 200 characters.
// Detect unbounded copied source text even when the quotation is verbatim.
test("Arc v2: a verbatim quote above two hundred characters is an answer failure", async t => {
	const text = initial[0]!.text + " z".repeat(140);
	const a = answer(); a.goal.cites = [cite("u1", text.slice(0, 201))];
	const h = await setup(t, { entries: [evidence("u1", "user", text), ...initial.slice(1)], steps: [{ answer: a }, { answer: answer() }] });
	done(await h.build()); assert.equal(h.starts().length, 2);
});

// Contract: arc.md / Answer shape / STATES and recall floor; Receipt / Overview head.
// Detect unsupported blocked state and agent questions incorrectly requiring owner-message evidence.
test("Arc v2: blocked requests and agent questions contribute to Needs you", async t => {
	const points = [point({ state: "blocked" }), point({ by: "agent", title: "Choose the release time", cites: [cite("a2")] }), point({ state: "blocked", waits: "agent" })];
	const h = await setup(t, { steps: [{ answer: answer({ points }) }] });
	const r = done(await h.build());
	assert.deepEqual(r.points.map((p: any) => p.needsYou), [true, true, false]);
	assert.equal(r.points[1].by, "agent");
	await h.browser.until<any>(h.threads, v => v.threads["pi:sess-a"].arc?.needsYou === 2);
});

// Contract: arc.md / Answer shape / recall floor: omitted question in newest agent stop.
// Detect silent loss of an owner-facing question when the model omits it; avoid duplicate fallback items.
test("Arc v2: recall floor recovers an omitted final question exactly once", async t => {
	const entries = [...initial.slice(0, 3), evidence("a2", "assistant", "Which release time should I use?")];
	const h = await setup(t, { entries, steps: [{ answer: answer({ points: [] }) }] });
	const r = done(await h.build());
	const floor = r.points.filter((p: any) => p.needsYou);
	assert.equal(floor.length, 1); assert.equal(floor[0].title, "Unanswered question in the last reply");
	assert.ok(floor[0].cites.some((c: any) => c.id === "a2"));
	h.plan([{ answer: answer({ points: [] }) }, { answer: answer({ points: [point({ id: floor[0].id, by: "agent", title: "Choose the release time", cites: [cite("a2", entries[3]!.text)] })] }) }]);
	const next = done(await h.build());
	assert.equal(next.points.filter((p: any) => p.needsYou).length, 1, "a cited question suppresses a second fallback");
});
