import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalSessionRegistry,
  TrafficScopeManager,
  TrafficScopeResolver,
} from "../application/scopes.js";

const uuid = (digit: string) =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const agentA = uuid("1");
const agentB = uuid("2");
const session = (id: string) =>
  `${JSON.stringify({ type: "session", id })}\n${JSON.stringify({ timestamp: "2026-07-15T00:00:00.000Z", message: { role: "user", content: "safe" } })}\n`;

test("TeamTraceScope includes every explicit mapping and rotates provenance on config replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "traffic-scopes-"));
  const team = join(root, "trace");
  await mkdir(team);
  const a = join(root, "a.jsonl"),
    b = join(root, "b.jsonl");
  await writeFile(a, session(agentA));
  await writeFile(b, session(agentB));
  await writeFile(
    join(team, "config.json"),
    JSON.stringify({
      name: "trace",
      members: [
        { name: "ended", sessionFile: a },
        { name: "current", sessionFile: b, isActive: true },
      ],
    }),
  );
  const resolver = new TrafficScopeResolver(new LocalSessionRegistry(), root, [
    root,
  ]);
  const first = await resolver.resolve({
    kind: "team_trace",
    teamRef: "piteams:trace",
  });
  assert.deepEqual(
    first.sources.map((x) => [x.agentRef, x.presentation?.displayName]),
    [
      [`pi-session:${agentA}`, "ended"],
      [`pi-session:${agentB}`, "current"],
    ],
  );
  assert.deepEqual(first.limitations, {
    membershipInterval: "unavailable",
    sessionExtentMayExceedMembership: true,
  });
  await writeFile(
    join(team, "config.json"),
    JSON.stringify({
      name: "trace",
      members: [{ name: "current", sessionFile: b, isActive: true }],
    }),
  );
  const second = await resolver.resolve({
    kind: "team_trace",
    teamRef: "piteams:trace",
  });
  assert.notEqual(first.scopeRef, second.scopeRef);
  assert.deepEqual(
    second.sources.map((x) => x.agentRef),
    [`pi-session:${agentB}`],
  );
});

test("AgentListScope resolves only UUIDs from an explicit trusted Session-root adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "traffic-session-root-"));
  const file = join(root, "agent.jsonl");
  await writeFile(file, session(agentA));
  const resolver = new TrafficScopeResolver(
    new LocalSessionRegistry(),
    join(root, "no-teams"),
    [root],
  );
  const scope = await resolver.resolve({
    kind: "agents",
    agentRefs: [`pi-session:${agentA}`],
  });
  assert.equal(scope.sources[0]?.locator, file);
  assert.equal(scope.diagnostics.length, 0);
});

test("AgentListScope canonicalizes duplicates, retains typed unavailable diagnostics, and shares prepared source work", async () => {
  const root = await mkdtemp(join(tmpdir(), "traffic-scopes-"));
  const a = join(root, "a.jsonl");
  await writeFile(a, session(agentA));
  const registry = new LocalSessionRegistry();
  registry.register(agentA, a);
  const manager = new TrafficScopeManager(
    new TrafficScopeResolver(registry, join(root, "no-teams"), [root]),
    2,
  );
  const first = await manager.open({
    kind: "agents",
    agentRefs: [`pi-session:${agentA}`, `pi-session:${agentA}`],
  });
  assert.deepEqual(first.scope.selection, {
    kind: "agents",
    agentRefs: [`pi-session:${agentA}`],
  });
  const bytes = manager.sourceStore.metrics.bytes_read;
  const second = await manager.open({
    kind: "agents",
    agentRefs: [`pi-session:${agentA}`, `pi-session:${agentB}`],
  });
  assert.equal(second.scope.diagnostics[0]?.code, "agent_unavailable");
  assert.equal(
    manager.sourceStore.metrics.bytes_read,
    bytes,
    "overlap reconciles by stat without rereading source bytes",
  );
});

test("scope presentation labels a shared Session without contaminating its prepared cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "traffic-presentation-"));
  const teams = join(root, "teams");
  const file = join(root, "agent.jsonl");
  await writeFile(file, session(agentA));
  for (const [teamName, memberName] of [
    ["alpha", "alpha-worker"],
    ["beta", "beta-worker"],
  ]) {
    await mkdir(join(teams, teamName), { recursive: true });
    await writeFile(
      join(teams, teamName, "config.json"),
      JSON.stringify({
        name: teamName,
        members: [{ name: memberName, sessionFile: file }],
      }),
    );
  }
  const manager = new TrafficScopeManager(
    new TrafficScopeResolver(new LocalSessionRegistry(), teams, [root]),
    3,
  );
  const agent = (
    envelope: Awaited<ReturnType<typeof manager.open>>["envelope"],
  ) => envelope.rows.find((row) => row.row_type === "agent");
  const alpha = await manager.open({
    kind: "team_trace",
    teamRef: "piteams:alpha",
  });
  assert.equal(agent(alpha.envelope)?.display_name, "alpha-worker");
  assert.equal(alpha.envelope.report.team_name, "alpha");
  const unassociated = await manager.open({
    kind: "agents",
    agentRefs: [`pi-session:${agentA}`],
  });
  assert.equal(agent(unassociated.envelope)?.display_name, null);
  assert.equal(unassociated.envelope.report.team_name, null);
  const beta = await manager.open({
    kind: "team_trace",
    teamRef: "piteams:beta",
  });
  assert.equal(agent(beta.envelope)?.display_name, "beta-worker");
  assert.equal(beta.envelope.report.team_name, "beta");
  assert.equal(manager.sourceStore.cacheMetrics().preparedSources, 1);
});

test("TeamTraceScope rejects outside and symlink escapes without reading them, while missing in-root mappings stay unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "traffic-trusted-"));
  const sessions = join(root, "sessions");
  const teams = join(root, "teams");
  const outside = join(root, "outside.jsonl");
  await mkdir(sessions);
  await mkdir(join(teams, "trace"), { recursive: true });
  await writeFile(outside, session(agentA));
  await symlink(outside, join(sessions, "escape.jsonl"));
  await writeFile(
    join(teams, "trace", "config.json"),
    JSON.stringify({
      name: "trace",
      members: [
        { sessionFile: outside },
        { sessionFile: join(sessions, "escape.jsonl") },
        { sessionFile: join(sessions, "missing.jsonl") },
      ],
    }),
  );
  const scope = await new TrafficScopeResolver(
    new LocalSessionRegistry(),
    teams,
    [sessions],
  ).resolve({ kind: "team_trace", teamRef: "piteams:trace" });
  assert.equal(scope.sources.length, 0);
  assert.deepEqual(
    scope.diagnostics.map((diagnostic) => diagnostic.code).sort(),
    [
      "agent_unavailable",
      "source_outside_trusted_root",
      "source_outside_trusted_root",
    ],
  );
  assert.equal(
    scope.diagnostics.some((diagnostic) => diagnostic.ref.includes(root)),
    false,
  );
});

test("prepared cache bounds retained inactive sources and rehydrates an evicted wide scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "traffic-cache-"));
  const ids = [agentA, agentB, uuid("3")];
  const registry = new LocalSessionRegistry();
  for (const [index, id] of ids.entries()) {
    const file = join(root, `${index}.jsonl`);
    await writeFile(file, session(id));
    registry.register(id, file);
  }
  const manager = new TrafficScopeManager(
    new TrafficScopeResolver(registry, join(root, "teams"), [root]),
    2,
  );
  const wide = await manager.open({
    kind: "agents",
    agentRefs: ids.map((id) => `pi-session:${id}`) as [string, ...string[]],
  });
  const expectedAnalysis = wide.envelope.analysis_id;
  await manager.open({
    kind: "agents",
    agentRefs: [`pi-session:${agentA}`],
  });
  assert.equal(manager.health().sourceCache.activeScopeWorkingSet, 4);
  // Lower the process-wide retained cache through an env-independent direct eviction
  // and prove a scope's materialized view rehydrates to the same evidence result.
  manager.sourceStore.evict({ maxEntries: 1, idleMs: 0, retain: [] });
  const rehydrated = await manager.snapshot(wide.scope.scopeRef);
  assert.equal(rehydrated?.analysis_id, expectedAnalysis);
  assert.ok(manager.health().sourceCache.evictions >= 2);
});
