import assert from "node:assert/strict";
import test from "node:test";

import { projectRarebitSessionActivity } from "../src/rarebit-activity.mjs";

const occurrence = (overrides = {}) => ({
  sourceEntryId: "entry",
  role: "user",
  outcome: "user",
  timestamp: "2026-07-26T12:00:00.000Z",
  ...overrides,
});

test("activity projection preserves the latest selected user and stop in branch order", () => {
  const activity = projectRarebitSessionActivity({
    manifest: { selectorVersion: "rarebit-selector-v1" },
    manifestHash: "selection-hash",
    occurrences: [
      occurrence({
        sourceEntryId: "user-1",
        timestamp: "2026-07-26T12:00:00.000Z",
      }),
      occurrence({
        sourceEntryId: "stop-1",
        role: "assistant",
        outcome: "stop",
        timestamp: "2026-07-26T12:01:00.000Z",
      }),
      occurrence({
        sourceEntryId: "user-2",
        timestamp: "2026-07-26T12:02:00.000Z",
      }),
      occurrence({
        sourceEntryId: "continuation",
        role: "assistant",
        outcome: "continuation",
        timestamp: "2026-07-26T12:03:00.000Z",
      }),
    ],
  });

  assert.deepEqual(activity, {
    schemaVersion: 1,
    selectorVersion: "rarebit-selector-v1",
    selectionManifestHash: "selection-hash",
    latestUser: {
      sourceEntryId: "user-2",
      timestamp: "2026-07-26T12:02:00.000Z",
    },
    latestAgentStop: {
      sourceEntryId: "stop-1",
      timestamp: "2026-07-26T12:01:00.000Z",
    },
  });
});

test("activity projection never falls back from a latest missing timestamp", () => {
  const activity = projectRarebitSessionActivity({
    occurrences: [
      occurrence({
        sourceEntryId: "old-user",
        timestamp: "2026-07-26T12:00:00.000Z",
      }),
      occurrence({ sourceEntryId: "new-user", timestamp: null }),
      occurrence({
        sourceEntryId: "stop-without-time",
        role: "assistant",
        outcome: "stop",
        timestamp: null,
      }),
    ],
  });

  assert.deepEqual(activity.latestUser, {
    sourceEntryId: "new-user",
    timestamp: null,
  });
  assert.deepEqual(activity.latestAgentStop, {
    sourceEntryId: "stop-without-time",
    timestamp: null,
  });
});
