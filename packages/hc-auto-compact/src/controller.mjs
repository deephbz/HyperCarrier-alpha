import { randomUUID } from "node:crypto";

import { Type } from "typebox";
import { createMethodEngine } from "./method-engine.mjs";
import { FORK_APIS, forkFormat } from "./methods/fork.mjs";
import { PLAN_TOOL } from "./methods/plan-apply.mjs";
import {
  autoCompactCommandDescription,
  getAutoCompactArgumentCompletions,
  parseAutoCompactCommand,
} from "./command.mjs";
import { renderHumanReceipt, renderLifecycleHud, renderStatus } from "./presentation.mjs";
import {
  DEFAULT_AUTO_COMPACT_SETTINGS,
  resolveSessionStrategy,
  readConfiguredAutoCompactSettings,
  writeConfiguredAutoCompactSettings,
} from "./settings.mjs";

export const AUTO_COMPACT_TOOL_NAME = "auto_compact_ready";
export const AUTO_COMPACT_WIDGET_KEY = "hc-auto-compact-lifecycle";
export const AUTO_COMPACT_STATES = Object.freeze([
  "idle",
  "queued",
  "handoff_pending",
  "ready",
  "compacting",
  "pickup",
]);

const RESUME_INSTRUCTION =
  "Continue the prior request if work remains. If it is complete, stop.";
const PICKUP_PROMPT = `Auto Compact pickup: Pi compacted this Session. ${RESUME_INSTRUCTION}`;
const SUPERSESSION_PICKUP_PROMPT = `Auto Compact handoff cancelled: a separate Pi compaction finished first. Ignore the earlier handoff notice and do not call auto_compact_ready. ${RESUME_INSTRUCTION}`;

// Configurable guidance comes first so the framework-owned rules that follow
// it take precedence.
export function buildPreCompactPrompt(additionalGuidance) {
  const guidance =
    typeof additionalGuidance === "string" && additionalGuidance.trim()
      ? `\n\nPreservation guidance:\n${additionalGuidance.trim()}`
      : "";
  return `Auto Compact handoff: context is near the configured limit. Pi will run native compaction after you call auto_compact_ready.${guidance}

Rules (the no-inspection rule overrides any guidance above):
- Do not gather more context: do not read files, search, browse, inspect logs, or run verification.
- Use only information already in this Session and paths you already know.
- Use only safe write or edit operations.
- Do not write a reply, summary, or status message to the human. Emit no assistant text; use only tool calls. The human reads your progress after pickup.

Steps:
1. Write or update the minimum durable Evergreen/work artifacts that preserve current progress, decisions, unresolved work, and next steps. If no safe write is possible without inspection, skip this step.
2. Call auto_compact_ready with no arguments, alone, as your final action.

This notice applies only while auto_compact_ready is available. If that tool is unavailable, ignore this notice.`;
}

function friendlyPercent(value) {
  return Number.isInteger(value)
    ? String(value)
    : String(Number(value.toFixed(2)));
}

function contextUsage(ctx) {
  try {
    return ctx?.getContextUsage?.();
  } catch {
    return undefined;
  }
}

export function utilizationAtOrAboveThreshold(usage, threshold) {
  if (!usage || typeof usage.contextWindow !== "number")
    return { known: false, crossed: false };
  if (typeof usage.percent === "number" && Number.isFinite(usage.percent))
    return {
      known: true,
      crossed: usage.percent >= threshold,
      percent: usage.percent,
      tokens: usage.tokens,
      contextWindow: usage.contextWindow,
    };
  if (
    typeof usage.tokens === "number" &&
    Number.isFinite(usage.tokens) &&
    usage.contextWindow > 0
  ) {
    const percent = (usage.tokens / usage.contextWindow) * 100;
    return {
      known: true,
      crossed: percent >= threshold,
      percent,
      tokens: usage.tokens,
      contextWindow: usage.contextWindow,
    };
  }
  return {
    known: false,
    crossed: false,
    tokens: usage.tokens,
    contextWindow: usage.contextWindow,
  };
}

export function createAutoCompactController(pi, options = {}) {
  if (!pi?.on || !pi?.registerTool || !pi?.registerCommand)
    throw new TypeError("A complete Pi ExtensionAPI is required");

  const settingsLoader =
    options.settingsLoader ?? readConfiguredAutoCompactSettings;
  const settingsWriter =
    options.settingsWriter ?? writeConfiguredAutoCompactSettings;
  const onDebug =
    typeof options.onDebug === "function" ? options.onDebug : () => {};

  const methodEngine = createMethodEngine(pi);
  let state = "idle";
  let runSequence = 0;
  let lifecycle;
  let startInFlight = false;
  let sessionGeneration = 0;
  let automaticEnabledOverride;
  let sessionBudgetOverride;
  let sessionSelectionOverrides = {};
  let selectionIntentSequence = 0;
  let plainCompaction;
  let configurationWarning;
  let configurationIntentSequence = 0;
  let pendingExternalResolution;
  let currentWorkflowReceipt;
  let lastWorkflowReceipt;
  let thresholdArmed = true;
  let compactionFailed = false;
  let lastCompaction;
  let heldBatch;
  let lastUtilization;
  let settingsSnapshot = {
    settings: { ...DEFAULT_AUTO_COMPACT_SETTINGS },
    errors: [],
  };

  const debug = (type, detail = {}) => {
    try {
      onDebug({
        type,
        state,
        lifecycleId: lifecycle?.id,
        ...detail,
      });
    } catch {
      // Debug observation cannot change the control lifecycle.
    }
  };

  const transition = (next, detail = {}) => {
    const previous = state;
    state = next;
    debug("transition", { previous, next, ...detail });
    refreshBudgetState();
  };

  const notify = (ctx, text, level = "info") => {
    if (typeof ctx?.ui?.notify !== "function") return;
    try {
      ctx.ui.notify(text, level);
    } catch {
      // Human feedback is best-effort and never changes session control.
    }
  };

  const receiptForRun = (runId) =>
    currentWorkflowReceipt?.runId === runId
      ? currentWorkflowReceipt
      : undefined;

  const markReceiptInterrupted = (receipt, interruptedState, outcome) => {
    if (
      interruptedState === "queued" ||
      interruptedState === "handoff_pending"
    ) {
      receipt.handoff = "interrupted";
      receipt.compact = "not_requested";
    } else {
      receipt.handoff = "done";
      receipt.compact = interruptedState === "pickup" ? "done" : "interrupted";
    }
    if (receipt.preservation === "none") receipt.handoff = "skipped";
    receipt.pickup =
      interruptedState === "pickup" ? "interrupted" : "not_requested";
    receipt.outcome = outcome;
  };

  const finalizeCurrentReceipt = (runId) => {
    const receipt = receiptForRun(runId);
    if (!receipt) return undefined;
    receipt.terminal = true;
    lastWorkflowReceipt = receipt;
    currentWorkflowReceipt = undefined;
    return receipt;
  };

  const clearHumanReceipts = () => {
    currentWorkflowReceipt = undefined;
    lastWorkflowReceipt = undefined;
  };

  const receiptForWidget = () =>
    currentWorkflowReceipt ??
    (pendingExternalResolution?.runId === lastWorkflowReceipt?.runId
      ? lastWorkflowReceipt
      : undefined);

  const currentMethodPhase = () => state === "queued" && methodEngine.phase()
    ? "waiting for request" : methodEngine.phase();

  const setLifecycleWidget = (ctx) => {
    refreshBudgetState();
    if (ctx?.mode !== "tui" || typeof ctx?.ui?.setWidget !== "function")
      return false;
    try {
      const activeReceipt = receiptForWidget();
      if (compactionFailed && !activeReceipt) {
        ctx.ui.setWidget(AUTO_COMPACT_WIDGET_KEY, [failureNotice()]);
        return true;
      }
      if (!activeReceipt) {
        ctx.ui.setWidget(AUTO_COMPACT_WIDGET_KEY, undefined);
        return true;
      }
      ctx.ui.setWidget(AUTO_COMPACT_WIDGET_KEY, [
        renderLifecycleHud(activeReceipt, {
          state,
          methodPhase: currentMethodPhase(),
          externalResolution:
            pendingExternalResolution?.runId === activeReceipt.runId,
        }) + (heldBatch ? ` · held ${heldBatch.items.length}` : ""),
      ]);
      return true;
    } catch {
      // The lifecycle card is a best-effort TUI projection.
      return false;
    }
  };

  const notifyHumanReceipt = (
    ctx,
    receipt,
    { level = "info", includePrompt = false, heading } = {},
  ) => {
    if (!receipt) return;
    const cardRendered = setLifecycleWidget(ctx);
    notify(
      ctx,
      renderHumanReceipt(receipt, {
        heading,
        includePrompt: includePrompt && !cardRendered,
      }),
      level,
    );
  };

  const deactivateReadyTool = () => {
    try {
      const active = pi.getActiveTools();
      if (!active.includes(AUTO_COMPACT_TOOL_NAME)) return;
      pi.setActiveTools(
        active.filter((toolName) => toolName !== AUTO_COMPACT_TOOL_NAME),
      );
      debug("tool_deactivated");
    } catch (error) {
      debug("tool_deactivation_failed", {
        error: String(error?.message ?? error),
      });
    }
  };

  const foregroundPlan = () => lifecycle?.settings.method !== "native" && lifecycle?.settings.execution === "foreground";
  const activateReadyTool = () => {
    const name = foregroundPlan() ? PLAN_TOOL : AUTO_COMPACT_TOOL_NAME;
    const active = pi.getActiveTools();
    if (active.includes(name)) return;
    pi.setActiveTools([...active, name]);
    debug("tool_activated");
  };
  const configurePlannerTool = (effective) => {
    const active = pi.getActiveTools();
    // An active lifecycle owns the tool set; the next selection applies after it ends.
    const wanted = lifecycle
      ? foregroundPlan()
      : effective.settings.enabled && effective.settings.method !== "native" && effective.settings.execution === "foreground";
    if (wanted && !active.includes(PLAN_TOOL)) pi.setActiveTools([...active, PLAN_TOOL]);
    if (!wanted && active.includes(PLAN_TOOL)) pi.setActiveTools(active.filter((name) => name !== PLAN_TOOL));
  };

  const failureNotice = () => {
    const error = lastCompaction?.error ?? "unknown";
    const label =
      error.match(/Turn prefix summarization|Summarization/i)?.[0] ??
      error.split("\n")[0];
    return `Compaction failed: ${label}; see /auto-compact status`;
  };

  const budgetFor = (ctx, effective = settingsSnapshot) => {
    const modelWindow =
      ctx?.model?.contextWindow ?? contextUsage(ctx)?.contextWindow;
    const modelBudget =
      effective.settings.modelOverrides?.[
        `${ctx?.model?.provider}/${ctx?.model?.id}`
      ]?.budget_tokens;
    const configured =
      sessionBudgetOverride ??
      modelBudget ??
      effective.settings.budget_tokens ??
      modelWindow;
    const window = Math.min(configured, modelWindow);
    return {
      configured,
      window,
      modelWindow,
      source:
        sessionBudgetOverride !== undefined
          ? "Session override"
          : modelBudget !== undefined
            ? `model override ${ctx.model.provider}/${ctx.model.id}`
            : effective.settings.budget_tokens !== undefined
              ? "budget_tokens"
              : "model.contextWindow",
      clamped: configured > modelWindow,
    };
  };

  const utilizationFor = (ctx, effective) => {
    const usage = contextUsage(ctx);
    const budget = budgetFor(ctx, effective);
    return utilizationAtOrAboveThreshold(
      usage
        ? {
            ...usage,
            contextWindow: budget.window,
            ...(typeof usage.tokens === "number" ||
            budget.window !== usage.contextWindow
              ? { percent: undefined }
              : {}),
          }
        : usage,
      effective.settings.threshold,
    );
  };

  let composerPresent = false;
  let budgetSlot;
  let budgetContext;
  let budgetGeneration;

  const emitBudgetSlot = () => {
    if (!budgetSlot || budgetGeneration !== sessionGeneration) return;
    try {
      pi.events?.emit("hc.hud.slot", budgetSlot);
    } catch {
      // HUD projection cannot change Session control.
    }
  };

  const renderBudgetFallback = (ctx) => {
    if (ctx?.mode !== "tui" || typeof ctx?.ui?.setStatus !== "function") return;
    const compactTokens = (tokens) =>
      tokens >= 1_000_000
        ? `${(tokens / 1_000_000).toFixed(1)}M`
        : tokens >= 1000
          ? `${Number((tokens / 1000).toFixed(1))}k`
          : String(Math.round(tokens));
    try {
      let text;
      const value = budgetGeneration === sessionGeneration ? budgetSlot?.value : null;
      if (!composerPresent && value) {
        const percent = (value.used / value.limit) * 100;
        text = `budget ${compactTokens(value.used)}/${compactTokens(value.limit)} ${friendlyPercent(percent)}% · ${value.mode}`;
        const color =
          percent >= 100
            ? "error"
            : percent >= value.threshold
              ? "warning"
              : undefined;
        if (color && typeof ctx.ui.theme?.fg === "function")
          text = ctx.ui.theme.fg(color, text);
      }
      ctx.ui.setStatus("hc-auto-compact", text);
    } catch {
      // Footer projection cannot change Session control.
    }
  };

  const budgetControlState = (effective = settingsSnapshot) => {
    const phase =
      state === "compacting" || plainCompaction?.phase === "compacting"
        ? "compacting"
        : state === "handoff_pending" || state === "ready"
          ? "handoff"
          : undefined;
    return {
      mode: compactionFailed
        ? "disarmed"
        : (automaticEnabledOverride ?? effective.settings.enabled)
          ? "auto"
          : "off",
      ...(phase ? { phase } : {}),
      ...(heldBatch?.items.length ? { held: heldBatch.items.length } : {}),
    };
  };

  const refreshBudgetState = () => {
    if (!budgetSlot?.value || budgetGeneration !== sessionGeneration) return;
    const { mode, phase, held, ...value } = budgetSlot.value;
    budgetSlot = {
      ...budgetSlot,
      asOf: Date.now(),
      value: { ...value, ...budgetControlState() },
    };
    emitBudgetSlot();
    renderBudgetFallback(budgetContext);
  };

  const setBudgetFooter = (ctx, effective = settingsSnapshot) => {
    const used = contextUsage(ctx)?.tokens;
    const budget = budgetFor(ctx, effective);
    budgetContext = ctx;
    budgetGeneration = sessionGeneration;
    budgetSlot = {
      v: 1,
      key: "context.budget",
      producer: "hc-auto-compact",
      asOf: Date.now(),
      value:
        Number.isFinite(used) && Number.isFinite(budget.window) && budget.window > 0
          ? {
              kind: "ratio",
              used,
              limit: budget.window,
              unit: "tokens",
              capacity: budget.modelWindow,
              ...budgetControlState(effective),
              threshold: effective.settings.threshold,
            }
          : null,
    };
    emitBudgetSlot();
    renderBudgetFallback(ctx);
  };

  pi.events?.on("hc.hud.composer", (event) => {
    if (
      event?.v !== 1 ||
      event.surface !== "tui-footer" ||
      typeof event.present !== "boolean"
    )
      return;
    composerPresent = event.present;
    if (composerPresent) emitBudgetSlot();
    renderBudgetFallback(budgetContext);
  });

  const restoreBudgetOverride = (ctx) => {
    sessionBudgetOverride = undefined;
    const branch = ctx?.sessionManager?.getBranch?.() ?? [];
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (entry.type !== "custom" || entry.customType !== "auto-compact.budget")
        continue;
      const tokens = entry.data?.tokens;
      if (Number.isSafeInteger(tokens) && tokens > 0)
        sessionBudgetOverride = tokens;
      return;
    }
  };

  const summaryCaps = (ctx) => {
    const config = settingsSnapshot.compaction ?? {};
    const reserve =
      config.modelOverrides?.[`${ctx?.model?.provider}/${ctx?.model?.id}`]
        ?.reserveTokens ??
      config.reserveTokens ??
      16384;
    const max = ctx?.model?.maxTokens ?? Infinity;
    return {
      reserve,
      history: Math.min(Math.floor(0.8 * reserve), max),
      prefix: Math.min(Math.floor(0.5 * reserve), max),
    };
  };

  const timers = options.timers ?? globalThis;
  const emitHold = (active) =>
    pi.events?.emit("hc.delivery-hold", {
      holder: "hc-auto-compact",
      token: lifecycle.holdToken,
      active,
    });

  const signalHold = (active) => {
    if (!lifecycle || lifecycle.holdActive === active) return;
    lifecycle.holdActive = active;
    if (active) {
      emitHold(true);
      lifecycle.renewalTimer = timers.setInterval(
        () => {
          if (lifecycle?.holdActive) emitHold(true);
        },
        10 * 60 * 1000,
      );
      lifecycle.renewalTimer?.unref?.();
    } else {
      timers.clearInterval(lifecycle.renewalTimer);
      timers.clearInterval(lifecycle.admissionTimer);
      emitHold(false);
    }
  };

  const heldText = (items) =>
    items
      .map(
        (item) =>
          `${item.source === "interactive" ? "" : `[via ${item.source}]\n`}${item.text}`,
      )
      .join("\n\n");

  const disposeHeld = (ctx, reason, sourceCurrent = true) => {
    if (!heldBatch) return;
    const { items, runToken } = heldBatch;
    heldBatch = undefined;
    refreshBudgetState();
    if (!items.length) return;
    if (sourceCurrent) {
      try {
        pi.appendEntry("auto-compact.held-input", {
          runToken,
          reason,
          items: items.map((item) => ({
            text: item.text,
            source: item.source,
            imageCount: item.images?.length ?? 0,
          })),
        });
      } catch (error) {
        notify(
          ctx,
          `Held-input recovery record failed: ${error?.message ?? error}`,
          "warning",
        );
      }
    }
    const text = heldText(items);
    let restored = false;
    if (ctx?.mode === "tui" && typeof ctx?.ui?.setEditorText === "function") {
      try {
        const current = ctx.ui.getEditorText?.() ?? "";
        ctx.ui.setEditorText([text, current].filter(Boolean).join("\n\n"));
        restored = true;
      } catch {
        /* The full text below remains the recovery surface. */
      }
    }
    notify(
      ctx,
      `${reason}: ${items.length} held message(s) ${restored ? "restored to editor" : "surfaced for resubmission"}${items.some((item) => item.images?.length) ? "; lost images: images could not be restored" : ""}${restored ? "" : `\n${text}`}\nIf the message also appears in the chat, discard the editor copy.`,
      "warning",
    );
  };

  const finishPickup = (ctx) => {
    const runId = lifecycle?.id;
    const receipt = receiptForRun(runId);
    if (receipt) {
      receipt.pickup = "done";
      receipt.outcome = lifecycle?.pickupPrompt
        ? "Pickup instruction and prompted continuation requested; pickup admitted."
        : "Pickup instruction requested: resume unfinished work, or stop if complete. Pickup admitted.";
    }
    const archived = finalizeCurrentReceipt(runId);
    resetLifecycle("pickup_complete");
    notifyHumanReceipt(ctx, archived);
  };

  const resetLifecycle = (reason) => {
    methodEngine.cancel();
    pi.events?.emit("hc.compaction-method", { owner: "hc-auto-compact", active: false, token: lifecycle?.holdToken });
    signalHold(false);
    deactivateReadyTool();
    const prior = lifecycle;
    lifecycle = undefined;
    if (state !== "idle") transition("idle", { reason, priorId: prior?.id });
  };

  // Without explicit overrides, the result follows the committed Session selection:
  // a switch that starts during the load causes a reload, so no caller acts on an old selection.
  const loadEffective = async (ctx, candidate, publish = true) => {
    const generation = sessionGeneration;
    const intent = selectionIntentSequence;
    const overrides = candidate ?? sessionSelectionOverrides;
    let loaded;
    try {
      loaded = await settingsLoader({
        cwd: ctx?.cwd,
        projectTrusted: ctx?.isProjectTrusted?.() === true,
      });
    } catch (error) {
      loaded = {
        settings: { ...DEFAULT_AUTO_COMPACT_SETTINGS },
        errors: [
          `Cannot load Auto Compact settings: ${error?.message ?? error}`,
        ],
      };
    }
    const resolved = resolveSessionStrategy(loaded, overrides);
    const effective = {
      settings: {
        ...DEFAULT_AUTO_COMPACT_SETTINGS,
        ...resolved.settings,
        ...(automaticEnabledOverride === undefined
          ? {}
          : { enabled: automaticEnabledOverride }),
      },
      errors: [
        ...resolved.errors,
        ...(configurationWarning ? [configurationWarning] : []),
      ],
      compaction: loaded?.compaction ?? {},
      ...(loaded?.rawRefs ? { rawRefs: loaded.rawRefs } : {}),
    };
    if (!candidate && generation === sessionGeneration && intent !== selectionIntentSequence)
      return loadEffective(ctx, undefined, publish);
    if (publish && generation === sessionGeneration && intent === selectionIntentSequence) settingsSnapshot = effective;
    return effective;
  };

  const startHandoff = async (ctx, trigger, pickupPrompt) => {
    if (state !== "idle" || startInFlight || plainCompaction) {
      debug("handoff_ignored", { reason: "lifecycle_active", trigger });
      return { started: false, reason: "lifecycle_active" };
    }
    if (pickupPrompt && typeof pi.sendUserMessage !== "function") {
      debug("handoff_ignored", {
        reason: "pickup_prompt_unavailable",
        trigger,
      });
      return { started: false, reason: "pickup_prompt_unavailable" };
    }
    startInFlight = true;
    const startingGeneration = sessionGeneration;
    try {
      const effective = await loadEffective(ctx);
      if (startingGeneration !== sessionGeneration || state !== "idle") {
        debug("handoff_ignored", { reason: "session_changed", trigger });
        return { started: false, reason: "session_changed" };
      }
      if (trigger === "automatic" && !effective.settings.enabled) {
        debug("handoff_ignored", { reason: "disabled", trigger });
        return { started: false, reason: "disabled" };
      }

      const strategyErrors = effective.errors.filter((error) =>
        /auto_compact\.(preservation|method|execution)|background requires/.test(error));
      if (strategyErrors.length) throw new Error(strategyErrors.join("; "));
      if (effective.settings.execution === "background" && effective.settings.method === "native")
        throw new Error("background requires method summary or keepset");
      if (effective.settings.method !== "native" &&
          (typeof ctx.sessionManager.buildSessionProjection !== "function" ||
           (effective.settings.execution === "background" && typeof ctx.modelRegistry?.streamSimple !== "function")))
        throw new Error("summary/keepset requires Pi 1.1 projection and side-request APIs");
      if (effective.settings.execution === "background" && !forkFormat(ctx.model?.api))
        throw new Error(`background does not support ${ctx.model?.api ?? "this model API"}; it requires ${FORK_APIS.join(", ")}. Use /auto-compact fg`);

      const utilization = utilizationFor(ctx, effective);
      lastUtilization = utilization;
      if (utilization.crossed) thresholdArmed = false;

      const queueBehindCurrentWork =
        trigger === "manual" &&
        (ctx?.isIdle?.() === false || ctx?.hasPendingMessages?.() === true);
      lifecycle = {
        id: ++runSequence,
        settings: { ...effective.settings },
        trigger,
        pickupPrompt,
        startedAt: Date.now(),
        holdToken: randomUUID(),
        holdActive: false,
        ...(queueBehindCurrentWork ? { queueToken: randomUUID() } : {}),
      };
      if (effective.settings.method !== "native") methodEngine.start(ctx, effective.settings, summaryCaps(ctx));
      transition(queueBehindCurrentWork ? "queued" : "handoff_pending", {
        trigger,
      });
      const handoffPrompt = foregroundPlan()
        ? [effective.settings.preservation === "artifact-handoff"
            ? `First preserve current progress in durable artifacts. Use only context and paths already known. Do not read, inspect, search, browse, or verify. If no safe write is possible, skip preservation.\n${effective.settings.pre_compact_prompt}`
            : "Artifact preservation is skipped.",
          methodEngine.prompt()].join("\n\n")
        : buildPreCompactPrompt(effective.settings.pre_compact_prompt);
      currentWorkflowReceipt = {
        runId: lifecycle.id,
        preservation: effective.settings.preservation,
        trigger,
        prompt: handoffPrompt,
        handoff: queueBehindCurrentWork ? "pending" : "active",
        compact: "pending",
        pickup: "pending",
        outcome: queueBehindCurrentWork
          ? "Manual handoff queued behind current agent work."
          : "Waiting for the agent to preserve work and report ready.",
        instructionRequested: false,
        terminal: false,
      };
      if (effective.settings.preservation === "none") currentWorkflowReceipt.handoff = "skipped";
      // Background artifact-handoff writes its handoff record in the fork; no live handoff turn runs.
      if ((effective.settings.preservation === "none" || effective.settings.execution === "background") && !foregroundPlan()) {
        const forkHandoff = effective.settings.preservation !== "none";
        currentWorkflowReceipt.handoff = forkHandoff ? "pending" : "skipped";
        currentWorkflowReceipt.prompt = undefined;
        currentWorkflowReceipt.outcome = forkHandoff
          ? "Handoff record and plan run in the background fork; compaction pending."
          : "Artifact preservation skipped; compaction pending.";
        transition("ready");
        notifyHumanReceipt(ctx, currentWorkflowReceipt);
        if (effective.settings.execution === "foreground" && ctx.isIdle()) beginCompaction(ctx);
        return { started: true };
      }
      activateReadyTool();
      if (!queueBehindCurrentWork) signalHold(true);
      pi.sendMessage(
        {
          customType: "auto-compact.handoff",
          content: handoffPrompt,
          display: true,
          details: queueBehindCurrentWork
            ? {
                projection: "handoff",
                queuedRun: lifecycle.queueToken,
              }
            : { projection: "handoff" },
        },
        {
          triggerTurn: true,
          deliverAs: queueBehindCurrentWork ? "followUp" : "steer",
        },
      );
      currentWorkflowReceipt.instructionRequested = true;

      notifyHumanReceipt(ctx, currentWorkflowReceipt, { includePrompt: true });
      debug(queueBehindCurrentWork ? "handoff_queued" : "handoff_started", {
        trigger,
        utilization,
        threshold: effective.settings.threshold,
      });
      return { started: true };
    } catch (error) {
      const runId = lifecycle?.id;
      const receipt = receiptForRun(runId);
      if (!receipt) notify(ctx, `Auto Compact cannot start: ${error?.message ?? error}`, "error");
      if (receipt) {
        receipt.handoff = "failed";
        receipt.compact = "not_requested";
        receipt.pickup = "not_requested";
        receipt.outcome = "The handoff instruction could not be requested.";
      }
      const archived = finalizeCurrentReceipt(runId);
      disposeHeld(ctx, "Handoff failed");
      resetLifecycle("handoff_injection_failed");
      notifyHumanReceipt(ctx, archived, { level: "error" });
      debug("handoff_failed", { error: String(error?.message ?? error) });
      return { started: false, reason: "injection_failed" };
    } finally {
      startInFlight = false;
    }
  };

  const awaitPickupAdmission = (ctx, runId) => {
    if (state !== "pickup" || lifecycle?.id !== runId) return;
    lifecycle.admissionTimer = timers.setInterval(() => {
      if (state !== "pickup" || lifecycle?.id !== runId || !ctx.isIdle())
        return;
      disposeHeld(ctx, "Pickup was not admitted");
      thresholdArmed = true;
      const receipt = receiptForRun(runId);
      if (receipt) {
        receipt.pickup = "failed";
        receipt.outcome =
          "Pickup was not admitted. Automatic threshold re-armed.";
      }
      const archived = finalizeCurrentReceipt(runId);
      resetLifecycle("pickup_unadmitted");
      notifyHumanReceipt(ctx, archived, { level: "warning" });
    }, 5000);
    lifecycle.admissionTimer?.unref?.();
  };

  const beginPlainCompaction = (ctx) => {
    if (plainCompaction?.phase !== "pending") return;
    const attempt = plainCompaction;
    attempt.phase = "compacting";
    refreshBudgetState();
    attempt.summaryCaps = summaryCaps(ctx);
    const fail = (error) => {
      if (plainCompaction !== attempt) return;
      plainCompaction = undefined;
      compactionFailed = true;
      thresholdArmed = false;
      lastCompaction = {
        error: String(error?.message ?? error),
        caps: attempt.summaryCaps,
      };
      setLifecycleWidget(ctx);
      notify(ctx, failureNotice(), "error");
    };
    try {
      ctx.compact({
        onComplete: () => {
          if (plainCompaction !== attempt) return;
          plainCompaction = undefined;
          compactionFailed = false;
          setLifecycleWidget(ctx);
          setBudgetFooter(ctx);
        },
        onError: fail,
      });
    } catch (error) {
      fail(error);
    }
  };

  const beginCompaction = (ctx) => {
    if (state !== "ready" || !lifecycle) {
      debug("compaction_ignored", { reason: "not_ready" });
      return;
    }
    if (lifecycle.settings.execution === "background" && !methodEngine.ready()) return;
    const runId = lifecycle.id;
    signalHold(true);
    if (lifecycle.settings.method !== "native")
      pi.events?.emit("hc.compaction-method", {
        owner: "hc-auto-compact", method: lifecycle.settings.method, active: true, token: lifecycle.holdToken,
      });
    transition("compacting");
    lifecycle.ownCompaction = true;
    lifecycle.summaryCaps = summaryCaps(ctx);
    const receipt = receiptForRun(runId);
    if (receipt) {
      receipt.handoff = lifecycle.settings.preservation === "none" ? "skipped" : "done";
      receipt.compact = "active";
      receipt.pickup = "pending";
      receipt.outcome = `${receipt.handoff === "skipped" ? "Artifact preservation skipped" : "Handoff ready"}; ${lifecycle.settings.method} compaction is in progress.`;
    }
    notifyHumanReceipt(ctx, receipt);
    debug("compaction_started");

    const failCompaction = (error) => {
      if (
        state !== "compacting" ||
        lifecycle?.id !== runId ||
        lifecycle?.ownCompaction !== true
      )
        return;
      const failed = receiptForRun(runId);
      if (failed) {
        failed.handoff = lifecycle.settings.preservation === "none" ? "skipped" : "done";
        failed.compact = "failed";
        failed.pickup = "not_requested";
        failed.outcome = "Native compaction failed; pickup was not requested.";
      }
      compactionFailed = true;
      thresholdArmed = false;
      lastCompaction = {
        error: String(error?.message ?? error),
        caps: lifecycle.summaryCaps,
      };
      if (failed) failed.outcome = failureNotice();
      disposeHeld(ctx, "Compaction failed");
      const archived = finalizeCurrentReceipt(runId);
      resetLifecycle("compaction_failed");
      notifyHumanReceipt(ctx, archived, { level: "error" });
      debug("compaction_failed", {
        error: String(error?.message ?? error),
      });
    };

    try {
      ctx.compact({
        onComplete: () => {
          if (
            state !== "compacting" ||
            lifecycle?.id !== runId ||
            lifecycle?.ownCompaction !== true
          ) {
            debug("compaction_completion_ignored", { reason: "stale" });
            return;
          }
          if (compactionFailed) thresholdArmed = true;
          compactionFailed = false;
          setBudgetFooter(ctx);
          pi.events?.emit("hc.compaction-method", { owner: "hc-auto-compact", active: false, token: lifecycle.holdToken });
          methodEngine.cancel();
          transition("pickup");
          const completing = receiptForRun(runId);
          if (completing) {
            completing.handoff = lifecycle.settings.preservation === "none" ? "skipped" : "done";
            completing.compact = "done";
            completing.pickup = "active";
            completing.outcome =
              `${lifecycle.settings.method[0].toUpperCase()}${lifecycle.settings.method.slice(1)} compaction finished; requesting the pickup instruction.`;
            setLifecycleWidget(ctx);
          }
          try {
            if (heldBatch?.items.length) {
              const items = heldBatch.items;
              const text = [
                PICKUP_PROMPT,
                "Messages the human sent during the handoff and compaction follow. They take priority over resuming the prior request.",
                lifecycle.pickupPrompt
                  ? `Run prompt:\n${lifecycle.pickupPrompt}`
                  : undefined,
                ...items.map(
                  (item, index) =>
                    `${item.source === "interactive" ? `Human message ${index + 1}` : `Message ${index + 1} [via ${item.source}]`}:\n${item.text}`,
                ),
              ]
                .filter(Boolean)
                .join("\n\n");
              const images = items.flatMap((item) => item.images ?? []);
              pi.sendMessage(
                {
                  customType: "auto-compact.pickup",
                  content: images.length
                    ? [{ type: "text", text }, ...images]
                    : text,
                  display: true,
                  details: {
                    projection: "pickup",
                    runToken: lifecycle.holdToken,
                    heldCount: items.length,
                  },
                },
                { triggerTurn: true },
              );
              if (state !== "pickup" || lifecycle?.id !== runId) return;
              awaitPickupAdmission(ctx, runId);
              return;
            }
            const pickupPrompt = lifecycle.pickupPrompt;
            const pickupGeneration = sessionGeneration;
            pi.sendMessage(
              {
                customType: "auto-compact.pickup",
                content: PICKUP_PROMPT,
                display: true,
                details: {
                  projection: "pickup",
                  runToken: lifecycle.holdToken,
                },
              },
              { triggerTurn: !lifecycle.pickupPrompt },
            );
            if (pickupGeneration !== sessionGeneration) return;
            if (pickupPrompt) pi.sendUserMessage(pickupPrompt);
            if (state !== "pickup" || lifecycle?.id !== runId) return;
            if (completing) {
              completing.outcome = lifecycle.pickupPrompt
                ? "Pickup instruction and prompted continuation requested; waiting for admission."
                : "Pickup instruction requested; waiting for admission.";
              notifyHumanReceipt(ctx, completing);
            }
            awaitPickupAdmission(ctx, runId);
            debug("pickup_requested");
          } catch (error) {
            if (completing) {
              completing.pickup = "failed";
              completing.outcome = lifecycle?.pickupPrompt
                ? "Native compaction finished, but the prompted continuation could not be requested."
                : "Native compaction finished, but pickup could not be requested.";
            }
            const archived = finalizeCurrentReceipt(runId);
            disposeHeld(ctx, "Pickup failed");
            resetLifecycle("pickup_failed");
            notifyHumanReceipt(ctx, archived, { level: "error" });
            debug("pickup_failed", {
              error: String(error?.message ?? error),
            });
          }
        },
        onError: failCompaction,
      });
    } catch (error) {
      failCompaction(error);
    }
  };

  pi.registerTool({
    name: PLAN_TOOL,
    label: "Compaction plan",
    description: "Return the requested foreground compaction plan. Call it alone as your final action. Never call it outside a pending compaction step.",
    parameters: Type.Object({ summary: Type.String(), keep: Type.Array(Type.String()) }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (state !== "handoff_pending" || !foregroundPlan() || !methodEngine.acceptPlan(params, ctx))
        return { content: [{ type: "text", text: "No foreground compaction plan is pending." }], details: { status: "ignored" } };
      transition("ready");
      const receipt = receiptForRun(lifecycle.id);
      if (receipt) {
        receipt.handoff = lifecycle.settings.preservation === "none" ? "skipped" : "done";
        receipt.outcome = "Compaction plan received; waiting for settlement.";
      }
      setLifecycleWidget(ctx);
      return { content: [{ type: "text", text: "Plan recorded. Compaction starts after settlement." }], details: { status: "accepted" }, terminate: true };
    },
  });

  pi.registerTool({
    name: AUTO_COMPACT_TOOL_NAME,
    label: "Auto Compact Ready",
    description:
      "Finish the pending Auto Compact handoff after you preserve work. Call it with no arguments, alone, as your final action. Valid only while a handoff is pending.",
    promptSnippet:
      "auto_compact_ready: finish the current Auto Compact handoff after durable preservation",
    parameters: Type.Object({}, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (state !== "handoff_pending" || !lifecycle || foregroundPlan()) {
        debug("ready_rejected", { reason: "stale_or_duplicate" });
        return {
          content: [
            {
              type: "text",
              text: "No current Auto Compact handoff is awaiting readiness.",
            },
          ],
          details: { status: "ignored" },
          terminate: false,
        };
      }
      const receipt = receiptForRun(lifecycle.id);
      if (receipt) {
        receipt.handoff = "done";
        receipt.outcome =
          "Handoff reported ready; waiting for the agent run to settle.";
      }
      transition("ready");
      deactivateReadyTool();
      setLifecycleWidget(ctx);
      debug("ready_accepted");
      return {
        content: [
          {
            type: "text",
            text: "Handoff acknowledged. Native compaction will start after this turn settles.",
          },
        ],
        details: { status: "accepted" },
        terminate: true,
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    disposeHeld(ctx, "Session changed; old-target input surfaced", false);
    compactionFailed = false;
    lastCompaction = undefined;
    sessionGeneration += 1;
    automaticEnabledOverride = undefined;
    configurationWarning = undefined;
    pendingExternalResolution = undefined;
    clearHumanReceipts();
    setLifecycleWidget(ctx);
    sessionSelectionOverrides = {};
    selectionIntentSequence += 1;
    resetLifecycle("session_start");
    thresholdArmed = true;
    plainCompaction = undefined;
    restoreBudgetOverride(ctx);
    lastUtilization = undefined;
    const generation = sessionGeneration;
    const effective = await loadEffective(ctx);
    if (generation === sessionGeneration) {
      configurePlannerTool(effective);
      setBudgetFooter(ctx, effective);
    }
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    const generation = sessionGeneration;
    const effective = await loadEffective(ctx);
    if (generation === sessionGeneration) configurePlannerTool(effective);
  });

  pi.on("model_select", async (_event, ctx) => {
    const generation = sessionGeneration;
    const effective = await loadEffective(ctx);
    if (generation === sessionGeneration) setBudgetFooter(ctx, effective);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    disposeHeld(ctx, "Session shutdown; old-target input surfaced");
    compactionFailed = false;
    lastCompaction = undefined;
    sessionGeneration += 1;
    automaticEnabledOverride = undefined;
    configurationWarning = undefined;
    pendingExternalResolution = undefined;
    clearHumanReceipts();
    setLifecycleWidget(ctx);
    sessionSelectionOverrides = {};
    selectionIntentSequence += 1;
    resetLifecycle("session_shutdown");
    thresholdArmed = true;
    sessionBudgetOverride = undefined;
    plainCompaction = undefined;
    lastUtilization = undefined;
    budgetGeneration = sessionGeneration;
    budgetSlot = {
      v: 1,
      key: "context.budget",
      producer: "hc-auto-compact",
      asOf: Date.now(),
      value: null,
    };
    emitBudgetSlot();
    renderBudgetFallback(ctx);
    budgetSlot = undefined;
    budgetContext = undefined;
    budgetGeneration = undefined;
  });

  pi.on("session_tree", (_event, ctx) => {
    disposeHeld(
      ctx,
      "Session branch changed; old-target input surfaced",
      false,
    );
    compactionFailed = false;
    lastCompaction = undefined;
    sessionGeneration += 1;
    pendingExternalResolution = undefined;
    clearHumanReceipts();
    setLifecycleWidget(ctx);
    resetLifecycle("session_tree");
    thresholdArmed = true;
    plainCompaction = undefined;
    restoreBudgetOverride(ctx);
    lastUtilization = undefined;
    setBudgetFooter(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    const observedGeneration = sessionGeneration;
    const effective = await loadEffective(ctx);
    if (observedGeneration !== sessionGeneration) {
      debug("utilization_ignored", { reason: "session_changed" });
      return;
    }
    if (
      compactionFailed &&
      summaryCaps(ctx).reserve !== lastCompaction?.caps.reserve
    ) {
      compactionFailed = false;
      thresholdArmed = true;
      setLifecycleWidget(ctx);
    }
    const utilization = utilizationFor(ctx, effective);
    const window = budgetFor(ctx, effective).window;
    setBudgetFooter(ctx, effective);
    if (state === "ready" && lifecycle?.settings.execution === "background" && methodEngine.ready()) {
      beginCompaction(ctx);
      return;
    }
    if (
      (state === "handoff_pending" || state === "ready") &&
      typeof utilization.tokens === "number" &&
      utilization.tokens >= window
    ) {
      const receipt = receiptForRun(lifecycle?.id);
      if (receipt) {
        receipt.forced = true;
        receipt.overshootTokens = utilization.tokens - window;
      }
      deactivateReadyTool();
      if (foregroundPlan() && !methodEngine.ready()) {
        lifecycle.settings.method = "native";
        methodEngine.cancel();
      }
      transition("ready", { forced: true });
      beginCompaction(ctx);
      return;
    }
    lastUtilization = utilization;
    debug("utilization_observed", {
      ...utilization,
      threshold: effective.settings.threshold,
      enabled: effective.settings.enabled,
    });
    if (!utilization.known) return;
    if (!utilization.crossed) {
      if (!compactionFailed) thresholdArmed = true;
      return;
    }
    if (
      thresholdArmed &&
      !compactionFailed &&
      !plainCompaction &&
      state === "idle"
    ) {
      thresholdArmed = false;
      if (effective.settings.enabled) await startHandoff(ctx, "automatic");
      else plainCompaction = { phase: "pending" };
    }
  });

  const activateDeliveredQueuedHandoff = (message, ctx) => {
    if (
      state !== "queued" ||
      !lifecycle?.queueToken ||
      message?.role !== "custom" ||
      message.customType !== "auto-compact.handoff" ||
      message.details?.queuedRun !== lifecycle.queueToken
    )
      return false;

    const receipt = receiptForRun(lifecycle.id);
    if (receipt) {
      receipt.handoff = lifecycle.settings.preservation === "none" ? "skipped" : "active";
      receipt.outcome =
        "Queued handoff delivered; waiting for the agent to preserve work and report ready.";
    }
    delete lifecycle.queueToken;
    transition("handoff_pending", { trigger: lifecycle.trigger });
    signalHold(true);
    activateReadyTool();
    setLifecycleWidget(ctx);
    debug("queued_handoff_delivered");
    return true;
  };

  pi.on("input", (event, ctx) => {
    if (
      !ctx.hasUI ||
      !["handoff_pending", "ready", "compacting"].includes(state) ||
      ((lifecycle?.settings.preservation === "none" || lifecycle?.settings.execution === "background") &&
        !foregroundPlan() && state !== "compacting") ||
      !lifecycle
    )
      return;
    heldBatch ??= {
      sessionGeneration,
      runId: lifecycle.id,
      runToken: lifecycle.holdToken,
      items: [],
    };
    heldBatch.items.push({
      text: event.text,
      images: event.images,
      source: event.source,
    });
    notify(ctx, "Held until pickup");
    setLifecycleWidget(ctx);
    return { action: "handled" };
  });

  const admitPickup = (message, ctx) => {
    if (
      state !== "pickup" ||
      !lifecycle ||
      message?.role !== "custom" ||
      message.customType !== "auto-compact.pickup" ||
      message.details?.runToken !== lifecycle.holdToken
    )
      return false;
    heldBatch = undefined;
    finishPickup(ctx);
    return true;
  };

  pi.on("message_start", (event, ctx) => {
    activateDeliveredQueuedHandoff(event.message, ctx);
    admitPickup(event.message, ctx);
  });

  pi.on("context", (event, ctx) => {
    for (const message of event.messages) {
      activateDeliveredQueuedHandoff(message, ctx);
      admitPickup(message, ctx);
    }
  });

  pi.on("agent_settled", (event, ctx) => {
    if (state === "idle" && plainCompaction?.phase === "pending") {
      beginPlainCompaction(ctx);
      return;
    }
    if (state === "handoff_pending" && lifecycle) {
      const runId = lifecycle.id;
      const receipt = receiptForRun(runId);
      if (event.aborted) {
        thresholdArmed = true;
        if (receipt)
          markReceiptInterrupted(
            receipt,
            state,
            "Handoff aborted; the human took control. Automatic threshold re-armed.",
          );
        disposeHeld(ctx, "Handoff aborted");
        const archived = finalizeCurrentReceipt(runId);
        resetLifecycle("handoff_aborted");
        notifyHumanReceipt(ctx, archived, { level: "warning" });
        return;
      }
      if (foregroundPlan() && !methodEngine.ready()) {
        lifecycle.settings.method = "native";
        methodEngine.cancel();
      }
      if (receipt) {
        receipt.forced = true;
        receipt.outcome =
          "Handoff settled without readiness; forced compaction.";
      }
      deactivateReadyTool();
      transition("ready", { forced: true });
    }
    if (state === "ready") {
      beginCompaction(ctx);
      return;
    }
    if (state !== "queued" || !lifecycle) return;

    const runId = lifecycle.id;
    const undelivered = receiptForRun(runId);
    if (undelivered) {
      undelivered.handoff = "failed";
      undelivered.compact = "not_requested";
      undelivered.pickup = "not_requested";
      undelivered.outcome =
        "The queued handoff was removed before delivery; native compaction was not requested.";
    }
    const archived = finalizeCurrentReceipt(runId);
    resetLifecycle("queued_handoff_removed");
    notifyHumanReceipt(ctx, archived, { level: "warning" });
    debug("queued_handoff_removed");
  });

  const failPlanner = (error, ctx) => {
      compactionFailed = true;
      thresholdArmed = false;
      lastCompaction = { error: String(error?.message ?? error), caps: summaryCaps(ctx) };
      const receipt = receiptForRun(lifecycle?.id);
      if (receipt) { receipt.compact = "failed"; receipt.pickup = "not_requested"; receipt.outcome = lastCompaction.error; }
      const archived = finalizeCurrentReceipt(lifecycle?.id);
      disposeHeld(ctx, "Planner failed");
      resetLifecycle("planner_failed");
      notifyHumanReceipt(ctx, archived, { level: "error" });
  };
  pi.on("before_provider_request", (event, ctx) => {
    try {
      const phase = methodEngine.phase();
      methodEngine.capture(event, ctx);
      if (lifecycle?.settings.execution === "background") lifecycle.methodOutputLimit = methodEngine.outputLimit();
      if (methodEngine.phase() !== phase) setLifecycleWidget(ctx);
    }
    catch (error) { failPlanner(error, ctx); }
  });
  pi.on("message_update", (event, ctx) => methodEngine.launch(event, ctx,
    () => {
      setLifecycleWidget(ctx);
      if (state === "ready" && ctx.isIdle()) beginCompaction(ctx);
    },
    (error) => failPlanner(error, ctx)));

  pi.on("session_before_compact", (event, ctx) => {
    if (event.reason === "threshold") {
      debug("native_threshold_suppressed");
      return { cancel: true };
    }
    const ownManualCompaction =
      event.reason === "manual" &&
      ((state === "compacting" && lifecycle?.ownCompaction === true) ||
        plainCompaction?.phase === "compacting");
    if (ownManualCompaction) {
      const attempt = plainCompaction ?? lifecycle;
      attempt.aggregateUsage =
        event.preparation?.isSplitTurn === true &&
        event.preparation?.turnPrefixMessages?.length > 0 &&
        event.preparation?.messagesToSummarize?.length > 0;
    }
    if (!ownManualCompaction) {
      plainCompaction = undefined;
      pendingExternalResolution = undefined;
      setLifecycleWidget(ctx);
    }
    if (!ownManualCompaction && (state !== "idle" || startInFlight)) {
      const runId = lifecycle?.id;
      const interrupted = receiptForRun(runId);
      if (interrupted)
        markReceiptInterrupted(
          interrupted,
          state,
          "The cooperative workflow was interrupted by a separate native Pi compaction.",
        );
      const archived = finalizeCurrentReceipt(runId);
      if (archived) pendingExternalResolution = { reason: event.reason, runId };
      sessionGeneration += 1;
      disposeHeld(ctx, "External compaction");
      resetLifecycle(`external_${event.reason}_compaction`);
      notifyHumanReceipt(ctx, archived, { level: "warning" });
    }
    if (ownManualCompaction && lifecycle?.settings.method !== "native" && lifecycle) {
      const runId = lifecycle.id;
      return methodEngine.compact(event, ctx).catch((error) => {
        // Pi reports thrown hook errors and continues into native generation.
        // Rejected custom plans must cancel that operation explicitly.
        try {
          if (state === "compacting" && lifecycle?.id === runId) failPlanner(error, ctx);
        } catch (cleanupError) {
          debug("planner_failure_cleanup_error", { error: String(cleanupError?.message ?? cleanupError) });
        }
        return { cancel: true };
      });
    }
    return undefined;
  });

  pi.on("session_compact", (event, ctx) => {
    setBudgetFooter(ctx);
    if (compactionFailed) thresholdArmed = true;
    compactionFailed = false;
    const ownAttempt = lifecycle?.ownCompaction
      ? lifecycle
      : plainCompaction?.phase === "compacting"
        ? plainCompaction
        : undefined;
    if (ownAttempt) {
      lastCompaction = {
        usage: event.compactionEntry?.usage,
        tokensBefore: event.compactionEntry?.tokensBefore,
        aggregate: ownAttempt.aggregateUsage === true,
        caps: ownAttempt.summaryCaps,
      };
    }
    setLifecycleWidget(ctx);
    if (
      !pendingExternalResolution ||
      pendingExternalResolution.reason !== event.reason ||
      lastWorkflowReceipt?.runId !== pendingExternalResolution.runId
    )
      return;
    if (currentWorkflowReceipt) {
      pendingExternalResolution = undefined;
      debug("external_compaction_supersession_ignored", {
        reason: "newer_run_active",
      });
      return;
    }
    const superseded = lastWorkflowReceipt;
    superseded.compact = "external_done";
    superseded.pickup = "active";
    superseded.outcome =
      "The cooperative workflow was interrupted; external compaction finished and is requesting corrective pickup.";
    setLifecycleWidget(ctx);
    try {
      pi.sendMessage(
        {
          customType: "auto-compact.pickup",
          content: SUPERSESSION_PICKUP_PROMPT,
          display: true,
          details: { projection: "pickup", supersedes: "handoff" },
        },
        { triggerTurn: false },
      );
      superseded.pickup = "done";
      superseded.outcome =
        "The cooperative workflow was interrupted. External compaction finished; pickup instruction requested.";
      pendingExternalResolution = undefined;
      notifyHumanReceipt(ctx, superseded);
      debug("external_compaction_superseded_handoff", {
        reason: event.reason,
        willRetry: event.willRetry,
      });
    } catch (error) {
      superseded.pickup = "failed";
      superseded.outcome =
        "External compaction finished, but corrective pickup could not be requested.";
      pendingExternalResolution = undefined;
      notifyHumanReceipt(ctx, superseded, { level: "error" });
      debug("external_compaction_supersession_failed", {
        error: String(error?.message ?? error),
      });
    }
  });

  pi.registerCommand("auto-compact", {
    description: autoCompactCommandDescription(),
    getArgumentCompletions: getAutoCompactArgumentCompletions,
    handler: async (args, ctx) => {
      const command = parseAutoCompactCommand(args);
      if (!command.ok) {
        notify(
          ctx,
          command.error === "invalid_threshold"
            ? "Invalid threshold: use a percent greater than 1 and less than 110"
            : command.usage,
          "warning",
        );
        return;
      }

      if (command.subcommand === "run") {
        compactionFailed = false;
        thresholdArmed = true;
        refreshBudgetState();
        const result = await startHandoff(ctx, "manual", command.prompt);
        if (!result.started && result.reason === "lifecycle_active")
          notify(
            ctx,
            `Auto Compact is already ${plainCompaction ? `${plainCompaction.phase} in plain native mode` : state.replaceAll("_", " ")}`,
            "warning",
          );
        else if (
          !result.started &&
          result.reason === "pickup_prompt_unavailable"
        )
          notify(
            ctx,
            "Auto Compact cannot start the prompted run: this Pi runtime cannot deliver the continuation prompt",
            "error",
          );
        return;
      }

      if (command.subcommand === "budget") {
        const generation = sessionGeneration;
        const effective = await loadEffective(ctx);
        if (generation !== sessionGeneration) return;
        const tokens = command.budget === "default" ? null : command.budget;
        try {
          pi.appendEntry("auto-compact.budget", { tokens });
        } catch (error) {
          notify(
            ctx,
            `Auto Compact budget was not saved: ${error?.message ?? error}`,
            "error",
          );
          return;
        }
        sessionBudgetOverride = tokens ?? undefined;
        compactionFailed = false;
        thresholdArmed = true;
        setLifecycleWidget(ctx);
        setBudgetFooter(ctx, effective);
        const budget = budgetFor(ctx, effective);
        notify(
          ctx,
          `Auto Compact budget ${command.budget === "default" ? "restored to default" : `set to ${command.budget} for this Session branch`}; effective W ${Number.isFinite(budget.window) ? budget.window : "unavailable"}${budget.clamped ? " (clamped to model window)" : ""}`,
        );
        return;
      }

      if (["execution", "method", "preservation"].includes(command.subcommand)) {
        const generation = sessionGeneration;
        const intent = ++selectionIntentSequence;
        const candidate = { ...sessionSelectionOverrides };
        if (command.value === "default") delete candidate[command.subcommand];
        else candidate[command.subcommand] = command.value;
        const effective = await loadEffective(ctx, candidate, false);
        if (generation !== sessionGeneration || intent !== selectionIntentSequence) return;
        const invalid = effective.errors.filter((error) => /auto_compact\.(preservation|method|execution)|background requires/.test(error));
        if (invalid.length) {
          const order = effective.settings.execution === "background" && effective.settings.method === "native"
            ? command.subcommand === "execution"
              ? "/auto-compact method keepset then /auto-compact bg"
              : `/auto-compact fg then /auto-compact ${command.subcommand} ${command.value}`
            : "/auto-compact execution foreground then /auto-compact method keepset";
          notify(ctx, `Selection unchanged: ${invalid.join("; ")}. Use ${order}.`, "warning");
          return;
        }
        sessionSelectionOverrides = candidate;
        settingsSnapshot = effective;
        compactionFailed = false;
        thresholdArmed = true;
        if (!lifecycle) configurePlannerTool(effective);
        setLifecycleWidget(ctx);
        setBudgetFooter(ctx, effective);
        notify(ctx, `Next run: ${command.subcommand} ${effective.settings[command.subcommand]}; ${command.value === "default" ? "saved setting restored" : "temporary; not saved"}. Resets on /reload or Session switch${lifecycle ? "; active run unchanged" : ""}.`);
        return;
      }

      if (command.subcommand === "status") {
        const effective = await loadEffective(ctx);
        const usage = utilizationFor(ctx, effective);
        const budget = budgetFor(ctx, effective);
        const window = budget.window;
        const caps = summaryCaps(ctx);
        const thinking = pi.getThinkingLevel?.() ?? "off";
        const selected = lifecycle?.settings ?? effective.settings;
        const selectionDiffers = lifecycle && ["preservation", "method", "execution", "enabled", "threshold"].some(
          (key) => selected[key] !== effective.settings[key]);
        const nativeLimits = selected.method === "native" || selected.execution === "background" || (!lifecycle && !effective.settings.enabled);
        const modeText = lifecycle || effective.settings.enabled
          ? selected.preservation === "none"
            ? `; mode ${selected.method === "native" ? "native compaction" : "planning"} (preservation skipped)`
            : selected.execution === "background"
              ? "; mode background planning (fork handoff record in compaction context)"
              : "; mode cooperative handoff"
          : `; mode off (plain native budget compaction)${plainCompaction ? `; plain compaction ${plainCompaction.phase}` : ""}`;
        const phase = currentMethodPhase();
        const displayState = phase && ["handoff_pending", "ready"].includes(state) ? "planning" : state.replaceAll("_", " ");

        const settingsHint = nativeLimits
          ? "\nAfter changing compaction.reserveTokens, reload Pi (/reload or restart) to refresh native summary caps." : "";
        const persistenceHint =
          sessionBudgetOverride !== undefined
            ? "\nMessage-less Sessions can lose budget overrides after a Session switch."
            : "";
        const capWarning =
          nativeLimits && thinking !== "off" && Math.floor(0.5 * caps.reserve) < 16384
            ? "\nRaise compaction.reserveTokens (starting point 32768, unmeasured)."
            : "";
        const lastCompactionDisplay = !nativeLimits && lastCompaction
          ? Object.fromEntries(Object.entries(lastCompaction).filter(([key]) => key !== "caps"))
          : lastCompaction;
        const receipt = currentWorkflowReceipt ?? lastWorkflowReceipt;
        const view = {
          next: effective.settings,
          active: selectionDiffers ? selected : undefined,
          overrides: { ...sessionSelectionOverrides },
          failed: compactionFailed, state: displayState, usage, budget,
          room: Number.isFinite(window) ? Math.round(window * (1 - selected.threshold / 100)) : undefined,
          mode: modeText.replace(/^; mode /, ""),
          phase: phase ? state === "compacting" ? "installing" : phase : undefined,
          heldCount: heldBatch?.items.length ?? 0,
          nativeLimits, caps,
          outputCap: [methodEngine.outputLimit(), lifecycle?.methodOutputLimit,
            forkFormat(ctx.model?.api)?.capped === false ? null : undefined,
            lifecycle?.summaryCaps?.history, caps.history].find((value) => value !== undefined),
          outputCeiling: ctx.model?.maxTokens,
          last: lastCompactionDisplay,
          failure: compactionFailed ? failureNotice() : undefined,
          rearm: compactionFailed ? `Re-arm: successful compaction, settings command, /auto-compact run${nativeLimits ? ", or changed compaction.reserveTokens" : ""}.` : undefined,
          errors: effective.errors,
          warnings: [capWarning, persistenceHint].filter(Boolean).map((text) => text.trim()),
          hints: [settingsHint].filter(Boolean).map((text) => text.trim()),
          receipt, receiptHeading: currentWorkflowReceipt ? "Current workflow" : "Last workflow",
        };
        notify(
          ctx,
          renderStatus(view),
          effective.errors.length ? "warning" : "info",
        );
        return;
      }

      const patch =
        command.subcommand === "threshold"
          ? { threshold: command.threshold }
          : { enabled: command.subcommand === "on" };
      const configurationIntent =
        command.subcommand === "on" || command.subcommand === "off"
          ? ++configurationIntentSequence
          : undefined;
      let canceledReceipt;
      if (command.subcommand === "off") {
        disposeHeld(ctx, "Auto Compact off");
        automaticEnabledOverride = false;
        configurationWarning = undefined;
        setBudgetFooter(ctx);
        sessionGeneration += 1;
        if (
          state === "queued" ||
          state === "handoff_pending" ||
          state === "ready" ||
          state === "pickup"
        ) {
          const runId = lifecycle?.id;
          const interrupted = receiptForRun(runId);
          if (interrupted)
            markReceiptInterrupted(
              interrupted,
              state,
              "The workflow was canceled before native compaction.",
            );
          canceledReceipt = finalizeCurrentReceipt(runId);
          disposeHeld(ctx, "Auto Compact off");
          resetLifecycle("disabled");
        } else if (startInFlight) resetLifecycle("disabled");
      }
      const offSessionGeneration =
        command.subcommand === "off" ? sessionGeneration : undefined;
      const offCommandIsCurrent = () =>
        offSessionGeneration === undefined ||
        sessionGeneration === offSessionGeneration;
      try {
        const persisted = await settingsWriter({
          cwd: ctx?.cwd,
          projectTrusted: ctx?.isProjectTrusted?.() === true,
          patch,
        });
        if (!offCommandIsCurrent()) return;
        if (
          command.subcommand === "on" &&
          configurationIntent === configurationIntentSequence
        ) {
          automaticEnabledOverride = undefined;
          configurationWarning = undefined;
        }
        await loadEffective(ctx);
        if (!offCommandIsCurrent()) return;
        compactionFailed = false;
        thresholdArmed = true;
        setLifecycleWidget(ctx);
        setBudgetFooter(ctx);
        const settingText =
          command.subcommand === "threshold"
            ? `threshold set to ${friendlyPercent(command.threshold)}%`
            : `turned ${command.subcommand}`;
        const notice =
          command.subcommand === "off" && state === "compacting"
            ? `Auto Compact is off for future handoffs; the current compaction will finish (${persisted?.scope ?? "durable settings"})`
            : `Auto Compact ${settingText} (${persisted?.scope ?? "durable settings"})`;
        if (canceledReceipt) {
          canceledReceipt.outcome = `Workflow canceled; Auto Compact turned off (${persisted?.scope ?? "durable settings"}).`;
          notifyHumanReceipt(ctx, canceledReceipt);
        } else notify(ctx, notice, "info");
      } catch (error) {
        if (!offCommandIsCurrent()) return;
        if (command.subcommand === "off") {
          configurationWarning =
            "automatic handoffs are disabled for this Session, but the setting was not persisted";
          if (canceledReceipt) {
            canceledReceipt.outcome =
              "Workflow canceled; automatic handoffs are off for this Session, but the setting was not saved.";
            notifyHumanReceipt(ctx, canceledReceipt, { level: "error" });
          } else
            notify(
              ctx,
              "Auto Compact is off for this Session, but the setting was not saved",
              "error",
            );
          debug("settings_write_failed", {
            command: "off",
            error: String(error?.message ?? error),
          });
          return;
        }
        notify(
          ctx,
          `Auto Compact setting wasn't saved: ${error?.message ?? error}`,
          "error",
        );
      }
    },
  });

  return {
    startHandoff,
    snapshot() {
      return {
        state,
        startInFlight,
        thresholdArmed,
        budgetOverride: sessionBudgetOverride,
        selectionOverrides: { ...sessionSelectionOverrides },
        plainCompaction: plainCompaction?.phase,
        compactionFailed,
        lastCompaction,
        heldCount: heldBatch?.items.length ?? 0,
        lifecycle: lifecycle
          ? { id: lifecycle.id, trigger: lifecycle.trigger }
          : undefined,
        usage: lastUtilization,
        settings: { ...settingsSnapshot.settings },
        settingsErrors: [...settingsSnapshot.errors],
      };
    },
  };
}
