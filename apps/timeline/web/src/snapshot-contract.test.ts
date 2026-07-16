import { describe, expect, it } from "vitest";
import { demoSnapshot } from "./demo";
import { parseTimelineSnapshot, SnapshotCompatibilityError } from "./snapshot-contract";

describe("Timeline snapshot compatibility", () => {
  it("accepts the current complete projection", () => {
    const snapshot = demoSnapshot();
    expect(parseTimelineSnapshot(snapshot)).toBe(snapshot);
  });

  it("fails visibly for stale and structurally incomplete backends", () => {
    expect(() => parseTimelineSnapshot({ sourceVersion: 1, keyMessages: [] })).toThrow(
      /legacy\/unversioned/,
    );
    expect(() => parseTimelineSnapshot({ ...demoSnapshot(), rarebits: undefined })).toThrow(
      /missing required rarebits evidence/,
    );
    expect(() => parseTimelineSnapshot(null)).toThrow(SnapshotCompatibilityError);
  });
});
