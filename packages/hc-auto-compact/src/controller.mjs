import { Type } from "@earendil-works/pi-ai";
import {
  autoCompactCommandDescription,
  getAutoCompactArgumentCompletions,
  parseAutoCompactCommand,
} from "./command.mjs";
import {
  DEFAULT_AUTO_COMPACT_SETTINGS,
  readConfiguredAutoCompactSettings,
  writeConfiguredAutoCompactSettings,
} from "./settings.mjs";

export const AUTO_COMPACT_TOOL_NAME = "auto_compact_ready";
export const AUTO_COMPACT_WIDGET_KEY = "hc-auto-compact-lifecycle";
const AGENT_INSTRUCTION_LABEL =
  "Agent instruction (framework-generated hidden context; not user input):";
export const AUTO_COMPACT_STATES = Object.freeze([
  "idle",
  "handoff_pending",
  "ready",
  "compacting",
  "pickup",
]);

const PICKUP_PROMPT =
  "Auto Compact finished Pi's native compaction. Resume the prior request if work remains; if the request is complete, stop normally.";
const SUPERSESSION_PICKUP_PROMPT =
  "The earlier Auto Compact handoff is no longer active because a separate native Pi compaction finished. Ignore that earlier handoff notice and its readiness instruction. Resume the prior request if work remains; if the request is complete, stop normally.";

export function buildPreCompactPrompt(additionalGuidance) {
  const guidance =
    typeof additionalGuidance === "string" && additionalGuidance.trim()
      ? `\n\nAdditional preservation guidance:\n${additionalGuidance.trim()}`
      : "";
  return `Context is approaching the configured limit. Auto Compact will run Pi's native compaction after you report that this handoff is complete. This handoff notice applies only while auto_compact_ready is available; if that tool is unavailable, ignore this notice. Before signaling readiness, first preserve current progress in the project's durable Evergreen/work artifacts.${guidance}\n\nWhen preservation is complete, call auto_compact_ready with no arguments as your final and only action.`;
}

function stageLabel(name, status) {
  switch (status) {
    case "active":
      return `● ${name} (active)`;
    case "done":
      return `✓ ${name}`;
    case "failed":
      return `× ${name} (failed)`;
    case "interrupted":
      return `↷ ${name} (interrupted)`;
    case "external_done":
      return `✓ ${name} (external)`;
    case "pending":
      return `○ ${name}`;
    case "not_requested":
    default:
      return `— ${name}`;
  }
}

function renderHumanReceipt(receipt, { heading, includePrompt = false } = {}) {
  const title = [
    "AUTO COMPACT",
    receipt.trigger === "manual" ? "MANUAL" : "AUTOMATIC",
    heading,
  ]
    .filter(Boolean)
    .join(" · ");
  const rail = [
    stageLabel("HANDOFF", receipt.handoff),
    stageLabel("COMPACT", receipt.compact),
    stageLabel("PICKUP", receipt.pickup),
  ].join(" → ");
  const prompt =
    includePrompt && receipt.instructionRequested
      ? `\n\n${AGENT_INSTRUCTION_LABEL}\n${receipt.prompt}`
      : "";
  return `${title}\n${rail}\n${receipt.outcome}${prompt}`;
}

function renderLifecycleHud(receipt, { state, externalResolution = false }) {
  const trigger = receipt.trigger === "manual" ? "MANUAL" : "AUTOMATIC";
  const phase = externalResolution
    ? "EXTERNAL COMPACTION — resolving interrupted handoff"
    : state === "handoff_pending"
      ? "HANDOFF — awaiting readiness"
      : state === "ready"
        ? "READY — awaiting turn end"
        : state === "compacting"
          ? "COMPACTING"
          : "PICKUP — requesting continuation";
  return `AUTO COMPACT · ${trigger} · ${phase}`;
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

  let state = "idle";
  let lifecycleSequence = 0;
  let lifecycle;
  let startInFlight = false;
  let sessionGeneration = 0;
  let automaticEnabledOverride;
  let configurationWarning;
  let configurationIntentSequence = 0;
  let interruptedExternalCompaction;
  let currentHumanReceipt;
  let lastHumanReceipt;
  let thresholdArmed = true;
  let lastUsage;
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
  };

  const notify = (ctx, text, level = "info") => {
    if (!ctx?.hasUI || typeof ctx?.ui?.notify !== "function") return;
    try {
      ctx.ui.notify(text, level);
    } catch {
      // Human feedback is best-effort and never changes session control.
    }
  };

  const receiptForRun = (runId) =>
    currentHumanReceipt?.runId === runId ? currentHumanReceipt : undefined;

  const archiveCurrentReceipt = (runId) => {
    const receipt = receiptForRun(runId);
    if (!receipt) return undefined;
    receipt.terminal = true;
    lastHumanReceipt = receipt;
    currentHumanReceipt = undefined;
    return receipt;
  };

  const clearHumanReceipts = () => {
    currentHumanReceipt = undefined;
    lastHumanReceipt = undefined;
  };

  const activeWidgetReceipt = () =>
    currentHumanReceipt ??
    (interruptedExternalCompaction?.runId === lastHumanReceipt?.runId
      ? lastHumanReceipt
      : undefined);

  const setLifecycleWidget = (ctx) => {
    if (ctx?.mode !== "tui" || typeof ctx?.ui?.setWidget !== "function")
      return false;
    try {
      const activeReceipt = activeWidgetReceipt();
      if (!activeReceipt) {
        ctx.ui.setWidget(AUTO_COMPACT_WIDGET_KEY, undefined);
        return true;
      }
      ctx.ui.setWidget(AUTO_COMPACT_WIDGET_KEY, [
        renderLifecycleHud(activeReceipt, {
          state,
          externalResolution:
            interruptedExternalCompaction?.runId === activeReceipt.runId,
        }),
      ]);
      return true;
    } catch {
      // The lifecycle card is a best-effort TUI projection.
      return false;
    }
  };

  const clearLifecycleWidget = (ctx) => {
    setLifecycleWidget(ctx);
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

  const activateReadyTool = () => {
    const active = pi.getActiveTools();
    if (active.includes(AUTO_COMPACT_TOOL_NAME)) return;
    pi.setActiveTools([...active, AUTO_COMPACT_TOOL_NAME]);
    debug("tool_activated");
  };

  const resetLifecycle = (reason) => {
    deactivateReadyTool();
    const prior = lifecycle;
    lifecycle = undefined;
    if (state !== "idle") transition("idle", { reason, priorId: prior?.id });
  };

  const loadEffective = async (ctx) => {
    try {
      settingsSnapshot = await settingsLoader({
        cwd: ctx?.cwd,
        projectTrusted: ctx?.isProjectTrusted?.() === true,
      });
    } catch (error) {
      settingsSnapshot = {
        settings: { ...DEFAULT_AUTO_COMPACT_SETTINGS },
        errors: [
          `Cannot load Auto Compact settings: ${error?.message ?? error}`,
        ],
      };
    }
    settingsSnapshot = {
      settings: {
        ...DEFAULT_AUTO_COMPACT_SETTINGS,
        ...(settingsSnapshot?.settings ?? {}),
        ...(automaticEnabledOverride === undefined
          ? {}
          : { enabled: automaticEnabledOverride }),
      },
      errors: [
        ...(settingsSnapshot?.errors ?? []),
        ...(configurationWarning ? [configurationWarning] : []),
      ],
      ...(settingsSnapshot?.rawRefs
        ? { rawRefs: settingsSnapshot.rawRefs }
        : {}),
    };
    return settingsSnapshot;
  };

  const startHandoff = async (ctx, trigger, pickupPrompt) => {
    if (state !== "idle" || startInFlight) {
      debug("handoff_ignored", { reason: "lifecycle_active", trigger });
      return { started: false, reason: "lifecycle_active" };
    }
    if (pickupPrompt && typeof pi.sendUserMessage !== "function") {
      debug("handoff_ignored", { reason: "pickup_prompt_unavailable", trigger });
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

      const usage = contextUsage(ctx);
      const utilization = utilizationAtOrAboveThreshold(
        usage,
        effective.settings.threshold,
      );
      lastUsage = utilization;
      if (utilization.crossed) thresholdArmed = false;

      lifecycle = {
        id: ++lifecycleSequence,
        trigger,
        pickupPrompt,
        startedAt: Date.now(),
      };
      transition("handoff_pending", { trigger });
      const handoffPrompt = buildPreCompactPrompt(
        effective.settings.pre_compact_prompt,
      );
      currentHumanReceipt = {
        runId: lifecycle.id,
        trigger,
        prompt: handoffPrompt,
        handoff: "active",
        compact: "pending",
        pickup: "pending",
        outcome: "Waiting for the agent to preserve work and report ready.",
        instructionRequested: false,
        terminal: false,
      };
      activateReadyTool();
      pi.sendMessage(
        {
          customType: "auto-compact.handoff",
          content: handoffPrompt,
          display: true,
          details: { projection: "handoff" },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
      currentHumanReceipt.instructionRequested = true;

      notifyHumanReceipt(ctx, currentHumanReceipt, { includePrompt: true });
      debug("handoff_started", {
        trigger,
        utilization,
        threshold: effective.settings.threshold,
      });
      return { started: true };
    } catch (error) {
      const runId = lifecycle?.id;
      const receipt = receiptForRun(runId);
      if (receipt) {
        receipt.handoff = "failed";
        receipt.compact = "not_requested";
        receipt.pickup = "not_requested";
        receipt.outcome = "The handoff instruction could not be requested.";
      }
      const archived = archiveCurrentReceipt(runId);
      resetLifecycle("handoff_injection_failed");
      notifyHumanReceipt(ctx, archived, { level: "error" });
      debug("handoff_failed", { error: String(error?.message ?? error) });
      return { started: false, reason: "injection_failed" };
    } finally {
      startInFlight = false;
    }
  };

  const beginCompaction = (ctx) => {
    if (state !== "ready" || !lifecycle) {
      debug("compaction_ignored", { reason: "not_ready" });
      return;
    }
    const runId = lifecycle.id;
    transition("compacting");
    lifecycle.ownCompaction = true;
    const receipt = receiptForRun(runId);
    if (receipt) {
      receipt.handoff = "done";
      receipt.compact = "active";
      receipt.pickup = "pending";
      receipt.outcome = "Handoff ready; native compaction is in progress.";
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
        failed.handoff = "done";
        failed.compact = "failed";
        failed.pickup = "not_requested";
        failed.outcome = "Native compaction failed; pickup was not requested.";
      }
      const archived = archiveCurrentReceipt(runId);
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
          transition("pickup");
          const completing = receiptForRun(runId);
          if (completing) {
            completing.handoff = "done";
            completing.compact = "done";
            completing.pickup = "active";
            completing.outcome =
              "Native compaction finished; requesting the pickup instruction.";
            setLifecycleWidget(ctx);
          }
          try {
            pi.sendMessage(
              {
                customType: "auto-compact.pickup",
                content: PICKUP_PROMPT,
                display: true,
                details: { projection: "pickup" },
              },
              { triggerTurn: lifecycle.pickupPrompt ? false : true },
            );
            if (lifecycle.pickupPrompt)
              pi.sendUserMessage(lifecycle.pickupPrompt);
            if (completing) {
              completing.pickup = "done";
              completing.outcome = lifecycle.pickupPrompt
                ? "Pickup instruction and prompted continuation requested."
                : "Pickup instruction requested: resume unfinished work, or stop if complete.";
            }
            const archived = archiveCurrentReceipt(runId);
            resetLifecycle("pickup_complete");
            notifyHumanReceipt(ctx, archived);
            debug("pickup_requested");
          } catch (error) {
            if (completing) {
              completing.pickup = "failed";
              completing.outcome = lifecycle?.pickupPrompt
                ? "Native compaction finished, but the prompted continuation could not be requested."
                : "Native compaction finished, but pickup could not be requested.";
            }
            const archived = archiveCurrentReceipt(runId);
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
    name: AUTO_COMPACT_TOOL_NAME,
    label: "Auto Compact Ready",
    description:
      "Report that preservation for the current Auto Compact handoff is complete. Call this with no arguments as your final and only action. It is valid only while an Auto Compact handoff is pending.",
    promptSnippet:
      "auto_compact_ready: finish the current Auto Compact handoff after durable preservation",
    parameters: Type.Object({}, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (state !== "handoff_pending" || !lifecycle) {
        debug("ready_rejected", { reason: "stale_or_duplicate" });
        return {
          content: [
            {
              type: "text",
              text: "No current Auto Compact handoff is awaiting readiness.",
            },
          ],
          details: { status: "ignored" },
          terminate: true,
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

  pi.on("session_start", (_event, ctx) => {
    sessionGeneration += 1;
    automaticEnabledOverride = undefined;
    configurationWarning = undefined;
    interruptedExternalCompaction = undefined;
    clearHumanReceipts();
    clearLifecycleWidget(ctx);
    resetLifecycle("session_start");
    thresholdArmed = true;
    lastUsage = undefined;
    void loadEffective(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    sessionGeneration += 1;
    automaticEnabledOverride = undefined;
    configurationWarning = undefined;
    interruptedExternalCompaction = undefined;
    clearHumanReceipts();
    clearLifecycleWidget(ctx);
    resetLifecycle("session_shutdown");
    thresholdArmed = true;
    lastUsage = undefined;
  });

  pi.on("session_tree", (_event, ctx) => {
    sessionGeneration += 1;
    interruptedExternalCompaction = undefined;
    clearHumanReceipts();
    clearLifecycleWidget(ctx);
    resetLifecycle("session_tree");
    thresholdArmed = true;
    lastUsage = undefined;
  });

  pi.on("turn_end", async (_event, ctx) => {
    const observedGeneration = sessionGeneration;
    const effective = await loadEffective(ctx);
    if (observedGeneration !== sessionGeneration) {
      debug("utilization_ignored", { reason: "session_changed" });
      return;
    }
    const usage = contextUsage(ctx);
    const utilization = utilizationAtOrAboveThreshold(
      usage,
      effective.settings.threshold,
    );
    lastUsage = utilization;
    debug("utilization_observed", {
      ...utilization,
      threshold: effective.settings.threshold,
      enabled: effective.settings.enabled,
    });
    if (!utilization.known) return;
    if (!utilization.crossed) {
      thresholdArmed = true;
      return;
    }
    if (effective.settings.enabled && thresholdArmed && state === "idle") {
      thresholdArmed = false;
      await startHandoff(ctx, "automatic");
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (state === "ready") beginCompaction(ctx);
  });

  pi.on("session_before_compact", (event, ctx) => {
    if (event.reason === "threshold") {
      debug("native_threshold_suppressed");
      return { cancel: true };
    }
    const ownManualCompaction =
      event.reason === "manual" &&
      state === "compacting" &&
      lifecycle?.ownCompaction === true;
    if (!ownManualCompaction) {
      interruptedExternalCompaction = undefined;
      setLifecycleWidget(ctx);
    }
    if (!ownManualCompaction && (state !== "idle" || startInFlight)) {
      const runId = lifecycle?.id;
      const interrupted = receiptForRun(runId);
      if (interrupted) {
        if (state === "handoff_pending") {
          interrupted.handoff = "interrupted";
          interrupted.compact = "not_requested";
        } else {
          interrupted.handoff = "done";
          interrupted.compact = "interrupted";
        }
        interrupted.pickup = "not_requested";
        interrupted.outcome =
          "The cooperative workflow was interrupted by a separate native Pi compaction.";
      }
      const archived = archiveCurrentReceipt(runId);
      if (archived)
        interruptedExternalCompaction = { reason: event.reason, runId };
      sessionGeneration += 1;
      resetLifecycle(`external_${event.reason}_compaction`);
      notifyHumanReceipt(ctx, archived, { level: "warning" });
    }
    return undefined;
  });

  pi.on("session_compact", (event, ctx) => {
    if (
      !interruptedExternalCompaction ||
      interruptedExternalCompaction.reason !== event.reason ||
      lastHumanReceipt?.runId !== interruptedExternalCompaction.runId
    )
      return;
    if (currentHumanReceipt) {
      interruptedExternalCompaction = undefined;
      debug("external_compaction_supersession_ignored", {
        reason: "newer_run_active",
      });
      return;
    }
    const superseded = lastHumanReceipt;
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
      interruptedExternalCompaction = undefined;
      notifyHumanReceipt(ctx, superseded);
      debug("external_compaction_superseded_handoff", {
        reason: event.reason,
        willRetry: event.willRetry,
      });
    } catch (error) {
      superseded.pickup = "failed";
      superseded.outcome =
        "External compaction finished, but corrective pickup could not be requested.";
      interruptedExternalCompaction = undefined;
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
            ? "Invalid threshold: use a percent greater than 0 and less than 95"
            : command.usage,
          "warning",
        );
        return;
      }

      if (command.subcommand === "run") {
        const result = await startHandoff(ctx, "manual", command.prompt);
        if (!result.started && result.reason === "lifecycle_active")
          notify(
            ctx,
            `Auto Compact is already ${state.replaceAll("_", " ")}`,
            "warning",
          );
        else if (!result.started && result.reason === "pickup_prompt_unavailable")
          notify(
            ctx,
            "Auto Compact cannot start the prompted run: this Pi runtime cannot deliver the continuation prompt",
            "error",
          );
        return;
      }

      if (command.subcommand === "status") {
        const effective = await loadEffective(ctx);
        const usage = utilizationAtOrAboveThreshold(
          contextUsage(ctx),
          effective.settings.threshold,
        );
        const usageText = usage.known
          ? `; context ${friendlyPercent(usage.percent)}%`
          : "; context unavailable";
        const invalidText = effective.errors.length
          ? `; invalid settings: ${effective.errors.join("; ")}`
          : "";
        const receipt = currentHumanReceipt ?? lastHumanReceipt;
        const workflow = receipt
          ? `\n\n${renderHumanReceipt(receipt, {
              heading: currentHumanReceipt
                ? "Current workflow"
                : "Last workflow",
              includePrompt: true,
            })}`
          : "\n\nNo Auto Compact run this Session";
        notify(
          ctx,
          `Auto Compact is ${effective.settings.enabled ? "on" : "off"} at ${friendlyPercent(effective.settings.threshold)}%; state ${state.replaceAll("_", " ")}${usageText}${invalidText}${workflow}`,
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
        automaticEnabledOverride = false;
        configurationWarning = undefined;
        sessionGeneration += 1;
        if (state === "handoff_pending" || state === "ready") {
          const runId = lifecycle?.id;
          const interrupted = receiptForRun(runId);
          if (interrupted) {
            if (state === "handoff_pending") {
              interrupted.handoff = "interrupted";
              interrupted.compact = "not_requested";
            } else {
              interrupted.handoff = "done";
              interrupted.compact = "interrupted";
            }
            interrupted.pickup = "not_requested";
            interrupted.outcome =
              "The workflow was canceled before native compaction.";
          }
          canceledReceipt = archiveCurrentReceipt(runId);
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
        lifecycle: lifecycle
          ? { id: lifecycle.id, trigger: lifecycle.trigger }
          : undefined,
        usage: lastUsage,
        settings: { ...settingsSnapshot.settings },
        settingsErrors: [...settingsSnapshot.errors],
      };
    },
  };
}
