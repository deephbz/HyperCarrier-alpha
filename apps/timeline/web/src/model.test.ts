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
import type { Lane, ProcessObservation, SessionLane, Snapshot } from "./types";
const observedUsage = (tokens = 1, cost = 0) =>
  ({
    tokens: { availability: "complete", value: tokens },
    cost: { availability: "complete", value: cost },
  }) as const;
const lane = {
  kind: "session",
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
  requestsByTurn: new Map(),
  rarebits: [],
  responseOutcomes: [],
  processes: [],
  start: 1,
  end: 2,
} satisfies SessionLane;

function processObservation(overrides: Partial<ProcessObservation> = {}): ProcessObservation {
  return {
    id: "process-one",
    pid: 42,
    observedAt: "2026-01-01T00:30:00Z",
    cwd: "/work/atlas",
    process: { pid: 42, state: "running" },
    locations: [],
    link: {
      sessionId: "s",
      grade: "provider_verified",
      method: "herdr:native_session",
      observedAt: "2026-01-01T00:30:00Z",
      provenance: ["herdr"],
    },
    issues: [],
    ...overrides,
  };
}

function withProcess(base: SessionLane, overrides: Partial<ProcessObservation> = {}): SessionLane {
  const process = processObservation(overrides);
  return { ...base, processes: [process], primaryProcess: process };
}
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
  it("groups Process lanes by their explicit no-evidence coordinates", () => {
    const process = {
      kind: "process" as const,
      process: {
        id: "p1",
        pid: 44,
        observedAt: "2026-01-01T00:00:00Z",
        cwd: "/repo",
        process: { pid: 44, state: "running" as const },
        locations: [
          { provider: "tmux" as const, sessionName: "work", windowIndex: 2, paneId: "%3" },
        ],
        issues: [],
      },
      start: 0,
      end: 1,
      boundedTimeAnchor: { at: 0, source: "runtime-observation" as const },
    };
    expect(groupKey(process, "project")).toBe("No Session/Project evidence");
    expect(groupKey(process, "team")).toBe("No Pi Team evidence");
    expect(groupKey(process, "state")).toBe("Running · work state unavailable");
    expect(groupKey(process, "cwd")).toBe("/repo");
    expect(groupKey(process, "name")).toBe("PID 44");
    expect(groupKey(process, "tmux-session")).toBe("work");
    expect(groupKey(process, "tmux-window")).toBe("work / 2");
    expect(groupKey(process, "tmux-pane")).toBe("work / 2 / %3");
  });

  it("does not manufacture a Session lane for an unlinked live process", () => {
    const snapshot = {
      generatedAt: "2026-01-01T01:00:00Z",
      schemaVersion: 4,
      sessions: [],
      turns: [],
      requests: [],
      rarebits: [],
      processes: [
        {
          id: "p1",
          pid: 1,
          observedAt: "2026-01-01T01:00:00Z",
          cwd: "/work/new",
          process: { pid: 1, state: "running" },
          locations: [],
          coordination: {
            kind: "pi-team" as const,
            teamName: "timeline-alpha-removal",
            agentName: "product-observer",
            role: "teammate" as const,
            source: "fixture",
          },
          issues: [],
        },
      ],
      trace: { durationMs: 1, sessionFiles: 0, rejected: [] },
    } as Snapshot;
    expect(lanesFromSnapshot(snapshot)).toMatchObject([{ kind: "process", process: { id: "p1" } }]);
  });

  it("retains every linked process overlay for one Session", () => {
    const snapshot = {
      generatedAt: "2026-01-01T01:00:00Z",
      schemaVersion: 4,
      sessions: [{ ...lane.session, id: "shared" }],
      turns: [],
      requests: [],
      rarebits: [],
      processes: [1, 2].map((pid) => ({
        id: `pid:${pid}`,
        pid,
        observedAt: "2026-01-01T01:00:00Z",
        process: { pid, state: "running" as const },
        locations: [],
        issues: [],
        link: {
          sessionId: "shared",
          grade: "provider_verified" as const,
          method: "herdr:native_session",
          observedAt: "2026-01-01T01:00:00Z",
          provenance: ["herdr"],
        },
      })),
      trace: { durationMs: 1, sessionFiles: 1, rejected: [] },
    } as Snapshot;
    const [shared] = lanesFromSnapshot(snapshot);
    expect(shared.processes?.map((process) => process.pid)).toEqual([1, 2]);
  });

  it("uses the context tuple only as presentation and keeps process-only state distinct", () => {
    const contextLane = withProcess(
      { ...lane, session: { ...lane.session, id: "session-one", name: "release" } },
      {
        id: "process-one",
        pid: 42,
        coordination: {
          kind: "pi-team",
          teamName: "alpha",
          agentName: "reviewer",
          role: "teammate",
          source: "fixture",
        },
      },
    );
    const samePresentation = withProcess(
      { ...contextLane, session: { ...contextLane.session, id: "session-two" } },
      { ...contextLane.primaryProcess, id: "process-two", pid: 99 },
    );

    expect(groupKey(contextLane, "context")).toBe("Intelligent");
    expect(groupKey(contextLane, "context")).toBe(groupKey(samePresentation, "context"));
    expect(contextLane.session.id).not.toBe(samePresentation.session.id);
    expect(laneContextPresentation(contextLane).label).toBe(
      laneContextPresentation(samePresentation).label,
    );
    expect(laneContextPresentation(contextLane)).toMatchObject({
      label: "alpha | reviewer | release | atlas",
      identity: "release",
      identitySource: "native-session-name",
    });
    expect(laneContextPresentation(contextLane).parts).toEqual([
      { coordinate: "team", value: "alpha" },
      { coordinate: "team-role", value: "reviewer" },
      { coordinate: "session", value: "release" },
      { coordinate: "project", value: "atlas" },
    ]);
    expect(laneContextPresentation(contextLane).label).not.toContain("42");
    expect(runtimePresentation(contextLane)).toEqual({
      label: "Running · work state unavailable",
      processLabel: "Running",
      workLabel: "Work state unavailable",
      className: "state-unobserved",
    });
    expect(runtimePresentation(lane)).toEqual({
      label: "No associated live process",
      processLabel: "No associated live process",
      workLabel: "No live process observation",
      className: "state-stopped",
    });
    expect(runtimePresentation(contextLane)).toEqual({
      label: "Running · work state unavailable",
      processLabel: "Running",
      workLabel: "Work state unavailable",
      className: "state-unobserved",
    });

    const linkedUnnamed = withProcess(
      { ...lane, session: { ...lane.session, name: undefined, projectName: undefined } },
      {
        coordination: {
          kind: "pi-team",
          teamName: "timeline-alpha-removal",
          agentName: "product-observer",
          role: "teammate",
          source: "fixture",
        },
      },
    );
    expect(linkedUnnamed.session.name).toBeUndefined();
    expect(laneContextPresentation(linkedUnnamed)).toMatchObject({
      label: "timeline-alpha-removal / product-observer | atlas",
      identity: "timeline-alpha-removal / product-observer",
      identitySource: "verified-team-member",
      team: "timeline-alpha-removal",
      teamRoleName: "product-observer",
    });
    expect(laneAlias(linkedUnnamed)).toBe("timeline-alpha-removal / product-observer");

    const heuristicLinked = withProcess(linkedUnnamed, {
      link: { ...linkedUnnamed.primaryProcess!.link!, grade: "heuristic" },
      coordination: linkedUnnamed.primaryProcess!.coordination,
    });
    expect(heuristicLinked.primaryProcess?.coordination).toMatchObject({
      teamName: "timeline-alpha-removal",
      agentName: "product-observer",
    });
    expect(laneContextPresentation(heuristicLinked)).toMatchObject({
      label: "Unnamed session · s | atlas",
      identity: "Unnamed session · s",
      identitySource: "unnamed-session",
    });

    const unlabeled = {
      ...lane,
      session: { ...lane.session, name: undefined, projectName: undefined },
    } as Lane;
    expect(effectiveProjectLabel(unlabeled)).toBe("atlas");
    expect(laneContextPresentation(unlabeled)).toMatchObject({
      label: "Unnamed session · s | atlas",
      identity: "Unnamed session · s",
      identitySource: "unnamed-session",
    });

    const noProjectCoordinate = {
      ...unlabeled,
      session: { ...unlabeled.session, cwd: "" },
    } as Lane;
    expect(laneContextPresentation(noProjectCoordinate).label).toBe("Unnamed session · s");
  });

  it("de-emphasizes only an explicit teammate coordination role", () => {
    const teammate = withProcess(lane, {
      id: "teammate",
      pid: 1,
      coordination: {
        kind: "pi-team",
        teamName: "alpha",
        agentName: "builder",
        role: "teammate",
        source: "fixture",
      },
    });
    const lead = withProcess(teammate, {
      ...teammate.primaryProcess,
      id: "lead",
      coordination: { ...teammate.primaryProcess!.coordination!, role: "lead" },
    });
    const unknown = withProcess(teammate, {
      ...teammate.primaryProcess,
      id: "unknown",
      coordination: {
        ...teammate.primaryProcess!.coordination!,
        role: "unknown" as "lead",
      },
    });

    expect(laneIdentityEmphasis(teammate)).toBe("teammate");
    expect(laneIdentityEmphasis(lead)).toBe("primary");
    expect(laneIdentityEmphasis(lane)).toBe("primary");
    expect(laneIdentityEmphasis(unknown)).toBe("primary");
  });

  it("formats complete, partial, zero, and unavailable Session usage independently", () => {
    const withUsage = (usage: SessionLane["session"]["usage"]) =>
      ({
        ...lane,
        session: { ...lane.session, usage },
        rarebits: [{}, {}],
      }) as SessionLane;

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
    const makeLane = (id: string, name: string, cwd: string, teamName?: string) => {
      const base: SessionLane = {
        ...lane,
        session: { ...lane.session, id, name, cwd, projectName: undefined },
      };
      return teamName
        ? withProcess(base, {
            id: `process-${id}`,
            pid: 1,
            cwd,
            coordination: {
              kind: "pi-team",
              teamName,
              agentName: "lead",
              role: "lead",
              source: "fixture",
            },
          })
        : base;
    };
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
    schemaVersion: 4,
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
    rarebits: [],
    processes: [
      {
        id: "p-live-stale",
        pid: 1,
        observedAt: "2026-01-01T12:00:00Z",
        cwd: "/work/live-stale",
        process: { pid: 1, state: "running" },
        locations: [],
        link: {
          sessionId: "live-stale-message",
          grade: "provider_verified",
          method: "fixture",
          observedAt: "2026-01-01T12:00:00Z",
          provenance: ["fixture"],
        },
        issues: [],
      },
      {
        id: "p-live-only",
        pid: 2,
        observedAt: "2026-01-01T12:00:00Z",
        cwd: "/work/live-only",
        process: { pid: 2, state: "running" },
        locations: [],
        issues: [],
      },
    ],
    trace: { durationMs: 1, sessionFiles: 4, rejected: [] },
  } satisfies Snapshot;

  it("uses recorded message time for historical sessions, not start, end, or heartbeat", () => {
    const lanes = lanesFromSnapshot(snapshot);
    const visible = filterLanesByBoundedTime(lanes, now - 60 * 60_000, null);

    expect(
      visible.map((lane) =>
        lane.kind === "session" ? `session:${lane.session.id}` : `process:${lane.process.id}`,
      ),
    ).toEqual(["session:old-recent-message", "process:p-live-only"]);
    expect(
      lanes.find((lane) => lane.kind === "session" && lane.session.id === "live-stale-message")
        ?.boundedTimeAnchor,
    ).toEqual({
      at: Date.parse("2026-01-01T08:00:00Z"),
      source: "message",
    });
    expect(
      lanes.find((lane) => lane.kind === "process" && lane.process.id === "p-live-only"),
    ).toBeDefined();
  });

  it("applies custom lower and upper bounds to the same message-time evidence", () => {
    const lanes = lanesFromSnapshot(snapshot);

    expect(
      filterLanesByBoundedTime(lanes, Date.parse("2026-01-01T11:30:00Z"), null).map((lane) =>
        lane.kind === "session" ? `session:${lane.session.id}` : `process:${lane.process.id}`,
      ),
    ).toEqual(["session:old-recent-message", "process:p-live-only"]);
    expect(
      filterLanesByBoundedTime(lanes, null, Date.parse("2026-01-01T11:30:00Z"))
        .filter((lane): lane is SessionLane => lane.kind === "session")
        .map((lane) => lane.session.id),
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
      schemaVersion: 4,
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
      rarebits: [],
      processes: [],
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
  const coordinated = withProcess(lane, {
    id: "p1",
    pid: 12,
    coordination: {
      kind: "pi-team",
      teamName: "alpha",
      agentName: "builder",
      role: "teammate",
      source: "/teams/alpha/config.json",
    },
    locations: [
      {
        provider: "tmux",
        serverSocket: "/tmp/tmux/a",
        sessionName: "agents",
        windowId: "@2",
        windowIndex: 3,
        windowName: "build",
        paneId: "%9",
        cwd: "/work/atlas",
      },
    ],
    link: {
      sessionId: "s",
      grade: "provider_verified",
      method: "pi_teams:exact_membership_session",
      observedAt: "2026-01-01T00:30:00Z",
      provenance: ["pi_teams"],
    },
  });
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
    expect(laneAlias(coordinated)).toBe("alpha / builder");
    expect(filterKey(coordinated, "team")).toBe(groupKey(coordinated, "team"));
    expect(filterKey(coordinated, "state")).toBe("Running · work state unavailable");
  });
  it("builds coherent identity details through one pure seam", () => {
    const details = new Map(inspectorDiagnosticDetails(coordinated));
    expect(details.has("Alias")).toBe(false);
    expect(details.get("PID")).toBe(12);
    expect(details.has("Session ID")).toBe(false);
    expect(details.get("Process instance")).toBe("p1");
  });
  it("keeps provider verification separate from OS process observation", () => {
    const details = new Map(inspectorDetails(coordinated));
    expect(details.get("Session identity confidence")).toBe("provider verified");
    expect(details.get("Process evidence")).toBe("os process scan · exact observation");
    expect(details.get("Work state")).toBe("Work state unavailable");
  });
  it("renders heuristic grade and provenance without legacy binding fields", () => {
    const inferred = withProcess(coordinated, {
      ...coordinated.primaryProcess,
      link: {
        sessionId: "s",
        grade: "heuristic",
        method: "unique_recent_session",
        observedAt: "2026-01-01T00:30:00Z",
        provenance: ["ps", "session_catalog"],
      },
    });
    const details = new Map(inspectorDetails(inferred));
    expect(details.get("Session identity confidence")).toBe("heuristic");
    expect(details.get("Session evidence")).toBe("ps,session_catalog");
  });
});
