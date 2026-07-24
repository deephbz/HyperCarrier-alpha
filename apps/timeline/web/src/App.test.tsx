import { readFileSync } from "node:fs";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, laneMarkerPaths, laneOutcomeSummary, snapshotSelection } from "./App";
import { trafficDeepLink } from "./TrafficLaunch";
import { demoSnapshot } from "./demo";

const timelineStyles = readFileSync("web/src/styles.css", "utf8");

afterEach(cleanup);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/?demo=1");
});

describe("dashboard controls", () => {
  it("compresses dense response outcomes into a constant four-path lane surface", () => {
    const snapshot = demoSnapshot();
    const session = snapshot.sessions[0];
    for (const size of [1_500, 10_000]) {
      const lane = {
        session,
        turns: [],
        requests: [],
        requestsByTurn: new Map(),
        rarebits: snapshot.rarebits.filter((marker) => marker.sessionId === session.id),
        responseOutcomes: Array.from({ length: size }, (_, index) => ({
          requestId: `request-${index}`,
          sessionId: session.id,
          at: new Date(Date.parse(session.startedAt) + index * 1_000).toISOString(),
          visual: index % 10 === 0 ? ("stop" as const) : ("continuation" as const),
          stopReason: index % 10 === 0 ? "stop" : "toolUse",
        })),
        start: Date.parse(session.startedAt),
        end: Date.parse(session.endedAt),
      };
      const paths = laneMarkerPaths(lane, [lane.start, lane.start + size * 1_000]);
      expect(Object.keys(paths)).toEqual(["users", "continuation", "stop", "terminal"]);
      expect(paths.continuation.match(/M /g)).toHaveLength(size * 0.9);
      expect(paths.stop.match(/M /g)).toHaveLength(size * 0.1);
      expect(laneOutcomeSummary(lane)).toContain(`toolUse ${size * 0.9}`);
      expect(laneOutcomeSummary(lane)).toContain(`stop ${size * 0.1}`);
    }
  });
  it("builds bounded and lazy snapshot queries from explicit time evidence", () => {
    const now = Date.parse("2026-01-02T00:00:00Z");
    expect(snapshotSelection("24h", null, null, now)).toEqual({
      window: "24h",
      query: "window=24h",
    });
    expect(snapshotSelection("all", null, null, now)).toEqual({
      window: "all",
      query: "window=all",
    });
    expect(snapshotSelection("6h", now - 2 * 3_600_000, now, now)).toEqual({
      window: "6h",
      query: `window=6h&from=${now - 2 * 3_600_000}&to=${now}`,
    });
    expect(snapshotSelection("24h", now - 2 * 24 * 3_600_000, now, now)).toEqual({
      window: "all",
      query: `window=all&from=${now - 2 * 24 * 3_600_000}&to=${now}`,
    });
  });

  it("defaults to a bounded 24h dropdown with the complete time-window surface", () => {
    const { container } = render(<App />);

    const activity = screen.getByRole("combobox", { name: "Activity window" }) as HTMLSelectElement;
    expect(activity.value).toBe("24h");
    expect([...activity.options].map((option) => option.value)).toEqual([
      "15m",
      "1h",
      "6h",
      "24h",
      "all",
    ]);
    expect(screen.getByDisplayValue("Intelligent")).toBeTruthy();
    expect(
      [...container.querySelectorAll(".group-head strong")].map((node) => node.textContent),
    ).toEqual(["Intelligent"]);
    expect(container.querySelectorAll(".group")).toHaveLength(1);
  });

  it("forms exclusive opaque Team or canonical Agent traffic deep links", () => {
    expect(trafficDeepLink("http://127.0.0.1:4321", { teamName: "traffic team" })).toBe(
      "http://127.0.0.1:4321/traffic?team=piteams%3Atraffic+team",
    );
    const sessionIds = [
      ["019f0000", "0000", "7000", "8000", "000000000001"].join("-"),
      ["019f0000", "0000", "7000", "8000", "000000000002"].join("-"),
    ];
    const expected = new URL("/traffic", "http://127.0.0.1:4321");
    for (const sessionId of sessionIds)
      expected.searchParams.append("agent", `pi-session:${sessionId}`);
    expect(trafficDeepLink("http://127.0.0.1:4321", { sessionIds })).toBe(expected.toString());
  });
  it("renders the demo fleet and composes alive, field, and value filters", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByRole("heading", { name: "Pi session timeline" })).toBeTruthy();
    expect(screen.getByText("60 visible")).toBeTruthy();

    await user.click(screen.getByRole("checkbox", { name: "Alive only" }));
    expect(screen.getByText("10 visible")).toBeTruthy();

    await user.selectOptions(screen.getByRole("combobox", { name: "Filter sessions by" }), "state");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter value" }),
      "Running · Thinking",
    );
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
    expect(screen.getByRole("heading", { name: "timeline-lead | api-service" })).toBeTruthy();
    expect(screen.getAllByText("Session ID")).toHaveLength(1);
    expect(screen.getAllByText("demo-0").length).toBeGreaterThan(0);
    const inspector = document.querySelector(".inspector");
    const footer = document.querySelector("footer");
    expect(inspector?.contains(screen.getByRole("button", { name: "Close inspector" }))).toBe(true);
    expect(inspector?.contains(footer)).toBe(false);
    expect(
      inspector?.compareDocumentPosition(footer as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("gives the inspector an internal scrollport that reserves the shared footer size", () => {
    expect(timelineStyles).toMatch(/--app-header-block-size:\s*76px/);
    expect(timelineStyles).toMatch(/--app-toolbar-block-size:\s*50px/);
    expect(timelineStyles).toMatch(/--app-footer-block-size:\s*38px/);
    expect(timelineStyles).toMatch(
      /\.inspector\s*\{.*?top:\s*var\(--app-toolbar-block-size\).*?100dvh\s*-\s*var\(--app-toolbar-block-size\)\s*-\s*var\(--app-footer-block-size\).*?overflow-y:\s*auto/s,
    );
    expect(timelineStyles).toMatch(
      /@media \(max-width: 1050px\).*?\.inspector\s*\{.*?top:\s*calc\(var\(--app-header-block-size\) \+ var\(--app-toolbar-block-size\)\).*?bottom:\s*var\(--app-footer-block-size\);.*?height:\s*auto/s,
    );
    expect(timelineStyles).toMatch(
      /@media \(max-width: 600px\).*?\.workspace\s*\{.*?overflow-x:\s*auto;.*?overscroll-behavior-inline:\s*contain/s,
    );
    expect(timelineStyles).toMatch(/html,\s*body\s*\{.*?max-width:\s*100%;.*?overflow-x:\s*clip/s);
    expect(timelineStyles).toMatch(/main\s*\{.*?padding-bottom:\s*var\(--app-footer-block-size\)/s);
    expect(timelineStyles).toMatch(
      /footer\s*\{.*?position:\s*fixed;.*?left:\s*0;.*?right:\s*0;.*?bottom:\s*0;.*?height:\s*var\(--app-footer-block-size\)/s,
    );
  });

  it("keeps a useful Session identity column while narrow timelines remain scrollable", () => {
    expect(timelineStyles).toMatch(/body\s*\{.*?min-width:\s*0/s);
    expect(timelineStyles).toMatch(/--label:\s*clamp\(320px, 38vw, 460px\)/);
    expect(timelineStyles).toMatch(
      /@media \(max-width: 600px\).*?:root\s*\{.*?--label:\s*clamp\(270px, 82vw, 320px\).*?\.ledger\s*\{.*?min-width:\s*800px/s,
    );
  });

  it("keeps runtime state accessible while the compact secondary shows only Rarebits and usage", () => {
    const { container } = render(<App />);
    const lanes = [...container.querySelectorAll(".lane")];
    expect(lanes.length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/\b\d+\s+outcomes\b/i);

    for (const lane of lanes) {
      const title = lane.querySelector(".lane-context");
      const secondary = lane.querySelector(".lane-secondary small");
      expect(title?.textContent?.trim()).not.toBe("");
      expect(secondary?.textContent).toMatch(/\d+ Rarebits?/);
      expect(secondary?.textContent).toMatch(/\d+(?:\.\d+)?[KMB]? tokens/);
      expect(secondary?.textContent).toMatch(/\$/);
      expect(secondary?.textContent).not.toMatch(
        /Running|Stopped|Idle|Thinking|Using tool|Waiting|Blocked|Settled|Failed|Unknown|Session|outcomes/i,
      );
    }
    const leadButton = screen.getByRole("button", { name: /timeline-lead, session demo-0/ });
    expect(leadButton.getAttribute("aria-label")).toContain("Running · Thinking");

    expect(timelineStyles).toMatch(
      /\.lane-context\s*\{.*?display:\s*-webkit-box.*?white-space:\s*normal.*?-webkit-line-clamp:\s*2/s,
    );
    expect(timelineStyles).toMatch(
      /\.lane-secondary\s*\{.*?display:\s*flex.*?height:\s*20px.*?\.lane-links\s*\{.*?flex:\s*0 0 auto.*?opacity:\s*0\.35/s,
    );
    expect(timelineStyles).toMatch(
      /@media \(max-width: 600px\).*?\.lane-secondary small\s*\{\s*font-size:\s*var\(--text-2xs\)/s,
    );
  });

  it("uses a typography-only subordinate treatment for explicit teammates", () => {
    render(<App />);
    const teammate = screen
      .getByRole("button", { name: /timeline-worker-1, session demo-1/ })
      .querySelector(".lane-context");
    const lead = screen
      .getByRole("button", { name: /timeline-worker-2, session demo-2/ })
      .querySelector(".lane-context");
    const standalone = screen
      .getByRole("button", { name: /timeline-lead, session demo-0/ })
      .querySelector(".lane-context");

    expect(teammate?.classList.contains("lane-context-teammate")).toBe(true);
    expect(lead?.classList.contains("lane-context-primary")).toBe(true);
    expect(standalone?.classList.contains("lane-context-primary")).toBe(true);
    expect(timelineStyles).toMatch(
      /\.lane-context-teammate\s*\{.*?font-size:\s*var\(--text-xs\);.*?font-weight:\s*450/s,
    );
    expect(timelineStyles).toMatch(
      /\.lane-context-teammate \.lane-context-part\s*\{\s*font-weight:\s*inherit/s,
    );
  });

  it("renders tuple coordinates semantically while preserving one canonical accessible label", () => {
    const { container } = render(<App />);
    const firstLane = screen
      .getByRole("button", { name: /timeline-lead, session demo-0/ })
      .closest(".lane");
    const title = firstLane?.querySelector<HTMLElement>(".lane-context");
    const session = title?.querySelector<HTMLElement>('[data-coordinate="session"]');
    const project = title?.querySelector<HTMLElement>('[data-coordinate="project"]');
    const button = firstLane?.querySelector<HTMLButtonElement>(".lane-select");

    expect(session?.textContent).toBe("timeline-lead");
    expect(project?.textContent).toBe("api-service");
    expect(title?.querySelectorAll(".lane-context-separator")).toHaveLength(1);
    expect(title?.getAttribute("aria-label")).toBe("timeline-lead | api-service");
    expect(title?.getAttribute("title")).toBe("timeline-lead | api-service");
    expect(button?.getAttribute("aria-label")).toContain("timeline-lead | api-service");
    expect(container.textContent).not.toMatch(/\b\d+\s+outcomes\b/i);
  });

  it("keeps the canonical tuple available in the inspector", async () => {
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
    expect(screen.getByRole("heading", { name: "timeline-lead | api-service" })).toBeTruthy();
  });

  it("keeps dense lane actions separate while enlarging primary inspector controls", () => {
    const { container } = render(<App />);
    const firstLane = container.querySelector(".lane");
    expect(
      firstLane?.querySelector(".lane-select")?.contains(firstLane.querySelector(".lane-links")),
    ).toBe(false);
    expect(timelineStyles).not.toMatch(/backdrop-filter/);
    expect(timelineStyles).not.toMatch(/text-rendering:\s*optimizeLegibility/);
    expect(timelineStyles).not.toMatch(/var\(--violet\)/);
    expect(timelineStyles).toMatch(
      /\.session-links a:hover,\s*\.session-links a:focus-visible\s*\{.*?border-color:\s*var\(--accent\);.*?color:\s*var\(--accent\)/s,
    );
    expect(timelineStyles).toMatch(/\.toolbar select,\s*\.search\s*\{\s*height:\s*40px/s);
    expect(timelineStyles).toMatch(/\.close\s*\{.*?width:\s*40px;.*?height:\s*40px/s);
    expect(timelineStyles).toMatch(/\.session-links a\s*\{.*?min-height:\s*40px/s);
    expect(timelineStyles).toMatch(
      /@media \(max-width: 600px\).*?\.toolbar select,.*?\.toolbar input\s*\{.*?font-size:\s*16px.*?\.close,\s*\.session-links a\s*\{.*?min-height:\s*44px/s,
    );
    expect(timelineStyles).toMatch(/--lane-action-size:\s*40px/);
    expect(timelineStyles).toMatch(/--lane-action-gap:\s*16px/);
    expect(timelineStyles).toMatch(
      /--lane-action-icon-size:\s*calc\(var\(--lane-action-size\) - var\(--lane-action-gap\)\)/,
    );
    expect(timelineStyles).toMatch(
      /--lane-action-zone:\s*calc\(var\(--lane-action-size\) \* 2 \+ 12px\)/,
    );
    expect(timelineStyles).toMatch(/--lane-action-y-offset:\s*-8px/);
    expect(timelineStyles).toMatch(
      /\.lane-label\s*\{.*?position:\s*relative.*?\.lane-select::before\s*\{.*?inset:\s*0 var\(--lane-action-zone\) 0 0/s,
    );
    expect(timelineStyles).toMatch(
      /\.lane-links\s*\{.*?z-index:\s*2.*?gap:\s*var\(--lane-action-gap\).*?margin-right:\s*8px.*?\.lane-links a::before\s*\{.*?width:\s*var\(--lane-action-size\).*?height:\s*var\(--lane-action-size\)/s,
    );
    expect(timelineStyles).toMatch(
      /\.lane-links a::before\s*\{.*?top:\s*calc\(50% \+ var\(--lane-action-y-offset\)\)/s,
    );
    expect(timelineStyles).toMatch(
      /@media \(hover: none\)\s*\{\s*\.lane-links\s*\{\s*opacity:\s*0\.65/s,
    );
    expect(timelineStyles).toMatch(
      /@media \(max-width: 600px\).*?:root\s*\{.*?--lane-action-size:\s*44px/s,
    );
  });

  it("keeps response markers and their detailed accessible summary without visible counts", () => {
    const { container } = render(<App />);
    expect(container.querySelectorAll("path.response-marker-continuation").length).toBeGreaterThan(
      0,
    );
    expect(container.querySelectorAll("path.response-marker-stop").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("path.response-marker-terminal").length).toBeGreaterThan(0);
    const summaries = screen.getAllByRole("img", { name: /User messages and response outcomes/ });
    expect(summaries.length).toBeGreaterThan(0);
    const labels = summaries.map((summary) => summary.getAttribute("aria-label") ?? "");
    expect(labels.every((label) => /: (?:no response outcomes|.+ \d+)/.test(label))).toBe(true);
    expect(labels.some((label) => /(?:toolUse|stop|error) \d+/.test(label))).toBe(true);
  });

  it("uses one Rarebit marker projection and lazily fetches the selected Session summary", async () => {
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
    expect(document.querySelectorAll("path.user-marker").length).toBeGreaterThan(0);
    expect(document.querySelectorAll("path.response-marker-stop").length).toBeGreaterThan(0);
    expect(fetch).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /timeline-lead, session demo-0/ }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/sessions/demo-0/rarebit-summary",
        expect.objectContaining({ signal: expect.anything() }),
      ),
    );
    expect(await screen.findByText("Derived summary only.")).toBeTruthy();
    const summary = screen.getByText("Rarebit Summary").closest("section");
    const diagnostics = screen.getByText("Native diagnostics & provenance").closest("details");
    expect(
      summary?.compareDocumentPosition(diagnostics as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows current automatic inhibition separately from stale historical summary and attention", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          availability: "stale",
          status: "inhibited",
          summary: "Historical teammate summary.",
          automaticSummaryPolicy: {
            state: "inhibited",
            provider: "pi-teams",
            reason: "current_teammate_membership",
            observedAt: "2026-07-24T01:02:03.000Z",
            validUntil: "2026-07-24T01:02:04.000Z",
          },
          historicalSummary: {
            availability: "stale",
            status: "ok",
            observedAt: "2026-07-23T01:02:03.000Z",
            jobId: "history-job",
          },
        }),
      }),
    );
    render(<App />);
    await user.click(screen.getByRole("button", { name: /timeline-lead, session demo-0/ }));
    expect(await screen.findByText("Historical teammate summary.")).toBeTruthy();
    expect(screen.getByText(/Automatic summary inhibited by team-management policy/)).toBeTruthy();
    expect(
      screen.getByText(/This says nothing about attention, health, or readiness/),
    ).toBeTruthy();
    expect(screen.getByText(/Historical summary as of 2026-07-23/)).toBeTruthy();
    expect(document.querySelectorAll("path.user-marker").length).toBeGreaterThan(0);
  });

  it("labels an expired inhibition receipt as historical policy evidence", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          availability: "missing",
          status: "inhibited",
          automaticSummaryPolicy: {
            state: "inhibition_receipt_expired",
            provider: "pi-teams",
            reason: "current_teammate_membership",
            observedAt: "2026-07-24T01:02:03.000Z",
            validUntil: "2026-07-24T01:02:04.000Z",
          },
          historicalSummary: { availability: "missing" },
        }),
      }),
    );
    render(<App />);
    await user.click(screen.getByRole("button", { name: /timeline-lead, session demo-0/ }));
    expect(
      await screen.findByText(/Latest automatic-summary inhibition receipt expired/),
    ).toBeTruthy();
    expect(screen.getByText(/current policy status requires a fresh query/)).toBeTruthy();
    expect(screen.getByText(/No historical summary is available/)).toBeTruthy();
    expect(screen.queryByText(/^Automatic summary inhibited by team-management policy/)).toBeNull();
  });

  it("copies a detail value on row click but preserves text-selection interaction", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ availability: "missing", reason: "sidecar_missing" }),
      }),
    );

    render(<App />);
    await user.click(screen.getByRole("button", { name: /timeline-lead, session demo-0/ }));
    const row = screen.getByTitle("Click to copy Session ID");
    await user.click(row);
    expect(writeText).toHaveBeenCalledWith("demo-0");

    const selection = vi.spyOn(window, "getSelection").mockReturnValue({
      toString: () => "demo",
    } as Selection);
    await user.click(row);
    expect(writeText).toHaveBeenCalledTimes(1);
    selection.mockRestore();

    const originalExecCommand = document.execCommand;
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    await user.click(screen.getByRole("button", { name: "Copy Session ID" }));
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: originalExecCommand,
    });
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
    const response = { ok: true, text: async () => JSON.stringify(demoSnapshot()) };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ baseUrl: "http://127.0.0.1:4321" }) })
      .mockReturnValueOnce(first.then(() => response))
      .mockResolvedValue(response);
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", fetch);

    const { App: LiveApp } = await import("./App");
    render(<LiveApp />);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/snapshot?window=24h");

    await act(async () => {
      listeners.get("ready")?.();
      listeners.get("invalidate")?.();
      vi.advanceTimersByTime(100);
    });
    expect(fetch).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveFirst(undefined);
      await Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenNthCalledWith(3, "/api/snapshot?window=24h");
  });

  it("fails visibly instead of treating a stale backend as zero Rarebits", async () => {
    window.history.replaceState({}, "", "/");
    vi.resetModules();
    class FakeEventSource {
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({ sourceVersion: 1, keyMessages: [] }),
      }),
    );
    const { App: LiveApp } = await import("./App");
    render(<LiveApp />);
    expect((await screen.findByRole("alert")).textContent).toContain("schema mismatch");
    expect(screen.queryByText("0 Rarebits")).toBeNull();
  });

  it("loads All history incrementally and preserves server-owned inspector links", async () => {
    window.history.replaceState({}, "", "/");
    vi.resetModules();

    class FakeEventSource {
      addEventListener() {}
      close() {}
    }
    const page = (window: "24h" | "all", hasOlder: boolean, nextCursor: string | null) => {
      const snapshot = demoSnapshot();
      snapshot.sessions[0] = {
        ...snapshot.sessions[0],
        links: {
          live: "http://127.0.0.1:4319/session/demo-0",
          tps: "http://127.0.0.1:4320/?auto=1&session=demo-0",
        },
      };
      snapshot.page = { window, hasOlder, nextCursor, source: "last_message_at" };
      return snapshot;
    };
    const fetch = vi.fn(async (url: string) => {
      const body = url.includes("before=older-cursor")
        ? page("all", false, null)
        : url.includes("window=all")
          ? page("all", true, "older-cursor")
          : page("24h", false, null);
      return {
        ok: true,
        text: async () => JSON.stringify(body),
        json: async () => body,
      };
    });
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", fetch);

    const { App: LiveApp } = await import("./App");
    const user = userEvent.setup();
    render(<LiveApp />);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/snapshot?window=24h"));
    expect(await screen.findAllByTitle("Open live session inspector")).not.toHaveLength(0);

    await user.selectOptions(screen.getByRole("combobox", { name: "Activity window" }), "all");
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/snapshot?window=all"));
    await user.click(await screen.findByRole("button", { name: "Load older Sessions" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/snapshot?window=all&before=older-cursor"),
    );
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
