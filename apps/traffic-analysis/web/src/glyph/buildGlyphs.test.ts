import { expect, it } from "vitest";
import { matrixFixture } from "../fixture";
import { agentSublanes } from "../scale/agentSublanes";
import { assertVerticalSublaneGrammar, buildGlyphs } from "./buildGlyphs";

it("uses exactly two visible sublanes and splits request display roles without changing authority", () => {
  const lanes = agentSublanes(
    matrixFixture.columns.map((column) => column.agentRef),
    60,
    660,
  );
  const glyphs = buildGlyphs(matrixFixture, lanes, (ms) => ms / 1000);
  assertVerticalSublaneGrammar(glyphs, lanes);
  const request = matrixFixture.marks.find(
    (mark) => mark.rowType === "request_interval",
  )!;
  const roles = glyphs.filter((glyph) => glyph.eventRef === request.eventRef);
  expect(roles.map((glyph) => glyph.displayRole).sort()).toEqual([
    "request_interval",
    "response_outcome",
  ]);
  expect(roles.map((glyph) => glyph.eventRef)).toEqual([
    request.eventRef,
    request.eventRef,
  ]);
  expect(new Set(roles.map((glyph) => glyph.x)).size).toBe(2);
  const xPositions = new Set(
    lanes.flatMap((lane) => [lane.boundaryX, lane.observedX]),
  );
  expect(
    glyphs
      .filter((glyph) => glyph.role !== "global_break")
      .every((glyph) => glyph.x != null && xPositions.has(glyph.x)),
  ).toBe(true);
});

it("keeps same-Agent overlapping request/tool strokes on B while bounding distinct hit targets", () => {
  const lanes = agentSublanes(
    matrixFixture.columns.map((column) => column.agentRef),
    60,
    660,
  );
  const glyphs = buildGlyphs(matrixFixture, lanes, (ms) => ms);
  const request = glyphs.find(
    (glyph) => glyph.key === "request:fixture:overlap:request",
  )!;
  const tool = glyphs.find(
    (glyph) => glyph.key === "tool:fixture:overlap:tool",
  )!;
  const lane = lanes.find((item) => item.agentRef === "a1")!;
  expect(request.agentRef).toBe(tool.agentRef);
  expect(request.y1).toBeLessThan(tool.y2);
  expect(tool.y1).toBeLessThan(request.y2);
  expect(request.x).toBe(lane.observedX);
  expect(tool.x).toBe(lane.observedX);
  expect(request.hitX).toBe(lane.observedX - 4);
  expect(tool.hitX).toBe(lane.observedX + 4);
  // 14px targets overlap only in their 6px shared core; each retains a 8px
  // exclusive side, without introducing a third visible axis.
  expect(request.hitX! + 7).toBeGreaterThan(tool.hitX! - 7);
  expect(request.hitX! - 7).toBeLessThan(tool.hitX! - 7);
  expect(request.hitX! + 7).toBeLessThan(tool.hitX! + 7);
  expect(request.eventRef).toBe("fixture:overlap:request");
  expect(tool.eventRef).toBe("fixture:overlap:tool");
  expect(tool.displayRole).toBe("tool_observation");
});
