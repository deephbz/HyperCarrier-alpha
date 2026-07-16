import { execFileSync } from "node:child_process";
import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rarebitMetadata } from "@hypercarrier/hc-rarebit/core";
import { readPiTeams } from "./pi-teams.js";

export const SIDECAR_LEASE_MS = 30_000;
export const SNAPSHOT_SCHEMA_VERSION = 2;
const MAX_CLOCK_SKEW_MS = 5_000;
const PI_TEAMS_PROCESS_START_TOLERANCE_MS = 2_500;
const SOLO_SESSION_STARTUP_GRACE_MS = 120_000;
const TMUX_FIELD_SEPARATOR = "::PI_TIMELINE_FIELD::";

function errorSummary(error) {
  return {
    kind: error?.name || "Error",
    code: typeof error?.code === "string" ? error.code : undefined,
  };
}

function safeReadDir(path, options) {
  try {
    return readdirSync(path, options);
  } catch {
    return [];
  }
}

export function discoverTmuxSockets({
  uid = process.getuid?.(),
  roots = [tmpdir(), "/private/tmp", "/tmp"],
} = {}) {
  if (uid === undefined) return [];
  const sockets = new Set();
  for (const root of roots) {
    const dir = join(root, `tmux-${uid}`);
    for (const entry of safeReadDir(dir, { withFileTypes: true })) {
      if (entry.isSocket()) {
        const path = join(dir, entry.name);
        try {
          sockets.add(realpathSync(path));
        } catch {
          sockets.add(path);
        }
      }
    }
  }
  return [...sockets].sort();
}

export function parseTmuxPanes(text, socketPath) {
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const parts = line.split(line.includes(TMUX_FIELD_SEPARATOR) ? TMUX_FIELD_SEPARATOR : "\t");
      const [sessionId, sessionName, windowId, windowIndex] = parts;
      const hasWindowName = parts.length >= 12;
      const [windowName, paneId, paneIndex, panePid, tty, cwd, command, dead] = hasWindowName
        ? parts.slice(4)
        : [undefined, ...parts.slice(4)];
      if (!paneId || !/^%\d+$/.test(paneId) || !/^\d+$/.test(panePid ?? "")) return [];
      return [
        {
          serverSocket: socketPath,
          sessionId,
          sessionName,
          windowId,
          windowIndex: Number(windowIndex),
          windowName,
          paneId,
          paneIndex: Number(paneIndex),
          panePid: Number(panePid),
          tty,
          cwd,
          command,
          dead: dead === "1",
        },
      ];
    });
}

export function queryTmux(run = execFileSync, sockets = discoverTmuxSockets()) {
  const panes = [];
  const diagnostics = [];
  const format = [
    "#{session_id}",
    "#{session_name}",
    "#{window_id}",
    "#{window_index}",
    "#{window_name}",
    "#{pane_id}",
    "#{pane_index}",
    "#{pane_pid}",
    "#{pane_tty}",
    "#{pane_current_path}",
    "#{pane_current_command}",
    "#{pane_dead}",
  ].join(TMUX_FIELD_SEPARATOR);
  for (const socket of sockets) {
    try {
      const output = String(
        run("tmux", ["-S", socket, "list-panes", "-a", "-F", format], {
          encoding: "utf8",
          timeout: 2_000,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
      const parsed = parseTmuxPanes(output, socket);
      panes.push(...parsed);
      diagnostics.push({ socket, ok: true, panes: parsed.length });
    } catch (error) {
      diagnostics.push({ socket, ok: false, error: errorSummary(error) });
    }
  }
  return { panes, diagnostics };
}

function processStartTime(value) {
  const fields = value.split(/\s+/);
  const normalized = /^\w{3}\s+\d+\s+\w{3}\b/.test(value)
    ? `${fields[0]} ${fields[2]} ${fields[1]} ${fields.slice(3).join(" ")}`
    : value;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

export function parseProcessTable(text) {
  const processes = [];
  for (const line of text.split("\n")) {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(?:(\w{3}\s+(?:\w{3}\s+\d+|\d+\s+\w{3})\s+\d\d:\d\d:\d\d\s+\d{4})\s+)?(.+)$/,
    );
    if (!match) continue;
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      tty: match[3],
      startTime: match[4] ? processStartTime(match[4]) : undefined,
      command: match[5],
    });
  }
  return processes;
}

export function queryProcesses(run = execFileSync) {
  const output = String(
    run("ps", ["-axo", "pid=,ppid=,tty=,lstart=,command="], { encoding: "utf8", timeout: 2_000 }),
  );
  return parseProcessTable(output);
}

export function isPiProcess(command) {
  const executable = command.trim().split(/\s+/, 1)[0]?.split("/").at(-1);
  return (
    executable === "pi" ||
    /pi-coding-agent/.test(command) ||
    /@mariozechner\/pi-coding-agent/.test(command)
  );
}

export function mapPiProcessesToPanes(panes, processes) {
  const children = new Map();
  for (const process of processes) {
    const list = children.get(process.ppid) ?? [];
    list.push(process);
    children.set(process.ppid, list);
  }
  const mapped = [];
  for (const pane of panes.filter((item) => !item.dead)) {
    const paneRoot = processes.find((item) => item.pid === pane.panePid);
    const queue = [...(paneRoot ? [paneRoot] : []), ...(children.get(pane.panePid) ?? [])];
    const seen = new Set();
    while (queue.length) {
      const process = queue.shift();
      if (seen.has(process.pid)) continue;
      seen.add(process.pid);
      if (isPiProcess(process.command)) mapped.push({ process, pane });
      queue.push(...(children.get(process.pid) ?? []));
    }
  }
  return mapped;
}

const qualifiedWindow = (pane) => `${pane.serverSocket}:${pane.sessionId}:${pane.windowId}`;

function terminalMatches(membership, pane) {
  if (membership.configuredTerminalId?.startsWith("%"))
    return membership.configuredTerminalId === pane?.paneId;
  if (membership.configuredTerminalId?.startsWith("@"))
    return membership.configuredTerminalId === pane?.windowId;
  return false;
}

function exactPiTeamsMembership(agent, memberships) {
  const candidates = memberships.filter(
    (membership) =>
      membership.pid === agent.pid &&
      membership.sessionFile &&
      membership.isActive &&
      membership.membershipId &&
      membership.membershipId === membership.runtimeMembershipId &&
      membership.runtimeStartedAt &&
      agent.processStartedAt &&
      Math.abs(Date.parse(membership.runtimeStartedAt) - Date.parse(agent.processStartedAt)) <=
        PI_TEAMS_PROCESS_START_TOLERANCE_MS &&
      terminalMatches(membership, agent.pane),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

function bindExactPiTeamsSessions(liveAgents, sessions, memberships, claimedSessions, bindSession) {
  for (const agent of liveAgents.filter((item) => !item.sessionId)) {
    const membership = exactPiTeamsMembership(agent, memberships);
    if (!membership) continue;
    const matchingSessions = sessions.filter(
      (session) =>
        !claimedSessions.has(session.id) &&
        resolve(session.source) === resolve(membership.sessionFile),
    );
    if (matchingSessions.length !== 1) continue;
    bindSession(agent, matchingSessions[0], "exact", {
      kind: "pi_teams_session_file",
      evidenceSource: membership.source,
    });
  }
}

function bindUniqueRecentSoloSessions(liveAgents, sessions, claimedSessions, bindSession) {
  const unboundByCwd = new Map();
  for (const agent of liveAgents.filter(
    (item) => !item.sessionId && !item.coordination && item.processStartedAt,
  )) {
    const candidates = unboundByCwd.get(agent.cwd) ?? [];
    candidates.push(agent);
    unboundByCwd.set(agent.cwd, candidates);
  }
  for (const [cwd, agents] of unboundByCwd) {
    if (agents.length !== 1) continue;
    const agent = agents[0];
    const processStartedAt = Date.parse(agent.processStartedAt);
    if (!Number.isFinite(processStartedAt)) continue;
    const candidates = sessions.filter((session) => {
      const sessionStartedAt = Date.parse(session.startedAt);
      return (
        !claimedSessions.has(session.id) &&
        session.cwd === cwd &&
        Number.isFinite(sessionStartedAt) &&
        sessionStartedAt >= processStartedAt &&
        sessionStartedAt - processStartedAt <= SOLO_SESSION_STARTUP_GRACE_MS
      );
    });
    if (candidates.length !== 1) continue;
    bindSession(agent, candidates[0], "inferred_unique_recent_session", {
      kind: "unique_recent_session",
      value: candidates[0].startedAt,
      processSource: "ps",
    });
  }
}

export function inferLiveMetadata(liveAgents, sessions, memberships, teams, now = Date.now()) {
  const claimedSessions = new Set(
    liveAgents.flatMap((agent) => (agent.sessionId ? [agent.sessionId] : [])),
  );

  const bindSession = (agent, session, confidence, evidence) => {
    agent.sessionId = session.id;
    agent.sessionName = session.name;
    if (confidence === "exact") delete agent.sessionConfidence;
    else agent.sessionConfidence = confidence;
    agent.sessionBinding = {
      confidence,
      sessionSource: session.source,
      ...evidence,
    };
    claimedSessions.add(session.id);
  };

  // A PID-validated PiTeams Membership can name its exact native Session
  // file. Join that locator before heuristics, but expose only binding kind and
  // provenance in the public projection.
  bindExactPiTeamsSessions(liveAgents, sessions, memberships, claimedSessions, bindSession);

  // A stale lead PID is common after a resumed/restarted Pi process. Infer only
  // when multiple PID-validated teammates share one qualified window and there
  // is exactly one unmatched Pi in that same window/cwd for the sole lead role.
  for (const team of teams) {
    const teammates = liveAgents.filter(
      (agent) =>
        agent.coordination?.teamName === team.name && agent.coordination.role === "teammate",
    );
    const byWindow = new Map();
    for (const agent of teammates) {
      const key = qualifiedWindow(agent.pane);
      const list = byWindow.get(key) ?? [];
      list.push(agent);
      byWindow.set(key, list);
    }
    const leadRoles = memberships.filter(
      (item) => item.teamName === team.name && item.role === "lead",
    );
    if (leadRoles.length !== 1) continue;
    const lead = leadRoles[0];
    for (const [windowKey, validatedTeammates] of byWindow) {
      if (validatedTeammates.length < 2) continue;
      const candidates = liveAgents.filter(
        (agent) =>
          !agent.coordination &&
          qualifiedWindow(agent.pane) === windowKey &&
          (!lead.cwd || agent.cwd === lead.cwd),
      );
      if (candidates.length === 1) {
        candidates[0].coordination = {
          kind: "pi-team",
          teamName: team.name,
          agentName: lead.agentName,
          role: "lead",
          ready: lead.ready,
          source: lead.source,
          confidence: "inferred_shared_window",
        };
      }
    }
  }

  // Pi commonly resumes an existing named session in a fresh process. The
  // process start time can no longer identify that session, but users often
  // keep the tmux window title equal to the Pi session name. Require a unique
  // same-cwd name match so a generic/reused window title never guesses.
  for (const agent of liveAgents.filter((item) => !item.sessionId && item.pane?.windowName)) {
    const candidates = sessions.filter(
      (session) =>
        !claimedSessions.has(session.id) &&
        session.cwd === agent.cwd &&
        session.name === agent.pane.windowName,
    );
    if (candidates.length === 1) {
      bindSession(agent, candidates[0], "inferred_tmux_window_name", {
        kind: "tmux_window_name",
        value: agent.pane.windowName,
        tmuxSource: agent.pane.serverSocket,
      });
    }
  }

  // A newly created Pi session starts with its process. This is a stronger
  // correlation than cwd/title matching and works for teammates without the
  // lifecycle extension.
  for (const agent of liveAgents.filter((item) => !item.sessionId && item.processStartedAt)) {
    const started = Date.parse(agent.processStartedAt);
    const candidates = sessions.filter(
      (session) =>
        !claimedSessions.has(session.id) &&
        session.cwd === agent.cwd &&
        Math.abs(Date.parse(session.startedAt) - started) <= 2_000,
    );
    if (candidates.length === 1) {
      bindSession(agent, candidates[0], "inferred_process_start", {
        kind: "process_start",
        value: agent.processStartedAt,
        processSource: "ps",
      });
    }
  }

  // ps timestamps have one-second precision on macOS, so concurrently spawned
  // teammates can each match the same session batch. When the cardinalities are
  // equal inside one team/window/start-second cohort, preserve spawn order using
  // monotonically allocated PIDs and session timestamps.
  const batches = new Map();
  for (const agent of liveAgents.filter(
    (item) => !item.sessionId && item.processStartedAt && item.coordination?.teamName,
  )) {
    const key = [
      agent.coordination.teamName,
      qualifiedWindow(agent.pane),
      agent.cwd,
      agent.processStartedAt,
    ].join("|");
    const list = batches.get(key) ?? [];
    list.push(agent);
    batches.set(key, list);
  }
  for (const agents of batches.values()) {
    if (agents.length < 2) continue;
    const started = Date.parse(agents[0].processStartedAt);
    const candidates = sessions
      .filter(
        (session) =>
          !claimedSessions.has(session.id) &&
          session.cwd === agents[0].cwd &&
          Math.abs(Date.parse(session.startedAt) - started) <= 2_000,
      )
      .sort(
        (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.id.localeCompare(b.id),
      );
    if (candidates.length !== agents.length) continue;
    agents
      .sort((a, b) => a.pid - b.pid)
      .forEach((agent, index) => {
        const session = candidates[index];
        bindSession(agent, session, "inferred_process_start_batch", {
          kind: "process_start_batch",
          value: agent.processStartedAt,
          processSource: "ps",
        });
      });
  }

  // Compatibility join for a solo Pi that started before lifecycle package
  // adoption. It is intentionally weaker than the exact/title/start-time
  // joins above and therefore requires one unbound process and one forward-
  // time Session candidate in the cwd. It binds identity only; callers retain
  // the process-only work-state projection.
  bindUniqueRecentSoloSessions(liveAgents, sessions, claimedSessions, bindSession);

  // A resumed lead predates its current process. After exact/start-time joins,
  // accept only one recently active, named, unclaimed session in the same cwd.
  for (const agent of liveAgents.filter(
    (item) => !item.sessionId && item.coordination?.role === "lead",
  )) {
    const candidates = sessions.filter(
      (session) =>
        !claimedSessions.has(session.id) &&
        session.cwd === agent.cwd &&
        session.name &&
        now - Date.parse(session.endedAt) <= 120_000,
    );
    if (candidates.length === 1) {
      bindSession(agent, candidates[0], "inferred_recent_named_session", {
        kind: "recent_named_session",
        value: candidates[0].endedAt,
      });
    }
  }
  return liveAgents;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Live files are local extension input, not an API schema. Project an explicit
// metadata allowlist so a malformed or future extension field cannot leak.
function projectLiveRecord(record, source) {
  return {
    schemaVersion: Number(record.schemaVersion ?? 1),
    processInstanceId: record.processInstanceId,
    processStartedAt: record.processStartedAt,
    pid: record.pid,
    sessionId: record.sessionId,
    sessionFile: record.sessionFile,
    sessionName: record.sessionName,
    cwd: record.cwd,
    state: record.state,
    activeTool: record.activeTool,
    heartbeatAt: record.heartbeatAt,
    model: typeof record.model === "string" ? record.model : record.model?.id,
    context: record.context
      ? {
          tokens: Number(record.context.tokens ?? 0),
          window: Number(record.context.window ?? 0),
          percent: Number(record.context.percent ?? 0),
        }
      : undefined,
    tmux: record.tmux
      ? { serverSocket: record.tmux.serverSocket, paneId: record.tmux.paneId }
      : undefined,
    source,
    confidence: "exact",
  };
}

function leaseIsFresh(at, leaseMs, now) {
  const observedAt = Date.parse(at ?? "");
  const declared = Number(leaseMs);
  const boundedLease = Number.isFinite(declared)
    ? Math.max(1_000, Math.min(declared, SIDECAR_LEASE_MS))
    : SIDECAR_LEASE_MS;
  return (
    Number.isFinite(observedAt) &&
    observedAt <= now + MAX_CLOCK_SKEW_MS &&
    now - observedAt <= boundedLease
  );
}

export function readLiveSidecars({
  dir = join(homedir(), ".pi", "agent", "timeline", "live"),
  now = Date.now(),
  panes = [],
  processes = [],
  alive = processAlive,
} = {}) {
  const accepted = [];
  const rejected = [];
  const processByPid = new Map(processes.map((item) => [item.pid, item]));
  const paneByQualifiedId = new Map(
    panes.map((item) => [`${item.serverSocket}:${item.paneId}`, item]),
  );
  for (const file of safeReadDir(dir).filter((name) => name.endsWith(".json"))) {
    const path = join(dir, file);
    let record;
    try {
      record = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      rejected.push({ source: path, reason: "malformed_json" });
      continue;
    }
    const reject = (reason) => rejected.push({ source: path, reason, pid: record?.pid });
    if (record.schemaVersion !== 1) {
      reject("unsupported_schema_version");
      continue;
    }
    if (!Number.isInteger(record.pid) || !record.processInstanceId || !record.processStartedAt) {
      reject("invalid_identity");
      continue;
    }
    if (record.state === "stopped") {
      reject("process_stopped");
      continue;
    }
    if (!alive(record.pid) || !processByPid.has(record.pid)) {
      reject("process_not_alive");
      continue;
    }
    const observedProcess = processByPid.get(record.pid);
    if (
      observedProcess.startTime &&
      (!Number.isFinite(Date.parse(record.processStartedAt)) ||
        Math.abs(Date.parse(observedProcess.startTime) - Date.parse(record.processStartedAt)) >
          2_000)
    ) {
      reject("process_instance_mismatch");
      continue;
    }
    if (!leaseIsFresh(record.heartbeatAt ?? record.lastEventAt, record.leaseMs, now)) {
      reject("lease_expired");
      continue;
    }
    if (record.tmux?.serverSocket && record.tmux?.paneId) {
      const key = `${record.tmux.serverSocket}:${record.tmux.paneId}`;
      const pane = paneByQualifiedId.get(key);
      if (!pane) {
        reject("pane_missing");
        continue;
      }
      const ancestry = mapPiProcessesToPanes([pane], processes).some(
        ({ process }) => process.pid === record.pid,
      );
      if (!ancestry) {
        reject("pane_ancestry_mismatch");
        continue;
      }
    }
    accepted.push(projectLiveRecord(record, path));
  }
  return { accepted, rejected };
}

function lifecycleRecord(started, heartbeat, attached, named, state) {
  const attachedTmux = attached?.tmux;
  const startedTmux = started.tmux;
  return {
    processInstanceId: started.processBootId,
    processStartedAt: started.processStartedAt,
    pid: started.pid,
    sessionId: heartbeat.sessionId ?? attached?.sessionId,
    sessionFile: attached?.sessionFile,
    sessionName: named ? named.name : attached?.name,
    cwd: attached?.cwd ?? started.cwd,
    model: heartbeat.model ?? attached?.model,
    context: heartbeat.context,
    state: state?.state ?? heartbeat.state ?? "idle",
    activeTool: state?.tool ?? heartbeat.tool,
    heartbeatAt: heartbeat.at,
    tmux: {
      serverSocket:
        attachedTmux?.serverSocket ??
        attachedTmux?.socket ??
        startedTmux?.serverSocket ??
        startedTmux?.socket,
      paneId: attachedTmux?.paneId ?? startedTmux?.paneId,
    },
  };
}

function lifecycleCandidate(path, now) {
  let events;
  try {
    events = readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return { rejection: { source: path, reason: "malformed_lifecycle_jsonl" } };
  }
  if (events.some((event) => event.schemaVersion !== 1)) {
    return { rejection: { source: path, reason: "unsupported_schema_version" } };
  }
  const started = events.find((event) => event.type === "process_started");
  const heartbeat = events.findLast((event) => event.type === "heartbeat");
  const attached = events.findLast((event) => event.type === "session_attached");
  const named = events.findLast(
    (event) =>
      event.type === "session_named" &&
      event.attachmentId === attached?.attachmentId &&
      event.sessionId === attached?.sessionId,
  );
  const state = events.findLast((event) => event.type === "state_observed");
  const stopped = events.findLast((event) => event.type === "process_stopping");
  if (!started?.pid || !started.processStartedAt || !started.processBootId) {
    return { rejection: { source: path, reason: "missing_process_started" } };
  }
  if (stopped && Date.parse(stopped.at) >= Date.parse(heartbeat?.at ?? "")) {
    return { rejection: { source: path, reason: "process_stopped" } };
  }
  if (!heartbeat || !leaseIsFresh(heartbeat.at, heartbeat.leaseMs, now)) {
    return { rejection: { source: path, reason: "lease_expired", pid: started.pid } };
  }
  return {
    candidate: { path, record: lifecycleRecord(started, heartbeat, attached, named, state) },
  };
}

function validateLifecycleCandidate(candidate, { alive, processByPid, paneById, processes }) {
  const { record, path } = candidate;
  const reject = (reason) => ({ rejection: { source: path, reason, pid: record.pid } });
  if (!alive(record.pid) || !processByPid.has(record.pid)) return reject("process_not_alive");
  const observedProcess = processByPid.get(record.pid);
  const recordedStart = Date.parse(record.processStartedAt);
  if (
    observedProcess.startTime &&
    (!Number.isFinite(recordedStart) ||
      Math.abs(Date.parse(observedProcess.startTime) - recordedStart) > 2_000)
  ) {
    return reject("process_instance_mismatch");
  }
  const pane = paneById.get(`${record.tmux.serverSocket}:${record.tmux.paneId}`);
  if (!pane) return reject("pane_missing");
  const belongsToPane = mapPiProcessesToPanes([pane], processes).some(
    ({ process }) => process.pid === record.pid,
  );
  return belongsToPane
    ? { accepted: projectLiveRecord(record, path) }
    : reject("pane_ancestry_mismatch");
}

export function readLifecycleLeases({
  dir = join(homedir(), ".pi", "agent", "timeline", "events"),
  now = Date.now(),
  panes = [],
  processes = [],
  alive = processAlive,
} = {}) {
  const parsed = safeReadDir(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((file) => lifecycleCandidate(join(dir, file), now));
  const processByPid = new Map(processes.map((item) => [item.pid, item]));
  const paneById = new Map(panes.map((item) => [`${item.serverSocket}:${item.paneId}`, item]));
  const checked = parsed.map((result) =>
    result.candidate
      ? validateLifecycleCandidate(result.candidate, { alive, processByPid, paneById, processes })
      : result,
  );
  return {
    accepted: checked.flatMap((result) => (result.accepted ? [result.accepted] : [])),
    rejected: checked.flatMap((result) => (result.rejection ? [result.rejection] : [])),
  };
}

function sumUsage(usage = {}) {
  const input = Number(usage.input ?? 0),
    output = Number(usage.output ?? 0);
  const cacheRead = Number(usage.cacheRead ?? 0),
    cacheWrite = Number(usage.cacheWrite ?? 0);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: Number(usage.totalTokens ?? input + output + cacheRead + cacheWrite),
    cost: Number(usage.cost?.total ?? 0),
  };
}

function createSessionParseState(source) {
  return {
    source,
    session: undefined,
    turns: [],
    requests: [],
    rarebits: [],
    rejected: [],
    currentTurnIndex: undefined,
    lastMessageAt: undefined,
    lastMessageAtMs: undefined,
    lineNumber: 0,
    entryOrder: -1,
  };
}

function cloneSessionParseState(state) {
  return {
    ...state,
    session: state.session ? { ...state.session } : undefined,
    turns: state.turns.map((turn) => ({ ...turn })),
    requests: state.requests.map((request) => ({ ...request })),
    rarebits: state.rarebits.map((marker) => ({ ...marker })),
    rejected: state.rejected.map((rejection) => ({ ...rejection })),
  };
}

function recordLastMessageAt(state, timestamp) {
  if (typeof timestamp !== "string") return;
  const millis = Date.parse(timestamp);
  if (!Number.isFinite(millis) || millis <= (state.lastMessageAtMs ?? -Infinity)) return;
  state.lastMessageAt = timestamp;
  state.lastMessageAtMs = millis;
}

function parseSessionLine(state, line) {
  if (!line.trim()) return false;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    state.rejected.push({
      source: state.source,
      line: state.lineNumber,
      reason: "malformed_jsonl",
    });
    return true;
  }
  if (!entry || typeof entry !== "object") return true;
  state.entryOrder += 1;
  const rarebit = rarebitMetadata(entry, state.entryOrder);
  if (rarebit) state.rarebits.push(rarebit);
  if (entry.type === "session") {
    state.session = {
      id: entry.id,
      startedAt: entry.timestamp,
      cwd: entry.cwd,
      source: state.source,
    };
  } else if (entry.type === "session_info" || entry.type === "session_name") {
    if (state.session && typeof entry.name === "string") state.session.name = entry.name;
  } else if (entry.type === "message" && entry.message?.role === "user") {
    recordLastMessageAt(state, entry.timestamp);
    state.currentTurnIndex = state.turns.length;
    state.turns.push({
      id: entry.id,
      sessionId: state.session?.id,
      startedAt: entry.timestamp,
      confidence: "inferred",
      requestCount: 0,
      cost: 0,
      totalTokens: 0,
    });
  } else if (entry.type === "message" && entry.message?.role === "assistant") {
    recordLastMessageAt(state, entry.timestamp);
    const currentTurn = state.turns[state.currentTurnIndex];
    const usage = sumUsage(entry.message.usage);
    state.requests.push({
      id: entry.id,
      sessionId: state.session?.id,
      turnId: currentTurn?.id,
      at: entry.timestamp,
      model: entry.message.model,
      provider: entry.message.provider,
      stopReason: entry.message.stopReason,
      ...usage,
    });
    if (currentTurn) {
      currentTurn.endedAt = entry.timestamp;
      currentTurn.requestCount += 1;
      currentTurn.cost += usage.cost;
      currentTurn.totalTokens += usage.totalTokens;
    }
  }
  return true;
}

function materializeSessionParseState(state) {
  const { session, turns, requests, rarebits, rejected } = state;
  if (!session)
    return {
      session,
      turns,
      requests,
      rarebits: [],
      rejected: [...rejected, { source: state.source, reason: "missing_session_header" }],
    };
  session.turnCount = turns.length;
  session.requestCount = requests.length;
  session.cost = requests.reduce((sum, item) => sum + item.cost, 0);
  session.totalTokens = requests.reduce((sum, item) => sum + item.totalTokens, 0);
  session.endedAt = requests.at(-1)?.at ?? session.startedAt;
  session.lastMessageAt = state.lastMessageAt;
  session.links = sessionLinks(session.id);
  return {
    session,
    turns,
    requests,
    rarebits: rarebits.map((marker) => ({ sessionId: session.id, ...marker })),
    rejected,
  };
}

function parseCompleteJsonl(state, text) {
  let linesParsed = 0;
  for (const line of text.split("\n")) {
    state.lineNumber += 1;
    if (parseSessionLine(state, line)) linesParsed += 1;
  }
  return linesParsed;
}

function parseCommittedJsonl(bytes, source, state = createSessionParseState(source)) {
  const newline = bytes.lastIndexOf(0x0a);
  if (newline < 0) return { state, tail: bytes, linesParsed: 0 };
  const committed = bytes.subarray(0, newline).toString("utf8");
  return {
    state,
    tail: bytes.subarray(newline + 1),
    linesParsed: parseCompleteJsonl(state, committed),
  };
}

function visibleSessionParseState(state, tail) {
  if (!tail.length) return { state, linesParsed: 0 };
  const line = tail.toString("utf8");
  try {
    JSON.parse(line);
  } catch {
    return { state, linesParsed: 0 };
  }
  const visible = cloneSessionParseState(state);
  visible.lineNumber += 1;
  parseSessionLine(visible, line);
  return { state: visible, linesParsed: 1 };
}

function readAppendedBytes(path, start, end) {
  const length = end - start;
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(length);
  const descriptor = openSync(path, "r");
  try {
    const bytesRead = readSync(descriptor, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(descriptor);
  }
}

const SESSION_CACHE_VERSION = 3;
const SESSION_CATALOG_VERSION = 1;

function cacheStamp(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${SESSION_CACHE_VERSION}`;
}

function catalogStamp(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${SESSION_CATALOG_VERSION}`;
}

function sessionLinks(id) {
  const liveBase = process.env.PI_LIVE_DETAIL_BASE_URL ?? "http://127.0.0.1:4319";
  const tpsBase = process.env.PI_TPS_WEB_BASE_URL ?? "http://127.0.0.1:4320";
  return {
    live: `${liveBase.replace(/\/$/, "")}/session/${encodeURIComponent(id)}`,
    tps: `${tpsBase.replace(/\/$/, "")}/?auto=1&session=${encodeURIComponent(id)}`,
  };
}

function parseCatalogHeader(bytes, source) {
  for (const line of bytes.toString("utf8").split("\n")) {
    try {
      const entry = JSON.parse(line);
      if (
        entry?.type === "session" &&
        typeof entry.id === "string" &&
        typeof entry.timestamp === "string"
      ) {
        return {
          id: entry.id,
          startedAt: entry.timestamp,
          endedAt: entry.timestamp,
          cwd: typeof entry.cwd === "string" ? entry.cwd : "",
          source,
          turnCount: 0,
          requestCount: 0,
          cost: 0,
          totalTokens: 0,
          links: sessionLinks(entry.id),
        };
      }
    } catch {}
  }
  return null;
}

const CATALOG_TAIL_CHUNK_BYTES = 64 * 1024;
const CATALOG_TAIL_MAX_BYTES = 1024 * 1024;

function messageTimestampFromLine(line) {
  if (!line.length) return undefined;
  try {
    const entry = JSON.parse(line.toString("utf8"));
    if (
      entry?.type === "message" &&
      (entry.message?.role === "user" || entry.message?.role === "assistant") &&
      typeof entry.timestamp === "string" &&
      Number.isFinite(Date.parse(entry.timestamp))
    )
      return entry.timestamp;
  } catch {}
  return undefined;
}

function latestMessageInCompleteLines(bytes) {
  let end = bytes.length;
  while (end > 0) {
    const newline = bytes.lastIndexOf(0x0a, end - 1);
    const start = newline + 1;
    const timestamp = messageTimestampFromLine(bytes.subarray(start, end));
    if (timestamp) return timestamp;
    if (newline < 0) break;
    end = newline;
  }
  return undefined;
}

function latestMessageFromTail(path, size, maxBytes = CATALOG_TAIL_MAX_BYTES) {
  const descriptor = openSync(path, "r");
  try {
    let position = size;
    let tail = Buffer.alloc(0);
    let bytesRead = 0;
    while (position > 0 && bytesRead < maxBytes) {
      const length = Math.min(CATALOG_TAIL_CHUNK_BYTES, position, maxBytes - bytesRead);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const read = readSync(descriptor, chunk, 0, length, position);
      bytesRead += read;
      tail = Buffer.concat([chunk.subarray(0, read), tail]);
      const firstNewline = tail.indexOf(0x0a);
      if (firstNewline >= 0) {
        const timestamp = latestMessageInCompleteLines(tail.subarray(firstNewline + 1));
        if (timestamp) return { timestamp, bytesRead, state: "observed" };
        // Keep only the possibly split line. Complete lines have already been
        // inspected as raw bytes, so a UTF-8 code point split at a chunk edge
        // is never decoded and re-encoded into replacement characters.
        tail = tail.subarray(0, firstNewline);
      }
    }
    if (position > 0)
      return {
        timestamp: undefined,
        bytesRead,
        state: "unknown",
        reason: "tail_scan_cap_exhausted",
      };
    const timestamp = messageTimestampFromLine(tail);
    return timestamp
      ? { timestamp, bytesRead, state: "observed" }
      : { timestamp: undefined, bytesRead, state: "absent" };
  } finally {
    closeSync(descriptor);
  }
}

/**
 * A bounded header/tail scan is the cold-start catalog. Full JSONL parsing is
 * deferred until a Session falls inside the requested response window.
 */
export function readSessionCatalogMetadata(path) {
  const stat = statSync(path);
  const header = readAppendedBytes(path, 0, Math.min(stat.size, 64 * 1024));
  const session = parseCatalogHeader(header, path);
  if (!session)
    return {
      session: null,
      rejected: { source: path, reason: "missing_session_header" },
      catalogTrace: { bytesRead: header.length },
    };
  const tail = latestMessageFromTail(path, stat.size);
  return {
    session: {
      ...session,
      lastMessageAt: tail.timestamp,
      lastMessageAtEvidence: {
        state: tail.state,
        source: "bounded_tail_scan",
        reason: tail.reason,
      },
    },
    rejected: null,
    catalogTrace: {
      bytesRead: header.length + tail.bytesRead,
      tailScan: {
        state: tail.state,
        reason: tail.reason,
        maxBytes: CATALOG_TAIL_MAX_BYTES,
      },
    },
  };
}

export class SessionCatalog {
  constructor() {
    this.files = new Map();
  }
  read(path) {
    const stat = statSync(path);
    const cached = this.files.get(path);
    if (cached?.stamp === catalogStamp(stat))
      return {
        ...cached.value,
        catalogCacheHit: true,
        catalogTrace: { ...cached.value.catalogTrace, bytesRead: 0 },
      };
    const value = readSessionCatalogMetadata(path);
    this.files.set(path, { stamp: catalogStamp(stat), value });
    return { ...value, catalogCacheHit: false };
  }
}

export function parseSessionJsonl(text, source = "unknown") {
  const state = createSessionParseState(source);
  parseCompleteJsonl(state, text);
  return materializeSessionParseState(state);
}

export class SessionCache {
  constructor() {
    this.files = new Map();
  }
  rebuild(path, stat) {
    const bytes = readFileSync(path);
    const parsed = parseCommittedJsonl(bytes, path);
    const visible = visibleSessionParseState(parsed.state, parsed.tail);
    const entry = {
      stamp: cacheStamp(stat),
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      tail: parsed.tail,
      state: parsed.state,
      visibleState: visible.state,
    };
    this.files.set(path, entry);
    return {
      ...materializeSessionParseState(entry.visibleState),
      cacheHit: false,
      cacheTrace: {
        bytesRead: bytes.length,
        linesParsed: parsed.linesParsed + visible.linesParsed,
        appendCount: 0,
        rebuildCount: 1,
      },
    };
  }
  read(path) {
    const stat = statSync(path);
    const cached = this.files.get(path);
    if (cached?.stamp === cacheStamp(stat)) {
      return {
        ...materializeSessionParseState(cached.visibleState),
        cacheHit: true,
        cacheTrace: { bytesRead: 0, linesParsed: 0, appendCount: 0, rebuildCount: 0 },
      };
    }
    const canAppend =
      cached && stat.dev === cached.dev && stat.ino === cached.ino && stat.size > cached.size;
    if (!canAppend) return this.rebuild(path, stat);

    const appended = readAppendedBytes(path, cached.size, stat.size);
    const candidateState = cloneSessionParseState(cached.state);
    const parsed = parseCommittedJsonl(
      Buffer.concat([cached.tail, appended]),
      path,
      candidateState,
    );
    const malformedAppend = candidateState.rejected.length > cached.state.rejected.length;
    if (malformedAppend) return this.rebuild(path, stat);

    const visible = visibleSessionParseState(candidateState, parsed.tail);
    const entry = {
      stamp: cacheStamp(stat),
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      tail: parsed.tail,
      state: candidateState,
      visibleState: visible.state,
    };
    this.files.set(path, entry);
    return {
      ...materializeSessionParseState(entry.visibleState),
      cacheHit: false,
      cacheTrace: {
        bytesRead: appended.length,
        linesParsed: parsed.linesParsed + visible.linesParsed,
        appendCount: 1,
        rebuildCount: 0,
      },
    };
  }
}

export function findSessionFiles(root = join(homedir(), ".pi", "agent", "sessions")) {
  const files = [];
  for (const entry of safeReadDir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...findSessionFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files.sort();
}

export const SNAPSHOT_WINDOWS = new Map([
  ["15m", 15 * 60_000],
  ["1h", 60 * 60_000],
  ["6h", 6 * 60 * 60_000],
  ["24h", 24 * 60 * 60_000],
]);
export const HISTORY_PAGE_SIZE = 100;

function decodeHistoryCursor(cursor) {
  if (cursor === undefined) return null;
  if (typeof cursor !== "string" || !cursor) throw new Error("invalid_snapshot_cursor");
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof parsed?.at !== "number" ||
      !Number.isFinite(parsed.at) ||
      typeof parsed?.id !== "string"
    )
      throw new Error("invalid_snapshot_cursor");
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_snapshot_cursor") throw error;
    throw new Error("invalid_snapshot_cursor", { cause: error });
  }
}

function encodeHistoryCursor(item) {
  return Buffer.from(JSON.stringify({ at: item.at, id: item.session.id })).toString("base64url");
}

function sessionCatalogEntry(item) {
  const session = item.session ?? item;
  const at = Date.parse(session?.lastMessageAt ?? "");
  return Number.isFinite(at) ? { item, session, at } : null;
}

/**
 * Selects a metadata response by canonical message evidence. This deliberately
 * does not use file mtime, process heartbeat, or cwd as a session-activity
 * substitute. The opaque history cursor makes the all-history view stable and
 * bounded even when a host has thousands of session logs.
 */
export function selectSessionWindow(
  parsedSessions,
  { window = "full", cursor, now = Date.now(), limit = HISTORY_PAGE_SIZE, from, to } = {},
) {
  const allSessions = parsedSessions
    .map((item) => item?.session ?? item)
    .filter((session) => typeof session?.id === "string");
  const catalog = parsedSessions
    .map(sessionCatalogEntry)
    .filter(Boolean)
    .sort((a, b) => b.at - a.at || a.session.id.localeCompare(b.session.id));
  if (window === "full") {
    return {
      // Full is used by internal callers which need all source records,
      // including a syntactically valid Session without message evidence.
      selected: new Set(allSessions.map((session) => session.id)),
      messageFrom: null,
      messageTo: null,
      page: { window: "all", nextCursor: null, hasOlder: false, source: "last_message_at" },
    };
  }
  if (window !== "all") {
    const duration = SNAPSHOT_WINDOWS.get(window);
    if (!duration) throw new Error(`invalid_snapshot_window:${window}`);
    const upperBound = Number.isFinite(to) ? to : null;
    const lowerBound = Number.isFinite(from) ? from : (upperBound ?? now) - duration;
    return {
      selected: new Set(
        catalog
          .filter((item) => item.at >= lowerBound && (upperBound === null || item.at <= upperBound))
          .map((item) => item.session.id),
      ),
      messageFrom: lowerBound,
      messageTo: upperBound,
      page: { window, nextCursor: null, hasOlder: false, source: "last_message_at" },
    };
  }
  const lowerBound = Number.isFinite(from) ? from : null;
  const upperBound = Number.isFinite(to) ? to : null;
  const boundedCatalog = catalog.filter(
    (item) =>
      (lowerBound === null || item.at >= lowerBound) &&
      (upperBound === null || item.at <= upperBound),
  );
  const decoded = decodeHistoryCursor(cursor);
  const eligible = decoded
    ? boundedCatalog.filter(
        (item) => item.at < decoded.at || (item.at === decoded.at && item.session.id > decoded.id),
      )
    : boundedCatalog;
  const pageItems = eligible.slice(
    0,
    Math.max(1, Math.min(Number(limit) || HISTORY_PAGE_SIZE, HISTORY_PAGE_SIZE)),
  );
  const hasOlder = eligible.length > pageItems.length;
  return {
    selected: new Set(pageItems.map((item) => item.session.id)),
    messageFrom: pageItems.at(-1)?.at ?? null,
    messageTo: pageItems[0]?.at ?? null,
    page: {
      window: "all",
      nextCursor: hasOlder && pageItems.length ? encodeHistoryCursor(pageItems.at(-1)) : null,
      hasOlder,
      source: "last_message_at",
    },
  };
}

export function collectSnapshot(options = {}) {
  const started = performance.now();
  const tmux = queryTmux(options.run, options.sockets);
  let processes = [];
  const rejected = [];
  try {
    processes = options.processes ?? queryProcesses(options.run);
  } catch (error) {
    rejected.push({ source: "ps", reason: "command_failed", error: errorSummary(error) });
  }
  const mapped = mapPiProcessesToPanes(tmux.panes, processes);
  const mappedPids = new Set(mapped.map(({ process }) => process.pid));
  const piTeams = readPiTeams({ root: options.teamsRoot, livePids: mappedPids });
  const sidecars = readLiveSidecars({ ...options, panes: tmux.panes, processes });
  const lifecycle = readLifecycleLeases({
    ...options,
    dir: options.eventsDir,
    panes: tmux.panes,
    processes,
  });
  const cache = options.cache ?? new SessionCache();
  const catalogCache = options.catalogCache ?? new SessionCatalog();
  const sessionFiles = options.sessionFiles ?? findSessionFiles(options.sessionsRoot);
  const catalogSessions = [];
  let cacheHits = 0;
  let catalogCacheHits = 0;
  let catalogBytesRead = 0;
  let catalogUnknownLastMessageAt = 0;
  const sessionCacheTrace = { bytesRead: 0, linesParsed: 0, appendCount: 0, rebuildCount: 0 };
  for (const path of sessionFiles) {
    try {
      const catalog = catalogCache.read(path);
      if (catalog.catalogCacheHit) catalogCacheHits += 1;
      catalogBytesRead += catalog.catalogTrace?.bytesRead ?? 0;
      if (catalog.session?.lastMessageAtEvidence?.state === "unknown")
        catalogUnknownLastMessageAt += 1;
      if (catalog.session) catalogSessions.push({ path, session: catalog.session });
      if (catalog.rejected) rejected.push(catalog.rejected);
    } catch (error) {
      rejected.push({ source: path, reason: "read_failed", error: errorSummary(error) });
    }
  }
  const selection = selectSessionWindow(
    catalogSessions.map((item) => item.session),
    options,
  );
  const selectedParses = [];
  for (const item of catalogSessions) {
    if (!selection.selected.has(item.session.id)) continue;
    try {
      const parsed = cache.read(item.path);
      if (parsed.cacheHit) cacheHits++;
      for (const key of Object.keys(sessionCacheTrace))
        sessionCacheTrace[key] += parsed.cacheTrace?.[key] ?? 0;
      if (parsed.session) selectedParses.push(parsed);
      rejected.push(...parsed.rejected);
    } catch (error) {
      rejected.push({ source: item.path, reason: "read_failed", error: errorSummary(error) });
    }
  }
  const sessions = selectedParses.map((parsed) => parsed.session);
  const turns = selectedParses.flatMap((parsed) => parsed.turns);
  const requests = selectedParses.flatMap((parsed) => parsed.requests);
  const rarebits = selectedParses.flatMap((parsed) =>
    parsed.rarebits.filter((marker) => {
      const at = Date.parse(marker.timestamp ?? "");
      return (
        Number.isFinite(at) &&
        (selection.messageFrom === null || at >= selection.messageFrom) &&
        (selection.messageTo === null || at <= selection.messageTo)
      );
    }),
  );
  const allCatalogSessions = catalogSessions.map((item) => item.session);

  // The atomic hot projection is the authoritative current observation when
  // both representations exist; append-only lifecycle events remain the
  // historical source and fallback.
  const exactRecords = [...lifecycle.accepted, ...sidecars.accepted];
  const exactByPid = new Map(exactRecords.map((item) => [item.pid, item]));
  const sessionById = new Map(allCatalogSessions.map((item) => [item.id, item]));
  const teamMembershipsByPid = new Map();
  for (const membership of piTeams.memberships.filter((item) => item.pid)) {
    const candidates = teamMembershipsByPid.get(membership.pid) ?? [];
    candidates.push(membership);
    teamMembershipsByPid.set(membership.pid, candidates);
  }
  const liveAgents = mapped.map(({ process, pane }) => {
    const exact = exactByPid.get(process.pid);
    const candidates = teamMembershipsByPid.get(process.pid) ?? [];
    const membership = candidates.length === 1 ? candidates[0] : undefined;
    const coordination = membership
      ? {
          kind: "pi-team",
          teamName: membership.teamName,
          agentName: membership.agentName,
          role: membership.role,
          ready: membership.ready,
          source: membership.source,
        }
      : undefined;
    const processBinding = { confidence: "exact", source: "ps", pid: process.pid };
    const processObservation = { pid: process.pid, state: "running" };
    return exact
      ? {
          ...exact,
          pane,
          coordination,
          process: processObservation,
          processState: "running",
          workState: {
            availability: "observed",
            state: exact.state,
            evidenceSource: exact.source,
            observedAt: exact.heartbeatAt,
          },
          processBinding,
          sessionBinding: exact.sessionId
            ? {
                confidence: "exact",
                kind: "lifecycle_extension",
                evidenceSource: exact.source,
                sessionSource: sessionById.get(exact.sessionId)?.source,
              }
            : undefined,
        }
      : {
          processInstanceId: `pid:${process.pid}`,
          processStartedAt: process.startTime,
          pid: process.pid,
          cwd: pane.cwd,
          pane,
          coordination,
          process: processObservation,
          processState: "running",
          workState: {
            availability: "unobserved",
            reason: "lifecycle_evidence_unavailable",
          },
          processBinding,
          confidence: "process_only",
        };
  });
  inferLiveMetadata(liveAgents, allCatalogSessions, piTeams.memberships, piTeams.teams);
  const visibleLiveAgents = liveAgents.filter(
    // A live sidecar can truthfully bind a just-created Session before that
    // JSONL is discoverable. Keep that runtime-only evidence instead of
    // treating the catalog's temporary absence as a stopped process.
    (agent) =>
      !agent.sessionId ||
      !sessionById.has(agent.sessionId) ||
      selection.selected.has(agent.sessionId),
  );
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sessions,
    turns,
    requests,
    rarebits,
    liveAgents: visibleLiveAgents,
    teams: piTeams.teams,
    teamMemberships: piTeams.memberships.map((membership) => ({
      teamName: membership.teamName,
      agentName: membership.agentName,
      role: membership.role,
      pid: membership.pid,
      source: membership.source,
    })),
    trace: {
      durationMs: performance.now() - started,
      tmux: tmux.diagnostics,
      processCount: processes.length,
      sidecars: { accepted: sidecars.accepted.length, rejected: sidecars.rejected.length },
      lifecycle: { accepted: lifecycle.accepted.length, rejected: lifecycle.rejected.length },
      piTeams: {
        teams: piTeams.teams.length,
        memberships: piTeams.memberships.length,
        liveMatches: liveAgents.filter((agent) => agent.coordination).length,
        inferredLeads: liveAgents.filter(
          (agent) => agent.coordination?.confidence === "inferred_shared_window",
        ).length,
        ambiguousPids: [...teamMembershipsByPid.values()].filter((items) => items.length > 1)
          .length,
      },
      sessionBindings: {
        exact: liveAgents.filter((agent) => agent.sessionId && !agent.sessionConfidence).length,
        inferredTmuxWindowName: liveAgents.filter(
          (agent) => agent.sessionConfidence === "inferred_tmux_window_name",
        ).length,
        inferredProcessStart: liveAgents.filter(
          (agent) => agent.sessionConfidence === "inferred_process_start",
        ).length,
        inferredProcessStartBatch: liveAgents.filter(
          (agent) => agent.sessionConfidence === "inferred_process_start_batch",
        ).length,
        inferredUniqueRecent: liveAgents.filter(
          (agent) => agent.sessionConfidence === "inferred_unique_recent_session",
        ).length,
        inferredRecentNamed: liveAgents.filter(
          (agent) => agent.sessionConfidence === "inferred_recent_named_session",
        ).length,
      },
      sessionFiles: sessionFiles.length,
      catalogSessions: allCatalogSessions.length,
      responseSessions: sessions.length,
      catalog: {
        cacheHits: catalogCacheHits,
        bytesRead: catalogBytesRead,
        unknownLastMessageAt: catalogUnknownLastMessageAt,
      },
      cacheHits,
      sessionCache: sessionCacheTrace,
      rejected: [...rejected, ...sidecars.rejected, ...lifecycle.rejected, ...piTeams.rejected],
    },
    page: selection.page,
  };
}
