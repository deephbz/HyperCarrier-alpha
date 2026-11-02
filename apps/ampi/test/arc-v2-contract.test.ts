import "./bound.ts";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { answer, chapter, cite, claim, DEFAULT_MODEL, done, evidence, initial, point, setup, sleep, T, waitFor } from "./arc-v2-fixture.ts";

// Contract: arc.md / Build / Incremental by default, First Build; Receipt.
// Detect lost windows, oversized calls, early partial publication, and missing receipt custody.
test("Arc v2: first Build folds two message-boundary windows and stores only the final result", async t => {
	const entries = Array.from({ length: 20 }, (_, i) => { const e = evidence(`${i % 2 ? "a" : "u"}${Math.floor(i / 2) + 1}`, i % 2 ? "assistant" : "user"); return { ...e, text: e.text.padEnd(22_000, "x") }; });
	const first = answer({ chapters: [chapter("u1", true)], points: [point()] });
	const second = answer({ now: claim("The second window completed.", "u6"), chapters: [chapter("u6")], points: [] });
	const h = await setup(t, { entries, steps: [{ answer: first }, { answer: second }] });
	assert.equal(h.starts().length, 0, "opening a receipt does not call the model");
	const gate = h.gate("last-window-release");
	h.plan([{ answer: first }, { answer: second, gate }]);
	const building = h.build();
	await waitFor(() => h.starts().length === 2, "second window held");
	assert.equal(h.value().receipt, undefined, "an intermediate window is not published as a receipt");
	h.release(gate);
	const r = done(await building);
	assert.equal(h.starts().length, 2);
	const [a, b] = h.starts();
	assert.ok(a!.prompt!.includes("Synthetic evidence u1."));
	assert.ok(!a!.prompt!.includes("Synthetic evidence u6."), "the first window cannot see future messages");
	assert.ok(b!.prompt!.includes("Synthetic evidence u6."));
	assert.ok(b!.prompt!.includes("Completed synthetic work"), "the next window receives the previous Arc");
	assert.equal(r.asOf, "a10"); assert.equal(r.asOfCount, 20);
	assert.equal(r.tier, "b"); assert.ok(r.selector);
	assert.equal(r.v, 1); assert.equal(r.session, "devbox/pi:sess-a");
	assert.equal(r.model, DEFAULT_MODEL); assert.ok(r.promptVersion); assert.ok(r.fingerprint);
	assert.equal(r.chapters.length, 2); assert.equal(r.now.text, second.now.text);
	assert.deepEqual(r.chapters.map((c: any) => [c.n, c.firstId, c.lastId]), [[1, "u1", "a5"], [2, "u6", "a10"]]);
	assert.equal(r.builds.length, 1); assert.equal(r.builds[0].windows, 2); assert.equal(r.builds[0].calls, 2);
	assert.equal(r.builds[0].trigger, "manual");
	const files: string[] = [];
	function walk(dir: string) { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".json") && dir.endsWith("/arc")) files.push(p); } }
	walk(h.f.dir);
	assert.equal(files.length, 1, "one private receipt per Session");
	assert.deepEqual(JSON.parse(readFileSync(files[0]!, "utf8")), r);
});

// Contract: arc.md / Build / Closed chapters are frozen; Key points carry across versions; Full rebuild.
// Detect model rewrites of closed history, lost omitted points, reused IDs, and a rebuild that stays incremental.
test("Arc v2: incremental Build restores frozen chapters, preserves omitted points, and carries point IDs", async t => {
	const first = answer({ chapters: [chapter("u1", true), chapter("u2")], points: [point(), point({ kind: "rule", state: "in force", waits: undefined, title: "Keep the source private" })] });
	const h = await setup(t, { steps: [{ answer: first }] });
	const before = done(await h.build());
	const id = before.points[0].id, omitted = before.points[1];
	h.append(evidence("u3"), evidence("a3", "assistant"));
	await h.browser.until<any>(h.threads, v => v.threads["pi:sess-a"]);
	await h.browser.until<any>(h.sid, v => v.stale === 2);
	const rewritten = chapter("u1", true); rewritten.label = "Changed frozen chapter";
	h.plan([{ answer: first }, { answer: answer({ chapters: [rewritten, chapter("u2")], points: [point({ id, state: "done", waits: undefined, text: "Done: the owner chose the next step.", cites: [cite("u3")] }), point({ kind: "decision", state: "confirm", by: "agent", waits: undefined, title: "Agent chose the parser", cites: [cite("a3")] })] }) }, { answer: answer() }]);
	const after = done(await h.build());
	assert.equal(h.starts().length, 2, "an ordinary incremental Build uses one call");
	assert.deepEqual(after.chapters[0], before.chapters[0]);
	assert.ok(after.builds.some((b: any) => b.repairs.length > 0), "closed-chapter restoration is visible");
	assert.equal(after.points.find((p: any) => p.id === id).state, "done");
	assert.deepEqual(after.points.find((p: any) => p.id === omitted.id), omitted);
	const fresh = after.points.find((p: any) => p.kind === "decision");
	assert.match(fresh.id, /^K\d+$/); assert.ok(!before.points.some((p: any) => p.id === fresh.id));
	assert.equal(after.asOf, "a3"); assert.equal(after.asOfCount, 6);
	assert.ok(h.starts()[1]!.prompt!.includes(id), "the model receives previous point IDs");
	const rebuilt = done(await h.build(true));
	assert.equal(rebuilt.builds.at(-1).trigger === "rebuild" || rebuilt.builds[0].trigger === "rebuild", true);
	assert.equal(rebuilt.chapters.length, 1, "full rebuild does not restore the old frozen chapter");
});

// Contract: arc.md / Validation and retry, citation repair and owner evidence.
// Detect fabricated IDs/quotes, cross-Session evidence, and owner claims supported only by the agent.
test("Arc v2: invalid citations and unsupported points are removed; normalized verbatim quotes survive", async t => {
	const entries = [evidence("u1", "user", "The **owner** chose\n the parser."), ...initial.slice(1)];
	const good = cite("u1", "the owner chose the parser.");
	const a = answer({ goal: { text: "The owner chose the parser.", cites: [good] }, now: claim("The agent completed work.", "a1"), chapters: [{ ...chapter(), summary: { scope: { text: "The owner chose the parser.", cites: [good] }, bullets: [
		{ text: "Keep one valid citation.", cites: [good, cite("missing"), cite("a1", "An invented quotation.")] },
		{ text: "Drop the invented claim.", cites: [cite("missing")] },
	] } }], points: [point({ cites: [good] }), point({ title: "Keep unsupported owner rule", kind: "rule", state: "in force", cites: [cite("a1")] }), point({ title: "Choose fabricated evidence", cites: [cite("foreign")] }), point({ title: "Choose invented quote", cites: [cite("u1", "The owner approved deployment.")] })] });
	const h = await setup(t, { entries, steps: [{ answer: a }] });
	h.writeSession("foreign-session", [evidence("foreign")]);
	const r = done(await h.build());
	assert.equal(h.starts().length, 1, "repair does not require an answer retry");
	assert.equal(r.points.length, 1); assert.deepEqual(r.points[0].cites, [good]);
	assert.equal(r.chapters[0].summary.bullets.length, 1);
	assert.deepEqual(r.chapters[0].summary.bullets[0].cites, [good]);
	assert.ok(r.builds[0].repairs.length > 0);
});

// Contract: arc.md / Chapter summary: fixed structure, adaptive length; Validation and retry.
// Detect unbounded lists and acceptance of depth/text overflow that code cannot repair.
test("Arc v2: oversized bullet lists repair at eight roots and six children", async t => {
	const roots = Array.from({ length: 10 }, (_, i) => ({ ...claim(`Root ${i} has evidence.`), children: Array.from({ length: 9 }, (_, j) => claim(`Child ${j} has evidence.`)) }));
	const a = answer(); a.chapters[0].summary.bullets = roots;
	const h = await setup(t, { steps: [{ answer: a }] });
	const r = done(await h.build());
	assert.equal(r.chapters[0].summary.bullets.length, 8);
	assert.ok(r.chapters[0].summary.bullets.every((b: any) => b.children.length === 6));
	assert.ok(r.builds[0].repairs.length > 0);
});

for (const [name, mutate, check] of [
	["depth four", (a: any) => { a.chapters[0].summary.bullets = [{ ...claim(), children: [{ ...claim(), children: [{ ...claim(), children: [claim()] }] }] }]; },
		(r: any) => assert.equal(r.chapters[0].summary.bullets[0].children[0].children[0].children, undefined)],
	["bullet above 600 characters", (a: any) => { a.chapters[0].summary.bullets[0].text = "word ".repeat(130); },
		(r: any) => assert.equal(r.chapters[0].summary.bullets.length, 0)],
	["point text above 600 characters", (a: any) => { a.points[0].text = "word ".repeat(130); }, (r: any) => assert.equal(r.points.length, 0)],
	["invalid state", (a: any) => { a.points[0].state = "imaginary"; }, (r: any) => assert.equal(r.points.length, 0)],
	["four cites on one claim", (a: any) => { a.goal.cites = [cite("u1"), cite("u2"), cite("a1"), cite("a2")]; }, (r: any) => assert.equal(r.goal.cites.length, 3)],
	["thirteen-word title", (a: any) => { a.points[0].title = "word ".repeat(13); }, (r: any) => assert.equal(r.points.length, 0)],
	["thirteen-word chapter label", (a: any) => { a.chapters = [chapter("u1", true), { ...chapter("u2"), label: "word ".repeat(13) }]; },
		(r: any) => assert.deepEqual(r.chapters.map((c: any) => [c.firstId, c.closed]), [["u1", true]])],
	["reversed chapter order", (a: any) => { a.chapters = [chapter("u2", true), chapter("u1")]; },
		(r: any) => assert.deepEqual(r.chapters.map((c: any) => c.firstId), ["u1"])],
] as const) {
	// Contract: arc.md / Validation and retry: code repairs a local defect at its item; only an unusable answer retries.
	// Detect local defects that cost a model call, or invalid items reaching storage.
	test(`Arc v2: ${name} is repaired by code without a retry`, async t => {
		const invalid = answer(); mutate(invalid);
		const h = await setup(t, { steps: [{ answer: invalid }] });
		const r = done(await h.build());
		assert.equal(h.starts().length, 1); assert.equal(r.builds[0].calls, 1);
		assert.ok(r.builds[0].repairs.length > 0, "the repair is recorded");
		check(r);
	});
}

// Contract: arc.md / Validation and retry: word and length targets guide the model; code never cuts stored text.
test("Arc v2: long text under the caps is stored unchanged", async t => {
	const a = answer(), title = "Choose the next step for the remaining release work", bullet = "word ".repeat(60).trim();
	a.points[0].title = title; a.chapters[0].summary.bullets[0].text = bullet;
	const h = await setup(t, { steps: [{ answer: a }] });
	const r = done(await h.build());
	assert.equal(r.points[0].title, title); assert.equal(r.chapters[0].summary.bullets[0].text, bullet);
	assert.deepEqual(r.builds[0].repairs, []);
});

// Contract: arc.md / Validation and retry: an answer that is not JSON retries with its reasons appended.
test("Arc v2: an unusable answer retries with its reasons", async t => {
	const h = await setup(t, { steps: [{ raw: "not JSON" }, { answer: answer() }] });
	const r = done(await h.build());
	assert.equal(h.starts().length, 2); assert.equal(r.builds[0].calls, 2);
	assert.notEqual(h.starts()[1]!.prompt, h.starts()[0]!.prompt, "retry appends validation reasons");
});

// Contract: arc.md / Model and settings: ampi_arc.retries bounds the calls per window.
test("Arc v2: retries 0 makes one call per window and fails without a second", async t => {
	const h = await setup(t, { arc: { auto: false, retries: 0 }, steps: [{ raw: "not JSON" }, { answer: answer() }] });
	const v = await h.build();
	assert.equal(v.status.state, "failed"); assert.equal(v.status.error?.code, "answer");
	assert.equal(h.starts().length, 1);
	assert.equal(v.status.nextAt, undefined, "with automatic Builds off, no retry time shows");
});

// Contract: arc.md / Validation and retry: default retries 2 give three calls; a rejected answer preserves the receipt.
test("Arc v2: three invalid answers fail once and retain the last good Arc", async t => {
	const h = await setup(t, { steps: [{ answer: answer() }, { raw: "not JSON" }] });
	const before = done(await h.build());
	const v = await h.build();
	assert.equal(v.status.state, "failed"); assert.equal(v.status.error?.code, "answer");
	assert.equal(h.starts().length, 4, "one good call plus three answer attempts");
	assert.equal(v.receipt.asOf, before.asOf); assert.deepEqual(v.receipt.chapters, before.chapters);
	await sleep(150); assert.equal(h.starts().length, 4, "no fourth answer attempt");
});

// Contract: arc.md / Model and settings: default model, exact provider/modelId, hot settings reload, invalid key errors.
// Detect fuzzy model selection, stale settings stamps, and invalid settings causing a model call.
test("Arc v2: default and literal model settings apply at each Build; invalid settings fail before ask", async t => {
	const h = await setup(t, { omitSettings: true });
	done(await h.build()); assert.equal(h.starts()[0]!.model, DEFAULT_MODEL);
	h.setSettings({ model: "synthetic/provider/model", auto: false });
	const r = done(await h.build()); assert.equal(r.model, "synthetic/provider/model");
	assert.equal(h.starts()[1]!.model, "synthetic/provider/model");
	for (const invalid of [{ model: 12 }, { model: "missing-provider" }, { auto: "yes" }]) {
		h.setSettings(invalid);
		const v = await h.build();
		assert.equal(v.status.state, "failed"); assert.equal(v.status.error?.code, "settings");
		assert.ok(v.status.error!.message.includes("settings.json")); assert.ok(v.status.error!.message.includes("ampi_arc"));
		assert.equal(h.starts().length, 2);
		assert.deepEqual(v.receipt.chapters, r.chapters);
	}
});

// Contract: arc.md / Receipt / Head for Overview; View: the Arc panel; Pipeline / Render.
// Detect fleet prose leakage, wrong Needs-you derivation, stale reads that invoke the model, and branch-count aliasing.
test("Arc v2: Overview head carries only Needs-you figures; append and equal-count branch replacement mark staleness", async t => {
	const points = [point(), point({ kind: "decision", state: "confirm", by: "agent", waits: undefined, title: "Agent chose the parser", cites: [cite("a1")] }), point({ kind: "confusion", state: "open", waits: "agent", title: "Check the parser result" }), point({ state: "done", waits: undefined }), point({ kind: "rule", state: "in force", waits: undefined, title: "Keep the source private" })];
	const h = await setup(t, { steps: [{ answer: answer({ points }) }] });
	const r = done(await h.build());
	assert.deepEqual(r.points.map((p: any) => p.needsYou), [true, true, false, false, false]);
	const head = await h.browser.until<any>(h.threads, v => v.threads["pi:sess-a"].arc?.needsYou === 2);
	assert.deepEqual(head.threads["pi:sess-a"].arc, { needsYou: 2, oldestAt: new Date(T).toISOString(), stale: 0 });
	const second = h.browser.sub("devbox", { kind: "view", view: "arc", threadId: "pi:sess-a" });
	await h.browser.until<any>(second, v => Boolean(v.receipt)); assert.equal(h.starts().length, 1);
	h.append(evidence("u3"));
	await h.browser.until<any>(h.sid, v => v.stale === 1);
	await h.browser.until<any>(h.threads, v => v.threads["pi:sess-a"].arc?.stale === 1);
	h.writeSession("a", [...initial.slice(0, 3), evidence("branch-a2", "assistant")], "sess-a");
	const branched = await h.browser.until<any>(h.sid, v => v.stale === 0 && v.branchChanged === true);
	assert.equal(branched.receipt.fingerprint, r.fingerprint, "branch change does not silently replace the receipt");
	assert.equal(h.starts().length, 1, "reads and auto:false appends never call the model");
});
