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

describe("TraceViewer default scope", () => {
  it("opens with the Rarebit-only mode selected", async () => {
    renderTraceViewer(TraceViewer);

    await waitFor(() => expect(screen.getByLabelText("Rarebits only")).toBeTruthy());
    expect((screen.getByLabelText("Rarebits only") as HTMLInputElement).checked).toBe(true);
  });
});
