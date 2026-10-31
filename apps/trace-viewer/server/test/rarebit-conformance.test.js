import "../../test/home.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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

const jsonl = (records) => `${records.map(JSON.stringify).join("\n")}\n`;

test("Trace Viewer attaches strict Rarebit selection to full active-branch records", () => {
  const fixture = corpus.cases.find((candidate) => candidate.id === "fork-compaction-and-resume");
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
