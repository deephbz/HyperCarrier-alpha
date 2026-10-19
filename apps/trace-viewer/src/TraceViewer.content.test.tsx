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

describe("TraceViewer content inspector", () => {
  it("starts on Content with rendered output and can switch to raw text", async () => {
    const view = renderTraceViewer(TraceViewer);

    await waitFor(() => expect(screen.getByLabelText("Record content")).toBeTruthy());
    const rendered = screen.getByRole("button", { name: "Rendered" });
    expect(rendered.getAttribute("aria-pressed")).toBe("true");
    expect(view.container.querySelector(".content-renderer")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Raw text" }));
    expect(screen.getByRole("button", { name: "Raw text" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(view.container.querySelector("pre.record-content")).toBeTruthy();
  });
});
