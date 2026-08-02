import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseSessionJsonl } from "../collector.js";
import { isDefaultLiveEntry } from "../live-detail.js";

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

test("Live Detail delegates its physical-entry predicate to strict Rarebit semantics", () => {
  const fixture = caseById("linear-prose-and-outcomes");
  const selected = fixture.records.filter(isDefaultLiveEntry).map((entry) => entry.id);
  assert.deepEqual(
    selected,
    fixture.expected.rarebits.map((item) => item.sourceEntryId),
  );
  assert.equal(selected.includes("a-error"), false);
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
