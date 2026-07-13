import type { AgentState, FilterMode, GroupMode, Lane, Request, Session, Snapshot } from "./types";

export const statePresentation: Record<AgentState, { label: string; className: string }> = {
  idle: { label: "Idle", className: "state-idle" },
  thinking: { label: "Thinking", className: "state-thinking" },
  tool: { label: "Using tool", className: "state-tool" },
  waiting_input: { label: "Waiting", className: "state-waiting" },
  blocked: { label: "Blocked", className: "state-blocked" },
  settled: { label: "Settled", className: "state-settled" },
  failed: { label: "Failed", className: "state-failed" },
  unknown: { label: "Unknown", className: "state-unknown" },
};
export const stateLabel = Object.fromEntries(
  Object.entries(statePresentation).map(([state, value]) => [state, value.label]),
) as Record<AgentState, string>;
export const stateClass = Object.fromEntries(
  Object.entries(statePresentation).map(([state, value]) => [state, value.className]),
) as Record<AgentState, string>;

/**
 * The complete, intentionally small search contract for a conversation
 * session. Search is a case-insensitive substring match over stable session
 * identity plus its human-facing name and working directory.
 */
export function sessionMatchesQuery(session: Session, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;

  return [session.id, session.name ?? "", session.cwd].some((candidate) =>
    candidate.toLowerCase().includes(needle),
  );
}

function indexBy<T>(items: T[], keyFor: (item: T) => string) {
  const index = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    const group = index.get(key);
    if (group) group.push(item);
    else index.set(key, [item]);
  }
  return index;
}

function indexRequests(requests: Request[]) {
  const bySession = new Map<string, Request[]>();
  const bySessionTurn = new Map<string, Map<string, Request[]>>();
  for (const request of requests) {
    const sessionRequests = bySession.get(request.sessionId);
    if (sessionRequests) sessionRequests.push(request);
    else bySession.set(request.sessionId, [request]);

    if (!request.turnId) continue;
    let turns = bySessionTurn.get(request.sessionId);
    if (!turns) {
      turns = new Map();
      bySessionTurn.set(request.sessionId, turns);
    }
    const turnRequests = turns.get(request.turnId);
    if (turnRequests) turnRequests.push(request);
    else turns.set(request.turnId, [request]);
  }
  return { bySession, bySessionTurn };
}

function messageTime(session: Session) {
  if (!session.lastMessageAt) return undefined;
  const at = Date.parse(session.lastMessageAt);
  return Number.isNaN(at) ? undefined : at;
}

/**
 * Filters only when the caller supplies a bound. A logged Session must have
 * explicit message evidence; the sole fallback is a runtime observation for a
 * live-only lane whose session log is not yet available.
 */
export function filterLanesByBoundedTime(lanes: Lane[], from: number | null, to: number | null) {
  if (from === null && to === null) return lanes;
  return lanes.filter((lane) => {
    const at = lane.boundedTimeAnchor?.at;
    return at !== undefined && (from === null || at >= from) && (to === null || at <= to);
  });
}

export function lanesFromSnapshot(snapshot: Snapshot): Lane[] {
  const liveBySession = new Map(
    snapshot.liveAgents.filter((a) => a.sessionId).map((a) => [a.sessionId!, a]),
  );
  const sessionIds = new Set(snapshot.sessions.map((session) => session.id));
  const turnsBySession = indexBy(snapshot.turns, (turn) => turn.sessionId);
  const requests = indexRequests(snapshot.requests);
  const liveOnly = snapshot.liveAgents
    .filter((live) => !live.sessionId || !sessionIds.has(live.sessionId))
    .map((live) => {
      const at = live.processStartedAt ?? live.heartbeatAt ?? snapshot.generatedAt;
      const runtimeObservedAt = Date.parse(
        live.heartbeatAt ?? live.processStartedAt ?? snapshot.generatedAt,
      );
      return {
        session: {
          id: live.sessionId ?? `live:${live.processInstanceId}`,
          startedAt: at,
          endedAt: live.heartbeatAt ?? snapshot.generatedAt,
          cwd: live.cwd,
          name: live.sessionName,
          source: "live-extension",
          turnCount: 0,
          requestCount: 0,
          cost: 0,
          totalTokens: 0,
        },
        turns: [],
        requests: [],
        requestsByTurn: new Map(),
        live,
        boundedTimeAnchor: { at: runtimeObservedAt, source: "runtime-observation" as const },
        start: Date.parse(at),
        end: Date.parse(live.heartbeatAt ?? snapshot.generatedAt),
      };
    });
  return [
    ...snapshot.sessions.map((session) => {
      const turns = turnsBySession.get(session.id) ?? [];
      const sessionRequests = requests.bySession.get(session.id) ?? [];
      const lastMessageAt = messageTime(session);
      return {
        session,
        turns,
        requests: sessionRequests,
        requestsByTurn: requests.bySessionTurn.get(session.id) ?? new Map(),
        live: liveBySession.get(session.id),
        boundedTimeAnchor:
          lastMessageAt === undefined
            ? undefined
            : { at: lastMessageAt, source: "message" as const },
        start: Date.parse(session.startedAt),
        end: Date.parse(session.endedAt),
      };
    }),
    ...liveOnly,
  ].sort((a, b) => a.start - b.start);
}

export function laneAlias(lane: Lane) {
  return (
    lane.session.name ??
    lane.live?.sessionName ??
    lane.live?.coordination?.agentName ??
    lane.live?.sessionId?.slice(0, 8) ??
    lane.session.id.slice(0, 8)
  );
}

const noTmux = "No live tmux evidence";
const groupResolvers: Record<GroupMode, (lane: Lane) => string> = {
  none: () => "All sessions",
  name: (lane) => lane.session.name ?? lane.session.id,
  team: (lane) => lane.live?.coordination?.teamName ?? "No Pi Team evidence",
  "tmux-session": (lane) => lane.live?.pane?.sessionName ?? noTmux,
  "tmux-window": (lane) => {
    const pane = lane.live?.pane;
    const name = pane?.windowName ? `: ${pane.windowName}` : "";
    return pane ? `${pane.sessionName} / ${pane.windowIndex}${name}` : noTmux;
  },
  "tmux-pane": (lane) => {
    const pane = lane.live?.pane;
    return pane ? `${pane.sessionName} / ${pane.windowIndex} / ${pane.paneId}` : noTmux;
  },
  state: (lane) => stateLabel[lane.live?.state ?? "settled"],
  cwd: (lane) => lane.session.cwd,
  project: (lane) => lane.session.cwd.split("/").filter(Boolean).at(-1) ?? lane.session.cwd,
};

export function groupKey(lane: Lane, mode: GroupMode) {
  return groupResolvers[mode](lane);
}

export function filterKey(lane: Lane, mode: FilterMode) {
  if (mode === "all") return "All";
  return groupKey(lane, mode);
}

export function extent(
  lanes: Lane[],
  rangeHours: number | null,
  now = Date.now(),
): [number, number] {
  if (rangeHours) return [now - rangeHours * 3_600_000, now];
  if (!lanes.length) return [now - 3_600_000, now];
  const lo = Math.min(...lanes.map((l) => l.start));
  const hi = Math.max(now, ...lanes.map((l) => (l.live ? now : l.end)));
  return [lo, Math.max(lo + 60_000, hi)];
}

export const position = (at: number, [start, end]: [number, number]) =>
  Math.max(0, Math.min(100, ((at - start) / (end - start)) * 100));
export const money = (v: number) =>
  v < 0.01 && v > 0
    ? "<$0.01"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }).format(v);
export const compact = (v: number) =>
  new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(v);
export const duration = (ms: number) =>
  ms < 60_000
    ? `${Math.max(1, Math.round(ms / 1000))}s`
    : ms < 3_600_000
      ? `${Math.round(ms / 60_000)}m`
      : `${(ms / 3_600_000).toFixed(1)}h`;

function contextLabel(lane: Lane) {
  const context = lane.live?.context;
  if (context?.percent == null) return "—";
  const usage =
    context.tokens == null || context.window == null
      ? ""
      : ` · ${compact(context.tokens)}/${compact(context.window)}`;
  return `${context.percent.toFixed(0)}%${usage}`;
}

function sessionEvidence(lane: Lane) {
  const binding = lane.live?.sessionBinding;
  return binding?.evidenceSource ?? binding?.tmuxSource ?? binding?.processSource ?? "—";
}

function processEvidence(lane: Lane) {
  const binding = lane.live?.processBinding;
  return binding ? `${binding.source} · ${binding.confidence}` : "—";
}

export function inspectorDetails(lane: Lane): ReadonlyArray<readonly [string, string | number]> {
  const live = lane.live;
  return [
    ["Session ID", live ? (live.sessionId ?? "Unavailable") : lane.session.id],
    ["Alias", laneAlias(lane)],
    ["PID", live?.pid ?? "—"],
    ["Process instance", live?.processInstanceId ?? "—"],
    ["Source", lane.session.source],
    [
      "Identity confidence",
      live?.sessionConfidence?.replaceAll("_", " ") ?? live?.confidence ?? "—",
    ],
    ["Session match", live?.sessionBinding?.kind.replaceAll("_", " ") ?? "—"],
    ["Session evidence", sessionEvidence(lane)],
    ["Session source", live?.sessionBinding?.sessionSource ?? lane.session.source],
    ["Process evidence", processEvidence(lane)],
    ["Started", new Date(lane.start).toLocaleString()],
    ["Last observed", new Date(live?.heartbeatAt ?? lane.session.endedAt).toLocaleString()],
    ["Turns", lane.session.turnCount],
    ["Requests", lane.session.requestCount],
    ["Spend", money(lane.session.cost)],
    ["Tokens", compact(lane.session.totalTokens)],
    ["Duration", duration(lane.end - lane.start)],
    ["Context", contextLabel(lane)],
  ];
}
