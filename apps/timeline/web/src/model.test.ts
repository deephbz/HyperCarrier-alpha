import { describe, it, expect } from "vitest";
import {
  extent,
  position,
  filterKey,
  groupKey,
  inspectorDetails,
  laneAlias,
  lanesFromSnapshot,
  sessionMatchesQuery,
} from "./model";
import { demoSnapshot } from "./demo";
import type { Lane, Snapshot } from "./types";
const lane = {
  session: {
    id: "s",
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T01:00:00Z",
    cwd: "/work/atlas",
    source: "x",
    turnCount: 1,
    requestCount: 1,
    cost: 1,
    totalTokens: 10,
  },
  turns: [],
  requests: [],
  start: 1,
  end: 2,
} as Lane;
describe("timeline model", () => {
  it("groups by project", () => expect(groupKey(lane, "project")).toBe("atlas"));
  it("clamps positions", () => {
    expect(position(-1, [0, 10])).toBe(0);
    expect(position(20, [0, 10])).toBe(100);
  });
  it("uses selected recent range", () => expect(extent([], 1, 3_600_000)).toEqual([0, 3_600_000]));
  it("keeps live agents visible before their session log is discoverable", () => {
    const snapshot = {
      generatedAt: "2026-01-01T01:00:00Z",
      sourceVersion: 1,
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
  });
});

describe("dense browser demo", () => {
  it("includes a 200+ turn, 10M+ token lane among 60 sessions", () => {
    const snapshot = demoSnapshot();
    const dense = snapshot.sessions.find((session) => session.turnCount >= 200);
    expect(snapshot.sessions).toHaveLength(60);
    expect(dense?.turnCount).toBe(240);
    expect(dense?.totalTokens).toBeGreaterThan(10_000_000);
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
    cost: 0,
    totalTokens: 1,
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
    expect(filterKey(coordinated, "state")).toBe("Idle");
  });
  it("builds coherent identity details through one pure seam", () => {
    const details = new Map(inspectorDetails(coordinated));
    expect(details.get("Alias")).toBe("builder");
    expect(details.get("PID")).toBe(12);
    expect(details.get("Session ID")).toBe("Unavailable");
    expect(details.get("Process instance")).toBe("p1");
  });
});
