import type { MatrixMark, MatrixWireProjection } from "../matrixTypes";
import type { AgentSublanes } from "../scale/agentSublanes";
import type { GlobalGap } from "../timeMap";

export type GlyphRole =
  | "user_boundary"
  | "request_interval"
  | "request_outcome"
  | "tool_span"
  | "quiet_after_stop"
  | "global_break";
export type DisplayRole =
  | "user_boundary"
  | "request_interval"
  | "response_outcome"
  | "tool_observation"
  | "quiet_after_stop"
  | "global_break";

export type GlyphSpec = {
  key: string;
  /** Typed presentation role, never inferred from a human-readable label. */
  displayRole: DisplayRole;
  role: GlyphRole;
  eventRef: string | null;
  agentRef: string | null;
  x: number | null;
  /** An interaction-only offset inside the observed B zone; visible marks stay on x. */
  hitX: number | null;
  y1: number;
  y2: number;
  mark: MatrixMark;
  label: string;
};

const yFor = (toY: (utcMs: number) => number, ms: number | null) =>
  toY(ms ?? 0);

/**
 * Converts already-prepared display facts into rendering geometry only. A request
 * has two independent display roles but one backend authority `eventRef`.
 */
export const buildGlyphs = (
  projection: MatrixWireProjection,
  sublanes: readonly AgentSublanes[],
  toY: (utcMs: number) => number,
): GlyphSpec[] => {
  const lanes = new Map(sublanes.map((lane) => [lane.agentRef, lane]));
  const glyphs: Array<Omit<GlyphSpec, "displayRole">> = [];
  for (const mark of projection.marks) {
    if (mark.rowType === "global_quiet_gap") {
      glyphs.push({
        key: `break:${mark.eventRef}`,
        role: "global_break",
        eventRef: mark.eventRef,
        agentRef: null,
        x: null,
        hitX: null,
        y1: yFor(toY, mark.startMs),
        y2: yFor(toY, mark.endMs),
        mark,
        label: "Global quiet break",
      });
      continue;
    }
    if (!mark.agentRef) continue;
    const lane = lanes.get(mark.agentRef);
    if (!lane) continue;
    const start = yFor(toY, mark.startMs);
    const end = yFor(toY, mark.endMs ?? mark.startMs);
    if (mark.rowType === "turn") {
      glyphs.push({
        key: `boundary:${mark.eventRef}`,
        role: "user_boundary",
        eventRef: mark.eventRef,
        agentRef: mark.agentRef,
        x: lane.boundaryX,
        hitX: lane.boundaryX,
        y1: start,
        y2: start,
        mark,
        label: mark.label,
      });
    } else if (mark.rowType === "request_interval") {
      glyphs.push({
        key: `request:${mark.eventRef}`,
        role: "request_interval",
        eventRef: mark.eventRef,
        agentRef: mark.agentRef,
        x: lane.observedX,
        hitX: lane.observedX - 4,
        y1: start,
        y2: end,
        mark,
        label: mark.label,
      });
      glyphs.push({
        key: `outcome:${mark.eventRef}`,
        role: "request_outcome",
        eventRef: mark.eventRef,
        agentRef: mark.agentRef,
        x: lane.boundaryX,
        hitX: lane.boundaryX,
        y1: end,
        y2: end,
        mark,
        label: mark.label,
      });
    } else if (mark.rowType === "tool_observation_span") {
      glyphs.push({
        key: `tool:${mark.eventRef}`,
        role: "tool_span",
        eventRef: mark.eventRef,
        agentRef: mark.agentRef,
        x: lane.observedX,
        hitX: lane.observedX + 4,
        y1: start,
        y2: end,
        mark,
        label: mark.label,
      });
    } else if (mark.rowType === "quiet_gap") {
      glyphs.push({
        key: `quiet:${mark.eventRef}`,
        role: "quiet_after_stop",
        eventRef: mark.eventRef,
        agentRef: mark.agentRef,
        x: lane.boundaryX,
        hitX: lane.boundaryX,
        y1: start,
        y2: end,
        mark,
        label: mark.label,
      });
    }
  }
  return glyphs.map((glyph) => ({
    ...glyph,
    displayRole:
      glyph.role === "request_outcome"
        ? "response_outcome"
        : glyph.role === "tool_span"
          ? "tool_observation"
          : glyph.role,
  }));
};

export const projectionGlobalGaps = (
  projection: MatrixWireProjection,
): GlobalGap[] =>
  projection.marks
    .filter(
      (mark) =>
        mark.rowType === "global_quiet_gap" &&
        mark.endMs != null &&
        mark.endMs > mark.startMs,
    )
    .map((mark) => ({
      startMs: mark.startMs,
      endMs: mark.endMs!,
      hiddenMs: mark.endMs! - mark.startMs,
    }))
    .sort((left, right) => left.startMs - right.startMs);

/** Testable visual grammar: non-break lines are vertical and live on xA or xB. */
export const assertVerticalSublaneGrammar = (
  glyphs: readonly GlyphSpec[],
  sublanes: readonly AgentSublanes[],
) => {
  const positions = new Set(
    sublanes.flatMap((lane) => [lane.boundaryX, lane.observedX]),
  );
  for (const glyph of glyphs) {
    if (glyph.role === "global_break") continue;
    if (glyph.x == null || !positions.has(glyph.x))
      throw new Error(`glyph ${glyph.key} is outside a fixed sublane`);
    if (
      glyph.role === "request_interval" ||
      glyph.role === "tool_span" ||
      glyph.role === "quiet_after_stop"
    ) {
      // The sole line abscissa is deliberately represented once: renderers set x1=x2=glyph.x.
      if (!Number.isFinite(glyph.y1) || !Number.isFinite(glyph.y2))
        throw new Error(`glyph ${glyph.key} has invalid vertical geometry`);
    }
  }
};
