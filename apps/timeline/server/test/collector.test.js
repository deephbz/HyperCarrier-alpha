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
  collectSnapshot,
  discoverTmuxSockets,
  inferLiveMetadata,
  mapPiProcessesToPanes,
  parseProcessTable,
  parseSessionJsonl,
  parseTmuxPanes,
  queryProcesses,
  queryTmux,
  readLifecycleLeases,
  readLiveSidecars,
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

test("isolated real tmux server maps a live Pi-shaped process", { timeout: 10_000 }, (t) => {
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
  const tmux = queryTmux(execFileSync, [socket]);
  assert.equal(tmux.panes.length, 1);
  const mapped = mapPiProcessesToPanes(tmux.panes, queryProcesses(execFileSync));
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].pane.serverSocket, socket);
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
  ];
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
        model: "m",
        usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.25 } },
      },
    },
  ]
    .map(JSON.stringify)
    .join("\n");
  const parsed = parseSessionJsonl(input, "fixture");
  assert.equal(parsed.session.cost, 0.25);
  assert.equal(parsed.turns[0].requestCount, 1);
  assert.equal(parsed.requests[0].totalTokens, 15);
  assert.ok(!JSON.stringify(parsed).includes(secret));

  const nativeUsage = input.replace('"totalTokens":15,', '"cacheRead":3,"cacheWrite":2,');
  assert.equal(parseSessionJsonl(nativeUsage, "native").requests[0].totalTokens, 20);
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
  assert.deepEqual(snapshot.liveAgents[0].process, { pid: 120 });
  assert.deepEqual(snapshot.liveAgents[0].coordination, {
    kind: "pi-team",
    teamName: "alpha",
    agentName: "builder",
    role: "teammate",
    ready: undefined,
    source: join(teamsRoot, "alpha", "config.json"),
  });
  assert.equal(snapshot.trace.piTeams.liveMatches, 1);

  const failed = queryTmux(() => {
    throw new Error(sentinel);
  }, ["/tmp/a"]);
  assert.equal(JSON.stringify(failed).includes(sentinel), false);
  assert.equal(failed.diagnostics[0].error.kind, "Error");
});
