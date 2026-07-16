import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { CustomChart } from "echarts/charts";
import { GraphicComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer as EChartsCanvasRenderer } from "echarts/renderers";
import { glyphStyle, trafficPalette } from "./visualStyle";
import type { SceneRendererProps } from "./types";

echarts.use([
  CustomChart,
  TooltipComponent,
  GraphicComponent,
  EChartsCanvasRenderer,
]);

export const echartsDevicePixelRatio = (value: number | undefined) =>
  Math.max(2, value ?? 1);

/** ECharts paints the shared z contract explicitly; input chronology never decides overlap. */
export function EChartsRenderer(props: SceneRendererProps) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const chart = echarts.init(host.current, undefined, {
      renderer: "canvas",
      devicePixelRatio: echartsDevicePixelRatio(window.devicePixelRatio),
    });
    const glyphs = props.scene.glyphs
      .filter((glyph) => glyph.role !== "global_break" && glyph.x != null)
      .sort(
        (a, b) =>
          glyphStyle(a).z - glyphStyle(b).z || a.key.localeCompare(b.key),
      );
    chart.setOption(
      {
        animation: false,
        graphic: [
          ...props.scene.breakBands.flatMap((band) => [
            {
              type: "rect",
              z: 0,
              shape: {
                x: props.scene.margin.left,
                y: band.top,
                width:
                  props.scene.width -
                  props.scene.margin.left -
                  props.scene.margin.right,
                height: band.bottom - band.top,
              },
              style: {
                fill: trafficPalette.gapBand,
                stroke: trafficPalette.quietGap,
              },
            },
            {
              type: "text",
              z: 1,
              style: {
                x: props.scene.margin.left + 6,
                y: band.top + 13,
                text: `Global quiet break · ${Math.round(band.gap.hiddenMs / 1000)}s hidden`,
                fill: trafficPalette.muted,
                font: "10px monospace",
              },
            },
          ]),
          ...props.scene.ticks.map((tick) => ({
            type: "text",
            z: 1,
            style: {
              x: 4,
              y: tick.y + 4,
              text: tick.label,
              fill: trafficPalette.muted,
              font: "11px monospace",
            },
          })),
          ...props.scene.lanes.flatMap((lane) => [
            {
              type: "text",
              z: 1,
              style: {
                x: (lane.bandLeft + lane.bandRight) / 2,
                y: 18,
                text: lane.label,
                textAlign: "center",
                fill: trafficPalette.ink,
                font: "11px monospace",
              },
            },
            {
              type: "text",
              z: 1,
              style: {
                x: lane.boundaryX,
                y: 34,
                text: "boundary/outcome",
                textAlign: "center",
                fill: trafficPalette.muted,
                font: "9px monospace",
              },
            },
            {
              type: "text",
              z: 1,
              style: {
                x: lane.observedX,
                y: 34,
                text: "observed",
                textAlign: "center",
                fill: trafficPalette.muted,
                font: "9px monospace",
              },
            },
          ]),
        ],
        tooltip: {
          show: true,
          formatter: (value: { dataIndex: number }) =>
            glyphs[value.dataIndex]?.label ?? "",
        },
        series: [
          {
            type: "custom",
            coordinateSystem: "none",
            data: glyphs.map((glyph) => [glyph.x, glyph.y1, glyph.y2]),
            renderItem: (params: { dataIndex: number }) => {
              const glyph = glyphs[params.dataIndex]!;
              const style = glyphStyle(glyph);
              const selected = glyph.eventRef === props.selectedEventRef;
              const shape =
                style.symbol === "square"
                  ? {
                      type: "rect",
                      shape: {
                        x: glyph.x! - style.radius,
                        y: glyph.y1 - style.radius,
                        width: style.radius * 2,
                        height: style.radius * 2,
                      },
                    }
                  : style.symbol === "circle"
                    ? {
                        type: "circle",
                        shape: { cx: glyph.x, cy: glyph.y1, r: style.radius },
                      }
                    : {
                        type: "line",
                        shape: {
                          x1: glyph.x,
                          y1: glyph.y1,
                          x2: glyph.x,
                          y2: glyph.y2,
                        },
                      };
              const mark = {
                ...shape,
                z2: style.z,
                style: {
                  stroke: style.stroke,
                  fill: style.fill,
                  lineWidth: style.lineWidth,
                },
              };
              if (!selected) return mark;
              const outer =
                style.symbol === "line"
                  ? shape
                  : style.symbol === "square"
                    ? {
                        type: "rect",
                        shape: {
                          x: glyph.x! - style.radius - 4,
                          y: glyph.y1 - style.radius - 4,
                          width: style.radius * 2 + 8,
                          height: style.radius * 2 + 8,
                        },
                      }
                    : {
                        type: "circle",
                        shape: {
                          cx: glyph.x,
                          cy: glyph.y1,
                          r: style.radius + 4,
                        },
                      };
              return {
                type: "group",
                children: [
                  {
                    ...outer,
                    style: {
                      stroke: trafficPalette.selectionHalo,
                      fill: "transparent",
                      lineWidth:
                        style.symbol === "line" ? style.lineWidth + 8 : 5,
                    },
                  },
                  {
                    ...outer,
                    style: {
                      stroke: trafficPalette.selection,
                      fill: "transparent",
                      lineWidth:
                        style.symbol === "line" ? style.lineWidth + 4 : 2,
                    },
                  },
                  mark,
                ],
              };
            },
          },
        ],
      },
      { notMerge: true },
    );
    const click = (event: { dataIndex?: number }) => {
      const ref =
        event.dataIndex == null ? null : glyphs[event.dataIndex]?.eventRef;
      if (ref) props.onSelect(ref);
    };
    chart.on("click", click);
    chart.on("mouseover", (event: { dataIndex?: number }) =>
      props.onHover(
        event.dataIndex == null
          ? null
          : (glyphs[event.dataIndex]?.eventRef ?? null),
      ),
    );
    chart.on("mouseout", () => props.onHover(null));
    const resize = new ResizeObserver(() => chart.resize());
    resize.observe(host.current);
    return () => {
      resize.disconnect();
      chart.dispose();
    };
  }, [props]);
  return (
    <div
      ref={host}
      className="scene-chart"
      aria-label="ECharts Canvas custom-series wall-clock renderer"
    />
  );
}
