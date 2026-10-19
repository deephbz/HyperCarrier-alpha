import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TraceViewer } from "./TraceViewer";
import { installStubEventSource, renderTraceViewer } from "./test-fixtures";

beforeEach(() => installStubEventSource());

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("TraceViewer split layout", () => {
  it("starts the inspector at the 30:70 default instead of a fixed width", async () => {
    const view = renderTraceViewer(TraceViewer);

    await waitFor(() =>
      expect(screen.getByRole("separator", { name: "Resize inspector" })).toBeTruthy(),
    );
    const frame = view.container.querySelector(".trace-workspace-frame");
    expect(frame?.getAttribute("style")).toContain("--trace-inspector-width: 70%");
  });
});
