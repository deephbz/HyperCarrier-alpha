import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { complete } from "@earendil-works/pi-ai/compat";

export * from "./index.mjs";

import { processKeyMessageSummary } from "./index.mjs";

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

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function modelFromPiDefaults(settings) {
  const defaultModel = nonEmptyString(settings?.defaultModel);
  const defaultProvider = nonEmptyString(settings?.defaultProvider);
  if (!defaultModel) return { error: "Pi setting defaultModel is missing" };

  if (defaultProvider)
    return { model: { provider: defaultProvider, id: defaultModel } };

  const separator = defaultModel.indexOf("/");
  if (separator > 0 && separator < defaultModel.length - 1)
    return {
      model: {
        provider: defaultModel.slice(0, separator),
        id: defaultModel.slice(separator + 1),
      },
    };

  return {
    error:
      "Pi settings need defaultProvider with defaultModel, or a provider/model defaultModel",
  };
}

export async function readConfiguredKeyMessageSummarySettings({
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
        settingsKey: "defaultProvider + defaultModel",
        status: "invalid",
        rawRefs,
      },
    };
  // The extension inherits normal Pi defaults. It owns no provider/model
  // preference and a trusted Project may use Pi's usual settings override.
  const effective = { ...global.value, ...project.value };
  const resolved = modelFromPiDefaults(effective);
  return {
    ...(resolved.model ? { model: resolved.model } : {}),
    ...(resolved.error ? { modelConfigurationError: resolved.error } : {}),
    modelProvenance: {
      source: "pi_default_model_settings",
      settingsKey: "defaultProvider + defaultModel",
      status: resolved.model ? "resolved" : "invalid",
      rawRefs,
    },
  };
}

export default function registerPiKeyMessageSummary(pi, config = {}) {
  const { settingsLoader = readConfiguredKeyMessageSummarySettings, ...explicit } = config;
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

  const notifyOutcome = (ctx, result, triggered) => {
    if (!triggered || result?.duplicate || result?.inFlight) return;
    switch (result?.record?.status) {
      case "ok":
        notify(ctx, "Key Message Summary updated", "info");
        break;
      case "unavailable_overflow":
        notify(ctx, "Key Message Summary unavailable: input is too large", "warning");
        break;
      case "failure":
        notify(ctx, "Key Message Summary failed; inspect its private sidecar", "error");
        break;
      case "conflict":
        notify(ctx, "Key Message Summary conflict; inspect its private sidecar", "warning");
        break;
      default:
        break;
    }
  };

  const materialize = async (ctx) => {
    let synthesisTriggered = false;
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
            settingsKey: "defaultProvider + defaultModel",
            status: "invalid",
          },
        };
      }
    }
    try {
      const result = await processKeyMessageSummary(ctx, {
        ...injected,
        ...explicit,
        piAi: explicit.piAi ?? { complete },
        onSynthesisTriggered: (detail) => {
          synthesisTriggered = true;
          notify(
            ctx,
            `Key Message Summary triggered (${detail.activation.toolCallCount} tool calls, ${detail.activation.continuationCount} continuations)`,
            "info",
          );
        },
      });
      notifyOutcome(ctx, result, synthesisTriggered);
      return result;
    } catch (error) {
      if (synthesisTriggered)
        notify(ctx, "Key Message Summary failed; inspect its private sidecar", "error");
      throw error;
    }
  };
  // A reload/resume/fork must be able to materialize an existing durable
  // Session immediately. Idempotent input identity makes this safe; exact
  // same-branch records are deduplicated rather than re-summarized.
  pi.on("session_start", async (_event, ctx) => materialize(ctx));
  // Pi's `agent_end` fires once after the complete agent loop for a user
  // prompt. `turn_end` is too early (it repeats after tool use), while an
  // invented `agent_settled` hook would never run.
  pi.on("agent_end", async (_event, ctx) => materialize(ctx));
}
