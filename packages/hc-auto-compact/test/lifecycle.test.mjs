import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_COMPACT_TOOL_NAME,
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
  notifyError,
  setWidgetError,
} = {}) {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const messages = [];
  const notices = [];
  const widgetCalls = [];
  const widgets = new Map();
  const debug = [];
  const compactCalls = [];
  const writes = [];
  let currentUsage = usage;
  let currentActiveTools = [...activeTools];
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
  };
}

async function triggerAutomatic(harness) {
  await harness.handlers.get("turn_end")({}, harness.ctx);
}

async function triggerManual(harness) {
  await harness.commands.get("auto-compact").handler("run", harness.ctx);
}

async function ready(harness) {
  return harness.tools
    .get(AUTO_COMPACT_TOOL_NAME)
    .execute(`call-${Date.now()}`, {}, undefined, undefined, harness.ctx);
}

function assertVisibleHandoffReceipt(harness, { pathPattern, customGuidance }) {
  const handoff = harness.messages.find(
    ({ message }) => message.customType === "auto_compact_handoff",
  );
  assert.ok(handoff, "hidden handoff message was not sent");
  const notice = harness.notices.at(-1);
  assert.ok(notice, "visible handoff summary was not shown");
  assert.equal(notice.level, "info");
  assert.doesNotMatch(
    notice.text,
    /framework-generated hidden context/,
    "the transient notice must not duplicate the persistent prompt",
  );

  const card = onlyWidgetText(harness);
  const delimiter =
    "Agent instruction (framework-generated hidden context; not user input):\n";
  const delimiterIndex = card.indexOf(delimiter);
  assert.notEqual(delimiterIndex, -1, "card must label the agent instruction");
  const visibleSummary = card.slice(0, delimiterIndex);
  const projectedInstruction = card.slice(delimiterIndex + delimiter.length);
  assert.match(visibleSummary, pathPattern);
  assert.match(visibleSummary, /waiting/i);
  assert.match(visibleSummary, /preserv/i);
  assert.match(visibleSummary, /report.*ready/i);
  assert.equal(
    projectedInstruction,
    handoff.message.content,
    "visible receipt must project the exact hidden instruction",
  );
  assert.ok(
    projectedInstruction.includes(customGuidance),
    "configured preservation guidance must survive in both projections",
  );
  assert.doesNotMatch(
    card,
    /lifecycle(?:Id)?|contextWindow|startedAt|handoff #\d+/i,
  );
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

function assertExactCardInstruction(text, hiddenContent) {
  const delimiter =
    "Agent instruction (framework-generated hidden context; not user input):\n";
  const delimiterIndex = text.indexOf(delimiter);
  assert.notEqual(
    delimiterIndex,
    -1,
    "persistent card must label the hidden agent instruction",
  );
  assert.equal(
    text.slice(delimiterIndex + delimiter.length),
    hiddenContent,
    "card instruction suffix must equal the hidden message byte-for-byte",
  );
}

function onlyWidgetText(harness) {
  assert.equal(harness.widgets.size, 1, "one persistent Auto Compact card");
  const [{ content }] = [...harness.widgets.values()];
  assert.ok(Array.isArray(content), "persistent card must use text lines");
  assert.equal(
    content.length,
    1,
    "exact prompt must use one multiline component below Pi's array cap",
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

test("automatic crossing starts one hidden handoff with fixed preservation semantics", async () => {
  const harness = makeHarness({
    prompt: "Also record the active experiment receipt.",
  });
  await Promise.all([triggerAutomatic(harness), triggerAutomatic(harness)]);

  assert.equal(harness.messages.length, 1);
  const [{ message, options }] = harness.messages;
  assert.equal(message.customType, "auto_compact_handoff");
  assert.equal(message.display, false);
  assert.deepEqual(message.details, { projection: "handoff" });
  assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
  assert.match(message.content, /approaching the configured limit/i);
  assert.match(message.content, /native compaction/i);
  assert.match(message.content, /durable Evergreen\/work artifacts/i);
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
  assert.equal(harness.messages[0].message.customType, "auto_compact_handoff");
  assert.equal(harness.controller.snapshot().lifecycle.trigger, "manual");
  assert.match(harness.notices.at(-1).text, /AUTO COMPACT · MANUAL/);
});

test("automatic and manual handoffs show exact visible receipts for the hidden instruction", async () => {
  const automaticGuidance =
    "Record the automatic experiment receipt before reporting ready.";
  const automatic = makeHarness({ prompt: automaticGuidance });
  await triggerAutomatic(automatic);
  assertVisibleHandoffReceipt(automatic, {
    pathPattern: /AUTO COMPACT · AUTOMATIC/,
    customGuidance: automaticGuidance,
  });

  const manualGuidance =
    "Record the manual experiment receipt before reporting ready.";
  const manual = makeHarness({ enabled: false, prompt: manualGuidance });
  await triggerManual(manual);
  assertVisibleHandoffReceipt(manual, {
    pathPattern: /AUTO COMPACT · MANUAL/,
    customGuidance: manualGuidance,
  });
});

test("automatic and manual UI progress from HANDOFF through COMPACT to PICKUP and retain a last-run receipt", async () => {
  for (const scenario of [
    {
      path: "automatic",
      start: triggerAutomatic,
      heading: /threshold|automatic/i,
    },
    { path: "manual", start: triggerManual, heading: /manual/i },
  ]) {
    const guidance = `Preserve the ${scenario.path} visual receipt exactly.`;
    const harness = makeHarness({
      enabled: scenario.path !== "manual",
      prompt: guidance,
    });
    await scenario.start(harness);
    assert.equal(harness.notices.length, 1);
    const handoffMessage = harness.messages.find(
      ({ message }) => message.customType === "auto_compact_handoff",
    ).message;

    const startedNotice = harness.notices.at(-1).text;
    assert.doesNotMatch(
      startedNotice,
      /framework-generated hidden context/,
      "the persistent card is the sole full-prompt receipt in TUI mode",
    );
    const started = onlyWidgetText(harness);
    assert.match(started, /AUTO COMPACT · (AUTOMATIC|MANUAL)/);
    assert.match(started, scenario.heading);
    const startedStages = lifecycleStages(started);
    assert.match(startedStages.handoff, /●.*active/i);
    assert.match(started, /waiting.*ready/i);
    assert.match(startedStages.compact, /○/);
    assert.match(startedStages.pickup, /○/);
    assert.equal((started.match(/\bactive\b/gi) ?? []).length, 1);
    assertExactInstruction(started, handoffMessage.content);
    assertNoUiDiagnostics(started);

    harness.setConfiguredPrompt("Later configuration must not rewrite a run.");
    await harness.commands.get("auto-compact").handler("status", harness.ctx);
    assert.equal(harness.notices.length, 2);
    const currentStatus = harness.notices.at(-1).text;
    assert.match(currentStatus, /current/i);
    const currentStages = lifecycleStages(currentStatus);
    assert.match(currentStages.handoff, /●.*active/i);
    assert.match(currentStages.compact, /○/);
    assert.match(currentStages.pickup, /○/);
    assertExactInstruction(currentStatus, handoffMessage.content);
    assert.doesNotMatch(currentStatus, /Later configuration/);
    assertNoUiDiagnostics(currentStatus);

    await ready(harness);
    harness.handlers.get("agent_settled")({}, harness.ctx);
    assert.equal(harness.notices.length, 3);
    const compacting = harness.notices.at(-1).text;
    const compactingStages = lifecycleStages(compacting);
    assert.match(compactingStages.handoff, /✓/);
    assert.match(compactingStages.compact, /●.*active/i);
    assert.match(compactingStages.pickup, /○/);
    assert.equal((compacting.match(/\bactive\b/gi) ?? []).length, 1);
    assertNoUiDiagnostics(compacting);

    harness.compactCalls[0].onComplete();
    assert.equal(harness.notices.length, 4);
    const completed = harness.notices.at(-1).text;
    const completedStages = lifecycleStages(completed);
    assert.match(completedStages.handoff, /✓/);
    assert.match(completedStages.compact, /✓/);
    assert.match(completedStages.pickup, /✓/);
    assert.match(completed, /resume.*unfinished|stop normally/i);
    assertNoUiDiagnostics(completed);

    await harness.commands.get("auto-compact").handler("status", harness.ctx);
    assert.equal(harness.notices.length, 5);
    const lastStatus = harness.notices.at(-1).text;
    assert.match(lastStatus, /last/i);
    const lastStages = lifecycleStages(lastStatus);
    assert.match(lastStages.handoff, /✓/);
    assert.match(lastStages.compact, /✓/);
    assert.match(lastStages.pickup, /✓/);
    assertExactInstruction(lastStatus, handoffMessage.content);
    assertNoUiDiagnostics(lastStatus);
  }
});

test("automatic and manual runs persist the exact instruction in a transitioning TUI card", async () => {
  for (const scenario of [
    {
      path: "automatic",
      start: triggerAutomatic,
      heading: /AUTO COMPACT · AUTOMATIC/,
    },
    {
      path: "manual",
      start: triggerManual,
      heading: /AUTO COMPACT · MANUAL/,
    },
  ]) {
    const guidance =
      scenario.path === "automatic"
        ? Array.from(
            { length: 12 },
            (_, index) => `Automatic guidance line ${index + 1}.`,
          ).join("\n")
        : "Preserve the manual persistent card snapshot.";
    const harness = makeHarness({
      enabled: scenario.path !== "manual",
      prompt: guidance,
    });
    await scenario.start(harness);
    const handoffMessage = harness.messages[0].message;

    const initialCard = onlyWidgetText(harness);
    assert.match(initialCard, scenario.heading);
    const initialStages = lifecycleStages(initialCard);
    assert.match(initialStages.handoff, /●.*active/i);
    assert.match(initialStages.compact, /○/);
    assert.match(initialStages.pickup, /○/);
    assertExactCardInstruction(initialCard, handoffMessage.content);
    assertNoUiDiagnostics(initialCard);
    assert.ok(initialCard.includes(guidance));
    const [widgetKey] = harness.widgets.keys();
    assert.equal(widgetKey, "hc-auto-compact-lifecycle");
    assert.equal(harness.widgetCalls[0].options, undefined);
    assert.equal(
      new Set(harness.widgetCalls.map(({ key }) => key)).size,
      1,
      "all card transitions must update one stable widget",
    );

    harness.setConfiguredPrompt("Later settings must not rewrite the card.");
    await harness.commands.get("auto-compact").handler("status", harness.ctx);
    assert.equal(onlyWidgetText(harness), initialCard);
    assertExactInstruction(harness.notices.at(-1).text, handoffMessage.content);
    assert.doesNotMatch(onlyWidgetText(harness), /Later settings/);

    await ready(harness);
    harness.handlers.get("agent_settled")({}, harness.ctx);
    const compactingCard = onlyWidgetText(harness);
    const compactingStages = lifecycleStages(compactingCard);
    assert.match(compactingStages.handoff, /✓/);
    assert.match(compactingStages.compact, /●.*active/i);
    assert.match(compactingStages.pickup, /○/);
    assert.doesNotMatch(compactingCard, /framework-generated hidden context/);
    assertNoUiDiagnostics(compactingCard);

    harness.compactCalls[0].onComplete();
    const completedCard = onlyWidgetText(harness);
    const completedStages = lifecycleStages(completedCard);
    assert.match(completedStages.handoff, /✓/);
    assert.match(completedStages.compact, /✓/);
    assert.match(completedStages.pickup, /✓/);
    assert.match(completedCard, /resume.*unfinished|stop if complete/i);
    assert.doesNotMatch(completedCard, /framework-generated hidden context/);
    assertNoUiDiagnostics(completedCard);
    assert.equal([...harness.widgets.keys()][0], widgetKey);
  }
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
  await command.handler("threshold 95", harness.ctx);
  assert.equal(harness.writes.length, writeCount);
  assert.equal(harness.notices.at(-1).level, "warning");
  assert.match(harness.notices.at(-1).text, /greater than 0 and less than 95/i);

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
  assert.equal(stale.terminate, true);

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
    ({ message }) => message.customType === "auto_compact_pickup",
  );
  assert.equal(pickups.length, 1);
  assert.equal(pickups[0].message.display, false);
  assert.deepEqual(pickups[0].message.details, { projection: "pickup" });
  assert.deepEqual(pickups[0].options, { triggerTurn: true });
  assert.match(pickups[0].message.content, /Resume the prior request/i);
  assert.match(pickups[0].message.content, /stop normally/i);
  assert.equal(harness.controller.snapshot().state, "idle");
  assert.deepEqual(harness.activeTools(), ["read"]);

  harness.setUsage({
    tokens: null,
    contextWindow: 100_000,
    percent: null,
  });
  await triggerAutomatic(harness);
  assert.equal(
    harness.messages.filter(
      ({ message }) => message.customType === "auto_compact_handoff",
    ).length,
    1,
    "unknown post-compact accounting must not start a handoff",
  );

  harness.setUsage({ tokens: 90_000, contextWindow: 100_000, percent: 90 });
  await triggerAutomatic(harness);
  assert.equal(
    harness.messages.filter(
      ({ message }) => message.customType === "auto_compact_handoff",
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
      ({ message }) => message.customType === "auto_compact_handoff",
    ).length,
    2,
    "dropping below then crossing again rearms automatic mode",
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
      ({ message }) => message.customType === "auto_compact_pickup",
    ),
    false,
  );
  assert.match(asynchronous.notices.at(-1).text, /failed/i);
  assert.doesNotMatch(asynchronous.notices.at(-1).text, /provider refused/);

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
});

test("compaction error marks COMPACT failed and never presents PICKUP as sent", async () => {
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
  assert.doesNotMatch(stages.pickup, /✓|done|sent/i);
  assert.doesNotMatch(failure, /native compactor failed/);
  assertNoUiDiagnostics(failure);
  assert.equal(
    harness.messages.filter(
      ({ message }) => message.customType === "auto_compact_pickup",
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
    sendMessageErrorFor: "auto_compact_pickup",
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
    assert.equal(
      harness.messages.filter(
        ({ message }) => message.customType === "auto_compact_pickup",
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
      ({ message }) => message.customType === "auto_compact_pickup",
    );
    assert.equal(pickups.length, 1, scenario.reason);
    assert.equal(pickups[0].message.display, false, scenario.reason);
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
    assert.match(pickups[0].message.content, /handoff is no longer active/i);
    assert.match(pickups[0].message.content, /Ignore that earlier handoff/i);
    assert.match(pickups[0].message.content, /Resume the prior request/i);
    assert.equal(harness.controller.snapshot().state, "idle");
    assert.deepEqual(harness.activeTools(), ["read"]);

    const supersededNotice = harness.notices.at(-1).text;
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
    assert.equal(
      harness.messages.filter(
        ({ message }) => message.customType === "auto_compact_pickup",
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
      ({ message }) => message.customType === "auto_compact_pickup",
    ).length,
    0,
    "the ctx.compact callback owns pickup for this lifecycle",
  );

  harness.compactCalls[0].onComplete();
  harness.handlers.get("session_compact")(nativeCompletion, harness.ctx);
  const pickups = harness.messages.filter(
    ({ message }) => message.customType === "auto_compact_pickup",
  );
  assert.equal(pickups.length, 1);
  assert.deepEqual(pickups[0].message.details, { projection: "pickup" });
  assert.deepEqual(pickups[0].options, { triggerTurn: true });
  assert.equal(harness.controller.snapshot().state, "idle");
  assert.deepEqual(harness.activeTools(), ["read"]);
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
      ({ message }) => message.customType === "auto_compact_pickup",
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
    assert.deepEqual(harness.writes, [{ enabled: false }]);
    assert.deepEqual(harness.activeTools(), ["read"]);
    await harness.commands.get("auto-compact").handler("status", harness.ctx);
    const status = harness.notices.at(-1).text;
    assert.match(status, /last/i);
    scenario.assertStages(lifecycleStages(status));
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
      ({ message }) => message.customType === "auto_compact_pickup",
    ).length,
    1,
  );
  await triggerAutomatic(harness);
  assert.equal(
    harness.messages.filter(
      ({ message }) => message.customType === "auto_compact_handoff",
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
  assert.match(harness.notices[0].text, /could not be sent/i);
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
      ({ message }) => message.customType === "auto_compact_pickup",
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
  assert.equal(harness.messages[0].message.customType, "auto_compact_handoff");
  assert.equal(harness.widgets.size, 0);
  assertExactInstruction(
    harness.notices.at(-1).text,
    harness.messages[0].message.content,
  );
  assert.deepEqual(harness.activeTools(), ["read", AUTO_COMPACT_TOOL_NAME]);
});
