import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  matrixInspectorWire,
  matrixWire,
  ordinalWire,
  type MatrixWireProjection,
} from "../application/matrix.js";
import type { AnalysisEnvelope } from "../domain/contracts.js";

type WireMark = {
  agentRef: string | null;
  rowType: string;
  startMs: number;
  endMs: number | null;
  precision: string;
  qualification: string | null;
  provenanceRefs: string[];
  evidence: { basis: string };
  display: { kind: string };
};

const fixture = async () =>
  JSON.parse(
    await readFile(
      new URL("../../fixtures/dense-analysis-envelope.json", import.meta.url),
      "utf8",
    ),
  ) as AnalysisEnvelope;

test("dense fixture is deterministic, provenance-bearing, heterogeneous, and privacy-safe", async () => {
  const data = await fixture();
  const typed = matrixWire(data, { row_budget: 600 }) as MatrixWireProjection;
  assert.equal(
    (data.parameters.fixture as { name: string }).name,
    "dense-matrix-v1",
  );
  assert.equal(typed.marks.length, 600);
  assert.equal(typed.columns.length, 6);
  assert.deepEqual(typed.snapshot.report, {
    teamName: "dense-fixture-team",
    leaderSessionName: "Fixture lead",
    leaderSessionId: "fixture-dense-trace-1",
    coverage: { startMs: 1784019600000, endMs: 1784023200000 },
  });
  assert.equal(
    new Set(
      typed.marks
        .map((mark: WireMark) => mark.agentRef)
        .filter(
          (agentRef: string | null): agentRef is string => agentRef !== null,
        ),
    ).size,
    6,
  );
  assert.deepEqual(
    new Set(typed.marks.map((mark: WireMark) => mark.rowType)),
    new Set([
      "turn",
      "request_interval",
      "tool_observation_span",
      "quiet_gap",
      "global_quiet_gap",
    ]),
  );
  const globalGaps = typed.marks.filter(
    (mark: WireMark) => mark.rowType === "global_quiet_gap",
  );
  assert.equal(globalGaps.length, 1);
  assert.equal(globalGaps[0]!.agentRef, null);
  assert.equal(globalGaps[0]!.startMs, 1784019615000);
  assert.equal(globalGaps[0]!.endMs, 1784019624000);
  assert.equal(globalGaps[0]!.precision, "exact");
  assert.equal(globalGaps[0]!.qualification, "exact_all_included_agents_quiet");
  assert.equal(globalGaps[0]!.provenanceRefs.length, 6);
  assert.ok(globalGaps[0]!.evidence.basis.includes("every included agent"));
  assert.ok(
    typed.marks.some(
      (mark: WireMark) =>
        mark.rowType === "quiet_gap" && mark.agentRef !== null,
    ),
  );
  assert.deepEqual(
    new Set(
      typed.marks
        .filter((mark: WireMark) => mark.rowType === "request_interval")
        .map((mark: WireMark) => mark.display.kind),
    ),
    new Set(["agent_continuation", "agent_stop", "agent_truncated"]),
  );
  assert.ok(
    typed.snapshot.inputs.every((input: { sourceId: string }) =>
      data.provenance.source_ids.includes(input.sourceId),
    ),
  );
  assert.ok(
    typed.marks.every(
      (mark: WireMark) => mark.provenanceRefs.length > 0 && mark.evidence.basis,
    ),
  );
  assert.equal(
    JSON.stringify(typed).match(/secret|payload|fixture excerpt/i),
    null,
  );
  assert.equal(data.aggregates.length >= 3, true);
  assert.equal(ordinalWire(data).rows.length > 100, true);
});

test("dense fixture declares and enforces the matrix LOD budget with scoped inspection", async () => {
  const data = await fixture();
  const typed = matrixWire(data, { row_budget: 100 }) as MatrixWireProjection;
  assert.equal(typed.marks.length, 100);
  assert.equal(typed.coverage.rowBudget, 100);
  assert.ok(
    typed.marks.some((mark: WireMark) => mark.rowType === "global_quiet_gap"),
    "global compression evidence survives mark LOD while local marks are trimmed",
  );
  const mark = typed.marks.at(-1)!;
  const inspector = matrixInspectorWire(
    data,
    typed.snapshot.id,
    mark.eventRef,
    {
      row_budget: 100,
    },
  );
  assert.equal(inspector?.eventRef, mark.eventRef);
  assert.equal(inspector?.snapshotId, typed.snapshot.id);
});
