import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAtomicJsonSink,
  createLifecycleExtension,
  parseTmuxEnvironment,
  SCHEMA_VERSION,
} from "../extensions/timeline-lifecycle.mjs";
import { collectSnapshot, readLiveSidecars } from "../server/collector.js";

function harness() {
  const handlers = new Map();
  const records = [];
  const pi = {
    on(name, fn) {
      handlers.set(name, fn);
    },
    getSessionName() {
      return "safe-name";
    },
  };
  const ctx = {
    cwd: "/repo/project",
    model: { provider: "test-provider", id: "test-model", contextWindow: 200_000 },
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => "/sessions/1.jsonl",
      getSessionName: () => "safe-name",
    },
    getContextUsage: () => ({ tokens: 42_000, contextWindow: 200_000, percent: 21 }),
  };
  const boot = {
    processBootId: "boot-1",
    startedAt: "2026-01-01T00:00:00.000Z",
    processStartedEmitted: false,
  };
  createLifecycleExtension({
    sink: (r) => records.push(r),
    boot,
    heartbeatMs: 0,
    now: () => new Date("2026-01-01T00:00:01.000Z"),
  })(pi);
  return { handlers, records, ctx };
}

test("parses tmux identity without titles or terminal content", () => {
  assert.deepEqual(
    parseTmuxEnvironment({ TMUX: "/tmp/tmux-501/default,123,0", TMUX_PANE: "%17" }),
    {
      serverSocket: "/tmp/tmux-501/default",
      paneId: "%17",
    },
  );
  assert.equal(parseTmuxEnvironment({}), undefined);
});

test("atomic private live lease is accepted by collector, expires, and records stop", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-timeline-live-"));
  const livePath = join(root, "boot-1.json");
  const handlers = new Map();
  const pi = {
    on(name, fn) {
      handlers.set(name, fn);
    },
    getSessionName: () => "safe",
  };
  const ctx = {
    cwd: "/repo/project",
    model: { provider: "p", id: "m" },
    sessionManager: {
      getSessionId: () => "s1",
      getSessionFile: () => "/s",
      getSessionName: () => "safe",
    },
    getContextUsage: () => ({ tokens: 5, contextWindow: 10, percent: 50 }),
  };
  const boot = {
    processBootId: "boot-1",
    startedAt: "2026-07-11T10:00:00.000Z",
    processStartedEmitted: false,
  };
  createLifecycleExtension({
    sink() {},
    liveSink: createAtomicJsonSink(livePath),
    boot,
    heartbeatMs: 5_000,
    now: () => new Date("2026-07-11T12:00:00.000Z"),
    env: {},
  })(pi);
  handlers.get("session_start")({ reason: "startup" }, ctx);
  assert.equal(statSync(livePath).mode & 0o777, 0o600);
  const record = JSON.parse(readFileSync(livePath, "utf8"));
  assert.equal(record.processInstanceId, "boot-1");
  assert.equal(record.sessionId, "s1");
  assert.equal(record.context.percent, 50);
  const processes = [{ pid: process.pid, ppid: 1, command: "pi", startTime: boot.startedAt }];
  const accepted = readLiveSidecars({
    dir: root,
    now: Date.parse("2026-07-11T12:00:10Z"),
    processes,
    alive: () => true,
  });
  assert.equal(accepted.accepted.length, 1);
  const paneLine = `$1\twork\t@2\t0\t%3\t0\t1\tttys001\t/repo/project\tzsh\t0\n`;
  const snapshot = collectSnapshot({
    dir: root,
    eventsDir: join(root, "no-events"),
    now: Date.parse("2026-07-11T12:00:10Z"),
    sockets: ["/tmp/a"],
    run: () => paneLine,
    processes: [{ pid: 1, ppid: 0, command: "zsh" }, ...processes.map((p) => ({ ...p, ppid: 1 }))],
    sessionFiles: [],
    alive: () => true,
  });
  assert.equal(snapshot.liveAgents.length, 1);
  assert.equal(snapshot.liveAgents[0].confidence, "exact");
  assert.equal(snapshot.liveAgents[0].sessionId, "s1");
  const stale = readLiveSidecars({
    dir: root,
    now: Date.parse("2026-07-11T12:01:00Z"),
    processes,
    alive: () => true,
  });
  assert.equal(stale.accepted.length, 0);
  assert.equal(stale.rejected[0].reason, "lease_expired");
  handlers.get("session_shutdown")({ reason: "quit" }, ctx);
  assert.equal(JSON.parse(readFileSync(livePath, "utf8")).state, "stopped");
  const stopped = readLiveSidecars({
    dir: root,
    now: Date.parse("2026-07-11T12:00:10Z"),
    processes,
    alive: () => true,
  });
  assert.equal(stopped.accepted.length, 0);
  assert.equal(stopped.rejected[0].reason, "process_stopped");
});

test("emits distinct process, runtime, attachment, run, and model-step identities", () => {
  const { handlers, records, ctx } = harness();
  handlers.get("session_start")({ reason: "startup" }, ctx);
  handlers.get("agent_start")({}, ctx);
  handlers.get("turn_start")({ turnIndex: 0, timestamp: 1 }, ctx);
  handlers.get("tool_execution_start")({ toolName: "bash", args: { secret: "DO_NOT_LEAK" } }, ctx);
  handlers.get("tool_execution_end")(
    { toolName: "bash", result: { content: "DO_NOT_LEAK" }, isError: false },
    ctx,
  );
  handlers.get("turn_end")(
    { turnIndex: 0, message: { stopReason: "toolUse", content: "DO_NOT_LEAK" } },
    ctx,
  );
  handlers.get("agent_settled")({}, ctx);
  const types = records.map((r) => r.type);
  for (const type of [
    "process_started",
    "extension_runtime_started",
    "session_attached",
    "agent_run_started",
    "model_step_started",
    "model_step_ended",
    "agent_run_settled",
  ]) {
    assert.ok(types.includes(type), `missing ${type}`);
  }
  assert.equal(
    records.every((r) => r.schemaVersion === SCHEMA_VERSION),
    true,
  );
  assert.equal(records.find((r) => r.type === "session_attached").sessionId, "session-1");
  assert.equal(records.find((r) => r.type === "agent_run_settled").context.tokens, 42_000);
});

test("strict privacy: prompts, tool args/results, and message content never cross the sink", () => {
  const { handlers, records, ctx } = harness();
  handlers.get("session_start")({ reason: "startup" }, ctx);
  handlers.get("agent_start")({}, ctx);
  handlers.get("tool_execution_start")(
    { toolName: "read", args: { path: "SENTINEL_SECRET_7d9" } },
    ctx,
  );
  handlers.get("tool_execution_end")(
    { toolName: "read", result: { content: "SENTINEL_SECRET_7d9" }, isError: true },
    ctx,
  );
  handlers.get("turn_end")(
    {
      turnIndex: 3,
      message: { stopReason: "error", content: "SENTINEL_SECRET_7d9" },
      toolResults: [{ content: "SENTINEL_SECRET_7d9" }],
    },
    ctx,
  );
  const wire = records.map(JSON.stringify).join("\n");
  assert.equal(wire.includes("SENTINEL_SECRET_7d9"), false);
  assert.equal(wire.includes('"args"'), false);
  assert.equal(wire.includes('"result"'), false);
  assert.equal(wire.includes('"content"'), false);
});

test("heartbeat is a lease observation and shutdown closes only the attachment/runtime", () => {
  const { handlers, records, ctx } = harness();
  handlers.get("session_start")({ reason: "startup" }, ctx);
  handlers.get("session_shutdown")({ reason: "reload" }, ctx);
  assert.ok(records.some((r) => r.type === "heartbeat" && r.leaseMs >= 1_000));
  assert.ok(records.some((r) => r.type === "session_detached" && r.reason === "reload"));
  assert.ok(records.some((r) => r.type === "extension_runtime_stopped"));
  assert.equal(
    records.some((r) => r.type === "process_stopping"),
    false,
  );
});
