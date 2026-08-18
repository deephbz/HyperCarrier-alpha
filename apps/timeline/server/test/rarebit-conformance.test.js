import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseSessionJsonl } from "../collector.js";
import { projectPiTrace } from "../live-detail.js";
import { parseNativeSession, resolveActiveBranch } from "@hypercarrier/rarebit/session";

const corpus = JSON.parse(
  await readFile(
    new URL(
      "../../../../packages/hc-rarebit/test/fixtures/conformance-corpus.v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

const caseById = (id) => corpus.cases.find((candidate) => candidate.id === id);
const jsonl = (records) => `${records.map(JSON.stringify).join("\n")}\n`;

test("Timeline matches strict Rarebit roles on a linear trace", () => {
  const fixture = caseById("linear-prose-and-outcomes");
  const projection = parseSessionJsonl(jsonl(fixture.records), fixture.id);
  assert.equal(
    projection.rarebits.every((occurrence) => !Object.hasOwn(occurrence, "producer")),
    true,
  );
  assert.deepEqual(
    projection.rarebits.map(({ sourceEntryId, role, outcome }) => ({
      sourceEntryId,
      role,
      outcome,
    })),
    fixture.expected.rarebits.map(({ sourceEntryId, role, outcome }) => ({
      sourceEntryId,
      role,
      outcome,
    })),
  );
});

test("Timeline executable gap: physical-entry markers do not yet resolve the active branch", () => {
  const fixture = caseById("fork-compaction-and-resume");
  const projection = parseSessionJsonl(jsonl(fixture.records), fixture.id);
  const actual = projection.rarebits.map((marker) => marker.sourceEntryId);
  const strict = fixture.expected.rarebits.map((occurrence) => occurrence.sourceEntryId);
  assert.match(corpus.capabilities.knownNonconformance.timeline, /active branch/);
  assert.notDeepEqual(actual, strict);
  assert.deepEqual(
    actual.filter((entryId) => !strict.includes(entryId)),
    ["u-abandoned", "a-abandoned"],
  );
});

test("Trace Viewer attaches strict Rarebit selection to full active-branch records", () => {
  const fixture = caseById("fork-compaction-and-resume");
  const parsed = parseNativeSession(jsonl(fixture.records), fixture.id);
  const activeBranch = resolveActiveBranch(parsed, fixture.id);
  const trace = projectPiTrace({
    availability: "available",
    sessionId: fixture.id,
    version: "fixture",
    activeLeafId: activeBranch.at(-1)?.id ?? null,
    activeBranchIds: activeBranch.map((entry) => entry.id),
    activeBranch,
  });
  assert.deepEqual(
    trace.records.filter((record) => record.rarebit).map((record) => record.sourceEntryId),
    fixture.expected.rarebits.map((item) => item.sourceEntryId),
  );
  assert.equal(
    trace.records.some((record) => !record.rarebit),
    true,
  );
});

test("Timeline malformed input stays observable instead of becoming silent empty success", () => {
  const fixture = corpus.failureCases.find((candidate) => candidate.id === "malformed-jsonl");
  const projection = parseSessionJsonl(`${fixture.lines.join("\n")}\n`, fixture.id);
  assert.equal(
    projection.rejected.some((entry) => entry.reason === "malformed_jsonl"),
    true,
  );
  assert.equal(projection.rarebits.length, 1, "complete prefix remains separately visible");
});
