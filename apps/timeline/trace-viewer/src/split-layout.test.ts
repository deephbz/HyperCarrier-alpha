import { describe, expect, it } from "vitest";

import {
  INSPECTOR_MIN_WIDTH,
  clampInspectorWidth,
  constrainedInspectorWidth,
  inspectorMaximumWidth,
  inspectorWidthFromDrag,
} from "./split-layout";

describe("split layout geometry", () => {
  it("leaves a usable ledger instead of a fixed inspector cap", () => {
    // 1558px workspace: the 30:70 default is 70% (1090.6), already above 720.
    expect(inspectorMaximumWidth(1558)).toBe(1278);
    expect(clampInspectorWidth(1090.6, 1558)).toBeCloseTo(1090.6);
    // A left drag of 40px grows the inspector and stays near the default.
    expect(inspectorWidthFromDrag(1090.6, 500, 460, 1558)).toBeCloseTo(1130.6);
    expect(inspectorWidthFromDrag(1090.6, 500, 460, 1558)).toBeLessThan(
      inspectorMaximumWidth(1558),
    );
  });

  it("keeps the inspector within the workspace on any drag direction", () => {
    expect(inspectorWidthFromDrag(1130, 500, 5000, 1558)).toBe(INSPECTOR_MIN_WIDTH);
    expect(inspectorWidthFromDrag(1130, 500, -5000, 1558)).toBe(1278);
    expect(inspectorWidthFromDrag(1090, 500, 500 + 100, 1558)).toBeCloseTo(990);
  });

  it("falls back safely when the workspace is unmeasured or narrow", () => {
    expect(inspectorMaximumWidth(0)).toBe(INSPECTOR_MIN_WIDTH);
    expect(inspectorMaximumWidth(Number.NaN)).toBe(INSPECTOR_MIN_WIDTH);
    expect(clampInspectorWidth(900, 600)).toBe(INSPECTOR_MIN_WIDTH);
    expect(clampInspectorWidth(Number.NaN, 1558)).toBe(1278);
  });

  it("derives the rendered value from the measured width, including after shrink", () => {
    // Unmeasured falls back to the minimum until the workspace mounts.
    expect(constrainedInspectorWidth(null, 0)).toBe(INSPECTOR_MIN_WIDTH);
    expect(constrainedInspectorWidth(null, 1558)).toBeCloseTo(1090.6);
    expect(constrainedInspectorWidth(1130, 1558)).toBe(1130);
    // A viewport shrink re-clamps the stale requested pixels.
    expect(constrainedInspectorWidth(1130, 900)).toBe(620);
    expect(constrainedInspectorWidth(1130, 500)).toBe(INSPECTOR_MIN_WIDTH);
  });
});
