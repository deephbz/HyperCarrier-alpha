import type {
  CoordinationEvidence,
  ProcessObservation,
  RarebitMarker,
  Request,
  Session,
  Snapshot,
  Turn,
} from "./types";
const origin = Date.now() - 8 * 3_600_000;
const projects = ["api-service", "data-pipeline", "model-evaluation", "research-notes"];

function demoCoordination(index: number): CoordinationEvidence | undefined {
  if (index !== 1 && index !== 2) return undefined;
  return {
    kind: "pi-team",
    teamName: "timeline",
    agentName: index === 1 ? "worker" : "lead",
    role: index === 1 ? "teammate" : "lead",
    source: "demo",
  };
}

export function demoSnapshot(): Snapshot {
  const sessions: Session[] = [],
    turns: Turn[] = [],
    requests: Request[] = [],
    rarebits: RarebitMarker[] = [],
    processes: ProcessObservation[] = [];
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
    const summaryAttention =
      i % 13 === 2 || i % 13 === 4
        ? {
            state: "known" as const,
            needsHumanAttention: i % 13 === 2,
            source: {
              kind: "rarebit_summary" as const,
              schemaVersion: 2,
              jobId: `demo-summary-${i}`,
              observedAt: new Date(cursor).toISOString(),
              selectorVersion: "demo-selector-v1",
              manifestHash: `demo-manifest-${i}`,
              promptVersion: "demo-summary-v2",
              implementationVersion: "demo-v1",
            },
          }
        : undefined;
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
      rarebitSummaryAttention: summaryAttention,
      usage: {
        tokens: { availability: "complete", value: tokens },
        cost: { availability: "complete", value: cost },
      },
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
      processes.push({
        id: `demo-p${i}`,
        pid: 7000 + i,
        observedAt: new Date().toISOString(),
        cwd: `/work/${project}`,
        process: { pid: 7000 + i, state: "running" },
        locations: [
          {
            provider: "tmux",
            serverSocket: "demo",
            sessionName: "agents",
            windowIndex: 1 + (i % 3),
            paneId: `%${i + 1}`,
            cwd: `/work/${project}`,
          },
        ],
        coordination: demoCoordination(i),
        link: {
          sessionId: id,
          grade: "provider_verified",
          method: "demo",
          observedAt: new Date().toISOString(),
          provenance: ["demo"],
        },
        issues: [],
      });
  }
  return {
    schemaVersion: 4,
    generatedAt: new Date().toISOString(),
    sessions,
    turns,
    requests,
    rarebits,
    processes,
    trace: { durationMs: 4.2, sessionFiles: 60, rejected: [] },
  };
}
