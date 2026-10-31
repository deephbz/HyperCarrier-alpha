import "./home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { modelAlias, renderFooter } from "../src/visual-language.mjs";

const envelope = (key, value) => [key, { v: 1, key, producer: "fixture", asOf: 1, value }];
function state(over = {}) {
  return {
    cwd: "~/repos/HyperCarrier", branch: "main", session: "hc-footer", multiplexer: true,
    model: { provider: "magpie", id: "claude/claude-fable-5-1", thinking: "medium" },
    cost: 1.23, cacheHit: 99.7, context: { used: 133100, limit: 1000000 },
    slots: new Map([
      envelope("context.budget", { kind: "ratio", used: 133100, limit: 200000, unit: "tokens", mode: "auto", threshold: 90 }),
      envelope("rarebit.summary", { kind: "count", n: 12, unread: 3, status: "ok" }),
    ]), ...over,
  };
}
// Literal layout goldens for full and explicit compact representations.
test("mock A: solo full", () => {
  assert.deepEqual(renderFooter(state(), 118), [
    "hc-footer · ~/repos/HyperCarrier (main)",
    "magpie/fable5.1-M · 67%/200k ⟲90 · $1.23 CH99% · rb 12↑3 ✓sum",
  ]);
});
test("mock B: two compact solo panes", () => {
  assert.deepEqual(renderFooter(state(), 58, { tier: "compact" }), ["hc-footer · HyperCarrier (main)", "magpie/fable5.1-M · 67%/200k⟲90 · $1.23 · rb 12↑3"]);
  const other = state({ cwd: "~/repos/Blackmagic", branch: "docs-pass", session: "bm-docs", cost: 0.41,
    model: { provider: "magpie", id: "claude/claude-opus-5-5", thinking: "low" },
    slots: new Map([envelope("context.budget", { kind: "ratio", used: 410000, limit: 1000000, unit: "tokens", threshold: 85, mode: "auto" })]),
  });
  assert.deepEqual(renderFooter(other, 58, { tier: "compact" }), ["bm-docs · Blackmagic (docs-pass)", "magpie/opus5.5-L · 41%/1.0M⟲85 · $0.41"]);
});
test("mock C: leader, worker, and no multiplexer", () => {
  const leader = state({ session: "20261010-hc-handoff" });
  leader.slots.set(...envelope("team.member", { kind: "identity", team: "20261010-hc-handoff", role: "team-lead" }));
  assert.deepEqual(renderFooter(leader, 58, { tier: "compact" }), ["20261010-hc-handoff · HyperCarrier (main)", "magpie/fable5.1-M · 67%/200k⟲90 · $1.23 · rb 12↑3"]);
  const worker = state({ cwd: "~/repos/HyperCarrier/.worktrees/auto-compact-budget-hold", branch: "auto-compact-budget-hold", session: "20261010-hc-handoff/ac-builder", cost: 0.37,
    model: { provider: "magpie", id: "claude/claude-sonnet-5-5", thinking: "high" },
    slots: new Map([
      envelope("context.budget", { kind: "ratio", used: 96000, limit: 200000, unit: "tokens", mode: "auto", threshold: 90 }),
      envelope("rarebit.summary", { kind: "count", n: 4, unread: 0, status: "ok" }),
      envelope("team.member", { kind: "identity", team: "hc-auto-compact-handoff", role: "ac-builder" }),
    ]),
  });
  assert.deepEqual(renderFooter(worker, 58, { tier: "compact" }), ["20261010-hc-handoff/ac-builder · auto-compact-budget-hold", "magpie/sonnet5.5-H · 48%/200k⟲90 · $0.37 · rb 4↑0"]);
  assert.deepEqual(renderFooter({ ...leader, multiplexer: false }, 120), [
    "20261010-hc-handoff · ~/repos/HyperCarrier (main) · team-lead",
    "magpie/fable5.1-M · 67%/200k ⟲90 · $1.23 CH99% · rb 12↑3 ✓sum",
  ]);
});
test("ladder: absent producer, explicit tiers, tail dropping, final truncation", () => {
  const s = state({ slots: new Map(), context: { used: 440000, limit: 1000000 } });
  assert.match(renderFooter(s, 90)[1], /44%\/1.0M/);
  assert.equal(renderFooter(state(), 49, { tier: "minimal" })[1], "magpie/fable5.1-M · 67%");
  assert.equal(renderFooter(state(), 50, { tier: "compact" })[1], "magpie/fable5.1-M · 67%/200k⟲90 · $1.23 · rb 12↑3");
  assert.equal(renderFooter(state(), 35, { tier: "full" })[1], "magpie/fable5.1-M · 67%/200k ⟲90");
  assert.equal(renderFooter(state(), 10)[1], "67%");
  assert.equal(renderFooter(state(), 2)[1].replace(/\x1b\[0m/g, ""), "6…");
  for (let width = 0; width < 130; width++) for (const line of renderFooter(state(), width)) assert.ok(visibleWidth(line) <= width);
});
test("off, unknown native usage, generic slots, status order, terminal columns", () => {
  const s = state();
  s.slots.get("context.budget").value.mode = "off";
  s.slots.set(...envelope("custom.label", { kind: "label", text: "你好\nready" }));
  s.statuses = new Map([["z", "last\nline"], ["a", "first"]]);
  const lines = renderFooter(s, 120);
  assert.match(lines[1], /⟲off.*你好 ready$/);
  assert.equal(lines[2], "first last line");
  assert.match(renderFooter(state({ slots: new Map(), context: { used: null, limit: 1000000 } }), 120)[1], /\?\/1.0M/);
  for (const line of renderFooter(s, 8)) assert.ok(visibleWidth(line) <= 8);
});
test("model aliases do not mutate the wire model", () => {
  const model = { provider: "p", id: "claude-fable-5-1", thinking: "xhigh" };
  assert.equal(modelAlias(model), "p/fable5.1-XH");
  assert.equal(modelAlias(model, { "p/claude-fable-5-1": "short" }), "short-XH");
  assert.equal(model.id, "claude-fable-5-1");
});
test("threshold and freshness styling use raw values", () => {
  const s = state();
  const slot = s.slots.get("context.budget");
  const calls = [];
  const theme = { fg(tone, text) { calls.push({ tone, text }); return text; } };
  slot.value.used = 180000;
  renderFooter(s, 200, { theme, noColor: false });
  assert.ok(calls.some(({ tone, text }) => tone === "warning" && text === "90%"));
  calls.length = 0;
  slot.value.used = 200000;
  renderFooter(s, 200, { theme, noColor: false });
  assert.ok(calls.some(({ tone, text }) => tone === "error" && text === "100%"));
  calls.length = 0;
  slot.staleAfterMs = 10;
  renderFooter(s, 200, { theme, now: 12, noColor: false });
  assert.ok(calls.some(({ tone, text }) => tone === "dim" && text === "100%/200k ⟲90?"));
});
