import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";

const { lock } = lockfile;

export const DEFAULT_PRE_COMPACT_PROMPT =
  "Preserve current progress, decisions, unresolved work, and the continuation context needed for the prior request.";

export const DEFAULT_AUTO_COMPACT_SETTINGS = Object.freeze({
  enabled: true,
  threshold: 90,
  pre_compact_prompt: DEFAULT_PRE_COMPACT_PROMPT,
});

export function isValidThreshold(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value < 95
  );
}

function settingsObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

export function mergeAutoCompactSettings(
  globalSettings = {},
  projectSettings = {},
) {
  return {
    ...settingsObject(globalSettings?.auto_compact),
    ...settingsObject(projectSettings?.auto_compact),
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
        "auto_compact.threshold must be greater than 0 and less than 95",
      );
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

  return { settings, errors };
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
