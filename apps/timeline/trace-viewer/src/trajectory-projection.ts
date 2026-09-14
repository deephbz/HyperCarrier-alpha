/*
 * Adapted from DeepSeek Harness Trajectory at
 * deepseek-ai/deepseek-harness@99f6f02fecdb7dff40c3fbc9470f5907c29f74ca
 * (MIT; see ../UPSTREAM-NOTICE.md). This keeps the three-lane trace
 * projection while using HyperCarrier's Pi trace record contract.
 */

import type { TraceLane, TraceRecord } from "./types";

const semanticTagByKind: Readonly<
  Record<string, { readonly label: string; readonly lane: TraceLane }>
> = {
  input: { label: "USER", lane: "input" },
  assistant: { label: "ASSISTANT", lane: "model" },
  tool_result: { label: "TOOL", lane: "tools" },
};

/** A half-open, active-branch ordinal range. It is presentation state, not Pi evidence. */
export interface TraceRange {
  readonly start: number;
  readonly end: number;
}

export type TraceTransition = "initial" | "append" | "reset";

/** Active-branch ordinal bounds are the stable coordinate for presentation state. */
export function traceBounds(records: readonly TraceRecord[]): TraceRange | null {
  if (records.length === 0) return null;
  return { start: 0, end: Math.max(...records.map((record) => record.order + 1)) };
}

/** An append retains every prior active-branch record at its exact ordinal. */
export function traceTransition(
  previous: readonly TraceRecord[] | null,
  next: readonly TraceRecord[],
): TraceTransition {
  if (previous === null) return "initial";
  return previous.length <= next.length &&
    previous.every(
      (record, index) =>
        record.recordId === next[index]?.recordId && record.order === next[index]?.order,
    )
    ? "append"
    : "reset";
}

/** A range names branch order, so a reset must not project it onto a new branch. */
export function reconcileTraceRange(
  range: TraceRange | null,
  records: readonly TraceRecord[],
  transition: TraceTransition,
): TraceRange | null {
  const bounds = traceBounds(records);
  if (range === null || bounds === null || transition === "reset") return null;
  return clampTraceRange(range, bounds);
}

/** Clamp an ordinal focus or viewport to one or more whole trace records. */
export function clampTraceRange(range: TraceRange, bounds: TraceRange): TraceRange {
  const minimum = Math.min(bounds.end - 1, Math.max(bounds.start, Math.floor(range.start)));
  const maximum = Math.max(minimum + 1, Math.min(bounds.end, Math.ceil(range.end)));
  if (maximum <= bounds.end) return { start: minimum, end: maximum };
  return { start: Math.max(bounds.start, bounds.end - 1), end: bounds.end };
}

/** Rounded shared pixel edges preserve exact ordinal-cell boundaries without implying duration. */
export interface OrdinalCellGeometry {
  readonly end: number;
  readonly start: number;
}

/** Dense overview opacity follows matching Rarebits, not unrelated records in one pixel. */
export function overviewMatchRatio(total: number, matches: number, rarebits: number): number {
  if (
    !Number.isFinite(total) ||
    total <= 0 ||
    !Number.isFinite(matches) ||
    !Number.isFinite(rarebits)
  )
    return 0;
  const denominator = rarebits > 0 ? rarebits : total;
  return Math.min(1, Math.max(0, matches / denominator));
}

/** One drawn pixel column; the dense path uses ceil(width) one-pixel buckets. */
export function overviewColumnAtClientX(
  clientX: number,
  left: number,
  width: number,
): number | null {
  if (!Number.isFinite(clientX) || !Number.isFinite(left) || !Number.isFinite(width)) return null;
  const columns = Math.max(1, Math.ceil(width));
  if (columns <= 0) return null;
  const fraction = Math.min(1, Math.max(0, (clientX - left) / Math.max(1, width)));
  return Math.min(columns - 1, Math.floor(fraction * columns));
}

/**
 * A hit follows the drawn cell, so a dense Rarebit-containing pixel stays
 * selectable even when floor(inverse ordinal) lands on its non-Rarebit neighbor.
 */
export function selectableRecordAtColumn<T extends { readonly order: number }>(
  selectable: readonly T[],
  column: number,
  domain: TraceRange,
  columns: number,
): T | null {
  if (!Number.isFinite(column) || !Number.isFinite(columns) || columns <= 0) return null;
  for (const record of selectable) {
    const cell = ordinalCellGeometry(record.order, domain, columns);
    if (cell === null) continue;
    if (column >= cell.start && column < Math.max(cell.start + 1, cell.end)) return record;
  }
  return null;
}

/**
 * Arrow keys move from the selected record's branch ordinal and skip marks that
 * are not selectable in the current mode, so bounds stay stable.
 */
export function adjacentSelectableRecord<
  T extends { readonly recordId: string; readonly order: number },
>(
  records: readonly T[],
  selectable: readonly T[],
  selectedId: string | null,
  direction: -1 | 1,
): T | null {
  if (records.length === 0) return null;
  const selectableIds = new Set(selectable.map((record) => record.recordId));
  const start = selectedId === null ? -1 : records.findIndex((r) => r.recordId === selectedId);
  for (let index = start + direction; index >= 0 && index < records.length; index += direction) {
    const candidate = records[index];
    if (selectableIds.has(candidate.recordId)) return candidate;
  }
  return null;
}

export function ordinalCellGeometry(
  order: number,
  domain: TraceRange,
  width: number,
): OrdinalCellGeometry | null {
  if (!Number.isFinite(order) || !Number.isFinite(width) || width <= 0) return null;
  const span = domain.end - domain.start;
  if (!Number.isFinite(span) || span <= 0) return null;
  const startOrder = Math.max(domain.start, order);
  const endOrder = Math.min(domain.end, order + 1);
  if (startOrder >= endOrder) return null;
  const edge = (ordinal: number) =>
    Math.max(0, Math.min(width, Math.round(((ordinal - domain.start) / span) * width)));
  return { start: edge(startOrder), end: edge(endOrder) };
}

/** Normalize once per query, not once per active-branch record. */
export function normalizeTraceQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * A row tag repeats only an exact source-message role. Lanes remain display
 * coordinates, so non-message records never acquire an actor tag.
 */
export function recordSemanticTag(record: Pick<TraceRecord, "kind" | "lane">) {
  const tag = semanticTagByKind[record.kind];
  return tag?.lane === record.lane ? tag : null;
}

/** A search highlight keeps all trace evidence in the ledger and overview. */
export function recordMatchesNormalizedTraceQuery(
  record: TraceRecord,
  normalizedQuery: string,
): boolean {
  return (
    normalizedQuery === "" ||
    `${record.label}\n${record.text}`.toLowerCase().includes(normalizedQuery)
  );
}

/** Focus is an emphasis relation. It is not a filter. */
export function recordWithinTraceRange(record: TraceRecord, range: TraceRange | null): boolean {
  return range === null || (record.order >= range.start && record.order < range.end);
}
