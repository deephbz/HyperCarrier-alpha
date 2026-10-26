import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { collectRounds, fitGap, keepCap, overheadOf, PlanRejected, renderKept, resolveKeep, tailTokens } from "@hypercarrier/auto-compact-durable/keepset";
import { FIT_NEXT, plannerLine, recordDetail, recordLine, rowHead, rowLine } from "../src/shared/compact-record.ts";

// The keep cap and the per-item cut bound the installed text, after fences, headers and cut marks.

const estimate = (text: string) => Math.ceil(text.length / 4);

/** Synthetic replaced entries: one tool call and its result per output. */
function entries(outputs: readonly string[], args: object = {}) {
	return outputs.flatMap((output, i) => [
		{ id: String(2 * i + 1), kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name: "bash", arguments: args }] }] },
		{ id: String(2 * i + 2), kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: `c${i}`, toolName: "bash", content: [{ type: "text", text: output }], isError: false }] },
	]) as never;
}

test("keep budget: a backtick-only output cannot expand past the per-item cut or the cap once fenced", () => {
	const rounds = collectRounds(entries(["`".repeat(32_000), "`".repeat(32_000)]));
	const resolved = resolveKeep(rounds, ["t1", "t2"], 20_000);
	const text = renderKept(resolved.kept);
	assert.equal(resolved.tokens, estimate(text), "the cap counts the rendered text");
	assert.ok(resolved.tokens <= 2 * 8_000 + 1, `two cut blocks and their separator: ${resolved.tokens}`);
	for (const block of text.split("\n\n### ")) assert.ok(estimate(block) <= 8_000, `block ${estimate(block)} tokens`);
	assert.match(text, /\[cut at 8000 tokens; \d+ more tokens in history\]/);
	assert.throws(() => resolveKeep(collectRounds(entries(Array(3).fill("`".repeat(32_000)))), ["t1", "t2", "t3"], 20_000), (e: unknown) => e instanceof PlanRejected && /over the 20000-token cap/.test(e.message));
});

test("keep budget: many tiny outputs pay for their headers and fences", () => {
	const rounds = collectRounds(entries(Array.from({ length: 300 }, () => "x"), { command: "printf x" }));
	const labels = rounds.map((r) => r.label);
	assert.throws(() => resolveKeep(rounds, labels, keepCap(2500)), (e: unknown) => e instanceof PlanRejected && /kept outputs need \d+ tokens, over the 625-token cap/.test(e.message));
	// The same request is rejected every time: the decision depends only on the plan and the entries.
	assert.throws(() => resolveKeep(rounds, labels, keepCap(2500)), /over the 625-token cap/);
});

test("keep budget: a tiny W leaves a tiny cap, and the fit check names what does not fit", () => {
	assert.equal(keepCap(200), 50);
	assert.throws(() => resolveKeep(collectRounds(entries(["y".repeat(400)])), ["t1"], keepCap(200)), /over the 50-token cap/);
	assert.equal(fitGap({ summaryTokens: 500, tailTokens: 200, overheadTokens: 100, limit: 1024 }), undefined);
	assert.equal(
		fitGap({ summaryTokens: 9_000, tailTokens: 200, overheadTokens: 100, limit: 1024 }),
		"the summary does not fit: summary 9000 + kept tail 200 + prompt 100 = 9300 tokens, over the 1024-token compaction trigger",
	);
});

test("compaction line: short row, planner detail apart, mostly uncached under half, and the restart edge in owner words", () => {
	const planner = { model: "magpie/claude-haiku-5-5", requests: 1, usage: { input: 51_362, output: 399, cacheRead: 12_039, cacheWrite: 0, cost: 0 }, promptTokens: 63_401, cache: "19% of 63401 prompt tokens read from cache" };
	const keep = { cap: 20_000, perItemTokens: 8_000, keptTokens: 322, kept: [{ label: "t2", name: "read", tokens: 322 }], dropped: [], droppedCount: 1 };
	const base = { taskId: "t", reason: "manual", at: 1, replacedEntries: 14, firstKept: 30 };
	assert.equal(recordLine({ method: "keepset", ...base, keep, planner }), "keepset · 14 entries replaced · 1 output kept (322 of 20.0k) · 1 dropped · planner mostly uncached");
	assert.equal(recordLine({ method: "keepset", ...base, keep, planner: { ...planner, usage: { ...planner.usage, input: 492, cacheRead: 56_477 } } }), "keepset · 14 entries replaced · 1 output kept (322 of 20.0k) · 1 dropped");
	// The row says "low cache" for the same fact; a manual compaction says so, an automatic one does not.
	assert.equal(rowLine({ method: "keepset", ...base, keep, planner }), "14 entries replaced · 1 output kept · 1 dropped · low cache");
	assert.equal(rowHead({ method: "keepset", ...base, keep, planner }), "Compacted (manual)");
	assert.equal(rowHead({ method: "keepset", ...base, reason: "threshold", keep, planner }), "Compacted");
	assert.equal(plannerLine({ method: "keepset", ...base, keep, planner }), "planner magpie/claude-haiku-5-5 · 1 request · 399 out / 63.4k in · 19% of 63401 prompt tokens read from cache");
	const cold = { method: "native-fallback" as const, ...base, error: "no cache reuse: no request captured for this conversation in this process" };
	assert.equal(recordLine(cold), "summary only (first compaction after a restart; planner has no cached request yet)");
	assert.equal(recordLine({ method: "native-fallback", ...base, planRejected: "keep named an unknown entry (t999)", error: "x" }), "summary only (plan rejected: keep named an unknown entry (t999))");
	// The title and the body say why the planner was mostly uncached: a known gap on the Claude subscription bridge.
	assert.deepEqual(recordDetail({ method: "keepset", ...base, keep, planner }).slice(1), ["planner mostly uncached: read 19% from cache; the request prefix changed or its cache expired before the planner ran"]);
	assert.deepEqual(recordDetail({ method: "keepset", ...base, keep, planner: { ...planner, model: "claude/claude-haiku-5-5" } }).slice(1), ["planner mostly uncached: read 19% from cache; expected on the claude/ subscription bridge (known gap); the API route reuses the cache"]);
	// A summary too large for the window: a short row, the arithmetic in the detail, and the owner's next step.
	const fit = "the summary does not fit: summary 629 + kept tail 272 + prompt 4711 = 5612 tokens, over the 2250-token compaction trigger";
	const tooLarge = { method: "native-fallback" as const, ...base, planRejected: fit, error: fit, planner: { ...planner, usage: { ...planner.usage, input: 492, cacheRead: 56_477 } } };
	assert.equal(recordLine(tooLarge), "summary only (plan too large for the window)");
	assert.deepEqual(recordDetail(tooLarge).slice(1), [fit, FIT_NEXT]);
	assert.match(FIT_NEXT, /\/auto-compact budget <tokens>.*\/auto-compact method summary/);
	assert.equal(recordLine({ method: "native-fallback", ...base, error: fit }), "summary only (plan too large for the window)", "the summary method's fit failure reads the same");
	assert.equal(recordLine({ method: "hc-summary", ...base, replacedEntries: 1 }), "summary · 1 entry replaced");
});

test("fit estimate: the tail counts an image as 4800 characters and thinking and tool-call arguments as text", () => {
	const tail = [
		{ id: "10", kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 0 }] },
		{ id: "11", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "thinking", thinking: "t".repeat(7000) }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "x".repeat(3500) } }] }] },
		{ id: "9", kind: "pi.user", model: [{ role: "user", content: "replaced, before the first kept entry", timestamp: 0 }] },
	] as never;
	const user = Math.ceil(("see".length + 4800) / 3.5);
	const assistant = Math.ceil((7000 + "bash".length + JSON.stringify({ command: "x".repeat(3500) }).length) / 3.5);
	assert.equal(tailTokens(tail, 10), user + assistant);
	assert.equal(tailTokens(tail, 12), 0, "nothing at or after the first kept entry");
});

test("fit estimate: the prompt overhead is the replayed system state that placement restates after the cut", () => {
	const system = { role: "system", content: "", sections: { preamble: "p".repeat(35_000), gone: null }, toolsAdded: [{ name: "wide", description: "d".repeat(35_000), parameters: { type: "object", properties: {} } }], timestamp: 0 };
	// A later patch replaces the preamble and adds a tool; durable restates the result as one baseline after the cut.
	const patch = { role: "system", content: "", sections: { preamble: "q".repeat(70_000) }, toolsAdded: [{ name: "wider", description: "e".repeat(35_000), parameters: { type: "object", properties: {} } }], timestamp: 0 };
	const user = { role: "user", content: "hi", timestamp: 0 };
	const history = [{ id: "1", model: [system] }, { id: "2", model: [user] }, { id: "3", model: [patch] }, { id: "4", model: [user] }] as never;
	const firstKept = 4;
	assert.ok(Number((history as { id: string }[])[2]!.id) < firstKept, "the patch is before the first kept entry");
	const replayed = overheadOf(undefined, history);
	// 70k preamble + 35k + 35k schema descriptions at 3.5 characters per token; the replaced 35k preamble is gone.
	assert.ok(replayed >= 40_000 && replayed < 41_000, `the patched preamble replaces the old one and both tools count: ${replayed}`);
	assert.equal(tailTokens(history, firstKept), Math.ceil(2 / 3.5), "the tail holds the user message only");
	// The captured request carries the same patch in its messages; the request-level system prompt adds to it.
	const captured = { model: {}, options: {}, at: 0, context: { systemPrompt: "s".repeat(3_500), messages: [system, user, patch, user], tools: [] } } as never;
	assert.ok(overheadOf(captured, []) >= replayed + 1_000, "the captured request replays the patch too");
	assert.equal(overheadOf(captured, history), overheadOf(captured, []), "the larger estimate wins");
	// A system patch inside the kept tail is omitted by placement, so it counts once, as overhead.
	assert.equal(tailTokens([{ id: "5", model: [patch] }] as never, 5), 0);
});
