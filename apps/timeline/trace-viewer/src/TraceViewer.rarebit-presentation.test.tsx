import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
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

async function renderReady() {
  renderTraceViewer(TraceViewer);
  await waitFor(() => expect(screen.getByRole("button", { name: /Record 1/ })).toBeTruthy());
}

describe("TraceViewer Rarebit-only presentation", () => {
  it("keeps every ledger row visible and dims non-Rarebits", async () => {
    await renderReady();

    const rows = screen.getAllByRole("button", { name: /Record/ });
    expect(rows).toHaveLength(3);
    expect(screen.getByRole("button", { name: /Record 0/ }).className).toContain("dimmed");
    expect(screen.getByRole("button", { name: /Record 1/ }).className).not.toContain("dimmed");
  });

  it("still inspects a faded row and then moves to the next Rarebit by keyboard", async () => {
    await renderReady();

    fireEvent.click(screen.getByRole("button", { name: /Record 0/ }));
    expect(screen.getByRole("heading", { name: "Record 0" })).toBeTruthy();

    fireEvent.keyDown(screen.getByLabelText(/Active-branch order overview/), {
      key: "ArrowRight",
    });
    expect(screen.getByRole("heading", { name: "Record 1" })).toBeTruthy();
  });
});
