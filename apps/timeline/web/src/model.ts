import type {
  AgentState,
  FilterMode,
  GroupMode,
  Lane,
  Request,
  RarebitSummaryAttention,
  ResponseOutcomeMarker,
  Session,
  SessionUsageMetric,
  Snapshot,
  SnapshotWindow,
} from "./types";

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

export function summaryAttentionPresentation(attention?: RarebitSummaryAttention) {
  return attention?.state === "known" && attention.needsHumanAttention
    ? {
        label: "Rarebit Summary indicates human attention needed",
        className: "lane-attention-needed",
      }
    : null;
}

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
  const rarebitsBySession = indexBy(snapshot.rarebits ?? [], (marker) => marker.sessionId);
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
          usage: {
            tokens: { availability: "unavailable" as const },
            cost: { availability: "unavailable" as const },
          },
        },
        turns: [],
        requests: [],
        requestsByTurn: new Map(),
        rarebits: [],
        responseOutcomes: [],
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
        rarebits: rarebitsBySession.get(session.id) ?? [],
        responseOutcomes: responseOutcomesFromRequests(sessionRequests),
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

export function shortSessionId(lane: Lane) {
  return lane.session.id.slice(0, 8);
}

/**
 * A label is a presentation aid, never Session identity. Keep the short ID
 * visible whenever an alias is missing or conflicts within the current view.
 */
export function laneDisplayLabel(lane: Lane, lanes: Lane[]) {
  const alias = laneAlias(lane);
  const conflicts = lanes.filter((candidate) => laneAlias(candidate) === alias).length > 1;
  return conflicts || alias === shortSessionId(lane) ? `${alias} · ${shortSessionId(lane)}` : alias;
}

export function runtimePresentation(lane: Lane) {
  if (!lane.live)
    return {
      label: "Stopped",
      processLabel: "Stopped",
      workLabel: "No live process",
      className: "state-stopped",
    };
  const observed = lane.live.workState?.availability === "observed";
  const state = observed ? lane.live.workState.state : undefined;
  // Accept exact legacy fixtures while the v2 HTTP contract remains strict.
  const legacyState = lane.live.confidence === "exact" ? lane.live.state : undefined;
  const presentation = statePresentation[state ?? legacyState ?? "unknown"];
  if (!observed && !legacyState)
    return {
      label: "Running · work state unavailable",
      processLabel: "Running",
      workLabel: "Work state unavailable",
      className: "state-unobserved",
    };
  return {
    label: `Running · ${presentation.label}`,
    processLabel: "Running",
    workLabel: presentation.label,
    className: presentation.className,
  };
}

export function responseOutcome(request: Request): ResponseOutcomeMarker | undefined {
  const stopReason = request.stopReason;
  const visual =
    stopReason === "toolUse"
      ? "continuation"
      : stopReason === "stop"
        ? "stop"
        : stopReason
          ? "terminal"
          : undefined;
  return visual
    ? {
        requestId: request.id,
        sessionId: request.sessionId,
        at: request.at,
        visual,
        stopReason,
      }
    : undefined;
}

export function responseOutcomesFromRequests(requests: Request[]) {
  return requests.flatMap((request) => {
    const marker = responseOutcome(request);
    return marker ? [marker] : [];
  });
}

const noTmux = "No live tmux evidence";
export function explicitProjectName(lane: Lane) {
  return lane.session.projectName;
}

function cwdBasename(cwd: string | undefined) {
  const normalized = cwd?.trim().replace(/[\\/]+$/, "");
  if (!normalized) return undefined;
  return normalized.split(/[\\/]/).at(-1) || undefined;
}

/**
 * A display-only Project/workspace coordinate. An explicit registry Project
 * label wins; cwd contributes only its basename and never becomes Project
 * identity or association evidence.
 */
export function effectiveProjectLabel(lane: Lane) {
  return explicitProjectName(lane) ?? cwdBasename(lane.session.cwd || lane.live?.cwd);
}

/**
 * Compact presentation tuple used by each Intelligent lane. Missing
 * coordinates stay explicit, and the inspector remains the place to audit
 * their evidence. This is not an identity key.
 */
export function laneContextPresentation(lane: Lane) {
  const team = lane.live?.coordination?.teamName;
  const teamRoleName = lane.live?.coordination?.agentName;
  const project = effectiveProjectLabel(lane);
  const sessionName = lane.session.name ?? lane.live?.sessionName;
  const parts = [
    { coordinate: "team" as const, value: team },
    { coordinate: "team-role" as const, value: teamRoleName },
    { coordinate: "session" as const, value: sessionName },
    { coordinate: "project" as const, value: project },
  ].filter(
    (part): part is { coordinate: "team" | "team-role" | "session" | "project"; value: string } =>
      Boolean(part.value),
  );
  // The sort contract keeps all four slots, but the human title spends no
  // space on missing evidence. Session ID remains visible on its own line.
  const label = parts.map((part) => part.value).join(" | ") || "Unlabelled session";
  return { label, parts, sessionName, project, team, teamRoleName };
}

/**
 * Coordination role is the sole hierarchy signal. Only an explicit teammate
 * is subordinate; team leads, standalone Sessions, and unknown coordination
 * retain the primary lane treatment.
 */
export function laneIdentityEmphasis(lane: Lane) {
  return lane.live?.coordination?.role === "teammate" ? "teammate" : "primary";
}

function intelligentCoordinates(lane: Lane) {
  const context = laneContextPresentation(lane);
  return [
    context.team ?? "",
    context.teamRoleName ?? "",
    context.sessionName ?? "",
    context.project ?? "",
  ];
}

/** Sort the Intelligent projection without turning its tuple into a group or identity. */
export function compareIntelligentLanes(left: Lane, right: Lane) {
  const leftCoordinates = intelligentCoordinates(left);
  const rightCoordinates = intelligentCoordinates(right);
  for (let index = 0; index < leftCoordinates.length; index += 1) {
    const comparison = leftCoordinates[index].localeCompare(rightCoordinates[index]);
    if (comparison !== 0) return comparison;
  }
  return left.session.id.localeCompare(right.session.id);
}

const groupResolvers: Record<Exclude<GroupMode, "context">, (lane: Lane) => string> = {
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
  state: (lane) => runtimePresentation(lane).label,
  cwd: (lane) => lane.session.cwd,
  project: (lane) => explicitProjectName(lane) ?? "No Project association",
};

export function groupKey(lane: Lane, mode: GroupMode) {
  if (mode === "context") return "Intelligent";
  return groupResolvers[mode](lane);
}

export function groupLabel(lane: Lane, mode: GroupMode) {
  return groupKey(lane, mode);
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
  Math.max(0, Math.min(100, 100 - ((at - start) / (end - start)) * 100));

export function windowHours(window: SnapshotWindow) {
  return window === "15m"
    ? 0.25
    : window === "1h"
      ? 1
      : window === "6h"
        ? 6
        : window === "24h"
          ? 24
          : null;
}

function uniqueBy<T>(items: T[], key: (item: T) => string) {
  const index = new Map<string, T>();
  for (const item of items) if (!index.has(key(item))) index.set(key(item), item);
  return [...index.values()];
}

/** Merge newest-first metadata pages without ever merging Session identities. */
export function mergeSnapshotPages(head: Snapshot, older: Snapshot[]): Snapshot {
  const pages = [head, ...older];
  return {
    ...head,
    sessions: uniqueBy(
      pages.flatMap((page) => page.sessions),
      (session) => session.id,
    ),
    turns: uniqueBy(
      pages.flatMap((page) => page.turns),
      (turn) => turn.id,
    ),
    requests: uniqueBy(
      pages.flatMap((page) => page.requests),
      (request) => request.id,
    ),
    rarebits: uniqueBy(
      pages.flatMap((page) => page.rarebits ?? []),
      (message) => `${message.sessionId}:${message.sourceEntryId ?? "entry"}:${message.order}`,
    ),
    liveAgents: head.liveAgents,
    page: older.at(-1)?.page ?? head.page,
  };
}
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

function usageMetricLabel(metric: SessionUsageMetric, format: (value: number) => string) {
  if (metric.availability === "unavailable") return "—";
  const formatted = format(metric.value);
  if (metric.availability === "complete") return formatted;
  return `known ${formatted}`;
}

export function tokenUsageLabel(metric: SessionUsageMetric) {
  return usageMetricLabel(metric, compact);
}

export function costUsageLabel(metric: SessionUsageMetric) {
  return usageMetricLabel(metric, money);
}

export function laneSecondaryLabel(lane: Lane) {
  const { tokens, cost } = lane.session.usage;
  return [
    countLabel(lane.rarebits.length, "Rarebit"),
    `${tokenUsageLabel(tokens)} tokens`,
    costUsageLabel(cost),
  ].join(" · ");
}
export const duration = (ms: number) =>
  ms < 60_000
    ? `${Math.max(1, Math.round(ms / 1000))}s`
    : ms < 3_600_000
      ? `${Math.round(ms / 60_000)}m`
      : `${(ms / 3_600_000).toFixed(1)}h`;

export function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

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

function sessionIdentityConfidence(lane: Lane) {
  const live = lane.live;
  return live?.sessionBinding?.confidence ?? live?.sessionConfidence ?? "—";
}

function readableTimestamp(value?: string) {
  const at = Date.parse(value ?? "");
  return Number.isFinite(at) ? new Date(at).toLocaleString() : "Unknown";
}

export function inspectorOperationalDetails(
  lane: Lane,
): ReadonlyArray<readonly [string, string | number]> {
  const live = lane.live;
  const runtime = runtimePresentation(lane);
  const lastObservedAt = live?.heartbeatAt ?? lane.session.endedAt;
  const startedMillis = Date.parse(lane.session.startedAt);
  const observedMillis = Date.parse(lastObservedAt);
  const observedDuration =
    Number.isFinite(startedMillis) && Number.isFinite(observedMillis)
      ? duration(Math.max(0, observedMillis - startedMillis))
      : "Unknown";
  return [
    ["Process state", runtime.processLabel],
    ["Work state", runtime.workLabel],
    ["Started", readableTimestamp(lane.session.startedAt)],
    ["Last observed", readableTimestamp(lastObservedAt)],
    ["Duration", observedDuration],
    ["Turns", lane.session.turnCount],
    ["Requests", lane.session.requestCount],
    ["Total tokens", tokenUsageLabel(lane.session.usage.tokens)],
    ["Spend", costUsageLabel(lane.session.usage.cost)],
    ["Context usage", contextLabel(lane)],
  ];
}

export function inspectorSessionIdentity(lane: Lane) {
  return lane.live ? (lane.live.sessionId ?? "Unavailable") : lane.session.id;
}

export function inspectorDiagnosticDetails(
  lane: Lane,
): ReadonlyArray<readonly [string, string | number]> {
  const live = lane.live;
  return [
    ["Working directory", lane.session.cwd],
    ["PID", live?.pid ?? "—"],
    ["Process instance", live?.processInstanceId ?? "—"],
    ["Source", lane.session.source],
    ["Session identity confidence", sessionIdentityConfidence(lane).replaceAll("_", " ")],
    ["Session match", live?.sessionBinding?.kind.replaceAll("_", " ") ?? "—"],
    ["Session evidence", sessionEvidence(lane)],
    ["Session source", live?.sessionBinding?.sessionSource ?? lane.session.source],
    ["Process evidence", processEvidence(lane)],
  ];
}

/** Compatibility seam for callers that still need the complete flat detail set. */
export function inspectorDetails(lane: Lane): ReadonlyArray<readonly [string, string | number]> {
  return [
    ["Session ID", inspectorSessionIdentity(lane)],
    ...inspectorOperationalDetails(lane),
    ...inspectorDiagnosticDetails(lane),
  ];
}
