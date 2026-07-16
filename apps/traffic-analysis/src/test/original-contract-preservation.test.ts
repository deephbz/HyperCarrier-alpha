import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { matrixWire } from "../application/matrix.js";
import type { AnalysisEnvelope } from "../domain/contracts.js";

const fixture = async () =>
  JSON.parse(
    await readFile(
      new URL("../../fixtures/analysis-envelope.json", import.meta.url),
      "utf8",
    ),
  ) as AnalysisEnvelope;

/**
 * Semantic release gate: the matrix is an additive wall-clock projection, so
 * it may be sparse, but its marks must remain provenance-bearing safe facts.
 * The browser-level projection/refresh gate is in web/src/original-contract.test.tsx.
 */
test("original contract: matrix marks preserve source identity and qualifications", async () => {
  const projection = matrixWire(await fixture());
  assert.ok(projection.snapshot.preparedDerivationId);
  assert.ok(projection.snapshot.analysisId);
  assert.ok(
    (
      projection.snapshot.inputs as Array<{ sourceId: string; sha256: string }>
    ).every((input) => input.sourceId && input.sha256),
  );
  assert.ok(
    (
      projection.marks as Array<{
        eventRef: string;
        provenanceRefs: string[];
        evidence: { class: string; basis: string };
      }>
    ).every(
      (mark) =>
        mark.eventRef &&
        mark.provenanceRefs.length > 0 &&
        mark.evidence.class &&
        mark.evidence.basis,
    ),
  );
  assert.ok(
    (
      projection.marks as Array<{
        rowType: string;
        label: string;
      }>
    ).some(
      (mark) =>
        mark.rowType === "tool_observation_span" &&
        /not runtime/i.test(mark.label),
    ),
  );
});
