import { isAbsolute, normalize } from "node:path";
import { pathToFileURL } from "node:url";

const OBSERVATION_SCHEMA = "pi-teams-observation/1";
const DEFAULT_DEADLINE_MS = 1_000;

function safeIssue(issue) {
  if (!issue || typeof issue !== "object" || typeof issue.code !== "string") return undefined;
  return {
    provider: "pi_teams",
    reason: issue.code,
    scope:
      issue.scope === "snapshot" || issue.scope === "team" || issue.scope === "membership"
        ? issue.scope
        : "snapshot",
    ...(typeof issue.teamName === "string" ? { teamName: issue.teamName } : {}),
    ...(typeof issue.memberName === "string" ? { agentName: issue.memberName } : {}),
  };
}

function terminalTarget(value) {
  if (
    !value ||
    typeof value.backend !== "string" ||
    (value.kind !== "pane" && value.kind !== "window") ||
    typeof value.targetId !== "string"
  )
    return undefined;
  return { backend: value.backend, kind: value.kind, id: value.targetId };
}

function projectMembership(episode, source, parentTeamName) {
  if (
    !episode ||
    typeof episode.membershipId !== "string" ||
    episode.teamName !== parentTeamName ||
    typeof episode.memberName !== "string" ||
    (episode.coordinationRole !== "lead" && episode.coordinationRole !== "teammate") ||
    (episode.lifecycle?.state !== "current" && episode.lifecycle?.state !== "ended")
  )
    return undefined;
  const binding = episode.processBinding;
  const exactGeneration =
    binding &&
    binding.membershipId === episode.membershipId &&
    Number.isInteger(binding.pid) &&
    binding.pid > 1 &&
    typeof binding.processStartedAt === "string";
  const target = terminalTarget(episode.terminalTarget);
  return {
    teamName: episode.teamName,
    agentName: episode.memberName,
    role: episode.coordinationRole,
    configuredTerminalId: target?.id,
    terminalTarget: target,
    pid: exactGeneration ? binding.pid : undefined,
    ready:
      exactGeneration && typeof episode.readiness === "boolean" ? episode.readiness : undefined,
    source,
    sessionFile:
      episode.session?.kind === "pi-jsonl-path" &&
      typeof episode.session.locator === "string" &&
      isAbsolute(episode.session.locator) &&
      normalize(episode.session.locator) === episode.session.locator
        ? episode.session.locator
        : undefined,
    isActive: episode.lifecycle.state === "current",
    membershipId: episode.membershipId,
    runtimeMembershipId: exactGeneration ? binding.membershipId : undefined,
    runtimeStartedAt: exactGeneration ? binding.processStartedAt : undefined,
    lifecycle: episode.lifecycle,
  };
}

function unavailable(reason) {
  return {
    teams: [],
    memberships: [],
    rejected: [{ provider: "pi_teams", reason, scope: "snapshot" }],
    observation: {
      schema: OBSERVATION_SCHEMA,
      availability: "unavailable",
      producerVersion: undefined,
      issueCount: 1,
    },
  };
}

async function defaultProjector(options) {
  const configured = process.env.PI_TIMELINE_PI_TEAMS_OBSERVATION_MODULE;
  const specifier = configured
    ? configured.startsWith("/")
      ? pathToFileURL(configured).href
      : configured
    : "@hypercarrier/pi-team-bright/observation";
  const module = await import(specifier);
  if (typeof module.readObservationSnapshot !== "function")
    throw new Error("pi_teams_observation_projector_missing");
  return module.readObservationSnapshot(options);
}

function safeIssues(issues) {
  return (Array.isArray(issues) ? issues : []).map(safeIssue).filter(Boolean);
}

function projectTeam(team, source) {
  if (!team || typeof team.teamName !== "string" || !Array.isArray(team.memberships))
    return {
      rejected: [{ provider: "pi_teams", reason: "invalid_team_observation", scope: "team" }],
    };
  const memberships = [];
  const rejected = safeIssues(team.issues);
  for (const episode of team.memberships) {
    const membership = projectMembership(episode, source, team.teamName);
    if (!membership) {
      rejected.push({
        provider: "pi_teams",
        reason: "invalid_membership_observation",
        scope: "team",
        teamName: team.teamName,
      });
      continue;
    }
    memberships.push(membership);
    rejected.push(...safeIssues(episode.issues));
  }
  return {
    team: { name: team.teamName, source, memberCount: team.memberships.length },
    memberships,
    rejected,
  };
}

function availability(value) {
  return value === "available" || value === "partial" || value === "unavailable"
    ? value
    : "unavailable";
}

/**
 * Consume PiTeams' public recorded-evidence projection. This adapter never
 * treats recorded Process generation or readiness as OS liveness.
 */
export async function readPiTeams({
  root,
  deadlineMs = DEFAULT_DEADLINE_MS,
  signal,
  readObservationSnapshot = defaultProjector,
} = {}) {
  let snapshot;
  try {
    snapshot = await readObservationSnapshot({
      ...(root ? { teamsRoot: root } : {}),
      deadlineMs,
      ...(signal ? { signal } : {}),
    });
  } catch {
    return unavailable("provider_unavailable");
  }
  if (!snapshot || snapshot.schema !== OBSERVATION_SCHEMA)
    return unavailable("unsupported_observation_schema");
  if (!Array.isArray(snapshot.teams) || !Array.isArray(snapshot.issues))
    return unavailable("invalid_observation_snapshot");

  const source = `${snapshot.schema}:${snapshot.producerVersion ?? "unknown"}`;
  const teams = [];
  const memberships = [];
  const rejected = safeIssues(snapshot.issues);
  for (const teamObservation of snapshot.teams) {
    const projected = projectTeam(teamObservation, source);
    if (projected.team) teams.push(projected.team);
    memberships.push(...(projected.memberships ?? []));
    rejected.push(...projected.rejected);
  }
  return {
    teams,
    memberships,
    rejected,
    observation: {
      schema: snapshot.schema,
      producerVersion: snapshot.producerVersion,
      availability: availability(snapshot.availability),
      issueCount: rejected.length,
      generatedAt: typeof snapshot.generatedAt === "string" ? snapshot.generatedAt : undefined,
    },
  };
}
