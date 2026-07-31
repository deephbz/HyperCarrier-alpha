import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_COMPACT_TOOL_NAME,
  AUTO_COMPACT_WIDGET_KEY,
  buildPreCompactPrompt,
  createAutoCompactController,
  utilizationAtOrAboveThreshold,
} from "../src/controller.mjs";

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
} = {}) {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const messages = [];
  const userMessages = [];
  const deliveries = [];
  const notices = [];
  const widgetCalls = [];
  const widgets = new Map();
  const debug = [];
  const compactCalls = [];
  const writes = [];
  let currentUsage = usage;
  let currentActiveTools = [...activeTools];
  let currentlyIdle = idle;
  let currentlyHasPendingMessages = pendingMessages;
  const configuredSettings = {
    enabled,
    threshold,
    pre_compact_prompt: prompt,
  };

  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
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
    sendUserMessage(prompt) {
      if (sendUserMessageError) throw sendUserMessageError;
      userMessages.push(prompt);
      deliveries.push({ kind: "user", prompt });
    },
  };
  const ctx = {
    cwd: "/test/project",
    hasUI: true,
    mode: "tui",
    isProjectTrusted: () => true,
    ui: {
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
      compactCalls.push(options);
    },
  };
  const load =
    settingsLoader ??
    (async () => ({
      settings: { ...configuredSettings },
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
    onDebug: (event) => debug.push(event),
  });

  return {
    handlers,
    commands,
    tools,
    messages,
    userMessages,
    deliveries,
    notices,
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
    /lifecycle(?:Id)?|runId|contextWindow|startedAt|handoff #\d+|provenance|tokens=|reason=|error=|\d{4}-\d{2}-\d{2}T\d{2}:/i,
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
  assert.equal(
    content.length,
    1,
    "HUD must use exactly one text entry",
  );
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
  assert.match(prompt, /using only information already present in this Session/i);
  assert.match(prompt, /immediately write or update the minimum durable/i);
  assert.match(prompt, /only already-known paths and safe write or edit operations/i);
  assert.match(prompt, /if no safe durable update is possible.*do not inspect/i);
  assert.match(prompt, /no-inspection rule takes precedence/i);
  assert.ok(
    prompt.lastIndexOf("no-inspection rule") >
      prompt.indexOf("Read the project status first"),
    "the framework-owned restriction must follow and override configurable guidance",
  );
  assert.match(
    prompt,
    /minimal preservation write is complete, or no safe write is possible, call auto_compact_ready/i,
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
  assert.deepEqual(message.details, { projection: "handoff" });
  assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
  assert.match(message.content, /approaching the configured limit/i);
  assert.match(message.content, /native compaction/i);
  assert.match(message.content, /durable Evergreen\/work artifacts/i);
  assert.match(message.content, /do not gather more context/i);
  assert.match(message.content, /do not read files, search, browse/i);
  assert.match(message.content, /auto_compact_ready with no arguments/i);
  assert.match(
    message.content,
    /applies only while auto_compact_ready is available/i,
  );
  assert.match(message.content, /if that tool is unavailable, ignore/i);
  assert.match(message.content, /active experiment receipt/);
  assert.deepEqual(harness.activeTools(), ["read", AUTO_COMPACT_TOOL_NAME]);
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
  assert.deepEqual(harness.activeTools(), ["read", AUTO_COMPACT_TOOL_NAME]);
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
  assert.deepEqual(harness.activeTools(), ["read", AUTO_COMPACT_TOOL_NAME]);

  const prematureReady = await ready(harness);
  assert.equal(prematureReady.details.status, "ignored");
  assert.equal(prematureReady.terminate, false);
  assert.equal(harness.controller.snapshot().state, "queued");

  harness.handlers.get("message_start")(
    { message: { role: "custom", ...queued.message } },
    harness.ctx,
  );
  assert.equal(harness.controller.snapshot().state, "handoff_pending");
  assert.deepEqual(harness.activeTools(), ["read", AUTO_COMPACT_TOOL_NAME]);
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
  assert.deepEqual(harness.activeTools(), ["read", AUTO_COMPACT_TOOL_NAME]);
});

test("a queued manual handoff removed before delivery terminates without compacting", async () => {
  const harness = makeHarness({ idle: false });
  await triggerManual(harness);
  assert.equal(harness.controller.snapshot().state, "queued");

  harness.handlers.get("agent_settled")({}, harness.ctx);

  assert.equal(harness.controller.snapshot().state, "idle");
  assert.deepEqual(harness.activeTools(), ["read"]);
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
  assert.deepEqual(harness.activeTools(), ["read"]);

  harness.handlers.get("context")(
    { messages: [{ role: "custom", ...queued }] },
    harness.ctx,
  );
  assert.equal(harness.controller.snapshot().state, "idle");
  assert.deepEqual(harness.activeTools(), ["read"]);
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
    assert.deepEqual(handoff.message.details, { projection: "handoff" });
    assert.equal(
      handoff.message.content,
      buildPreCompactPrompt("Preserve the exact current work."),
    );
    assert.deepEqual(handoff.options, { triggerTurn: true, deliverAs: "steer" });
    assertCompactHud(
      harness,
      `AUTO COMPACT · ${scenario.trigger} · HANDOFF — awaiting readiness`,
    );
    assert.doesNotMatch(onlyWidgetText(harness), /preserv|outcome|instruction|\n/i);

    await ready(harness);
    assertCompactHud(
      harness,
      `AUTO COMPACT · ${scenario.trigger} · READY — awaiting turn end`,
    );
    harness.handlers.get("agent_settled")({}, harness.ctx);
    assertCompactHud(harness, `AUTO COMPACT · ${scenario.trigger} · COMPACTING`);

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
    assertExactInstruction(harness.notices.at(-1).text, handoff.message.content);
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

test("session start removes a ready tool that Pi activated during registration", () => {
  const harness = makeHarness({
    activeTools: ["read", AUTO_COMPACT_TOOL_NAME],
  });
  harness.handlers.get("session_start")({}, harness.ctx);
  assert.deepEqual(harness.activeTools(), ["read"]);
  assert.equal(harness.controller.snapshot().state, "idle");
});

test("human command reports status, persists valid changes, and rejects invalid input", async () => {
  const harness = makeHarness();
  const command = harness.commands.get("auto-compact");
  assert.match(
    command.description,
    /status\|on\|off\|threshold <percent>\|run/,
  );

  await command.handler("status", harness.ctx);
  assert.match(harness.notices.at(-1).text, /is on at 90%/i);
  assert.match(harness.notices.at(-1).text, /context 90%/i);

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
  assert.match(harness.notices.at(-1).text, /greater than 1 and less than 110/i);

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
  assert.equal(harness.activeTools().includes(AUTO_COMPACT_TOOL_NAME), false);
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
  assert.deepEqual(harness.activeTools(), ["read"]);

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
  assert.deepEqual(pickups[0].message.details, { projection: "pickup" });
  assert.deepEqual(pickups[0].options, { triggerTurn: true });
  assert.equal(
    pickups[0].message.content,
    "Auto Compact finished Pi's native compaction. Resume the prior request if work remains; if the request is complete, stop normally.",
  );
  assert.match(harness.notices.at(-1).text, /pickup instruction requested/i);
  assert.doesNotMatch(harness.notices.at(-1).text, /pickup instruction sent/i);
  assert.equal(harness.controller.snapshot().state, "idle");
  assert.deepEqual(harness.activeTools(), ["read"]);
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
    { kind: "custom", message: pickup.message, options: { triggerTurn: false } },
    { kind: "user", prompt },
  ]);
  assert.match(harness.notices.at(-1).text, /prompted continuation requested/i);
  assert.doesNotMatch(harness.notices.at(-1).text, /prompted continuation sent/i);
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
  assert.deepEqual(
    harness.messages.at(-1).options,
    { triggerTurn: false },
  );
  const stages = lifecycleStages(harness.notices.at(-1).text);
  assert.match(stages.pickup, /×.*failed/i);
  assert.doesNotMatch(harness.notices.at(-1).text, /prompted continuation sent/i);
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
  assert.doesNotMatch(asynchronous.notices.at(-1).text, /provider refused/);
  assertLifecycleWidgetCleared(asynchronous);

  const synchronous = makeHarness();
  synchronous.ctx.compact = () => {
    throw new Error("compact unavailable");
  };
  await triggerManual(synchronous);
  await ready(synchronous);
  synchronous.handlers.get("agent_settled")({}, synchronous.ctx);
  assert.equal(synchronous.controller.snapshot().state, "idle");
  assert.match(synchronous.notices.at(-1).text, /failed/i);
  assert.doesNotMatch(synchronous.notices.at(-1).text, /compact unavailable/);
  assertLifecycleWidgetCleared(synchronous);
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
  assert.doesNotMatch(failure, /native compactor failed/);
  assertNoUiDiagnostics(failure);
  assertLifecycleWidgetCleared(harness);
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

test("an agent that never calls ready remains pending and is never force-compacted", async () => {
  const harness = makeHarness();
  await triggerAutomatic(harness);
  const handoffMessage = harness.messages[0].message;
  const noticeCount = harness.notices.length;
  for (let index = 0; index < 3; index += 1)
    harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.equal(harness.controller.snapshot().state, "handoff_pending");
  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.activeTools().includes(AUTO_COMPACT_TOOL_NAME), true);
  assert.equal(
    harness.notices.length,
    noticeCount,
    "waiting has no timeout or synthetic transition",
  );

  await harness.commands.get("auto-compact").handler("status", harness.ctx);
  const status = harness.notices.at(-1).text;
  assert.match(status, /current/i);
  const stages = lifecycleStages(status);
  assert.match(stages.handoff, /●.*active/i);
  assert.match(stages.compact, /○/);
  assert.match(stages.pickup, /○/);
  assertExactInstruction(status, handoffMessage.content);
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
  assert.deepEqual(harness.activeTools(), ["read"]);
  assert.match(harness.notices.at(-1).text, /separate native Pi compaction/i);
  assert.equal((await ready(harness)).details.status, "ignored");
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
    assert.deepEqual(harness.activeTools(), ["read"]);
    assert.equal(harness.notices.length, 2);
    const interruptedNotice = harness.notices.at(-1).text;
    const interruptedStages = lifecycleStages(interruptedNotice);
    assert.match(interruptedStages.handoff, /↷.*interrupted/i);
    assert.match(interruptedStages.compact, /—/);
    assert.match(interruptedStages.pickup, /—/);
    assertNoUiDiagnostics(interruptedNotice);
    assert.equal(harness.widgets.size, 1, "external resolution keeps its card visible");
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
      "The earlier Auto Compact handoff is no longer active because a separate native Pi compaction finished. Ignore that earlier handoff notice and its readiness instruction. Resume the prior request if work remains; if the request is complete, stop normally.",
      scenario.reason,
    );
    assert.equal(harness.controller.snapshot().state, "idle");
    assert.deepEqual(harness.activeTools(), ["read"]);
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
    assert.deepEqual(harness.activeTools(), ["read"]);
    const interruptedStages = lifecycleStages(harness.notices.at(-1).text);
    assert.match(interruptedStages.handoff, /✓/);
    assert.doesNotMatch(interruptedStages.handoff, /↷|interrupted/i);
    assert.match(interruptedStages.compact, /↷.*interrupted/i);
    assert.match(interruptedStages.pickup, /—/);
    assert.equal(harness.widgets.size, 1, "external resolution keeps its card visible");

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
  assert.deepEqual(pickups[0].message.details, { projection: "pickup" });
  assert.deepEqual(pickups[0].options, { triggerTurn: true });
  assert.equal(harness.controller.snapshot().state, "idle");
  assert.deepEqual(harness.activeTools(), ["read"]);
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
    assert.deepEqual(pending.activeTools(), ["read"], event);
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
    assert.deepEqual(harness.activeTools(), ["read"]);
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
    const off = harness.commands.get("auto-compact").handler("off", harness.ctx);
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
      const off = harness.commands.get("auto-compact").handler("off", harness.ctx);
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
      assert.equal(onlyWidgetText(harness), cardBeforeWrite, `${event} ${outcome}`);
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
  assert.deepEqual(harness.activeTools(), ["read"]);
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
  assert.deepEqual(harness.activeTools(), ["read"]);
  assert.equal(
    harness.messages.filter(
      ({ message }) => message.customType === "auto-compact.pickup",
    ).length,
    1,
  );
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
  assert.deepEqual(harness.activeTools(), ["read", AUTO_COMPACT_TOOL_NAME]);
});
