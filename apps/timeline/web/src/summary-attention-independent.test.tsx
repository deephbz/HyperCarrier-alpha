import { describe, expect, it } from "vitest";
import { summaryStatusPresentation } from "./model";
import type { RarebitSummaryStatusSource } from "./types";
const source: RarebitSummaryStatusSource = {
  jobId: "job",
  sessionId: "s",
  branchLeafId: "leaf",
  selectionManifestHash: "manifest",
  selectorVersion: "selector",
  lifecycleBoundary: "agent_settled",
  model: null,
  schemaVersion: 4,
  observedAt: "2026-07-26T00:00:00.000Z",
  promptVersion: "v4",
  implementationVersion: "test",
};
describe("Rarebit Summary status lane projection", () => {
  it("uses the serialized package presentation: only attention salience draws", () => {
    expect(
      summaryStatusPresentation({
        state: "available",
        status: "needs_attention",
        reason: "blocker",
        sourcePending: false,
        presentation: { mark: "◆!", label: "needs you", tone: "attention", salience: "attention" },
        source,
      }),
    ).toEqual({ label: "Rarebit Summary needs you", className: "lane-attention-needed" });
    expect(
      summaryStatusPresentation({
        state: "available",
        status: "finished",
        reason: null,
        sourcePending: false,
        presentation: {
          mark: null,
          label: "appears finished",
          tone: "neutral",
          salience: "ordinary",
        },
        source,
      }),
    ).toBeNull();
  });
});
