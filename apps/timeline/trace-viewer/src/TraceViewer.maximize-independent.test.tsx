import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TraceViewer } from "./TraceViewer";
import type { PiTrace, TraceContentBlock, TraceRecord } from "./types";
import { installStubEventSource, renderTraceViewer } from "./test-fixtures";

let emitInvalidate: (() => void) | undefined;

beforeEach(() => {
  installStubEventSource();
  emitInvalidate = undefined;
  class InvalidateEventSource {
    addEventListener(name: string, listener: () => void) {
      if (name === "invalidate") emitInvalidate = listener;
    }
    close() {}
  }
  vi.stubGlobal("EventSource", InvalidateEventSource);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

const block = <T extends TraceContentBlock>(value: T): T => value;

function record(
  order: number,
  sourceEntryId: string,
  kind: string,
  lane: "input" | "model" | "tools",
  label: string,
  content: readonly TraceContentBlock[],
): TraceRecord {
  return {
    recordId: `entry:${sourceEntryId}`,
    sourceEntryId,
    order,
    kind,
    lane,
    label,
    turn: 1,
    step: order === 0 ? null : order,
    timestamp: null,
    content,
    rarebit: true,
    details: {},
    unavailable: {},
    raw: { type: "message", id: sourceEntryId },
  };
}

const maximizeTrace: PiTrace = {
  availability: "available",
  schemaVersion: "pi-trace/2",
  sessionId: "session-test",
  sourceVersion: "maximize-source",
  selectorVersion: "maximize-selector",
  activeLeafId: "leaf-1",
  activeBranchIds: ["leaf-1"],
  records: [
    record(0, "user", "input", "input", "User message", [
      block({ kind: "prose", sourceBlockIndex: 0, text: "Owner request" }),
    ]),
    record(1, "assistant", "assistant", "model", "Assistant message", [
      block({ kind: "reasoning", sourceBlockIndex: 0, text: "Private reasoning" }),
      block({ kind: "prose", sourceBlockIndex: 1, text: "Visible prose" }),
      block({
        kind: "tool_call",
        sourceBlockIndex: 2,
        id: "call-1",
        name: "read",
        arguments: { path: "x" },
        toolResultRecordId: "entry:tool-result",
      }),
    ]),
    record(2, "tool-result", "tool_result", "tools", "Tool result", [
      block({
        kind: "tool_result",
        sourceBlockIndex: 0,
        text: "Tool output",
        toolCallId: "call-1",
        toolName: "read",
        isError: false,
      }),
    ]),
  ],
  selection: {
    selectorVersion: "maximize-selector",
    manifestHash: "maximize-hash",
    rarebitSourceEntryIds: ["user", "assistant", "tool-result"],
  },
};

function expandedToggle() {
  return screen.queryByRole("button", { name: "Expand inspector" });
}

function restoreToggle() {
  return screen.getByRole("button", { name: "Restore split view" });
}

function isInert(element: Element) {
  return element.hasAttribute("inert");
}

describe("TraceViewer full-page inspector toggle", () => {
  it("maximizes and restores without losing inspector state, width, or ledger scroll", async () => {
    const view = renderTraceViewer(TraceViewer, maximizeTrace);
    await waitFor(() => expect(screen.getByRole("button", { name: /Tool result/ })).toBeTruthy());
    fireEvent.click(view.container.querySelector('[data-record-id="entry:assistant"]')!);
    expect(screen.getByRole("heading", { name: "Assistant message" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "content" }));
    fireEvent.click(screen.getByRole("button", { name: "Raw text" }));
    fireEvent.click(screen.getByText(/Reasoning · source block 1/));
    const details = screen.getByText(/Reasoning · source block 1/)
      .parentElement as HTMLDetailsElement;
    expect(details.open).toBe(true);

    const frame = view.container.querySelector(".trace-workspace-frame")!;
    const toolbar = view.container.querySelector(".trace-toolbar")!;
    const overview = screen.getByRole("region", { name: "Trajectory overview" });
    const ledgerRegion = screen.getByRole("region", { name: "Trace ledger" });
    const ledger = ledgerRegion.querySelector(".ledger-scroll")!;
    ledger.scrollTop = 137;
    fireEvent.scroll(ledger);
    const widthBefore = frame.getAttribute("style");

    fireEvent.click(expandedToggle()!);
    expect(restoreToggle().getAttribute("aria-pressed")).toBe("true");
    expect(expandedToggle()).toBeNull();
    expect(screen.getByRole("heading", { name: "Assistant message" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "content" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "Raw text" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(details.open).toBe(true);

    expect(isInert(toolbar)).toBe(true);
    expect(isInert(overview)).toBe(true);
    expect(isInert(ledgerRegion)).toBe(true);

    const resize = screen.queryByRole("separator", { name: "Resize inspector" });
    if (resize !== null) {
      expect(
        resize.getAttribute("aria-disabled") === "true" || resize.getAttribute("tabindex") === "-1",
      ).toBe(true);
    }
    expect(ledger.scrollTop).toBe(137);

    fireEvent.click(restoreToggle());
    expect(expandedToggle()?.getAttribute("aria-pressed")).toBe("false");
    expect(frame.getAttribute("style")).toBe(widthBefore);
    expect(ledger.scrollTop).toBe(137);
    expect(screen.getByRole("tab", { name: "content" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "Raw text" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(details.open).toBe(true);
    if (resize !== null) {
      expect(resize.getAttribute("tabindex")).not.toBe("-1");
      expect(resize.getAttribute("aria-disabled")).not.toBe("true");
    }
  });

  it("focuses the maximize toggle so Escape exits from the focused control", async () => {
    renderTraceViewer(TraceViewer, maximizeTrace);
    await waitFor(() => expect(expandedToggle()).toBeTruthy());

    fireEvent.click(expandedToggle()!);
    const restore = restoreToggle();
    expect(document.activeElement).toBe(restore);
    fireEvent.keyDown(restore, { key: "Escape" });
    expect(expandedToggle()?.getAttribute("aria-pressed")).toBe("false");
  });

  it("restores body overflow and raw recovery when SSE invalidates an expanded trace", async () => {
    const view = renderTraceViewer(TraceViewer, maximizeTrace);
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify(maximizeTrace), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            availability: "unavailable",
            reason: "source_missing",
            message: "The exact trace source is unavailable.",
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
      );
    document.body.style.overflow = "scroll";
    await waitFor(() => expect(expandedToggle()).toBeTruthy());
    fireEvent.click(expandedToggle()!);
    expect(document.body.style.overflow).toBe("hidden");

    expect(emitInvalidate).toBeTruthy();
    emitInvalidate!();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Trace unavailable" })).toBeTruthy(),
    );
    expect(document.body.style.overflow).toBe("scroll");
    expect(view.container.querySelector('a[href="/raw/session-test"]')).toBeTruthy();
  });

  it("exits only from the expanded state with Escape and supports a narrow viewport", async () => {
    const view = renderTraceViewer(TraceViewer, maximizeTrace);
    await waitFor(() => expect(expandedToggle()).toBeTruthy());
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 });
    fireEvent(window, new Event("resize"));

    fireEvent.keyDown(expandedToggle()!, { key: "Escape" });
    expect(expandedToggle()?.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(expandedToggle()!);
    expect(restoreToggle()).toBeTruthy();
    fireEvent.keyDown(restoreToggle(), { key: "Escape" });
    expect(expandedToggle()?.getAttribute("aria-pressed")).toBe("false");
    expect(view.container.querySelector(".trace-workspace")).toBeTruthy();
  });
});
