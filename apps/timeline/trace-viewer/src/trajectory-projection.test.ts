import { describe, expect, it } from "vitest";

import {
  clampTraceRange,
  normalizeTraceQuery,
  reconcileTraceRange,
  recordMatchesNormalizedTraceQuery,
  recordWithinTraceRange,
  traceBounds,
  traceTransition,
} from "./trajectory-projection";
import type { TraceRecord } from "./types";

function record(order: number, text = "trace evidence"): TraceRecord {
  return {
    recordId: `entry:${order}`,
    sourceEntryId: `${order}`,
    order,
    kind: "message",
    lane: "input",
    label: "User message",
    turn: 1,
    step: null,
    timestamp: null,
    text,
    rarebit: false,
    details: {},
    unavailable: {},
    raw: {},
  };
}

describe("Pi trace trajectory projection", () => {
  it("keeps persisted active-branch bounds when scope is sparse", () => {
    expect(traceBounds([record(4), record(8)])).toEqual({ start: 0, end: 9 });
  });

  it("clamps a focus range to whole active-branch ordinals", () => {
    expect(clampTraceRange({ start: -4.2, end: 99.1 }, { start: 0, end: 9 })).toEqual({
      start: 0,
      end: 9,
    });
    expect(clampTraceRange({ start: 8.8, end: 8.8 }, { start: 0, end: 9 })).toEqual({
      start: 8,
      end: 9,
    });
  });

  it("uses search and focus as emphasis predicates", () => {
    const matched = record(4, "Find this record");
    const other = record(8, "Other context");

    expect(normalizeTraceQuery(" FIND ")).toBe("find");
    expect(recordMatchesNormalizedTraceQuery(matched, "find")).toBe(true);
    expect(recordMatchesNormalizedTraceQuery(other, "find")).toBe(false);
    expect(recordWithinTraceRange(matched, { start: 4, end: 5 })).toBe(true);
    expect(recordWithinTraceRange(other, { start: 4, end: 5 })).toBe(false);
  });

  it("classifies an ordinal-preserving update as an append", () => {
    const previous = [record(0), record(1)];
    const next = [...previous, record(2)];

    expect(traceTransition(null, next)).toBe("initial");
    expect(traceTransition(previous, next)).toBe("append");
    expect(reconcileTraceRange({ start: 0, end: 2 }, next, "append")).toEqual({
      start: 0,
      end: 2,
    });
  });

  it("resets ordinal-only focus when a branch replaces its active records", () => {
    const previous = [record(0), record(1), record(2)];
    const next = [record(0), { ...record(1), recordId: "entry:replacement" }];

    expect(traceTransition(previous, next)).toBe("reset");
    expect(reconcileTraceRange({ start: 1, end: 3 }, next, "reset")).toBeNull();
    expect(traceBounds(next)).toEqual({ start: 0, end: 2 });
  });
});
