import {
  buildGlyphs,
  projectionGlobalGaps,
  type GlyphSpec,
} from "../../glyph/buildGlyphs";
import type { MatrixWireProjection } from "../../matrixTypes";
import { agentSublanes, type AgentSublanes } from "../../scale/agentSublanes";
import { CompressedTimeMap, type DisplayTick } from "../../timeMap";

export type WallClockScene = {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
  lanes: readonly (AgentSublanes & { label: string })[];
  ticks: readonly DisplayTick[];
  breakBands: ReturnType<CompressedTimeMap["breakBands"]>;
  glyphs: readonly GlyphSpec[];
  accessibilityOrder: readonly GlyphSpec[];
  /** Rendering-only inverse mapper for common wheel interaction; no adapter derives time geometry. */
  toUtc: (y: number) => number;
};

export const wallClockMargin = { top: 42, right: 22, bottom: 24, left: 76 };
export const wallClockMinHeight = 504;

/** The sole projection-to-geometry boundary. Renderer adapters receive this display-only scene. */
export const buildWallClockScene = (
  projection: MatrixWireProjection,
  globalGapProjection: MatrixWireProjection,
  width: number,
  height = wallClockMinHeight,
): WallClockScene => {
  const lanes = agentSublanes(
    projection.columns.map((column) => column.agentRef),
    wallClockMargin.left,
    width - wallClockMargin.right,
  ).map((lane) => ({
    ...lane,
    label:
      projection.columns.find((column) => column.agentRef === lane.agentRef)
        ?.header.label ?? lane.agentRef,
  }));
  const window = projection.coverage.currentWindow;
  const mapper = new CompressedTimeMap(
    window.startMs,
    window.endMs,
    wallClockMargin.top,
    height - wallClockMargin.bottom,
    projectionGlobalGaps(globalGapProjection),
  );
  const glyphs = buildGlyphs(projection, lanes, mapper.toY.bind(mapper));
  return {
    width,
    height,
    margin: wallClockMargin,
    lanes,
    ticks: mapper.ticks(),
    breakBands: mapper.breakBands(),
    glyphs,
    accessibilityOrder: glyphs.filter((glyph) => glyph.eventRef !== null),
    toUtc: mapper.toUtc.bind(mapper),
  };
};

export { glyphStyle } from "./visualStyle";
