import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DIRECT_MAX_AGE_MS = 120_000;
const START_TOLERANCE_MS = 2_500;
const SOLO_STARTUP_GRACE_MS = 120_000;
/** One snapshot plus at most 64 Pi-pane probes is the documented provider pass budget. */
const HERDR_MAX_PANES = 64;
const HERDR_PASS_DEADLINE_MS = 5_000;

const safeError = (error) => ({
  kind: error?.name || "Error",
  code: typeof error?.code === "string" ? error.code : undefined,
});
const validDate = (value) => Number.isFinite(Date.parse(value ?? ""));
const issue = (code) => ({ code, message: code.replaceAll("_", " ") });

/** Process observations are OS facts. Providers may decorate, but never create them. */
export function observePiProcesses(processes, now = new Date().toISOString()) {
  return processes.map((process) => ({
    id: `pid:${process.pid}:start:${process.startTime ?? "unknown"}`,
    pid: process.pid,
    processStartedAt: process.startTime,
    observedAt: now,
    cwd: undefined,
    locations: [],
    issues: process.startTime ? [] : [issue("process_start_unknown")],
    process: { pid: process.pid, state: "running" },
  }));
}

/** tmux is a location provider, not the fleet inventory. */
export function applyTmuxLocations(observations, mapped) {
  const byPid = new Map(observations.map((observation) => [observation.pid, observation]));
  for (const { process, pane } of mapped) {
    const observation = byPid.get(process.pid);
    if (!observation) continue;
    observation.cwd ??= pane.cwd;
    observation.locations.push({
      provider: "tmux",
      serverSocket: pane.serverSocket,
      sessionName: pane.sessionName,
      windowId: pane.windowId,
      windowIndex: pane.windowIndex,
      windowName: pane.windowName,
      paneId: pane.paneId,
      cwd: pane.cwd,
    });
  }
}

function runJson(run, command, args, timeout = 2_000) {
  return JSON.parse(
    String(run(command, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] })),
  );
}

function descendantsByPid(observations, processes) {
  const observed = new Map(observations.map((item) => [item.pid, item]));
  const children = new Map();
  for (const process of processes)
    children.set(process.ppid, [...(children.get(process.ppid) ?? []), process.pid]);
  return (root) => {
    const result = new Set();
    const queue = [root];
    while (queue.length) {
      const pid = queue.shift();
      if (observed.has(pid)) result.add(pid);
      queue.push(...(children.get(pid) ?? []));
    }
    return [...result];
  };
}

function catalogSession(catalogSessions, value) {
  if (typeof value !== "string") return undefined;
  return catalogSessions.find((item) => {
    try {
      return resolve(item.source) === resolve(value);
    } catch {
      return false;
    }
  });
}

function decorateHerdrObservation(observation, pane, session, now, trace, allowClaim) {
  observation.cwd ??= typeof pane.foreground_cwd === "string" ? pane.foreground_cwd : pane.cwd;
  observation.locations.push({
    provider: "herdr",
    paneId: pane.pane_id,
    tabId: pane.tab_id,
    workspaceId: pane.workspace_id,
    cwd: observation.cwd,
  });
  trace.locations += 1;
  if (!allowClaim) return undefined;
  if (!session) {
    if (!observation.issues.some((entry) => entry.code === "provider_session_unavailable"))
      observation.issues.push(issue("provider_session_unavailable"));
    return undefined;
  }
  trace.claims += 1;
  return {
    processId: observation.id,
    sessionId: session.id,
    provider: "herdr",
    method: "native_session",
    observedAt: new Date(now).toISOString(),
  };
}

function herdrPanePids(run, binary, pane, descendants, trace, timeout) {
  if (!pane || typeof pane.pane_id !== "string" || !pane.pane_id) {
    trace.malformed += 1;
    return [];
  }
  try {
    const info = runJson(run, binary, ["pane", "process-info", "--pane", pane.pane_id], timeout)
      ?.result?.process_info;
    if (!info || typeof info !== "object") {
      trace.malformed += 1;
      return [];
    }
    const roots = [
      info.shell_pid,
      ...(Array.isArray(info.foreground_processes)
        ? info.foreground_processes.map((item) => item?.pid)
        : []),
    ].filter(Number.isInteger);
    return [...new Set(roots.flatMap(descendants))];
  } catch (error) {
    if (error?.code === "ETIMEDOUT" || error?.killed) trace.timedOut += 1;
    else if (error instanceof SyntaxError) trace.malformed += 1;
    else trace.rejected += 1;
    return [];
  }
}

function applyHerdrPaneEvidence({ paneObservations, pane, catalogSessions, now, trace }) {
  const allowClaim = paneObservations.length === 1;
  if (!allowClaim)
    for (const observation of paneObservations)
      if (!observation.issues.some((entry) => entry.code === "provider_process_ambiguous"))
        observation.issues.push(issue("provider_process_ambiguous"));
  const session = catalogSession(catalogSessions, pane.agent_session.value);
  return paneObservations.flatMap((observation) => {
    const claim = decorateHerdrObservation(observation, pane, session, now, trace, allowClaim);
    return claim ? [claim] : [];
  });
}

/** Herdr 0.7.5 locations/claims are joined only to an existing OS observation. */
export function readHerdrProvider({
  run = execFileSync,
  catalogSessions,
  observations,
  processes = [],
  now = Date.now(),
  clock = Date.now,
  herdrBinary = process.env.PI_TIMELINE_HERDR_BIN || join(homedir(), ".local", "bin", "herdr"),
} = {}) {
  const trace = {
    provider: "herdr",
    ok: false,
    claims: 0,
    locations: 0,
    rejected: 0,
    capped: 0,
    budget: HERDR_MAX_PANES,
    deadlineMs: HERDR_PASS_DEADLINE_MS,
    timedOut: 0,
    deadlineSkipped: 0,
    malformed: 0,
    ignored: 0,
  };
  const startedAt = clock();
  const deadline = startedAt + HERDR_PASS_DEADLINE_MS;
  try {
    const snapshotTimeout = Math.max(1, Math.min(2_000, deadline - clock()));
    const panes = runJson(run, herdrBinary, ["api", "snapshot"], snapshotTimeout)?.result?.snapshot
      ?.panes;
    if (!Array.isArray(panes)) {
      trace.malformed += 1;
      throw new Error("invalid_snapshot");
    }
    const piPanes = panes.filter(
      (pane) =>
        pane?.agent_session?.agent === "pi" &&
        pane.agent_session.kind === "path" &&
        pane.agent_session.source === "herdr:pi",
    );
    trace.ignored = panes.length - piPanes.length;
    const selectedPanes = piPanes.slice(0, HERDR_MAX_PANES);
    trace.capped = piPanes.length - selectedPanes.length;
    const byPid = new Map(observations.map((item) => [item.pid, item]));
    const descendants = descendantsByPid(observations, processes);
    const claims = [];
    for (let index = 0; index < selectedPanes.length; index += 1) {
      const pane = selectedPanes[index];
      const remaining = deadline - clock();
      if (remaining <= 0) {
        trace.deadlineSkipped += selectedPanes.length - index;
        break;
      }
      if (typeof pane?.agent_session?.value !== "string" || !pane.agent_session.value) {
        trace.malformed += 1;
        continue;
      }
      const paneObservations = herdrPanePids(
        run,
        herdrBinary,
        pane,
        descendants,
        trace,
        Math.max(1, Math.min(2_000, remaining)),
      )
        .map((pid) => byPid.get(pid))
        .filter(Boolean);
      claims.push(
        ...applyHerdrPaneEvidence({ paneObservations, pane, catalogSessions, now, trace }),
      );
    }
    trace.ok = true;
    return { claims, trace };
  } catch (error) {
    if (error?.code === "ETIMEDOUT" || error?.killed) trace.timedOut += 1;
    else if (error instanceof SyntaxError) trace.malformed += 1;
    else if (error?.message !== "invalid_snapshot") trace.rejected += 1;
    return { claims: [], trace: { ...trace, error: safeError(error) } };
  }
}

function membershipLocationMatches(membership, observation) {
  const target = membership.terminalTarget;
  if (!target || (target.kind !== "pane" && target.kind !== "window")) return false;
  return observation.locations.some((location) => {
    if (location.provider !== target.backend) return false;
    if (target.kind === "pane") return location.paneId === target.id;
    return target.backend === "tmux" && location.windowId === target.id;
  });
}

function currentMembership(membership, observation) {
  const fresh =
    membership.runtimeStartedAt &&
    observation.processStartedAt &&
    validDate(membership.runtimeStartedAt) &&
    validDate(observation.processStartedAt) &&
    Math.abs(Date.parse(membership.runtimeStartedAt) - Date.parse(observation.processStartedAt)) <=
      START_TOLERANCE_MS;
  return Boolean(
    membership.isActive &&
    membership.membershipId &&
    membership.membershipId === membership.runtimeMembershipId &&
    fresh,
  );
}

export function piTeamsClaims(observations, memberships, catalogSessions, now = Date.now()) {
  const claims = [];
  const decoration = new Map();
  for (const observation of observations) {
    const pidCandidates = memberships.filter((membership) => membership.pid === observation.pid);
    const candidates = pidCandidates.filter((membership) =>
      currentMembership(membership, observation),
    );
    if (candidates.length > 1) {
      if (!observation.issues.some((entry) => entry.code === "coordination_ambiguous"))
        observation.issues.push(issue("coordination_ambiguous"));
      continue;
    }
    if (candidates.length === 0) {
      if (
        pidCandidates.length &&
        !observation.issues.some((entry) => entry.code === "coordination_stale")
      )
        observation.issues.push(issue("coordination_stale"));
      continue;
    }
    if (candidates.length === 1) {
      const membership = candidates[0];
      decoration.set(observation.id, {
        kind: "pi-team",
        teamName: membership.teamName,
        agentName: membership.agentName,
        role: membership.role,
        ready: membership.ready,
        source: membership.source,
      });
      const sessions =
        typeof membership.sessionFile === "string"
          ? catalogSessions.filter(
              (session) => resolve(session.source) === resolve(membership.sessionFile),
            )
          : [];
      const locationMatches = membershipLocationMatches(membership, observation);
      if (
        !locationMatches &&
        membership.terminalTarget &&
        observation.locations.some(
          (location) => location.provider === membership.terminalTarget.backend,
        ) &&
        !observation.issues.some((entry) => entry.code === "coordination_target_mismatch")
      )
        observation.issues.push(issue("coordination_target_mismatch"));
      if (locationMatches && sessions.length === 1) {
        claims.push({
          processId: observation.id,
          sessionId: sessions[0].id,
          provider: "pi_teams",
          method: "exact_membership_session",
          observedAt: new Date(now).toISOString(),
        });
      }
    }
  }
  return { claims, decoration };
}

function directResolution(observation, claims, sessions, now) {
  if (!observation.processStartedAt) return { issue: issue("process_start_unknown") };
  const relevant = claims.filter(
    (claim) => claim.processId === observation.id && sessions.has(claim.sessionId),
  );
  const fresh = relevant.filter((claim) => {
    const observedAt = Date.parse(claim.observedAt);
    return (
      Number.isFinite(observedAt) && observedAt <= now && now - observedAt <= DIRECT_MAX_AGE_MS
    );
  });
  const targets = new Set(fresh.map((claim) => claim.sessionId));
  if (targets.size > 1) return { issue: issue("association_conflict") };
  if (targets.size === 1) {
    const sessionId = [...targets][0];
    return {
      link: {
        sessionId,
        grade: "provider_verified",
        method: fresh
          .map((claim) => `${claim.provider}:${claim.method}`)
          .sort()
          .join(","),
        observedAt: fresh
          .map((claim) => claim.observedAt)
          .sort()
          .at(-1),
        provenance: fresh.map((claim) => claim.provider).sort(),
      },
    };
  }
  if (relevant.some((claim) => !Number.isFinite(Date.parse(claim.observedAt))))
    return { issue: issue("provider_claim_malformed") };
  if (relevant.some((claim) => Date.parse(claim.observedAt) > now))
    return { issue: issue("provider_claim_future") };
  if (relevant.length) return { issue: issue("provider_claim_stale") };
  return {};
}

function heuristic(observation, sessions, claimed, observations, now) {
  const candidates = [...sessions.values()].filter(
    (session) => !claimed.has(session.id) && session.cwd === observation.cwd,
  );
  const started = Date.parse(observation.processStartedAt ?? "");
  const recent = candidates.filter(
    (session) =>
      validDate(session.startedAt) &&
      Number.isFinite(started) &&
      Date.parse(session.startedAt) >= started &&
      Date.parse(session.startedAt) - started <= SOLO_STARTUP_GRACE_MS,
  );
  const sameCwdProcesses = observations.filter((candidate) => candidate.cwd === observation.cwd);
  if (sameCwdProcesses.length === 1 && recent.length === 1)
    return {
      sessionId: recent[0].id,
      grade: "heuristic",
      method: "unique_recent_session",
      observedAt: new Date(now).toISOString(),
      provenance: ["ps", "session_catalog"],
    };
  const windowNames = observation.locations
    .filter((location) => location.provider === "tmux" && location.windowName)
    .map((location) => location.windowName);
  const named = candidates.filter((session) => windowNames.includes(session.name));
  if (named.length === 1)
    return {
      sessionId: named[0].id,
      grade: "heuristic",
      method: "unique_tmux_window_name",
      observedAt: new Date(now).toISOString(),
      provenance: ["tmux", "session_catalog"],
    };
  if ((recent.length > 0 && sameCwdProcesses.length > 1) || recent.length > 1 || named.length > 1) {
    if (!observation.issues.some((entry) => entry.code === "association_ambiguous"))
      observation.issues.push(issue("association_ambiguous"));
  }
  return undefined;
}

/** Direct claims outrank recomputed bounded heuristics; direct disagreement blocks fallback. */
export function resolveAssociations({ observations, catalogSessions, claims, now = Date.now() }) {
  const sessions = new Map(catalogSessions.map((session) => [session.id, session]));
  const claimed = new Set();
  for (const observation of observations) {
    const direct = directResolution(observation, claims, sessions, now);
    if (direct.issue && !observation.issues.some((entry) => entry.code === direct.issue.code))
      observation.issues.push(direct.issue);
    if (direct.link) {
      observation.link = direct.link;
      claimed.add(direct.link.sessionId);
    }
  }
  for (const observation of observations.filter(
    (item) => !item.link && !item.issues.some((entry) => entry.code === "association_conflict"),
  )) {
    const link = heuristic(observation, sessions, claimed, observations, now);
    if (link) {
      observation.link = link;
      claimed.add(link.sessionId);
    }
  }
  return observations;
}
