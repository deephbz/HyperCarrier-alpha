import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveRarebitSettings } from "./rarebit-settings.mjs";
import {
  processRarebitSummary,
  processRarebitTitle,
} from "./rarebit-service.mjs";
import {
  extractRarebits,
  queryRarebits,
  readRarebitSession,
} from "./rarebit-session.mjs";

export const RAREBIT_CLI_USAGE = `Usage:
  hc-rarebit query --session <exact-path-or-id> --json
  hc-rarebit extract --session <exact-path-or-id> --json
  hc-rarebit summarize --session <exact-path-or-id> [--force] [--model-command <executable> [--model-arg <arg>]] --json
  hc-rarebit title --session <exact-path-or-id> [--date YYYY-MM-DD] [--model-command <executable> [--model-arg <arg>]] --json

Normal summarize/title resolve rarebit.model from Pi settings. The optional model-command
adapter receives one prompt on stdin and must write only model text to stdout.
query is metadata-only; extract exposes raw selected Rarebit prose on demand.`;

function requiredValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${flag} requires a value`);
  return value;
}

export function parseRarebitCliArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const [command, ...rest] = argv;
  if (!new Set(["query", "extract", "summarize", "title"]).has(command))
    throw new Error(
      "First argument must be query, extract, summarize, or title",
    );
  const options = { command, modelArgs: [], json: false, force: false };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    switch (argument) {
      case "--session":
        options.session = requiredValue(rest, index, argument);
        index += 1;
        break;
      case "--model-command":
        options.modelCommand = requiredValue(rest, index, argument);
        index += 1;
        break;
      case "--model-arg":
        options.modelArgs.push(requiredValue(rest, index, argument));
        index += 1;
        break;
      case "--date":
        options.date = requiredValue(rest, index, argument);
        index += 1;
        break;
      case "--json":
        options.json = true;
        break;
      case "--force":
        options.force = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!options.session) throw new Error("--session is required");
  if (!options.json) throw new Error("--json is required");
  if (options.force && command !== "summarize")
    throw new Error("--force only applies to summarize");
  return options;
}

export function runModelCommand(
  command,
  args,
  prompt,
  { spawnProcess = spawn, env } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) =>
      reject(
        new Error(`Cannot start model command ${command}: ${error.message}`),
      ),
    );
    child.on("close", (code, signal) => {
      if (code === 0) return resolve(stdout);
      const detail =
        stderr.trim() ||
        `exit ${code ?? "null"}${signal ? ` (${signal})` : ""}`;
      reject(new Error(`Model command failed: ${detail}`));
    });
    child.stdin.end(prompt);
  });
}

/**
 * The normal CLI adapter deliberately invokes Pi in a stripped, ephemeral
 * print mode. Pi—not this package—continues to own credentials, provider
 * configuration, proxy behavior, and model transport.
 */
export function runPiRarebitModel({
  model,
  prompt,
  agentDir,
  piCommand = "pi",
  spawnProcess = spawn,
}) {
  const args = [
    "--print",
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "--no-prompt-templates",
    "--model",
    `${model.provider}/${model.id}`,
    "--system-prompt",
    "Return only the requested result. Do not use tools.",
  ];
  return runModelCommand(piCommand, args, prompt, {
    spawnProcess,
    env: {
      ...process.env,
      ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}),
    },
  });
}

function configuredAgentDir(env = process.env) {
  return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

async function jsonFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`Cannot read Pi settings ${path}: ${error.message}`);
  }
}

/** Read the narrow, explicit model/policy contract shared with the Pi shell. */
export async function readRarebitCliSettings({
  agentDir = configuredAgentDir(),
  cwd = process.cwd(),
} = {}) {
  const globalPath = join(agentDir, "settings.json");
  const projectPath = join(cwd, ".pi", "settings.json");
  const resolved = resolveRarebitSettings(
    await jsonFile(globalPath),
    await jsonFile(projectPath),
  );
  if (!resolved.model)
    throw new Error(
      resolved.modelConfigurationError ??
        "Rarebit model is not configured; set rarebit.model to provider/model in Pi settings",
    );
  return {
    agentDir,
    model: resolved.model,
    modelProvenance: {
      source: "pi_settings_files",
      settingsKey: "rarebit.model",
      status: "resolved",
      rawRefs: [globalPath, projectPath],
    },
    summaryPolicy: resolved.summaryPolicy,
    autoTitle: resolved.autoTitle,
  };
}

function contextForLoadedSession(loaded) {
  return {
    sessionManager: {
      getHeader: () => ({ id: loaded.session.id }),
      getSessionFile: () => loaded.sessionFile,
      getBranch: () => loaded.branch,
    },
  };
}

function sessionDate(session, explicitDate) {
  if (explicitDate) return explicitDate;
  const timestamp = session?.startedAt;
  if (typeof timestamp === "string" && /^\d{4}-\d{2}-\d{2}/.test(timestamp))
    return timestamp.slice(0, 10);
  throw new Error(
    "--date YYYY-MM-DD is required because the persisted Session has no ISO start date",
  );
}

async function modelRuntime(options, dependencies) {
  if (options.modelCommand) {
    return {
      model: { provider: "external-command", id: options.modelCommand },
      modelProvenance: { source: "explicit_model_command", status: "resolved" },
      summaryPolicy: {},
      complete: (prompt) =>
        dependencies.runModelCommand(
          options.modelCommand,
          options.modelArgs,
          prompt,
        ),
    };
  }
  const settings = await dependencies.readSettings();
  return {
    ...settings,
    complete: (prompt) =>
      dependencies.runPiModel({
        model: settings.model,
        prompt,
        agentDir: settings.agentDir,
      }),
  };
}

export async function runRarebitCli(options, dependencies = {}) {
  const runtimeDependencies = {
    readSettings: dependencies.readSettings ?? readRarebitCliSettings,
    runPiModel: dependencies.runPiModel ?? runPiRarebitModel,
    runModelCommand: dependencies.runModelCommand ?? runModelCommand,
    processSummary: dependencies.processSummary ?? processRarebitSummary,
    processTitle: dependencies.processTitle ?? processRarebitTitle,
  };
  if (options.command === "query") return queryRarebits(options.session);
  if (options.command === "extract") return extractRarebits(options.session);

  const loaded = await readRarebitSession(options.session);
  const runtime = await modelRuntime(options, runtimeDependencies);
  if (options.command === "summarize") {
    const result = await runtimeDependencies.processSummary(
      contextForLoadedSession(loaded),
      {
        model: runtime.model,
        modelProvenance: runtime.modelProvenance,
        summaryPolicy: runtime.summaryPolicy,
        forceSynthesis: options.force === true,
        allowExternalSession: true,
        modelClient: {
          complete: async ({ prompt }) => ({
            text: await runtime.complete(prompt),
          }),
        },
      },
    );
    return {
      operation: "summary",
      status: result.record.status,
      duplicate: result.duplicate === true,
      inFlight: result.inFlight === true,
      record: result.record,
    };
  }

  const result = await runtimeDependencies.processTitle(
    contextForLoadedSession(loaded),
    {
      model: runtime.model,
      modelProvenance: runtime.modelProvenance,
      allowFirstUserFallback: true,
      evidenceProvenance: "branch_user_fallback",
      titleDate: sessionDate(loaded.session, options.date),
      allowExternalSession: true,
      modelClient: {
        complete: async ({ prompt }) => ({
          text: await runtime.complete(prompt),
        }),
      },
    },
  );
  return {
    operation: "title",
    status: result.record.status,
    duplicate: result.duplicate === true,
    inFlight: result.inFlight === true,
    session: loaded.session,
    title: result.record.title,
    record: result.record,
  };
}
