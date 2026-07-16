import { createHash } from "node:crypto";
import type {
  Aggregate,
  AnalysisEnvelope,
  AnalysisRow,
  Evidence,
  Provenance,
} from "../domain/contracts.js";

export const MATRIX_SCHEMA_VERSION = "traffic-matrix-v1";
export const ORDINAL_SCHEMA_VERSION = "traffic-ordinal-v2";
export const ORDINAL_DISCLOSURE_SCHEMA_VERSION =
  "traffic-ordinal-disclosure-v1";
export const SECONDARY_SCHEMA_VERSION = "traffic-secondary-v1";
const DEFAULT_ROW_BUDGET = 600;
const MARK_TYPES = new Set([
  "turn",
  "request_interval",
  "tool_observation_span",
  "quiet_gap",
  "global_quiet_gap",
]);
type Detail = "marks" | "summary";
type Window = { start_ms: number; end_ms: number };

export type MatrixProjection = {
  schema_version: typeof MATRIX_SCHEMA_VERSION;
  snapshot: {
    id: string;
    prepared_derivation_id: string;
    analysis_id: string;
    /**
     * Privacy-safe identity prepared by the analysis authority for the matrix's
     * first paint. This is intentionally a narrow report projection: the shell
     * receives no source records, raw payloads, or provenance locations.
     */
    report: {
      team_name: string | null;
      leader_session_name: string | null;
      leader_session_id: string | null;
      coverage: { start_ms: number | null; end_ms: number | null };
    };
    inputs: Array<{ source_id: string; sha256: string }>;
    parameters: {
      initial_window: Window;
      returned_window: Window;
      detail: Detail;
      row_budget: number;
    };
    replay: "rebuild_if_inputs_available";
    inspector_availability: {
      scope: "current_analysis_process_only";
      stale_reason: "analysis_rotated_or_process_restarted";
    };
  };
  coverage: {
    start_ms: number | null;
    end_ms: number | null;
    freshness: "observed_snapshot";
  };
  columns: MatrixColumn[];
  marks: MatrixMark[];
  diagnostics: Array<{ code: string; evidence: Evidence }>;
};
export type MatrixColumn = {
  agent_ref: string;
  session_trace_ref: string;
  display_name: string;
  display_name_evidence: Evidence;
  role: { state: "unavailable" };
  membership: { state: "unavailable" };
  inspection_cue: {
    latest_observed_event_ref: string | null;
    latest_observed_at_ms: number | null;
    priority: "unassessed";
    intervention: "unassessed";
  };
};
export type MatrixMark = {
  event_ref: string;
  row_type:
    | "turn"
    | "request_interval"
    | "tool_observation_span"
    | "quiet_gap"
    | "global_quiet_gap";
  agent_ref: string | null;
  label: string;
  start_ms: number;
  end_ms: number | null;
  precision: "point" | "exact" | "inferred";
  evidence: Evidence;
  provenance_refs: string[];
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
    evidence: Evidence;
  };
};
export type MatrixInspector = MatrixMark & {
  snapshot_id: string;
  prepared_derivation_id: string;
  analysis_id: string;
  safe_metrics: Record<string, number | string | null>;
};

const field = <T>(row: AnalysisRow, key: string) => row[key] as T | undefined;
const timeFor = (row: AnalysisRow) =>
  field<number>(row, "timestamp_ms") ??
  field<number>(row, "assistant_request_start_ms") ??
  field<number>(row, "start_ms") ??
  null;
const endFor = (row: AnalysisRow) =>
  field<number>(row, "assistant_response_recorded_ms") ??
  field<number>(row, "end_ms") ??
  null;
const labelFor = (row: AnalysisRow) => {
  if (row.row_type === "turn")
    return field<string>(row, "classifier") === "user_alert"
      ? "User-alert"
      : "User-request";
  if (row.row_type === "request_interval") {
    const outcome = field<string>(row, "outcome");
    return outcome === "continuation"
      ? "Agent-continuation"
      : outcome === "stop"
        ? "Agent-stop"
        : outcome === "truncated"
          ? "Agent-truncated"
          : "Agent-response unavailable";
  }
  if (row.row_type === "tool_observation_span")
    return "Tool available to result recorded — not runtime";
  return row.row_type === "global_quiet_gap"
    ? "Global quiet interval"
    : "Quiet after stop";
};
const displayFor = (row: AnalysisRow): MatrixMark["display"] => {
  if (row.row_type === "turn") {
    const alert = field<string>(row, "classifier") === "user_alert";
    return {
      kind: alert ? "user_alert" : "user_request",
      glyph: "boundary",
      alert: null,
      evidence: row.evidence,
    };
  }
  if (row.row_type === "request_interval") {
    const outcome = field<string>(row, "outcome");
    const truncated = outcome === "truncated";
    return {
      kind: truncated
        ? "agent_truncated"
        : outcome === "stop"
          ? "agent_stop"
          : outcome === "continuation"
            ? "agent_continuation"
            : "agent_response_unavailable",
      glyph: truncated
        ? "truncated_warning"
        : outcome === "continuation"
          ? "continuation"
          : outcome === "stop"
            ? "stop"
            : "unavailable",
      alert: truncated ? "truncated_response" : null,
      evidence: row.evidence,
    };
  }
  return {
    kind:
      row.row_type === "tool_observation_span"
        ? "tool_observation"
        : "quiet_gap",
    glyph: row.row_type === "tool_observation_span" ? "span" : "gap",
    alert: null,
    evidence: row.evidence,
  };
};
const precisionFor = (row: AnalysisRow): MatrixMark["precision"] =>
  row.row_type === "turn"
    ? "point"
    : row.row_type === "quiet_gap"
      ? "inferred"
      : "exact";
const snapshotId = (
  data: AnalysisEnvelope,
  window: Window,
  detail: Detail,
  rowBudget: number,
) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        schema: MATRIX_SCHEMA_VERSION,
        prepared: data.prepared_derivation_id,
        analysis: data.analysis_id,
        window,
        detail,
        rowBudget,
        inputs: data.provenance.source_artifacts.map((x) => [
          x.source_id,
          x.sha256,
        ]),
      }),
    )
    .digest("hex");

function requestedWindow(
  data: AnalysisEnvelope,
  requested: Partial<Window>,
): Window {
  const start = requested.start_ms ?? data.report.coverage.start_ms ?? 0;
  const end = requested.end_ms ?? data.report.coverage.end_ms ?? start;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    throw Error("invalid_window");
  return { start_ms: start, end_ms: end };
}

export function matrixProjection(
  data: AnalysisEnvelope,
  options: {
    start_ms?: number;
    end_ms?: number;
    detail?: Detail;
    row_budget?: number;
  } = {},
): MatrixProjection {
  const detail = options.detail ?? "marks";
  const rowBudget = Math.min(
    5_000,
    Math.max(1, options.row_budget ?? DEFAULT_ROW_BUDGET),
  );
  const window = requestedWindow(data, options);
  const candidates = data.rows
    .filter(
      (row) =>
        MARK_TYPES.has(row.row_type) &&
        (() => {
          const start = timeFor(row);
          if (start === null) return false;
          // Points must occur in the window; intervals intersect it. This keeps
          // in-flight requests, tools, and gaps visible after a zoom.
          const end = endFor(row) ?? start;
          return start <= window.end_ms && end >= window.start_ms;
        })(),
    )
    .sort(
      (a, b) =>
        (timeFor(a) ?? Infinity) - (timeFor(b) ?? Infinity) ||
        a.row_id.localeCompare(b.row_id),
    );
  // Compression metadata is authoritative layout evidence, so retain global
  // intersections before applying the display-mark LOD budget. Local quiet gaps
  // remain ordinary agent marks and receive no such preference.
  const globalQuiet = candidates.filter(
    (row) => row.row_type === "global_quiet_gap",
  );
  const visible =
    detail === "summary" || candidates.length > rowBudget
      ? [
          ...globalQuiet,
          ...candidates
            .filter((row) => row.row_type !== "global_quiet_gap")
            .slice(-Math.max(0, rowBudget - globalQuiet.length)),
        ]
      : candidates;
  const marks = visible.flatMap((row): MatrixMark[] => {
    const start = timeFor(row);
    if (start === null) return [];
    return [
      {
        event_ref: row.row_id,
        row_type: row.row_type as MatrixMark["row_type"],
        agent_ref: row.agent_id,
        label: labelFor(row),
        start_ms: start,
        end_ms: endFor(row),
        precision: precisionFor(row),
        evidence: row.evidence,
        provenance_refs:
          row.provenance_refs.length > 0 ? row.provenance_refs : [row.row_id],
        display: displayFor(row),
        qualification:
          (row.row_type === "tool_observation_span"
            ? field<string>(row, "interpretation")
            : undefined) ??
          field<string>(row, "qualification") ??
          field<string>(row, "pairing_state") ??
          field<string>(row, "interpretation") ??
          null,
      },
    ];
  });
  const latest = new Map<string, MatrixMark>();
  for (const mark of marks)
    if (
      mark.agent_ref &&
      (!latest.get(mark.agent_ref) ||
        latest.get(mark.agent_ref)!.start_ms <= mark.start_ms)
    )
      latest.set(mark.agent_ref, mark);
  const columns = data.rows
    .filter((row) => row.row_type === "agent")
    .map((row): MatrixColumn => ({
      agent_ref: row.agent_id!,
      session_trace_ref: field<string>(row, "session_trace_id")!,
      display_name:
        field<string>(row, "display_name") ??
        `Unnamed agent · ${field<string>(row, "session_trace_id")!.slice(0, 12)}`,
      display_name_evidence:
        field<Evidence>(row, "display_name_evidence") ?? row.evidence,
      role: { state: "unavailable" },
      membership: { state: "unavailable" },
      inspection_cue: {
        latest_observed_event_ref: latest.get(row.agent_id!)?.event_ref ?? null,
        latest_observed_at_ms: latest.get(row.agent_id!)?.start_ms ?? null,
        priority: "unassessed",
        intervention: "unassessed",
      },
    }));
  return {
    schema_version: MATRIX_SCHEMA_VERSION,
    snapshot: {
      id: snapshotId(data, window, detail, rowBudget),
      prepared_derivation_id: data.prepared_derivation_id,
      analysis_id: data.analysis_id,
      report: {
        team_name: data.report.team_name,
        leader_session_name: data.report.leader_session_name,
        leader_session_id: data.report.leader_session_id,
        coverage: { ...data.report.coverage },
      },
      inputs: data.provenance.source_artifacts.map((x) => ({
        source_id: x.source_id,
        sha256: x.sha256,
      })),
      parameters: {
        initial_window: requestedWindow(data, {}),
        returned_window: window,
        detail,
        row_budget: rowBudget,
      },
      replay: "rebuild_if_inputs_available",
      inspector_availability: {
        scope: "current_analysis_process_only",
        stale_reason: "analysis_rotated_or_process_restarted",
      },
    },
    coverage: { ...data.report.coverage, freshness: "observed_snapshot" },
    columns,
    marks,
    diagnostics: data.diagnostics.map((x) => ({
      code: x.code,
      evidence: x.evidence,
    })),
  };
}

export function matrixInspector(
  data: AnalysisEnvelope,
  snapshot_id: string,
  event_ref: string,
  options: Parameters<typeof matrixProjection>[1] = {},
): MatrixInspector | undefined {
  const projection = matrixProjection(data, options);
  if (projection.snapshot.id !== snapshot_id) throw Error("stale_snapshot");
  const mark = projection.marks.find((x) => x.event_ref === event_ref);
  if (!mark) return undefined;
  const row = data.rows.find((x) => x.row_id === event_ref)!;
  return {
    ...mark,
    snapshot_id,
    prepared_derivation_id: data.prepared_derivation_id,
    analysis_id: data.analysis_id,
    safe_metrics: {
      observed_elapsed_ms: field<number>(row, "observed_elapsed_ms") ?? null,
      observed_span_ms: field<number>(row, "observed_span_ms") ?? null,
      outcome: field<string>(row, "outcome") ?? null,
    },
  };
}

const camel = (value: unknown): any => {
  if (Array.isArray(value)) return value.map(camel);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()),
      camel(child),
    ]),
  );
};

/**
 * Stable public provenance for normal HTTP projections. Adapter provenance is
 * intentionally richer and may contain local evidence locators or future
 * implementation details, so the wire contract is constructed field-by-field
 * instead of forwarding or subtractively redacting the adapter object.
 */
const wireProvenance = (provenance: Provenance) => ({
  sourceIds: [...provenance.source_ids],
  parserVersion: provenance.parser_version,
  contentPolicy: provenance.content_policy,
  classifier: {
    id: provenance.classifier.id,
    version: provenance.classifier.version,
  },
  toolManifestVersion: provenance.tool_manifest_version,
});

const wireReport = (data: AnalysisEnvelope) => ({
  title: data.report.title,
  teamName: data.report.team_name,
  leaderSessionId: data.report.leader_session_id,
  leaderSessionName: data.report.leader_session_name,
  coverage: {
    startMs: data.report.coverage.start_ms,
    endMs: data.report.coverage.end_ms,
  },
});

const wireEvidence = (evidence: Evidence) => ({
  class: evidence.class,
  basis: evidence.basis,
  ...(evidence.confidence === undefined
    ? {}
    : { confidence: evidence.confidence }),
  ...(evidence.unavailable_reason === undefined
    ? {}
    : { unavailableReason: evidence.unavailable_reason }),
});

const wireDisplay = (display: MatrixMark["display"]) => ({
  kind: display.kind,
  glyph: display.glyph,
  alert: display.alert,
  evidence: wireEvidence(display.evidence),
});

const wireMark = (mark: MatrixMark) => ({
  eventRef: mark.event_ref,
  rowType: mark.row_type,
  agentRef: mark.agent_ref,
  label: mark.label,
  startMs: mark.start_ms,
  endMs: mark.end_ms,
  precision: mark.precision,
  evidence: wireEvidence(mark.evidence),
  provenanceRefs: [...mark.provenance_refs],
  qualification: mark.qualification,
  display: wireDisplay(mark.display),
});

const wireAggregate = (aggregate: Aggregate) => ({
  aggregateId: aggregate.aggregate_id,
  kind: aggregate.kind,
  dimensions: { ...aggregate.dimensions },
  measures: { ...aggregate.measures },
  semantics: aggregate.semantics,
  evidence: wireEvidence(aggregate.evidence),
});

/** Public API contract. Only the already allowlisted presentation fields cross this boundary. */
export function matrixWire(
  data: AnalysisEnvelope,
  options: Parameters<typeof matrixProjection>[1] = {},
) {
  const projection = matrixProjection(data, options);
  return {
    schemaVersion: projection.schema_version,
    snapshot: camel(projection.snapshot),
    coverage: {
      ...camel(projection.coverage),
      initialWindow: camel(projection.snapshot.parameters.initial_window),
      currentWindow: camel(projection.snapshot.parameters.returned_window),
      rowBudget: projection.snapshot.parameters.row_budget,
      detail: projection.snapshot.parameters.detail,
    },
    columns: projection.columns.map((column) => ({
      agentRef: column.agent_ref,
      sessionTraceId: column.session_trace_ref,
      header: {
        label: column.display_name,
        evidence: wireEvidence(column.display_name_evidence),
      },
      role: column.role,
      membership: column.membership,
      inspectionCue: camel(column.inspection_cue),
    })),
    marks: projection.marks.map(wireMark),
    diagnostics: projection.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      evidence: wireEvidence(diagnostic.evidence),
    })),
  };
}

export function matrixInspectorWire(
  data: AnalysisEnvelope,
  snapshotId: string,
  eventRef: string,
  options: Parameters<typeof matrixProjection>[1] = {},
) {
  const inspector = matrixInspector(data, snapshotId, eventRef, options);
  return (
    inspector && {
      ...wireMark(inspector),
      snapshotId: inspector.snapshot_id,
      preparedDerivationId: inspector.prepared_derivation_id,
      analysisId: inspector.analysis_id,
      safeMetrics: {
        observedElapsedMs: inspector.safe_metrics.observed_elapsed_ms,
        observedSpanMs: inspector.safe_metrics.observed_span_ms,
        outcome: inspector.safe_metrics.outcome,
      },
    }
  );
}

export type MatrixWireProjection = ReturnType<typeof matrixWire>;
export type MatrixWireInspector = NonNullable<
  ReturnType<typeof matrixInspectorWire>
>;

/**
 * Backend-prepared ordinal evidence. Its order is chronological only: adjacent
 * buckets do not imply elapsed duration, causality, or agent runtime.
 */
type OrdinalSourceTurn = {
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
    usage: {
      totalTokens: number | null;
      estimatedCostUsd: number | null;
      costBasis: string | null;
    };
    content: Array<{
      partRef: string;
      partIndex: number;
      type: string;
      present: boolean;
      retention: "metadata_only" | "approved_excerpt";
      approvedExcerpt: { reference: string; text: string } | null;
      toolCallRef: string | null;
    }>;
    toolEvents: Array<{
      eventRef: string;
      kind: string;
      callRef: string | null;
      toolName: string | null;
      status: string;
      pairingState: string;
      recordedAtMs: number | null;
    }>;
  }>;
};

/**
 * Produces the sole ordinal disclosure payload from semantic rows.  This is a
 * deliberately narrow policy boundary: excerpts retain only extraction-approved
 * text; ordered content, calls, and results carry identity/type/status metadata
 * but never thinking, tool arguments/results, custom payloads, or raw errors.
 */
const ordinalDisclosureFor = (
  rows: AnalysisRow[],
  turnId: string | null,
): OrdinalSourceTurn | null => {
  if (!turnId) return null;
  const turn = rows.find(
    (row) => row.row_type === "turn" && row.turn_id === turnId,
  );
  if (!turn || !turn.source_id) return null;
  const requests = rows
    .filter(
      (row) => row.row_type === "request_interval" && row.turn_id === turnId,
    )
    .sort(
      (a, b) =>
        (field<number>(a, "ordinal") ?? Infinity) -
          (field<number>(b, "ordinal") ?? Infinity) ||
        a.row_id.localeCompare(b.row_id),
    )
    .map((request) => {
      const requestId = request.request_id!;
      const content = rows
        .filter(
          (row) =>
            row.row_type === "content_part" && row.request_id === requestId,
        )
        .sort(
          (a, b) =>
            (field<number>(a, "part_index") ?? Infinity) -
              (field<number>(b, "part_index") ?? Infinity) ||
            a.row_id.localeCompare(b.row_id),
        )
        .map((part) => {
          const retention =
            field<"metadata_only" | "approved_excerpt">(part, "retention") ??
            "metadata_only";
          const text =
            retention === "approved_excerpt"
              ? (field<string>(part, "visible_text_excerpt") ?? null)
              : null;
          return {
            partRef: part.row_id,
            partIndex: field<number>(part, "part_index") ?? 0,
            type: field<string>(part, "part_type") ?? "unknown",
            present: field<boolean>(part, "present") ?? false,
            retention,
            approvedExcerpt:
              text === null ? null : { reference: part.row_id, text },
            toolCallRef: field<string>(part, "tool_call_id") ?? null,
          };
        });
      const toolEvents = rows
        .filter(
          (row) =>
            row.row_type === "tool_event" && row.request_id === requestId,
        )
        .sort(
          (a, b) =>
            (field<number>(a, "timestamp_ms") ?? Infinity) -
              (field<number>(b, "timestamp_ms") ?? Infinity) ||
            a.row_id.localeCompare(b.row_id),
        )
        .map((event) => ({
          eventRef: event.row_id,
          kind: field<string>(event, "kind") ?? "unknown",
          callRef: field<string>(event, "call_id") ?? null,
          toolName: field<string>(event, "tool_name") ?? null,
          status: field<string>(event, "status") ?? "unknown",
          pairingState: field<string>(event, "pairing_state") ?? "unknown",
          recordedAtMs: field<number>(event, "timestamp_ms") ?? null,
        }));
      return {
        sourceRef: {
          sourceId: request.source_id!,
          requestId,
          requestOrdinal: field<number>(request, "ordinal") ?? null,
        },
        provider: field<string>(request, "provider") ?? null,
        model: field<string>(request, "model") ?? null,
        api: field<string>(request, "api") ?? null,
        outcome: field<string>(request, "outcome") ?? null,
        usage: {
          totalTokens:
            field<{ total_tokens?: number }>(request, "usage")?.total_tokens ??
            null,
          estimatedCostUsd:
            field<{ estimated_cost_usd?: number | null }>(request, "usage")
              ?.estimated_cost_usd ?? null,
          costBasis:
            field<{ cost_basis?: string | null }>(request, "usage")
              ?.cost_basis ?? null,
        },
        content,
        toolEvents,
      };
    });
  const excerpt = field<string>(turn, "excerpt") ?? null;
  return {
    sourceRef: {
      sourceId: turn.source_id,
      turnId,
      turnOrdinal: field<number>(turn, "ordinal") ?? null,
    },
    approvedExcerpt:
      excerpt === null ? null : { reference: turn.row_id, text: excerpt },
    compactSummary: {
      requestCount:
        field<number>(turn, "following_request_count") ?? requests.length,
      toolCount: field<number>(turn, "tool_count") ?? 0,
      totalTokens: field<number>(turn, "following_total_tokens") ?? 0,
      estimatedCostUsd:
        field<number>(turn, "following_estimated_cost_usd") ?? null,
      outcome: field<string>(turn, "episode_outcome") ?? null,
    },
    requests,
  };
};

const ordinalSnapshotId = (data: AnalysisEnvelope) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        schema: ORDINAL_SCHEMA_VERSION,
        prepared: data.prepared_derivation_id,
        analysis: data.analysis_id,
        inputs: data.provenance.source_artifacts.map((x) => [
          x.source_id,
          x.sha256,
        ]),
      }),
    )
    .digest("hex");

/**
 * A bounded sequence projection. This intentionally contains neither wall-clock
 * fields nor disclosure content: the snapshot-scoped disclosure endpoint is the
 * sole policy boundary for the latter.
 */
export function ordinalWire(data: AnalysisEnvelope) {
  const matrix = matrixProjection(data);
  const candidates = data.rows
    .flatMap((row) => {
      const at = timeFor(row);
      // The ordinal grid has exactly Agent-owned cells. Global compression gaps
      // are layout evidence, not agent events, so they cannot consume an ordinal.
      return at === null || !row.agent_id || !MARK_TYPES.has(row.row_type)
        ? []
        : [{ row, at }];
    })
    .sort((a, b) => a.at - b.at || a.row.row_id.localeCompare(b.row.row_id));
  const localOrdinals = new Map<string, number>();
  return {
    schemaVersion: ORDINAL_SCHEMA_VERSION,
    snapshot: {
      id: ordinalSnapshotId(data),
      analysisId: data.analysis_id,
      preparedDerivationId: data.prepared_derivation_id,
      inputs: data.provenance.source_artifacts.map((artifact) => ({
        sourceId: artifact.source_id,
        sha256: artifact.sha256,
      })),
      report: wireReport(data),
      provenance: wireProvenance(data.provenance),
      disclosureAvailability: {
        scope: "issued_ordinal_snapshot_only" as const,
        staleReason: "analysis_rotated_or_process_restarted" as const,
      },
    },
    columns: matrix.columns.map((column) => ({
      agentRef: column.agent_ref,
      sessionTraceId: column.session_trace_ref,
      label: column.display_name,
    })),
    ordering: {
      basis: "timestamp_ascending_then_source_scoped_event_ref",
      equalTimestamp: "source_scoped_event_ref",
      adjacency: "not_elapsed_duration_or_causality",
    },
    rows: candidates.map(({ row }, index) => {
      const ownerAgentRef = row.agent_id;
      const derivedLocal = ownerAgentRef
        ? (localOrdinals.get(ownerAgentRef) ?? 0)
        : null;
      if (ownerAgentRef) localOrdinals.set(ownerAgentRef, derivedLocal! + 1);
      const globalOrdinal = field<number>(row, "global_ordinal") ?? index;
      const agentLocalOrdinal =
        field<number>(row, "agent_local_ordinal") ?? derivedLocal;
      return {
        globalOrdinal,
        cells: [
          {
            eventRef: row.row_id,
            ownerAgentRef,
            label: labelFor(row),
            /** Typed backend display fact: clients must not classify the human label. */
            display: wireDisplay(displayFor(row)),
            globalOrdinal,
            agentLocalOrdinal,
            disclosureRef: row.row_id,
          },
        ],
      };
    }),
  };
}

/** Returns existing policy-approved detail for one event in one issued ordinal snapshot. */
export function ordinalDisclosureWire(
  data: AnalysisEnvelope,
  ordinalSnapshotId: string,
  disclosureRef: string,
) {
  if (ordinalSnapshotId !== ordinalWire(data).snapshot.id)
    throw Error("stale_ordinal_snapshot");
  const row = data.rows.find(
    (candidate) =>
      candidate.row_id === disclosureRef &&
      MARK_TYPES.has(candidate.row_type) &&
      timeFor(candidate) !== null,
  );
  if (!row) return null;
  return {
    schemaVersion: ORDINAL_DISCLOSURE_SCHEMA_VERSION,
    snapshotId: ordinalSnapshotId,
    disclosureRef,
    eventRef: row.row_id,
    disclosure: ordinalDisclosureFor(data.rows, row.turn_id),
  };
}

export function secondaryWire(
  data: AnalysisEnvelope,
  matrixSnapshotId: string,
  options: Parameters<typeof matrixProjection>[1],
) {
  const matrix = matrixProjection(data, options);
  if (matrix.snapshot.id !== matrixSnapshotId)
    throw Error("stale_matrix_snapshot");
  const rows = data.rows
    .filter(
      (row) =>
        row.row_type === "cumulative_usage_point" ||
        row.row_type === "active_agent_interval",
    )
    .map((row) =>
      row.row_type === "cumulative_usage_point"
        ? {
            kind: "cumulative_usage_point" as const,
            ref: row.row_id,
            agentRef: row.agent_id,
            atMs: field<number>(row, "at_ms") ?? null,
            cumulativeInputTokens:
              field<number>(row, "cumulative_input_tokens") ?? null,
            cumulativeEstimatedCostUsd:
              field<number>(row, "cumulative_estimated_cost_usd") ?? null,
            evidence: wireEvidence(row.evidence),
          }
        : {
            kind: "active_agent_interval" as const,
            ref: row.row_id,
            startMs: field<number>(row, "start_ms") ?? null,
            endMs: field<number>(row, "end_ms") ?? null,
            distinctActiveAgents:
              field<number>(row, "distinct_active_agents") ?? null,
            evidence: wireEvidence(row.evidence),
          },
    );
  return {
    schemaVersion: SECONDARY_SCHEMA_VERSION,
    snapshotId: matrixSnapshotId,
    analysisId: data.analysis_id,
    report: wireReport(data),
    aggregates: data.aggregates.map(wireAggregate),
    rows,
  };
}

export type OrdinalWireProjection = ReturnType<typeof ordinalWire>;
export type SecondaryWireProjection = ReturnType<typeof secondaryWire>;
export type OrdinalDisclosureWireProjection = ReturnType<
  typeof ordinalDisclosureWire
>;
