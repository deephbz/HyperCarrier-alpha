import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { complete } from "@earendil-works/pi-ai/compat";

export * from "./index.mjs";

import { processSettlement } from "./index.mjs";

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

export async function readConfiguredRecentOutputSettings({
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
        settingsKey: "hcRecentOutput.model",
        status: "invalid",
        rawRefs,
      },
    };
  const effective = {
    ...(global.value?.hcRecentOutput ?? {}),
    ...(project.value?.hcRecentOutput ?? {}),
  };
  return {
    ...(Object.hasOwn(effective, "model") ? { model: effective.model } : {}),
    modelProvenance: {
      source: "pi_settings_files",
      settingsKey: "hcRecentOutput.model",
      status: Object.hasOwn(effective, "model") ? "resolved" : "missing",
      rawRefs,
    },
  };
}

export default function registerPiRecentOutput(pi, config = {}) {
  const { settingsLoader = readConfiguredRecentOutputSettings, ...explicit } = config;
  if (!pi?.on) throw new TypeError("A Pi ExtensionAPI with .on is required");
  pi.on("agent_settled", async (_event, ctx) => {
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
            settingsKey: "hcRecentOutput.model",
            status: "invalid",
          },
        };
      }
    }
    return processSettlement(ctx, {
      ...injected,
      ...explicit,
      piAi: explicit.piAi ?? { complete },
    });
  });
}
