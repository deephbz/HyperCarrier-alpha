import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

function safeEntries(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function safePid(path) {
  try {
    const value = Number(String(readFileSync(path, "utf8")).trim());
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function memberPid(teamDir, member, runtime, livePids) {
  const lead = member.agentType === "lead";
  const path = lead ? join(teamDir, "lead-session.json") : join(teamDir, `${member.name}.pid`);
  const recorded = lead ? safeJson(path)?.pid : safePid(path);
  const candidate = Number(runtime?.pid ?? recorded);
  const valid =
    Number.isInteger(candidate) && candidate > 0 && (!livePids || livePids.has(candidate));
  return { pid: valid ? candidate : undefined, path: recorded === undefined ? undefined : path };
}

function terminalId(member) {
  if (typeof member.tmuxPaneId === "string" && member.tmuxPaneId) return member.tmuxPaneId;
  if (typeof member.windowId === "string" && member.windowId) return member.windowId;
  return undefined;
}

function projectMember(team, teamDir, member, livePids) {
  const runtimePath = join(teamDir, "runtime", `${member.name}.json`);
  const runtime = safeJson(runtimePath);
  const pid = memberPid(teamDir, member, runtime, livePids);
  const heartbeat = Number(runtime?.lastHeartbeatAt);
  const runtimeStartedAt = Number(runtime?.startedAt);
  const membershipId =
    typeof member.membershipId === "string" && member.membershipId
      ? member.membershipId
      : undefined;
  const runtimeMembershipId =
    typeof runtime?.membershipId === "string" && runtime.membershipId
      ? runtime.membershipId
      : undefined;
  return {
    teamName: team.name,
    agentName: member.name,
    role: member.agentType === "lead" ? "lead" : "teammate",
    cwd: typeof member.cwd === "string" ? member.cwd : undefined,
    model: typeof member.model === "string" ? member.model : undefined,
    configuredTerminalId: terminalId(member),
    pid: pid.pid,
    ready: typeof runtime?.ready === "boolean" ? runtime.ready : undefined,
    lastHeartbeatAt: Number.isFinite(heartbeat) ? new Date(heartbeat).toISOString() : undefined,
    source: team.source,
    runtimeSource: runtime ? runtimePath : undefined,
    pidSource: pid.path,
    // Internal cross-source locator. The collector uses it only for a
    // currently PID-validated Membership and strips it from the HTTP snapshot.
    sessionFile:
      typeof member.sessionFile === "string" && isAbsolute(member.sessionFile)
        ? member.sessionFile
        : undefined,
    isActive: member.isActive === true,
    membershipId,
    runtimeMembershipId,
    runtimeStartedAt: Number.isFinite(runtimeStartedAt)
      ? new Date(runtimeStartedAt).toISOString()
      : undefined,
  };
}

export function readPiTeams({ root = join(homedir(), ".pi", "teams"), livePids } = {}) {
  const teams = [];
  const memberships = [];
  const rejected = [];
  for (const directory of safeEntries(root).filter((entry) => entry.isDirectory())) {
    const teamDir = join(root, directory.name);
    const configPath = join(teamDir, "config.json");
    const config = safeJson(configPath);
    if (!config || typeof config.name !== "string" || !Array.isArray(config.members)) {
      rejected.push({ source: configPath, reason: "invalid_team_config" });
      continue;
    }
    const team = {
      name: config.name,
      createdAt: Number.isFinite(Number(config.createdAt))
        ? new Date(Number(config.createdAt)).toISOString()
        : undefined,
      source: configPath,
      memberCount: config.members.length,
    };
    teams.push(team);
    for (const member of config.members) {
      if (!member || typeof member.name !== "string") continue;
      memberships.push(projectMember(team, teamDir, member, livePids));
    }
  }
  return { teams, memberships, rejected };
}
