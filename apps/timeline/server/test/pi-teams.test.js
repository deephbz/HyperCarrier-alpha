import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readPiTeams } from "../pi-teams.js";

test("Pi Teams parser projects metadata only and validates live PID evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-teams-"));
  const team = join(root, "alpha");
  mkdirSync(join(team, "runtime"), { recursive: true });
  writeFileSync(
    join(team, "config.json"),
    JSON.stringify({
      name: "alpha",
      description: "SECRET TEAM PROMPT",
      createdAt: 1,
      members: [
        {
          name: "team-lead",
          agentType: "lead",
          cwd: "/repo",
          tmuxPaneId: "%1",
          prompt: "SECRET MEMBER PROMPT",
        },
        {
          name: "builder",
          agentType: "teammate",
          cwd: "/repo",
          tmuxPaneId: "%2",
          model: "safe-model",
          prompt: "SECRET MEMBER PROMPT",
        },
      ],
    }),
  );
  writeFileSync(join(team, "lead-session.json"), JSON.stringify({ pid: 100 }));
  writeFileSync(join(team, "builder.pid"), "120\n");
  writeFileSync(
    join(team, "runtime", "builder.json"),
    JSON.stringify({
      teamName: "alpha",
      agentName: "builder",
      ready: true,
      lastHeartbeatAt: 10,
      lastError: { message: "SECRET RUNTIME ERROR" },
    }),
  );

  const result = readPiTeams({ root, livePids: new Set([120]) });
  assert.equal(result.teams[0].name, "alpha");
  assert.equal(result.memberships.find((item) => item.agentName === "team-lead").pid, undefined);
  const builder = result.memberships.find((item) => item.agentName === "builder");
  assert.equal(builder.pid, 120);
  assert.equal(builder.ready, true);
  assert.equal(builder.configuredTerminalId, "%2");
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
});

test("Pi Teams parser diagnoses malformed configs without raw errors", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-teams-bad-"));
  mkdirSync(join(root, "broken"));
  writeFileSync(join(root, "broken", "config.json"), "{");
  const result = readPiTeams({ root, livePids: new Set() });
  assert.deepEqual(
    result.rejected.map((item) => item.reason),
    ["invalid_team_config"],
  );
});
