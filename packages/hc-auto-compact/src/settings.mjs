import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { isValidThreshold } from "./threshold.mjs";

export { isValidThreshold };

const { lock } = lockfile;

export const DEFAULT_PRE_COMPACT_PROMPT =
  "Preserve current progress, decisions, unresolved work, and the continuation context needed for the prior request.";

export const DEFAULT_AUTO_COMPACT_SETTINGS = Object.freeze({
  enabled: true,
  threshold: 90,
  preservation: "artifact-handoff",
  method: "keepset",
  execution: "foreground",
  pre_compact_prompt: DEFAULT_PRE_COMPACT_PROMPT,
});

function settingsObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

export function mergeAutoCompactSettings(
  globalSettings = {},
  projectSettings = {},
) {
  const global = settingsObject(globalSettings?.auto_compact);
  const project = settingsObject(projectSettings?.auto_compact);
  return {
    ...global,
    ...project,
    ...(global.modelOverrides !== undefined ||
    project.modelOverrides !== undefined
      ? {
          modelOverrides: {
            ...settingsObject(global.modelOverrides),
            ...settingsObject(project.modelOverrides),
          },
        }
      : {}),
  };
}

export function resolveAutoCompactSettings(
  globalSettings = {},
  projectSettings = {},
) {
  const configured = mergeAutoCompactSettings(globalSettings, projectSettings);
  const errors = [];
  const settings = { ...DEFAULT_AUTO_COMPACT_SETTINGS };

  if (configured.enabled !== undefined) {
    if (typeof configured.enabled === "boolean")
      settings.enabled = configured.enabled;
    else errors.push("auto_compact.enabled must be true or false");
  }

  if (configured.threshold !== undefined) {
    if (isValidThreshold(configured.threshold))
      settings.threshold = configured.threshold;
    else
      errors.push(
        "auto_compact.threshold must be greater than 1 and less than 110",
      );
  }

  if (configured.budget_tokens !== undefined) {
    if (
      Number.isSafeInteger(configured.budget_tokens) &&
      configured.budget_tokens > 0
    )
      settings.budget_tokens = configured.budget_tokens;
    else errors.push("auto_compact.budget_tokens must be a positive integer");
  }

  if (configured.modelOverrides !== undefined) {
    settings.modelOverrides = {};
    for (const [key, override] of Object.entries(
      settingsObject(configured.modelOverrides),
    )) {
      if (
        override &&
        typeof override === "object" &&
        !Array.isArray(override) &&
        override.budget_tokens === undefined
      )
        continue;
      if (
        Number.isSafeInteger(override?.budget_tokens) &&
        override.budget_tokens > 0
      )
        settings.modelOverrides[key] = {
          budget_tokens: override.budget_tokens,
        };
      else
        errors.push(
          `auto_compact.modelOverrides[${key}].budget_tokens must be a positive integer`,
        );
    }
  }

  if (configured.pre_compact_prompt !== undefined) {
    if (
      typeof configured.pre_compact_prompt === "string" &&
      configured.pre_compact_prompt.trim()
    )
      settings.pre_compact_prompt = configured.pre_compact_prompt.trim();
    else
      errors.push("auto_compact.pre_compact_prompt must be a non-empty string");
  }

  for (const [key, values] of Object.entries({
    preservation: ["artifact-handoff", "none"],
    method: ["native", "summary", "keepset"],
    execution: ["foreground", "background"],
  })) {
    if (configured[key] === undefined) continue;
    if (values.includes(configured[key])) settings[key] = configured[key];
    else errors.push(`auto_compact.${key} must be ${values.join(" or ")}`);
  }
  if (settings.execution === "background" && settings.method === "native")
    errors.push("background requires method summary or keepset");

  const globalOverrides = settingsObject(
    globalSettings.compaction?.modelOverrides,
  );
  const projectOverrides = settingsObject(
    projectSettings.compaction?.modelOverrides,
  );
  const modelOverrides = { ...globalOverrides, ...projectOverrides };
  for (const [key, override] of Object.entries(projectOverrides)) {
    if (override && typeof override === "object" && !Array.isArray(override))
      modelOverrides[key] = {
        ...settingsObject(globalOverrides[key]),
        ...override,
      };
  }
  const compaction = {
    ...settingsObject(globalSettings.compaction),
    ...settingsObject(projectSettings.compaction),
    modelOverrides,
  };
  return { settings, errors, compaction, strategyConfigured: Object.fromEntries(
    STRATEGY_KEYS.map((key) => [key, configured[key]])), };
}

export const STRATEGY_KEYS = ["preservation", "method", "execution"];
const STRATEGY_VALUES = {
  preservation: ["artifact-handoff", "none"],
  method: ["native", "summary", "keepset"],
  execution: ["foreground", "background"],
};

// Resolve next-run intent independently from the active lifecycle snapshot.
export function resolveSessionStrategy(base = {}, overrides = {}) {
  const settings = { ...DEFAULT_AUTO_COMPACT_SETTINGS, ...base.settings };
  const errors = (base.errors ?? []).filter((error) =>
    !error.startsWith("background requires") &&
    !(base.strategyConfigured && STRATEGY_KEYS.some((key) => error.startsWith(`auto_compact.${key} `))) &&
    !STRATEGY_KEYS.some((key) => Object.hasOwn(overrides, key) && error.startsWith(`auto_compact.${key} `)));
  for (const key of STRATEGY_KEYS) {
    const value = Object.hasOwn(overrides, key) ? overrides[key]
      : base.strategyConfigured ? base.strategyConfigured[key] : settings[key];
    if (value === undefined) settings[key] = DEFAULT_AUTO_COMPACT_SETTINGS[key];
    else if (STRATEGY_VALUES[key].includes(value)) settings[key] = value;
    else errors.push(`auto_compact.${key} must be ${STRATEGY_VALUES[key].join(" or ")}`);
  }
  if (settings.execution === "background" && settings.method === "native")
    errors.push("background requires method summary or keepset");
  return { ...base, settings, errors };
}

export function configuredAgentDir(env = process.env) {
  return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

async function readJsonSettings(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`Cannot read Pi settings ${path}: ${error.message}`, {
      cause: error,
    });
  }
}

export async function readConfiguredAutoCompactSettings({
  cwd = process.cwd(),
  projectTrusted = false,
  agentDir = configuredAgentDir(),
} = {}) {
  const globalPath = join(agentDir, "settings.json");
  const projectPath = projectTrusted
    ? join(cwd, ".pi", "settings.json")
    : undefined;
  const [globalSettings, projectSettings] = await Promise.all([
    readJsonSettings(globalPath),
    projectPath ? readJsonSettings(projectPath) : {},
  ]);
  return {
    ...resolveAutoCompactSettings(globalSettings, projectSettings),
    rawRefs: [globalPath, projectPath].filter(Boolean),
  };
}

async function writeJsonSettings(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/**
 * Persist only the extension namespace. A trusted Project receives the
 * override; otherwise the global Pi settings file is the durable target.
 */
let settingsWriteQueue = Promise.resolve();

async function writeConfiguredAutoCompactSettingsNow({
  cwd,
  projectTrusted,
  agentDir,
  patch,
}) {
  const scope = projectTrusted ? "project" : "global";
  const path =
    scope === "project"
      ? join(cwd, ".pi", "settings.json")
      : join(agentDir, "settings.json");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const release = await lock(path, {
    realpath: false,
    retries: {
      retries: 8,
      factor: 1.5,
      minTimeout: 10,
      maxTimeout: 250,
    },
  });
  try {
    const current = await readJsonSettings(path);
    const next = {
      ...settingsObject(current),
      auto_compact: {
        ...settingsObject(current?.auto_compact),
        ...patch,
      },
    };
    await writeJsonSettings(path, next);
    return { path, scope };
  } finally {
    await release();
  }
}

export function writeConfiguredAutoCompactSettings({
  cwd = process.cwd(),
  projectTrusted = false,
  agentDir = configuredAgentDir(),
  patch = {},
} = {}) {
  const write = settingsWriteQueue.then(() =>
    writeConfiguredAutoCompactSettingsNow({
      cwd,
      projectTrusted,
      agentDir,
      patch,
    }),
  );
  settingsWriteQueue = write.catch(() => {});
  return write;
}
