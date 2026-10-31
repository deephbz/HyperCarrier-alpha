import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { resolveAutoCompactSettings, settingsObject } from "./resolve.mjs";

export * from "./resolve.mjs";

const { lock } = lockfile;

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
