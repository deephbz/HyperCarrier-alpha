import { createHash } from "node:crypto";
import { readObservationSnapshot } from "@hypercarrier/pi-team-bright/observation";
import {
  SOURCE,
  appendReceipt,
  cleanToken,
  listAgents,
  reportSequence,
  runHerdr,
} from "./lib.mjs";

export const TOKEN_NAMES = [
  "pi_team_lead",
  "pi_team_worker",
  "pi_team_binding",
];
const LEGACY_TOKEN_NAMES = ["pi_team_name"];

function exactPiSession(agent) {
  const session = agent?.agent_session;
  return agent?.agent === "pi" &&
    session?.agent === "pi" &&
    session?.kind === "path" &&
    typeof session.value === "string" &&
    session.value.length > 0
    ? session.value
    : null;
}

function exactCandidates(snapshot) {
  return snapshot.teams
    .flatMap((team) => team.memberships)
    .filter(
      (member) =>
        member.terminalTarget?.backend === "herdr" &&
        member.terminalTarget?.kind === "pane" &&
        typeof member.terminalTarget.targetId === "string" &&
        member.terminalTarget.targetId.length > 0 &&
        member.session?.kind === "pi-jsonl-path" &&
        typeof member.session.locator === "string" &&
        member.session.locator.length > 0,
    );
}

function bindingToken(paneId, session) {
  return createHash("sha256")
    .update(`${paneId}\0${session}`)
    .digest("base64url")
    .slice(0, 24);
}

export function projectHierarchy(snapshot, agents) {
  const candidates = exactCandidates(snapshot);
  return agents.flatMap((agent) => {
    if (typeof agent?.pane_id !== "string" || !agent.pane_id) return [];
    const session = exactPiSession(agent);
    const priorBinding = agent.tokens?.pi_team_binding;
    if (!session) {
      // Detection can temporarily lose Session evidence. Preserve display until
      // an ended Membership or a new exact pane-and-Session binding proves change.
      return [{ paneId: agent.pane_id, kind: "unsupported" }];
    }
    const exact = candidates.filter(
      (member) =>
        member.terminalTarget.targetId === agent.pane_id &&
        member.session.locator === session,
    );
    const matches = exact.filter((member) => member.lifecycle?.state === "current");
    if (matches.length !== 1) {
      const currentBinding = bindingToken(agent.pane_id, session);
      return [{
        paneId: agent.pane_id,
        kind: matches.length > 1
          ? "ambiguous"
          : exact.some((member) => member.lifecycle?.state === "ended")
            ? "ended"
            : priorBinding && priorBinding !== currentBinding
              ? "replaced"
              : "unmatched",
        matchCount: matches.length,
      }];
    }
    const member = matches[0];
    const memberName = cleanToken(member.memberName, 78);
    if (!memberName) {
      return [{ paneId: agent.pane_id, kind: "invalid" }];
    }
    return [{
      paneId: agent.pane_id,
      kind: "matched",
      memberName,
      role: member.coordinationRole,
      tokens: {
        pi_team_lead: member.coordinationRole === "lead" ? memberName : null,
        pi_team_worker:
          member.coordinationRole === "teammate" ? `↳ ${memberName}` : null,
        pi_team_binding: bindingToken(agent.pane_id, session),
      },
    }];
  });
}

export function metadataArgs(projection, sequence, { clear = false } = {}) {
  const args = [
    "pane",
    "report-metadata",
    projection.paneId,
    "--source",
    SOURCE,
    "--seq",
    String(sequence),
  ];
  for (const token of TOKEN_NAMES) {
    const value = !clear && projection.tokens?.[token];
    args.push(value ? "--token" : "--clear-token", value ? `${token}=${value}` : token);
  }
  for (const token of LEGACY_TOKEN_NAMES) args.push("--clear-token", token);
  return args;
}

export function reportProjection(projection, sequence, run = runHerdr) {
  return run(metadataArgs(projection, sequence));
}

export function clearProjection(projection, sequence, run = runHerdr) {
  return run(metadataArgs(projection, sequence, { clear: true }));
}

export async function reconcileHierarchy({
  readObservation = readObservationSnapshot,
  agents = listAgents,
  run = runHerdr,
  record = appendReceipt,
  sequence = reportSequence(),
  reason = "manual",
  targetPaneId,
} = {}) {
  const snapshot = await readObservation({ deadlineMs: 1000 });
  const allLiveAgents = agents();
  const liveAgents = targetPaneId
    ? allLiveAgents.filter((agent) => agent?.pane_id === targetPaneId)
    : allLiveAgents;
  const projection = projectHierarchy(snapshot, liveAgents);
  let published = 0;
  let cleared = 0;

  for (const item of projection) {
    if (snapshot.availability !== "unavailable" && item.kind === "matched") {
      reportProjection(item, sequence, run);
      published += 1;
    } else if (
      item.kind === "replaced" ||
      (snapshot.availability !== "unavailable" && item.kind === "ended") ||
      (snapshot.availability === "available" && !["ambiguous", "matched"].includes(item.kind))
    ) {
      clearProjection(item, sequence, run);
      cleared += 1;
    }
  }

  const result = {
    availability: snapshot.availability,
    observedTeamCount: snapshot.teams.length,
    liveAgentCount: allLiveAgents.length,
    consideredAgentCount: liveAgents.length,
    published,
    cleared,
    ambiguous: projection.filter((item) => item.kind === "ambiguous").length,
    matches: projection
      .filter((item) => item.kind === "matched")
      .map((item) => ({ paneId: item.paneId, role: item.role })),
  };
  record("hierarchy_reconciled", { reason, ...result });
  return result;
}

export function clearAllHierarchy({
  agents = listAgents,
  run = runHerdr,
  record = appendReceipt,
  sequence = reportSequence(),
  reason = "manual",
} = {}) {
  const liveAgents = agents();
  let cleared = 0;
  for (const agent of liveAgents) {
    if (typeof agent?.pane_id !== "string" || !agent.pane_id) continue;
    clearProjection({ paneId: agent.pane_id }, sequence, run);
    cleared += 1;
  }
  const result = { liveAgentCount: liveAgents.length, cleared };
  record("hierarchy_cleared", { reason, ...result });
  return result;
}
