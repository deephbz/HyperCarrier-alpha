export type MatrixEvidence = {
  class: string;
  basis: string;
  confidence?: number;
  unavailableReason?: string;
};

export type MatrixMark = {
  eventRef: string;
  rowType:
    | "turn"
    | "request_interval"
    | "tool_observation_span"
    | "quiet_gap"
    | "global_quiet_gap";
  agentRef: string | null;
  label: string;
  startMs: number;
  endMs: number | null;
  precision: "point" | "exact" | "inferred";
  evidence: MatrixEvidence;
  provenanceRefs: string[];
  qualification: string | null;
  display: {
    kind:
      | "user_request"
      | "user_alert"
      | "agent_continuation"
      | "agent_stop"
      | "agent_truncated"
      | "agent_response_unavailable"
      | "tool_observation"
      | "quiet_gap";
    glyph:
      | "boundary"
      | "continuation"
      | "stop"
      | "truncated_warning"
      | "unavailable"
      | "span"
      | "gap";
    alert: "truncated_response" | null;
    evidence: MatrixEvidence;
  };
};

export type MatrixWireProjection = {
  schemaVersion: "traffic-matrix-v1";
  snapshot: {
    id: string;
    preparedDerivationId: string;
    analysisId: string;
    report: {
      teamName: string | null;
      leaderSessionName: string | null;
      leaderSessionId: string | null;
      coverage: { startMs: number | null; endMs: number | null };
    };
    inputs: Array<{ sourceId: string; sha256: string }>;
    parameters: {
      initialWindow: { startMs: number; endMs: number };
      returnedWindow: { startMs: number; endMs: number };
      detail: "marks" | "summary";
      rowBudget: number;
    };
    replay: string;
    inspectorAvailability?: { scope: string; staleReason: string | null };
  };
  coverage: {
    startMs: number | null;
    endMs: number | null;
    freshness: string;
    initialWindow: { startMs: number; endMs: number };
    currentWindow: { startMs: number; endMs: number };
    rowBudget: number;
    detail: "marks" | "summary";
  };
  columns: Array<{
    agentRef: string;
    sessionTraceId: string;
    header: { label: string; evidence: MatrixEvidence };
    role: { state: string };
    membership: { state: string };
    inspectionCue: {
      latestObservedEventRef: string | null;
      latestObservedAtMs: number | null;
      priority: "unassessed";
      intervention: "unassessed";
    };
  }>;
  marks: MatrixMark[];
  diagnostics: Array<{ code: string; evidence: MatrixEvidence }>;
};

export type MatrixWireInspector = MatrixMark & {
  snapshotId: string;
  preparedDerivationId: string;
  analysisId: string;
  safeMetrics: Record<string, number | string | null>;
};

/** A bounded ordinal skeleton: no timestamps and no disclosure body cross this endpoint. */
export type OrdinalWireProjection = {
  schemaVersion: "traffic-ordinal-v2";
  snapshot: {
    id: string;
    analysisId: string;
    preparedDerivationId: string;
    disclosureAvailability: { scope: string; staleReason: string };
  };
  columns: Array<{ agentRef: string; sessionTraceId: string; label: string }>;
  ordering: { basis: string; equalTimestamp: string; adjacency: string };
  rows: Array<{
    globalOrdinal: number;
    cells: Array<{
      eventRef: string;
      ownerAgentRef: string | null;
      label: string;
      display: Pick<MatrixMark["display"], "kind" | "glyph">;
      globalOrdinal: number;
      agentLocalOrdinal: number | null;
      disclosureRef: string;
    }>;
  }>;
};

export type OrdinalDisclosure = {
  sourceRef: { sourceId: string; turnId: string; turnOrdinal: number | null };
  approvedExcerpt: { reference: string; text: string } | null;
  compactSummary: {
    requestCount: number;
    toolCount: number;
    totalTokens: number;
    estimatedCostUsd: number | null;
    outcome: string | null;
  };
  requests: Array<{
    sourceRef: {
      sourceId: string;
      requestId: string;
      requestOrdinal: number | null;
    };
    provider: string | null;
    model: string | null;
    api: string | null;
    outcome: string | null;
    content: Array<{ type: string; retention: string }>;
    toolEvents: Array<{ kind: string; status: string }>;
  }>;
};

export type OrdinalDisclosureWireProjection = {
  schemaVersion: "traffic-ordinal-disclosure-v1";
  snapshotId: string;
  disclosureRef: string;
  eventRef: string;
  disclosure: OrdinalDisclosure | null;
};

export const isOrdinalProjection = (
  value: unknown,
): value is OrdinalWireProjection =>
  !!value &&
  typeof value === "object" &&
  (value as { schemaVersion?: unknown }).schemaVersion ===
    "traffic-ordinal-v2" &&
  Array.isArray((value as { rows?: unknown }).rows);

export const isOrdinalDisclosureProjection = (
  value: unknown,
): value is OrdinalDisclosureWireProjection =>
  !!value &&
  typeof value === "object" &&
  (value as { schemaVersion?: unknown }).schemaVersion ===
    "traffic-ordinal-disclosure-v1";

export const isMatrixProjection = (
  value: unknown,
): value is MatrixWireProjection =>
  !!value &&
  typeof value === "object" &&
  (value as { schemaVersion?: unknown }).schemaVersion ===
    "traffic-matrix-v1" &&
  Array.isArray((value as { columns?: unknown }).columns) &&
  Array.isArray((value as { marks?: unknown }).marks);

export const formatUtc = (ms: number | null | undefined) =>
  ms == null
    ? "Unavailable"
    : new Date(ms).toISOString().replace("T", " ").replace(".000Z", " UTC");
