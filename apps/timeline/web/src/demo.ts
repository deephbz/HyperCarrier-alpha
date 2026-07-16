import type {
  Snapshot,
  Session,
  Turn,
  Request,
  LiveAgent,
  AgentState,
  RarebitMarker,
} from "./types";
const origin = Date.now() - 8 * 3_600_000;
const projects = ["api-service", "data-pipeline", "model-evaluation", "research-notes"];
const states: AgentState[] = ["thinking", "tool", "waiting_input", "blocked", "idle", "settled"];
export function demoSnapshot(): Snapshot {
  const sessions: Session[] = [],
    turns: Turn[] = [],
    requests: Request[] = [],
    rarebits: RarebitMarker[] = [],
    liveAgents: LiveAgent[] = [];
  for (let i = 0; i < 60; i++) {
    const id = `demo-${i}`,
      started = origin + i * 19 * 60_000;
    let cursor = started;
    const n = i === 0 ? 240 : 6 + (i % 9);
    let cost = 0,
      tokens = 0;
    for (let j = 0; j < n; j++) {
      cursor += (2 + ((j * 7 + i) % 11)) * 60_000;
      const ended = cursor + (1 + ((j * 13 + i) % 16)) * 60_000;
      const c = ((j * 17 + i * 3) % 80) / 100;
      const tok = 12_000 + ((j * 91_731 + i * 4_000) % 190_000);
      const tid = `${id}-t${j}`;
      turns.push({
        id: tid,
        sessionId: id,
        startedAt: new Date(cursor).toISOString(),
        endedAt: new Date(ended).toISOString(),
        confidence: j % 6 ? "exact" : "inferred",
        requestCount: 1 + (j % 3),
        cost: c,
        totalTokens: tok,
      });
      for (let k = 0; k < 1 + (j % 3); k++)
        requests.push({
          id: `${tid}-r${k}`,
          sessionId: id,
          turnId: tid,
          at: new Date(cursor + k * 30_000).toISOString(),
          model: "gpt-5.6-terra",
          provider: "synthetic",
          stopReason: k < j % 3 ? "toolUse" : "stop",
          cost: c / (1 + (j % 3)),
          totalTokens: tok / (1 + (j % 3)),
          input: tok * 0.8,
          output: tok * 0.2,
          cacheRead: tok * 0.5,
          cacheWrite: 0,
        });
      cost += c;
      tokens += tok;
      cursor = ended;
    }
    const project = projects[i % projects.length];
    sessions.push({
      id,
      startedAt: new Date(started).toISOString(),
      endedAt: new Date(cursor).toISOString(),
      lastMessageAt: new Date(cursor).toISOString(),
      cwd: `/work/${project}`,
      source: "demo",
      name: i === 0 ? "timeline-lead" : i < 5 ? `timeline-worker-${i}` : `${project}-${i + 1}`,
      turnCount: n,
      requestCount: n,
      cost,
      totalTokens: tokens,
    });
    rarebits.push(
      {
        sessionId: id,
        sourceEntryId: `${id}-user`,
        order: 1,
        role: "user",
        outcome: "user",
        producer: null,
        timestamp: new Date(started + 60_000).toISOString(),
      },
      {
        sessionId: id,
        sourceEntryId: `${id}-stop`,
        order: n + 1,
        role: "assistant",
        outcome: "stop",
        producer: null,
        timestamp: new Date(cursor).toISOString(),
      },
    );
    if (i < 10)
      liveAgents.push({
        processInstanceId: `demo-p${i}`,
        pid: 7000 + i,
        sessionId: id,
        cwd: `/work/${project}`,
        state: states[i % states.length],
        processState: "running",
        process: { pid: 7000 + i, state: "running" },
        workState: {
          availability: "observed",
          state: states[i % states.length],
          evidenceSource: "demo",
        },
        activeTool: i % 6 === 1 ? "read" : undefined,
        heartbeatAt: new Date(Date.now() - i * 3000).toISOString(),
        model: "gpt-5.6-terra",
        context: { tokens: 20_000 + i * 13_000, window: 200_000, percent: 10 + i * 6.5 },
        confidence: "exact",
        pane: {
          serverSocket: "demo",
          sessionName: "agents",
          windowIndex: 1 + (i % 3),
          paneId: `%${i + 1}`,
          cwd: `/work/${project}`,
        },
      });
  }
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    sessions,
    turns,
    requests,
    rarebits,
    liveAgents,
    trace: { durationMs: 4.2, sessionFiles: 60, rejected: [] },
  };
}
