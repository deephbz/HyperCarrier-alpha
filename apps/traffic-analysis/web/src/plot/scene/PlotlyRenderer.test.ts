import { expect, it } from "vitest";
import {
  modebarViewportLeft,
  plotlyLaneAxis,
  plotlyCoordinateUtc,
  plotlyRangeWindow,
  plotlyViewportInteraction,
} from "./PlotlyRenderer";

it("exposes a conventional modebar while fixing lanes and bridging y-range geometry", () => {
  expect(plotlyViewportInteraction.dragmode).toBe("pan");
  expect(plotlyViewportInteraction.displayModeBar).toBe(true);
  expect(plotlyViewportInteraction.xaxis.fixedrange).toBe(true);
  expect(plotlyViewportInteraction.yaxis.fixedrange).toBe(false);
  expect(
    plotlyRangeWindow((coordinate) => coordinate * 10, 100, [80, 20]),
  ).toEqual({
    startMs: 200,
    endMs: 800,
  });
});

it("uses fixed numeric lane centers as ordinary x-axis tick labels", () => {
  const axis = plotlyLaneAxis([
    {
      agentRef: "a",
      bandLeft: 76,
      bandRight: 236,
      boundaryX: 116,
      observedX: 196,
      label: "Agent A",
    },
    {
      agentRef: "b",
      bandLeft: 236,
      bandRight: 396,
      boundaryX: 276,
      observedX: 356,
      label: "Agent B",
    },
  ]);
  expect(axis.fixedrange).toBe(true);
  expect(axis.tickmode).toBe("array");
  expect(axis.tickvals).toEqual([156, 316]);
  expect(axis.ticktext).toEqual(["Agent A", "Agent B"]);
});

it("keeps the modebar in the visible horizontal viewport without changing lane scroll", () => {
  // The canvas can be wider than the `.plot-column` viewport; these x values
  // remain inside the viewport after its corresponding horizontal scroll.
  expect(modebarViewportLeft(0, 899, 250)).toBe(641);
  expect(modebarViewportLeft(819, 899, 250)).toBe(1460);
  expect(modebarViewportLeft(0, 200, 250)).toBe(8);
});

it("extrapolates only out-of-scene modebar ranges while preserving compressed mapping inside", () => {
  const compressed = (coordinate: number) =>
    Math.min(100, Math.max(0, coordinate)) === 50
      ? 700
      : Math.min(100, Math.max(0, coordinate)) * 10;
  expect(plotlyCoordinateUtc(compressed, 100, 50)).toBe(700);
  expect(plotlyCoordinateUtc(compressed, 100, -20)).toBe(-200);
  expect(plotlyCoordinateUtc(compressed, 100, 120)).toBe(1200);
  expect(plotlyRangeWindow(compressed, 100, [-20, 120])).toEqual({
    startMs: -200,
    endMs: 1200,
  });
});
