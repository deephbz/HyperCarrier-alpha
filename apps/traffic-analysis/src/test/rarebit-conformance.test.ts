import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { preparePiJsonl } from "../adapters/pi/prepare.js";

type CorpusCase = {
  id: string;
  records: unknown[];
  expected: {
    rarebits: Array<{ sourceEntryId: string; outcome: string }>;
  };
};
type FailureCase = {
  id: string;
  lines: string[];
  expected: { trafficDiagnostic: string };
};
type Corpus = {
  capabilities: {
    notRarebitProjections: { traffic_outcomes: string };
  };
  cases: CorpusCase[];
  failureCases: FailureCase[];
};

const corpus = JSON.parse(
  await readFile(
    new URL(
      "../../../../packages/hc-rarebit/test/fixtures/conformance-corpus.v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Corpus;
const jsonl = (records: unknown[]) =>
  `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

test("Traffic outcomes preserve the shared user/continuation/stop marker-role subset", () => {
  const fixture = corpus.cases.find(
    (candidate) => candidate.id === "linear-prose-and-outcomes",
  )!;
  assert.match(
    corpus.capabilities.notRarebitProjections.traffic_outcomes,
    /operational/,
  );
  const prepared = preparePiJsonl(jsonl(fixture.records), fixture.id);
  assert.equal(prepared.turns.length, 1);
  assert.deepEqual(
    prepared.requests.map((request) => request.outcome),
    ["continuation", "truncated", "stop"],
  );
  assert.deepEqual(
    fixture.expected.rarebits.map((occurrence) => occurrence.outcome),
    ["user", "continuation", "stop"],
  );
});

test("Traffic reports malformed corpus input as typed unavailable evidence", () => {
  const fixture = corpus.failureCases.find(
    (candidate) => candidate.id === "malformed-jsonl",
  )!;
  const prepared = preparePiJsonl(`${fixture.lines.join("\n")}\n`, fixture.id);
  const diagnostic = prepared.diagnostics.find(
    (candidate) => candidate.code === fixture.expected.trafficDiagnostic,
  );
  assert.equal(diagnostic?.evidence.class, "unavailable");
  assert.equal(diagnostic?.evidence.unavailable_reason, "malformed_line");
});
