import test from "node:test";
import assert from "node:assert/strict";
import {
  clearAllHierarchy,
  metadataArgs,
  projectHierarchy,
  reconcileHierarchy,
} from "./hierarchy.mjs";
import { reportSequence } from "./lib.mjs";

function membership(overrides = {}) {
  return {
    membershipId: "membership-1",
    teamName: "alpha",
    memberName: "researcher",
    coordinationRole: "teammate",
    lifecycle: { state: "current", joinedAt: "2026-01-01T00:00:00Z" },
    session: { kind: "pi-jsonl-path", locator: "/sessions/current.jsonl" },
    terminalTarget: { backend: "herdr", kind: "pane", targetId: "w1:p2" },
    issues: [],
    ...overrides,
  };
}

function snapshot(members, availability = "available") {
  return {
    schema: "pi-teams-observation/1",
    generatedAt: "2026-01-01T00:00:00Z",
    producerVersion: "test",
    availability,
    teams: [{ teamName: "alpha", memberships: members, issues: [] }],
    issues: [],
  };
}

function agent(overrides = {}) {
  return {
    agent: "pi",
    pane_id: "w1:p2",
    agent_session: {
      agent: "pi",
      kind: "path",
      value: "/sessions/current.jsonl",
    },
    ...overrides,
  };
}

test("projects Team and subordinate Worker tokens from one exact pane and Session match", () => {
  const [worker] = projectHierarchy(snapshot([membership()]), [agent()]);
  assert.deepEqual(worker, {
    paneId: "w1:p2",
    kind: "matched",
    memberName: "researcher",
    role: "teammate",
    tokens: {
      pi_team_lead: null,
      pi_team_worker: "↳ researcher",
      pi_team_binding: worker.tokens.pi_team_binding,
    },
  });

  const [leader] = projectHierarchy(
    snapshot([membership({ memberName: "lead", coordinationRole: "lead" })]),
    [agent()],
  );
  assert.equal(leader.tokens.pi_team_lead, "lead");
  assert.equal(leader.tokens.pi_team_worker, null);
  assert.match(worker.tokens.pi_team_binding, /^[A-Za-z0-9_-]{24}$/);
});

test("rejects stale, inferred, non-Herdr, ended, and ambiguous Memberships", () => {
  assert.equal(
    projectHierarchy(
      snapshot([membership({ session: { kind: "pi-jsonl-path", locator: "/sessions/stale.jsonl" } })]),
      [agent()],
    )[0].kind,
    "unmatched",
  );
  assert.equal(
    projectHierarchy(
      snapshot([membership({ terminalTarget: { backend: "tmux", kind: "pane", targetId: "w1:p2" } })]),
      [agent()],
    )[0].kind,
    "unmatched",
  );
  assert.equal(
    projectHierarchy(
      snapshot([membership({ lifecycle: { state: "ended", joinedAt: "x" } })]),
      [agent()],
    )[0].kind,
    "ended",
  );
  assert.equal(
    projectHierarchy(snapshot([membership(), membership({ membershipId: "membership-2" })]), [agent()])[0].kind,
    "ambiguous",
  );
  assert.equal(
    projectHierarchy(snapshot([membership()]), [agent({ agent: "claude" })])[0].kind,
    "unsupported",
  );
  assert.equal(
    projectHierarchy(snapshot([]), [agent({
      agent_session: null,
      tokens: { pi_team_binding: "prior-binding" },
    })])[0].kind,
    "unsupported",
  );
});

test("emits only source-owned tokens with explicit opposite-role clearing", () => {
  const [worker] = projectHierarchy(snapshot([membership()]), [agent()]);
  assert.deepEqual(metadataArgs(worker, "42"), [
    "pane", "report-metadata", "w1:p2",
    "--source", "plugin:pi-teams-hierarchy",
    "--seq", "42",
    "--clear-token", "pi_team_lead",
    "--token", "pi_team_worker=↳ researcher",
    "--token", `pi_team_binding=${worker.tokens.pi_team_binding}`,
    "--clear-token", "pi_team_name",
  ]);
  assert.equal(metadataArgs(worker, "42").some((value) => value.includes("rarebit")), false);
});

test("partial observation publishes exact positives but does not clear absence", async () => {
  const calls = [];
  const result = await reconcileHierarchy({
    readObservation: async () => snapshot([membership()], "partial"),
    agents: () => [agent(), agent({ pane_id: "w1:p3", agent_session: { agent: "pi", kind: "path", value: "/sessions/other.jsonl" } })],
    run: (args) => calls.push(args),
    record: () => {},
    sequence: "43",
  });
  assert.equal(result.published, 1);
  assert.equal(result.cleared, 0);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("pi_team_worker=↳ researcher"));
});

test("complete observation clears unmatched panes and leaves ambiguous panes unchanged", async () => {
  const calls = [];
  const result = await reconcileHierarchy({
    readObservation: async () => snapshot([
      membership(),
      membership({ membershipId: "membership-2" }),
    ]),
    agents: () => [
      agent(),
      agent({ pane_id: "w1:p3", agent_session: { agent: "pi", kind: "path", value: "/sessions/other.jsonl" } }),
    ],
    run: (args) => calls.push(args),
    record: () => {},
    sequence: "44",
  });
  assert.equal(result.ambiguous, 1);
  assert.equal(result.published, 0);
  assert.equal(result.cleared, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(-8), [
    "--clear-token", "pi_team_lead",
    "--clear-token", "pi_team_worker",
    "--clear-token", "pi_team_binding",
    "--clear-token", "pi_team_name",
  ]);
});

test("partial observation clears labels only from positive ended Membership evidence", async () => {
  const calls = [];
  const result = await reconcileHierarchy({
    readObservation: async () => snapshot([
      membership({ lifecycle: { state: "ended", joinedAt: "x", endedAt: "y", reason: "team_shutdown" } }),
    ], "partial"),
    agents: () => [agent()],
    run: (args) => calls.push(args),
    record: () => {},
    sequence: "45",
  });
  assert.equal(result.published, 0);
  assert.equal(result.cleared, 1);
  assert.equal(calls.length, 1);
});

test("unavailable observation preserves all prior metadata", async () => {
  const calls = [];
  const result = await reconcileHierarchy({
    readObservation: async () => snapshot([], "unavailable"),
    agents: () => [agent()],
    run: (args) => calls.push(args),
    record: () => {},
    sequence: "46",
  });
  assert.equal(result.published, 0);
  assert.equal(result.cleared, 0);
  assert.deepEqual(calls, []);
});

test("a targeted settlement retry does not republish other live Agents", async () => {
  const calls = [];
  const result = await reconcileHierarchy({
    readObservation: async () => snapshot([membership()]),
    agents: () => [agent(), agent({ pane_id: "w1:p3" })],
    run: (args) => calls.push(args),
    record: () => {},
    sequence: "47",
    targetPaneId: "w1:p2",
  });
  assert.equal(result.liveAgentCount, 2);
  assert.equal(result.consideredAgentCount, 1);
  assert.equal(calls.length, 1);
});

test("report sequences order reporters within one wall-clock tick", () => {
  const first = BigInt(reportSequence(1_000, 100n));
  const second = BigInt(reportSequence(1_000, 200n));
  assert.ok(second > first);
});

test("clear-all removes only hierarchy tokens from every live pane", () => {
  const calls = [];
  const result = clearAllHierarchy({
    agents: () => [agent(), agent({ pane_id: "w1:p3" })],
    run: (args) => calls.push(args),
    record: () => {},
    sequence: "48",
  });
  assert.equal(result.cleared, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls.flat().some((value) => String(value).includes("rarebit")), false);
});
