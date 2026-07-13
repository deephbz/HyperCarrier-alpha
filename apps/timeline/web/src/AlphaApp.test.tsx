import { readFileSync } from "node:fs";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlphaApp, axisCardModel, recentSummaryModels, runtimeEmptyText } from "./AlphaApp";
import { alphaDemoSnapshot } from "./alpha-demo";
import { decisionSummaryModel, orderProjectsByIntervention } from "./alpha-decision";

const alphaStyles = readFileSync("web/src/alpha.css", "utf8");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const liveSnapshot = {
  schemaVersion: 1,
  generatedAt: "2026-07-13T00:00:00.000Z",
  projects: [],
  trace: {
    schemaVersion: 1,
    derivationVersion: "test",
    generatedAt: "2026-07-13T00:00:00.000Z",
    diagnostics: [],
  },
};

describe("Alpha project board", () => {
  it("keeps AxisCard rendering decisions in a covered pure seam", () => {
    expect(
      axisCardModel({ state: "partial", reason: "partial_source", diagnostics: [{}] } as never),
    ).toEqual({
      state: "partial",
      reason: "partial source",
      diagnosticCount: 1,
    });
    expect(axisCardModel({ provenance: {} } as never)).toEqual({
      state: "observed",
      reason: undefined,
      diagnosticCount: 0,
    });
    expect(runtimeEmptyText({ reason: "no_explicit_runtime_association" } as never)).toBe(
      "No Session association configured",
    );
    expect(runtimeEmptyText({ reason: "no_current_runtime_observation" } as never)).toBe(
      "Session associated; no current runtime observation",
    );
  });

  it("derives the operator decision from intervention and change evidence", () => {
    const projects = alphaDemoSnapshot().projects;
    expect(decisionSummaryModel(projects[0])).toMatchObject({
      bucket: "owner-action",
      actor: "Likely owner",
      action: "human approval needed",
      why: "owner decision watermark is behind",
    });
    expect(decisionSummaryModel(projects[0]).whatChanged).toContain("waiting on owner input");
    expect(decisionSummaryModel(projects[2])).toMatchObject({
      bucket: "unresolved",
      actor: "Unassessed",
      action: expect.stringContaining("no fresh evidence"),
      headline: expect.stringContaining("Unassessed"),
      evidenceBasis: expect.stringContaining("No fresh recent output"),
    });
    expect(decisionSummaryModel(projects[2]).uncertainty).toContain("does not assign owner action");
  });

  it("differentiates and orders two unassessed Projects by categorical evidence", () => {
    const projects = alphaDemoSnapshot().projects;
    const freshOutput = {
      ...projects[0],
      projectRef: { ...projects[0].projectRef, id: "unresolved-fresh", name: "Fresh evidence" },
      intervention: {
        ...projects[0].intervention,
        state: "unknown",
        items: [],
        reason: "no_intervention_assessment",
      },
    };
    const noOutput = {
      ...projects[2],
      projectRef: { ...projects[2].projectRef, id: "unresolved-empty", name: "No output" },
      intervention: {
        ...projects[2].intervention,
        items: [],
        reason: "no_intervention_assessment",
      },
    };
    const freshSummary = decisionSummaryModel(freshOutput);
    const emptySummary = decisionSummaryModel(noOutput);

    expect(freshSummary.bucket).toBe("unresolved");
    expect(emptySummary.bucket).toBe("unresolved");
    expect(freshSummary.headline).not.toBe(emptySummary.headline);
    expect(freshSummary.headline).toContain("no owner action assigned");
    expect(emptySummary.headline).toContain("no owner action assigned");
    expect(freshSummary.evidenceBasis).toContain(
      "Fresh recent output and meaningful recorded changes",
    );
    expect(
      orderProjectsByIntervention([noOutput, freshOutput]).map(
        (project) => project.projectRef.name,
      ),
    ).toEqual(["Fresh evidence", "No output"]);
  });

  it("projects a long real-data-like Markdown summary into bounded plain text", () => {
    const source = alphaDemoSnapshot().projects[2];
    const longProgress =
      "The adapter now records the latest source contract, preserves the reported evidence boundary, and keeps the operator-facing projection aligned while the remaining validation path continues through several deliberately verbose clauses that should be clipped for the board surface.";
    const markdownTick = String.fromCharCode(96);
    const longSummary =
      `# hc-recent-output\n\n## Progress\n- **Progress:** ${markdownTick}${longProgress}${markdownTick}\n\n## Findings\n- ` +
      `${markdownTick}raw-summary-id-987${markdownTick} remains traceable from the source record.\n- The rest of this structured report contains many more words than the depth-0 surface should carry, including questions, next steps, and delivery notes.`;
    const project = {
      ...source,
      recentOutput: {
        ...source.recentOutput,
        provenance: { ...source.recentOutput.provenance, freshness: "fresh" as const },
        items: [{ summary: longSummary, observedAt: "2026-07-13T00:00:01.000Z" }],
      },
      eventDelta: { ...source.eventDelta, count: 53 },
      evergreenDelta: { ...source.evergreenDelta, changeCount: 53 },
    };
    const summary = decisionSummaryModel(project);

    expect(summary.headline).toBe(
      "Unassessed — recent output and changes available; no owner action assigned.",
    );
    expect(summary.headline.length).toBeLessThan(100);
    expect(summary.whatChanged).toContain("Agent reported:");
    expect(summary.whatChanged).toContain("53 total recorded events");
    expect(summary.whatChanged).toContain("Evergreen proposal available");
    expect(summary.whatChanged.match(/53/g)).toHaveLength(1);
    expect(summary.whatChanged).not.toMatch(/[*_#`]/);
    expect(summary.whatChanged).not.toContain("raw-summary-id-987");
    expect(summary.whatChanged.length).toBeLessThanOrEqual(320);
    expect(summary.whatChanged).toContain("…");
  });

  it("extracts only Progress from a v2 one-line pipe summary", () => {
    const source = alphaDemoSnapshot().projects[2];
    const project = {
      ...source,
      recentOutput: {
        ...source.recentOutput,
        provenance: { ...source.recentOutput.provenance, freshness: "fresh" as const },
        items: [
          {
            summary:
              "Progress: one bounded operator fact. | Findings: must stay in drill-down. | Questions/Requests: owner review. | Next step: inspect trace.",
            observedAt: "2026-07-13T00:00:01.000Z",
          },
        ],
      },
    };
    const summary = decisionSummaryModel(project);
    expect(summary.whatChanged).toContain("one bounded operator fact.");
    expect(summary.whatChanged).not.toContain("must stay in drill-down");
    expect(summary.whatChanged).not.toContain("owner review");
  });

  it("sorts recent reports newest-first without treating source order as recency", () => {
    const source = alphaDemoSnapshot().projects[0].recentOutput;
    const models = recentSummaryModels({
      ...source,
      items: [
        {
          summary: "older",
          provenance: {
            ...source.provenance,
            validAt: "2026-07-12T10:00:00.000Z",
          },
        },
        {
          summary: "newer",
          provenance: {
            ...source.provenance,
            validAt: "2026-07-12T11:00:00.000Z",
          },
        },
      ],
    });
    expect(models.map(({ item }) => item.summary)).toEqual(["newer", "older"]);
  });

  it("does not let duplicate proposal counts amplify intervention ordering", () => {
    const source = alphaDemoSnapshot().projects[2];
    const withEventAndProposal = {
      ...source,
      projectRef: { ...source.projectRef, id: "event-and-proposal" },
      recentOutput: { ...source.recentOutput, items: [] },
      eventDelta: { ...source.eventDelta, count: 1 },
      evergreenDelta: { ...source.evergreenDelta, changeCount: 999 },
    };
    const withEventOnly = {
      ...source,
      projectRef: { ...source.projectRef, id: "event-only" },
      recentOutput: { ...source.recentOutput, items: [] },
      eventDelta: { ...source.eventDelta, count: 1 },
      evergreenDelta: { ...source.evergreenDelta, changeCount: 0 },
    };
    expect(
      orderProjectsByIntervention([withEventOnly, withEventAndProposal]).map(
        (project) => project.projectRef.id,
      ),
    ).toEqual(["event-only", "event-and-proposal"]);
  });

  it("orders owner action, unresolved assessment, team action, then no action", () => {
    const projects = alphaDemoSnapshot().projects;
    const noAction = {
      ...projects[0],
      projectRef: { ...projects[0].projectRef, id: "alpha-no-action", name: "No action" },
      intervention: {
        ...projects[0].intervention,
        items: [{ assessment: "no current action", reason: "continue monitoring" }],
      },
    };
    expect(
      orderProjectsByIntervention([...projects, noAction]).map(
        (project) => project.projectRef.name,
      ),
    ).toEqual(["Alpha review", "Needs review", "Watchdog lane", "No action"]);
  });

  it("renders explicit demo content only when the demo mode is selected", () => {
    render(<AlphaApp demo />);
    expect(screen.getByRole("heading", { name: "Projects, evidence, and decisions" })).toBeTruthy();
    expect(screen.getByText("Alpha review")).toBeTruthy();
    expect(screen.getByText("Watchdog lane")).toBeTruthy();
    expect(screen.getByText("Needs review")).toBeTruthy();
    expect(screen.getAllByText("Seven evidence axes")).toHaveLength(3);
    expect(screen.getAllByText("unknown · ambiguous").length).toBeGreaterThan(0);
    expect(screen.getAllByText("stale · exact").length).toBeGreaterThan(0);
  });

  it("keeps axis evidence collapsed until requested and labels the decision region", async () => {
    const user = userEvent.setup();
    render(<AlphaApp demo />);
    const firstCard = screen.getAllByRole("article")[0];
    expect(within(firstCard).getByRole("region", { name: /Likely owner/ })).toBeTruthy();
    const disclosure = within(firstCard).getByText("Seven evidence axes").closest("details");
    expect(disclosure?.hasAttribute("open")).toBe(false);
    await user.click(within(firstCard).getByText("Seven evidence axes"));
    expect(within(firstCard).getByRole("region", { name: "Runtime axis" })).toBeTruthy();
    expect(within(firstCard).getByText(/Latest agent report/)).toBeTruthy();
    expect(within(firstCard).getByText("Agent reported:")).toBeTruthy();
    expect(within(firstCard).getByText(/source refs: summary:alpha-review-summary/)).toBeTruthy();
    expect(
      within(firstCard).getByRole("region", { name: "Recorded event history axis" }),
    ).toBeTruthy();
    expect(within(firstCard).getByText("2 total recorded event(s)")).toBeTruthy();
    expect(
      within(firstCard).getByText(
        "Canonical context exists; no delivery or acceptance evidence recorded.",
      ),
    ).toBeTruthy();
    expect(
      within(firstCard)
        .getByRole("region", { name: "Delivery evidence axis" })
        .querySelector(".alpha-state"),
    ).toBeNull();

    const unknownRuntimeCard = screen
      .getAllByRole("article")
      .find((card) => within(card).queryByText("Needs review"));
    expect(unknownRuntimeCard).toBeTruthy();
    await user.click(within(unknownRuntimeCard!).getByText("Seven evidence axes"));
    expect(within(unknownRuntimeCard!).getByText("No Session association configured")).toBeTruthy();
  });

  it("keeps raw internals out of the decision surface while showing requested report refs", async () => {
    const user = userEvent.setup();
    render(<AlphaApp demo />);
    const firstCard = screen.getAllByRole("article")[0];
    const defaultSurface = `${firstCard.querySelector(".alpha-project-head")?.textContent} ${firstCard.querySelector(".alpha-decision")?.textContent}`;
    expect(defaultSurface).not.toMatch(/alpha-review|manifest:|hash|refs:|source diagnostic/);
    await user.click(within(firstCard).getByText("Seven evidence axes"));
    const axesSurface = firstCard.querySelector(".alpha-axes")?.textContent ?? "";
    expect(axesSurface).toContain("source refs: summary:alpha-review-summary");
    expect(axesSurface).not.toMatch(/manifest:|hash|source diagnostic|Project ID/);
  });

  it("uses a keyboard-modal trace drawer and returns focus to Trace", async () => {
    const user = userEvent.setup();
    render(<AlphaApp demo />);
    const traceButton = screen.getAllByRole("button", { name: "Trace" })[0];
    await user.click(traceButton);
    expect(traceButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("dialog", { name: "Alpha review" })).toBeTruthy();
    expect(screen.getByText("Trace / raw refs")).toBeTruthy();
    expect(
      within(screen.getByRole("dialog", { name: "Alpha review" })).getByText(/identity refs:/),
    ).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Alpha review" }).textContent).toContain(
      "Project ID: alpha-review",
    );
    expect(
      within(screen.getByRole("dialog", { name: "Alpha review" })).getAllByText(
        /manifest:alpha-review/,
      ).length,
    ).toBeGreaterThan(0);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close trace" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(traceButton);
  });

  it("shows loading, live error, and retry instead of synthetic fallback", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("GET /api/alpha/snapshot failed"));
    render(<AlphaApp demo={false} />);
    expect(screen.getByRole("status").textContent).toContain("Loading explicit Project manifest");
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("GET /api/alpha/snapshot failed");
    expect(screen.queryByText("Alpha review")).toBeNull();
    expect(screen.getByRole("link", { name: "Open synthetic demo" }).getAttribute("href")).toBe(
      "/alpha?demo=1",
    );
  });

  it("renders an explicit empty-manifest state", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(liveSnapshot), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    render(<AlphaApp demo={false} />);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("No explicit Projects configured"),
    );
  });

  it("keeps the trace usable at a narrow mobile viewport", async () => {
    window.innerWidth = 320;
    const user = userEvent.setup();
    render(<AlphaApp demo />);
    await user.click(screen.getAllByRole("button", { name: "Trace" })[0]);
    const dialog = screen.getByRole("dialog", { name: "Alpha review" });
    expect(dialog.className).toContain("alpha-trace");
    expect(window.innerWidth).toBe(320);
  });

  it("keeps Alpha mobile containers shrinkable and long text wrappable", () => {
    render(<AlphaApp demo />);

    expect(document.querySelector(".alpha-top > div:first-child")).toBeTruthy();
    expect(document.querySelector(".alpha-board")).toBeTruthy();
    expect(document.querySelector(".alpha-project")).toBeTruthy();
    expect(document.querySelector(".alpha-decision")).toBeTruthy();
    expect(document.querySelector(".alpha-decision-details > div")).toBeTruthy();
    expect(document.querySelector(".alpha-axis")).toBeTruthy();

    expect(alphaStyles).toMatch(/body:has\(\.alpha-page\)\s*\{[^}]*min-width:\s*0/s);
    expect(alphaStyles).toMatch(/\.alpha-top\s*\{[^}]*min-width:\s*0/s);
    expect(alphaStyles).toMatch(
      /\.alpha-board\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s,
    );
    expect(alphaStyles).toMatch(/\.alpha-project\s*\{[^}]*min-width:\s*0/s);
    expect(alphaStyles).toMatch(/\.alpha-decision\s*\{[^}]*min-width:\s*0/s);
    expect(alphaStyles).toMatch(/\.alpha-axes\s*\{[^}]*min-width:\s*0/s);
    expect(alphaStyles).toMatch(/\.alpha-top h1[\s\S]*?overflow-wrap:\s*anywhere/);
    expect(alphaStyles).toMatch(/\.alpha-project-head h2[\s\S]*?overflow-wrap:\s*anywhere/);
    expect(alphaStyles).toMatch(/\.alpha-decision h3[\s\S]*?overflow-wrap:\s*anywhere/);
    expect(alphaStyles).toMatch(/\.alpha-decision-details dd[\s\S]*?overflow-wrap:\s*anywhere/);
  });
});
