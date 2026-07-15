import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { demoSnapshot } from "./demo";

afterEach(cleanup);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/?demo=1");
});

describe("dashboard controls", () => {
  it("renders the demo fleet and composes alive, field, and value filters", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByRole("heading", { name: "Pi session timeline" })).toBeTruthy();
    expect(screen.getByText("60 visible")).toBeTruthy();

    await user.click(screen.getByRole("checkbox", { name: "Alive only" }));
    expect(screen.getByText("10 visible")).toBeTruthy();

    await user.selectOptions(screen.getByRole("combobox", { name: "Filter sessions by" }), "state");
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter value" }), "Thinking");
    expect(screen.getByText("2 visible")).toBeTruthy();
  });

  it("opens coherent session details from an alias-first lane", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ availability: "missing", reason: "sidecar_missing" }),
      }),
    );
    render(<App />);
    await user.click(screen.getByRole("button", { name: /timeline-lead, session demo-0/ }));
    expect(screen.getByRole("heading", { name: "timeline-lead" })).toBeTruthy();
    expect(screen.getByText("Session ID")).toBeTruthy();
    expect(screen.getAllByText("demo-0").length).toBeGreaterThan(0);
  });

  it("uses one Key Message marker projection and lazily fetches the selected Session summary", async () => {
    const user = userEvent.setup();
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        availability: "available",
        status: "ok",
        selection: { occurrenceCount: 2, uniquePayloadCount: 2, asOf: "2026-01-01T00:00:00Z" },
        summary: "Derived summary only.",
      }),
    });
    vi.stubGlobal("fetch", fetch);
    render(<App />);

    expect(screen.queryByRole("combobox", { name: "Detail" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Color" })).toBeNull();
    expect(screen.getAllByRole("listitem", { name: /User message/ }).length).toBeGreaterThan(0);
    expect(fetch).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /timeline-lead, session demo-0/ }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/sessions/demo-0/key-message-summary",
        expect.objectContaining({ signal: expect.anything() }),
      ),
    );
    expect(await screen.findByText("Derived summary only.")).toBeTruthy();
  });

  it("coalesces live invalidations while a snapshot is in flight", async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/");
    vi.resetModules();

    const listeners = new Map<string, () => void>();
    class FakeEventSource {
      addEventListener(type: string, listener: () => void) {
        listeners.set(type, listener);
      }
      close() {}
    }
    let resolveFirst!: (value: unknown) => void;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const response = { ok: true, json: async () => demoSnapshot() };
    const fetch = vi
      .fn()
      .mockReturnValueOnce(first.then(() => response))
      .mockResolvedValue(response);
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", fetch);

    const { App: LiveApp } = await import("./App");
    render(<LiveApp />);
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      listeners.get("ready")?.();
      listeners.get("invalidate")?.();
      vi.advanceTimersByTime(100);
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst(undefined);
      await Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reveals only opt-in local collection diagnostics", async () => {
    window.history.replaceState({}, "", "/?demo=1&diagnostics=1");
    vi.resetModules();

    const { App: DiagnosticApp } = await import("./App");
    render(<DiagnosticApp />);

    expect(screen.getByText(/Local diagnostics/)).toBeTruthy();
    expect(screen.getByText("JSONL cache")).toBeTruthy();
    expect(screen.getByText(/60 sessions · 60 lanes/)).toBeTruthy();
  });
});
