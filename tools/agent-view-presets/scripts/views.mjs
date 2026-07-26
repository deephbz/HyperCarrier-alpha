import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  appendReceipt,
  MODE_ALL_AGENTS,
  MODE_NO_TEAMMATES,
  pluginStateDirectory,
  readMode,
  socketRequest,
  SOURCE,
  teamsDirectory,
  writeMode,
} from "./lib.mjs";

const MAX_TEAM_CONFIG_BYTES = 1_000_000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactActiveHerdrTeammatePane(member) {
  if (
    !isRecord(member) ||
    member.agentType !== "teammate" ||
    member.isActive === false
  ) {
    return null;
  }
  const target = member.terminalTarget;
  return isRecord(target) &&
    target.backend === "herdr" &&
    target.kind === "pane" &&
    typeof target.targetId === "string" &&
    target.targetId.length > 0
    ? target.targetId
    : null;
}

function readTeamConfig(configPath) {
  const before = statSync(configPath);
  if (!before.isFile()) throw new Error("not a regular file");
  if (before.size > MAX_TEAM_CONFIG_BYTES) {
    throw new Error(`exceeds ${MAX_TEAM_CONFIG_BYTES} bytes`);
  }
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const after = statSync(configPath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("changed during read");
  }
  if (!isRecord(config) || !Array.isArray(config.members)) {
    throw new Error("does not contain a members array");
  }
  return config;
}

export function readTeammatePaneProjection(teamsRoot = teamsDirectory()) {
  let entries;
  try {
    entries = readdirSync(teamsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { paneIds: [], teamCount: 0, configCount: 0 };
    }
    throw new Error(`PiTeams state is unavailable: ${error.message}`);
  }

  const paneIds = new Set();
  const issues = [];
  let configCount = 0;
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isDirectory()) continue;
    const configPath = join(teamsRoot, entry.name, "config.json");
    let config;
    try {
      config = readTeamConfig(configPath);
    } catch (error) {
      // A directory without config.json is not a current Team record. PiTeams
      // test/probe residue can legitimately leave such directories behind.
      if (error?.code === "ENOENT") continue;
      issues.push(`${entry.name}: ${error.message}`);
      continue;
    }
    configCount += 1;
    for (const member of config.members) {
      const paneId = exactActiveHerdrTeammatePane(member);
      if (paneId) paneIds.add(paneId);
    }
  }

  if (issues.length > 0) {
    throw new Error(
      `PiTeams state is incomplete; Agent view unchanged (${issues.join("; ")})`,
    );
  }
  return {
    paneIds: [...paneIds].sort(),
    teamCount: configCount,
    configCount,
  };
}

export function noTeammatesViewParams(paneIds) {
  const uniquePaneIds = [...new Set(paneIds)].sort();
  return {
    source: SOURCE,
    label: "no teammates",
    ...(uniquePaneIds.length > 0
      ? {
          filter: {
            op: "not",
            filter: {
              op: "in",
              field: "pane_id",
              values: uniquePaneIds,
            },
          },
        }
      : {}),
  };
}

export async function applyNoTeammates({
  teamsRoot = teamsDirectory(),
  stateDirectory = pluginStateDirectory(),
  request = socketRequest,
  record = appendReceipt,
} = {}) {
  const projection = readTeammatePaneProjection(teamsRoot);
  const params = noTeammatesViewParams(projection.paneIds);
  const result = await request("agent.view.set", params);
  writeMode(MODE_NO_TEAMMATES, stateDirectory);
  record(
    "agent_view_set",
    {
      mode: MODE_NO_TEAMMATES,
      teammatePaneCount: projection.paneIds.length,
      observedTeamCount: projection.teamCount,
    },
    stateDirectory,
  );
  return { mode: MODE_NO_TEAMMATES, projection, result };
}

export async function showAllAgents({
  stateDirectory = pluginStateDirectory(),
  request = socketRequest,
  record = appendReceipt,
} = {}) {
  const result = await request("agent.view.clear", { source: SOURCE });
  writeMode(MODE_ALL_AGENTS, stateDirectory);
  record("agent_view_cleared", { mode: MODE_ALL_AGENTS }, stateDirectory);
  return { mode: MODE_ALL_AGENTS, result };
}

export async function toggleTeammates(options = {}) {
  const stateDirectory = options.stateDirectory ?? pluginStateDirectory();
  return readMode(stateDirectory) === MODE_NO_TEAMMATES
    ? showAllAgents({ ...options, stateDirectory })
    : applyNoTeammates({ ...options, stateDirectory });
}

export async function refreshSelectedView(options = {}) {
  const stateDirectory = options.stateDirectory ?? pluginStateDirectory();
  return readMode(stateDirectory) === MODE_NO_TEAMMATES
    ? applyNoTeammates({ ...options, stateDirectory })
    : { mode: MODE_ALL_AGENTS, unchanged: true };
}
