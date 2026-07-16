import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  matrixInspectorWire,
  matrixWire,
  secondaryWire,
  ordinalDisclosureWire,
  ordinalWire,
} from "../application/matrix.js";
import type { AnalysisEnvelope } from "../domain/contracts.js";

const fixture = async () =>
  JSON.parse(
    await readFile(
      new URL("../../fixtures/analysis-envelope.json", import.meta.url),
      "utf8",
    ),
  ) as AnalysisEnvelope;

test("matrix: projection is metadata-only, trace-derived, and selection is snapshot scoped", async () => {
  const data = await fixture();
  const projection = matrixWire(data);
  assert.equal(projection.schemaVersion, "traffic-matrix-v1");
  assert.equal(projection.columns[0].sessionTraceId, "session-fixture");
  assert.match(projection.columns[0].header.label, /^Unnamed agent/);
  assert.deepEqual(projection.columns[0].role, { state: "unavailable" });
  assert.equal(projection.columns[0].inspectionCue.priority, "unassessed");
  const mark = projection.marks.find(
    (x: any) => x.rowType === "tool_observation_span",
  )!;
  assert.equal(mark.label.includes("not runtime"), true);
  assert.deepEqual(mark.display, {
    kind: "tool_observation",
    glyph: "span",
    alert: null,
    evidence: mark.evidence,
  });
  const request = projection.marks.find(
    (item: any) => item.rowType === "request_interval",
  )!;
  assert.equal(request.display.kind, "agent_continuation");
  assert.equal(request.display.glyph, "continuation");
  const truncated = matrixWire({
    ...data,
    rows: data.rows.map((row) =>
      row.row_type === "request_interval"
        ? { ...row, outcome: "truncated" }
        : row,
    ),
  }).marks.find((item: any) => item.rowType === "request_interval")!;
  assert.deepEqual(truncated.display, {
    kind: "agent_truncated",
    glyph: "truncated_warning",
    alert: "truncated_response",
    evidence: truncated.evidence,
  });
  assert.equal(
    JSON.stringify(projection).includes("Please inspect the source"),
    false,
  );
  const inspector = matrixInspectorWire(
    data,
    projection.snapshot.id,
    mark.eventRef,
  )!;
  assert.equal(inspector.snapshotId, projection.snapshot.id);
  assert.deepEqual(projection.snapshot.inspectorAvailability, {
    scope: "current_analysis_process_only",
    staleReason: "analysis_rotated_or_process_restarted",
  });
  const narrowed = matrixWire(data, {
    start_ms: mark.startMs,
    end_ms: mark.startMs,
    row_budget: 1,
  });
  assert.equal(
    matrixInspectorWire(data, narrowed.snapshot.id, mark.eventRef, {
      start_ms: mark.startMs,
      end_ms: mark.startMs,
      row_budget: 1,
    })?.eventRef,
    mark.eventRef,
  );
  assert.throws(
    () => matrixInspectorWire(data, "stale", mark.eventRef),
    /stale_snapshot/,
  );
});

test("matrix: snapshot prepares first-paint report identity without source payloads", async () => {
  const data = await fixture();
  const observed = matrixWire({
    ...data,
    report: {
      ...data.report,
      team_name: "matrix-team",
      leader_session_name: "Observed leader",
      leader_session_id: "leader-session-id",
    },
  });
  assert.deepEqual(observed.snapshot.report, {
    teamName: "matrix-team",
    leaderSessionName: "Observed leader",
    leaderSessionId: "leader-session-id",
    coverage: {
      startMs: data.report.coverage.start_ms,
      endMs: data.report.coverage.end_ms,
    },
  });

  const idFallback = matrixWire({
    ...data,
    report: {
      ...data.report,
      leader_session_name: null,
      leader_session_id: "leader-session-id",
    },
  });
  assert.equal(idFallback.snapshot.report.leaderSessionName, null);
  assert.equal(idFallback.snapshot.report.leaderSessionId, "leader-session-id");

  const unavailable = matrixWire({
    ...data,
    report: {
      ...data.report,
      team_name: null,
      leader_session_name: null,
      leader_session_id: null,
      coverage: { start_ms: null, end_ms: null },
    },
  });
  assert.deepEqual(unavailable.snapshot.report, {
    teamName: null,
    leaderSessionName: null,
    leaderSessionId: null,
    coverage: { startMs: null, endMs: null },
  });

  const poisoned = matrixWire({
    ...data,
    report: { ...data.report, raw_payload: "SECRET_REPORT_PAYLOAD" } as any,
    provenance: {
      ...data.provenance,
      location: "SECRET_PROVENANCE_LOCATION",
    } as any,
  });
  const serialized = JSON.stringify(poisoned.snapshot.report);
  assert.equal(serialized.includes("SECRET_REPORT_PAYLOAD"), false);
  assert.equal(serialized.includes("SECRET_PROVENANCE_LOCATION"), false);
});

test("normal projections allowlist nested evidence and aggregate fields", async () => {
  const data = await fixture();
  const secret = "/private/adapter/poisoned-session.jsonl";
  const poisonEvidence = (evidence: any) => ({
    ...evidence,
    confidence: 0.75,
    unavailable_reason: "typed-unavailable-reason",
    adapterLocator: secret,
    arbitraryProvenanceExtra: "SECRET_EVIDENCE_EXTRA",
  });
  const poisoned: AnalysisEnvelope = {
    ...data,
    rows: data.rows.map((row) => ({
      ...row,
      evidence: poisonEvidence(row.evidence),
      ...(row.row_type === "agent"
        ? {
            display_name_evidence: poisonEvidence(
              row.display_name_evidence as any,
            ),
          }
        : {}),
    })),
    diagnostics: data.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      evidence: poisonEvidence(diagnostic.evidence),
    })),
    aggregates: data.aggregates.map((aggregate) => ({
      ...aggregate,
      evidence: poisonEvidence(aggregate.evidence),
      adapterLocator: secret,
      arbitraryAggregateExtra: "SECRET_AGGREGATE_EXTRA",
    })) as any,
  };

  const matrix = matrixWire(poisoned);
  const mark = matrix.marks[0]!;
  const inspector = matrixInspectorWire(
    poisoned,
    matrix.snapshot.id,
    mark.eventRef,
  )!;
  const ordinal = ordinalWire(poisoned);
  const secondary = secondaryWire(poisoned, matrix.snapshot.id, {});
  for (const projection of [matrix, inspector, ordinal, secondary]) {
    const serialized = JSON.stringify(projection);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes("SECRET_EVIDENCE_EXTRA"), false);
    assert.equal(serialized.includes("SECRET_AGGREGATE_EXTRA"), false);
  }
  assert.deepEqual(Object.keys(mark.evidence).sort(), [
    "basis",
    "class",
    "confidence",
    "unavailableReason",
  ]);
  assert.deepEqual(mark.display.evidence, mark.evidence);
  assert.deepEqual(inspector.evidence, mark.evidence);
  assert.deepEqual(
    Object.keys(ordinal.rows[0]!.cells[0]!.display.evidence).sort(),
    ["basis", "class", "confidence", "unavailableReason"],
  );
  assert.deepEqual(Object.keys(secondary.aggregates[0]!).sort(), [
    "aggregateId",
    "dimensions",
    "evidence",
    "kind",
    "measures",
    "semantics",
  ]);
});

test("matrix: intervals that cross either window boundary remain visible", async () => {
  const data = await fixture();
  const request = data.rows.find((row) => row.row_type === "request_interval")!;
  const start = Number(request.assistant_request_start_ms);
  const end = Number(request.assistant_response_recorded_ms);
  const projection = matrixWire(data, { start_ms: start + 1, end_ms: end - 1 });
  assert.ok(
    projection.marks.some((mark: any) => mark.eventRef === request.row_id),
  );
});

test("matrix: unavailable request outcomes stay typed unavailable", async () => {
  const data = await fixture();
  const unavailable = matrixWire({
    ...data,
    rows: data.rows.map((row) =>
      row.row_type === "request_interval" ? { ...row, outcome: null } : row,
    ),
  }).marks.find((mark: any) => mark.rowType === "request_interval")!;
  assert.equal(unavailable.label, "Agent-response unavailable");
  assert.equal(unavailable.display.kind, "agent_response_unavailable");
  assert.equal(unavailable.display.glyph, "unavailable");
});

test("secondary payload is snapshot-scoped and excludes nested source rows", async () => {
  const data = await fixture();
  const matrix = matrixWire(data);
  const secondary = secondaryWire(
    {
      ...data,
      report: {
        ...data.report,
        adapter_locator: "/private/adapter/session.jsonl",
      } as any,
    },
    matrix.snapshot.id,
    {},
  );
  assert.equal(secondary.schemaVersion, "traffic-secondary-v1");
  assert.equal(secondary.snapshotId, matrix.snapshot.id);
  const serialized = JSON.stringify(secondary);
  assert.equal(serialized.includes("Please inspect the source"), false);
  assert.equal(serialized.includes("/private/adapter/session.jsonl"), false);
  assert.deepEqual(Object.keys(secondary.report).sort(), [
    "coverage",
    "leaderSessionId",
    "leaderSessionName",
    "teamName",
    "title",
  ]);
  assert.equal(serialized.includes('"content_part"'), false);
  assert.ok(
    secondary.rows.every(
      (row) =>
        row.kind === "cumulative_usage_point" ||
        row.kind === "active_agent_interval",
    ),
  );
  assert.throws(
    () => secondaryWire(data, "stale", {}),
    /stale_matrix_snapshot/,
  );
});

test("ordinal evidence is a snapshot-scoped skeleton with stable sequence and agent ownership", async () => {
  const data = await fixture();
  const ordinal = ordinalWire(data);
  assert.equal(ordinal.schemaVersion, "traffic-ordinal-v2");
  assert.deepEqual(ordinal.ordering, {
    basis: "timestamp_ascending_then_source_scoped_event_ref",
    equalTimestamp: "source_scoped_event_ref",
    adjacency: "not_elapsed_duration_or_causality",
  });
  assert.equal(ordinal.columns[0]?.sessionTraceId, "session-fixture");
  assert.equal(ordinal.snapshot.report.title, "Agent-turns viz");
  assert.equal(ordinal.snapshot.id.length, 64);
  assert.ok(ordinal.rows.length > 0);
  const cell = ordinal.rows[0]!.cells[0]!;
  assert.equal(
    ordinal.rows.every((row) => row.cells.length === 1),
    true,
  );
  assert.equal(
    ordinal.rows.every((row) => row.cells[0]!.ownerAgentRef !== null),
    true,
  );
  assert.equal(cell.ownerAgentRef, "agent:session-fixture");
  assert.equal(cell.disclosureRef, cell.eventRef);
  assert.equal(cell.globalOrdinal, 0);
  assert.equal(cell.agentLocalOrdinal, 0);
  const serialized = JSON.stringify(ordinal);
  assert.equal(serialized.includes("timeMs"), false);
  assert.equal(serialized.includes("recordedAtMs"), false);
  assert.equal(serialized.includes("Please inspect the source"), false);
  assert.equal(serialized.includes('disclosure":'), false);
});

test("ordinal wire provenance is an allowlist and never forwards adapter locators or extras", async () => {
  const data = await fixture();
  const poisoned = ordinalWire({
    ...data,
    report: {
      ...data.report,
      raw_payload: "SECRET_REPORT_EXTRA",
    } as any,
    provenance: {
      ...data.provenance,
      location: "SECRET_TOP_LEVEL_LOCATOR",
      arbitrary_adapter_detail: "SECRET_PROVENANCE_EXTRA",
      classifier: {
        ...data.provenance.classifier,
        adapter_secret: "SECRET_CLASSIFIER_EXTRA",
      },
      source_artifacts: data.provenance.source_artifacts.map((artifact) => ({
        ...artifact,
        location: "/private/adapter/session.jsonl",
        adapter_secret: "SECRET_ARTIFACT_EXTRA",
      })),
    } as any,
  });

  assert.deepEqual(poisoned.snapshot.provenance, {
    sourceIds: data.provenance.source_ids,
    parserVersion: data.provenance.parser_version,
    contentPolicy: data.provenance.content_policy,
    classifier: {
      id: data.provenance.classifier.id,
      version: data.provenance.classifier.version,
    },
    toolManifestVersion: data.provenance.tool_manifest_version,
  });
  assert.deepEqual(Object.keys(poisoned.snapshot.report).sort(), [
    "coverage",
    "leaderSessionId",
    "leaderSessionName",
    "teamName",
    "title",
  ]);
  const serialized = JSON.stringify(poisoned);
  for (const secret of [
    "SECRET_REPORT_EXTRA",
    "SECRET_TOP_LEVEL_LOCATOR",
    "SECRET_PROVENANCE_EXTRA",
    "SECRET_CLASSIFIER_EXTRA",
    "SECRET_ARTIFACT_EXTRA",
    "/private/adapter/session.jsonl",
  ])
    assert.equal(serialized.includes(secret), false, secret);
});

test("ordinal disclosure is by-ref, snapshot scoped, and retains approved safe details", async () => {
  const data = await fixture();
  const ordinal = ordinalWire(data);
  const cell = ordinal.rows[0]!.cells[0]!;
  const disclosed = ordinalDisclosureWire(
    data,
    ordinal.snapshot.id,
    cell.disclosureRef,
  )!;
  assert.equal(disclosed.schemaVersion, "traffic-ordinal-disclosure-v1");
  assert.equal(disclosed.snapshotId, ordinal.snapshot.id);
  assert.equal(disclosed.eventRef, cell.eventRef);
  const disclosure = disclosed.disclosure!;
  assert.deepEqual(disclosure.sourceRef, {
    sourceId: "source:session-fixture",
    turnId: "source:session-fixture:turn:0",
    turnOrdinal: 0,
  });
  assert.deepEqual(disclosure.approvedExcerpt, {
    reference: "source:session-fixture:turn:0",
    text: "Please inspect the source",
  });
  assert.deepEqual(disclosure.compactSummary, {
    requestCount: 2,
    toolCount: 1,
    totalTokens: 27,
    estimatedCostUsd: 0.015,
    outcome: "stop",
  });
  assert.equal(disclosure.requests.length, 2);
  assert.deepEqual(disclosure.requests[0]?.sourceRef, {
    sourceId: "source:session-fixture",
    requestId: "source:session-fixture:request:0",
    requestOrdinal: 0,
  });
  assert.equal(disclosure.requests[0]?.provider, "test");
  assert.equal(disclosure.requests[0]?.usage.totalTokens, 18);
  assert.deepEqual(
    disclosure.requests[0]?.content.map((part) => part.partIndex),
    [0, 1],
  );
  assert.deepEqual(disclosure.requests[0]?.toolEvents[0], {
    eventRef: "source:session-fixture:tool-call:0",
    kind: "call_available",
    callRef: "call-1",
    toolName: "read",
    status: "unknown",
    pairingState: "matched",
    recordedAtMs: 1784019603000,
  });
  assert.throws(
    () => ordinalDisclosureWire(data, "unknown", cell.disclosureRef),
    /stale_ordinal_snapshot/,
  );
});

test("ordinal disclosure exposes only approved excerpts and safe ordered metadata", async () => {
  const data = await fixture();
  const poisoned: AnalysisEnvelope = {
    ...data,
    rows: data.rows.map((row) => {
      if (row.row_type === "content_part" && row.row_id.endsWith("part:1"))
        return {
          ...row,
          visible_text_excerpt: "SECRET_TOOL_ARGUMENT",
          tool_arguments: "SECRET_TOOL_ARGUMENT",
          custom_payload: "SECRET_CUSTOM_PAYLOAD",
        };
      if (row.row_type === "tool_event")
        return {
          ...row,
          raw_error: "SECRET_RAW_ERROR",
          result: "SECRET_RESULT",
        };
      return row;
    }),
  };
  const ordinal = ordinalWire(poisoned);
  const serialized = JSON.stringify(ordinal);
  assert.equal(serialized.includes("SECRET_TOOL_ARGUMENT"), false);
  assert.equal(serialized.includes("SECRET_CUSTOM_PAYLOAD"), false);
  assert.equal(serialized.includes("SECRET_RAW_ERROR"), false);
  assert.equal(serialized.includes("SECRET_RESULT"), false);
  const disclosure = ordinalDisclosureWire(
    poisoned,
    ordinal.snapshot.id,
    ordinal.rows[0]!.cells[0]!.disclosureRef,
  )!.disclosure!;
  const disclosedSerialized = JSON.stringify(disclosure);
  assert.equal(disclosedSerialized.includes("SECRET_TOOL_ARGUMENT"), false);
  assert.equal(disclosedSerialized.includes("SECRET_CUSTOM_PAYLOAD"), false);
  assert.equal(disclosedSerialized.includes("SECRET_RAW_ERROR"), false);
  assert.equal(disclosedSerialized.includes("SECRET_RESULT"), false);
  const toolPart = disclosure.requests[0]!.content[1]!;
  assert.equal(toolPart.retention, "metadata_only");
  assert.equal(toolPart.approvedExcerpt, null);
  assert.equal(toolPart.toolCallRef, "call-1");
});

test("matrix: local quiet gaps remain agent-scoped and cannot become compression gaps", async () => {
  const data = await fixture();
  const projection = matrixWire(data);
  const localQuiet = projection.marks.find(
    (mark: any) => mark.rowType === "quiet_gap",
  );
  assert.ok(localQuiet);
  assert.notEqual(localQuiet.agentRef, null);
  assert.equal(
    projection.marks.some((mark: any) => mark.rowType === "global_quiet_gap"),
    false,
  );
});

test("matrix: dense rows honor a bounded metadata-only LOD response", async () => {
  const data = await fixture();
  const request = data.rows.find((row) => row.row_type === "request_interval")!;
  const dense: AnalysisEnvelope = {
    ...data,
    rows: Array.from({ length: 800 }, (_, index) => ({
      ...request,
      row_id: `dense:${index}`,
      assistant_request_start_ms: 1784019600000 + index,
      assistant_response_recorded_ms: 1784019600001 + index,
    })),
  };
  const projection = matrixWire(dense, { row_budget: 25 });
  assert.equal(projection.marks.length, 25);
  assert.equal(projection.coverage.rowBudget, 25);
  assert.equal(projection.coverage.detail, "marks");
  assert.deepEqual(
    projection.coverage.currentWindow,
    projection.snapshot.parameters.returnedWindow,
  );
  assert.equal(
    projection.marks.some((mark: any) => "excerpt" in mark),
    false,
  );
});
