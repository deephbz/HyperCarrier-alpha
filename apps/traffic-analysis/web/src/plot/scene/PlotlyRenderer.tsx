import { useEffect, useRef } from "react";
import Plotly from "plotly.js-dist-min";
import { glyphStyle, trafficPalette } from "./visualStyle";
import type { WallClockScene } from "./WallClockScene";
import type { SceneRendererProps } from "./types";

/** Plotly keeps the lane axis fixed but exposes conventional y navigation through the shared UTC owner. */
export const plotlyViewportInteraction = {
  dragmode: "pan",
  xaxis: { fixedrange: true },
  yaxis: { fixedrange: false },
  displayModeBar: true,
};

export const plotlyCoordinateUtc = (
  toUtc: (coordinate: number) => number,
  sceneHeight: number,
  coordinate: number,
) => {
  if (coordinate >= 0 && coordinate <= sceneHeight) return toUtc(coordinate);
  const start = toUtc(0);
  const end = toUtc(sceneHeight);
  // Plotly Zoom out can ask beyond the visible scene; extrapolate instead of
  // re-clamping to the current narrowed window, then let the shared owner bound it.
  return start + (coordinate / sceneHeight) * (end - start);
};

export const plotlyRangeWindow = (
  toUtc: (coordinate: number) => number,
  sceneHeight: number,
  range: readonly [number, number],
) => {
  const first = plotlyCoordinateUtc(toUtc, sceneHeight, range[0]);
  const second = plotlyCoordinateUtc(toUtc, sceneHeight, range[1]);
  return { startMs: Math.min(first, second), endMs: Math.max(first, second) };
};

/**
 * Plotly attaches its modebar to the scene-wide canvas. Keep its local x
 * coordinate aligned with the scroll viewport, so a modebar action never
 * requires moving the lane/time annotations out of view.
 */
export const modebarViewportLeft = (
  scrollLeft: number,
  viewportWidth: number,
  modebarWidth: number,
) => Math.max(8, scrollLeft + viewportWidth - modebarWidth - 8);

/** Agent identity is a fixed categorical x axis, not an annotation that y zoom can discard. */
export const plotlyLaneAxis = (lanes: WallClockScene["lanes"]) => ({
  visible: true,
  showgrid: false,
  ticks: "",
  side: "top",
  tickmode: "array" as const,
  tickvals: lanes.map((lane) => (lane.bandLeft + lane.bandRight) / 2),
  ticktext: lanes.map((lane) => lane.label),
  ...plotlyViewportInteraction.xaxis,
});

/** Plotly receives the same ordered, typed scene as ECharts; chronology is not paint order. */
export function PlotlyRenderer(props: SceneRendererProps) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef(props);
  const handlersBound = useRef(false);
  const modebarPositioner = useRef<(() => void) | null>(null);
  const modebarScrollContainer = useRef<HTMLElement | null>(null);
  callbacks.current = props;
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const plotHost = element as HTMLDivElement & {
      on: (event: string, callback: (event: any) => void) => void;
    };
    const glyphs = props.scene.glyphs
      .filter((glyph) => glyph.role !== "global_break" && glyph.x != null)
      .sort(
        (a, b) =>
          glyphStyle(a).z - glyphStyle(b).z || a.key.localeCompare(b.key),
      );
    const data = glyphs.flatMap((glyph) => {
      const style = glyphStyle(glyph);
      const point = style.symbol !== "line";
      const coordinates = {
        x: point ? [glyph.x] : [glyph.x, glyph.x],
        y: point ? [glyph.y1] : [glyph.y1, glyph.y2],
      };
      const base = {
        type: "scatter",
        mode: point ? "markers" : "lines",
        ...coordinates,
        customdata: point ? [glyph.eventRef] : [glyph.eventRef, glyph.eventRef],
        hovertemplate: `${glyph.label}<extra></extra>`,
        marker: {
          color: style.fill,
          size: style.radius * 2,
          symbol: style.symbol === "square" ? "square" : "circle",
          line: { color: style.stroke, width: style.lineWidth },
        },
        line: { color: style.stroke, width: style.lineWidth },
        showlegend: false,
      };
      if (glyph.eventRef !== props.selectedEventRef) return [base];
      const ring = (color: string, width: number) =>
        point
          ? {
              ...base,
              marker: {
                ...base.marker,
                color: "rgba(0,0,0,0)",
                size: style.radius * 2 + 8,
                line: { color, width },
              },
              hoverinfo: "skip",
            }
          : { ...base, line: { color, width }, hoverinfo: "skip" };
      return [
        ring(trafficPalette.selectionHalo, style.lineWidth + 8),
        ring(trafficPalette.selection, style.lineWidth + 4),
        base,
      ];
    });
    void Plotly.react(
      element,
      data as never,
      {
        margin: { l: 76, r: 22, t: 42, b: 24 },
        paper_bgcolor: trafficPalette.surface,
        plot_bgcolor: trafficPalette.surface,
        xaxis: {
          range: [0, props.scene.width],
          ...plotlyLaneAxis(props.scene.lanes),
        },
        yaxis: {
          visible: false,
          autorange: "reversed",
          range: [props.scene.height, 0],
          ...plotlyViewportInteraction.yaxis,
        },
        dragmode: plotlyViewportInteraction.dragmode,
        showlegend: false,
        shapes: props.scene.breakBands.map((band) => ({
          type: "rect",
          x0: props.scene.margin.left,
          x1: props.scene.width - props.scene.margin.right,
          y0: band.top,
          y1: band.bottom,
          fillcolor: trafficPalette.gapBand,
          line: { color: trafficPalette.quietGap },
          layer: "below",
        })),
        annotations: [
          ...props.scene.ticks.map((tick) => ({
            x: props.scene.margin.left,
            y: tick.y,
            text: tick.label,
            showarrow: false,
            xanchor: "right",
            font: { size: 10, color: trafficPalette.muted },
          })),
          ...props.scene.breakBands.map((band) => ({
            x: props.scene.margin.left + 6,
            y: band.top + 8,
            text: `Global quiet break · ${Math.round(band.gap.hiddenMs / 1000)}s hidden`,
            showarrow: false,
            xanchor: "left",
            font: { size: 9, color: trafficPalette.muted },
          })),
          ...props.scene.lanes.flatMap((lane) => [
            {
              x: lane.boundaryX,
              y: 34,
              text: "boundary/outcome",
              showarrow: false,
              font: { size: 8, color: trafficPalette.muted },
            },
            {
              x: lane.observedX,
              y: 34,
              text: "observed",
              showarrow: false,
              font: { size: 8, color: trafficPalette.muted },
            },
          ]),
        ],
      },
      {
        responsive: true,
        displayModeBar: plotlyViewportInteraction.displayModeBar,
      },
    ).then(() => {
      const scrollContainer = element.closest<HTMLElement>(".plot-column");
      const positionModebar = () => {
        const modebar = element.querySelector<HTMLElement>(".modebar");
        if (!modebar || !scrollContainer) return;
        modebar.style.setProperty(
          "left",
          `${modebarViewportLeft(
            scrollContainer.scrollLeft,
            scrollContainer.clientWidth,
            modebar.offsetWidth,
          )}px`,
          "important",
        );
        modebar.style.setProperty("right", "auto", "important");
      };
      positionModebar();
      if (!modebarPositioner.current) {
        modebarPositioner.current = positionModebar;
        modebarScrollContainer.current = scrollContainer;
        scrollContainer?.addEventListener("scroll", positionModebar, {
          passive: true,
        });
      }
      if (handlersBound.current) return;
      handlersBound.current = true;
      plotHost.on(
        "plotly_click",
        (event: { points?: Array<{ customdata?: string }> }) => {
          const ref = event.points?.[0]?.customdata;
          if (ref) callbacks.current.onSelect(ref);
        },
      );
      plotHost.on(
        "plotly_hover",
        (event: { points?: Array<{ customdata?: string }> }) =>
          callbacks.current.onHover(event.points?.[0]?.customdata ?? null),
      );
      plotHost.on("plotly_unhover", () => callbacks.current.onHover(null));
      plotHost.on("plotly_relayout", (event: unknown) => {
        const update = event as {
          "yaxis.range[0]"?: number;
          "yaxis.range[1]"?: number;
          "yaxis.range"?: [number, number];
          "yaxis.autorange"?: boolean;
        };
        if (update["yaxis.autorange"] === true) {
          callbacks.current.onResetWindow?.();
          return;
        }
        const range =
          update["yaxis.range"] ??
          (typeof update["yaxis.range[0]"] === "number" &&
          typeof update["yaxis.range[1]"] === "number"
            ? [update["yaxis.range[0]"], update["yaxis.range[1]"]]
            : null);
        if (range)
          callbacks.current.onWindowChange?.(
            plotlyRangeWindow(
              callbacks.current.scene.toUtc,
              callbacks.current.scene.height,
              range,
            ),
          );
      });
    });
  }, [props.scene, props.selectedEventRef]);
  useEffect(
    () => () => {
      if (modebarPositioner.current)
        modebarScrollContainer.current?.removeEventListener(
          "scroll",
          modebarPositioner.current,
        );
      if (host.current) void Plotly.purge(host.current);
    },
    [],
  );
  return (
    <div
      ref={host}
      className="scene-chart"
      aria-label="Plotly wall-clock renderer"
    />
  );
}
