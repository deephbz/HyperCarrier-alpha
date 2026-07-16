import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
vi.mock("./plot/WallClockPlot", () => ({
  WallClockPlot: ({
    projection,
    onSelect,
    onWindowChange,
  }: {
    projection: {
      marks: Array<{ eventRef: string }>;
      coverage: { currentWindow: { startMs: number; endMs: number } };
    };
    onSelect: (eventRef: string) => void;
    onWindowChange: (window: { startMs: number; endMs: number }) => void;
  }) => (
    <>
      <button
        type="button"
        onClick={() => onSelect(projection.marks[0]!.eventRef)}
      >
        Canvas mark
      </button>
      <button
        type="button"
        onClick={() => onWindowChange({ startMs: 100, endMs: 200 })}
      >
        Change UTC
      </button>
      <output data-testid="mock-window">
        {projection.coverage.currentWindow.startMs}:
        {projection.coverage.currentWindow.endMs}
      </output>
    </>
  ),
}));
import { App, compactUtc, isBoundOrdinalProjection } from "./App";
import { matrixFixture, ordinalFixture } from "./fixture";

const matrixUrl = "/api/matrix?detail=marks&rowBudget=5000";

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
  );
});
afterEach(cleanup);

describe("traffic matrix dashboard", () => {
  it("formats compact UTC coverage literally without locale punctuation", () => {
    expect(compactUtc(Date.UTC(2026, 0, 2, 3, 4))).toBe("02 Jan 03:04");
    expect(compactUtc(null)).toBe("Unavailable");
  });

  it("accepts ordinal evidence only when it binds the displayed matrix derivation", () => {
    expect(
      isBoundOrdinalProjection(ordinalFixture, matrixFixture.snapshot),
    ).toBe(true);
    expect(
      isBoundOrdinalProjection(
        {
          ...ordinalFixture,
          snapshot: {
            ...ordinalFixture.snapshot,
            analysisId: "other-analysis",
          },
        },
        matrixFixture.snapshot,
      ),
    ).toBe(false);
  });
  it("renders a typed unavailable scope without a fixture-shaped plot, aggregates, or epoch window", async () => {
    window.history.replaceState({}, "", "/?team=piteams%3Amissing");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          scope: {
            scopeRef: "traffic:0123456789abcdef01234567",
            sources: [],
            diagnostics: [
              {
                code: "team_unavailable",
                message: "No explicit mappings are available.",
              },
            ],
          },
        }),
      }),
    );
    render(<App initialSource="live" />);
    expect(
      await screen.findByRole("heading", {
        name: "Evidence scope unavailable",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(
      /team_unavailable: Evidence scope unavailable/i,
    );
    expect(screen.queryByText("Wall-clock plot")).toBeNull();
    expect(screen.queryByText("Aggregational stats")).toBeNull();
    expect(document.body.textContent).not.toContain("1970");
  });

  it("renders the matrix first and removes the detailed event table", () => {
    render(<App initialSource="fixture" />);
    expect(
      screen.getByRole("heading", { name: "Agent-turns viz" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Selected event" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("listbox", { name: "Matrix event grid" }),
    ).toBeNull();
    expect(screen.getByText("Concurrency rail")).toBeTruthy();
    expect(screen.getByText(/Tool observation \(not runtime\)/)).toBeTruthy();
    expect(screen.getByText("Ordinal sequence")).toBeTruthy();
  });

  it("keeps operator semantics while hiding debug chrome by default", () => {
    render(<App initialSource="fixture" />);
    expect(screen.getByLabelText("Renderer")).toBeTruthy();
    expect(screen.queryByLabelText("Source")).toBeNull();
    expect(screen.getByText("Leader unavailable")).toBeTruthy();
    expect(screen.getByText("Team unavailable")).toBeTruthy();
    expect(screen.queryByText("fixture-snap")).toBeNull();
    expect(screen.queryByText(/44 marks returned/i)).toBeNull();
    expect(screen.queryByText(/44\/600 marks/i)).toBeNull();
    expect(screen.queryByText(/Bounded, backend-prepared marks/i)).toBeNull();
    expect(screen.queryByText(/Hover: none/i)).toBeNull();
    expect(
      screen.getByText("Evidence provenance").closest("details")?.open,
    ).toBe(false);
  });

  it("shows exact debug chrome only for debug=1", () => {
    window.history.replaceState({}, "", "/?debug=1");
    render(<App initialSource="fixture" />);
    expect(screen.getByLabelText("Source")).toBeTruthy();
    expect(screen.getByText("fixture-snap")).toBeTruthy();
    expect(
      screen.getByText(
        /3 Agents · 44 marks returned · request cap 600 · detail: marks/i,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/44\/600 marks/i)).toBeNull();
    expect(screen.getByText(/Bounded, backend-prepared marks/i)).toBeTruthy();
    expect(
      screen.getByText("Evidence provenance").closest("details")?.open,
    ).toBe(true);
  });

  it("uses the same opaque reference for canvas selection", async () => {
    render(<App initialSource="fixture" />);
    fireEvent.click(screen.getByRole("button", { name: "Canvas mark" }));
    expect(
      await screen.findByRole("heading", {
        name: /Tool available to result recorded/i,
      }),
    ).toBeTruthy();
  });

  it("retains the applied UTC window when an SSE revision follows navigation", async () => {
    const listeners = new Map<string, (event: MessageEvent) => void>();
    vi.stubGlobal(
      "EventSource",
      vi.fn(function () {
        return {
          addEventListener: (
            name: string,
            listener: (event: MessageEvent) => void,
          ) => listeners.set(name, listener),
          close: vi.fn(),
        };
      }),
    );
    let resolveNavigation: ((response: Response) => void) | null = null;
    const responseFor = (url: string) => {
      const query = new URL(url, "http://localhost").searchParams;
      const currentWindow = query.has("startMs")
        ? {
            startMs: Number(query.get("startMs")),
            endMs: Number(query.get("endMs")),
          }
        : matrixFixture.coverage.currentWindow;
      return {
        ok: true,
        json: async () =>
          url.startsWith("/api/matrix")
            ? {
                ...matrixFixture,
                coverage: { ...matrixFixture.coverage, currentWindow },
              }
            : {},
      } as Response;
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: URL | RequestInfo) => {
        const url = String(input);
        if (
          url.startsWith("/api/matrix?startMs=100&endMs=200") &&
          !resolveNavigation
        )
          return new Promise<Response>((resolve) => {
            resolveNavigation = resolve;
          });
        return Promise.resolve(responseFor(url));
      }),
    );
    render(<App initialSource="live" />);
    await waitFor(() => expect(listeners.get("revision")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Change UTC" }));
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toContain(
        "/api/matrix?startMs=100&endMs=200&detail=marks&rowBudget=5000",
      ),
    );
    // The source rotates before the action response. The navigation request
    // owns this window, so SSE must not issue a duplicate stale request.
    listeners.get("revision")!(new MessageEvent("revision", { data: "next" }));
    const matrixRequests = vi
      .mocked(fetch)
      .mock.calls.map(([url]) => String(url))
      .filter((url) => url.startsWith("/api/matrix"));
    expect(matrixRequests.at(-1)).toBe(
      "/api/matrix?startMs=100&endMs=200&detail=marks&rowBudget=5000",
    );
    expect(matrixRequests).toHaveLength(2);
    resolveNavigation!(
      responseFor(
        "/api/matrix?startMs=100&endMs=200&detail=marks&rowBudget=5000",
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("mock-window").textContent).toBe("100:200"),
    );
  });

  it("keeps only explicit window application in the toolbar and renders labeled report facts with a semantic legend", () => {
    render(<App initialSource="fixture" />);
    expect(screen.getByRole("button", { name: "Apply window" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Zoom out" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset view" })).toBeNull();
    expect(screen.getByText("Recorded UTC window")).toBeTruthy();
    expect(screen.getByText("Elapsed span")).toBeTruthy();
    expect(screen.getByText("Lead session")).toBeTruthy();
    expect(screen.getByLabelText("Evidence legend")).toBeTruthy();
  });

  it("orders wall-clock, open aggregational stats, then open ordinal events and requests both immediate projections", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: URL | RequestInfo) =>
        Promise.resolve({
          ok: true,
          json: async () => (String(input) === matrixUrl ? matrixFixture : {}),
        } as Response),
      ),
    );
    render(<App initialSource="live" />);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(matrixUrl));
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual(
        expect.arrayContaining(["/api/ordinal-evidence"]),
      ),
    );
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.map(([url]) => String(url))
          .some((url) => url.startsWith("/api/secondary?snapshotId=")),
      ).toBe(true),
    );
    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings.indexOf("Wall-clock plot")).toBeLessThan(
      headings.indexOf("Aggregational stats"),
    );
    expect(headings.indexOf("Aggregational stats")).toBeLessThan(
      headings.indexOf("Ordinal events"),
    );
    expect(
      screen.getByText("Aggregate charts and tables").closest("details")?.open,
    ).toBe(true);
    expect(screen.getByText("Ordinal sequence").closest("details")?.open).toBe(
      true,
    );
  });

  it("opens a fixed-row Agent-only ordinal grid and requests its bounded skeleton", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input: URL | RequestInfo) => {
      const url = String(input);
      return Promise.resolve({
        ok: url !== "/api/analysis",
        json: async () =>
          url === matrixUrl
            ? matrixFixture
            : url === "/api/ordinal-evidence"
              ? ordinalFixture
              : {},
      } as Response);
    });
    render(<App initialSource="live" />);
    await screen.findByText("Ordinal sequence");
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/ordinal-evidence"),
    );
    const grid = await screen.findByRole("grid", {
      name: "Ordinal evidence grid",
    });
    expect(grid.querySelectorAll("[role=columnheader]")).toHaveLength(
      ordinalFixture.columns.length,
    );
    expect(
      screen.getByLabelText(
        `Scroll sideways to view all ${ordinalFixture.columns.length} Agents`,
      ),
    ).toBeTruthy();
    expect(grid.textContent).not.toMatch(/UTC|Time/);
    expect(grid.querySelectorAll("[data-ordinal-row]").length).toBeLessThan(
      ordinalFixture.rows.length,
    );
  });

  it("uses only matrix coverage and an explicit identity fallback before deferred secondary evidence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: URL | RequestInfo) =>
        Promise.resolve({
          ok: true,
          json: async () => (String(input) === matrixUrl ? matrixFixture : {}),
        } as Response),
      ),
    );
    render(<App initialSource="live" />);
    expect(await screen.findByText(/Leader unavailable/i)).toBeTruthy();
    expect(
      vi.mocked(fetch).mock.calls.map(([url]) => String(url)),
    ).not.toContain("/api/analysis");
  });

  it("atomically replaces live provenance with fixture evidence", () => {
    window.history.replaceState({}, "", "/?debug=1");
    const fetchMock = vi.mocked(fetch);
    render(<App initialSource="live" />);
    const callsBeforeFixture = fetchMock.mock.calls.length;
    fireEvent.change(screen.getByLabelText("Source"), {
      target: { value: "fixture" },
    });
    expect(screen.getByText("fixture-snap")).toBeTruthy();
    expect(
      screen.getByText(
        /3 Agents · 44 marks returned · request cap 600 · detail: marks/i,
      ),
    ).toBeTruthy();
    expect(fetchMock.mock.calls.length).toBe(callsBeforeFixture);
  });
});
