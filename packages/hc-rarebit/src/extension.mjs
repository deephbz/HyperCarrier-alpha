import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { complete } from "@earendil-works/pi-ai/compat";

export * from "./rarebit-core.mjs";
export * from "./rarebit-model.mjs";
export * from "./rarebit-service.mjs";
export * from "./rarebit-store.mjs";

import {
  processRarebitSummary,
  processRarebitTitle,
} from "./rarebit-service.mjs";
import { DEFAULT_RAREBIT_SUMMARY_POLICY, sha256 } from "./rarebit-core.mjs";
import { resolveRarebitSettings } from "./rarebit-settings.mjs";
import {
  getRarebitArgumentCompletions,
  parseRarebitCommand,
  rarebitCommandDescription,
} from "./rarebit-command.mjs";
import {
  createDetachedMaterializer,
  registerRarebitLifecycle,
} from "./lifecycle.mjs";

async function readSettings(path) {
  try {
    return { value: JSON.parse(await readFile(path, "utf8")), path };
  } catch (error) {
    if (error?.code === "ENOENT") return { value: {}, path };
    return { error, path };
  }
}

function configuredAgentDir(env = process.env) {
  return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export async function readConfiguredRarebitSettings({
  cwd,
  projectTrusted,
  agentDir = configuredAgentDir(),
} = {}) {
  const global = await readSettings(join(agentDir, "settings.json"));
  const project = projectTrusted
    ? await readSettings(join(cwd ?? process.cwd(), ".pi", "settings.json"))
    : { value: {}, path: null };
  const failed = [global, project].find((entry) => entry.error);
  const rawRefs = [global.path, project.path].filter(Boolean);
  if (failed)
    return {
      modelConfigurationError: `Cannot read configured Pi settings files: ${failed.error.message}`,
      modelProvenance: {
        source: "pi_settings_files",
        settingsKey: "rarebit.model",
        status: "invalid",
        rawRefs,
      },
    };
  const resolved = resolveRarebitSettings(global.value, project.value);
  return {
    ...(resolved.model ? { model: resolved.model } : {}),
    ...(resolved.modelConfigurationError
      ? { modelConfigurationError: resolved.modelConfigurationError }
      : {}),
    modelProvenance: {
      source: "rarebit_settings_files",
      settingsKey: "rarebit.model",
      status: resolved.model ? "resolved" : "invalid",
      rawRefs,
    },
    summaryPolicy: resolved.summaryPolicy,
    autoTitle: resolved.autoTitle,
  };
}

export default function registerPiRarebit(pi, config = {}) {
  const { settingsLoader = readConfiguredRarebitSettings, ...explicit } =
    config;
  if (!pi?.on) throw new TypeError("A Pi ExtensionAPI with .on is required");

  const notify = (ctx, text, level = "info") => {
    if (!ctx?.hasUI || typeof ctx?.ui?.notify !== "function") return;
    try {
      ctx.ui.notify(text, level);
    } catch {
      // TUI feedback is best-effort and must not change the materialization
      // outcome or the agent-visible Session.
    }
  };

  const modelLabel = ({ provider, id } = {}) =>
    [provider, id].filter(Boolean).join("/") || "unavailable";

  const resultModelLabel = (result) => {
    const receipt = result?.record?.synthesis;
    const requested = receipt?.requestedModel ?? result?.record?.model;
    const provider = receipt?.provider?.responseProvider ?? requested?.provider;
    const id = receipt?.provider?.responseModel ?? requested?.id;
    return modelLabel({ provider, id });
  };

  const tokenLabel = (name, value) =>
    typeof value === "number" && Number.isFinite(value)
      ? `${name} tokens: ${value}`
      : `${name} tokens: unavailable`;

  const notifyOutcome = (ctx, result, triggered) => {
    if (!triggered || result?.duplicate || result?.inFlight) return;
    switch (result?.record?.status) {
      case "ok":
        notify(
          ctx,
          `Rarebit Summary updated (${tokenLabel("input", result.record.synthesis?.usage?.inputTokens)} · ${tokenLabel("output", result.record.synthesis?.usage?.outputTokens)} · model ${resultModelLabel(result)})`,
          "info",
        );
        break;
      case "unavailable_overflow":
        notify(
          ctx,
          "Rarebit Summary unavailable: input is too large",
          "warning",
        );
        break;
      case "failure":
        notify(
          ctx,
          "Rarebit Summary failed; inspect its private materialization",
          "error",
        );
        break;
      case "conflict":
        notify(
          ctx,
          "Rarebit Summary conflict; inspect its private materialization",
          "warning",
        );
        break;
      default:
        break;
    }
  };

  let policyOverrides = {};
  const loadEffective = async (ctx) => {
    let injected = {};
    if (!explicit.model) {
      try {
        injected = await settingsLoader({
          cwd: ctx?.cwd,
          projectTrusted: ctx?.isProjectTrusted?.() === true,
        });
      } catch (error) {
        injected = {
          modelConfigurationError: `Cannot resolve configured Pi settings files: ${error?.message ?? error}`,
          modelProvenance: {
            source: "pi_settings_files",
            settingsKey: "rarebit.model",
            status: "invalid",
          },
        };
      }
    }
    const summaryPolicy = {
      ...(injected.summaryPolicy ?? DEFAULT_RAREBIT_SUMMARY_POLICY),
      ...(explicit.summaryPolicy ?? {}),
      ...policyOverrides,
    };
    return {
      ...injected,
      ...explicit,
      summaryPolicy,
      piAi: explicit.piAi ?? { complete },
    };
  };

  const materialize = async (ctx, { force = false } = {}) => {
    let synthesisTriggered = false;
    const effective = await loadEffective(ctx);
    const result = await processRarebitSummary(ctx, {
      ...effective,
      forceSynthesis: force,
      onSynthesisTriggered: (detail) => {
        synthesisTriggered = true;
        const count = detail.rarebitCount ?? detail.rarebitCount;
        notify(
          ctx,
          `Rarebit Summary triggered (${count} Rarebits · input tokens: ~${detail.estimatedInputTokens} estimated (chars/4) · model ${modelLabel(detail.model)})`,
          "info",
        );
      },
    });
    notifyOutcome(ctx, result, synthesisTriggered);
    return result;
  };
  const schedule = createDetachedMaterializer(materialize, (_error, ctx) => {
    notify(
      ctx,
      "Rarebit Summary failed; inspect its private materialization",
      "error",
    );
  });
  const scheduleManualSummary = createDetachedMaterializer(
    (ctx) => materialize(ctx, { force: true }),
    (_error, ctx) =>
      notify(
        ctx,
        "Rarebit Summary failed; inspect its private materialization",
        "error",
      ),
  );

  const identityFrom = (ctx) => ({
    sessionId: String(
      ctx?.sessionManager?.getHeader?.()?.id ?? ctx?.sessionId ?? "",
    ),
    sessionFile: ctx?.sessionManager?.getSessionFile?.(),
  });
  let activeSession;
  let autoTitleOverride;
  const ownerTitleEvidence = new Map();

  const sameActiveSession = ({ sessionId, sessionFile }) =>
    Boolean(
      activeSession &&
      activeSession.sessionId === sessionId &&
      activeSession.sessionFile === sessionFile,
    );
  const localIsoDate = (date = new Date()) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const generateTitle = async (ctx, { manual = false, ownerMessage } = {}) => {
    const session = identityFrom(ctx);
    if (!session.sessionId || !session.sessionFile)
      return { status: "skipped_unpersisted_session" };
    if (!sameActiveSession(session))
      return { status: "skipped_session_changed" };
    const priorTitle = pi.getSessionName?.();
    if (!manual && priorTitle) return { status: "skipped_existing_title" };
    const evidence = ownerMessage ?? ownerTitleEvidence.get(session.sessionId);
    const sourceEntryId = evidence?.sourceEntryId ?? null;
    if (!manual && !sourceEntryId && !evidence?.text) {
      return { status: "skipped_owner_evidence_not_found" };
    }
    const effective = await loadEffective(ctx);
    const result = await processRarebitTitle(ctx, {
      ...effective,
      sourceEntryId: sourceEntryId ?? undefined,
      sourceText: !sourceEntryId && evidence?.text ? evidence.text : undefined,
      allowFirstUserFallback: manual && !sourceEntryId,
      evidenceProvenance: evidence
        ? sourceEntryId
          ? "captured_interactive_rpc"
          : "captured_interactive_rpc_text_match"
        : "branch_user_fallback",
      titleDate: localIsoDate(),
      priorTitle: priorTitle ?? null,
      requestIdentity: manual ? `manual:${sha256(priorTitle ?? "")}` : "auto",
      applyTitle: ({ title }) => {
        if (!sameActiveSession(session))
          return { status: "skipped_session_changed" };
        if (manual && pi.getSessionName?.() !== priorTitle)
          return { status: "skipped_title_changed" };
        if (!manual && pi.getSessionName?.())
          return { status: "skipped_existing_title" };
        pi.setSessionName(title);
        return { status: "applied" };
      },
    });
    if (result.record?.status === "applied")
      notify(ctx, `Rarebit titled Session: ${result.record.title}`, "info");
    else if (
      manual &&
      result.record?.status === "skipped_owner_evidence_not_found"
    )
      notify(
        ctx,
        "Rarebit cannot generate a title: persisted owner-message evidence is unavailable",
        "warning",
      );
    return result;
  };
  const scheduleTitle = createDetachedMaterializer(
    (ctx) => generateTitle(ctx, { ownerMessage: ctx?.rarebitOwnerMessage }),
    (_error, ctx) =>
      notify(
        ctx,
        "Rarebit auto-title failed; use /rarebit title to retry",
        "error",
      ),
  );

  registerRarebitLifecycle(pi, schedule, {
    onSessionStart: (ctx) => {
      activeSession = identityFrom(ctx);
    },
    onSessionShutdown: () => {
      activeSession = undefined;
    },
    onFirstPersistedOwnerMessage: (ctx, ownerMessage) => {
      const sessionId = identityFrom(ctx).sessionId;
      ownerTitleEvidence.set(sessionId, ownerMessage);
      if (ownerTitleEvidence.size > 256)
        ownerTitleEvidence.delete(ownerTitleEvidence.keys().next().value);
      void loadEffective(ctx).then((effective) => {
        if (
          (autoTitleOverride ?? effective.autoTitle ?? true) &&
          !pi.getSessionName?.()
        )
          scheduleTitle({ ...ctx, rarebitOwnerMessage: ownerMessage });
      });
    },
  });

  pi.registerCommand?.("rarebit", {
    description: rarebitCommandDescription(),
    getArgumentCompletions: getRarebitArgumentCompletions,
    handler: async (args, ctx) => {
      const command = parseRarebitCommand(args);
      if (!command.ok) {
        notify(
          ctx,
          command.error === "invalid_value"
            ? "Invalid Rarebit config value"
            : command.usage,
          "warning",
        );
        return;
      }
      const { subcommand, arguments: rest } = command;
      const effective = await loadEffective(ctx);
      const policy = effective.summaryPolicy ?? DEFAULT_RAREBIT_SUMMARY_POLICY;
      if (
        subcommand === "status" ||
        (subcommand === "config" && rest.length === 0)
      ) {
        const ratioSource = Object.hasOwn(policyOverrides, "maxRarebitRatio")
          ? "process_override"
          : "settings_or_default";
        const lengthSource = Object.hasOwn(policyOverrides, "minTotalLength")
          ? "process_override"
          : "settings_or_default";
        notify(
          ctx,
          `Rarebit ${subcommand}: auto-title=${autoTitleOverride ?? effective.autoTitle ?? true}; max_rarebit_ratio=${policy.maxRarebitRatio} (${ratioSource}); min_total_length=${policy.minTotalLength} estimated tokens via ceil(chars/4) (${lengthSource}); measurement=${policy.measurementVersion}; model=${modelLabel(effective.model)} from ${effective.modelProvenance?.settingsKey ?? "explicit config"}`,
          "info",
        );
        return;
      }
      if (subcommand === "config") {
        const [name, rawValue] = rest;
        const value = Number(rawValue);
        if (name === "max_rarebit_ratio" && value >= 0 && value <= 1)
          policyOverrides = { ...policyOverrides, maxRarebitRatio: value };
        else if (name === "min_total_length" && value >= 0)
          policyOverrides = { ...policyOverrides, minTotalLength: value };
        else {
          notify(ctx, "Invalid Rarebit config value", "warning");
          return;
        }
        notify(ctx, `Rarebit process override set: ${name}=${value}`, "info");
        return;
      }
      if (subcommand === "auto-title") {
        const value = rest[0];
        if (value === "on") autoTitleOverride = true;
        else if (value === "off") autoTitleOverride = false;
        notify(
          ctx,
          `Rarebit auto-title is ${(autoTitleOverride ?? effective.autoTitle ?? true) ? "on" : "off"}`,
          "info",
        );
        return;
      }
      if (subcommand === "title") {
        void generateTitle(ctx, { manual: true }).catch(() =>
          notify(ctx, "Rarebit title generation failed", "error"),
        );
        return;
      }
      if (subcommand === "summarize") {
        scheduleManualSummary(ctx);
        return;
      }
    },
  });
}
