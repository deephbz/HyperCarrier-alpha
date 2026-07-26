import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readPiTeams } from "../pi-teams.js";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "pi-teams-observation-v1.json",
);
const fixture = () => JSON.parse(readFileSync(fixturePath, "utf8"));

test("PiTeams observation fixture preserves episodes and exact recorded evidence", async () => {
  let received;
  const controller = new AbortController();
  const result = await readPiTeams({
    root: "/ignored/teams",
    deadlineMs: 37,
    signal: controller.signal,
    readObservationSnapshot: async (options) => {
      received = options;
      return fixture();
    },
  });

  assert.equal(received.teamsRoot, "/ignored/teams");
  assert.equal(received.deadlineMs, 37);
  assert.equal(received.signal, controller.signal);
  assert.deepEqual(result.teams, [
    {
      name: "example",
      source: "pi-teams-observation/1:fixture",
      memberCount: 4,
    },
  ]);
  assert.equal(result.memberships.length, 4);

  const lead = result.memberships.find((entry) => entry.membershipId === "lead-current");
  assert.equal(lead.isActive, true);
  assert.equal(lead.pid, 100);
  assert.equal(lead.runtimeStartedAt, "2024-01-01T00:00:01.000Z");
  assert.equal(lead.sessionFile, "/sessions/shared.jsonl");
  assert.deepEqual(lead.terminalTarget, { backend: "tmux", kind: "pane", id: "%1" });

  const ended = result.memberships.find((entry) => entry.membershipId === "worker-ended");
  assert.equal(ended.isActive, false);
  assert.equal(ended.pid, undefined);
  assert.equal(ended.sessionFile, "/sessions/worker.jsonl");

  const invalid = result.memberships.find((entry) => entry.membershipId === "worker-invalid");
  assert.equal(invalid.isActive, true);
  assert.equal(invalid.pid, undefined);
  assert.equal(invalid.ready, undefined);
  assert.equal(
    result.rejected.some(
      (entry) =>
        entry.reason === "runtime_generation_mismatch" &&
        entry.scope === "membership" &&
        entry.agentName === "broken" &&
        !("membershipId" in entry),
    ),
    true,
  );
  assert.deepEqual(result.observation, {
    schema: "pi-teams-observation/1",
    producerVersion: "fixture",
    availability: "partial",
    issueCount: 1,
    generatedAt: "2024-01-01T00:00:00.000Z",
  });
});

test("PiTeams observation keeps completed Teams on partial snapshot stop", async () => {
  const snapshot = fixture();
  snapshot.issues.push({ code: "projection_deadline_exceeded", scope: "snapshot" });
  const result = await readPiTeams({ readObservationSnapshot: async () => snapshot });

  assert.equal(result.teams.length, 1);
  assert.equal(result.memberships.length, 4);
  assert.equal(result.observation.availability, "partial");
  assert.equal(
    result.rejected.some(
      (entry) => entry.reason === "projection_deadline_exceeded" && entry.scope === "snapshot",
    ),
    true,
  );
});

test("PiTeams observation fails open for missing or incompatible providers", async () => {
  const missing = await readPiTeams({
    readObservationSnapshot: async () => {
      throw new Error("SECRET PROVIDER FAILURE");
    },
  });
  assert.deepEqual(missing.teams, []);
  assert.equal(missing.observation.availability, "unavailable");
  assert.equal(missing.rejected[0].reason, "provider_unavailable");
  assert.equal(JSON.stringify(missing).includes("SECRET"), false);

  const incompatible = await readPiTeams({
    readObservationSnapshot: async () => ({ ...fixture(), schema: "pi-teams-observation/2" }),
  });
  assert.equal(incompatible.observation.availability, "unavailable");
  assert.equal(incompatible.rejected[0].reason, "unsupported_observation_schema");
});
