import { describe, expect, it } from "vitest";

import {
  adjacentSelectableRecord,
  clampTraceRange,
  normalizeTraceQuery,
  ordinalCellGeometry,
  overviewColumnAtClientX,
  overviewMatchRatio,
  reconcileTraceRange,
  recordMatchesNormalizedTraceQuery,
  recordSemanticTag,
  recordWithinTraceRange,
  selectableRecordAtColumn,
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

  it("maps the pointer to the drawn overview pixel column", () => {
    expect(overviewColumnAtClientX(0, 0, 100)).toBe(0);
    expect(overviewColumnAtClientX(99, 0, 100)).toBe(99);
    expect(overviewColumnAtClientX(100, 0, 100)).toBe(99);
    expect(overviewColumnAtClientX(-5, 0, 100)).toBe(0);
  });

  it("selects the drawn cell, keeping a dense Rarebit reachable", () => {
    // At dense zoom the span (1000) exceeds the columns (100), so a cell
    // collapses to one pixel. A Rarebit sharing that pixel stays selectable.
    const dense = { start: 0, end: 1000 };
    const rarebit = { order: 500 };
    expect(ordinalCellGeometry(rarebit.order, dense, 100)).toEqual({ start: 50, end: 50 });
    expect(selectableRecordAtColumn([rarebit], 50, dense, 100)).toEqual(rarebit);
    expect(selectableRecordAtColumn([rarebit], 51, dense, 100)).toBeNull();

    // A sparse cell spans its rounded edges and the right boundary is included.
    const sparse = { start: 0, end: 3 };
    expect(ordinalCellGeometry(1, sparse, 10)).toEqual({ start: 3, end: 7 });
    expect(selectableRecordAtColumn([{ order: 1 }], 4, sparse, 10)).toEqual({ order: 1 });
    expect(selectableRecordAtColumn([{ order: 1 }], 7, sparse, 10)).toBeNull();
  });

  it("moves chronologically from the selected ordinal and skips ineligible marks", () => {
    const records = [record(0), record(1), record(2), record(3)].map((item) => ({
      order: item.order,
      recordId: item.recordId,
    }));
    const rarebits = [records[1], records[3]];

    expect(adjacentSelectableRecord(records, rarebits, records[0].recordId, 1)).toEqual(
      rarebits[0],
    );
    expect(adjacentSelectableRecord(records, rarebits, records[1].recordId, 1)).toEqual(
      rarebits[1],
    );
    expect(adjacentSelectableRecord(records, rarebits, records[3].recordId, 1)).toBeNull();
    expect(adjacentSelectableRecord(records, rarebits, null, 1)).toEqual(rarebits[0]);
    expect(adjacentSelectableRecord(records, rarebits, rarebits[1].recordId, -1)).toEqual(
      rarebits[0],
    );
  });

  it("weights dense pixels by matching Rarebits instead of unrelated records", () => {
    expect(overviewMatchRatio(101, 1, 1)).toBe(1);
    expect(overviewMatchRatio(100, 0, 0)).toBe(0);
    expect(overviewMatchRatio(100, 18, 0)).toBeCloseTo(0.18);
  });

  it("tiles visible ordinal cells at shared rounded boundaries", () => {
    const domain = { start: 0, end: 3 };

    expect(ordinalCellGeometry(0, domain, 10)).toEqual({ start: 0, end: 3 });
    expect(ordinalCellGeometry(1, domain, 10)).toEqual({ start: 3, end: 7 });
    expect(ordinalCellGeometry(2, domain, 10)).toEqual({ start: 7, end: 10 });
  });

  it("clips or aggregates ordinal cells without widening a false interval", () => {
    expect(ordinalCellGeometry(1, { start: 2, end: 5 }, 12)).toBeNull();
    expect(ordinalCellGeometry(2, { start: 2, end: 5 }, 12)).toEqual({ start: 0, end: 4 });
    expect(ordinalCellGeometry(4, { start: 2, end: 5 }, 12)).toEqual({ start: 8, end: 12 });
    expect(ordinalCellGeometry(2, { start: 0, end: 5 }, 2)).toEqual({ start: 1, end: 1 });
  });

  it("projects role tags only from exact message kinds at their matching lane", () => {
    expect(recordSemanticTag({ ...record(0), kind: "input", lane: "input" })).toEqual({
      label: "USER",
      lane: "input",
    });
    expect(recordSemanticTag({ ...record(1), kind: "assistant", lane: "model" })).toEqual({
      label: "ASSISTANT",
      lane: "model",
    });
    expect(recordSemanticTag({ ...record(2), kind: "tool_result", lane: "tools" })).toEqual({
      label: "TOOL",
      lane: "tools",
    });
    expect(recordSemanticTag({ ...record(3), kind: "compaction", lane: "model" })).toBeNull();
    expect(recordSemanticTag({ ...record(4), kind: "custom", lane: "input" })).toBeNull();
    expect(recordSemanticTag({ ...record(5), kind: "input", lane: "model" })).toBeNull();
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
