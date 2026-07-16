import type {
  MatrixMark,
  MatrixWireInspector,
  MatrixWireProjection,
  OrdinalWireProjection,
} from "./matrixTypes";

const start = Date.UTC(2026, 6, 14, 9, 0);
const end = start + 3_600_000;
const agents = ["a1", "a2", "a3"];
const marks: MatrixMark[] = Array.from({ length: 42 }, (_, index) => ({
  eventRef: `fixture:mark:${index}`,
  rowType:
    index % 4 === 0
      ? "tool_observation_span"
      : index % 3 === 0
        ? "turn"
        : "request_interval",
  agentRef: agents[index % agents.length]!,
  label:
    index % 4 === 0
      ? "Tool available to result recorded — not runtime"
      : index % 3 === 0
        ? "User request"
        : "Agent response recorded",
  startMs: start + index * 80_000,
  endMs: start + index * 80_000 + (index % 3 ? 28_000 : 0),
  precision: index % 3 ? "exact" : "point",
  evidence: { class: "observed", basis: "fixture" },
  provenanceRefs: [`fixture:${index}`],
  qualification: index % 4 === 0 ? "not_tool_runtime" : null,
  display:
    index % 4 === 0
      ? {
          kind: "tool_observation",
          glyph: "span",
          alert: null,
          evidence: { class: "observed", basis: "fixture" },
        }
      : index % 3 === 0
        ? {
            kind: "user_request",
            glyph: "boundary",
            alert: null,
            evidence: { class: "observed", basis: "fixture" },
          }
        : {
            kind: "agent_continuation",
            glyph: "continuation",
            alert: null,
            evidence: { class: "observed", basis: "fixture" },
          },
}));

// This pair is intentionally same-Agent and temporally overlapping. It is the
// prepared fixture proof that B-zone request/tool inspection stays disambiguated.
marks.push(
  {
    eventRef: "fixture:overlap:request",
    rowType: "request_interval",
    agentRef: "a1",
    label: "Agent-continuation",
    startMs: start + 480_000,
    endMs: start + 540_000,
    precision: "exact",
    evidence: { class: "observed", basis: "fixture same-Agent overlap" },
    provenanceRefs: ["fixture:overlap:request"],
    qualification: null,
    display: {
      kind: "agent_continuation",
      glyph: "continuation",
      alert: null,
      evidence: { class: "observed", basis: "fixture same-Agent overlap" },
    },
  },
  {
    eventRef: "fixture:overlap:tool",
    rowType: "tool_observation_span",
    agentRef: "a1",
    label: "Tool available to result recorded — not runtime",
    startMs: start + 500_000,
    endMs: start + 530_000,
    precision: "exact",
    evidence: { class: "observed", basis: "fixture same-Agent overlap" },
    provenanceRefs: ["fixture:overlap:tool"],
    qualification: "not_tool_runtime",
    display: {
      kind: "tool_observation",
      glyph: "span",
      alert: null,
      evidence: { class: "observed", basis: "fixture same-Agent overlap" },
    },
  },
);

/** A retained, checked-in projection, deliberately separate from live API snapshots. */
export const matrixFixture: MatrixWireProjection = {
  schemaVersion: "traffic-matrix-v1",
  snapshot: {
    id: "fixture-snapshot",
    preparedDerivationId: "fixture-prepared",
    analysisId: "fixture-analysis",
    report: {
      teamName: null,
      leaderSessionName: null,
      leaderSessionId: null,
      coverage: { startMs: start, endMs: end },
    },
    inputs: [{ sourceId: "fixture", sha256: "fixture" }],
    parameters: {
      initialWindow: { startMs: start, endMs: end },
      returnedWindow: { startMs: start, endMs: end },
      detail: "marks",
      rowBudget: 600,
    },
    replay: "unavailable",
    inspectorAvailability: {
      scope: "retained_checked_in_fixture",
      staleReason: null,
    },
  },
  coverage: {
    startMs: start,
    endMs: end,
    freshness: "fixture",
    initialWindow: { startMs: start, endMs: end },
    currentWindow: { startMs: start, endMs: end },
    rowBudget: 600,
    detail: "marks",
  },
  columns: agents.map((agent, index) => ({
    agentRef: agent,
    sessionTraceId: `fixture-session-${index + 1}`,
    header: {
      label:
        index === 2 ? "Unnamed agent · fixture-sess" : `Agent ${index + 1}`,
      evidence: { class: "observed", basis: "fixture" },
    },
    role: { state: "unavailable" },
    membership: { state: "unavailable" },
    inspectionCue: {
      latestObservedEventRef:
        marks.filter((mark) => mark.agentRef === agent).at(-1)?.eventRef ??
        null,
      latestObservedAtMs:
        marks.filter((mark) => mark.agentRef === agent).at(-1)?.startMs ?? null,
      priority: "unassessed",
      intervention: "unassessed",
    },
  })),
  marks,
  diagnostics: [],
};

/** Fixture inspection uses the same snapshot/event-ref scope as the live endpoint. */
export const fixtureInspector = (
  snapshotId: string,
  eventRef: string,
): MatrixWireInspector | null => {
  if (snapshotId !== matrixFixture.snapshot.id) return null;
  const mark = matrixFixture.marks.find((item) => item.eventRef === eventRef);
  if (!mark) return null;
  return {
    ...mark,
    snapshotId,
    preparedDerivationId: matrixFixture.snapshot.preparedDerivationId,
    analysisId: matrixFixture.snapshot.analysisId,
    safeMetrics: {},
  };
};

/** Checked-in skeleton mirrors the live ordinal contract without embedding disclosure bodies. */
export const ordinalFixture: OrdinalWireProjection = {
  schemaVersion: "traffic-ordinal-v2",
  snapshot: {
    id: "fixture-ordinal-snapshot",
    analysisId: "fixture-analysis",
    preparedDerivationId: "fixture-prepared",
    disclosureAvailability: {
      scope: "issued_ordinal_snapshot_only",
      staleReason: "analysis_rotated_or_process_restarted",
    },
  },
  columns: matrixFixture.columns.map((column) => ({
    agentRef: column.agentRef,
    sessionTraceId: column.sessionTraceId,
    label: column.header.label,
  })),
  ordering: {
    basis: "fixture ordinal",
    equalTimestamp: "fixture event reference",
    adjacency: "not_elapsed_duration_or_causality",
  },
  rows: marks.map((mark, globalOrdinal) => ({
    globalOrdinal,
    cells: [
      {
        eventRef: mark.eventRef,
        ownerAgentRef: mark.agentRef,
        label: mark.label,
        display: { kind: mark.display.kind, glyph: mark.display.glyph },
        globalOrdinal,
        agentLocalOrdinal: marks
          .slice(0, globalOrdinal)
          .filter((candidate) => candidate.agentRef === mark.agentRef).length,
        disclosureRef: mark.eventRef,
      },
    ],
  })),
};
