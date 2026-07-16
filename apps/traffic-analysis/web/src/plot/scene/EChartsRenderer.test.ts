import { expect, it } from "vitest";
import { echartsDevicePixelRatio } from "./EChartsRenderer";

it("uses at least a 2x canvas backing resolution on ordinary desktop displays", () => {
  expect(echartsDevicePixelRatio(undefined)).toBe(2);
  expect(echartsDevicePixelRatio(1)).toBe(2);
  expect(echartsDevicePixelRatio(2.5)).toBe(2.5);
});
