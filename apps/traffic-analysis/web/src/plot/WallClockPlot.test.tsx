import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
const rendererMouseDown = vi.fn();
vi.mock("./scene/EChartsRenderer", () => ({
  EChartsRenderer: () => (
    <div className="scene-chart">
      <canvas
        data-testid="renderer-surface"
        onMouseDown={(event) => {
          rendererMouseDown();
          event.stopPropagation();
        }}
      />
    </div>
  ),
}));
import { matrixFixture } from "../fixture";
import {
  buildWallClockScene,
  wallClockMinHeight,
} from "./scene/WallClockScene";
import { WallClockPlot, panWindow, wheelZoomWindow } from "./WallClockPlot";

it("builds one renderer-neutral scene with fixed vertical sublanes and exclusive overlap hits", () => {
  const scene = buildWallClockScene(matrixFixture, matrixFixture, 900);
  expect(wallClockMinHeight).toBe(504);
  expect(scene.height).toBe(504);
  const positions = new Set(
    scene.lanes.flatMap((lane) => [lane.boundaryX, lane.observedX]),
  );
  expect(
    scene.glyphs
      .filter((glyph) => glyph.role !== "global_break")
      .every((glyph) => glyph.x != null && positions.has(glyph.x)),
  ).toBe(true);
  const request = scene.glyphs.find(
    (glyph) =>
      glyph.eventRef === "fixture:overlap:request" &&
      glyph.role === "request_interval",
  )!;
  const tool = scene.glyphs.find(
    (glyph) =>
      glyph.eventRef === "fixture:overlap:tool" && glyph.role === "tool_span",
  )!;
  expect(request.agentRef).toBe("a1");
  expect(tool.agentRef).toBe("a1");
  expect(request.hitX).not.toBe(tool.hitX);
  expect(request.y1).toBeLessThan(tool.y2);
  expect(tool.y1).toBeLessThan(request.y2);
});

it("uses natural native wheel zoom, commits one bounded middle-drag pan, and removes keyboard evidence inventory", async () => {
  const onSelect = vi.fn();
  const onWindowChange = vi.fn();
  const { container, rerender } = render(
    <WallClockPlot
      projection={matrixFixture}
      renderer="echarts"
      selectedEventRef={null}
      onHover={() => {}}
      onSelect={onSelect}
      onWindowChange={onWindowChange}
    />,
  );
  await waitFor(() =>
    expect(container.querySelector(".scene-chart")).toBeTruthy(),
  );
  const root = container.querySelector<HTMLElement>(".svg-wall-clock")!;
  const surface = container.querySelector<HTMLElement>(".scene-chart")!;
  const rendererSurface = screen.getByTestId("renderer-surface");
  surface.getBoundingClientRect = () => ({ top: 0, height: 504 }) as DOMRect;
  const wheel = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaY: -120,
  });
  Object.defineProperty(wheel, "clientY", { value: 100 });
  rendererSurface.dispatchEvent(wheel);
  expect(wheel.defaultPrevented).toBe(true);
  expect(onWindowChange).toHaveBeenCalledWith(
    wheelZoomWindow(
      buildWallClockScene(matrixFixture, matrixFixture, 720).toUtc(100),
      -120,
      matrixFixture.coverage.currentWindow,
      matrixFixture.coverage.initialWindow,
    ),
  );
  onWindowChange.mockClear();
  rendererMouseDown.mockClear();
  fireEvent.mouseDown(rendererSurface, { button: 1, clientY: 220 });
  expect(rendererMouseDown).not.toHaveBeenCalled();
  expect(onWindowChange).not.toHaveBeenCalled();
  // Hover updates can rebind native listeners before release; gesture state remains component-owned.
  rerender(
    <WallClockPlot
      projection={matrixFixture}
      renderer="echarts"
      selectedEventRef={null}
      onHover={() => {}}
      onSelect={onSelect}
      onWindowChange={onWindowChange}
    />,
  );
  const rerenderedSurface =
    container.querySelector<HTMLElement>(".scene-chart")!;
  rerenderedSurface.getBoundingClientRect = () =>
    ({ top: 0, height: 504 }) as DOMRect;
  // The release is outside the root, as it can be after Plotly has handled the drag.
  fireEvent.mouseUp(rerenderedSurface.ownerDocument.defaultView!, {
    button: 1,
    clientY: 300,
  });
  const scene = buildWallClockScene(matrixFixture, matrixFixture, 720);
  expect(onWindowChange).toHaveBeenCalledTimes(1);
  expect(onWindowChange).toHaveBeenCalledWith(
    panWindow(
      scene.toUtc((220 * 504) / 504) - scene.toUtc((300 * 504) / 504),
      matrixFixture.coverage.currentWindow,
      matrixFixture.coverage.initialWindow,
    ),
  );
  expect(screen.getByText("Reset")).toBeTruthy();
  expect(screen.queryByText("Zoom in")).toBeNull();
  expect(screen.queryByText("Zoom out")).toBeNull();
  expect(screen.queryByLabelText("Pan UTC range")).toBeNull();
  expect(screen.queryByText(/Keyboard evidence selection/)).toBeNull();
});
