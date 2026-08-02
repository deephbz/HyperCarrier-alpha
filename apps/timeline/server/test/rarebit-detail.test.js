import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processRarebitSummary } from "@hypercarrier/rarebit";
import {
  projectRarebitSummaryStatus,
  readSessionRarebitSummary,
  sanitizeRarebitSummaryDetail,
} from "../rarebit-detail.js";
const assessmentRef = {
  jobId: "job-1",
  sessionId: "session-1",
  branchLeafId: "leaf-1",
  selectionManifestHash: "manifest-1",
  selectorVersion: "rarebit-selection-v1",
  lifecycleBoundary: "agent_settled",
  model: { provider: "openai", id: "model" },
  promptVersion: "summary-v4",
  implementationVersion: "impl-v4",
  observedAt: "2026-07-26T00:00:00.000Z",
  schemaVersion: 4,
};
function available(status, sourcePending = false) {
  return {
    availability: "available",
    status,
    reason: `${status}_reason`,
    sourcePending,
    assessmentRef,
    summary: "Summary prose is not status.",
  };
}
test("Timeline serializes the exact package assessmentRef and visual presentation", () => {
  for (const status of ["user_requested", "finished", "needs_attention", "ineligible", "error"]) {
    const projected = projectRarebitSummaryStatus(available(status));
    assert.equal(projected.status, status);
    assert.equal(projected.reason, `${status}_reason`);
    assert.deepEqual(projected.source, assessmentRef);
    assert.equal(
      projected.presentation.label,
      status === "needs_attention" ? "needs you" : projected.presentation.label,
    );
  }
});
test("source-pending removes package attention salience without reclassifying status", () => {
  const pending = projectRarebitSummaryStatus(available("needs_attention", true));
  assert.equal(pending.status, "needs_attention");
  assert.equal(pending.presentation.salience, "ordinary");
  const sanitized = sanitizeRarebitSummaryDetail(available("needs_attention"));
  assert.deepEqual(sanitized.summaryStatus.source, assessmentRef);
  assert.equal(sanitized.summaryStatus.presentation.salience, "attention");
});
test("an unaddressable Session source fails safely without a direct sidecar scan", async () => {
  assert.deepEqual(
    await readSessionRarebitSummary({ id: "s1", source: "/tmp/untrusted/s1.jsonl" }),
    { availability: "missing", reason: "sidecar_not_addressable" },
  );
});

test("Timeline reads the package current projection with bounded sidecar metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "timeline-rarebit-v4-"));
  const sessionRoot = join(root, "sessions");
  const rarebitRoot = join(root, "rarebit");
  const sessionDir = join(sessionRoot, "project");
  const sessionFile = join(sessionDir, "session.jsonl");
  const sessionId = "timeline-current";
  const branch = [
    {
      type: "message",
      id: "owner",
      parentId: null,
      message: { role: "user", content: "Summarize this Session." },
    },
  ];
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    sessionFile,
    [JSON.stringify({ type: "session", id: sessionId }), ...branch.map(JSON.stringify)].join("\n") +
      "\n",
  );
  const session = { id: sessionId, source: sessionFile };
  const missing = await readSessionRarebitSummary(session, {
    sessionRoot,
    rarebitRoot,
  });
  assert.equal(missing.availability, "missing");
  assert.equal(missing.sidecar.head, null);

  await processRarebitSummary(
    {
      sessionManager: {
        getHeader: () => ({ id: sessionId }),
        getSessionFile: () => sessionFile,
        getBranch: () => branch,
      },
    },
    {
      sessionRoot,
      rarebitRoot,
      forceSynthesis: true,
      model: { provider: "test", id: "model" },
      modelClient: {
        complete: async () =>
          JSON.stringify({
            summary: "The Session appears finished.",
            sessionStatus: "finished",
            statusReason: "all_requests_accomplished",
          }),
      },
    },
  );
  const detail = await readSessionRarebitSummary(session, {
    sessionRoot,
    rarebitRoot,
  });
  assert.equal(detail.availability, "available");
  assert.equal(detail.status, "finished");
  assert.equal(detail.syncState, "assessment_current");
  assert.equal(detail.selection.occurrenceCount, 1);
  assert.equal(detail.provenance.model.provider, "test");
  assert.equal(detail.sidecar.head.receiptOffset, 0);
  assert.equal(detail.sidecar.head.receiptHash.length, 64);
});
