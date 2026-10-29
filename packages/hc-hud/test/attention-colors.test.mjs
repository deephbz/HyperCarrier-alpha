import "./home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderFooter } from "../src/visual-language.mjs";

function fixture(extra = {}, { absent = false, stale = false } = {}) {
  const value = { kind: "ratio", used: 133100, limit: 200000, unit: "tokens", threshold: 90, mode: "auto", ...extra };
  const slot = { asOf: 100, value, ...(stale ? { staleAfterMs: 1 } : {}) };
  return { cwd: "~/repos/HyperCarrier", branch: "main", session: "hc-footer", multiplexer: true,
    model: { provider: "magpie", id: "claude/claude-fable-5-1", thinking: "medium" }, cost: 1.23, cacheHit: 99.7,
    context: { used: 133100, limit: 1000000 }, slots: new Map(absent ? [] : [["context.budget", slot]]) };
}
function recorder() {
  const calls = [];
  return { calls, theme: {
    fg(tone, text) { calls.push({ tone, text }); return text; },
    bold(text) { calls.push({ tone: "bold", text }); return text; },
  } };
}
function tokens(state, width) {
  const { calls, theme } = recorder();
  renderFooter(state, width, { tier: width >= 90 ? "full" : width >= 50 ? "compact" : "minimal", theme, now: 102, noColor: false });
  return calls;
}
const contains = (calls, tone, text) => calls.some((call) => call.tone === tone && call.text === text);

test("rest stays neutral; metadata is muted and Session stays readable", () => {
  const calls = tokens(fixture(), 120);
  for (const text of ["67%", "⟲90", "magpie/fable5.1-M"]) assert.ok(!calls.some((call) => call.text === text));
  assert.ok(contains(calls, "dim", "~/repos/HyperCarrier (main)"));
  assert.ok(contains(calls, "dim", "$1.23 CH99%"));
  assert.ok(contains(calls, "dim", " · "));
  assert.ok(contains(calls, "bold", "hc-footer"));
  assert.ok(!calls.some((call) => call.tone === "success"));
});
test("routine compaction and disarmed failure have distinct control tones in every tier", () => {
  for (const width of [120, 60, 40]) {
    for (const phase of ["handoff", "compacting"]) {
      const calls = tokens(fixture({ phase }), width);
      const control = width < 50 ? "⟲" : phase === "handoff" ? "⟲handoff" : "⟲compact";
      assert.ok(contains(calls, "accent", control));
      assert.ok(!calls.some((call) => call.tone === "error" || call.tone === "warning"));
    }
    const failed = tokens(fixture({ mode: "disarmed" }), width);
    assert.ok(contains(failed, "error", width < 50 ? "⟲" : "⟲failed"));
    assert.ok(!failed.some((call) => call.tone === "accent"));
    const mixed = tokens(fixture({ mode: "disarmed", phase: "compacting" }), width);
    assert.ok(contains(mixed, "error", width < 50 ? "⟲" : "⟲compact"));
    assert.ok(!mixed.some((call) => call.tone === "accent"));
  }
});
test("occupancy pressure survives active phase and uses raw percent", () => {
  for (const width of [120, 60, 40]) {
    for (const [used, tone, percent] of [[180000, "warning", "90%"], [204000, "error", "102%"], [199500, "warning", "100%"]]) {
      const calls = tokens(fixture({ used, phase: "compacting" }), width);
      assert.ok(contains(calls, tone, percent));
      assert.ok(contains(calls, "accent", width < 50 ? "⟲" : "⟲compact"));
    }
  }
});
test("held input is warning independently of phase, including held-only and minimal", () => {
  for (const width of [120, 60, 40]) {
    for (const phase of [undefined, "handoff", "compacting"]) {
      const calls = tokens(fixture({ phase, held: 2 }), width);
      assert.ok(contains(calls, "warning", width >= 90 ? "held 2" : "+2"));
      assert.ok(!calls.some((call) => call.tone === "error"));
    }
  }
});
test("stale failure dims the entire value; absence remains explicit and muted", () => {
  for (const [width, original] of [[120, "67%/200k ⟲failed held 2?"], [60, "67%/200k⟲failed+2?"], [40, "67%⟲+2?"]]) {
    const calls = tokens(fixture({ mode: "disarmed", held: 2 }, { stale: true }), width);
    assert.ok(contains(calls, "dim", original));
    assert.ok(!calls.some((call) => ["error", "warning", "accent"].includes(call.tone)));
  }
  const absent = tokens(fixture({}, { absent: true }), 120);
  assert.ok(contains(absent, "dim", "13%"));
  assert.ok(contains(absent, "dim", "⟲—"));
  assert.ok(!absent.some((call) => ["error", "warning", "accent"].includes(call.tone)));
});
test("intentional off stays neutral; generic status and Rarebit keep their semantics", () => {
  const s = fixture({ mode: "off" });
  s.slots.set("rarebit.summary", { asOf: 100, value: { kind: "count", n: 12, unread: 3, status: "ok" } });
  for (const [level, tone] of [["ok", "success"], ["warn", "warning"], ["error", "error"]]) {
    s.slots.set(`generic.${level}`, { asOf: 100, value: { kind: "status", level, text: `status ${level}` } });
    assert.ok(contains(tokens(s, 200), tone, `status ${level}`));
  }
  const calls = tokens(s, 200);
  assert.ok(!calls.some((call) => ["⟲off", "67%", "rb 12↑3 ✓sum"].includes(call.text)));
});

// Real ANSI has zero visible width. Role recording above returns unchanged text.
const ansiTheme = {
  fg(tone, text) { return `\x1b[${{ dim: 90, accent: 36, warning: 33, error: 31, success: 32 }[tone]}m${text}\x1b[39m`; },
  bold(text) { return `\x1b[1m${text}\x1b[22m`; },
};
const scenarios = [
  fixture(), fixture({ used: 180000 }), fixture({ phase: "handoff", held: 2 }), fixture({ phase: "compacting" }),
  fixture({ mode: "disarmed" }), fixture({ used: 204000, phase: "compacting" }), fixture({}, { stale: true }),
  fixture({}, { absent: true }), fixture({ mode: "off" }), fixture({ phase: "compacting", held: 2 }),
  fixture({ mode: "disarmed" }, { stale: true }), fixture({ held: 2 }), fixture({ phase: "compacting", mode: "disarmed" }),
];
test("ANSI-stripped full and narrow goldens stay unchanged", () => {
  const s = fixture({ phase: "handoff", held: 2 });
  s.slots.set("rarebit.summary", { asOf: 100, value: { kind: "count", n: 12, unread: 3, status: "ok" } });
  const goldens = [
    [118, ["hc-footer · ~/repos/HyperCarrier (main)", "magpie/fable5.1-M · 67%/200k ⟲handoff held 2 · $1.23 CH99% · rb 12↑3 ✓sum"]],
    [58, ["hc-footer · ~/repos/HyperCarrier (main)", "magpie/fable5.1-M · 67%/200k⟲handoff+2 · $1.23 · rb 12↑3"]],
    [40, ["hc-footer · ~/repos/HyperCarrier (main)", "magpie/fable5.1-M · 67%⟲+2"]],
  ];
  for (const [width, expected] of goldens) assert.deepEqual(renderFooter(s, width, { theme: ansiTheme, noColor: false }).map(stripVTControlCharacters), expected);
});
test("real ANSI preserves text and width shedding across states and all widths", () => {
  for (const s of scenarios) {
    s.cwd = "~/项目/HyperCarrier";
    s.statuses = new Map([["external", "\x1b[35mexternal ready\x1b[39m"]]);
    for (let width = 0; width <= 130; width++) {
      const plain = renderFooter(s, width, { now: 102 });
      const colored = renderFooter(s, width, { theme: ansiTheme, now: 102, noColor: false });
      assert.deepEqual(colored.map(stripVTControlCharacters), plain, `width ${width}`);
      for (const line of colored) assert.ok(visibleWidth(line) <= width);
    }
  }
});
test("missing theme and NO_COLOR produce plain text, including truncation and external status", () => {
  const s = fixture({ phase: "handoff", held: 2 });
  s.statuses = new Map([["external", "\x1b[35mexternal ready\x1b[39m"]]);
  const previous = process.env.NO_COLOR;
  try {
    process.env.NO_COLOR = "1";
    for (const width of [120, 60, 40, 2]) {
      const calls = recorder();
      const plain = renderFooter(s, width);
      assert.ok(plain.every((line) => !line.includes("\x1b")));
      assert.deepEqual(renderFooter(s, width, { theme: ansiTheme }), plain);
      renderFooter(s, width, { theme: calls.theme });
      assert.deepEqual(calls.calls, []);
    }
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});
test("theme without bold still leaves the Session name readable", () => {
  const { theme } = recorder();
  delete theme.bold;
  assert.equal(renderFooter(fixture(), 120, { theme, noColor: false })[0], "hc-footer · ~/repos/HyperCarrier (main)");
});
