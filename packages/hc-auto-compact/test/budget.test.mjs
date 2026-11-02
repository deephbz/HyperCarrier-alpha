import "./home.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { resolveBudget } from "../src/budget.mjs";
import { AUTO_COMPACT_TOOL_NAME, createAutoCompactController } from "../src/controller.mjs";

// Native-lane harness limited to budget, caps and sampling probes.
function makeHarness({ enabled = true, budget_tokens, compaction = {}, modelOverrides,
  usage = { tokens: 90_000, contextWindow: 100_000, percent: 90 } } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const hudSlots = [];
  const notices = [];
  const debug = [];
  const compactCalls = [];
  const sessionBranch = [];
  let activeTools = ["read"];
  const settings = { method: "native", enabled, threshold: 90,
    pre_compact_prompt: "Preserve the exact current work.",
    ...(budget_tokens ? { budget_tokens } : {}),
    ...(modelOverrides ? { modelOverrides } : {}) };
  const pi = {
    events: { on() {}, emit(channel, payload) { if (channel === "hc.hud.slot") hudSlots.push(payload); } },
    appendEntry(customType, data) { sessionBranch.push({ type: "custom", customType, data }); },
    getThinkingLevel: () => "off",
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
    registerTool(tool) {
      tools.set(tool.name, tool);
      activeTools = [...activeTools.filter(name => name !== tool.name), tool.name];
    },
    getActiveTools: () => [...activeTools],
    setActiveTools(next) { activeTools = [...next]; },
    sendMessage() {},
    sendUserMessage() {},
  };
  const ctx = {
    cwd: "/test/project", hasUI: true, mode: "tui",
    model: { provider: "test", id: "model", contextWindow: 100_000, maxTokens: 32_000 },
    isProjectTrusted: () => true,
    sessionManager: { getBranch: () => sessionBranch },
    ui: { setStatus() {}, getEditorText: () => "", setEditorText() {}, setWidget() {},
      notify(text, level) { notices.push({ text, level }); } },
    getContextUsage: () => usage,
    isIdle: () => true,
    hasPendingMessages: () => false,
    compact(options) { compactCalls.push(options); },
  };
  const controller = createAutoCompactController(pi, {
    settingsLoader: async () => ({ settings: { ...settings }, compaction, errors: [] }),
    settingsWriter: async ({ patch }) => {
      Object.assign(settings, patch);
      return { scope: "project", path: "/test/project/.pi/settings.json" };
    },
    onDebug: event => debug.push(event),
  });
  return { handlers, commands, tools, hudSlots, notices, debug, compactCalls, controller, ctx };
}

async function triggerAutomatic(harness) {
  await harness.handlers.get("turn_end")({}, harness.ctx);
}

async function triggerManual(harness, prompt) {
  await harness.commands
    .get("auto-compact")
    .handler(prompt === undefined ? "run" : `run ${prompt}`, harness.ctx);
}

async function ready(harness) {
  return harness.tools
    .get(AUTO_COMPACT_TOOL_NAME)
    .execute(`call-${Date.now()}`, {}, undefined, undefined, harness.ctx);
}

test("resolveBudget pins exact source strings for each precedence level", () => {
  const model = { provider: "test", id: "model" };
  const settings = { budget_tokens: 60_000 };
  const modelSettings = { ...settings, modelOverrides: { "test/model": { budget_tokens: 50_000 } } };
  for (const [config, session, source] of [
    [{}, undefined, "model.contextWindow"],
    [settings, undefined, "budget_tokens"],
    [modelSettings, undefined, "model override test/model"],
    [modelSettings, 40_000, "Session override"],
  ]) {
    assert.equal(resolveBudget(config, session, model, 100_000).source, source);
  }
});

test("budget arithmetic pins precedence, unknown windows and NaN usage", async () => {
  const cases = [
    { name: "window", expected: 100_000, label: "model window" },
    { name: "settings", budget_tokens: 60_000, expected: 60_000, label: "settings" },
    { name: "model", budget_tokens: 60_000, modelOverrides: { "test/model": { budget_tokens: 50_000 } }, expected: 50_000, label: "model override test/model" },
    { name: "Session", budget_tokens: 60_000, modelOverrides: { "test/model": { budget_tokens: 50_000 } }, session: 40_000, expected: 40_000, label: "branch override" },
    { name: "clamp", budget_tokens: 200_000, expected: 100_000, label: "settings" },
    { name: "usage window", window: undefined, expected: 100_000, label: "model window" },
    { name: "unknown window", window: undefined, usage: { tokens: 1_000 }, expected: undefined, label: "model window" },
    { name: "NaN tokens", usage: { tokens: NaN, contextWindow: 100_000, percent: 99 }, expected: undefined, label: "model window" },
  ];
  for (const entry of cases) {
    const harness = makeHarness({ ...entry, enabled: false, usage: entry.usage ?? { tokens: 1_000, contextWindow: 100_000 } });
    if (Object.hasOwn(entry, "window")) harness.ctx.model.contextWindow = entry.window;
    if (entry.session) await harness.commands.get("auto-compact").handler(`budget ${entry.session}`, harness.ctx);
    await triggerAutomatic(harness);
    assert.equal(harness.hudSlots.at(-1).value?.limit, entry.expected, entry.name);
    await harness.commands.get("auto-compact").handler("status", harness.ctx);
    assert.ok(harness.notices.at(-1).text.includes(`(${entry.label})`), entry.name);
    if (entry.expected === undefined) {
      assert.equal(harness.debug.findLast(event => event.type === "utilization_observed").known, false, entry.name);
    }
    if (entry.session) {
      await harness.commands.get("auto-compact").handler("budget default", harness.ctx);
      assert.equal(harness.hudSlots.at(-1).value.limit, 50_000);
    }
  }
});

test("summary caps pin reserve precedence, floors and output edges", async () => {
  const cases = [
    { compaction: {}, expected: { reserve: 16_384, history: 13_107, prefix: 8_192 } },
    { compaction: { reserveTokens: 101 }, expected: { reserve: 101, history: 80, prefix: 50 } },
    { compaction: { reserveTokens: 101, modelOverrides: { "test/model": { reserveTokens: 81 } } }, expected: { reserve: 81, history: 64, prefix: 40 } },
    ...[undefined, 0, 30, 60, 100].map(maxTokens => ({ compaction: { reserveTokens: 101 }, maxTokens,
      expected: { reserve: 101, history: maxTokens === undefined ? 80 : Math.min(80, maxTokens), prefix: maxTokens === undefined ? 50 : Math.min(50, maxTokens) } })),
  ];
  for (const entry of cases) {
    const harness = makeHarness({ compaction: entry.compaction });
    if (Object.hasOwn(entry, "maxTokens")) harness.ctx.model.maxTokens = entry.maxTokens;
    await triggerManual(harness);
    await ready(harness);
    harness.handlers.get("agent_settled")({}, harness.ctx);
    harness.compactCalls[0].onError(new Error("pin caps"));
    assert.deepEqual(harness.controller.snapshot().lastCompaction.caps, entry.expected);
  }
});

test("budget sampling remains lazy and HUD refresh does not sample usage", async () => {
  for (const modelWindow of [100_000, undefined]) {
    const harness = makeHarness({ enabled: false, usage: { tokens: 1_000, contextWindow: 100_000 } });
    harness.ctx.model.contextWindow = modelWindow;
    let utilizationReads = 0;
    let refreshReads = 0;
    let refreshObserved = false;
    // Observe the refresh path independently of the usage reads it must avoid.
    Object.defineProperty(harness.ctx.model, "contextWindow", {
      get() {
        if (new Error().stack.includes("at refreshBudgetState")) refreshObserved = true;
        return modelWindow;
      },
    });
    harness.ctx.getContextUsage = () => {
      const stack = new Error().stack;
      if (stack.includes("at utilizationFor")) utilizationReads++;
      if (stack.includes("at refreshBudgetState")) refreshReads++;
      return { tokens: 1_000, contextWindow: 100_000 };
    };
    await triggerAutomatic(harness);
    assert.equal(utilizationReads, modelWindow === undefined ? 2 : 1);
    utilizationReads = 0;
    await triggerManual(harness);
    await ready(harness);
    assert.ok(refreshObserved, "refreshBudgetState frame was not observed; update the sampling probe if renamed");
    assert.equal(refreshReads, 0);
  }
});

