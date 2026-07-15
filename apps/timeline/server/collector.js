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
import { join } from "node:path";
import { keyMessageMetadata } from "@hypercarrier/hc-key-msg-summary/selector";
import { readPiTeams } from "./pi-teams.js";

export const SIDECAR_LEASE_MS = 30_000;
const MAX_CLOCK_SKEW_MS = 5_000;
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

export function parseProcessTable(text) {
  const processes = [];
  for (const line of text.split("\n")) {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(?:(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+)?(.+)$/,
    );
    if (!match) continue;
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      tty: match[3],
      startTime: match[4] ? new Date(match[4]).toISOString() : undefined,
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

export function inferLiveMetadata(liveAgents, sessions, memberships, teams, now = Date.now()) {
  const claimedSessions = new Set(
    liveAgents.flatMap((agent) => (agent.sessionId ? [agent.sessionId] : [])),
  );

  const bindSession = (agent, session, confidence, evidence) => {
    agent.sessionId = session.id;
    agent.sessionName = session.name;
    agent.sessionConfidence = confidence;
    agent.sessionBinding = {
      confidence,
      sessionSource: session.source,
      ...evidence,
    };
    claimedSessions.add(session.id);
  };

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

function lifecycleRecord(started, heartbeat, attached, state) {
  const attachedTmux = attached?.tmux;
  const startedTmux = started.tmux;
  return {
    processInstanceId: started.processBootId,
    processStartedAt: started.processStartedAt,
    pid: started.pid,
    sessionId: heartbeat.sessionId ?? attached?.sessionId,
    sessionFile: attached?.sessionFile,
    sessionName: attached?.name,
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
  const started = events.find((event) => event.type === "process_started");
  const heartbeat = events.findLast((event) => event.type === "heartbeat");
  const attached = events.findLast((event) => event.type === "session_attached");
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
  return { candidate: { path, record: lifecycleRecord(started, heartbeat, attached, state) } };
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
    keyMessages: [],
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
    keyMessages: state.keyMessages.map((marker) => ({ ...marker })),
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
  const keyMessage = keyMessageMetadata(entry, state.entryOrder);
  if (keyMessage) state.keyMessages.push(keyMessage);
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
  const { session, turns, requests, keyMessages, rejected } = state;
  if (!session)
    return {
      session,
      turns,
      requests,
      keyMessages: [],
      rejected: [...rejected, { source: state.source, reason: "missing_session_header" }],
    };
  session.turnCount = turns.length;
  session.requestCount = requests.length;
  session.cost = requests.reduce((sum, item) => sum + item.cost, 0);
  session.totalTokens = requests.reduce((sum, item) => sum + item.totalTokens, 0);
  session.endedAt = requests.at(-1)?.at ?? session.startedAt;
  session.lastMessageAt = state.lastMessageAt;
  const liveBase = process.env.PI_LIVE_DETAIL_BASE_URL ?? "http://127.0.0.1:4319";
  const tpsBase = process.env.PI_TPS_WEB_BASE_URL ?? "http://127.0.0.1:4320";
  session.links = {
    live: `${liveBase.replace(/\/$/, "")}/session/${encodeURIComponent(session.id)}`,
    tps: `${tpsBase.replace(/\/$/, "")}/?auto=1&session=${encodeURIComponent(session.id)}`,
  };
  return {
    session,
    turns,
    requests,
    keyMessages: keyMessages.map((marker) => ({ sessionId: session.id, ...marker })),
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

function cacheStamp(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${SESSION_CACHE_VERSION}`;
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
  const sessionFiles = options.sessionFiles ?? findSessionFiles(options.sessionsRoot);
  const sessions = [],
    turns = [],
    requests = [],
    keyMessages = [];
  let cacheHits = 0;
  const sessionCacheTrace = { bytesRead: 0, linesParsed: 0, appendCount: 0, rebuildCount: 0 };
  for (const path of sessionFiles) {
    try {
      const parsed = cache.read(path);
      if (parsed.cacheHit) cacheHits++;
      for (const key of Object.keys(sessionCacheTrace))
        sessionCacheTrace[key] += parsed.cacheTrace?.[key] ?? 0;
      if (parsed.session) sessions.push(parsed.session);
      turns.push(...parsed.turns);
      requests.push(...parsed.requests);
      keyMessages.push(...parsed.keyMessages);
      rejected.push(...parsed.rejected);
    } catch (error) {
      rejected.push({ source: path, reason: "read_failed", error: errorSummary(error) });
    }
  }
  // The atomic hot projection is the authoritative current observation when
  // both representations exist; append-only lifecycle events remain the
  // historical source and fallback.
  const exactRecords = [...lifecycle.accepted, ...sidecars.accepted];
  const exactByPid = new Map(exactRecords.map((item) => [item.pid, item]));
  const sessionById = new Map(sessions.map((item) => [item.id, item]));
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
    return exact
      ? {
          ...exact,
          pane,
          coordination,
          process: { pid: process.pid },
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
          state: "unknown",
          pane,
          coordination,
          process: { pid: process.pid },
          processBinding,
          confidence: "process_only",
        };
  });
  inferLiveMetadata(liveAgents, sessions, piTeams.memberships, piTeams.teams);
  return {
    generatedAt: new Date().toISOString(),
    sourceVersion: 1,
    sessions,
    turns,
    requests,
    keyMessages,
    liveAgents,
    teams: piTeams.teams,
    teamMemberships: piTeams.memberships,
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
        inferredRecentNamed: liveAgents.filter(
          (agent) => agent.sessionConfidence === "inferred_recent_named_session",
        ).length,
      },
      sessionFiles: sessionFiles.length,
      cacheHits,
      sessionCache: sessionCacheTrace,
      rejected: [...rejected, ...sidecars.rejected, ...lifecycle.rejected, ...piTeams.rejected],
    },
  };
}
