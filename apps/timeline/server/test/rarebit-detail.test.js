import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rarebitMaterializationPath } from "@hypercarrier/hc-rarebit";
import { readSessionRarebitSummary } from "../rarebit-detail.js";

function roots() {
  const root = mkdtempSync(join(tmpdir(), "pi-key-detail-"));
  return { sessionRoot: join(root, "sessions"), rarebitRoot: join(root, "rarebit") };
}

function record(sessionId, status = "ok", overrides = {}) {
  return {
    type: "rarebit_summary",
    sessionId,
    status,
    observedAt: "2026-01-01T00:01:00Z",
    selection: {
      selectorVersion: "rarebit-selector-v1",
      manifestHash: "a".repeat(64),
      occurrenceCount: 1,
      uniquePayloadCount: 1,
      occurrences: [{ secret: "RAW_SESSION_PROSE" }],
      payloads: [{ secret: "RAW_SESSION_PROSE" }],
    },
    eligibility: {
      eligible: status === "ok",
      forced: false,
      reasons: status === "ineligible" ? ["total_length_below_minimum"] : [],
      policy: { policyVersion: "rarebit-summary-eligibility-v1" },
    },
    model: { provider: "test", id: "small" },
    modelProvenance: {
      source: "rarebit_settings_files",
      status: "resolved",
      settingsKey: "rarebit.model",
    },
    promptVersion: "v1",
    implementationVersion: "v1",
    jobId: "b".repeat(64),
    branch: { leafId: "a", entryIds: ["a"] },
    summary: "Derived summary only.",
    ...overrides,
  };
}

test("exact mirrored sidecar returns derived summary metadata, never raw session fields", () => {
  const options = roots();
  const session = {
    id: "s1",
    source: join(options.sessionRoot, "cwd", "s1.jsonl"),
    lastMessageAt: "2026-01-01T00:01:00Z",
  };
  const path = rarebitMaterializationPath(session.source, options);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record("not-s1"))}\n${JSON.stringify(record("s1"))}\n`);

  const detail = readSessionRarebitSummary(session, options);
  assert.equal(detail.availability, "available");
  assert.equal(detail.status, "ok");
  assert.equal(detail.summary, "Derived summary only.");
  assert.equal(detail.selection.occurrenceCount, 1);
  assert.equal(detail.selection.uniquePayloadCount, 1);
  assert.equal(JSON.stringify(detail).includes("RAW_SESSION_PROSE"), false);
  assert.equal("sessionFile" in detail, false);
});

test("detail makes missing, stale, ineligible, overflow, and failure explicit", () => {
  const options = roots();
  const session = {
    id: "s1",
    source: join(options.sessionRoot, "cwd", "s1.jsonl"),
    lastMessageAt: "2026-01-01T00:03:00Z",
  };
  assert.deepEqual(readSessionRarebitSummary(session, options), {
    availability: "missing",
    reason: "sidecar_missing",
  });
  const path = rarebitMaterializationPath(session.source, options);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record("s1"))}\n`);
  assert.equal(readSessionRarebitSummary(session, options).availability, "stale");
  writeFileSync(
    path,
    `${JSON.stringify(record("s1", "ineligible", { summary: undefined, observedAt: "2026-01-01T00:03:00Z" }))}\n`,
  );
  assert.equal(readSessionRarebitSummary(session, options).status, "ineligible");
  writeFileSync(path, `${JSON.stringify(record("s1", "unavailable_overflow"))}\n`);
  assert.equal(readSessionRarebitSummary(session, options).availability, "unavailable");
  writeFileSync(
    path,
    `${JSON.stringify(record("s1", "failure", { error: { name: "Timeout", message: "RAW_SESSION_PROSE" } }))}\n`,
  );
  const failure = readSessionRarebitSummary(session, options);
  assert.deepEqual(failure.failure, { retryable: false, kind: "Timeout" });
  assert.equal(JSON.stringify(failure).includes("RAW_SESSION_PROSE"), false);
});

test("same-branch eligibility checks do not replace synthesis outcomes", () => {
  const options = roots();
  const session = {
    id: "s1",
    source: join(options.sessionRoot, "cwd", "s1.jsonl"),
    lastMessageAt: "2026-01-01T00:01:00Z",
  };
  const path = rarebitMaterializationPath(session.source, options);
  mkdirSync(join(path, ".."), { recursive: true });
  const summary = record("s1", "ok", {
    observedAt: "2026-01-01T00:01:00Z",
    branch: { leafId: "same-leaf", entryIds: ["same-leaf"] },
  });
  const resumedEligibilityCheck = record("s1", "ineligible", {
    summary: undefined,
    observedAt: "2026-01-01T00:02:00Z",
    branch: { leafId: "same-leaf", entryIds: ["same-leaf"] },
  });
  writeFileSync(path, `${JSON.stringify(summary)}\n${JSON.stringify(resumedEligibilityCheck)}\n`);
  const preserved = readSessionRarebitSummary(session, options);
  assert.equal(preserved.status, "ok");
  assert.equal(preserved.summary, "Derived summary only.");

  const failure = record("s1", "failure", {
    summary: undefined,
    observedAt: "2026-01-01T00:03:00Z",
    branch: { leafId: "same-leaf", entryIds: ["same-leaf"] },
    error: { name: "ProviderFailure" },
  });
  writeFileSync(
    path,
    `${JSON.stringify(summary)}\n${JSON.stringify(failure)}\n${JSON.stringify(resumedEligibilityCheck)}\n`,
  );
  const explicitFailure = readSessionRarebitSummary(session, options);
  assert.equal(explicitFailure.status, "failure");
  assert.deepEqual(explicitFailure.failure, {
    retryable: false,
    kind: "ProviderFailure",
  });

  const newBranchCheck = {
    ...resumedEligibilityCheck,
    branch: { leafId: "new-leaf", entryIds: ["same-leaf", "new-leaf"] },
  };
  writeFileSync(path, `${JSON.stringify(summary)}\n${JSON.stringify(newBranchCheck)}\n`);
  assert.equal(readSessionRarebitSummary(session, options).status, "ineligible");
});

test("source outside the native session root is not addressable", () => {
  assert.deepEqual(readSessionRarebitSummary({ id: "s1", source: "/tmp/untrusted/s1.jsonl" }), {
    availability: "missing",
    reason: "sidecar_not_addressable",
  });
});
