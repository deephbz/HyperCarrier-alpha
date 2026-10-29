import "./home.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { heldRuntime } from './helpers/held-runtime.mjs';

import {
  AUTO_COMPACT_TOOL_NAME,
  AUTO_COMPACT_WIDGET_KEY,
  buildPreCompactPrompt,
  createAutoCompactController,
  utilizationAtOrAboveThreshold,
} from "../src/controller.mjs";
import { PLAN_TOOL } from "../src/methods/plan-apply.mjs";
import { renderRarebitRecord } from '../src/methods/assemble.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeHarness({
  enabled = true,
  strategy = {},
  budget_tokens,
  compaction = {},
  modelOverrides,
  thinking = "off",
  threshold = 90,
  prompt = "Preserve the exact current work.",
  settingsLoader,
  settingsWriter,
  usage = { tokens: 90_000, contextWindow: 100_000, percent: 90 },
  activeTools = ["read"],
  sendMessageError,
  sendMessageErrorFor,
  sendUserMessageError,
  notifyError,
  setWidgetError,
  idle = true,
  pendingMessages = false,
  timers,
  autoAdmission = true,
} = {}) {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const messages = [];
  const userMessages = [];
  const deliveries = [];
  const notices = [];
  const holdSignals = [];
  const hudSlots = [];
  const methodClaims = [];
  const cachePins = [];
  const eventListeners = new Map();
  const recoveryEntries = [];
  let editorText = "";
  const widgetCalls = [];
  const footerCalls = [];
  const footer = new Map();
  let sessionBranch = [];
  const widgets = new Map();
  const debug = [];
  const compactCalls = [];
  const writes = [];
  let currentUsage = usage;
  let currentActiveTools = [...activeTools];
  let currentlyIdle = idle;
  let currentlyHasPendingMessages = pendingMessages;
  // These lifecycle tests drive Pi's native lane; the shipped default method is keepset.
  const configuredSettings = {
    method: "native",
    ...strategy,
    enabled,
    threshold,
    pre_compact_prompt: prompt,
    ...(budget_tokens ? { budget_tokens } : {}),
    ...(modelOverrides ? { modelOverrides } : {}),
  };

  const pi = {
    events: {
      on(channel, listener) {
        eventListeners.set(channel, listener);
      },
      emit(channel, payload) {
        if (channel === "hc.delivery-hold")
          holdSignals.push({ channel, payload, messageCount: messages.length });
        if (channel === "hc.hud.slot") hudSlots.push(payload);
        if (channel === "hc.compaction-method") methodClaims.push(payload);
        if (["cache-goblin:pin", "cache-goblin:unpin"].includes(channel)) cachePins.push({ channel, payload });
        eventListeners.get(channel)?.(payload);
      },
    },
    appendEntry(customType, data) {
      recoveryEntries.push({ customType, data });
      sessionBranch.push({ type: "custom", customType, data });
    },
    getThinkingLevel: () => thinking,
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
      currentActiveTools = [...currentActiveTools.filter(name => name !== tool.name), tool.name];
    },
    getActiveTools() {
      return [...currentActiveTools];
    },
    setActiveTools(next) {
      currentActiveTools = [...next];
    },
    sendMessage(message, options) {
      if (
        sendMessageError &&
        (sendMessageErrorFor === undefined ||
          sendMessageErrorFor === message.customType)
      )
        throw sendMessageError;
      messages.push({ message, options });
      deliveries.push({ kind: "custom", message, options });
    },
    sendUserMessage(prompt, options) {
      if (sendUserMessageError) throw sendUserMessageError;
      userMessages.push(prompt);
      deliveries.push({
        kind: "user",
        prompt,
        ...(options ? { options } : {}),
      });
    },
  };
  const ctx = {
    cwd: "/test/project",
    hasUI: true,
    mode: "tui",
    model: {
      provider: "test",
      id: "model",
      contextWindow: 100_000,
      maxTokens: 32_000,
    },
    isProjectTrusted: () => true,
    sessionManager: { getBranch: () => sessionBranch },
    ui: {
      setStatus(key, text) {
        footerCalls.push({ key, text });
        footer.set(key, text);
      },
      getEditorText: () => editorText,
      setEditorText: (text) => {
        editorText = text;
      },
      notify(text, level) {
        if (notifyError) throw notifyError;
        notices.push({ text, level });
      },
      setWidget(key, content, options) {
        if (setWidgetError) throw setWidgetError;
        widgetCalls.push({ key, content, options });
        if (content === undefined) widgets.delete(key);
        else widgets.set(key, { content, options });
      },
    },
    getContextUsage() {
      return currentUsage;
    },
    isIdle() {
      return currentlyIdle;
    },
    hasPendingMessages() {
      return currentlyHasPendingMessages;
    },
    compact(options) {
      compactCalls.push({
        ...options,
        onComplete() {
          options.onComplete();
          const message = messages.at(-1)?.message;
          if (
            autoAdmission &&
            message?.customType === "auto-compact.pickup" &&
            !message.details?.heldCount
          )
            handlers.get("message_start")(
              { message: { ...message, role: "custom" } },
              ctx,
            );
        },
      });
    },
  };
  const load =
    settingsLoader ??
    (async () => ({
      settings: { ...configuredSettings },
      compaction,
      errors: [],
    }));
  const write =
    settingsWriter ??
    (async ({ patch }) => {
      writes.push(patch);
      Object.assign(configuredSettings, patch);
      return { scope: "project", path: "/test/project/.pi/settings.json" };
    });
  const controller = createAutoCompactController(pi, {
    settingsLoader: load,
    settingsWriter: write,
    timers,
    onDebug: (event) => debug.push(event),
  });

  return {
    pi,
    handlers,
    commands,
    tools,
    messages,
    userMessages,
    deliveries,
    notices,
    holdSignals,
    hudSlots,
    methodClaims,
    cachePins,
    emitEvent: (channel, payload) => pi.events.emit(channel, payload),
    footerCalls,
    footer,
    setBranch: (branch) => {
      sessionBranch = branch;
    },
    recoveryEntries,
    widgetCalls,
    widgets,
    debug,
    compactCalls,
    writes,
    controller,
    ctx,
    activeTools: () => [...currentActiveTools],
    setUsage(next) {
      currentUsage = next;
    },
    setConfiguredPrompt(next) {
      configuredSettings.pre_compact_prompt = next;
    },
    setConfiguredSettings(patch) {
      Object.assign(configuredSettings, patch);
    },
    setIdle(next) {
      currentlyIdle = next;
    },
    setHasPendingMessages(next) {
      currentlyHasPendingMessages = next;
    },
  };
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

function assertCompactHud(harness, expected) {
  const hud = onlyWidgetText(harness);
  assert.equal(hud, expected, "HUD must be one exact current-state line");
  assert.doesNotMatch(hud, /\n|preserv|outcome|instruction|hidden context/i);
  return hud;
}

function lifecycleStages(text) {
  const rail = text
    .split("\n")
    .find(
      (line) =>
        line.includes("HANDOFF") &&
        line.includes("COMPACT") &&
        line.includes("PICKUP"),
    );
  assert.ok(rail, "ordered HANDOFF → COMPACT → PICKUP rail is missing");
  const [handoff, compact, pickup, extra] = rail
    .split("→")
    .map((stage) => stage.trim());
  assert.equal(
    extra,
    undefined,
    "lifecycle rail must have exactly three stages",
  );
  assert.match(handoff, /HANDOFF/);
  assert.match(compact, /COMPACT/);
  assert.match(pickup, /PICKUP/);
  return { handoff, compact, pickup };
}

function assertNoUiDiagnostics(text) {
  assert.doesNotMatch(
    text,
    /lifecycle(?:Id)?|runId|startedAt|handoff #\d+|provenance|tokens=|reason=|error=|\d{4}-\d{2}-\d{2}T\d{2}:/i,
  );
}

function assertExactInstruction(text, hiddenContent) {
  const delimiter =
    "Agent instruction (framework-generated hidden context; not user input):\n";
  const delimiterIndex = text.indexOf(delimiter);
  assert.notEqual(delimiterIndex, -1, "agent instruction label is missing");
  assert.equal(
    text.slice(delimiterIndex + delimiter.length),
    hiddenContent,
    "instruction suffix must equal the hidden custom message byte-for-byte",
  );
}

function assertLifecycleWidgetCleared(harness) {
  assert.equal(
    harness.widgets.has(AUTO_COMPACT_WIDGET_KEY),
    false,
    "terminal workflow must remove the Auto Compact card",
  );
  assert.deepEqual(harness.widgetCalls.at(-1), {
    key: AUTO_COMPACT_WIDGET_KEY,
    content: undefined,
    options: undefined,
  });
}

function onlyWidgetText(harness) {
  assert.equal(harness.widgets.size, 1, "one active Auto Compact card");
  const [{ content }] = [...harness.widgets.values()];
  assert.ok(Array.isArray(content), "persistent card must use text lines");
  assert.equal(content.length, 1, "HUD must use exactly one text entry");
  return content.join("\n");
}

test("utilization uses Pi's effective context window and crosses inclusively", () => {
  assert.deepEqual(utilizationAtOrAboveThreshold(undefined, 90), {
    known: false,
    crossed: false,
  });
  assert.equal(
    utilizationAtOrAboveThreshold(
      { tokens: 89_999, contextWindow: 100_000 },
      90,
    ).crossed,
    false,
  );
  const boundary = utilizationAtOrAboveThreshold(
    { tokens: 180_000, contextWindow: 200_000 },
    90,
  );
  assert.equal(boundary.crossed, true);
  assert.equal(boundary.percent, 90);
  assert.equal(boundary.contextWindow, 200_000);
  assert.equal(
    utilizationAtOrAboveThreshold(
      { tokens: 1, contextWindow: 1_000, percent: 89.999 },
      90,
    ).crossed,
    false,
    "authoritative percent is preferred when Pi supplies it",
  );
});

test("automatic mode respects disabled settings and the inclusive configured boundary", async () => {
  const disabled = makeHarness({ enabled: false });
  await triggerAutomatic(disabled);
  assert.equal(disabled.messages.length, 0);
  assert.equal(disabled.controller.snapshot().state, "idle");

  const below = makeHarness({
    threshold: 87.5,
    usage: { tokens: 87_499, contextWindow: 100_000, percent: 87.499 },
  });
  await triggerAutomatic(below);
  assert.equal(below.messages.length, 0);

  below.setUsage({
    tokens: 87_500,
    contextWindow: 100_000,
    percent: 87.5,
  });
  await triggerAutomatic(below);
  assert.equal(below.messages.length, 1);
  assert.equal(below.controller.snapshot().state, "handoff_pending");
});

test("handoff prompt forbids context gathering and makes that invariant override guidance", () => {
  const prompt = buildPreCompactPrompt(
    "Read the project status first, then preserve the active receipt.",
  );

  assert.match(prompt, /do not gather more context/i);
  assert.match(prompt, /do not read files, search, browse, inspect logs/i);
  assert.match(prompt, /do not .*run verification/i);
  assert.match(
    prompt,
    /use only information already in this Session and paths you already know/i,
  );
  assert.match(prompt, /use only safe write or edit operations/i);
  assert.match(
    prompt,
    /do not write a reply, summary, or status message to the human/i,
  );
  assert.match(prompt, /emit no assistant text; use only tool calls/i);
  assert.match(prompt, /write or update the minimum durable/i);
  assert.match(
    prompt,
    /if no safe write is possible without inspection, skip this step/i,
  );
  assert.match(prompt, /no-inspection rule overrides any guidance above/i);
  assert.ok(
    prompt.lastIndexOf("no-inspection rule") >
      prompt.indexOf("Read the project status first"),
    "the framework-owned restriction must follow and override configurable guidance",
  );
  assert.match(
    prompt,
    /2\. Call auto_compact_ready with no arguments, alone, as your final action/i,
  );
});

test("automatic crossing starts one visible handoff with fixed preservation semantics", async () => {
  const harness = makeHarness({
    prompt: "Also record the active experiment receipt.",
  });
  await Promise.all([triggerAutomatic(harness), triggerAutomatic(harness)]);

  assert.equal(harness.messages.length, 1);
  const [{ message, options }] = harness.messages;
  assert.equal(message.customType, "auto-compact.handoff");
  assert.equal(message.display, true);
  assert.deepEqual(message.details, { projection: "handoff", method: "native", preservation: "artifact-handoff" });
  assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
  assert.match(message.content, /near the configured limit/i);
  assert.match(message.content, /native compaction/i);
  assert.match(message.content, /durable Evergreen\/work artifacts/i);
  assert.match(message.content, /do not gather more context/i);
  assert.match(message.content, /do not read files, search, browse/i);
  assert.match(message.content, /auto_compact_ready with no arguments/i);
  assert.match(
    message.content,
    /applies only to this pending handoff/i,
  );
  assert.match(message.content, /after pickup or cancellation, ignore/i);
  assert.match(message.content, /active experiment receipt/);
  assert.deepEqual(harness.activeTools(), ["read", PLAN_TOOL, AUTO_COMPACT_TOOL_NAME]);
  assert.match(harness.notices.at(-1).text, /AUTO COMPACT · AUTOMATIC/);
  assert.ok(
    harness.debug.some(
      ({ type, percent, contextWindow }) =>
        type === "utilization_observed" &&
        percent === 90 &&
        contextWindow === 100_000,
    ),
  );
});

test("manual run uses the same handoff while automatic mode is disabled", async () => {
  const harness = makeHarness({ enabled: false });
  await triggerManual(harness);
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].message.customType, "auto-compact.handoff");
  assert.equal(harness.controller.snapshot().lifecycle.trigger, "manual");
  assert.match(harness.notices.at(-1).text, /AUTO COMPACT · MANUAL/);
});

test("busy manual run queues its typed handoff until the native follow-up reaches context", async () => {
  const harness = makeHarness({ idle: false, pendingMessages: true });
  const pickupPrompt = "Continue after compacting.";

  await triggerManual(harness, pickupPrompt);

  assert.equal(harness.controller.snapshot().state, "queued");
  assert.deepEqual(harness.activeTools(), ["read", PLAN_TOOL, AUTO_COMPACT_TOOL_NAME]);
  assert.equal(harness.messages.length, 1);
  const queued = harness.messages[0];
  assert.equal(queued.message.customType, "auto-compact.handoff");
  assert.equal(queued.message.display, true);
  assert.equal(queued.message.details.projection, "handoff");
  assert.equal(typeof queued.message.details.queuedRun, "string");
  assert.deepEqual(queued.options, {
    triggerTurn: true,
    deliverAs: "followUp",
  });
  assertCompactHud(
    harness,
    "AUTO COMPACT · MANUAL · QUEUED — waiting behind current agent work",
  );

  harness.handlers.get("message_start")(
    {
      message: {
        role: "custom",
        customType: "auto-compact.handoff",
        details: { projection: "handoff", queuedRun: "another-run" },
      },
    },
    harness.ctx,
  );
  assert.equal(harness.controller.snapshot().state, "queued");
  assert.deepEqual(harness.activeTools(), ["read", PLAN_TOOL, AUTO_COMPACT_TOOL_NAME]);

  const prematureReady = await ready(harness);
  assert.equal(prematureReady.details.status, "ignored");
  assert.equal(prematureReady.terminate, false);
  assert.equal(harness.controller.snapshot().state, "queued");

  harness.handlers.get("message_start")(
    { message: { role: "custom", ...queued.message } },
    harness.ctx,
  );
  assert.equal(harness.controller.snapshot().state, "handoff_pending");
  assert.deepEqual(harness.activeTools(), ["read", PLAN_TOOL, AUTO_COMPACT_TOOL_NAME]);
  assertCompactHud(
    harness,
    "AUTO COMPACT · MANUAL · HANDOFF — awaiting readiness",
  );

  await ready(harness);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  harness.compactCalls[0].onComplete();
  assert.deepEqual(harness.userMessages, [pickupPrompt]);
});

test("automatic handoffs remain steers even when the agent is busy", async () => {
  const harness = makeHarness({ idle: false, pendingMessages: true });
  await triggerAutomatic(harness);
  assert.equal(harness.controller.snapshot().state, "handoff_pending");
  assert.deepEqual(harness.messages[0].options, {
    triggerTurn: true,
    deliverAs: "steer",
  });
  assert.deepEqual(harness.activeTools(), ["read", PLAN_TOOL, AUTO_COMPACT_TOOL_NAME]);
});

test("a queued manual handoff removed before delivery terminates without compacting", async () => {
  const harness = makeHarness({ idle: false });
  await triggerManual(harness);
  assert.equal(harness.controller.snapshot().state, "queued");

  harness.handlers.get("agent_settled")({}, harness.ctx);

  assert.equal(harness.controller.snapshot().state, "idle");
  assert.deepEqual(harness.activeTools(), ["read", PLAN_TOOL, AUTO_COMPACT_TOOL_NAME]);
  assert.equal(harness.compactCalls.length, 0);
  assertLifecycleWidgetCleared(harness);
  assert.match(harness.notices.at(-1).text, /removed before delivery/i);
});

test("canceling a queued run fences its late typed handoff", async () => {
  const harness = makeHarness({ idle: false });
  await triggerManual(harness);
  const queued = harness.messages[0].message;

  await harness.commands.get("auto-compact").handler("off", harness.ctx);
  assert.equal(harness.controller.snapshot().state, "idle");
  assert.deepEqual(harness.activeTools(), ["read", PLAN_TOOL, AUTO_COMPACT_TOOL_NAME]);

  harness.handlers.get("context")(
    { messages: [{ role: "custom", ...queued }] },
    harness.ctx,
  );
  assert.equal(harness.controller.snapshot().state, "idle");
  assert.deepEqual(harness.activeTools(), ["read", PLAN_TOOL, AUTO_COMPACT_TOOL_NAME]);
  assert.equal(harness.compactCalls.length, 0);
});

test("automatic and manual handoffs preserve the exact visible Session event and compact HUD", async () => {
  for (const scenario of [
    { trigger: "AUTOMATIC", start: triggerAutomatic },
    { trigger: "MANUAL", start: triggerManual },
  ]) {
    const harness = makeHarness({ enabled: scenario.trigger === "AUTOMATIC" });
    await scenario.start(harness);
    const handoff = harness.messages[0];
    assert.equal(handoff.message.display, true);
    assert.equal(handoff.message.customType, "auto-compact.handoff");
    assert.deepEqual(handoff.message.details, { projection: "handoff", method: "native", preservation: "artifact-handoff" });
    assert.equal(
      handoff.message.content,
      buildPreCompactPrompt("Preserve the exact current work."),
    );
    assert.deepEqual(handoff.options, {
      triggerTurn: true,
      deliverAs: "steer",
    });
    assertCompactHud(
      harness,
      `AUTO COMPACT · ${scenario.trigger} · HANDOFF — awaiting readiness`,
    );
    assert.doesNotMatch(
      onlyWidgetText(harness),
      /preserv|outcome|instruction|\n/i,
    );

    await ready(harness);
    assertCompactHud(
      harness,
      `AUTO COMPACT · ${scenario.trigger} · READY — awaiting turn end`,
    );
    harness.handlers.get("agent_settled")({}, harness.ctx);
    assertCompactHud(
      harness,
      `AUTO COMPACT · ${scenario.trigger} · COMPACTING`,
    );

    harness.compactCalls[0].onComplete();
    assert.ok(
      harness.widgetCalls.some(
        ({ content }) =>
          content?.[0] ===
          `AUTO COMPACT · ${scenario.trigger} · PICKUP — requesting continuation`,
      ),
      "pickup must render as a compact current-state HUD before terminal cleanup",
    );
    assertLifecycleWidgetCleared(harness);
    await harness.commands.get("auto-compact").handler("status", harness.ctx);
    assertExactInstruction(
      harness.notices.at(-1).text,
      handoff.message.content,
    );
  }
});

test("unresolved external compaction has a one-line current-owner HUD", async () => {
  const harness = makeHarness();
  await triggerManual(harness);
  harness.handlers.get("session_before_compact")(
    { reason: "manual", willRetry: false },
    harness.ctx,
  );
  assertCompactHud(
    harness,
    "AUTO COMPACT · MANUAL · EXTERNAL COMPACTION — resolving interrupted handoff",
  );
});

test("session start keeps both phase-gated tools that Pi activated during registration", () => {
  const harness = makeHarness({
    activeTools: ["read", AUTO_COMPACT_TOOL_NAME],
  });
  harness.handlers.get("session_start")({}, harness.ctx);
  assert.deepEqual(harness.activeTools(), ["read", PLAN_TOOL, AUTO_COMPACT_TOOL_NAME]);
  assert.equal(harness.controller.snapshot().state, "idle");
});

test("human command reports status, persists valid changes, and rejects invalid input", async () => {
  const harness = makeHarness();
  const command = harness.commands.get("auto-compact");
  assert.match(
    command.description,
    /status\|on\|off\|threshold <percent>\|budget <tokens\|default>\|execution .*\|run/,
  );

  await command.handler("status", harness.ctx);
  assert.match(harness.notices.at(-1).text, /^Auto Compact · ON · idle/);
  assert.match(harness.notices.at(-1).text, /trigger 90% \(90k\)/);
  assert.match(harness.notices.at(-1).text, /context\s+90%/i);

  await command.handler("threshold 84.5", harness.ctx);
  await command.handler("off", harness.ctx);
  await command.handler("on", harness.ctx);
  assert.deepEqual(harness.writes, [
    { threshold: 84.5 },
    { enabled: false },
    { enabled: true },
  ]);
  assert.match(harness.notices.at(-1).text, /turned on.*project/i);

  const writeCount = harness.writes.length;
  await command.handler("threshold 110", harness.ctx);
  assert.equal(harness.writes.length, writeCount);
  assert.equal(harness.notices.at(-1).level, "warning");
  assert.match(
    harness.notices.at(-1).text,
    /greater than 1 and less than 110/i,
  );

  await command.handler("bogus", harness.ctx);
  assert.equal(harness.writes.length, writeCount);
  assert.match(harness.notices.at(-1).text, /^Usage:/);
});

test("status distinguishes no run from current and last-run receipts", async () => {
  const harness = makeHarness();
  await harness.commands.get("auto-compact").handler("status", harness.ctx);
  const noRun = harness.notices.at(-1).text;
  assert.match(noRun, /no (?:current |last )?(?:Auto Compact )?run/i);
  assert.doesNotMatch(noRun, /Agent instruction/);
  assertNoUiDiagnostics(noRun);
});

test("ready is a temporary zero-parameter capability and defers native compact until settled", async () => {
  const harness = makeHarness();
  const tool = harness.tools.get(AUTO_COMPACT_TOOL_NAME);
  assert.ok(tool);
  assert.equal(harness.activeTools().includes(AUTO_COMPACT_TOOL_NAME), true);
  assert.deepEqual(tool.parameters.properties, {});
  assert.equal(tool.parameters.additionalProperties, false);

  const stale = await ready(harness);
  assert.equal(stale.details.status, "ignored");
  assert.equal(stale.terminate, false);

  await triggerAutomatic(harness);
  const accepted = await ready(harness);
  assert.equal(accepted.details.status, "accepted");
  assert.equal(accepted.terminate, true);
  assert.equal(harness.compactCalls.length, 0);
  assert.deepEqual(harness.activeTools(), ["read", PLAN_TOOL, AUTO_COMPACT_TOOL_NAME]);

  const duplicate = await ready(harness);
  assert.equal(duplicate.details.status, "ignored");
  assert.equal(harness.compactCalls.length, 0);

  harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.equal(harness.compactCalls.length, 1);
  assert.equal(harness.controller.snapshot().state, "compacting");
  assert.match(harness.notices.at(-1).text, /compaction is in progress/i);
});

test("successful native compaction injects pickup exactly once and high usage stays disarmed", async () => {
  const harness = makeHarness();
  await triggerAutomatic(harness);
  await ready(harness);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  const callbacks = harness.compactCalls[0];

  callbacks.onComplete();
  callbacks.onComplete();
  const pickups = harness.messages.filter(
    ({ message }) => message.customType === "auto-compact.pickup",
  );
  assert.equal(pickups.length, 1);
  assert.equal(pickups[0].message.customType, "auto-compact.pickup");
  assert.equal(pickups[0].message.display, true);
  assert.equal(pickups[0].message.details.projection, "pickup");
  assert.equal(
    pickups[0].message.details.runToken,
    harness.holdSignals[0].payload.token,
  );
  assert.deepEqual(pickups[0].options, { triggerTurn: true });
  assert.equal(
    pickups[0].message.content,
    "Auto Compact pickup: Pi compacted this Session. Continue the prior request if work remains. If it is complete, stop.",
  );
  assert.match(harness.notices.at(-1).text, /pickup instruction requested/i);
  assert.doesNotMatch(harness.notices.at(-1).text, /pickup instruction sent/i);
  assert.equal(harness.controller.snapshot().state, "idle");
  assert.deepEqual(harness.activeTools(), ["read", PLAN_TOOL, AUTO_COMPACT_TOOL_NAME]);
  assert.deepEqual(harness.userMessages, []);

  harness.setUsage({
    tokens: null,
    contextWindow: 100_000,
    percent: null,
  });
  await triggerAutomatic(harness);
  assert.equal(
    harness.messages.filter(
      ({ message }) => message.customType === "auto-compact.handoff",
    ).length,
    1,
    "unknown post-compact accounting must not start a handoff",
  );

  harness.setUsage({ tokens: 90_000, contextWindow: 100_000, percent: 90 });
  await triggerAutomatic(harness);
  assert.equal(
    harness.messages.filter(
      ({ message }) => message.customType === "auto-compact.handoff",
    ).length,
    1,
    "remaining above the threshold must not start a second lifecycle",
  );

  harness.setUsage({ tokens: 80_000, contextWindow: 100_000, percent: 80 });
  await triggerAutomatic(harness);
  harness.setUsage({ tokens: 90_000, contextWindow: 100_000, percent: 90 });
  await triggerAutomatic(harness);
  assert.equal(
    harness.messages.filter(
      ({ message }) => message.customType === "auto-compact.handoff",
    ).length,
    2,
    "dropping below then crossing again rearms automatic mode",
  );
});

test("prompted manual run sends its visible pickup before one unchanged continuation prompt", async () => {
  const harness = makeHarness();
  const prompt = "Continue the exact task; preserve  spacing.  ";
  await triggerManual(harness, prompt);
  await ready(harness);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  harness.compactCalls[0].onComplete();

  const pickup = harness.messages.at(-1);
  assert.equal(pickup.message.customType, "auto-compact.pickup");
  assert.deepEqual(pickup.options, { triggerTurn: false });
  assert.deepEqual(harness.userMessages, [prompt]);
  assert.deepEqual(harness.deliveries.slice(-2), [
    {
      kind: "custom",
      message: pickup.message,
      options: { triggerTurn: false },
    },
    { kind: "user", prompt },
  ]);
  assert.match(harness.notices.at(-1).text, /prompted continuation requested/i);
  assert.equal(harness.controller.snapshot().state, "idle");
});

test("prompted continuation send failure does not claim pickup success", async () => {
  const harness = makeHarness({
    sendUserMessageError: new Error("continuation unavailable"),
  });
  await triggerManual(harness, "Continue the task");
  await ready(harness);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  harness.compactCalls[0].onComplete();

  assert.deepEqual(harness.userMessages, []);
  assert.deepEqual(harness.messages.at(-1).options, { triggerTurn: false });
  const stages = lifecycleStages(harness.notices.at(-1).text);
  assert.match(stages.pickup, /×.*failed/i);
  assert.doesNotMatch(
    harness.notices.at(-1).text,
    /prompted continuation sent/i,
  );
});

test("compaction error and synchronous failure reset without pickup", async () => {
  const asynchronous = makeHarness();
  await triggerManual(asynchronous);
  await ready(asynchronous);
  asynchronous.handlers.get("agent_settled")({}, asynchronous.ctx);
  asynchronous.compactCalls[0].onError(new Error("provider refused"));
  assert.equal(asynchronous.controller.snapshot().state, "idle");
  assert.equal(
    asynchronous.messages.some(
      ({ message }) => message.customType === "auto-compact.pickup",
    ),
    false,
  );
  assert.match(asynchronous.notices.at(-1).text, /failed/i);
  assert.match(asynchronous.notices.at(-1).text, /provider refused/);
  assert.match(
    asynchronous.widgets.get(AUTO_COMPACT_WIDGET_KEY).content[0],
    /Compaction failed/,
  );

  const synchronous = makeHarness();
  synchronous.ctx.compact = () => {
    throw new Error("compact unavailable");
  };
  await triggerManual(synchronous);
  await ready(synchronous);
  synchronous.handlers.get("agent_settled")({}, synchronous.ctx);
  assert.equal(synchronous.controller.snapshot().state, "idle");
  assert.match(synchronous.notices.at(-1).text, /failed/i);
  assert.match(synchronous.notices.at(-1).text, /compact unavailable/);
  assert.match(
    synchronous.widgets.get(AUTO_COMPACT_WIDGET_KEY).content[0],
    /Compaction failed/,
  );
});

test("compaction error marks COMPACT failed and never presents PICKUP as requested", async () => {
  const harness = makeHarness({ prompt: "Preserve the error-path receipt." });
  await triggerManual(harness);
  const handoffMessage = harness.messages[0].message;
  await ready(harness);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  harness.compactCalls[0].onError(new Error("native compactor failed"));
  assert.equal(harness.notices.length, 3);

  const failure = harness.notices.at(-1).text;
  const stages = lifecycleStages(failure);
  assert.match(stages.handoff, /✓/);
  assert.match(stages.compact, /×.*failed/i);
  assert.match(stages.pickup, /—/);
  assert.doesNotMatch(stages.pickup, /✓|done|requested/i);
  assert.match(failure, /native compactor failed/);
  assertNoUiDiagnostics(failure);
  assert.match(
    harness.widgets.get(AUTO_COMPACT_WIDGET_KEY).content[0],
    /Compaction failed/,
  );
  assert.equal(
    harness.messages.filter(
      ({ message }) => message.customType === "auto-compact.pickup",
    ).length,
    0,
  );

  await harness.commands.get("auto-compact").handler("status", harness.ctx);
  const status = harness.notices.at(-1).text;
  assert.match(status, /last/i);
  assert.match(lifecycleStages(status).compact, /×.*failed/i);
  assertExactInstruction(status, handoffMessage.content);
});

test("pickup injection failure records PICKUP failed without changing completed compaction", async () => {
  const harness = makeHarness({
    sendMessageError: new Error("pickup injection unavailable"),
    sendMessageErrorFor: "auto-compact.pickup",
  });
  await triggerAutomatic(harness);
  const handoffMessage = harness.messages[0].message;
  await ready(harness);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  harness.compactCalls[0].onComplete();

  const failure = harness.notices.at(-1).text;
  const stages = lifecycleStages(failure);
  assert.match(stages.handoff, /✓/);
  assert.match(stages.compact, /✓/);
  assert.match(stages.pickup, /×.*failed/i);
  assert.doesNotMatch(failure, /pickup injection unavailable/);
  assert.equal(harness.controller.snapshot().state, "idle");
  assertLifecycleWidgetCleared(harness);

  await harness.commands.get("auto-compact").handler("status", harness.ctx);
  const status = harness.notices.at(-1).text;
  assert.match(status, /last/i);
  assert.match(lifecycleStages(status).pickup, /×.*failed/i);
  assertExactInstruction(status, handoffMessage.content);
});

test("a settled handoff without readiness forces compaction once", async () => {
  const harness = makeHarness();
  await triggerAutomatic(harness);
  for (let index = 0; index < 3; index += 1)
    harness.handlers.get("agent_settled")({ aborted: false }, harness.ctx);
  assert.equal(harness.controller.snapshot().state, "compacting");
  assert.equal(harness.compactCalls.length, 1);
  assert.equal(harness.activeTools().includes(AUTO_COMPACT_TOOL_NAME), true);
  await harness.commands.get("auto-compact").handler("status", harness.ctx);
  assert.match(
    harness.notices.at(-1).text,
    /Forced: handoff settled without readiness/,
  );
});

test("every zero-held pickup retains the hold until matching admission", async () => {
  for (const prompt of [undefined, "manual continuation"]) {
    const timers = fakeTimers();
    const harness = makeHarness({ timers, autoAdmission: false });
    if (prompt) await triggerManual(harness, prompt);
    else await triggerAutomatic(harness);
    await ready(harness);
    harness.handlers.get("agent_settled")({}, harness.ctx);
    harness.compactCalls[0].onComplete();
    const pickup = harness.messages.at(-1).message;
    assert.equal(pickup.details.runToken, harness.holdSignals[0].payload.token);
    assert.equal(harness.controller.snapshot().state, "pickup");
    assert.equal(harness.holdSignals.length, 1);
    assert.deepEqual(harness.userMessages, prompt ? [prompt] : []);
    const message = { ...pickup, role: "custom" };
    if (prompt)
      harness.handlers.get("context")({ messages: [message] }, harness.ctx);
    else harness.handlers.get("message_start")({ message }, harness.ctx);
    assert.equal(harness.controller.snapshot().state, "idle");
    assert.equal(harness.holdSignals.at(-1).payload.active, false);
    assert.equal(timers.intervals.size, 0);
  }
});

test("watchdog and abort re-arm while late released-token admission cannot finish a newer run", async () => {
  const timers = fakeTimers();
  const harness = makeHarness({ timers, autoAdmission: false });
  await compactHeld(harness);
  const oldPickup = { ...harness.messages.at(-1).message, role: "custom" };
  timers.fire(5000);
  assert.equal(harness.controller.snapshot().thresholdArmed, true);
  assert.ok(
    harness.notices.some((notice) =>
      /If the message also appears in the chat, discard the editor copy/.test(
        notice.text,
      ),
    ),
  );
  await triggerAutomatic(harness);
  assert.equal(harness.controller.snapshot().state, "handoff_pending");
  harness.handlers.get("message_start")({ message: oldPickup }, harness.ctx);
  assert.equal(harness.controller.snapshot().state, "handoff_pending");
  harness.handlers.get("agent_settled")({ aborted: true }, harness.ctx);
  assert.equal(harness.controller.snapshot().thresholdArmed, true);
  await triggerAutomatic(harness);
  assert.equal(harness.controller.snapshot().state, "handoff_pending");
});

test("capacity percentage without token usage cannot imply budget utilization", async () => {
  const harness = makeHarness({
    budget_tokens: 20_000,
    usage: { contextWindow: 100_000, percent: 90 },
  });
  await triggerAutomatic(harness);
  assert.equal(harness.controller.snapshot().usage.known, false);
  assert.equal(harness.controller.snapshot().state, "idle");
  assert.equal(harness.footer.get("hc-auto-compact"), undefined);
});

test("budget clamp drives threshold and status against true model capability", async () => {
  const harness = makeHarness({
    budget_tokens: 400_000,
    usage: { tokens: 244_800, contextWindow: 272_000, percent: 90 },
  });
  harness.ctx.model.contextWindow = 272_000;
  await triggerAutomatic(harness);
  assert.equal(harness.controller.snapshot().state, "handoff_pending");
  assert.equal(harness.controller.snapshot().usage.contextWindow, 272_000);
  await harness.commands.get("auto-compact").handler("status", harness.ctx);
  assert.match(
    harness.notices.at(-1).text,
    /budget\s+400k \(settings\) · clamped to model window 272k/,
  );
  assert.equal(harness.ctx.model.contextWindow, 272_000);
  assert.equal(
    harness.footer.get("hc-auto-compact"),
    "budget 244.8k/272k 90% · auto",
  );
});

test("budget command persists branch-local overrides and resolves Session over model over settings", async () => {
  const harness = makeHarness({
    budget_tokens: 80_000,
    modelOverrides: { "test/model": { budget_tokens: 60_000 } },
  });
  const command = harness.commands.get("auto-compact");
  await command.handler("status", harness.ctx);
  assert.match(
    harness.notices.at(-1).text,
    /budget\s+60k \(model override test\/model\)/,
  );
  await command.handler("budget 40k", harness.ctx);
  assert.equal(harness.controller.snapshot().budgetOverride, 40_000);
  assert.equal(harness.writes.length, 0);
  assert.deepEqual(harness.recoveryEntries.at(-1), {
    customType: "auto-compact.budget",
    data: { tokens: 40_000 },
  });
  await command.handler("status", harness.ctx);
  assert.match(
    harness.notices.at(-1).text,
    /budget\s+40k \(branch override\)/,
  );
  await harness.handlers.get("session_start")({}, harness.ctx);
  assert.equal(harness.controller.snapshot().budgetOverride, 40_000);
  const originalBranch = harness.ctx.sessionManager.getBranch();
  harness.setBranch([
    {
      type: "custom",
      customType: "auto-compact.budget",
      data: { tokens: 50_000 },
    },
  ]);
  harness.handlers.get("session_tree")({}, harness.ctx);
  assert.equal(harness.controller.snapshot().budgetOverride, 50_000);
  harness.setBranch(originalBranch);
  harness.handlers.get("session_tree")({}, harness.ctx);
  assert.equal(harness.controller.snapshot().budgetOverride, 40_000);
  await command.handler("budget default", harness.ctx);
  assert.equal(harness.controller.snapshot().budgetOverride, undefined);
  assert.deepEqual(harness.recoveryEntries.at(-1).data, { tokens: null });
  await harness.handlers.get("session_start")({}, harness.ctx);
  assert.equal(harness.controller.snapshot().budgetOverride, undefined);
  await command.handler("status", harness.ctx);
  assert.match(
    harness.notices.at(-1).text,
    /budget\s+60k \(model override test\/model\)/,
  );
  harness.setBranch([]);
  harness.handlers.get("session_tree")({}, harness.ctx);
  assert.equal(harness.controller.snapshot().budgetOverride, undefined);
});

test("new W stops a pending handoff on next turn_end without changing the hold token", async () => {
  const harness = makeHarness({
    budget_tokens: 100_000,
    usage: { tokens: 95_000, contextWindow: 100_000 },
  });
  await triggerManual(harness);
  const token = harness.holdSignals[0].payload.token;
  await harness.commands.get("auto-compact").handler("budget 80k", harness.ctx);
  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.holdSignals.length, 1);
  await triggerAutomatic(harness);
  assert.equal(harness.compactCalls.length, 1);
  assert.equal(harness.holdSignals[0].payload.token, token);
  await harness.commands.get("auto-compact").handler("status", harness.ctx);
  assert.match(harness.notices.at(-1).text, /overshoot 15000 tokens/);
});

test("budget persistence failure leaves the current override intact", async () => {
  const harness = makeHarness();
  await harness.commands.get("auto-compact").handler("budget 40k", harness.ctx);
  const append = harness.recoveryEntries.push;
  harness.recoveryEntries.push = () => {
    throw new Error("Session storage unavailable");
  };
  await harness.commands.get("auto-compact").handler("budget 50k", harness.ctx);
  assert.equal(harness.controller.snapshot().budgetOverride, 40_000);
  assert.match(harness.notices.at(-1).text, /budget was not saved/);
  harness.recoveryEntries.push = append;
});

test("Session boundaries fence late plain-compaction callbacks", async () => {
  const harness = makeHarness({ enabled: false });
  await triggerAutomatic(harness);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  const old = harness.compactCalls[0];
  await harness.handlers.get("session_start")({}, harness.ctx);
  old.onError(new Error("stale failure"));
  old.onComplete();
  assert.equal(harness.controller.snapshot().compactionFailed, false);
  assert.equal(harness.controller.snapshot().plainCompaction, undefined);
  assert.equal(harness.messages.length, 0);
});

test("model switches re-clamp the budget at the next turn boundary", async () => {
  const harness = makeHarness({
    budget_tokens: 400_000,
    usage: { tokens: 300_000, contextWindow: 1_000_000 },
  });
  harness.ctx.model.contextWindow = 1_000_000;
  await triggerAutomatic(harness);
  assert.equal(harness.controller.snapshot().state, "idle");
  harness.ctx.model.contextWindow = 272_000;
  await triggerAutomatic(harness);
  assert.equal(harness.controller.snapshot().state, "handoff_pending");
  await triggerAutomatic(harness);
  assert.equal(harness.compactCalls.length, 1);
});

test("off enforces budget through settled native compaction without handoff or custody", async () => {
  const harness = makeHarness({
    enabled: false,
    budget_tokens: 200_000,
    usage: { tokens: 180_000, contextWindow: 1_000_000 },
  });
  harness.ctx.model.contextWindow = 1_000_000;
  await triggerAutomatic(harness);
  assert.equal(harness.controller.snapshot().plainCompaction, "pending");
  assert.equal(harness.compactCalls.length, 0);
  assert.equal(capture(harness, "ordinary input"), undefined);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.equal(harness.compactCalls.length, 1);
  assert.equal(capture(harness, "compacting input"), undefined);
  assert.equal(harness.holdSignals.length, 0);
  assert.equal(harness.messages.length, 0);
  harness.handlers.get("session_before_compact")(
    { reason: "manual" },
    harness.ctx,
  );
  harness.handlers.get("session_compact")(
    { compactionEntry: { tokensBefore: 180_000, usage: { output: 500 } } },
    harness.ctx,
  );
  assert.equal(
    harness.controller.snapshot().lastCompaction.tokensBefore,
    180_000,
  );
  harness.compactCalls[0].onComplete();
  assert.equal(harness.controller.snapshot().plainCompaction, undefined);
  await triggerAutomatic(harness);
  assert.equal(harness.controller.snapshot().plainCompaction, undefined);
  await harness.commands.get("auto-compact").handler("status", harness.ctx);
  assert.match(
    harness.notices.at(-1).text,
    /mode\s+off \(plain native budget compaction\)/,
  );
});

test("plain budget compaction failure disarms and preserves the same failure record", async () => {
  const harness = makeHarness({ enabled: false });
  await triggerAutomatic(harness);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  harness.compactCalls[0].onError(new Error("Summarization failed: cap"));
  assert.equal(harness.controller.snapshot().compactionFailed, true);
  assert.equal(harness.controller.snapshot().lastCompaction.caps.prefix, 8192);
  harness.setUsage({ tokens: 20_000, contextWindow: 100_000 });
  await triggerAutomatic(harness);
  harness.setUsage({ tokens: 95_000, contextWindow: 100_000 });
  await triggerAutomatic(harness);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.equal(harness.compactCalls.length, 1);
  await harness.commands
    .get("auto-compact")
    .handler("budget 100k", harness.ctx);
  await triggerAutomatic(harness);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.equal(harness.compactCalls.length, 2);
});

test("budget footer updates at lifecycle boundaries, shows mode and colours, and hides unknown usage", async () => {
  const harness = makeHarness({
    enabled: false,
    budget_tokens: 200_000,
    usage: { tokens: 150_000, contextWindow: 1_000_000 },
  });
  harness.ctx.model.contextWindow = 1_000_000;
  await harness.handlers.get("session_start")({}, harness.ctx);
  assert.equal(
    harness.footer.get("hc-auto-compact"),
    "budget 150k/200k 75% · off",
  );
  harness.ctx.ui.theme = {
    fg: (color, text) => `<${color}>${text}</${color}>`,
  };
  harness.setUsage({ tokens: 180_000, contextWindow: 1_000_000 });
  await triggerAutomatic(harness);
  assert.equal(
    harness.footer.get("hc-auto-compact"),
    "<warning>budget 180k/200k 90% · off</warning>",
  );
  harness.setUsage({ tokens: 210_000, contextWindow: 1_000_000 });
  await triggerAutomatic(harness);
  assert.equal(
    harness.footer.get("hc-auto-compact"),
    "<error>budget 210k/200k 105% · off</error>",
  );
  harness.setUsage({ tokens: 12_345, contextWindow: 1_000_000 });
  harness.handlers.get("session_compact")({}, harness.ctx);
  assert.equal(
    harness.footer.get("hc-auto-compact"),
    "budget 12.3k/200k 6.17% · off",
  );
  await harness.commands
    .get("auto-compact")
    .handler("budget 100k", harness.ctx);
  assert.equal(
    harness.footer.get("hc-auto-compact"),
    "budget 12.3k/100k 12.35% · off",
  );
  await harness.commands.get("auto-compact").handler("on", harness.ctx);
  assert.match(harness.footer.get("hc-auto-compact"), /· auto$/);
  await harness.commands.get("auto-compact").handler("off", harness.ctx);
  assert.match(harness.footer.get("hc-auto-compact"), /· off$/);
  harness.setUsage(undefined);
  await triggerAutomatic(harness);
  assert.equal(harness.footer.get("hc-auto-compact"), undefined);
  const calls = harness.footerCalls.length;
  harness.ctx.mode = "rpc";
  await harness.handlers.get("session_start")({}, harness.ctx);
  assert.equal(harness.footerCalls.length, calls);
});

test("budget slot separates effective budget from capacity and replays without duplicate fallback", async () => {
  const harness = makeHarness({ budget_tokens: 200_000 });
  harness.ctx.model.contextWindow = 1_000_000;
  await harness.handlers.get("session_start")({}, harness.ctx);
  const slot = harness.hudSlots.at(-1);
  assert.equal(slot.v, 1);
  assert.equal(slot.key, "context.budget");
  assert.equal(slot.producer, "hc-auto-compact");
  assert.ok(Number.isFinite(slot.asOf));
  assert.deepEqual(slot.value, {
    kind: "ratio", used: 90_000, limit: 200_000, unit: "tokens",
    capacity: 1_000_000, mode: "auto", threshold: 90,
  });
  assert.match(harness.footer.get("hc-auto-compact"), /budget 90k\/200k/);
  harness.emitEvent("hc.hud.composer", { v: 1, present: true, surface: "tui-footer" });
  assert.equal(harness.hudSlots.at(-1), slot);
  assert.equal(harness.footer.get("hc-auto-compact"), undefined);
  await harness.commands.get("auto-compact").handler("budget 400k", harness.ctx);
  assert.equal(harness.hudSlots.at(-1).value.limit, 400_000);
  assert.equal(harness.footer.get("hc-auto-compact"), undefined);
  harness.emitEvent("hc.hud.composer", { v: 1, present: false, surface: "tui-footer" });
  assert.equal(harness.footer.get("hc-auto-compact"), "budget 90k/400k 22.5% · auto");
  harness.ctx.model.contextWindow = 100_000;
  await triggerAutomatic(harness);
  assert.equal(harness.hudSlots.at(-1).value.limit, 100_000);
  assert.equal(harness.hudSlots.at(-1).value.capacity, 100_000);
});

test("budget slots publish without a TUI and retract unknown usage and shutdown", async () => {
  const harness = makeHarness({ enabled: false });
  harness.ctx.mode = "rpc";
  await harness.handlers.get("session_start")({}, harness.ctx);
  assert.equal(harness.hudSlots.at(-1).value.mode, "off");
  assert.equal(harness.footerCalls.length, 0);
  harness.setUsage(undefined);
  await triggerAutomatic(harness);
  assert.equal(harness.hudSlots.at(-1).value, null);
  harness.setUsage({ tokens: 20_000, contextWindow: 100_000 });
  harness.handlers.get("session_compact")({}, harness.ctx);
  assert.equal(harness.hudSlots.at(-1).value.used, 20_000);
  harness.handlers.get("session_shutdown")({}, harness.ctx);
  assert.equal(harness.hudSlots.at(-1).value, null);
  const count = harness.hudSlots.length;
  harness.emitEvent("hc.hud.composer", { v: 1, present: true, surface: "tui-footer" });
  assert.equal(harness.hudSlots.length, count);
});

test("early composer presence suppresses fallback and invalid handshakes do not change it", async () => {
  const harness = makeHarness();
  harness.emitEvent("hc.hud.composer", { v: 1, present: true, surface: "tui-footer" });
  await harness.handlers.get("session_start")({}, harness.ctx);
  assert.equal(harness.hudSlots.at(-1).value.used, 90_000);
  assert.equal(harness.footer.get("hc-auto-compact"), undefined);
  for (const event of [
    { v: 2, present: false, surface: "tui-footer" },
    { v: 1, present: false, surface: "web" },
    { v: 1, present: "false", surface: "tui-footer" },
    null,
  ]) harness.emitEvent("hc.hud.composer", event);
  assert.equal(harness.footer.get("hc-auto-compact"), undefined);
  harness.emitEvent("hc.hud.composer", { v: 1, present: false, surface: "tui-footer" });
  assert.match(harness.footer.get("hc-auto-compact"), /budget 90k\/100k/);
});

test("fallback formats million-token capacity as 1.0M", async () => {
  const harness = makeHarness({ usage: { tokens: 1_200_000, contextWindow: 1_000_000 } });
  harness.ctx.model.contextWindow = 1_000_000;
  await harness.handlers.get("session_start")({}, harness.ctx);
  assert.equal(harness.footer.get("hc-auto-compact"), "budget 1.2M/1.0M 120% · auto");
});

test("budget slot publishes disarmed immediately on failure and clears it on re-arm", async () => {
  const harness = makeHarness();
  await triggerAutomatic(harness);
  await ready(harness);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  harness.compactCalls[0].onError(new Error("Summarization failed"));
  assert.equal(harness.hudSlots.at(-1).value.mode, "disarmed");
  assert.equal(harness.hudSlots.at(-1).value.phase, undefined);
  assert.match(harness.footer.get("hc-auto-compact"), /· disarmed$/);
  await harness.commands.get("auto-compact").handler("budget 100k", harness.ctx);
  assert.equal(harness.hudSlots.at(-1).value.mode, "auto");

  const plain = makeHarness({ enabled: false });
  await triggerAutomatic(plain);
  plain.handlers.get("agent_settled")({}, plain.ctx);
  plain.compactCalls[0].onError(new Error("Summarization failed"));
  assert.equal(plain.hudSlots.at(-1).value.mode, "disarmed");
  await plain.commands.get("auto-compact").handler("off", plain.ctx);
  assert.equal(plain.hudSlots.at(-1).value.mode, "off");
});

test("budget slot publishes handoff phase through readiness and removes it on abort", async () => {
  const harness = makeHarness();
  await triggerAutomatic(harness);
  assert.equal(harness.hudSlots.at(-1).value.phase, "handoff");
  await ready(harness);
  assert.equal(harness.hudSlots.at(-1).value.phase, "handoff");
  harness.handlers.get("agent_settled")({ aborted: true }, harness.ctx);
  // A ready handoff compacts even when the settled turn was aborted.
  assert.equal(harness.hudSlots.at(-1).value.phase, "compacting");

  const pending = makeHarness();
  await triggerAutomatic(pending);
  pending.handlers.get("agent_settled")({ aborted: true }, pending.ctx);
  assert.equal(pending.hudSlots.at(-1).value.phase, undefined);
});

test("budget slot publishes compacting phase for cooperative and plain native attempts", async () => {
  for (const enabled of [true, false]) {
    const harness = makeHarness({ enabled });
    await triggerAutomatic(harness);
    if (enabled) await ready(harness);
    harness.handlers.get("agent_settled")({}, harness.ctx);
    assert.equal(harness.hudSlots.at(-1).value.phase, "compacting");
    harness.compactCalls[0].onComplete();
    assert.equal(harness.hudSlots.at(-1).value.phase, undefined);
    assert.equal(harness.hudSlots.at(-1).value.mode, enabled ? "auto" : "off");
  }
});

test("budget slot publishes held counts during custody and removes them on admission or recovery", async () => {
  const harness = makeHarness();
  await triggerAutomatic(harness);
  capture(harness, "first");
  assert.equal(harness.hudSlots.at(-1).value.held, 1);
  capture(harness, "second");
  assert.equal(harness.hudSlots.at(-1).value.held, 2);
  await ready(harness);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.equal(harness.hudSlots.at(-1).value.held, 2);
  harness.compactCalls[0].onComplete();
  assert.equal(harness.hudSlots.at(-1).value.held, 2);
  harness.handlers.get("message_start")({ message: {
    ...harness.messages.at(-1).message, role: "custom",
  } }, harness.ctx);
  assert.equal(harness.hudSlots.at(-1).value.held, 2);
  harness.handlers.get('context')({ messages: [
    { ...harness.messages.at(-1).message, role: 'custom' },
    { role: 'user', content: 'first' }, { role: 'user', content: 'second' }
  ] }, harness.ctx);
  assert.equal(harness.hudSlots.at(-1).value.held, undefined);

  const cancelled = makeHarness();
  await triggerAutomatic(cancelled);
  capture(cancelled, "restore me");
  cancelled.handlers.get("agent_settled")({ aborted: true }, cancelled.ctx);
  assert.equal(cancelled.hudSlots.at(-1).value.held, undefined);
});

test("budget slot cannot replay or publish an older Session generation", async () => {
  const loading = deferred();
  let delayed = false;
  const harness = makeHarness({ settingsLoader: () => delayed
    ? loading.promise
    : Promise.resolve({ settings: { method: "native", enabled: true, threshold: 90 }, errors: [] }) });
  await harness.handlers.get("session_start")({}, harness.ctx);
  assert.equal(harness.hudSlots.length, 1);
  assert.equal(harness.hudSlots[0].staleAfterMs, undefined);
  delayed = true;
  const oldTurn = triggerAutomatic(harness);
  const newSession = harness.handlers.get("session_start")({}, harness.ctx);
  const count = harness.hudSlots.length;
  harness.emitEvent("hc.hud.composer", { v: 1, present: true, surface: "tui-footer" });
  assert.equal(harness.hudSlots.length, count);
  loading.resolve({ settings: { method: "native", enabled: false, threshold: 80 }, errors: [] });
  await Promise.all([oldTurn, newSession]);
  assert.equal(harness.hudSlots.length, count + 1);
  assert.equal(harness.hudSlots.at(-1).value.mode, "off");
  assert.doesNotMatch(JSON.stringify(harness.hudSlots.at(-1).value), /\\u001b|\\x1b/);
});

for (const composer of [true, false]) {
  test(`idle model selection re-clamps and restores the requested budget with ${composer ? "composer" : "fallback"}`, async () => {
    const harness = makeHarness({ budget_tokens: 200_000, usage: { tokens: 133_100, contextWindow: 1_000_000 } });
    harness.ctx.model.contextWindow = 1_000_000;
    await harness.handlers.get("session_start")({}, harness.ctx);
    if (composer) harness.emitEvent("hc.hud.composer", {
      v: 1, present: true, surface: "tui-footer",
    });
    for (const window of [100_000, 1_000_000]) {
      harness.ctx.model.contextWindow = window;
      await harness.handlers.get("model_select")({ model: harness.ctx.model, source: "set" }, harness.ctx);
      const value = harness.hudSlots.at(-1).value;
      assert.equal(value.limit, Math.min(200_000, window));
      assert.equal(value.capacity, window);
      assert.equal(value.used, 133_100);
      assert.equal(value.mode, "auto");
      assert.equal(harness.controller.snapshot().state, "idle");
      assert.equal(harness.compactCalls.length, 0);
      assert.equal(harness.messages.length, 0);
      if (composer) assert.equal(harness.footer.get("hc-auto-compact"), undefined);
      else assert.equal(harness.footer.get("hc-auto-compact"), window === 100_000
        ? "budget 133.1k/100k 133.1% · auto"
        : "budget 133.1k/200k 66.55% · auto");
    }
  });
}

test("model selection retains Session override, custody, phase and failure mode", async () => {
  const harness = makeHarness({ budget_tokens: 200_000 });
  harness.ctx.model.contextWindow = 1_000_000;
  await harness.handlers.get("session_start")({}, harness.ctx);
  await harness.commands.get("auto-compact").handler("budget 400k", harness.ctx);
  await triggerManual(harness);
  capture(harness, "hold this");
  harness.ctx.model.contextWindow = 100_000;
  await harness.handlers.get("model_select")({}, harness.ctx);
  assert.equal(harness.hudSlots.at(-1).value.limit, 100_000);
  assert.equal(harness.hudSlots.at(-1).value.phase, "handoff");
  assert.equal(harness.hudSlots.at(-1).value.held, 1);
  await ready(harness);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  harness.compactCalls[0].onError(new Error("Summarization failed"));
  harness.ctx.model.contextWindow = 1_000_000;
  await harness.handlers.get("model_select")({}, harness.ctx);
  assert.equal(harness.hudSlots.at(-1).value.limit, 400_000);
  assert.equal(harness.hudSlots.at(-1).value.mode, "disarmed");
  assert.equal(harness.hudSlots.at(-1).value.phase, undefined);
  assert.equal(harness.hudSlots.at(-1).value.held, undefined);
});

test("delayed model selection cannot publish into a newer Session", async () => {
  const pending = deferred();
  let delay = false;
  const harness = makeHarness({ settingsLoader: () => delay
    ? pending.promise
    : Promise.resolve({ settings: { method: "native", enabled: true, threshold: 90 }, errors: [] }) });
  await harness.handlers.get("session_start")({}, harness.ctx);
  delay = true;
  const selecting = harness.handlers.get("model_select")({}, harness.ctx);
  delay = false;
  await harness.handlers.get("session_start")({}, harness.ctx);
  await triggerManual(harness);
  const count = harness.hudSlots.length;
  pending.resolve({ settings: { method: "native", enabled: false, threshold: 90, budget_tokens: 50_000 }, errors: [] });
  await selecting;
  assert.equal(harness.hudSlots.length, count);
  assert.equal(harness.hudSlots.at(-1).value.limit, 100_000);
  capture(harness, "new Session input");
  assert.equal(harness.hudSlots.at(-1).value.mode, "auto");
  assert.equal(harness.hudSlots.at(-1).value.held, 1);
});

function fakeTimers() {
  const intervals = new Map();
  return {
    intervals,
    setInterval(fn, delay) {
      const timer = { fn, delay, unref() {} };
      intervals.set(timer, timer);
      return timer;
    },
    clearInterval(timer) {
      intervals.delete(timer);
    },
    fire(delay) {
      for (const timer of [...intervals.values()])
        if (timer.delay === delay) timer.fn();
    },
  };
}

function capture(harness, text, source = "interactive", images) {
  return harness.handlers.get("input")({ text, source, images }, harness.ctx);
}

async function compactHeld(harness, prompt) {
  await triggerManual(harness, prompt);
  capture(harness, "human priority");
  await ready(harness);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  harness.compactCalls[0].onComplete();
}

test("explicit budget drives threshold and forces at W in pending and ready", async () => {
  for (const reportReady of [false, true]) {
    const harness = makeHarness({
      budget_tokens: 20_000,
      usage: { tokens: 18_000, contextWindow: 100_000, percent: 18 },
    });
    await triggerAutomatic(harness);
    assert.equal(harness.controller.snapshot().state, "handoff_pending");
    if (reportReady) await ready(harness);
    harness.setUsage({
      tokens: 21_234,
      contextWindow: 100_000,
      percent: 21.234,
    });
    await harness.handlers.get("turn_end")({}, harness.ctx);
    assert.equal(harness.compactCalls.length, 1);
    assert.equal(harness.activeTools().includes(AUTO_COMPACT_TOOL_NAME), true);
    await harness.commands.get("auto-compact").handler("status", harness.ctx);
    assert.match(
      harness.notices.at(-1).text,
      /budget\s+20k \(settings\) · handoff room 2k/,
    );
    assert.match(harness.notices.at(-1).text, /overshoot 1234 tokens/);
  }
});

test("status names configured caps and the accepted reload and empty-Session persistence limits", async () => {
  const harness = makeHarness();
  const command = harness.commands.get("auto-compact");
  await command.handler("status", harness.ctx);
  assert.match(
    harness.notices.at(-1).text,
    /summary caps history 13\.1k · turn prefix 8\.2k/,
  );
  assert.match(
    harness.notices.at(-1).text,
    /After changing compaction.reserveTokens, reload Pi \(\/reload or restart\)/,
  );
  assert.doesNotMatch(harness.notices.at(-1).text, /Message-less Sessions/);
  await command.handler("budget 40k", harness.ctx);
  await command.handler("status", harness.ctx);
  assert.match(
    harness.notices.at(-1).text,
    /Message-less Sessions can lose budget overrides after a Session switch/,
  );
  await command.handler("budget default", harness.ctx);
  await command.handler("status", harness.ctx);
  assert.doesNotMatch(harness.notices.at(-1).text, /Message-less Sessions/);
});

test("status exposes native caps and keeps thinking warning out of the HUD", async () => {
  const harness = makeHarness({
    thinking: "medium",
    compaction: {
      reserveTokens: 32_768,
      modelOverrides: { "test/model": { reserveTokens: 16_384 } },
    },
  });
  await triggerManual(harness);
  await harness.commands.get("auto-compact").handler("status", harness.ctx);
  assert.match(
    harness.notices.at(-1).text,
    /budget\s+100k \(model window\)/,
  );
  assert.match(harness.notices.at(-1).text, /history 13\.1k · turn prefix 8\.2k/);
  assert.match(
    harness.notices.at(-1).text,
    /Raise compaction.reserveTokens \(starting point 32768, unmeasured\)/,
  );
  assert.doesNotMatch(
    harness.widgets.get(AUTO_COMPACT_WIDGET_KEY).content[0],
    /Raise/,
  );
});

test("failure retains caps and error, disarms across low usage, and re-arms on reserve change", async () => {
  const compaction = { reserveTokens: 16_384 };
  const harness = makeHarness({ compaction });
  await triggerAutomatic(harness);
  await ready(harness);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  harness.compactCalls[0].onError(
    new Error("Turn prefix summarization failed: output limit"),
  );
  assert.equal(harness.controller.snapshot().compactionFailed, true);
  assert.deepEqual(harness.controller.snapshot().lastCompaction.caps, {
    reserve: 16_384,
    history: 13_107,
    prefix: 8_192,
  });
  harness.setUsage({ tokens: 10_000, contextWindow: 100_000 });
  await triggerAutomatic(harness);
  harness.setUsage({ tokens: 90_000, contextWindow: 100_000 });
  await triggerAutomatic(harness);
  assert.equal(harness.messages.length, 1);
  await harness.commands.get("auto-compact").handler("status", harness.ctx);
  assert.match(harness.notices.at(-1).text, /Turn prefix summarization failed/);
  assert.match(harness.notices.at(-1).text, /Re-arm:/);
  compaction.reserveTokens = 32_768;
  await triggerAutomatic(harness);
  assert.equal(harness.messages.length, 2);
});

test("failure re-arms on explicit run, settings command, or successful compaction", async () => {
  for (const action of ["run", "threshold 90", "successful"]) {
    const harness = makeHarness();
    await triggerAutomatic(harness);
    await ready(harness);
    harness.handlers.get("agent_settled")({}, harness.ctx);
    harness.compactCalls[0].onError(new Error("Summarization failed"));
    if (action === "successful")
      harness.handlers.get("session_compact")(
        { reason: "manual" },
        harness.ctx,
      );
    else
      await harness.commands.get("auto-compact").handler(action, harness.ctx);
    assert.equal(harness.controller.snapshot().compactionFailed, false);
    await triggerAutomatic(harness);
    assert.equal(harness.messages.length, 2);
  }
});

test("failed settings writes do not re-arm a failed compactor", async () => {
  const harness = makeHarness({
    settingsWriter: async () => {
      throw new Error("read only");
    },
  });
  await triggerAutomatic(harness);
  await ready(harness);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  harness.compactCalls[0].onError(new Error("Summarization failed"));
  await harness.commands
    .get("auto-compact")
    .handler("threshold 85", harness.ctx);
  assert.equal(harness.controller.snapshot().compactionFailed, true);
  await triggerAutomatic(harness);
  assert.equal(harness.messages.length, 1);
});

test("caps use reserve without a thinking warning at R32768 and respect model.maxTokens", async () => {
  const harness = makeHarness({
    thinking: "medium",
    compaction: { reserveTokens: 32_768 },
  });
  await harness.commands.get("auto-compact").handler("status", harness.ctx);
  assert.match(harness.notices.at(-1).text, /history 26\.2k · turn prefix 16\.4k/);
  assert.doesNotMatch(harness.notices.at(-1).text, /Raise compaction/);
  harness.ctx.model.maxTokens = 10_000;
  await harness.commands.get("auto-compact").handler("status", harness.ctx);
  assert.match(harness.notices.at(-1).text, /history 10k · turn prefix 10k/);
});

test("held pickup send failure restores custody and records recovery", async () => {
  const harness = makeHarness({
    sendMessageError: new Error("pickup unavailable"),
    sendMessageErrorFor: "auto-compact.pickup",
  });
  await compactHeld(harness);
  assert.equal(harness.controller.snapshot().state, "idle");
  assert.equal(harness.ctx.ui.getEditorText(), "human priority");
  assert.equal(harness.recoveryEntries[0].data.reason, "Pickup failed");
  assert.equal(harness.holdSignals.at(-1).payload.active, false);
});

test("own compaction records native usage and labels two-call aggregation", async () => {
  const harness = makeHarness();
  await triggerManual(harness);
  await ready(harness);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  harness.handlers.get("session_before_compact")(
    {
      reason: "manual",
      preparation: {
        isSplitTurn: true,
        turnPrefixMessages: [{}],
        messagesToSummarize: [{}],
      },
    },
    harness.ctx,
  );
  const usage = { input: 111, output: 222 };
  harness.handlers.get("session_compact")(
    { reason: "manual", compactionEntry: { usage, tokensBefore: 90_000 } },
    harness.ctx,
  );
  assert.deepEqual(harness.controller.snapshot().lastCompaction, {
    usage,
    tokensBefore: 90_000,
    aggregate: true,
    caps: { reserve: 16_384, history: 13_107, prefix: 8_192 },
  });
});

test("capture covers every source and held state, but excludes queued, pickup, and no-UI", async () => {
  const harness = makeHarness();
  assert.equal(capture(harness, "idle"), undefined);
  await triggerManual(harness);
  for (const source of ["interactive", "rpc", "extension"])
    assert.deepEqual(capture(harness, source, source), { action: "handled" });
  harness.ctx.hasUI = false;
  assert.equal(capture(harness, "print"), undefined);
  harness.ctx.hasUI = true;
  await ready(harness);
  capture(harness, "ready");
  harness.handlers.get("agent_settled")({}, harness.ctx);
  capture(harness, "compacting");
  assert.equal(harness.controller.snapshot().heldCount, 5);
  assert.match(
    harness.widgets.get(AUTO_COMPACT_WIDGET_KEY).content[0],
    /held 5/,
  );
  harness.compactCalls[0].onComplete();
  assert.equal(capture(harness, "pickup"), undefined);
  const queued = makeHarness({ idle: false });
  await triggerManual(queued);
  assert.equal(capture(queued, "queued"), undefined);
});

test("held pickup sends instruction then ordered user messages; only matching context admits custody", async () => {
  const timers = fakeTimers();
  const harness = makeHarness({ timers });
  await triggerManual(harness, "manual objective");
  capture(harness, "first human");
  const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
  capture(harness, "second source", "rpc", [image]);
  await ready(harness);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  harness.compactCalls[0].onComplete();
  const pickup = harness.messages.at(-1);
  assert.deepEqual(pickup.options, { triggerTurn: false });
  assert.equal(pickup.message.details.heldCount, 2);
  assert.match(pickup.message.content, /take priority[\s\S]*Run prompt:\nmanual objective/);
  assert.doesNotMatch(pickup.message.content, /first human|second source|via rpc/);
  assert.deepEqual(harness.userMessages, ['first human']);
  assert.equal(harness.controller.snapshot().state, "pickup");
  harness.handlers.get("message_start")(
    {
      message: {
        ...pickup.message,
        role: "custom",
        details: { runToken: "other" },
      },
    },
    harness.ctx,
  );
  assert.equal(harness.controller.snapshot().heldCount, 2);
  const custom = { ...pickup.message, role: "custom" };
  harness.handlers.get("message_start")({ message: custom }, harness.ctx);
  assert.equal(harness.controller.snapshot().heldCount, 2, 'custom admission keeps custody');
  assert.equal(harness.holdSignals.at(-1).payload.active, true);
  const first = { role: 'user', content: [{ type: 'text', text: 'first human' }] };
  harness.handlers.get("message_start")({ message: first }, harness.ctx);
  assert.deepEqual(harness.userMessages, [
    'first human', [{ type: 'text', text: '[via rpc]\nsecond source' }, image]
  ]);
  assert.deepEqual(harness.deliveries.slice(-3).map(delivery => delivery.kind), ['custom', 'user', 'user']);
  for (const delivery of harness.deliveries.slice(-2))
    assert.deepEqual(delivery.options, { deliverAs: 'steer', expandPromptTemplates: false });
  harness.handlers.get("context")({ messages: [custom, first, { role: 'user', content: 'unrelated' }] }, harness.ctx);
  assert.equal(harness.controller.snapshot().heldCount, 1);
  assert.equal(harness.holdSignals.at(-1).payload.active, true);
  harness.handlers.get("context")({ messages: [custom, first,
    { role: 'user', content: [{ type: 'text', text: '[via rpc]\nsecond source' }, image] }
  ] }, harness.ctx);
  assert.equal(harness.controller.snapshot().heldCount, 0);
  assert.equal(harness.controller.snapshot().state, "idle");
  assert.equal(harness.holdSignals.at(-1).payload.active, false);
  assert.equal(
    harness.holdSignals[0].payload.token,
    pickup.message.details.runToken,
  );
  assert.equal(timers.intervals.size, 0);
  assert.equal(harness.recoveryEntries.length, 0);
});

test("idle watchdog records custody before restoring text and releases the hold", async () => {
  const timers = fakeTimers();
  const harness = makeHarness({ timers });
  harness.ctx.ui.setEditorText("new draft");
  await compactHeld(harness);
  harness.setIdle(false);
  timers.fire(5000);
  assert.equal(harness.controller.snapshot().state, "pickup");
  harness.setIdle(true);
  timers.fire(5000);
  assert.equal(harness.controller.snapshot().state, "idle");
  assert.equal(harness.ctx.ui.getEditorText(), "human priority\n\nnew draft");
  assert.equal(
    harness.recoveryEntries[0].customType,
    "auto-compact.held-input",
  );
  assert.deepEqual(harness.recoveryEntries[0].data.items, [
    { text: "human priority", source: "interactive", imageCount: 0 },
  ]);
  assert.equal(harness.holdSignals.at(-1).payload.active, false);
  assert.equal(timers.intervals.size, 0);
});

test("failure dispositions retain recovery text, name lost images, and never send to a new target", async () => {
  for (const outcome of [
    "error",
    "external",
    "off",
    "aborted",
    "session_start",
    "session_tree",
    "session_shutdown",
  ]) {
    const harness = makeHarness();
    await triggerManual(harness);
    capture(harness, "recover me", "interactive", [{ type: "image" }]);
    if (outcome === "error") {
      await ready(harness);
      harness.handlers.get("agent_settled")({}, harness.ctx);
      harness.compactCalls[0].onError(new Error("Summarization failed"));
    } else if (outcome === "external")
      harness.handlers.get("session_before_compact")(
        { reason: "overflow" },
        harness.ctx,
      );
    else if (outcome === "off")
      await harness.commands.get("auto-compact").handler("off", harness.ctx);
    else if (outcome === "aborted")
      harness.handlers.get("agent_settled")({ aborted: true }, harness.ctx);
    else harness.handlers.get(outcome)({}, harness.ctx);
    assert.equal(harness.ctx.ui.getEditorText(), "recover me", outcome);
    assert.equal(
      harness.recoveryEntries.length,
      ["session_start", "session_tree"].includes(outcome) ? 0 : 1,
      outcome,
    );
    assert.ok(
      harness.notices.some((notice) => /lost images/.test(notice.text)),
      outcome,
    );
    assert.equal(harness.userMessages.length, 0, outcome);
    assert.equal(harness.controller.snapshot().heldCount, 0, outcome);
    assert.equal(harness.holdSignals.at(-1).payload.active, false, outcome);
  }
  const rpc = makeHarness();
  rpc.ctx.mode = "rpc";
  await triggerManual(rpc);
  capture(rpc, "rpc recovery");
  rpc.handlers.get("agent_settled")({ aborted: true }, rpc.ctx);
  assert.ok(rpc.notices.some((notice) => /rpc recovery/.test(notice.text)));
  assert.equal(rpc.ctx.ui.getEditorText(), "");
});

test("hold begins before handoff delivery and renews with the same token until terminal", async () => {
  const timers = fakeTimers();
  const harness = makeHarness({ timers });
  await triggerManual(harness);
  assert.equal(harness.holdSignals[0].messageCount, 0);
  timers.fire(600_000);
  assert.deepEqual(
    harness.holdSignals[1].payload,
    harness.holdSignals[0].payload,
  );
  await harness.commands.get("auto-compact").handler("off", harness.ctx);
  assert.equal(timers.intervals.size, 0);
  await triggerManual(harness);
  assert.notEqual(
    harness.holdSignals.at(-1).payload.token,
    harness.holdSignals[0].payload.token,
  );
  const queued = makeHarness({ idle: false, timers: fakeTimers() });
  await triggerManual(queued);
  assert.equal(queued.holdSignals.length, 0);
  queued.handlers.get("message_start")(
    { message: { ...queued.messages[0].message, role: "custom" } },
    queued.ctx,
  );
  assert.equal(queued.holdSignals[0].payload.active, true);
});

test("only native threshold compaction is suppressed and external compaction interrupts handoff", async () => {
  const harness = makeHarness();
  assert.deepEqual(
    harness.handlers.get("session_before_compact")(
      { reason: "threshold" },
      harness.ctx,
    ),
    { cancel: true },
  );
  assert.equal(
    harness.handlers.get("session_before_compact")(
      { reason: "manual" },
      harness.ctx,
    ),
    undefined,
  );
  assert.equal(
    harness.handlers.get("session_before_compact")(
      { reason: "overflow" },
      harness.ctx,
    ),
    undefined,
  );

  await triggerManual(harness);
  assert.equal(
    harness.handlers.get("session_before_compact")(
      { reason: "manual" },
      harness.ctx,
    ),
    undefined,
  );
  assert.equal(harness.controller.snapshot().state, "idle");
  assert.deepEqual(harness.activeTools(), ["read", PLAN_TOOL, AUTO_COMPACT_TOOL_NAME]);
  assert.match(harness.notices.at(-1).text, /separate native Pi compaction/i);
  assert.equal((await ready(harness)).details.status, "ignored");
});

test("owned handoff lets Pi retry after typed overflow recovery", async () => {
  const harness = makeHarness();
  await triggerAutomatic(harness);

  assert.equal(
    harness.handlers.get("session_before_compact")(
      { reason: "overflow", willRetry: true },
      harness.ctx,
    ),
    undefined,
    "canceling would prevent Pi from retrying the failed request",
  );
  assert.equal(
    harness.compactCalls.length,
    0,
    "Pi owns retrying overflow compaction",
  );
  assert.equal(harness.controller.snapshot().state, "idle");

  harness.handlers.get("session_compact")(
    {
      reason: "overflow",
      willRetry: true,
      fromExtension: false,
      compactionEntry: { type: "compaction" },
    },
    harness.ctx,
  );
  const pickups = harness.messages.filter(
    ({ message }) => message.customType === "auto-compact.pickup",
  );
  assert.equal(pickups.length, 1);
  assert.deepEqual(pickups[0].options, { triggerTurn: false });
});

test("external compaction completion supersedes an interrupted handoff exactly once", async () => {
  for (const scenario of [
    { reason: "manual", willRetry: false, triggerTurn: false },
    { reason: "overflow", willRetry: true, triggerTurn: false },
  ]) {
    const harness = makeHarness();
    await triggerAutomatic(harness);
    assert.equal(harness.controller.snapshot().state, "handoff_pending");
    assert.equal(harness.activeTools().includes(AUTO_COMPACT_TOOL_NAME), true);

    assert.equal(
      harness.handlers.get("session_before_compact")(
        { reason: scenario.reason, willRetry: scenario.willRetry },
        harness.ctx,
      ),
      undefined,
    );
    assert.equal(harness.controller.snapshot().state, "idle");
    assert.deepEqual(harness.activeTools(), ["read", PLAN_TOOL, AUTO_COMPACT_TOOL_NAME]);
    assert.equal(harness.notices.length, 2);
    const interruptedNotice = harness.notices.at(-1).text;
    const interruptedStages = lifecycleStages(interruptedNotice);
    assert.match(interruptedStages.handoff, /↷.*interrupted/i);
    assert.match(interruptedStages.compact, /—/);
    assert.match(interruptedStages.pickup, /—/);
    assertNoUiDiagnostics(interruptedNotice);
    assert.equal(
      harness.widgets.size,
      1,
      "external resolution keeps its card visible",
    );
    assertCompactHud(
      harness,
      "AUTO COMPACT · AUTOMATIC · EXTERNAL COMPACTION — resolving interrupted handoff",
    );
    assert.equal(
      harness.messages.filter(
        ({ message }) => message.customType === "auto-compact.pickup",
      ).length,
      0,
      "supersession is projected only after native compaction succeeds",
    );

    const completed = {
      reason: scenario.reason,
      willRetry: scenario.willRetry,
      fromExtension: false,
      compactionEntry: { type: "compaction" },
    };
    harness.handlers.get("session_compact")(completed, harness.ctx);
    harness.handlers.get("session_compact")(completed, harness.ctx);
    assert.equal(
      harness.notices.length,
      3,
      "external completion gets one visible transition",
    );

    const pickups = harness.messages.filter(
      ({ message }) => message.customType === "auto-compact.pickup",
    );
    assert.equal(pickups.length, 1, scenario.reason);
    assert.equal(
      pickups[0].message.customType,
      "auto-compact.pickup",
      scenario.reason,
    );
    assert.equal(pickups[0].message.display, true, scenario.reason);
    assert.deepEqual(
      pickups[0].message.details,
      { projection: "pickup", supersedes: "handoff" },
      scenario.reason,
    );
    assert.deepEqual(
      pickups[0].options,
      { triggerTurn: scenario.triggerTurn },
      scenario.reason,
    );
    assert.equal(
      pickups[0].message.content,
      "Auto Compact handoff cancelled: a separate Pi compaction finished first. Ignore the earlier handoff notice and do not call auto_compact_ready. Continue the prior request if work remains. If it is complete, stop.",
      scenario.reason,
    );
    assert.equal(harness.controller.snapshot().state, "idle");
    assert.deepEqual(harness.activeTools(), ["read", PLAN_TOOL, AUTO_COMPACT_TOOL_NAME]);
    assert.deepEqual(harness.userMessages, []);
    assertLifecycleWidgetCleared(harness);

    const supersededNotice = harness.notices.at(-1).text;
    assert.match(supersededNotice, /pickup instruction requested/i);
    assert.doesNotMatch(supersededNotice, /pickup instruction sent/i);
    const supersededStages = lifecycleStages(supersededNotice);
    assert.match(supersededStages.handoff, /↷/);
    assert.match(supersededStages.compact, /✓.*external/i);
    assert.match(supersededStages.pickup, /✓/);
    assertNoUiDiagnostics(supersededNotice);
  }
});

test("external compaction after readiness preserves completed HANDOFF truth", async () => {
  for (const scenario of [
    { reason: "manual", willRetry: false },
    { reason: "overflow", willRetry: true },
  ]) {
    const harness = makeHarness();
    await triggerAutomatic(harness);
    const handoffMessage = harness.messages[0].message;
    await ready(harness);
    assert.equal(harness.controller.snapshot().state, "ready");

    assert.equal(
      harness.handlers.get("session_before_compact")(
        { reason: scenario.reason, willRetry: scenario.willRetry },
        harness.ctx,
      ),
      undefined,
    );
    assert.equal(harness.controller.snapshot().state, "idle");
    assert.deepEqual(harness.activeTools(), ["read", PLAN_TOOL, AUTO_COMPACT_TOOL_NAME]);
    const interruptedStages = lifecycleStages(harness.notices.at(-1).text);
    assert.match(interruptedStages.handoff, /✓/);
    assert.doesNotMatch(interruptedStages.handoff, /↷|interrupted/i);
    assert.match(interruptedStages.compact, /↷.*interrupted/i);
    assert.match(interruptedStages.pickup, /—/);
    assert.equal(
      harness.widgets.size,
      1,
      "external resolution keeps its card visible",
    );

    const completed = {
      reason: scenario.reason,
      willRetry: scenario.willRetry,
      fromExtension: false,
      compactionEntry: { type: "compaction" },
    };
    harness.handlers.get("session_compact")(completed, harness.ctx);
    harness.handlers.get("session_compact")(completed, harness.ctx);
    const completedStages = lifecycleStages(harness.notices.at(-1).text);
    assert.match(completedStages.handoff, /✓/);
    assert.doesNotMatch(completedStages.handoff, /↷|interrupted/i);
    assert.match(completedStages.compact, /✓.*external/i);
    assert.match(completedStages.pickup, /✓/);
    assertLifecycleWidgetCleared(harness);
    assert.equal(
      harness.messages.filter(
        ({ message }) => message.customType === "auto-compact.pickup",
      ).length,
      1,
    );

    await harness.commands.get("auto-compact").handler("status", harness.ctx);
    const status = harness.notices.at(-1).text;
    assert.match(status, /Last workflow/);
    const statusStages = lifecycleStages(status);
    assert.match(statusStages.handoff, /✓/);
    assert.doesNotMatch(statusStages.handoff, /↷|interrupted/i);
    assert.match(statusStages.compact, /✓.*external/i);
    assert.match(statusStages.pickup, /✓/);
    assertExactInstruction(status, handoffMessage.content);
    assertNoUiDiagnostics(status);
  }
});

test("our own native compaction projects one pickup across Pi completion and callback signals", async () => {
  const harness = makeHarness();
  await triggerAutomatic(harness);
  await ready(harness);
  harness.handlers.get("agent_settled")({}, harness.ctx);

  assert.equal(
    harness.handlers.get("session_before_compact")(
      { reason: "manual", willRetry: false },
      harness.ctx,
    ),
    undefined,
  );
  const nativeCompletion = {
    reason: "manual",
    willRetry: false,
    fromExtension: false,
    compactionEntry: { type: "compaction" },
  };
  harness.handlers.get("session_compact")(nativeCompletion, harness.ctx);
  assert.equal(
    harness.messages.filter(
      ({ message }) => message.customType === "auto-compact.pickup",
    ).length,
    0,
    "the ctx.compact callback owns pickup for this lifecycle",
  );

  harness.compactCalls[0].onComplete();
  harness.handlers.get("session_compact")(nativeCompletion, harness.ctx);
  const pickups = harness.messages.filter(
    ({ message }) => message.customType === "auto-compact.pickup",
  );
  assert.equal(pickups.length, 1);
  assert.equal(pickups[0].message.details.projection, "pickup");
  assert.equal(
    pickups[0].message.details.runToken,
    harness.holdSignals[0].payload.token,
  );
  assert.deepEqual(pickups[0].options, { triggerTurn: true });
  assert.equal(harness.controller.snapshot().state, "idle");
  assert.deepEqual(harness.activeTools(), ["read", PLAN_TOOL, AUTO_COMPACT_TOOL_NAME]);
});

test("corrective external pickup failure clears the card but retains status", async () => {
  const harness = makeHarness({
    sendMessageError: new Error("pickup injection unavailable"),
    sendMessageErrorFor: "auto-compact.pickup",
  });
  await triggerManual(harness);
  const handoffMessage = harness.messages[0].message;
  harness.handlers.get("session_before_compact")(
    { reason: "manual", willRetry: false },
    harness.ctx,
  );
  harness.handlers.get("session_compact")(
    {
      reason: "manual",
      willRetry: false,
      fromExtension: false,
      compactionEntry: { type: "compaction" },
    },
    harness.ctx,
  );
  assertLifecycleWidgetCleared(harness);
  const failure = harness.notices.at(-1).text;
  assert.match(lifecycleStages(failure).pickup, /×.*failed/i);
  assert.doesNotMatch(failure, /pickup injection unavailable/);

  await harness.commands.get("auto-compact").handler("status", harness.ctx);
  const status = harness.notices.at(-1).text;
  assert.match(status, /Last workflow/);
  assert.match(lifecycleStages(status).pickup, /×.*failed/i);
  assertExactInstruction(status, handoffMessage.content);
});

test("late external completion cannot supersede a newer active run", async () => {
  const harness = makeHarness();
  await triggerAutomatic(harness);
  harness.handlers.get("session_before_compact")(
    { reason: "overflow", willRetry: true },
    harness.ctx,
  );

  harness.setConfiguredPrompt("Preserve the newer manual run.");
  await triggerManual(harness);
  const newerHandoff = harness.messages.at(-1).message;
  assert.equal(harness.controller.snapshot().state, "handoff_pending");

  harness.handlers.get("session_compact")(
    {
      reason: "overflow",
      willRetry: true,
      fromExtension: false,
      compactionEntry: { type: "compaction" },
    },
    harness.ctx,
  );
  assert.equal(
    harness.messages.filter(
      ({ message }) => message.customType === "auto-compact.pickup",
    ).length,
    0,
  );
  assert.equal(harness.controller.snapshot().state, "handoff_pending");
  assert.equal(harness.activeTools().includes(AUTO_COMPACT_TOOL_NAME), true);

  await harness.commands.get("auto-compact").handler("status", harness.ctx);
  const status = harness.notices.at(-1).text;
  assert.match(status, /current/i);
  assert.match(lifecycleStages(status).handoff, /●.*active/i);
  assertExactInstruction(status, newerHandoff.content);
});

test("replacing an unresolved external compaction clears its card and fences late completion", async () => {
  const harness = makeHarness();
  await triggerManual(harness);
  const handoffMessage = harness.messages[0].message;
  harness.handlers.get("session_before_compact")(
    { reason: "manual", willRetry: false },
    harness.ctx,
  );
  assertCompactHud(
    harness,
    "AUTO COMPACT · MANUAL · EXTERNAL COMPACTION — resolving interrupted handoff",
  );

  harness.handlers.get("session_before_compact")(
    { reason: "overflow", willRetry: true },
    harness.ctx,
  );
  assertLifecycleWidgetCleared(harness);
  const messageCount = harness.messages.length;
  const noticeCount = harness.notices.length;
  harness.handlers.get("session_compact")(
    {
      reason: "manual",
      willRetry: false,
      fromExtension: false,
      compactionEntry: { type: "compaction" },
    },
    harness.ctx,
  );
  assert.equal(harness.messages.length, messageCount);
  assert.equal(harness.notices.length, noticeCount);
  assertLifecycleWidgetCleared(harness);

  await harness.commands.get("auto-compact").handler("status", harness.ctx);
  const status = harness.notices.at(-1).text;
  assert.match(status, /Last workflow/);
  assert.match(lifecycleStages(status).handoff, /↷.*interrupted/i);
  assertExactInstruction(status, handoffMessage.content);
});

test("session boundaries during native compaction clear the card and fence late callbacks", async () => {
  for (const event of ["session_start", "session_shutdown", "session_tree"]) {
    const harness = makeHarness();
    await triggerManual(harness);
    await ready(harness);
    harness.handlers.get("agent_settled")({}, harness.ctx);
    const callbacks = harness.compactCalls[0];
    const noticeCount = harness.notices.length;
    const messageCount = harness.messages.length;

    harness.handlers.get(event)({}, harness.ctx);
    assert.equal(harness.controller.snapshot().state, "idle", event);
    assertLifecycleWidgetCleared(harness);

    callbacks.onComplete();
    callbacks.onError(new Error("late failure"));
    assert.equal(harness.messages.length, messageCount, event);
    assert.equal(harness.notices.length, noticeCount, event);
    assertLifecycleWidgetCleared(harness);
  }
});

test("session shutdown and tree changes invalidate pending or ready callbacks", async () => {
  for (const event of ["session_shutdown", "session_tree"]) {
    const pending = makeHarness();
    await triggerManual(pending);
    pending.handlers.get(event)({}, pending.ctx);
    assert.equal(pending.controller.snapshot().state, "idle", event);
    assert.deepEqual(pending.activeTools(), ["read", PLAN_TOOL, AUTO_COMPACT_TOOL_NAME], event);
    assert.equal((await ready(pending)).details.status, "ignored", event);

    const acknowledged = makeHarness();
    await triggerManual(acknowledged);
    await ready(acknowledged);
    acknowledged.handlers.get(event)({}, acknowledged.ctx);
    acknowledged.handlers.get("agent_settled")({}, acknowledged.ctx);
    assert.equal(acknowledged.compactCalls.length, 0, event);
  }
});

test("session lifecycle boundaries clear current and last-run receipts", async () => {
  for (const event of ["session_start", "session_shutdown", "session_tree"]) {
    const harness = makeHarness();
    await triggerManual(harness);
    assert.equal(harness.widgets.size, 1, event);
    const [widgetKey] = harness.widgets.keys();
    harness.handlers.get(event)({}, harness.ctx);
    assert.equal(harness.widgets.size, 0, event);
    assert.deepEqual(
      harness.widgetCalls.at(-1),
      { key: widgetKey, content: undefined, options: undefined },
      event,
    );
    await harness.commands.get("auto-compact").handler("status", harness.ctx);
    assert.match(
      harness.notices.at(-1).text,
      /no (?:current |last )?(?:Auto Compact )?run/i,
      event,
    );
  }
});

test("/off invalidates a pending or ready lifecycle before compaction", async () => {
  for (const scenario of [
    {
      acknowledge: false,
      assertStages(stages) {
        assert.match(stages.handoff, /↷.*interrupted/i);
        assert.match(stages.compact, /—/);
        assert.match(stages.pickup, /—/);
      },
    },
    {
      acknowledge: true,
      assertStages(stages) {
        assert.match(stages.handoff, /✓/);
        assert.match(stages.compact, /↷.*interrupted/i);
        assert.match(stages.pickup, /—/);
      },
    },
  ]) {
    const harness = makeHarness();
    await triggerManual(harness);
    if (scenario.acknowledge) await ready(harness);
    await harness.commands.get("auto-compact").handler("off", harness.ctx);
    scenario.assertStages(lifecycleStages(harness.notices.at(-1).text));
    harness.handlers.get("agent_settled")({}, harness.ctx);
    assert.equal(harness.controller.snapshot().state, "idle");
    assert.equal(harness.compactCalls.length, 0);
    assertLifecycleWidgetCleared(harness);
    assert.deepEqual(harness.writes, [{ enabled: false }]);
    assert.deepEqual(harness.activeTools(), ["read", PLAN_TOOL, AUTO_COMPACT_TOOL_NAME]);
    await harness.commands.get("auto-compact").handler("status", harness.ctx);
    const status = harness.notices.at(-1).text;
    assert.match(status, /last/i);
    scenario.assertStages(lifecycleStages(status));
  }
});

test("deferred /off completion cannot replace a newer active workflow card", async () => {
  for (const outcome of ["success", "failure"]) {
    const write = deferred();
    const harness = makeHarness({
      settingsWriter: async () => write.promise,
    });
    await triggerManual(harness);
    const off = harness.commands
      .get("auto-compact")
      .handler("off", harness.ctx);
    await Promise.resolve();

    harness.setConfiguredPrompt(`Preserve newer ${outcome} workflow.`);
    await triggerManual(harness);
    const newerHandoff = harness.messages.at(-1).message;
    assertCompactHud(
      harness,
      "AUTO COMPACT · MANUAL · HANDOFF — awaiting readiness",
    );

    if (outcome === "success") write.resolve({ scope: "project" });
    else write.reject(new Error("settings unavailable"));
    await off;

    assertCompactHud(
      harness,
      "AUTO COMPACT · MANUAL · HANDOFF — awaiting readiness",
    );
    await harness.commands.get("auto-compact").handler("status", harness.ctx);
    assert.match(harness.notices.at(-1).text, /Current workflow/);
    assertExactInstruction(harness.notices.at(-1).text, newerHandoff.content);
  }
});

test("deferred /off completion cannot project across a Session boundary", async () => {
  for (const event of ["session_start", "session_shutdown", "session_tree"]) {
    for (const outcome of ["success", "failure"]) {
      const write = deferred();
      const harness = makeHarness({
        settingsWriter: async () => write.promise,
      });
      await triggerManual(harness);
      const off = harness.commands
        .get("auto-compact")
        .handler("off", harness.ctx);
      await Promise.resolve();

      harness.handlers.get(event)({}, harness.ctx);
      harness.setConfiguredPrompt(`Preserve ${event} ${outcome} workflow.`);
      await triggerManual(harness);
      const currentHandoff = harness.messages.at(-1).message;
      const noticeCount = harness.notices.length;
      const cardBeforeWrite = onlyWidgetText(harness);

      if (outcome === "success") write.resolve({ scope: "project" });
      else write.reject(new Error("settings unavailable"));
      await off;

      assert.equal(harness.notices.length, noticeCount, `${event} ${outcome}`);
      assert.equal(
        onlyWidgetText(harness),
        cardBeforeWrite,
        `${event} ${outcome}`,
      );
      assertCompactHud(
        harness,
        "AUTO COMPACT · MANUAL · HANDOFF — awaiting readiness",
      );
    }
  }
});

test("/off during native compaction disables future handoffs but lets the current compact finish", async () => {
  const harness = makeHarness();
  await triggerManual(harness);
  await ready(harness);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.equal(harness.controller.snapshot().state, "compacting");

  await harness.commands.get("auto-compact").handler("off", harness.ctx);
  assert.equal(harness.controller.snapshot().state, "compacting");
  assert.match(harness.notices.at(-1).text, /current compaction will finish/i);

  harness.compactCalls[0].onComplete();
  assert.equal(harness.controller.snapshot().state, "idle");
  assert.equal(
    harness.messages.filter(
      ({ message }) => message.customType === "auto-compact.pickup",
    ).length,
    1,
  );
  await triggerAutomatic(harness);
  assert.equal(
    harness.messages.filter(
      ({ message }) => message.customType === "auto-compact.handoff",
    ).length,
    1,
  );
});

test("delayed settings loads cannot create reentrant or post-/off handoffs", async () => {
  const firstLoad = deferred();
  let loadCount = 0;
  const harness = makeHarness({
    settingsLoader: async () => {
      loadCount += 1;
      if (loadCount === 1) return firstLoad.promise;
      return {
        settings: {
          method: "native",
          enabled: false,
          threshold: 90,
          pre_compact_prompt: "preserve",
        },
        errors: [],
      };
    },
  });

  const delayedTurn = triggerAutomatic(harness);
  await Promise.resolve();
  await harness.commands.get("auto-compact").handler("off", harness.ctx);
  firstLoad.resolve({
    settings: {
          method: "native",
      enabled: true,
      threshold: 90,
      pre_compact_prompt: "preserve",
    },
    errors: [],
  });
  await delayedTurn;
  assert.equal(harness.messages.length, 0);
  assert.equal(harness.controller.snapshot().state, "idle");

  const startLoad = deferred();
  const reentrant = makeHarness({
    settingsLoader: () => startLoad.promise,
  });
  const first = triggerManual(reentrant);
  const second = triggerManual(reentrant);
  await Promise.resolve();
  assert.match(reentrant.notices.at(-1).text, /already/i);
  startLoad.resolve({
    settings: {
          method: "native",
      enabled: true,
      threshold: 90,
      pre_compact_prompt: "preserve",
    },
    errors: [],
  });
  await Promise.all([first, second]);
  assert.equal(reentrant.messages.length, 1);
});

test("handoff injection failure emits a failed rail without a false instruction receipt", async () => {
  const harness = makeHarness({
    sendMessageError: new Error("injection unavailable"),
  });
  await triggerManual(harness);
  assert.equal(harness.messages.length, 0);
  assert.equal(harness.controller.snapshot().state, "idle");
  assert.deepEqual(harness.activeTools(), ["read", PLAN_TOOL, AUTO_COMPACT_TOOL_NAME]);
  assert.equal(harness.notices.length, 1);
  assertLifecycleWidgetCleared(harness);
  assert.match(harness.notices[0].text, /could not be requested/i);
  assert.doesNotMatch(harness.notices[0].text, /Agent instruction/);
  const stages = lifecycleStages(harness.notices[0].text);
  assert.match(stages.handoff, /×.*failed/i);
  assert.match(stages.compact, /—/);
  assert.match(stages.pickup, /—/);

  await harness.commands.get("auto-compact").handler("status", harness.ctx);
  const status = harness.notices.at(-1).text;
  assert.match(status, /last/i);
  assert.match(lifecycleStages(status).handoff, /×.*failed/i);
  assert.doesNotMatch(status, /Agent instruction/);
});

test("TUI notification failure never changes the control lifecycle", async () => {
  const harness = makeHarness({
    notifyError: new Error("TUI unavailable"),
  });
  await triggerManual(harness);
  assert.equal(harness.notices.length, 0);
  assert.equal(harness.controller.snapshot().state, "handoff_pending");
  assert.equal(harness.activeTools().includes(AUTO_COMPACT_TOOL_NAME), true);

  await ready(harness);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.equal(harness.controller.snapshot().state, "compacting");
  harness.compactCalls[0].onComplete();
  assert.equal(harness.controller.snapshot().state, "idle");
  assert.deepEqual(harness.activeTools(), ["read", PLAN_TOOL, AUTO_COMPACT_TOOL_NAME]);
  assert.equal(
    harness.messages.filter(
      ({ message }) => message.customType === "auto-compact.pickup",
    ).length,
    1,
  );
});

test("foreground custom method claims ownership before compaction and reports skipped preservation", async () => {
  const harness = makeHarness({ strategy: { preservation: "none", method: "summary", execution: "foreground" } });
  let calls = 0;
  harness.ctx.sessionManager.getSessionId = () => "session";
  harness.ctx.sessionManager.buildSessionProjection = () => ({ entries: [] });
  harness.ctx.modelRegistry = { streamSimple: () => {
    calls++;
    return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Summary" }], usage: { input: 4, output: 2, totalTokens: 6 } }) };
  } };
  await triggerManual(harness);
  assert.equal(harness.messages.length, 1);
  assert.match(harness.messages[0].message.content, /Artifact preservation is skipped/);
  assert.equal(harness.compactCalls.length, 0);
  await harness.tools.get("compaction_plan").execute("plan", { summary: "Summary", keep: [] }, undefined, undefined, harness.ctx);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.equal(harness.compactCalls.length, 1);
  const claim = harness.methodClaims.find((c) => c.active);
  assert.equal(claim.method, "summary");
  assert.ok(claim.token);
  const result = await harness.handlers.get("session_before_compact")({ reason: "manual" }, harness.ctx);
  assert.equal(calls, 0, "foreground must use the main session response, not a side request");
  assert.equal(result.compaction.usage, undefined, "main assistant usage must not be double-counted");
  harness.compactCalls[0].onComplete();
  const pickup = harness.messages.find(({ message }) => message.customType === "auto-compact.pickup").message;
  assert.equal(pickup.details.plan.summary, "Summary", "the pickup keeps the plan for the human view");
  assert.equal(pickup.details.plan.execution, "foreground");
  assert.doesNotMatch(pickup.content, /Summary/, "the plan view stays out of model content");
  assert.match(harness.notices.at(-1).text, /HANDOFF \(skipped\)/);
  assert.doesNotMatch(harness.notices.at(-1).text, /✓ HANDOFF/);
  assert.ok(harness.methodClaims.some((c) => !c.active && c.token === claim.token));
});

for (const execution of ["foreground", "background"]) test(`${execution} rejected plan cancels native generation and releases custody without pickup`, async () => {
  const harness = makeHarness({ strategy: { preservation: "none", method: "summary", execution } });
  let projected = [{ id: "A", type: "message", message: { role: "user", content: [{ type: "text", text: "original" }] } }];
  harness.setBranch(projected);
  harness.ctx.model.api = "anthropic-messages";
  harness.ctx.sessionManager.getSessionId = () => "session";
  harness.ctx.sessionManager.getLeafId = () => "A";
  harness.ctx.sessionManager.buildSessionProjection = () => ({ entries: projected.map(sourceEntry => ({ sourceEntry, messages: [sourceEntry.message] })) });
  harness.ctx.modelRegistry = { streamSimple: () => ({ result: async () => ({ stopReason: "stop", content: [{ type: "text", text: '{"summary":"plan","keep":[]}' }] }) }) };
  await triggerManual(harness);
  if (execution === "foreground") {
    await harness.tools.get("compaction_plan").execute("plan", { summary: "plan", keep: [] }, undefined, undefined, harness.ctx);
    harness.handlers.get("agent_settled")({}, harness.ctx);
  } else {
    harness.handlers.get("before_provider_request")({ payload: { max_tokens: 100, messages: [{ role: "user", content: [{ type: "text", text: "original" }] }] } }, harness.ctx);
    harness.handlers.get("message_update")({ message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta" } }, harness.ctx);
    await new Promise(setImmediate);
  }
  assert.equal(harness.controller.snapshot().state, "compacting");
  const claim = harness.methodClaims.find(c => c.active);
  assert.ok(claim);
  assert.deepEqual(harness.handlers.get("input")({ text: "held input", source: "interactive" }, harness.ctx), { action: "handled" });
  projected = [{ ...projected[0], message: { role: "user", content: [{ type: "text", text: "edited" }] } }];
  // Pi 1.1 reports hook exceptions and continues. Explicit cancellation is required.
  let result;
  try { result = await harness.handlers.get("session_before_compact")({ reason: "manual" }, harness.ctx); } catch {}
  assert.deepEqual(result, { cancel: true });
  assert.equal(harness.controller.snapshot().state, "idle");
  assert.equal(harness.controller.snapshot().compactionFailed, true);
  assert.equal(harness.controller.snapshot().heldCount, 0);
  assert.match(harness.controller.snapshot().lastCompaction.error, /projection changed/);
  assert.ok(harness.recoveryEntries.some(e => e.customType === "auto-compact.held-input"));
  assert.ok(harness.methodClaims.some(c => !c.active && c.token === claim.token));
  assert.equal(harness.holdSignals.at(-1).payload.active, false);
  if (execution === "background") assert.equal(harness.cachePins.at(-1).channel, "cache-goblin:unpin");
  // Late native completion/error callbacks must not create pickup or replace the failure.
  harness.compactCalls[0].onComplete();
  harness.compactCalls[0].onError(new Error("native cancellation"));
  assert.equal(harness.messages.filter(m => m.message.customType === "auto-compact.pickup").length, 0);
  assert.equal(harness.controller.snapshot().compactionFailed, true);
  if (execution === "foreground") {
    await harness.commands.get("auto-compact").handler("status", harness.ctx);
    assert.match(harness.notices.at(-1).text, /output ceiling/);
    assert.doesNotMatch(harness.notices.at(-1).text, /"caps"|compaction.reserveTokens|summary caps history/);
  }
});

test("foreground missing-plan fallback still enters the native hook lane", async () => {
  const harness = makeHarness({ strategy: { preservation: "none", method: "summary", execution: "foreground" } });
  harness.ctx.sessionManager.getSessionId = () => "session";
  harness.ctx.sessionManager.buildSessionProjection = () => ({ entries: [] });
  await triggerManual(harness);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.equal(harness.compactCalls.length, 1);
  assert.equal(harness.handlers.get("session_before_compact")({ reason: "manual" }, harness.ctx), undefined);
  assert.equal(harness.methodClaims.filter(c => c.active).length, 0);
});

for (const [name, text, stopReason, thinking] of [
  ["length termination", '{"summary":"complete looking","keep":[]}', "length"],
  ["captured instruction text", "A_OK", "stop"],
  ["trailing JSON junk", '{"summary":"plan","keep":[]} junk', "stop"],
  ["incompatible thinking budget", undefined, undefined, { type: "enabled", budget_tokens: 100 }],
]) test(`background ${name} abandons the job without compaction or pickup`, async () => {
  const harness = makeHarness({ strategy: { preservation: "none", method: "keepset", execution: "background" } });
  const sourceEntry = { id: "A", type: "message", message: { role: "user", content: [{ type: "text", text: "A_OK" }] } };
  harness.setBranch([sourceEntry]);
  harness.ctx.model.api = "anthropic-messages";
  harness.ctx.sessionManager.getSessionId = () => "session";
  harness.ctx.sessionManager.getLeafId = () => "A";
  harness.ctx.sessionManager.buildSessionProjection = () => ({ entries: [{ sourceEntry, messages: [sourceEntry.message] }] });
  let sideRequests = 0;
  harness.ctx.modelRegistry = { streamSimple: () => { sideRequests++; return { result: async () => ({ stopReason, content: [{ type: "text", text }] }) }; } };
  await triggerManual(harness);
  harness.setIdle(false);
  const payload = { max_tokens: 100, ...(thinking ? { thinking } : {}), messages: [{ role: "user", content: [{ type: "text", text: "A_OK" }] }] };
  const original = structuredClone(payload);
  harness.handlers.get("before_provider_request")({ payload }, harness.ctx);
  harness.handlers.get("message_update")({ message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta" } }, harness.ctx);
  await new Promise(setImmediate);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.equal(sideRequests, thinking ? 0 : 1);
  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.controller.snapshot().state, "idle");
  assert.equal(harness.controller.snapshot().compactionFailed, true);
  assert.equal(harness.controller.snapshot().heldCount, 0);
  assert.deepEqual(harness.cachePins.map(e => e.channel), ["cache-goblin:pin", "cache-goblin:unpin"]);
  assert.equal(harness.methodClaims.filter(c => c.active).length, 0);
  assert.equal(harness.messages.filter(m => m.message.customType === "auto-compact.pickup").length, 0);
  assert.deepEqual(payload, original);
  assert.deepEqual(harness.ctx.sessionManager.getBranch(), [sourceEntry]);
});

test("background HUD and status show request, computation, install phases and active selection", async () => {
  const harness = makeHarness({ strategy: { preservation: "none", method: "keepset", execution: "background" } });
  const sourceEntry = { id: "A", type: "message", message: { role: "user", content: [{ type: "text", text: "request" }] } };
  harness.setBranch([sourceEntry]);
  harness.ctx.model.api = "anthropic-messages";
  harness.ctx.sessionManager.getSessionId = () => "session";
  harness.ctx.sessionManager.getLeafId = () => "A";
  harness.ctx.sessionManager.buildSessionProjection = () => ({ entries: [{ sourceEntry, messages: [sourceEntry.message] }] });
  let finish;
  harness.ctx.modelRegistry = { streamSimple: () => ({ result: () => new Promise((resolve) => { finish = resolve; }) }) };
  await triggerManual(harness);
  assert.match(onlyWidgetText(harness), /PLANNING.*waiting for request/);
  await harness.commands.get("auto-compact").handler("status", harness.ctx);
  assert.match(harness.notices.at(-1).text, /phase\s+waiting for request/);
  harness.setIdle(false);
  harness.handlers.get("before_provider_request")({ payload: { max_tokens: 100, messages: [{ role: "user", content: [{ type: "text", text: "request" }] }] } }, harness.ctx);
  harness.handlers.get("message_update")({ message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta" } }, harness.ctx);
  assert.match(onlyWidgetText(harness), /PLANNING.*computing/);
  finish({ stopReason: "stop", content: [{ type: "text", text: '{"summary":"plan","keep":[]}' }] });
  await new Promise(setImmediate);
  assert.match(onlyWidgetText(harness), /PLANNING.*waiting to install/);
  assert.equal(harness.compactCalls.length, 0);
  harness.setConfiguredSettings({ preservation: "artifact-handoff", method: "native", execution: "foreground" });
  await harness.commands.get("auto-compact").handler("status", harness.ctx);
  const status = harness.notices.at(-1).text;
  assert.match(status, /next\s+native · foreground · artifact-handoff/);
  assert.match(status, /active\s+keepset · background · none/);
  assert.match(status, /phase\s+waiting to install/);
  assert.match(status, /background output cap 100/);
  assert.doesNotMatch(status, /mode cooperative handoff/);
});

test("custom foreground with skipped preservation says planning and shows model output ceiling", async () => {
  const harness = makeHarness({ strategy: { preservation: "none", method: "summary", execution: "foreground" } });
  harness.ctx.sessionManager.getSessionId = () => "session";
  harness.ctx.sessionManager.buildSessionProjection = () => ({ entries: [] });
  await triggerManual(harness);
  assert.match(onlyWidgetText(harness), /PLANNING/);
  assert.doesNotMatch(onlyWidgetText(harness), /HANDOFF|awaiting readiness/);
  await harness.commands.get("auto-compact").handler("status", harness.ctx);
  assert.match(harness.notices.at(-1).text, /output ceiling 32k \(Session request settings apply\)/);
  assert.doesNotMatch(harness.notices.at(-1).text, /configured summary caps|reload Pi.*native summary caps|mode cooperative handoff/);
});

test("background waits without input custody and off cancels its job before plain native compaction", async () => {
  const harness = makeHarness({ strategy: { preservation: "none", method: "keepset", execution: "background" } });
  harness.ctx.model.api = "anthropic-messages";
  harness.ctx.sessionManager.getSessionId = () => "session";
  harness.ctx.sessionManager.buildSessionProjection = () => ({ entries: [] });
  harness.ctx.modelRegistry = { streamSimple: () => { throw new Error("must not call planner"); } };
  await triggerManual(harness);
  assert.equal(harness.controller.snapshot().state, "ready");
  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.holdSignals.filter((s) => s.payload.active).length, 0);
  assert.equal(harness.handlers.get("input")({ text: "new user input" }, harness.ctx), undefined);
  await harness.commands.get("auto-compact").handler("off", harness.ctx);
  assert.equal(harness.controller.snapshot().state, "idle");
  await triggerAutomatic(harness);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.equal(harness.compactCalls.length, 1);
  assert.equal(harness.handlers.get("session_before_compact")({ reason: "manual" }, harness.ctx), undefined);
});

test("background artifact-handoff runs the handoff in the fork without a live handoff turn or input custody", async () => {
  const harness = makeHarness({ strategy: { preservation: "artifact-handoff", method: "keepset", execution: "background" } });
  const sourceEntry = { id: "A", type: "message", message: { role: "user", content: [{ type: "text", text: "request" }] } };
  harness.setBranch([sourceEntry]);
  harness.ctx.model.api = "anthropic-messages";
  harness.ctx.sessionManager.getSessionId = () => "session";
  harness.ctx.sessionManager.getLeafId = () => "A";
  harness.ctx.sessionManager.buildSessionProjection = () => ({ entries: [{ sourceEntry, messages: [sourceEntry.message] }] });
  let finish, sent;
  harness.ctx.modelRegistry = { streamSimple: (model, context, options) => {
    sent = options.onPayload();
    return { result: () => new Promise((resolve) => { finish = resolve; }) };
  } };
  await triggerManual(harness);
  assert.equal(harness.controller.snapshot().state, "ready");
  assert.equal(harness.messages.filter((m) => m.message.customType === "auto-compact.handoff").length, 0);
  assert.equal(harness.holdSignals.filter((s) => s.payload.active).length, 0);
  assert.equal(harness.handlers.get("input")({ text: "new user input" }, harness.ctx), undefined);
  assert.match(onlyWidgetText(harness), /HANDOFF \/ PLANNING.*waiting for request/);
  await harness.commands.get("auto-compact").handler("status", harness.ctx);
  assert.match(harness.notices.at(-1).text, /mode\s+background planning \(fork handoff record in compaction context\)/);
  harness.setIdle(false);
  harness.handlers.get("before_provider_request")({ payload: { max_tokens: 100, messages: [{ role: "user", content: [{ type: "text", text: "request" }] }] } }, harness.ctx);
  harness.handlers.get("message_update")({ message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta" } }, harness.ctx);
  assert.match(sent.messages[0].content.at(-1).text, /JSON key "handoff" \(nonempty string\)/);
  finish({ stopReason: "stop", content: [{ type: "text", text: '{"summary":"plan","keep":[],"handoff":"intent at A"}' }] });
  await new Promise(setImmediate);
  assert.match(onlyWidgetText(harness), /HANDOFF \/ PLANNING.*waiting to install/);
});

test("background rejects non-Anthropic before arming or holding", async () => {
  const harness = makeHarness({ strategy: { preservation: "none", method: "summary", execution: "background" } });
  await triggerManual(harness);
  assert.equal(harness.controller.snapshot().state, "idle");
  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.holdSignals.filter((s) => s.payload.active).length, 0);
});

test("TUI card failure falls back to an exact notice without changing the lifecycle", async () => {
  const harness = makeHarness({
    prompt: "Preserve the fallback receipt exactly.",
    setWidgetError: new Error("demo renderer unavailable"),
  });

  await triggerManual(harness);

  assert.equal(harness.controller.snapshot().state, "handoff_pending");
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].message.customType, "auto-compact.handoff");
  assert.equal(harness.widgets.size, 0);
  assertExactInstruction(
    harness.notices.at(-1).text,
    harness.messages[0].message.content,
  );
  assert.deepEqual(harness.activeTools(), ["read", PLAN_TOOL, AUTO_COMPACT_TOOL_NAME]);
});

test("Session switches reject unsafe order and default atomically without persistence", async () => {
  const h = makeHarness();
  const command = (text) => h.commands.get("auto-compact").handler(text, h.ctx);
  await command("bg");
  assert.deepEqual(h.controller.snapshot().selectionOverrides, {});
  assert.match(h.notices.at(-1).text, /method keepset then \/auto-compact bg/);
  await command("method keepset");
  assert.ok(h.activeTools().includes("compaction_plan"));
  await command("bg");
  await command("preservation none");
  const before = h.controller.snapshot();
  await command("method default");
  assert.deepEqual(h.controller.snapshot(), before);
  assert.match(h.notices.at(-1).text, /fg then \/auto-compact method default/);
  await command("status");
  assert.match(h.notices.at(-1).text, /next\s+keepset\* · background\* · none\*/);
  assert.match(h.notices.at(-1).text, /temporary: resets on \/reload or Session switch/);
  assert.doesNotMatch(h.notices.at(-1).text, /Message-less/);
  h.handlers.get("session_tree")({}, h.ctx);
  assert.deepEqual(h.controller.snapshot().selectionOverrides, before.selectionOverrides);
  await command("fg");
  await command("method default");
  assert.equal(h.controller.snapshot().settings.method, "native");
  await h.handlers.get("session_start")({}, h.ctx);
  assert.deepEqual(h.controller.snapshot().selectionOverrides, {});
  await command("method summary");
  h.handlers.get("session_shutdown")({}, h.ctx);
  assert.deepEqual(h.controller.snapshot().selectionOverrides, {});
  assert.equal(h.writes.length, 0);
  assert.equal(h.recoveryEntries.length, 0);
});

test("late Session switches cannot overwrite newer intent or cross Session replacement", async () => {
  const pending = [];
  const h = makeHarness({ settingsLoader: () => { const d = deferred(); pending.push(d); return d.promise; } });
  const command = (text) => h.commands.get("auto-compact").handler(text, h.ctx);
  const older = command("method summary");
  const newer = command("method keepset");
  pending[1].resolve({ settings: {}, errors: [] });
  await newer;
  const after = h.controller.snapshot();
  const notices = h.notices.length;
  pending[0].resolve({ settings: {}, errors: [] });
  await older;
  assert.deepEqual(h.controller.snapshot(), after);
  assert.equal(h.notices.length, notices);
  const stale = command("preservation none");
  const start = h.handlers.get("session_start")({}, h.ctx);
  pending[3].resolve({ settings: {}, errors: [] });
  await start;
  pending[2].resolve({ settings: {}, errors: [] });
  await stale;
  assert.deepEqual(h.controller.snapshot().selectionOverrides, {});
  assert.equal(h.notices.length, notices);
});

test("valid selection repairs a base combination error and re-arms a failed run", async () => {
  const h = makeHarness({ strategy: { method: "native", execution: "background" },
    settingsLoader: async () => ({ settings: { method: "native", execution: "background" }, errors: ["background requires method summary or keepset"] }) });
  await h.commands.get("auto-compact").handler("method summary", h.ctx);
  assert.deepEqual(h.controller.snapshot().settingsErrors, []);
  assert.equal(h.controller.snapshot().settings.execution, "background");
  const failed = makeHarness();
  await triggerManual(failed);
  await ready(failed);
  failed.handlers.get("agent_settled")({}, failed.ctx);
  failed.compactCalls[0].onError(new Error("failed"));
  assert.equal(failed.controller.snapshot().compactionFailed, true);
  await failed.commands.get("auto-compact").handler("status", failed.ctx);
  assert.match(failed.notices.at(-1).text, /^Auto Compact · DISARMED/);
  await failed.commands.get("auto-compact").handler("preservation none", failed.ctx);
  assert.equal(failed.controller.snapshot().compactionFailed, false);
  assert.equal(failed.controller.snapshot().thresholdArmed, true);
});

test("background job keeps its capture, claim and phase after selecting foreground", async () => {
  const h = makeHarness({ strategy: { method: "keepset", execution: "background", preservation: "none" } });
  h.ctx.model.api = "anthropic-messages";
  const sourceEntry = { id: "A", type: "message", message: { role: "user", content: [{ type: "text", text: "request" }] } };
  h.setBranch([sourceEntry]);
  h.ctx.sessionManager.getSessionId = () => "session";
  h.ctx.sessionManager.getLeafId = () => "A";
  h.ctx.sessionManager.buildSessionProjection = () => ({ entries: [{ sourceEntry, messages: [sourceEntry.message] }] });
  let finish;
  h.ctx.modelRegistry = { streamSimple: () => ({ result: () => new Promise((resolve) => { finish = resolve; }) }) };
  await triggerManual(h);
  h.setIdle(false);
  h.handlers.get("before_provider_request")({ payload: { max_tokens: 100, messages: [{ role: "user", content: [{ type: "text", text: "request" }] }] } }, h.ctx);
  h.handlers.get("message_update")({ message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta" } }, h.ctx);
  const tools = h.activeTools();
  const claims = [...h.methodClaims];
  const pins = [...h.cachePins];
  await h.commands.get("auto-compact").handler("fg", h.ctx);
  assert.deepEqual(h.activeTools(), tools);
  assert.deepEqual(h.methodClaims, claims);
  assert.deepEqual(h.cachePins, pins);
  await h.commands.get("auto-compact").handler("status", h.ctx);
  assert.match(h.notices.at(-1).text, /active\s+keepset · background · none/);
  assert.match(h.notices.at(-1).text, /phase\s+computing/);
  assert.match(h.notices.at(-1).text, /background output cap 100/);
  await new Promise(setImmediate);
  finish({ stopReason: "stop", content: [{ type: "text", text: '{"summary":"plan","keep":[]}' }] });
  await new Promise(setImmediate);
  await h.commands.get("auto-compact").handler("status", h.ctx);
  assert.match(h.notices.at(-1).text, /phase\s+waiting to install/);
  assert.equal(h.compactCalls.length, 0);
  h.handlers.get("session_shutdown")({}, h.ctx);
});

test("next-run switches leave foreground planner tools, claim and captured policy intact", async () => {
  const h = makeHarness({ strategy: { method: "keepset", preservation: "none" } });
  h.ctx.sessionManager.getSessionId = () => "session";
  h.ctx.sessionManager.buildSessionProjection = () => ({ entries: [] });
  await triggerManual(h);
  const tools = h.activeTools();
  const claims = [...h.methodClaims];
  await h.commands.get("auto-compact").handler("bg", h.ctx);
  assert.deepEqual(h.activeTools(), tools);
  assert.deepEqual(h.methodClaims, claims);
  assert.equal(h.controller.snapshot().state, "handoff_pending");
  await h.commands.get("auto-compact").handler("status", h.ctx);
  assert.match(h.notices.at(-1).text, /next\s+keepset · background\* · none/);
  assert.match(h.notices.at(-1).text, /active\s+keepset · foreground · none/);
  assert.match(h.notices.at(-1).text, /output ceiling 32k/);
  assert.doesNotMatch(h.notices.at(-1).text, /background output cap/);
});

test("agent start during a background run keeps the run's tools after selecting foreground", async () => {
  const h = makeHarness({ strategy: { preservation: "none", method: "keepset", execution: "background" } });
  const sourceEntry = { id: "A", type: "message", message: { role: "user", content: [{ type: "text", text: "A_OK" }] } };
  h.setBranch([sourceEntry]);
  h.ctx.model.api = "anthropic-messages";
  h.ctx.sessionManager.getSessionId = () => "session";
  h.ctx.sessionManager.getLeafId = () => "A";
  h.ctx.sessionManager.buildSessionProjection = () => ({ entries: [{ sourceEntry, messages: [sourceEntry.message] }] });
  h.ctx.modelRegistry = { streamSimple: () => ({ result: () => new Promise(() => {}) }) };
  await triggerManual(h);
  assert.ok(h.controller.snapshot().lifecycle);
  const tools = h.activeTools();
  await h.commands.get("auto-compact").handler("fg", h.ctx);
  await h.handlers.get("before_agent_start")({}, h.ctx);
  assert.deepEqual(h.activeTools(), tools);
  assert.ok(h.activeTools().includes(PLAN_TOOL));
});

test("a settings load that a switch overtakes reloads the committed selection", async () => {
  const loads = [];
  const h = makeHarness({ settingsLoader: () => { const d = deferred(); loads.push(d); return d.promise; } });
  const saved = () => ({ settings: { enabled: true, threshold: 90, pre_compact_prompt: "p", method: "keepset", execution: "foreground", preservation: "none" }, errors: [] });
  const starting = h.handlers.get("before_agent_start")({}, h.ctx);
  const switching = h.commands.get("auto-compact").handler("bg", h.ctx);
  await new Promise(setImmediate);
  assert.equal(loads.length, 2);
  loads[1].resolve(saved());
  await switching;
  assert.ok(h.activeTools().includes(PLAN_TOOL));
  loads[0].resolve(saved());
  await new Promise(setImmediate);
  assert.equal(loads.length, 3);
  loads[2].resolve(saved());
  await starting;
  assert.ok(h.activeTools().includes(PLAN_TOOL));
  assert.equal(h.controller.snapshot().settings.execution, "background");
});

for (const execution of ['foreground', 'background']) test(`${execution} summary installation uses the held user pickup path`, async () => {
  const h = makeHarness({ autoAdmission: false, timers: fakeTimers(),
    strategy: { preservation: 'none', method: 'summary', execution } });
  const sourceEntry = { id: 'A', type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Request' }] } };
  h.setBranch([sourceEntry]);
  h.ctx.model.api = 'anthropic-messages';
  h.ctx.sessionManager.getSessionId = () => 'source';
  h.ctx.sessionManager.getLeafId = () => 'A';
  h.ctx.sessionManager.buildSessionProjection = () => ({ entries: [{ sourceEntry, messages: [sourceEntry.message] }] });
  h.ctx.modelRegistry = { streamSimple: () => ({ result: async () => ({ stopReason: 'stop',
    content: [{ type: 'text', text: '{"summary":"State","keep":[]}' }] }) }) };
  await triggerManual(h);
  if (execution === 'foreground') {
    await h.tools.get(PLAN_TOOL).execute('plan', { summary: 'State', keep: [] }, undefined, undefined, h.ctx);
  } else {
    h.setIdle(false);
    h.handlers.get('before_provider_request')({ payload: { max_tokens: 100, messages: [{ role: 'user', content: [{ type: 'text', text: 'Request' }] }] } }, h.ctx);
    h.handlers.get('message_update')({ message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta' } }, h.ctx);
    await new Promise(setImmediate);
  }
  h.setIdle(true);
  h.handlers.get('agent_settled')({}, h.ctx);
  assert.equal(h.controller.snapshot().state, 'compacting');
  capture(h, 'Installation input');
  await h.handlers.get('session_before_compact')({ reason: 'manual' }, h.ctx);
  h.compactCalls[0].onComplete();
  const pickup = h.messages.at(-1);
  assert.deepEqual(pickup.options, { triggerTurn: false });
  assert.deepEqual(h.userMessages, ['Installation input']);
  assert.equal(h.controller.snapshot().heldCount, 1);
  h.handlers.get('context')({ messages: [{ ...pickup.message, role: 'custom' },
    { role: 'user', content: 'Installation input' }] }, h.ctx);
  assert.equal(h.controller.snapshot().heldCount, 0);
  assert.equal(h.holdSignals.at(-1).payload.active, false);
});

for (const busy of [false, true]) test(`real Pi held pickup uses one run and ordered user records (${busy ? 'busy' : 'idle'})`, { timeout: 10000 }, async () => {
  const harness = makeHarness({ autoAdmission: false, timers: fakeTimers() });
  await triggerManual(harness);
  const image = { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', mimeType: 'image/png' };
  capture(harness, 'Repeated input', 'interactive', [image]);
  capture(harness, 'Repeated input');
  capture(harness, 'Image input', 'rpc', [image]);
  await ready(harness);
  harness.handlers.get('agent_settled')({}, harness.ctx);
  const runtime = await heldRuntime(harness, { busy });
  try {
    harness.compactCalls[0].onComplete();
    assert.equal(harness.controller.snapshot().heldCount, 3, 'pickup alone cannot release held custody');
    assert.equal(harness.holdSignals.at(-1).payload.active, true);
    runtime.release();
    await runtime.idle();
    assert.deepEqual(runtime.errors, []);
    assert.equal(runtime.events.filter(event => event.type === 'agent_start').length, 1);
    const users = runtime.session.sessionManager.getBranch().filter(entry => entry.type === 'message' && entry.message.role === 'user').map(entry => entry.message);
    assert.deepEqual(users.slice(busy ? 1 : 0).map(message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')),
      ['Repeated input', 'Repeated input', '[via rpc]\nImage input']);
    assert.deepEqual(users[busy ? 1 : 0].content.filter(block => block.type === 'image'), [image]);
    assert.deepEqual(users[busy ? 2 : 1].content.filter(block => block.type === 'image'), []);
    assert.deepEqual(users.at(-1).content.filter(block => block.type === 'image'), [image]);
    const record = renderRarebitRecord(runtime.session.sessionManager.getBranch(), { budgetTokens: 12000 });
    assert.match(record.text, /\[USER\]\nRepeated input/);
    assert.match(record.text, /\[USER\]\n\[via rpc\]\nImage input/);
    assert.doesNotMatch(record.text, /Auto Compact pickup:/);
    assert.equal(harness.controller.snapshot().heldCount, 0);
    assert.equal(harness.controller.snapshot().state, 'idle');
    assert.equal(harness.holdSignals.at(-1).payload.active, false);
    assert.ok(runtime.events.some(event => event.type === 'context' && event.held === 0));
    assert.deepEqual(harness.recoveryEntries, []);
  } finally { runtime.close(); }
});

for (const failure of ['handled', 'transformed', 'rejected', 'partial']) test(`real Pi ${failure} held delivery stays recoverable`, { timeout: 10000 }, async () => {
  const timers = fakeTimers();
  const harness = makeHarness({ autoAdmission: false, timers });
  await triggerManual(harness);
  capture(harness, 'First held');
  capture(harness, 'Second held');
  await ready(harness);
  harness.handlers.get('agent_settled')({}, harness.ctx);
  const runtime = await heldRuntime(harness, {
    handle: failure === 'handled' ? 'First held' : failure === 'partial' ? 'Second held' : undefined,
    transform: failure === 'transformed' ? 'First held' : undefined,
    reject: failure === 'rejected',
  });
  try {
    harness.compactCalls[0].onComplete();
    await runtime.idle();
    assert.equal(harness.controller.snapshot().heldCount, failure === 'partial' ? 1 : 2);
    timers.fire(5000);
    assert.equal(harness.controller.snapshot().state, 'idle');
    assert.equal(harness.holdSignals.at(-1).payload.active, false);
    assert.equal(harness.ctx.ui.getEditorText(), failure === 'partial' ? 'Second held' : 'First held\n\nSecond held');
    assert.equal(harness.recoveryEntries.at(-1).customType, 'auto-compact.held-input');
    if (failure === 'rejected') assert.ok(runtime.errors.some(error => error.event === 'send_user_message'));
  } finally { runtime.close(); }
});

for (const boundary of ['session_start', 'session_tree']) test(`${boundary} fences unsent held tail and recovers the original target's text`, async () => {
  const harness = makeHarness({ autoAdmission: false, timers: fakeTimers() });
  await triggerManual(harness);
  capture(harness, 'first'); capture(harness, 'second'); capture(harness, 'third');
  await ready(harness);
  harness.handlers.get('agent_settled')({}, harness.ctx);
  harness.compactCalls[0].onComplete();
  const custom = { ...harness.messages.at(-1).message, role: 'custom' };
  harness.handlers.get('message_start')({ message: custom }, harness.ctx);
  harness.handlers.get('context')({ messages: [custom, { role: 'user', content: 'first' }] }, harness.ctx);
  const send = harness.pi.sendUserMessage;
  let switching;
  harness.pi.sendUserMessage = (content, options) => {
    send(content, options);
    switching = harness.handlers.get(boundary)({}, harness.ctx);
  };
  harness.handlers.get('message_start')({ message: { role: 'user', content: 'first' } }, harness.ctx);
  await switching;
  assert.deepEqual(harness.userMessages, ['first', 'second']);
  assert.equal(harness.ctx.ui.getEditorText(), 'second\n\nthird');
  assert.equal(harness.recoveryEntries.length, 0, 'the source Session is no longer current');
  assert.equal(harness.controller.snapshot().heldCount, 0);
  assert.equal(harness.holdSignals.at(-1).payload.active, false);
});

test('duplicate held text requires two distinct records across context events', async () => {
  const harness = makeHarness({ autoAdmission: false, timers: fakeTimers() });
  await triggerManual(harness);
  capture(harness, 'same'); capture(harness, 'same');
  await ready(harness);
  harness.handlers.get('agent_settled')({}, harness.ctx);
  harness.compactCalls[0].onComplete();
  const custom = { ...harness.messages.at(-1).message, role: 'custom' };
  const user = { role: 'user', content: 'same' };
  for (let i = 0; i < 2; i++) {
    harness.handlers.get('context')({ messages: [custom, user] }, harness.ctx);
    assert.equal(harness.controller.snapshot().heldCount, 1);
    assert.equal(harness.holdSignals.at(-1).payload.active, true);
  }
  harness.handlers.get('context')({ messages: [custom, user, { ...user }] }, harness.ctx);
  assert.equal(harness.controller.snapshot().heldCount, 0);
  assert.equal(harness.holdSignals.at(-1).payload.active, false);
});

for (const toolName of [PLAN_TOOL, AUTO_COMPACT_TOOL_NAME]) test(`${toolName} idle refusal tells the model to continue work`, async () => {
  const h = makeHarness({ enabled: false });
  const result = await h.tools.get(toolName).execute('idle', { summary: 'Unused', keep: [] }, undefined, undefined, h.ctx);
  assert.equal(result.content[0].text, 'No Auto Compact compaction is pending. Continue your current work. Do not call this tool again until an Auto Compact notice asks for it.');
  assert.equal(result.details.status, 'ignored');
  assert.notEqual(result.terminate, true);
  assert.equal(h.controller.snapshot().state, 'idle');
  assert.equal(h.compactCalls.length, 0);
});

test('plan refusal during native handoff names the readiness tool and preserves pending state', async () => {
  const h = makeHarness();
  await triggerManual(h);
  const result = await h.tools.get(PLAN_TOOL).execute('wrong-plan', { summary: 'Unused', keep: [] }, undefined, undefined, h.ctx);
  assert.equal(result.content[0].text, 'This compaction uses auto_compact_ready. Follow the handoff notice and call auto_compact_ready.');
  assert.equal(result.details.status, 'ignored');
  assert.notEqual(result.terminate, true);
  assert.equal(h.controller.snapshot().state, 'handoff_pending');
  assert.equal(h.compactCalls.length, 0);
  assert.equal((await ready(h)).details.status, 'accepted');
  assert.equal(h.controller.snapshot().state, 'ready');
});

test('empty foreground summary refusal identifies the argument problem and permits correction', async () => {
  const h = makeHarness({ strategy: { method: 'summary', execution: 'foreground', preservation: 'none' } });
  h.ctx.sessionManager.getSessionId = () => 'session';
  h.ctx.sessionManager.buildSessionProjection = () => ({ entries: [] });
  h.ctx.modelRegistry = { streamSimple: () => { throw new Error('Foreground planning must not fork'); } };
  await triggerManual(h);
  const planTool = h.tools.get(PLAN_TOOL);
  const result = await planTool.execute('empty-plan', { summary: ' \n\t', keep: [] }, undefined, undefined, h.ctx);
  assert.equal(result.content[0].text, 'The summary was empty. Call compaction_plan again with a nonempty summary.');
  assert.equal(result.details.status, 'ignored');
  assert.notEqual(result.terminate, true);
  assert.equal(h.controller.snapshot().state, 'handoff_pending');
  assert.equal(h.compactCalls.length, 0);
  const corrected = await planTool.execute('corrected-plan', { summary: 'State', keep: [] }, undefined, undefined, h.ctx);
  assert.equal(corrected.details.status, 'accepted');
  assert.equal(h.controller.snapshot().state, 'ready');
});

test('readiness refusal during foreground plan names the plan tool and preserves pending state', async () => {
  const h = makeHarness({ strategy: { method: 'summary', execution: 'foreground', preservation: 'none' } });
  h.ctx.sessionManager.getSessionId = () => 'session';
  h.ctx.sessionManager.buildSessionProjection = () => ({ entries: [] });
  h.ctx.modelRegistry = { streamSimple: () => { throw new Error('Foreground planning must not fork'); } };
  await triggerManual(h);
  const result = await ready(h);
  assert.equal(result.content[0].text, 'This compaction needs a plan. Call compaction_plan with summary and keep.');
  assert.equal(result.details.status, 'ignored');
  assert.equal(result.terminate, false);
  assert.equal(h.controller.snapshot().state, 'handoff_pending');
  assert.equal(h.compactCalls.length, 0);
  const plan = await h.tools.get(PLAN_TOOL).execute('right-plan', { summary: 'State', keep: [] }, undefined, undefined, h.ctx);
  assert.equal(plan.details.status, 'accepted');
  assert.equal(h.controller.snapshot().state, 'ready');
});

for (const [phase, text] of [
  ['queued', 'Auto Compact is queued. Continue your current work until its handoff notice arrives.'],
  ['ready', 'Auto Compact has received its final action. End your turn now without a reply. Do not call this tool again.'],
  ['compacting', 'Auto Compact is installing the compaction. Wait for pickup. Do not call this tool again.'],
  ['pickup', 'Auto Compact is resuming work. Follow the pickup message. Do not call this tool again.'],
]) test(`${phase} refusal explains the current phase without repeating a final action`, async () => {
  const h = makeHarness({ idle: phase !== 'queued', autoAdmission: false, timers: fakeTimers() });
  await triggerManual(h);
  if (phase !== 'queued') await ready(h);
  if (['compacting', 'pickup'].includes(phase)) h.handlers.get('agent_settled')({}, h.ctx);
  if (phase === 'pickup') h.compactCalls[0].onComplete();
  assert.equal(h.controller.snapshot().state, phase);
  for (const toolName of [PLAN_TOOL, AUTO_COMPACT_TOOL_NAME]) {
    const result = await h.tools.get(toolName).execute('repeated', { summary: 'Unused', keep: [] }, undefined, undefined, h.ctx);
    assert.equal(result.content[0].text, text);
    assert.equal(result.details.status, 'ignored');
    assert.notEqual(result.terminate, true);
    assert.equal(h.controller.snapshot().state, phase);
  }
});

test("background status reports no output cap for a Codex model", async () => {
  const h = makeHarness({ strategy: { preservation: "none", method: "keepset", execution: "background" } });
  h.ctx.model.api = "openai-codex-responses";
  await h.commands.get("auto-compact").handler("status", h.ctx);
  assert.match(h.notices.at(-1).text, /background output cap none \(provider default\)/);
  h.ctx.model.api = "openai-responses";
  await h.commands.get("auto-compact").handler("status", h.ctx);
  assert.match(h.notices.at(-1).text, /background output cap \d/);
});
