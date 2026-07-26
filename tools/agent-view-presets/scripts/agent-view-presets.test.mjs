import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MODE_ALL_AGENTS,
  MODE_NO_TEAMMATES,
  readMode,
  SOURCE,
} from "./lib.mjs";
import {
  applyNoTeammates,
  noTeammatesViewParams,
  readTeammatePaneProjection,
  showAllAgents,
  toggleTeammates,
} from "./views.mjs";

const roots = [];
function temporaryRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
function writeTeam(root, name, config) {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "config.json"), JSON.stringify(config));
}
function member({
  agentType = "teammate",
  isActive = true,
  backend = "herdr",
  kind = "pane",
  targetId = "w1:p2",
} = {}) {
  return {
    agentType,
    isActive,
    terminalTarget: { backend, kind, targetId },
  };
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("projects only exact active Herdr teammate pane bindings", () => {
  const root = temporaryRoot("agent-view-teams-");
  writeTeam(root, "alpha", {
    members: [
      member({ agentType: "lead", targetId: "w1:p1" }),
      member({ targetId: "w1:p2" }),
      member({ targetId: "w1:p2" }),
      member({ targetId: "w1:p3", isActive: false }),
      member({ targetId: "%4", backend: "tmux" }),
      member({ targetId: "w1:window", kind: "window" }),
      { agentType: "teammate", isActive: true, tmuxPaneId: "w1:p5" },
    ],
  });
  writeTeam(root, "beta", {
    members: [member({ targetId: "w2:p9" })],
  });

  assert.deepEqual(readTeammatePaneProjection(root), {
    paneIds: ["w1:p2", "w2:p9"],
    teamCount: 2,
    configCount: 2,
  });
});

test("missing PiTeams root is a complete empty projection", () => {
  const root = join(temporaryRoot("agent-view-missing-"), "absent");
  assert.deepEqual(readTeammatePaneProjection(root), {
    paneIds: [],
    teamCount: 0,
    configCount: 0,
  });
});

test("directories without a Team config are ignored", () => {
  const root = temporaryRoot("agent-view-residue-");
  mkdirSync(join(root, "probe-residue"));
  writeTeam(root, "alpha", { members: [member({ targetId: "w1:p2" })] });

  assert.deepEqual(readTeammatePaneProjection(root), {
    paneIds: ["w1:p2"],
    teamCount: 1,
    configCount: 1,
  });
});

test("malformed Team state refuses a partial projection", () => {
  const root = temporaryRoot("agent-view-malformed-");
  writeTeam(root, "good", { members: [member()] });
  const broken = join(root, "broken");
  mkdirSync(broken);
  writeFileSync(join(broken, "config.json"), "not json");

  assert.throws(
    () => readTeammatePaneProjection(root),
    /state is incomplete.*broken/i,
  );
});

test("no-teammates filter excludes exact panes and preserves Herdr sort policy", () => {
  assert.deepEqual(noTeammatesViewParams(["w2:p9", "w1:p2", "w1:p2"]), {
    source: SOURCE,
    label: "no teammates",
    filter: {
      op: "not",
      filter: {
        op: "in",
        field: "pane_id",
        values: ["w1:p2", "w2:p9"],
      },
    },
  });
  assert.equal("sort" in noTeammatesViewParams(["w1:p2"]), false);
  assert.deepEqual(noTeammatesViewParams([]), {
    source: SOURCE,
    label: "no teammates",
  });
});

test("apply and clear persist mode only after accepted Agent view mutations", async () => {
  const teamsRoot = temporaryRoot("agent-view-apply-teams-");
  const stateDirectory = temporaryRoot("agent-view-apply-state-");
  writeTeam(teamsRoot, "alpha", {
    members: [member({ targetId: "w4:p66" })],
  });
  const calls = [];
  const request = async (method, params) => {
    calls.push({ method, params });
    return { active: method === "agent.view.set", source: SOURCE };
  };
  const record = () => {};

  assert.equal(readMode(stateDirectory), MODE_ALL_AGENTS);
  await applyNoTeammates({
    teamsRoot,
    stateDirectory,
    request,
    record,
  });
  assert.equal(readMode(stateDirectory), MODE_NO_TEAMMATES);
  await showAllAgents({ stateDirectory, request, record });
  assert.equal(readMode(stateDirectory), MODE_ALL_AGENTS);
  assert.deepEqual(
    calls.map(({ method }) => method),
    ["agent.view.set", "agent.view.clear"],
  );
  assert.equal("sort" in calls[0].params, false);
  assert.deepEqual(calls[1].params, { source: SOURCE });
});

test("toggle uses the persisted mode to hide then restore teammates", async () => {
  const teamsRoot = temporaryRoot("agent-view-toggle-teams-");
  const stateDirectory = temporaryRoot("agent-view-toggle-state-");
  writeTeam(teamsRoot, "alpha", { members: [member()] });
  const methods = [];
  const options = {
    teamsRoot,
    stateDirectory,
    request: async (method) => {
      methods.push(method);
      return { active: method === "agent.view.set" };
    },
    record: () => {},
  };

  await toggleTeammates(options);
  assert.equal(readMode(stateDirectory), MODE_NO_TEAMMATES);
  await toggleTeammates(options);
  assert.equal(readMode(stateDirectory), MODE_ALL_AGENTS);
  assert.deepEqual(methods, ["agent.view.set", "agent.view.clear"]);
});

test("failed Agent view set does not persist no-teammates mode", async () => {
  const teamsRoot = temporaryRoot("agent-view-fail-teams-");
  const stateDirectory = temporaryRoot("agent-view-fail-state-");
  writeTeam(teamsRoot, "alpha", { members: [member()] });

  await assert.rejects(
    applyNoTeammates({
      teamsRoot,
      stateDirectory,
      request: async () => {
        throw new Error("rejected");
      },
      record: () => {},
    }),
    /rejected/,
  );
  assert.equal(readMode(stateDirectory), MODE_ALL_AGENTS);
});
