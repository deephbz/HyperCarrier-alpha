#!/usr/bin/env node
/** Generate a deterministic, metadata-only scale fixture for the collector. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

export const FIXTURE_NOW = "2026-07-11T12:00:00.000Z";
export const SESSION_COUNT = 13;
export const DENSE_SESSION_TURNS = 240;

const projects = ["atlas", "beacon", "cipher", "delta", "ember", "fjord", "grove", "harbor"];
const iso = (seconds) =>
  new Date(Date.parse("2026-07-10T08:00:00.000Z") + seconds * 1_000).toISOString();
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const writeJsonl = (path, records) =>
  writeFileSync(path, `${records.map(JSON.stringify).join("\n")}\n`);

function usageFor(sessionNumber, turn) {
  const dense = sessionNumber === 1;
  const input = dense ? 42_000 + (turn % 5) * 1_000 : 8_000 + sessionNumber * 500;
  const output = dense ? 1_200 + (turn % 7) * 100 : 700 + (turn % 4) * 75;
  return {
    input,
    output,
    cacheRead: Math.floor(input * 0.7),
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { total: Number((input * 0.000003 + output * 0.000015).toFixed(6)) },
  };
}

function sessionRecords(number) {
  const id = `synthetic-session-${String(number).padStart(2, "0")}`;
  const turns = number === 1 ? DENSE_SESSION_TURNS : 4 + (number % 5);
  const start = number * 3_600;
  const records = [
    {
      type: "session",
      id,
      timestamp: iso(start),
      cwd: `/work/${projects[(number - 1) % projects.length]}`,
    },
    {
      type: "session_name",
      timestamp: iso(start + 1),
      name: `synthetic-${projects[(number - 1) % projects.length]}-${number}`,
    },
  ];
  for (let turn = 1; turn <= turns; turn++) {
    const at = start + turn * 35;
    records.push({
      type: "message",
      id: `${id}-user-${turn}`,
      timestamp: iso(at),
      message: { role: "user" },
    });
    records.push({
      type: "message",
      id: `${id}-assistant-${turn}`,
      timestamp: iso(at + 12),
      message: {
        role: "assistant",
        provider: "synthetic-provider",
        model: "synthetic-model-v1",
        stopReason: "stop",
        usage: usageFor(number, turn),
      },
    });
  }
  return records;
}

function lifecycleRecords(number) {
  const id = `synthetic-session-${String(number).padStart(2, "0")}`;
  const pid = 50_000 + number;
  const boot = `synthetic-host:${pid}:2026-07-11`;
  const paneId = `%${100 + number}`;
  const start = 97_000 + number * 20;
  const common = {
    schemaVersion: 1,
    host: "synthetic-host",
    processBootId: boot,
    extensionRuntimeId: `runtime-${number}`,
  };
  const event = (type, seconds, payload = {}) => ({
    ...common,
    eventId: `${boot}:${type}:${seconds}`,
    type,
    at: iso(seconds),
    observedAt: iso(seconds),
    ...payload,
  });
  const cwd = `/work/${projects[(number - 1) % projects.length]}`;
  const records = [
    event("process_started", start, {
      pid,
      processStartedAt: iso(start),
      cwd,
      tmux: { socket: "/tmp/tmux-synthetic/main", paneId },
    }),
    event("extension_runtime_started", start + 1, { pid }),
    event("session_attached", start + 2, {
      sessionId: id,
      attachmentId: `attachment-${number}`,
      cwd,
      sessionFile: `sessions/${id}.jsonl`,
      name: `synthetic-${number}`,
      tmux: { socket: "/tmp/tmux-synthetic/main", paneId },
    }),
    event("agent_run_started", start + 3, {
      sessionId: id,
      attachmentId: `attachment-${number}`,
      agentRunId: `run-${number}`,
    }),
    event("state_observed", start + 4, {
      sessionId: id,
      state: number === 1 ? "waiting_input" : "thinking",
    }),
  ];
  if (number === 1) {
    for (let member = 0; member < 6; member++) {
      records.push(
        event("coordination_membership", start + 5 + member, {
          sessionId: member === 0 ? id : `synthetic-team-member-${member}`,
          relation: "pi_team",
          teamId: "synthetic-blocked-mesh",
          role: member === 0 ? "leader" : "teammate",
          state: member === 0 ? "blocked" : "waiting",
        }),
      );
    }
    for (const compact of [60, 120, 180, 220]) {
      records.push(
        event("compaction_completed", start + compact, {
          sessionId: id,
          attachmentId: "attachment-1",
          agentRunId: "run-1",
          reason: "context_window",
          willRetry: true,
          context: { tokens: 190_000, window: 200_000, percent: 95 },
        }),
      );
    }
  }
  const fresh = number === 1 || number === 2;
  records.push(
    event("heartbeat", fresh ? 100_800 : start + 10, {
      sessionId: id,
      attachmentId: `attachment-${number}`,
      state: number === 1 ? "waiting_input" : "idle",
      leaseMs: 30_000,
      context: { tokens: 42_000 + number * 500, window: 200_000, percent: 21 + number },
    }),
  );
  return records;
}

/**
 * Create sessions, lifecycle event logs, and live sidecars under `root`.
 * The returned paths and manifest make tests independent of the caller's cwd.
 */
export function generateFixture(root) {
  const fixtureRoot = resolve(root);
  const sessionsRoot = join(fixtureRoot, "sessions");
  const eventsDir = join(fixtureRoot, "events");
  const liveDir = join(fixtureRoot, "live");
  for (const dir of [sessionsRoot, eventsDir, liveDir]) mkdirSync(dir, { recursive: true });

  let totalTokens = 0;
  let submissions = 0;
  for (let number = 1; number <= SESSION_COUNT; number++) {
    const id = `synthetic-session-${String(number).padStart(2, "0")}`;
    const records = sessionRecords(number);
    writeJsonl(join(sessionsRoot, `${id}.jsonl`), records);
    writeJsonl(join(eventsDir, `synthetic-boot-${number}.jsonl`), lifecycleRecords(number));
    for (const record of records) {
      if (record.message?.role === "user") submissions++;
      if (record.message?.role === "assistant") totalTokens += record.message.usage.totalTokens;
    }
  }
  const live = (number, heartbeatAt, state) => ({
    processInstanceId: `synthetic-host:${50_000 + number}:2026-07-11`,
    processStartedAt: iso(97_000 + number * 20),
    pid: 50_000 + number,
    sessionId: `synthetic-session-${String(number).padStart(2, "0")}`,
    heartbeatAt,
    state,
    tmux: { serverSocket: "/tmp/tmux-synthetic/main", paneId: `%${100 + number}` },
  });
  writeJson(join(liveDir, "blocked-team-leader.json"), live(1, FIXTURE_NOW, "blocked"));
  writeJson(join(liveDir, "stale-waiting-member.json"), live(2, iso(90_000), "waiting_input"));
  const manifest = {
    generatedAt: FIXTURE_NOW,
    sessionsRoot,
    eventsDir,
    liveDir,
    sessionCount: SESSION_COUNT,
    submissions,
    totalTokens,
    compactions: 4,
    team: { id: "synthetic-blocked-mesh", leader: "synthetic-session-01", teammates: 5 },
  };
  writeJson(join(fixtureRoot, "manifest.json"), manifest);
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const manifest = generateFixture(process.argv[2] ?? "synthetic-fixture");
  console.log(JSON.stringify(manifest));
}
