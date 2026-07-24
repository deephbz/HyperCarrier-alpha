import { describe, it, expect } from "vitest";
import {
  compareIntelligentLanes,
  countLabel,
  effectiveProjectLabel,
  extent,
  filterLanesByBoundedTime,
  position,
  filterKey,
  groupKey,
  inspectorDiagnosticDetails,
  inspectorDetails,
  laneAlias,
  laneContextPresentation,
  laneIdentityEmphasis,
  laneSecondaryLabel,
  lanesFromSnapshot,
  runtimePresentation,
  responseOutcomesFromRequests,
  sessionMatchesQuery,
} from "./model";
import { demoSnapshot } from "./demo";
import type { Lane, Snapshot } from "./types";
const observedUsage = (tokens = 1, cost = 0) =>
  ({
    tokens: { availability: "complete", value: tokens },
    cost: { availability: "complete", value: cost },
  }) as const;
const lane = {
  session: {
    id: "s",
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T01:00:00Z",
    cwd: "/work/atlas",
    projectName: "atlas",
    source: "x",
    turnCount: 1,
    requestCount: 1,
    usage: observedUsage(10, 1),
  },
  turns: [],
  requests: [],
  start: 1,
  end: 2,
} as Lane;
describe("timeline model", () => {
  it("pluralizes presentation counts from one shared rule", () => {
    expect(countLabel(0, "Rarebit")).toBe("0 Rarebits");
    expect(countLabel(1, "Rarebit")).toBe("1 Rarebit");
    expect(countLabel(2, "Rarebit")).toBe("2 Rarebits");
    expect(countLabel(1, "entry", "entries")).toBe("1 entry");
    expect(countLabel(2, "entry", "entries")).toBe("2 entries");
  });
  it("groups by project", () => expect(groupKey(lane, "project")).toBe("atlas"));
  it("clamps positions", () => {
    expect(position(-1, [0, 10])).toBe(100);
    expect(position(20, [0, 10])).toBe(0);
    expect(position(10, [0, 10])).toBe(0);
    expect(position(0, [0, 10])).toBe(100);
  });
  it("uses selected recent range", () => expect(extent([], 1, 3_600_000)).toEqual([0, 3_600_000]));
  it("keeps live agents visible before their session log is discoverable", () => {
    const snapshot = {
      generatedAt: "2026-01-01T01:00:00Z",
      schemaVersion: 3,
      sessions: [],
      turns: [],
      requests: [],
      liveAgents: [
        {
          processInstanceId: "p1",
          pid: 1,
          cwd: "/work/new",
          state: "idle",
          confidence: "exact",
          processStartedAt: "2026-01-01T00:00:00Z",
        },
      ],
      trace: { durationMs: 1, sessionFiles: 0, rejected: [] },
    } as Snapshot;
    const lanes = lanesFromSnapshot(snapshot);
    expect(lanes).toHaveLength(1);
    expect(lanes[0].session.id).toBe("live:p1");
    expect(lanes[0].live?.processInstanceId).toBe("p1");
    expect(lanes[0].session.usage).toEqual({
      tokens: { availability: "unavailable" },
      cost: { availability: "unavailable" },
    });
  });

  it("uses the context tuple only as presentation and keeps runtime state distinct", () => {
    const contextLane = {
      ...lane,
      session: { ...lane.session, id: "session-one", name: "release" },
      live: {
        processInstanceId: "process-one",
        pid: 42,
        cwd: "/work/atlas",
        state: "idle",
        confidence: "exact",
        coordination: {
          kind: "pi-team",
          teamName: "alpha",
          agentName: "reviewer",
          role: "teammate",
          source: "fixture",
        },
      },
    } as Lane;
    const samePresentation = {
      ...contextLane,
      session: { ...contextLane.session, id: "session-two" },
      live: { ...contextLane.live!, processInstanceId: "process-two", pid: 99 },
    } as Lane;

    expect(groupKey(contextLane, "context")).toBe("Intelligent");
    expect(groupKey(contextLane, "context")).toBe(groupKey(samePresentation, "context"));
    expect(contextLane.session.id).not.toBe(samePresentation.session.id);
    expect(laneContextPresentation(contextLane).label).toBe(
      laneContextPresentation(samePresentation).label,
    );
    expect(laneContextPresentation(contextLane).label).toBe("alpha | reviewer | release | atlas");
    expect(laneContextPresentation(contextLane).parts).toEqual([
      { coordinate: "team", value: "alpha" },
      { coordinate: "team-role", value: "reviewer" },
      { coordinate: "session", value: "release" },
      { coordinate: "project", value: "atlas" },
    ]);
    expect(laneContextPresentation(contextLane).label).not.toContain("42");
    expect(runtimePresentation(contextLane)).toEqual({
      label: "Running · Idle",
      processLabel: "Running",
      workLabel: "Idle",
      className: "state-idle",
    });
    expect(runtimePresentation(lane)).toEqual({
      label: "Stopped",
      processLabel: "Stopped",
      workLabel: "No live process",
      className: "state-stopped",
    });
    const processOnly = {
      ...contextLane,
      live: {
        ...contextLane.live!,
        confidence: "process_only",
        state: undefined,
        processState: "running",
        workState: {
          availability: "unobserved",
          reason: "lifecycle_evidence_unavailable",
        },
      },
    } as Lane;
    expect(runtimePresentation(processOnly)).toEqual({
      label: "Running · work state unavailable",
      processLabel: "Running",
      workLabel: "Work state unavailable",
      className: "state-unobserved",
    });

    const unlabeled = {
      ...lane,
      session: { ...lane.session, name: undefined, projectName: undefined },
    } as Lane;
    expect(effectiveProjectLabel(unlabeled)).toBe("atlas");
    expect(laneContextPresentation(unlabeled).label).toBe("atlas");

    const noProjectCoordinate = {
      ...unlabeled,
      session: { ...unlabeled.session, cwd: "" },
    } as Lane;
    expect(laneContextPresentation(noProjectCoordinate).label).toBe("Unlabelled session");
  });

  it("de-emphasizes only an explicit teammate coordination role", () => {
    const teammate = {
      ...lane,
      live: {
        processInstanceId: "teammate",
        pid: 1,
        cwd: lane.session.cwd,
        confidence: "exact",
        coordination: {
          kind: "pi-team",
          teamName: "alpha",
          agentName: "builder",
          role: "teammate",
          source: "fixture",
        },
      },
    } as Lane;
    const lead = {
      ...teammate,
      live: {
        ...teammate.live!,
        processInstanceId: "lead",
        coordination: { ...teammate.live!.coordination!, role: "lead" },
      },
    } as Lane;
    const unknown = {
      ...teammate,
      live: {
        ...teammate.live!,
        processInstanceId: "unknown",
        coordination: { ...teammate.live!.coordination!, role: "unknown" },
      },
    } as unknown as Lane;

    expect(laneIdentityEmphasis(teammate)).toBe("teammate");
    expect(laneIdentityEmphasis(lead)).toBe("primary");
    expect(laneIdentityEmphasis(lane)).toBe("primary");
    expect(laneIdentityEmphasis(unknown)).toBe("primary");
  });

  it("formats complete, partial, zero, and unavailable Session usage independently", () => {
    const withUsage = (usage: Lane["session"]["usage"]) =>
      ({
        ...lane,
        session: { ...lane.session, usage },
        rarebits: [{}, {}],
      }) as Lane;

    expect(
      laneSecondaryLabel(
        withUsage({
          tokens: { availability: "complete", value: 1_250_000 },
          cost: { availability: "complete", value: 12.345 },
        }),
      ),
    ).toBe("2 Rarebits · 1.3M tokens · $12.35");
    expect(
      laneSecondaryLabel(
        withUsage({
          tokens: { availability: "complete", value: 0 },
          cost: { availability: "complete", value: 0 },
        }),
      ),
    ).toBe("2 Rarebits · 0 tokens · $0.00");
    expect(
      laneSecondaryLabel(
        withUsage({
          tokens: { availability: "partial", value: 12_500 },
          cost: { availability: "unavailable" },
        }),
      ),
    ).toBe("2 Rarebits · known 12.5K tokens · —");
    expect(
      laneSecondaryLabel(
        withUsage({
          tokens: { availability: "partial", value: 12_450 },
          cost: { availability: "partial", value: 12.345 },
        }),
      ),
    ).toBe("2 Rarebits · known 12.5K tokens · known $12.35");
    expect(
      laneSecondaryLabel(
        withUsage({
          tokens: { availability: "unavailable" },
          cost: { availability: "partial", value: 0.004 },
        }),
      ),
    ).toBe("2 Rarebits · — tokens · known <$0.01");
  });

  it("keeps dense response outcomes independent from sparse Rarebit evidence", () => {
    const requests = [
      ...Array.from({ length: 69 }, (_, index) => ({
        id: `tool-${index}`,
        sessionId: "s",
        at: `2026-07-16T04:${String(index % 60).padStart(2, "0")}:00Z`,
        stopReason: "toolUse",
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        id: `stop-${index}`,
        sessionId: "s",
        at: `2026-07-16T05:0${index}:00Z`,
        stopReason: "stop",
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `error-${index}`,
        sessionId: "s",
        at: `2026-07-16T05:1${index}:00Z`,
        stopReason: "error",
      })),
      {
        id: "last-stop",
        sessionId: "s",
        at: "2026-07-16T05:20:00Z",
        stopReason: "stop",
      },
    ].map((request) => ({
      ...request,
      cost: 0,
      totalTokens: 0,
      output: 0,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
    }));
    const outcomes = responseOutcomesFromRequests(requests);
    expect(outcomes.filter((marker) => marker.visual === "continuation")).toHaveLength(69);
    expect(outcomes.filter((marker) => marker.visual === "stop")).toHaveLength(4);
    expect(outcomes.filter((marker) => marker.stopReason === "error")).toHaveLength(4);
    expect(outcomes.at(-1)).toMatchObject({ requestId: "last-stop", visual: "stop" });
  });

  it("sorts Intelligent lanes by the presentation tuple, then Session ID", () => {
    const makeLane = (id: string, name: string, cwd: string, teamName?: string) =>
      ({
        ...lane,
        session: { ...lane.session, id, name, cwd, projectName: undefined },
        live: teamName
          ? {
              processInstanceId: `process-${id}`,
              pid: 1,
              cwd,
              state: "idle",
              confidence: "exact",
              coordination: {
                kind: "pi-team",
                teamName,
                agentName: "lead",
                role: "lead",
                source: "fixture",
              },
            }
          : undefined,
      }) as Lane;
    const lanes = [
      makeLane("z", "beta", "/work/zeta", "team-b"),
      makeLane("b", "alpha", "/work/beta", "team-a"),
      makeLane("a", "alpha", "/work/alpha", "team-a"),
      makeLane("solo", "solo", "/work/solo"),
    ];

    expect([...lanes].sort(compareIntelligentLanes).map((item) => item.session.id)).toEqual([
      "solo",
      "a",
      "b",
      "z",
    ]);
  });
});

describe("bounded timeline filtering", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  const snapshot = {
    generatedAt: "2026-01-01T12:00:00Z",
    schemaVersion: 3,
    sessions: [
      {
        id: "old-recent-message",
        startedAt: "2025-01-01T00:00:00Z",
        endedAt: "2025-01-01T00:01:00Z",
        lastMessageAt: "2026-01-01T11:30:00Z",
        cwd: "/work/old-recent",
        source: "pi-jsonl",
        turnCount: 1,
        requestCount: 1,
        usage: observedUsage(),
      },
      {
        id: "recent-start-stale-message",
        startedAt: "2026-01-01T11:45:00Z",
        endedAt: "2026-01-01T11:50:00Z",
        lastMessageAt: "2026-01-01T08:00:00Z",
        cwd: "/work/recent-start",
        source: "pi-jsonl",
        turnCount: 1,
        requestCount: 1,
        usage: observedUsage(),
      },
      {
        id: "live-stale-message",
        startedAt: "2026-01-01T11:45:00Z",
        endedAt: "2026-01-01T11:50:00Z",
        lastMessageAt: "2026-01-01T08:00:00Z",
        cwd: "/work/live-stale",
        source: "pi-jsonl",
        turnCount: 1,
        requestCount: 1,
        usage: observedUsage(),
      },
      {
        id: "missing-message-time",
        startedAt: "2026-01-01T11:45:00Z",
        endedAt: "2026-01-01T11:50:00Z",
        lastMessageAt: null,
        cwd: "/work/missing",
        source: "pi-jsonl",
        turnCount: 1,
        requestCount: 1,
        usage: observedUsage(),
      },
    ],
    turns: [],
    requests: [],
    liveAgents: [
      {
        processInstanceId: "p-live-stale",
        pid: 1,
        sessionId: "live-stale-message",
        cwd: "/work/live-stale",
        state: "thinking",
        heartbeatAt: "2026-01-01T11:59:00Z",
        confidence: "exact",
      },
      {
        processInstanceId: "p-live-only",
        pid: 2,
        cwd: "/work/live-only",
        state: "thinking",
        heartbeatAt: "2026-01-01T11:59:00Z",
        confidence: "exact",
      },
    ],
    trace: { durationMs: 1, sessionFiles: 4, rejected: [] },
  } satisfies Snapshot;

  it("uses recorded message time for historical sessions, not start, end, or heartbeat", () => {
    const lanes = lanesFromSnapshot(snapshot);
    const visible = filterLanesByBoundedTime(lanes, now - 60 * 60_000, null);

    expect(visible.map((lane) => lane.session.id)).toEqual([
      "old-recent-message",
      "live:p-live-only",
    ]);
    expect(
      lanes.find((lane) => lane.session.id === "live-stale-message")?.boundedTimeAnchor,
    ).toEqual({
      at: Date.parse("2026-01-01T08:00:00Z"),
      source: "message",
    });
    expect(
      lanes.find((lane) => lane.session.id === "live:p-live-only")?.boundedTimeAnchor?.source,
    ).toBe("runtime-observation");
  });

  it("applies custom lower and upper bounds to the same message-time evidence", () => {
    const lanes = lanesFromSnapshot(snapshot);

    expect(
      filterLanesByBoundedTime(lanes, Date.parse("2026-01-01T11:30:00Z"), null).map(
        (lane) => lane.session.id,
      ),
    ).toEqual(["old-recent-message", "live:p-live-only"]);
    expect(
      filterLanesByBoundedTime(lanes, null, Date.parse("2026-01-01T11:30:00Z")).map(
        (lane) => lane.session.id,
      ),
    ).toEqual(["old-recent-message", "recent-start-stale-message", "live-stale-message"]);
  });

  it("leaves the All view unfiltered when no time bounds are supplied", () => {
    const lanes = lanesFromSnapshot(snapshot);
    expect(filterLanesByBoundedTime(lanes, null, null)).toBe(lanes);
  });
});

describe("event indexes", () => {
  it("associates turns, requests, and per-turn request markers without repeated scans", () => {
    const snapshot = {
      generatedAt: "2026-01-01T12:00:00Z",
      schemaVersion: 3,
      sessions: [
        {
          id: "a",
          startedAt: "2026-01-01T10:00:00Z",
          endedAt: "2026-01-01T10:01:00Z",
          lastMessageAt: "2026-01-01T10:01:00Z",
          cwd: "/work/a",
          source: "pi-jsonl",
          turnCount: 1,
          requestCount: 1,
          usage: observedUsage(),
        },
        {
          id: "b",
          startedAt: "2026-01-01T10:00:00Z",
          endedAt: "2026-01-01T10:01:00Z",
          lastMessageAt: "2026-01-01T10:01:00Z",
          cwd: "/work/b",
          source: "pi-jsonl",
          turnCount: 1,
          requestCount: 1,
          usage: observedUsage(),
        },
      ],
      turns: [
        {
          id: "turn-a",
          sessionId: "a",
          startedAt: "2026-01-01T10:00:00Z",
          confidence: "exact",
          requestCount: 2,
          cost: 0,
          totalTokens: 1,
        },
        {
          id: "turn-b",
          sessionId: "b",
          startedAt: "2026-01-01T10:00:00Z",
          confidence: "exact",
          requestCount: 1,
          cost: 0,
          totalTokens: 1,
        },
      ],
      requests: [
        {
          id: "request-a-1",
          sessionId: "a",
          turnId: "turn-a",
          at: "2026-01-01T10:00:00Z",
          cost: 0,
          totalTokens: 1,
          output: 0,
          input: 1,
          cacheRead: 0,
          cacheWrite: 0,
        },
        {
          id: "request-a-2",
          sessionId: "a",
          turnId: "turn-a",
          at: "2026-01-01T10:00:30Z",
          cost: 0,
          totalTokens: 1,
          output: 0,
          input: 1,
          cacheRead: 0,
          cacheWrite: 0,
        },
        {
          id: "request-b-1",
          sessionId: "b",
          turnId: "turn-b",
          at: "2026-01-01T10:00:00Z",
          cost: 0,
          totalTokens: 1,
          output: 0,
          input: 1,
          cacheRead: 0,
          cacheWrite: 0,
        },
      ],
      liveAgents: [],
      trace: { durationMs: 1, sessionFiles: 2, rejected: [] },
    } satisfies Snapshot;
    const [a, b] = lanesFromSnapshot(snapshot);

    expect(a.turns.map((turn) => turn.id)).toEqual(["turn-a"]);
    expect(a.requests.map((request) => request.id)).toEqual(["request-a-1", "request-a-2"]);
    expect(a.requestsByTurn.get("turn-a")?.map((request) => request.id)).toEqual([
      "request-a-1",
      "request-a-2",
    ]);
    expect(b.requestsByTurn.get("turn-b")?.map((request) => request.id)).toEqual(["request-b-1"]);
  });
});

describe("dense browser demo", () => {
  it("includes a 200+ turn, 10M+ token lane among 60 sessions", () => {
    const snapshot = demoSnapshot();
    const dense = snapshot.sessions.find((session) => session.turnCount >= 200);
    expect(snapshot.sessions).toHaveLength(60);
    expect(dense?.turnCount).toBe(240);
    expect(dense?.usage.tokens).toMatchObject({
      availability: "complete",
      value: expect.any(Number),
    });
    expect(
      dense?.usage.tokens.availability === "unavailable" ? 0 : dense?.usage.tokens.value,
    ).toBeGreaterThan(10_000_000);
    expect(snapshot.turns.filter((turn) => turn.sessionId === dense?.id)).toHaveLength(240);
  });
});

describe("session search contract", () => {
  const session = {
    id: "session-search-example-001",
    name: "ExampleWorker",
    cwd: "/workspace/example-project",
    startedAt: "2026-07-11T15:14:21Z",
    endedAt: "2026-07-11T15:15:21Z",
    source: "pi-jsonl",
    turnCount: 1,
    requestCount: 1,
    usage: observedUsage(),
  };

  it("matches full and partial session IDs", () => {
    expect(sessionMatchesQuery(session, session.id)).toBe(true);
    expect(sessionMatchesQuery(session, "search-example")).toBe(true);
  });
  it("matches full and partial names case-insensitively", () => {
    expect(sessionMatchesQuery(session, "EXAMPLEWORKER")).toBe(true);
    expect(sessionMatchesQuery(session, "pleWo")).toBe(true);
  });
  it("matches cwd as the documented additional field case-insensitively", () => {
    expect(sessionMatchesQuery(session, "workspace/example-project")).toBe(true);
  });
  it("treats empty and whitespace-only queries as no filter", () => {
    expect(sessionMatchesQuery(session, "")).toBe(true);
    expect(sessionMatchesQuery(session, "   ")).toBe(true);
  });
  it("rejects a query absent from every indexed field", () => {
    expect(sessionMatchesQuery(session, "unrelated-project")).toBe(false);
  });
});

describe("coordination and tmux grouping", () => {
  const coordinated = {
    ...lane,
    live: {
      processInstanceId: "p1",
      pid: 12,
      cwd: "/work/atlas",
      state: "idle",
      confidence: "exact",
      coordination: {
        kind: "pi-team",
        teamName: "alpha",
        agentName: "builder",
        role: "teammate",
        source: "/teams/alpha/config.json",
      },
      pane: {
        serverSocket: "/tmp/tmux/a",
        sessionName: "agents",
        windowId: "@2",
        windowIndex: 3,
        windowName: "build",
        paneId: "%9",
        cwd: "/work/atlas",
      },
    },
  } as Lane;
  it("groups by validated Pi Team evidence", () =>
    expect(groupKey(coordinated, "team")).toBe("alpha"));
  it("groups by current tmux session, window, and pane", () => {
    expect(groupKey(coordinated, "tmux-session")).toBe("agents");
    expect(groupKey(coordinated, "tmux-window")).toBe("agents / 3: build");
    expect(groupKey(coordinated, "tmux-pane")).toBe("agents / 3 / %9");
  });
  it("does not guess historical coordination", () => {
    expect(groupKey(lane, "team")).toBe("No Pi Team evidence");
    expect(groupKey(lane, "tmux-session")).toBe("No live tmux evidence");
  });
  it("uses human aliases and the same ontology for filtering", () => {
    expect(laneAlias(coordinated)).toBe("builder");
    expect(filterKey(coordinated, "team")).toBe(groupKey(coordinated, "team"));
    expect(filterKey(coordinated, "state")).toBe("Running · Idle");
  });
  it("builds coherent identity details through one pure seam", () => {
    const details = new Map(inspectorDiagnosticDetails(coordinated));
    expect(details.has("Alias")).toBe(false);
    expect(details.get("PID")).toBe(12);
    expect(details.has("Session ID")).toBe(false);
    expect(details.get("Process instance")).toBe("p1");
  });
  it("keeps exact PiTeams Session identity separate from process-only runtime confidence", () => {
    const exact = {
      ...coordinated,
      live: {
        ...coordinated.live!,
        confidence: "process_only",
        sessionId: "session-exact",
        sessionConfidence: "inferred_unique_recent_session",
        sessionBinding: {
          confidence: "exact",
          kind: "pi_teams_session_file",
          sessionSource: "/sessions/session-exact.jsonl",
          evidenceSource: "/teams/alpha/config.json",
        },
        processBinding: { confidence: "exact", source: "ps", pid: 12 },
        state: undefined,
        processState: "running",
        workState: {
          availability: "unobserved",
          reason: "lifecycle_evidence_unavailable",
        },
      },
    } as Lane;
    const details = new Map(inspectorDetails(exact));
    expect(details.get("Session identity confidence")).toBe("exact");
    expect(details.get("Process evidence")).toBe("ps · exact");
    expect(details.get("Work state")).toBe("Work state unavailable");
  });
  it("renders inferred unique recent Session confidence without borrowing runtime confidence", () => {
    const inferred = {
      ...coordinated,
      live: {
        ...coordinated.live!,
        confidence: "process_only",
        sessionId: "session-inferred",
        sessionConfidence: "inferred_unique_recent_session",
        sessionBinding: {
          confidence: "inferred_unique_recent_session",
          kind: "unique_recent_session",
          sessionSource: "/sessions/session-inferred.jsonl",
          processSource: "ps",
        },
      },
    } as Lane;
    const details = new Map(inspectorDetails(inferred));
    expect(details.get("Session identity confidence")).toBe("inferred unique recent session");
    expect(details.get("Session evidence")).toBe("ps");
  });
});
