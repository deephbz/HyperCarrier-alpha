import "./home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { renderFooter } from "../src/visual-language.mjs";

// Frozen mock section D. Each row holds literal full and compact line-1 goldens.
const cases = [
  ["producer absent", null,
    "magpie/fable5.1-M · 13%/1.0M ⟲— · $1.23 CH99% · rb 12↑3 ✓sum",
    "magpie/fable5.1-M · 13%/1.0M⟲— · $1.23 · rb 12↑3"],
  ["off", { mode: "off" },
    "magpie/fable5.1-M · 67%/200k ⟲off · $1.23 CH99% · rb 12↑3 ✓sum",
    "magpie/fable5.1-M · 67%/200k⟲off · $1.23 · rb 12↑3"],
  ["disarmed", { mode: "disarmed" },
    "magpie/fable5.1-M · 67%/200k ⟲failed · $1.23 CH99% · rb 12↑3 ✓sum",
    "magpie/fable5.1-M · 67%/200k⟲failed · $1.23 · rb 12↑3"],
  ["handoff", { phase: "handoff", held: 2 },
    "magpie/fable5.1-M · 67%/200k ⟲handoff held 2 · $1.23 CH99% · rb 12↑3 ✓sum",
    "magpie/fable5.1-M · 67%/200k⟲handoff+2 · $1.23 · rb 12↑3"],
  ["stale", {},
    "magpie/fable5.1-M · 67%/200k ⟲90? · $1.23 CH99% · rb 12↑3 ✓sum",
    "magpie/fable5.1-M · 67%/200k⟲90? · $1.23 · rb 12↑3"],
];
function fixture(value) {
  const slots = new Map([["rarebit.summary", { asOf: 1, value: { kind: "count", n: 12, unread: 3, status: "ok" } }]]);
  if (value !== null) slots.set("context.budget", { asOf: 1, value: { kind: "ratio", used: 133100, limit: 200000, capacity: 1000000, threshold: 90, mode: "auto", ...value } });
  return { cwd: "~/repos/HyperCarrier", branch: "main", session: "hc-footer", multiplexer: true,
    model: { provider: "magpie", id: "claude/claude-fable-5-1", thinking: "medium" }, cost: 1.23, cacheHit: 99.7,
    context: { used: 133100, limit: 1000000 }, slots };
}
for (const [name, value, full, compact] of cases) test(`mock D: ${name}`, () => {
  const s = fixture(value);
  if (name === "stale") s.slots.get("context.budget").staleAfterMs = 10;
  assert.deepEqual(renderFooter(s, 118, { now: 12, tier: "full" }), ["hc-footer · ~/repos/HyperCarrier (main)", full]);
  assert.deepEqual(renderFooter(s, 58, { now: 12, tier: "compact" }), ["hc-footer · HyperCarrier (main)", compact]);
});
test("mock D: width 40", () => {
  assert.deepEqual(renderFooter(fixture({}), 40), ["hc-footer · ~/repos/HyperCarrier (main)", "magpie/fable5.1-M · 67%"]);
});
test("mock D: width 40, handoff with 2 held", () => {
  assert.deepEqual(renderFooter(fixture({ phase: "handoff", held: 2 }), 40), ["hc-footer · ~/repos/HyperCarrier (main)", "magpie/fable5.1-M · 67%⟲+2"]);
});
test("mock D: width 40, disarmed", () => {
  assert.deepEqual(renderFooter(fixture({ mode: "disarmed" }), 40), ["hc-footer · ~/repos/HyperCarrier (main)", "magpie/fable5.1-M · 67%⟲"]);
});
test("minimal active state keeps the glyph without a held count", () => {
  assert.equal(renderFooter(fixture({ phase: "handoff" }), 40)[1], "magpie/fable5.1-M · 67%⟲");
  assert.equal(renderFooter(fixture({ phase: "compacting", held: 2 }), 40)[1], "magpie/fable5.1-M · 67%⟲+2");
});
test("phase wins over threshold and disarmed mode", () => {
  assert.match(renderFooter(fixture({ phase: "compacting", mode: "disarmed" }), 120)[1], /⟲compact/);
});
