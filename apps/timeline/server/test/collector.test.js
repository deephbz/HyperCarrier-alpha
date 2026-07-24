import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SessionCache,
  SessionCatalog,
  collectSnapshot,
  discoverTmuxSockets,
  inferLiveMetadata,
  mapPiProcessesToPanes,
  parseProcessTable,
  parseSessionJsonl,
  parseTmuxPanes,
  queryProcesses,
  queryTmux,
  readSessionCatalogMetadata,
  readLifecycleLeases,
  readLiveSidecars,
  selectSessionWindow,
} from "../collector.js";

const paneLine = "$1\twork\t@2\t0\tagents\t%3\t1\t100\t/dev/ttys001\t/repo\tzsh\t0";

test("tmux socket discovery handles unsupported and absent roots", () => {
  assert.deepEqual(discoverTmuxSockets({ uid: undefined, roots: [] }), []);
  assert.deepEqual(discoverTmuxSockets({ uid: 12345, roots: ["/definitely/missing"] }), []);
});

test("tmux parser preserves server-qualified pane metadata", () => {
  assert.deepEqual(parseTmuxPanes(`${paneLine}\n`, "/tmp/tmux/u"), [
    {
      serverSocket: "/tmp/tmux/u",
      sessionId: "$1",
      sessionName: "work",
      windowId: "@2",
      windowIndex: 0,
      windowName: "agents",
      paneId: "%3",
      paneIndex: 1,
      panePid: 100,
      tty: "/dev/ttys001",
      cwd: "/repo",
      command: "zsh",
      dead: false,
    },
  ]);
});

test("multi-socket tmux query keeps failure diagnostics", () => {
  const run = (_command, args) => {
    if (args[1] === "/tmp/bad") throw new Error("no server");
    const format = args.at(-1);
    const separator = format.slice("#{session_id}".length, format.indexOf("#{session_name}"));
    return `${paneLine.split("\t").join(separator)}\n`;
  };
  const result = queryTmux(run, ["/tmp/a", "/tmp/bad"]);
  assert.equal(result.panes.length, 1);
  assert.deepEqual(
    result.diagnostics.map((item) => item.ok),
    [true, false],
  );
});

test("isolated real tmux server maps a live Pi-shaped process", { timeout: 10_000 }, async (t) => {
  try {
    execFileSync("tmux", ["-V"]);
  } catch {
    t.skip("tmux unavailable");
    return;
  }
  const name = `pi-timeline-test-${process.pid}`;
  const socket = join(tmpdir(), `${name}.sock`);
  t.after(() => {
    try {
      execFileSync("tmux", ["-S", socket, "kill-server"]);
    } catch {}
  });
  execFileSync("tmux", ["-S", socket, "new-session", "-d", "bash", "-c", "exec -a pi sleep 30"]);
  const deadline = Date.now() + 3_000;
  let observation = { tmux: { panes: [], diagnostics: [] }, mapped: [], processCount: 0 };
  while (Date.now() < deadline) {
    const tmux = queryTmux(execFileSync, [socket]);
    const processes = queryProcesses(execFileSync);
    const mapped = mapPiProcessesToPanes(tmux.panes, processes);
    observation = { tmux, mapped, processCount: processes.length };
    if (tmux.panes.length === 1 && mapped.length === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(
    observation.tmux.panes.length,
    1,
    `tmux pane was not ready: ${JSON.stringify(observation.tmux.diagnostics)}`,
  );
  assert.equal(
    observation.mapped.length,
    1,
    `Pi process was not ready: ${JSON.stringify({ tmux: observation.tmux.diagnostics, processCount: observation.processCount })}`,
  );
  const mapped = observation.mapped;
  assert.equal(mapped[0].pane.serverSocket, socket);
});

test("process parser accepts macOS weekday-day-month lstart output before the command", () => {
  const [process] = parseProcessTable("66844 66843 ttys003 Thu 16 Jul 12:33:42 2026     pi 30\n");
  assert.deepEqual(
    { pid: process.pid, ppid: process.ppid, tty: process.tty, command: process.command },
    { pid: 66844, ppid: 66843, tty: "ttys003", command: "pi 30" },
  );
  assert.match(process.startTime, /^2026-07-16T/);
});

test("process ancestry finds nested Pi without trusting pane current command", () => {
  const processes = parseProcessTable(
    `100 1 ttys001 zsh\n110 100 ttys001 npm exec pi\n120 110 ttys001 node /x/@mariozechner/pi-coding-agent/dist/cli.js\n200 1 ?? pi`,
  );
  const pane = parseTmuxPanes(paneLine, "/tmp/a")[0];
  assert.deepEqual(
    mapPiProcessesToPanes([pane], processes).map((item) => item.process.pid),
    [120],
  );
});

test("pane root can itself be the Pi process", () => {
  const pane = parseTmuxPanes(paneLine, "/tmp/a")[0];
  assert.deepEqual(
    mapPiProcessesToPanes([pane], [{ pid: 100, ppid: 1, tty: "t", command: "pi" }]).map(
      (item) => item.process.pid,
    ),
    [100],
  );
});

test("shared-window topology identifies one resumed team lead and binds all live session IDs", () => {
  const pane = (paneId) => ({
    serverSocket: "/tmp/a",
    sessionId: "$1",
    sessionName: "work",
    windowId: "@2",
    windowIndex: 0,
    windowName: "agents",
    paneId,
    cwd: "/repo",
  });
  const liveAgents = [
    {
      pid: 10,
      processInstanceId: "p10",
      processStartedAt: "2026-01-01T01:00:00Z",
      cwd: "/repo",
      state: "unknown",
      confidence: "process_only",
      pane: pane("%1"),
    },
    {
      pid: 11,
      processInstanceId: "p11",
      processStartedAt: "2026-01-01T01:05:00Z",
      cwd: "/repo",
      state: "unknown",
      confidence: "process_only",
      pane: pane("%2"),
      coordination: {
        kind: "pi-team",
        teamName: "alpha",
        agentName: "a",
        role: "teammate",
        source: "config",
      },
    },
    {
      pid: 12,
      processInstanceId: "p12",
      processStartedAt: "2026-01-01T01:06:00Z",
      cwd: "/repo",
      state: "unknown",
      confidence: "process_only",
      pane: pane("%3"),
      coordination: {
        kind: "pi-team",
        teamName: "alpha",
        agentName: "b",
        role: "teammate",
        source: "config",
      },
    },
    {
      pid: 13,
      processInstanceId: "p13",
      processStartedAt: "2026-01-01T01:07:00Z",
      cwd: "/repo",
      state: "unknown",
      confidence: "process_only",
      pane: pane("%4"),
      coordination: {
        kind: "pi-team",
        teamName: "alpha",
        agentName: "c",
        role: "teammate",
        source: "config",
      },
    },
  ];
  const sessions = [
    {
      id: "leader-session",
      name: "example-dashboard",
      cwd: "/repo",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T01:09:50Z",
    },
    {
      id: "a-session",
      cwd: "/repo",
      startedAt: "2026-01-01T01:05:01Z",
      endedAt: "2026-01-01T01:09:40Z",
    },
    {
      id: "b-session",
      cwd: "/repo",
      startedAt: "2026-01-01T01:06:01Z",
      endedAt: "2026-01-01T01:09:40Z",
    },
    {
      id: "c-session",
      cwd: "/repo",
      startedAt: "2026-01-01T01:07:01Z",
      endedAt: "2026-01-01T01:09:40Z",
    },
  ];
  const memberships = [
    { teamName: "alpha", agentName: "team-lead", role: "lead", cwd: "/repo", source: "config" },
  ];
  inferLiveMetadata(
    liveAgents,
    sessions,
    memberships,
    [{ name: "alpha" }],
    Date.parse("2026-01-01T01:10:00Z"),
  );
  assert.equal(liveAgents[0].coordination.agentName, "team-lead");
  assert.equal(liveAgents[0].coordination.confidence, "inferred_shared_window");
  assert.deepEqual(
    liveAgents.map((agent) => agent.sessionId),
    ["leader-session", "a-session", "b-session", "c-session"],
  );
  assert.equal(liveAgents[0].sessionName, "example-dashboard");
  assert.equal(liveAgents[0].sessionConfidence, "inferred_recent_named_session");
  assert.equal(liveAgents[1].sessionConfidence, "inferred_process_start");
});

test("shared-window lead inference refuses ambiguous unmatched Pi processes", () => {
  const common = { serverSocket: "/tmp/a", sessionId: "$1", windowId: "@2", cwd: "/repo" };
  const teammate = (pid) => ({
    pid,
    cwd: "/repo",
    pane: { ...common, paneId: `%${pid}` },
    coordination: {
      kind: "pi-team",
      teamName: "alpha",
      agentName: `t${pid}`,
      role: "teammate",
      source: "config",
    },
  });
  const agents = [
    teammate(1),
    teammate(2),
    { pid: 3, cwd: "/repo", pane: { ...common, paneId: "%3" } },
    { pid: 4, cwd: "/repo", pane: { ...common, paneId: "%4" } },
  ];
  inferLiveMetadata(
    agents,
    [],
    [{ teamName: "alpha", agentName: "team-lead", role: "lead", cwd: "/repo", source: "config" }],
    [{ name: "alpha" }],
  );
  assert.equal(agents[2].coordination, undefined);
  assert.equal(agents[3].coordination, undefined);
});

test("resumed Pi binds uniquely named tmux window to full session identity with provenance", () => {
  const agent = {
    pid: 42420,
    processStartedAt: "2026-07-12T01:13:18Z",
    cwd: "/repo",
    pane: {
      serverSocket: "/tmp/tmux/default",
      sessionId: "$0",
      windowId: "@1",
      windowName: "example-dashboard",
      paneId: "%21",
    },
  };
  const session = {
    id: "session-resume-example-001",
    name: "example-dashboard",
    cwd: "/repo",
    startedAt: "2026-07-12T00:20:53Z",
    endedAt: "2026-07-12T00:30:00Z",
    source: "/sessions/example-dashboard.jsonl",
  };
  inferLiveMetadata([agent], [session], [], [], Date.parse("2026-07-12T05:30:00Z"));
  assert.equal(agent.pid, 42420);
  assert.equal(agent.sessionId, session.id);
  assert.equal(agent.sessionName, "example-dashboard");
  assert.deepEqual(agent.sessionBinding, {
    confidence: "inferred_tmux_window_name",
    sessionSource: session.source,
    kind: "tmux_window_name",
    value: "example-dashboard",
    tmuxSource: "/tmp/tmux/default",
  });
});

test("tmux window binding refuses duplicate named sessions in one cwd", () => {
  const agent = { pid: 1, cwd: "/repo", pane: { serverSocket: "/tmp/a", windowName: "same" } };
  const sessions = [
    { id: "old", name: "same", cwd: "/repo" },
    { id: "new", name: "same", cwd: "/repo" },
  ];
  inferLiveMetadata([agent], sessions, [], []);
  assert.equal(agent.sessionId, undefined);
  assert.equal(agent.sessionBinding, undefined);
});

test("solo pre-lifecycle Pi binds one Session created 47 seconds after process start", () => {
  const workState = {
    availability: "unobserved",
    reason: "lifecycle_evidence_unavailable",
  };
  const agent = {
    pid: 77129,
    processStartedAt: "2026-07-16T04:46:30.000Z",
    cwd: "/workspaces/example-project",
    workState,
  };
  const session = {
    id: "example-session",
    name: "20260716-Example Session",
    cwd: "/workspaces/example-project",
    startedAt: "2026-07-16T04:47:17.000Z",
    source: "/sessions/example-session.jsonl",
  };

  inferLiveMetadata([agent], [session], [], []);

  assert.equal(agent.sessionId, session.id);
  assert.equal(agent.sessionName, session.name);
  assert.equal(agent.sessionConfidence, "inferred_unique_recent_session");
  assert.deepEqual(agent.sessionBinding, {
    confidence: "inferred_unique_recent_session",
    sessionSource: session.source,
    kind: "unique_recent_session",
    value: session.startedAt,
    processSource: "ps",
  });
  assert.equal(agent.workState, workState);
});

test("solo startup compatibility binding fails closed with a second agent or Session", () => {
  const agent = (pid) => ({
    pid,
    processStartedAt: "2026-07-16T04:46:30.000Z",
    cwd: "/workspaces/example-project",
  });
  const session = (id, seconds) => ({
    id,
    cwd: "/workspaces/example-project",
    startedAt: `2026-07-16T04:47:${seconds}.000Z`,
    source: `/sessions/${id}.jsonl`,
  });
  const withSecondAgent = [agent(77129), agent(77130)];
  inferLiveMetadata(withSecondAgent, [session("one", "17")], [], []);
  assert.ok(withSecondAgent.every((item) => item.sessionId === undefined));

  const oneAgent = agent(77129);
  inferLiveMetadata([oneAgent], [session("one", "17"), session("two", "18")], [], []);
  assert.equal(oneAgent.sessionId, undefined);
  assert.equal(oneAgent.sessionBinding, undefined);
});

test("same-second teammate spawn batch receives distinct session IDs by stable order", () => {
  const pane = (paneId) => ({
    serverSocket: "/tmp/a",
    sessionId: "$1",
    windowId: "@2",
    paneId,
    cwd: "/repo",
  });
  const agent = (pid, name) => ({
    pid,
    processStartedAt: "2026-01-01T01:00:00Z",
    cwd: "/repo",
    pane: pane(`%${pid}`),
    coordination: {
      kind: "pi-team",
      teamName: "alpha",
      agentName: name,
      role: "teammate",
      source: "config",
    },
  });
  const agents = [agent(120, "a"), agent(130, "b"), agent(140, "c")];
  const sessions = [
    {
      id: "s1",
      cwd: "/repo",
      startedAt: "2026-01-01T01:00:00.100Z",
      endedAt: "2026-01-01T01:01:00Z",
    },
    {
      id: "s2",
      cwd: "/repo",
      startedAt: "2026-01-01T01:00:00.200Z",
      endedAt: "2026-01-01T01:01:00Z",
    },
    {
      id: "s3",
      cwd: "/repo",
      startedAt: "2026-01-01T01:00:00.300Z",
      endedAt: "2026-01-01T01:01:00Z",
    },
  ];
  inferLiveMetadata(agents, sessions, [], [], Date.parse("2026-01-01T01:01:00Z"));
  assert.deepEqual(
    agents.map((item) => item.sessionId),
    ["s1", "s2", "s3"],
  );
  assert.ok(agents.every((item) => item.sessionConfidence === "inferred_process_start_batch"));
});

test("sidecars require a live process, valid lease, pane, and ancestry", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sidecar-"));
  const pane = parseTmuxPanes(paneLine, "/tmp/a")[0];
  const processes = [
    { pid: 100, ppid: 1, tty: "t", command: "zsh" },
    { pid: 120, ppid: 100, tty: "t", command: "pi" },
  ];
  const base = {
    schemaVersion: 1,
    processInstanceId: "host:120:1",
    processStartedAt: "2026-07-11T10:00:00.000Z",
    pid: 120,
    sessionId: "s1",
    heartbeatAt: "2026-07-11T12:00:00.000Z",
    leaseMs: 15_000,
    model: { provider: "test", id: "safe-model" },
    unexpected: "SIDECAR_SECRET",
    tmux: { serverSocket: "/tmp/a", paneId: "%3" },
  };
  writeFileSync(join(root, "good.json"), JSON.stringify(base));
  writeFileSync(
    join(root, "stale.json"),
    JSON.stringify({ ...base, processInstanceId: "old", heartbeatAt: "2026-07-11T11:00:00.000Z" }),
  );
  writeFileSync(
    join(root, "future.json"),
    JSON.stringify({
      ...base,
      processInstanceId: "future",
      heartbeatAt: "2026-07-11T13:00:00.000Z",
      leaseMs: 999_999_999,
    }),
  );
  writeFileSync(join(root, "bad.json"), "{");
  const result = readLiveSidecars({
    dir: root,
    now: Date.parse("2026-07-11T12:00:10Z"),
    panes: [pane],
    processes,
    alive: () => true,
  });
  assert.equal(result.accepted.length, 1);
  assert.deepEqual(result.rejected.map((item) => item.reason).sort(), [
    "lease_expired",
    "lease_expired",
    "malformed_json",
  ]);
  assert.equal(result.accepted[0].model, "safe-model");
  assert.equal(JSON.stringify(result.accepted).includes("SIDECAR_SECRET"), false);
  const expired = readLiveSidecars({
    dir: root,
    now: Date.parse("2026-07-11T12:00:16Z"),
    panes: [pane],
    processes,
    alive: () => true,
  });
  assert.equal(expired.accepted.length, 0);
});

test("lifecycle event logs materialize an exact leased live record", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-events-"));
  const pane = parseTmuxPanes(paneLine, "/tmp/a")[0];
  const events = [
    {
      type: "process_started",
      processBootId: "boot",
      pid: 120,
      processStartedAt: "2026-07-11T10:00:00Z",
      at: "2026-07-11T10:00:00Z",
      cwd: "/repo",
      tmux: { serverSocket: "/tmp/a", paneId: "%3" },
    },
    {
      type: "session_attached",
      at: "2026-07-11T11:00:00Z",
      sessionId: "s1",
      sessionFile: "/sessions/s1.jsonl",
      name: "agent-a",
      cwd: "/repo",
      tmux: { serverSocket: "/tmp/a", paneId: "%3" },
    },
    { type: "state_observed", at: "2026-07-11T12:00:00Z", state: "tool", tool: "bash" },
    {
      type: "heartbeat",
      at: "2026-07-11T12:00:05Z",
      leaseMs: 15_000,
      sessionId: "s1",
      state: "tool",
      context: { tokens: 10, window: 100, percent: 10 },
    },
  ].map((event) => ({ schemaVersion: 1, ...event }));
  writeFileSync(join(root, "boot.jsonl"), events.map(JSON.stringify).join("\n"));
  const result = readLifecycleLeases({
    dir: root,
    now: Date.parse("2026-07-11T12:00:10Z"),
    panes: [pane],
    processes: [
      { pid: 100, ppid: 1, command: "zsh" },
      {
        pid: 120,
        ppid: 100,
        startTime: "2026-07-11T10:00:00Z",
        command: "node /x/pi-coding-agent",
      },
    ],
    alive: () => true,
  });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].sessionId, "s1");
  assert.equal(result.accepted[0].state, "tool");
  assert.equal(result.accepted[0].activeTool, "bash");
});

test("lifecycle inputs reject unsupported schema versions", () => {
  const sidecars = mkdtempSync(join(tmpdir(), "pi-sidecar-schema-"));
  writeFileSync(
    join(sidecars, "future.json"),
    JSON.stringify({ schemaVersion: 2, pid: 1, processInstanceId: "p", processStartedAt: "x" }),
  );
  assert.equal(
    readLiveSidecars({ dir: sidecars }).rejected[0].reason,
    "unsupported_schema_version",
  );

  const events = mkdtempSync(join(tmpdir(), "pi-event-schema-"));
  writeFileSync(
    join(events, "future.jsonl"),
    `${JSON.stringify({ schemaVersion: 2, type: "process_started" })}\n`,
  );
  assert.equal(
    readLifecycleLeases({ dir: events }).rejected[0].reason,
    "unsupported_schema_version",
  );
});

test("PID-validated PiTeams Session locator binds exactly only with matching generation and pane", () => {
  const session = {
    id: "session-exact",
    source: "/sessions/session-exact.jsonl",
    cwd: "/repo",
    startedAt: "2026-07-16T04:00:00Z",
  };
  const agent = {
    pid: 81616,
    cwd: "/repo",
    processStartedAt: "2026-07-16T04:07:18.000Z",
    pane: { paneId: "%314", windowId: "@9" },
  };
  const membership = {
    pid: 81616,
    sessionFile: "/sessions/session-exact.jsonl",
    isActive: true,
    membershipId: "membership-1",
    runtimeMembershipId: "membership-1",
    runtimeStartedAt: "2026-07-16T04:07:19.800Z",
    configuredTerminalId: "%314",
    source: "/teams/example/config.json",
  };
  inferLiveMetadata([agent], [session], [membership], []);
  assert.equal(agent.sessionId, "session-exact");
  assert.equal(agent.sessionConfidence, undefined);
  assert.deepEqual(agent.sessionBinding, {
    confidence: "exact",
    sessionSource: "/sessions/session-exact.jsonl",
    kind: "pi_teams_session_file",
    evidenceSource: "/teams/example/config.json",
  });

  const mismatch = {
    ...agent,
    sessionId: undefined,
    sessionBinding: undefined,
    pane: { paneId: "%9" },
  };
  inferLiveMetadata([mismatch], [session], [membership], []);
  assert.equal(mismatch.sessionId, undefined);
});

test("JSONL parsing emits metadata only and reconciles turn cost", () => {
  const secret = "DO-NOT-LEAK-super-secret-prompt";
  const input = [
    { type: "session", id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/repo" },
    {
      type: "message",
      id: "u1",
      timestamp: "2026-01-01T00:01:00Z",
      message: { role: "user", content: secret },
    },
    {
      type: "message",
      id: "a1",
      timestamp: "2026-01-01T00:01:02Z",
      message: {
        role: "assistant",
        content: secret,
        stopReason: "stop",
        model: "m",
        usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.25 } },
      },
    },
  ]
    .map(JSON.stringify)
    .join("\n");
  const parsed = parseSessionJsonl(input, "fixture");
  assert.deepEqual(parsed.session.usage, {
    tokens: { availability: "complete", value: 15 },
    cost: { availability: "complete", value: 0.25 },
  });
  assert.equal(parsed.turns[0].requestCount, 1);
  assert.equal(parsed.requests[0].totalTokens, 15);
  assert.deepEqual(
    parsed.rarebits.map((marker) => marker.outcome),
    ["user", "stop"],
  );
  assert.equal(new URL(parsed.session.links.live).pathname, "/session/s1");
  assert.equal(new URL(parsed.session.links.tps).searchParams.get("session"), "s1");
  assert.ok(!JSON.stringify(parsed).includes(secret));

  const nativeUsage = input.replace('"totalTokens":15,', '"cacheRead":3,"cacheWrite":2,');
  const nativeParsed = parseSessionJsonl(nativeUsage, "native");
  assert.equal(nativeParsed.requests[0].totalTokens, 20);
  assert.deepEqual(nativeParsed.session.usage.tokens, {
    availability: "complete",
    value: 20,
  });
});

test("Session usage preserves observed zero, partial subtotals, and independent absence", () => {
  const header = {
    type: "session",
    id: "usage-evidence",
    timestamp: "2026-01-01T00:00:00Z",
    cwd: "/repo",
  };
  const assistant = (id, usage) => ({
    type: "message",
    id,
    timestamp: `2026-01-01T00:00:0${id.length}Z`,
    message: { role: "assistant", stopReason: "stop", usage },
  });
  const parse = (...entries) =>
    parseSessionJsonl([header, ...entries].map(JSON.stringify).join("\n"), "usage-fixture");

  assert.deepEqual(parse(assistant("zero", { totalTokens: 0, cost: { total: 0 } })).session.usage, {
    tokens: { availability: "complete", value: 0 },
    cost: { availability: "complete", value: 0 },
  });
  assert.deepEqual(
    parse(
      assistant("complete", { totalTokens: 1_000, cost: { total: 0 } }),
      assistant("partial", { input: 500, cost: { input: 0.05 } }),
      assistant("missing", undefined),
    ).session.usage,
    {
      tokens: { availability: "partial", value: 1_500 },
      cost: { availability: "partial", value: 0.05 },
    },
  );
  assert.deepEqual(parse(assistant("tokens", { totalTokens: 7 })).session.usage, {
    tokens: { availability: "complete", value: 7 },
    cost: { availability: "unavailable" },
  });
  assert.deepEqual(parse().session.usage, {
    tokens: { availability: "unavailable" },
    cost: { availability: "unavailable" },
  });
});

test("Rarebit markers share the summary predicate without serializing session prose", () => {
  const secret = "SENTINEL_KEY_MESSAGE_PROSE";
  const parsed = parseSessionJsonl(
    [
      { type: "session", id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/repo" },
      {
        type: "message",
        id: "u1",
        timestamp: "2026-01-01T00:01:00Z",
        message: { role: "user", content: secret },
      },
      {
        type: "message",
        id: "tool",
        timestamp: "2026-01-01T00:01:01Z",
        message: {
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "toolCall", name: "read" }],
        },
      },
      {
        type: "message",
        id: "continue",
        timestamp: "2026-01-01T00:01:02Z",
        message: {
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "text", text: secret }],
        },
      },
      {
        type: "message",
        id: "reasoning",
        timestamp: "2026-01-01T00:01:03Z",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "thinking", thinking: secret }],
        },
      },
      {
        type: "message",
        id: "stop",
        timestamp: "2026-01-01T00:01:04Z",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: secret }],
        },
      },
    ]
      .map(JSON.stringify)
      .join("\n"),
    "fixture",
  );
  assert.deepEqual(
    parsed.rarebits.map(({ sourceEntryId, role, outcome }) => ({
      sourceEntryId,
      role,
      outcome,
    })),
    [
      { sourceEntryId: "u1", role: "user", outcome: "user" },
      { sourceEntryId: "continue", role: "assistant", outcome: "continuation" },
      { sourceEntryId: "stop", role: "assistant", outcome: "stop" },
    ],
  );
  assert.equal(JSON.stringify(parsed.rarebits).includes(secret), false);
});

test("lastMessageAt uses the latest valid persisted user or assistant message timestamp", () => {
  const parsed = parseSessionJsonl(
    [
      { type: "session", id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/repo" },
      { type: "message", id: "u1", timestamp: "2026-01-01T00:01:00Z", message: { role: "user" } },
      {
        type: "message",
        id: "a1",
        timestamp: "2026-01-01T00:01:02Z",
        message: { role: "assistant", usage: {} },
      },
      { type: "heartbeat", timestamp: "2030-01-01T00:00:00Z" },
      { type: "message", id: "u2", timestamp: "not-a-date", message: { role: "user" } },
      {
        type: "message",
        id: "a2",
        timestamp: "2026-01-01T00:01:01Z",
        message: { role: "assistant", usage: {} },
      },
    ]
      .map(JSON.stringify)
      .join("\n"),
    "fixture",
  );
  assert.equal(parsed.session.lastMessageAt, "2026-01-01T00:01:02Z");
  assert.equal(parsed.session.endedAt, "2026-01-01T00:01:01Z");
});

test("catalog windowing uses persisted message time, pages older history, and avoids cold full parses", () => {
  const now = Date.parse("2026-01-02T00:00:00Z");
  const sessions = [
    { id: "recent", lastMessageAt: "2026-01-01T23:55:00Z" },
    { id: "old", lastMessageAt: "2025-12-30T00:00:00Z" },
  ];
  const recent = selectSessionWindow(sessions, { window: "15m", now });
  assert.deepEqual([...recent.selected], ["recent"]);
  const first = selectSessionWindow(sessions, { window: "all", limit: 1 });
  assert.deepEqual([...first.selected], ["recent"]);
  assert.equal(first.page.hasOlder, true);
  const second = selectSessionWindow(sessions, {
    window: "all",
    cursor: first.page.nextCursor,
    limit: 1,
  });
  assert.deepEqual([...second.selected], ["old"]);
  assert.throws(
    () => selectSessionWindow(sessions, { window: "all", cursor: "not-a-cursor" }),
    /invalid_snapshot_cursor/,
  );
});

test("fixed windows use lastMessageAt and anchor a historical window to its explicit upper bound", () => {
  const now = Date.parse("2026-01-10T00:00:00Z");
  const historicalEnd = Date.parse("2026-01-02T00:00:00Z");
  const sessions = [
    { id: "inside", lastMessageAt: "2026-01-01T23:30:00Z" },
    { id: "too-old", lastMessageAt: "2026-01-01T22:30:00Z" },
    { id: "too-new", lastMessageAt: "2026-01-02T00:30:00Z" },
  ];

  const selected = selectSessionWindow(sessions, {
    window: "1h",
    now,
    to: historicalEnd,
  });

  assert.deepEqual([...selected.selected], ["inside"]);
  assert.equal(selected.messageFrom, historicalEnd - 60 * 60_000);
  assert.equal(selected.messageTo, historicalEnd);
});

test("history cursor remains stable when Sessions share the same lastMessageAt", () => {
  const sessions = ["c", "a", "b"].map((id) => ({
    id,
    lastMessageAt: "2026-01-01T00:00:00Z",
  }));

  const first = selectSessionWindow(sessions, { window: "all", limit: 2 });
  const second = selectSessionWindow(sessions, {
    window: "all",
    cursor: first.page.nextCursor,
    limit: 2,
  });

  assert.deepEqual([...first.selected], ["a", "b"]);
  assert.deepEqual([...second.selected], ["c"]);
});

test("bounded collection skips full JSONL parsing for catalog entries outside the response window", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-catalog-window-"));
  const path = join(root, "old.jsonl");
  writeFileSync(
    path,
    [
      { type: "session", id: "old", timestamp: "2025-01-01T00:00:00Z", cwd: "/repo" },
      { type: "message", id: "u", timestamp: "2025-01-01T00:01:00Z", message: { role: "user" } },
      {
        type: "message",
        id: "large",
        timestamp: "2025-01-01T00:02:00Z",
        message: { role: "assistant", usage: {} },
        padding: "x".repeat(200_000),
      },
      {
        type: "message",
        id: "latest",
        timestamp: "2025-01-01T00:03:00Z",
        message: { role: "user" },
      },
    ]
      .map(JSON.stringify)
      .join("\n"),
  );
  const snapshot = collectSnapshot({
    sessionFiles: [path],
    cache: { read: () => assert.fail("old Session must not be full-parsed") },
    catalogCache: new SessionCatalog(),
    sockets: [],
    processes: [],
    window: "24h",
    now: Date.parse("2026-01-02T00:00:00Z"),
  });
  assert.equal(snapshot.sessions.length, 0);
  assert.equal(snapshot.trace.responseSessions, 0);
  assert.ok(snapshot.trace.catalog.bytesRead < 200_000);
});

test("catalog tail scan preserves a Unicode message split across 64 KiB chunks", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-catalog-unicode-tail-"));
  const path = join(root, "unicode.jsonl");
  const header = JSON.stringify({
    type: "session",
    id: "unicode",
    timestamp: "2026-01-01T00:00:00Z",
    cwd: "/repo",
  });
  const timestamp = "2026-01-01T00:10:00Z";
  const message = JSON.stringify({
    type: "message",
    id: "unicode-message",
    timestamp,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "界".repeat(30_000) }],
    },
  });
  const unicodeStart = Buffer.byteLength(`${header}\n${message.slice(0, message.indexOf("界"))}`);
  const unicodeEnd = unicodeStart + Buffer.byteLength("界".repeat(30_000));
  let body;
  let crossing;
  for (let pad = 0; pad < 3; pad += 1) {
    const trailing = Array.from({ length: 96 }, (_, index) =>
      JSON.stringify({ type: "session_name", name: `${index}-${"x".repeat(2_000)}` }),
    );
    trailing.push(JSON.stringify({ type: "session_name", name: "z".repeat(pad) }));
    body = [header, message, ...trailing].join("\n");
    const size = Buffer.byteLength(body);
    crossing = Array.from(
      { length: Math.ceil(size / (64 * 1024)) },
      (_, index) => size - (index + 1) * 64 * 1024,
    ).find(
      (boundary) =>
        boundary > unicodeStart &&
        boundary < unicodeEnd &&
        (boundary - unicodeStart) % Buffer.byteLength("界") !== 0,
    );
    if (crossing !== undefined) break;
  }
  assert.notEqual(crossing, undefined, "fixture must split a UTF-8 code point at a chunk edge");
  writeFileSync(path, body);

  const catalog = readSessionCatalogMetadata(path);
  assert.equal(catalog.session.lastMessageAt, timestamp);
  assert.deepEqual(catalog.session.lastMessageAtEvidence, {
    state: "observed",
    source: "bounded_tail_scan",
    reason: undefined,
  });
  assert.equal(catalog.catalogTrace.tailScan.state, "observed");
});

test("catalog tail scan reports unknown when trailing records exhaust its byte cap", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-catalog-cap-"));
  const path = join(root, "capped.jsonl");
  const timestamp = "2026-01-01T23:55:00Z";
  const lines = [
    { type: "session", id: "capped", timestamp: "2026-01-01T00:00:00Z", cwd: "/repo" },
    { type: "message", id: "recent", timestamp, message: { role: "user" } },
    ...Array.from({ length: 560 }, (_, index) => ({
      type: "session_name",
      name: `${index}-${"x".repeat(2_000)}`,
    })),
  ];
  writeFileSync(path, lines.map(JSON.stringify).join("\n"));

  const catalog = readSessionCatalogMetadata(path);
  assert.equal(catalog.session.lastMessageAt, undefined);
  assert.deepEqual(catalog.session.lastMessageAtEvidence, {
    state: "unknown",
    source: "bounded_tail_scan",
    reason: "tail_scan_cap_exhausted",
  });
  assert.deepEqual(catalog.catalogTrace.tailScan, {
    state: "unknown",
    reason: "tail_scan_cap_exhausted",
    maxBytes: 1024 * 1024,
  });

  const selected = selectSessionWindow(
    [
      catalog.session,
      { id: "recent", lastMessageAt: "2026-01-01T23:50:00Z" },
      { id: "old", lastMessageAt: "2026-01-01T20:00:00Z" },
    ],
    { window: "1h", now: Date.parse("2026-01-02T00:00:00Z") },
  );
  assert.deepEqual([...selected.selected], ["recent"]);
});

test("session cache is keyed by source stat identity", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-cache-"));
  const path = join(root, "s.jsonl");
  writeFileSync(
    path,
    JSON.stringify({ type: "session", id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/repo" }),
  );
  const cache = new SessionCache();
  assert.equal(cache.read(path).cacheHit, false);
  assert.equal(cache.read(path).cacheHit, true);
});

test("session cache appends a large JSONL file without rereading its committed prefix", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-cache-append-"));
  const path = join(root, "s.jsonl");
  const lines = [
    { type: "session", id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/repo" },
    ...Array.from({ length: 4_000 }, (_, index) => ({
      type: "session_name",
      name: `agent-${index}`,
    })),
    { type: "message", id: "u1", timestamp: "2026-01-01T00:01:00Z", message: { role: "user" } },
  ];
  writeFileSync(path, `${lines.map(JSON.stringify).join("\n")}\n`);
  const cache = new SessionCache();
  const initial = cache.read(path);
  assert.equal(initial.cacheTrace.rebuildCount, 1);
  const appended = [
    {
      type: "message",
      id: "a1",
      timestamp: "2026-01-01T00:01:02Z",
      message: { role: "assistant", usage: { input: 3, output: 5 } },
    },
    { type: "message", id: "u2", timestamp: "2026-01-01T00:02:00Z", message: { role: "user" } },
  ]
    .map(JSON.stringify)
    .join("\n");
  appendFileSync(path, `${appended}\n`);
  const updated = cache.read(path);
  assert.equal(updated.cacheTrace.appendCount, 1);
  assert.equal(updated.cacheTrace.rebuildCount, 0);
  assert.equal(updated.cacheTrace.bytesRead, Buffer.byteLength(`${appended}\n`));
  assert.equal(updated.cacheTrace.linesParsed, 2);
  assert.equal(updated.session.turnCount, 2);
  assert.equal(updated.session.requestCount, 1);
  assert.equal(updated.session.lastMessageAt, "2026-01-01T00:02:00Z");
  assert.deepEqual(
    { session: updated.session, turns: updated.turns, requests: updated.requests },
    (() => {
      const parsed = parseSessionJsonl(readFileSync(path, "utf8"), path);
      return { session: parsed.session, turns: parsed.turns, requests: parsed.requests };
    })(),
  );
  const hit = cache.read(path);
  assert.equal(hit.cacheHit, true);
  assert.deepEqual(hit.cacheTrace, {
    bytesRead: 0,
    linesParsed: 0,
    appendCount: 0,
    rebuildCount: 0,
  });
});

test("session cache carries a split trailing JSONL line into the next append", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-cache-tail-"));
  const path = join(root, "s.jsonl");
  const header = JSON.stringify({
    type: "session",
    id: "s1",
    timestamp: "2026-01-01T00:00:00Z",
    cwd: "/repo",
  });
  const user = JSON.stringify({
    type: "message",
    id: "u1",
    timestamp: "2026-01-01T00:01:00Z",
    message: { role: "user" },
  });
  const assistant = JSON.stringify({
    type: "message",
    id: "a1",
    timestamp: "2026-01-01T00:01:02Z",
    message: { role: "assistant", usage: { totalTokens: 8 } },
  });
  writeFileSync(path, `${header}\n${user.slice(0, -2)}`);
  const cache = new SessionCache();
  const before = cache.read(path);
  assert.equal(before.session.turnCount, 0);
  appendFileSync(path, `${user.slice(-2)}\n${assistant}\n`);
  const after = cache.read(path);
  assert.equal(after.cacheTrace.appendCount, 1);
  assert.equal(after.cacheTrace.linesParsed, 2);
  assert.equal(after.session.turnCount, 1);
  assert.equal(after.session.requestCount, 1);
  assert.deepEqual(
    { session: after.session, turns: after.turns, requests: after.requests },
    (() => {
      const parsed = parseSessionJsonl(readFileSync(path, "utf8"), path);
      return { session: parsed.session, turns: parsed.turns, requests: parsed.requests };
    })(),
  );
});

test("session cache rebuilds after truncation, replacement, or a malformed completed append", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-cache-rebuild-"));
  const path = join(root, "s.jsonl");
  const valid = (id) =>
    `${JSON.stringify({ type: "session", id, timestamp: "2026-01-01T00:00:00Z", cwd: "/repo" })}\n`;
  writeFileSync(path, `${valid("old")}${" ".repeat(1_000)}`);
  const cache = new SessionCache();
  cache.read(path);
  writeFileSync(path, valid("truncated"));
  const truncated = cache.read(path);
  assert.equal(truncated.session.id, "truncated");
  assert.deepEqual(truncated.cacheTrace, {
    bytesRead: Buffer.byteLength(valid("truncated")),
    linesParsed: 1,
    appendCount: 0,
    rebuildCount: 1,
  });

  const replacement = join(root, "replacement.jsonl");
  writeFileSync(replacement, valid("replaced"));
  renameSync(replacement, path);
  const replaced = cache.read(path);
  assert.equal(replaced.session.id, "replaced");
  assert.equal(replaced.cacheTrace.rebuildCount, 1);

  appendFileSync(path, "not-json\n");
  const malformed = cache.read(path);
  assert.equal(malformed.cacheTrace.rebuildCount, 1);
  assert.equal(malformed.cacheTrace.appendCount, 0);
  assert.deepEqual(malformed.rejected.at(-1), {
    source: path,
    line: 2,
    reason: "malformed_jsonl",
  });
});

test("snapshot never exposes process argv or raw command errors", () => {
  const sentinel = "SENTINEL_PROMPT_SECRET_42";
  const sidecarRoot = mkdtempSync(join(tmpdir(), "pi-empty-live-"));
  const eventsRoot = mkdtempSync(join(tmpdir(), "pi-empty-events-"));
  const teamsRoot = mkdtempSync(join(tmpdir(), "pi-teams-live-"));
  mkdirSync(join(teamsRoot, "alpha"));
  writeFileSync(
    join(teamsRoot, "alpha", "config.json"),
    JSON.stringify({
      name: "alpha",
      description: sentinel,
      members: [
        {
          name: "builder",
          agentType: "teammate",
          cwd: "/repo",
          tmuxPaneId: "%old",
          sessionFile: "/sessions/private-builder.jsonl",
          prompt: sentinel,
        },
      ],
    }),
  );
  writeFileSync(join(teamsRoot, "alpha", "builder.pid"), "120");
  const paneOutput = `${paneLine}\n`;
  const run = (_command, args) => {
    if (args.includes("list-panes")) return paneOutput;
    throw new Error(sentinel);
  };
  const snapshot = collectSnapshot({
    run,
    sockets: ["/tmp/a"],
    sessionFiles: [],
    dir: sidecarRoot,
    eventsDir: eventsRoot,
    teamsRoot,
    processes: [
      { pid: 100, ppid: 1, command: "zsh" },
      { pid: 120, ppid: 100, command: `node /x/pi-coding-agent -p ${sentinel}` },
    ],
  });
  assert.equal(snapshot.liveAgents.length, 1);
  assert.equal(JSON.stringify(snapshot).includes(sentinel), false);
  assert.deepEqual(snapshot.liveAgents[0].process, { pid: 120, state: "running" });
  assert.equal(snapshot.liveAgents[0].processState, "running");
  assert.deepEqual(snapshot.liveAgents[0].workState, {
    availability: "unobserved",
    reason: "lifecycle_evidence_unavailable",
  });
  assert.equal(snapshot.liveAgents[0].state, undefined);
  assert.equal(snapshot.schemaVersion, 3);
  assert.deepEqual(snapshot.liveAgents[0].coordination, {
    kind: "pi-team",
    teamName: "alpha",
    agentName: "builder",
    role: "teammate",
    ready: undefined,
    source: join(teamsRoot, "alpha", "config.json"),
  });
  assert.equal(snapshot.trace.piTeams.liveMatches, 1);
  assert.equal(JSON.stringify(snapshot.teamMemberships).includes("sessionFile"), false);
  assert.equal(JSON.stringify(snapshot.teamMemberships).includes("private-builder"), false);

  const failed = queryTmux(() => {
    throw new Error(sentinel);
  }, ["/tmp/a"]);
  assert.equal(JSON.stringify(failed).includes(sentinel), false);
  assert.equal(failed.diagnostics[0].error.kind, "Error");
});
