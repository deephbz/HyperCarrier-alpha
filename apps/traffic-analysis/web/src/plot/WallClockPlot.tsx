import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { MatrixWireProjection } from "../matrixTypes";
import {
  buildWallClockScene,
  wallClockMinHeight,
} from "./scene/WallClockScene";

export type UtcWindow = { startMs: number; endMs: number };
export type RendererName = "plotly" | "echarts";
export type WallClockPlotProps = {
  projection: MatrixWireProjection;
  /** This remains unfiltered on narrow screens: it alone defines global compressed gaps. */
  globalGapProjection?: MatrixWireProjection;
  renderer?: RendererName;
  selectedEventRef: string | null;
  onHover: (eventRef: string | null) => void;
  onSelect: (eventRef: string) => void;
  onWindowChange: (window: UtcWindow) => void;
};

const ECharts = lazy(() =>
  import("./scene/EChartsRenderer").then((module) => ({
    default: module.EChartsRenderer,
  })),
);
const Plotly = lazy(() =>
  import("./scene/PlotlyRenderer").then((module) => ({
    default: module.PlotlyRenderer,
  })),
);

export const wheelZoomWindow = (
  pointerMs: number,
  deltaY: number,
  current: UtcWindow,
  bounds: UtcWindow,
): UtcWindow => {
  const span = Math.max(1, current.endMs - current.startMs);
  // Browser convention: wheel-up (negative delta) zooms in, wheel-down zooms out.
  const nextSpan = span * (deltaY < 0 ? 0.75 : 1.25);
  const pointer = Math.min(current.endMs, Math.max(current.startMs, pointerMs));
  const fraction = (pointer - current.startMs) / span;
  let startMs = Math.round(pointer - fraction * nextSpan);
  let endMs = Math.round(startMs + nextSpan);
  if (startMs < bounds.startMs) {
    endMs += bounds.startMs - startMs;
    startMs = bounds.startMs;
  }
  if (endMs > bounds.endMs) {
    startMs -= endMs - bounds.endMs;
    endMs = bounds.endMs;
  }
  return {
    startMs: Math.max(bounds.startMs, startMs),
    endMs: Math.min(bounds.endMs, endMs),
  };
};
export const boundedWindow = (
  window: UtcWindow,
  bounds: UtcWindow,
): UtcWindow => {
  const span = Math.min(
    bounds.endMs - bounds.startMs,
    Math.max(1, window.endMs - window.startMs),
  );
  const startMs = Math.min(
    bounds.endMs - span,
    Math.max(bounds.startMs, Math.round(window.startMs)),
  );
  return { startMs, endMs: startMs + span };
};

export const panWindow = (
  offsetMs: number,
  current: UtcWindow,
  bounds: UtcWindow,
): UtcWindow =>
  boundedWindow(
    {
      startMs: current.startMs + offsetMs,
      endMs: current.endMs + offsetMs,
    },
    bounds,
  );

const utc = (ms: number) =>
  new Date(ms).toISOString().replace("T", " ").replace(".000Z", " UTC");

/** Shared controls and scene are outside renderer adapters. */
export function WallClockPlot({
  projection,
  globalGapProjection = projection,
  renderer = "echarts",
  selectedEventRef,
  onHover,
  onSelect,
  onWindowChange,
}: WallClockPlotProps) {
  const root = useRef<HTMLDivElement>(null);
  // Gesture identity survives hover-driven renderer/effect rebinds until mouseup commits it.
  const middleDrag = useRef<{ startY: number; startWindow: UtcWindow } | null>(
    null,
  );
  const minPlotWidth = Math.max(720, projection.columns.length * 160 + 76 + 22);
  const [width, setWidth] = useState(minPlotWidth);
  const window = projection.coverage.currentWindow;
  const bounds = projection.coverage.initialWindow;
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setWidth(Math.max(minPlotWidth, element.clientWidth)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [minPlotWidth]);
  const scene = useMemo(
    () =>
      buildWallClockScene(
        projection,
        globalGapProjection,
        Math.max(minPlotWidth, width),
        wallClockMinHeight,
      ),
    [globalGapProjection, projection, width],
  );
  const Renderer = renderer === "plotly" ? Plotly : ECharts;
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const surfaceAt = (target: EventTarget | null) =>
      target instanceof Element && target.closest(".scene-chart");
    // React delegates wheel passively in Chromium; every renderer receives this native route.
    const wheel = (event: WheelEvent) => {
      const surface = surfaceAt(event.target);
      if (event.deltaY === 0 || !surface) return;
      const rect = surface.getBoundingClientRect();
      const y =
        ((event.clientY - rect.top) * scene.height) / Math.max(1, rect.height);
      event.preventDefault();
      onWindowChange(
        wheelZoomWindow(scene.toUtc(y), event.deltaY, window, bounds),
      );
    };
    const mouseDown = (event: MouseEvent) => {
      if (event.button !== 1 || !surfaceAt(event.target)) return;
      // Capture precedes Plotly/D3's surface handlers and suppresses autoscroll.
      event.preventDefault();
      event.stopPropagation();
      middleDrag.current = { startY: event.clientY, startWindow: window };
    };
    const mouseUp = (event: MouseEvent) => {
      const drag = middleDrag.current;
      if (!drag || event.button !== 1) return;
      event.preventDefault();
      const surface = element.querySelector<HTMLElement>(".scene-chart");
      const rect = surface?.getBoundingClientRect();
      if (rect) {
        const startUtc = scene.toUtc(
          ((drag.startY - rect.top) * scene.height) / Math.max(1, rect.height),
        );
        const endUtc = scene.toUtc(
          ((event.clientY - rect.top) * scene.height) /
            Math.max(1, rect.height),
        );
        // Commit only on release: dragging cannot flood the projection API.
        onWindowChange(panWindow(startUtc - endUtc, drag.startWindow, bounds));
      }
      middleDrag.current = null;
    };
    const suppressMiddleGesture = (event: MouseEvent) => {
      if (event.button === 1) event.preventDefault();
    };
    const releaseTarget = element.ownerDocument.defaultView;
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("mousedown", mouseDown, true);
    // Window capture receives release even if a renderer re-parents or swallows its surface event.
    releaseTarget?.addEventListener("mouseup", mouseUp, true);
    element.addEventListener("auxclick", suppressMiddleGesture, true);
    element.addEventListener("contextmenu", suppressMiddleGesture, true);
    return () => {
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("mousedown", mouseDown, true);
      releaseTarget?.removeEventListener("mouseup", mouseUp, true);
      element.removeEventListener("auxclick", suppressMiddleGesture, true);
      element.removeEventListener("contextmenu", suppressMiddleGesture, true);
    };
  }, [bounds, onWindowChange, scene, window]);
  return (
    <div
      ref={root}
      className="svg-wall-clock"
      role="region"
      aria-label="Agent-by-time evidence matrix"
      data-renderer={renderer}
      style={{ minWidth: minPlotWidth }}
    >
      <div className="svg-wall-clock-controls" aria-label="Wall-clock controls">
        <button type="button" onClick={() => onWindowChange(bounds)}>
          Reset
        </button>
        <span className="interaction-hint">
          Wheel up zooms in · wheel down zooms out · middle-drag pans UTC
        </span>
        <output>
          {utc(window.startMs)} → {utc(window.endMs)}
        </output>
      </div>
      <Suspense
        fallback={<p className="muted">Loading {renderer} renderer…</p>}
      >
        <Renderer
          scene={scene}
          selectedEventRef={selectedEventRef}
          onHover={onHover}
          onSelect={onSelect}
          onWindowChange={(next) => onWindowChange(boundedWindow(next, bounds))}
          onResetWindow={() => onWindowChange(bounds)}
        />
      </Suspense>
    </div>
  );
}
