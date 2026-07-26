import type {
  FilterMode,
  GroupMode,
  SessionLane,
  ProcessLane,
  ProcessObservation,
  Lane,
  Request,
  RarebitSummaryAttention,
  ResponseOutcomeMarker,
  Session,
  SessionUsageMetric,
  Snapshot,
  SnapshotWindow,
} from "./types";

/** Session and OS-process projections share one discriminated lane pipeline. */
export type TimelineLane = Lane;

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

export function primaryProcess(lane: SessionLane) {
  return lane.primaryProcess;
}

export function tmuxLocation(process?: ProcessObservation) {
  return process?.locations.find((location) => location.provider === "tmux");
}

export function lanesFromSnapshot(snapshot: Snapshot): Lane[] {
  const processesBySession = indexBy(
    (snapshot.processes ?? []).filter((process) => process.link),
    (process) => process.link!.sessionId,
  );
  const turnsBySession = indexBy(snapshot.turns, (turn) => turn.sessionId);
  const rarebitsBySession = indexBy(snapshot.rarebits ?? [], (marker) => marker.sessionId);
  const requests = indexRequests(snapshot.requests);

  return [
    ...snapshot.sessions.map((session): SessionLane => {
      const turns = turnsBySession.get(session.id) ?? [];
      const sessionRequests = requests.bySession.get(session.id) ?? [];
      const lastMessageAt = messageTime(session);
      const processes = processesBySession.get(session.id) ?? [];
      return {
        kind: "session",
        session,
        turns,
        requests: sessionRequests,
        requestsByTurn: requests.bySessionTurn.get(session.id) ?? new Map(),
        rarebits: rarebitsBySession.get(session.id) ?? [],
        responseOutcomes: responseOutcomesFromRequests(sessionRequests),
        processes,
        primaryProcess: processes[0],
        boundedTimeAnchor:
          lastMessageAt === undefined
            ? undefined
            : { at: lastMessageAt, source: "message" as const },
        start: Date.parse(session.startedAt),
        end: Date.parse(session.endedAt),
      };
    }),
    ...(snapshot.processes ?? [])
      .filter(
        (process) =>
          !process.link ||
          !snapshot.sessions.some((session) => session.id === process.link?.sessionId),
      )
      .map((process): ProcessLane => {
        const start = Date.parse(process.observedAt);
        return {
          kind: "process",
          process,
          start,
          end: Date.parse(snapshot.generatedAt),
          boundedTimeAnchor: { at: start, source: "runtime-observation" },
        };
      }),
  ].sort((a, b) => a.start - b.start);
}

/** Kept for narrow callers; normal Timeline rendering uses lanesFromSnapshot only. */
export function processLanesFromSnapshot(snapshot: Snapshot): ProcessLane[] {
  return lanesFromSnapshot(snapshot).filter((lane): lane is ProcessLane => lane.kind === "process");
}

export function laneSelectionKey(lane: Lane) {
  return lane.kind === "session" ? `session:${lane.session.id}` : `process:${lane.process.id}`;
}

export function laneMatchesQuery(lane: Lane, query: string) {
  if (lane.kind === "session") return sessionMatchesQuery(lane.session, query);
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    String(lane.process.pid),
    lane.process.id,
    lane.process.cwd ?? "",
    ...lane.process.locations.flatMap((location) =>
      [location.provider, location.paneId, location.tabId, location.workspaceId].flatMap((value) =>
        typeof value === "string" ? [value] : [],
      ),
    ),
  ].some((candidate) => candidate.toLowerCase().includes(needle));
}

export function laneAlias(lane: SessionLane) {
  return laneContextPresentation(lane).identity;
}

export function shortSessionId(lane: SessionLane) {
  return lane.session.id.slice(0, 8);
}

/**
 * A label is a presentation aid, never Session identity. Keep the short ID
 * visible whenever an alias is missing or conflicts within the current view.
 */
export function laneDisplayLabel(lane: SessionLane, lanes: SessionLane[]) {
  const alias = laneAlias(lane);
  const conflicts = lanes.filter((candidate) => laneAlias(candidate) === alias).length > 1;
  return conflicts || alias === shortSessionId(lane) ? `${alias} · ${shortSessionId(lane)}` : alias;
}

export function runtimePresentation(lane: Lane) {
  if (lane.kind === "process")
    return {
      label: "Running · work state unavailable",
      processLabel: "Running",
      workLabel: "Work state unavailable",
      className: "state-unobserved",
    };
  if (!lane.primaryProcess)
    return {
      label: "No associated live process",
      processLabel: "No associated live process",
      workLabel: "No live process observation",
      className: "state-stopped",
    };
  return {
    label: "Running · work state unavailable",
    processLabel: "Running",
    workLabel: "Work state unavailable",
    className: "state-unobserved",
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
export function explicitProjectName(lane: SessionLane) {
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
export function effectiveProjectLabel(lane: SessionLane) {
  return explicitProjectName(lane) ?? cwdBasename(lane.session.cwd || lane.primaryProcess?.cwd);
}

/**
 * Compact presentation tuple used by each Intelligent lane. Missing
 * coordinates stay explicit, and the inspector remains the place to audit
 * their evidence. This is not an identity key.
 */
export function laneContextPresentation(lane: SessionLane) {
  const team = lane.primaryProcess?.coordination?.teamName;
  const teamRoleName = lane.primaryProcess?.coordination?.agentName;
  const project = effectiveProjectLabel(lane);
  const sessionName = lane.session.name;
  const verifiedTeamMember =
    lane.primaryProcess?.link?.grade === "provider_verified" && team && teamRoleName
      ? `${team} / ${teamRoleName}`
      : undefined;
  const identity = sessionName ?? verifiedTeamMember ?? `Unnamed session · ${shortSessionId(lane)}`;
  const identitySource = sessionName
    ? "native-session-name"
    : verifiedTeamMember
      ? "verified-team-member"
      : "unnamed-session";
  const parts = [
    ...(sessionName
      ? [
          { coordinate: "team" as const, value: team },
          { coordinate: "team-role" as const, value: teamRoleName },
          { coordinate: "session" as const, value: sessionName },
        ]
      : verifiedTeamMember
        ? [
            { coordinate: "team" as const, value: team },
            { coordinate: "team-role" as const, value: teamRoleName },
          ]
        : [{ coordinate: "session" as const, value: identity }]),
    { coordinate: "project" as const, value: project },
  ].filter(
    (part): part is { coordinate: "team" | "team-role" | "session" | "project"; value: string } =>
      Boolean(part.value),
  );
  const label = parts
    .map((part, index) =>
      index === 1 && identitySource === "verified-team-member" ? ` / ${part.value}` : part.value,
    )
    .join(" | ")
    .replace(" |  / ", " / ");
  return { label, parts, identity, identitySource, sessionName, project, team, teamRoleName };
}

/**
 * Coordination role is the sole hierarchy signal. Only an explicit teammate
 * is subordinate; team leads, standalone Sessions, and unknown coordination
 * retain the primary lane treatment.
 */
export function laneIdentityEmphasis(lane: SessionLane) {
  return lane.primaryProcess?.coordination?.role === "teammate" ? "teammate" : "primary";
}

function intelligentCoordinates(lane: SessionLane) {
  const context = laneContextPresentation(lane);
  return [
    context.team ?? "",
    context.teamRoleName ?? "",
    context.sessionName ?? "",
    context.project ?? "",
  ];
}

/** Sort the Intelligent projection without turning its tuple into a group or identity. */
export function compareIntelligentLanes(left: SessionLane, right: SessionLane) {
  const leftCoordinates = intelligentCoordinates(left);
  const rightCoordinates = intelligentCoordinates(right);
  for (let index = 0; index < leftCoordinates.length; index += 1) {
    const comparison = leftCoordinates[index].localeCompare(rightCoordinates[index]);
    if (comparison !== 0) return comparison;
  }
  return left.session.id.localeCompare(right.session.id);
}

const groupResolvers: Record<Exclude<GroupMode, "context">, (lane: SessionLane) => string> = {
  none: () => "All sessions",
  name: (lane) => lane.session.name ?? lane.session.id,
  team: (lane) => lane.primaryProcess?.coordination?.teamName ?? "No Pi Team evidence",
  "tmux-session": (lane) => String(tmuxLocation(lane.primaryProcess)?.sessionName ?? noTmux),
  "tmux-window": (lane) => {
    const pane = tmuxLocation(lane.primaryProcess);
    const name = pane?.windowName ? `: ${pane.windowName}` : "";
    return pane ? `${pane.sessionName} / ${pane.windowIndex}${name}` : noTmux;
  },
  "tmux-pane": (lane) => {
    const pane = tmuxLocation(lane.primaryProcess);
    return pane ? `${pane.sessionName} / ${pane.windowIndex} / ${pane.paneId}` : noTmux;
  },
  state: (lane) => runtimePresentation(lane).label,
  cwd: (lane) => lane.session.cwd,
  project: (lane) => explicitProjectName(lane) ?? "No Project association",
};

function processTmuxKey(lane: ProcessLane, mode: GroupMode) {
  const tmux = lane.process.locations.find((location) => location.provider === "tmux");
  if (!tmux) return noTmux;
  const session = String(tmux.sessionName ?? noTmux);
  const window = `${session} / ${tmux.windowIndex ?? "?"}`;
  return mode === "tmux-session"
    ? session
    : mode === "tmux-window"
      ? window
      : `${window} / ${tmux.paneId ?? "?"}`;
}

const processGroupResolvers: Partial<Record<GroupMode, (lane: ProcessLane) => string>> = {
  context: () => "Unbound process observations",
  none: () => "All lanes",
  state: (lane) => runtimePresentation(lane).label,
  cwd: (lane) => lane.process.cwd ?? "Working directory unavailable",
  team: (lane) => lane.process.coordination?.teamName ?? "No Pi Team evidence",
  name: (lane) => `PID ${lane.process.pid}`,
  "tmux-session": (lane) => processTmuxKey(lane, "tmux-session"),
  "tmux-window": (lane) => processTmuxKey(lane, "tmux-window"),
  "tmux-pane": (lane) => processTmuxKey(lane, "tmux-pane"),
};

export function groupKey(lane: Lane, mode: GroupMode) {
  if (lane.kind === "process")
    return processGroupResolvers[mode]?.(lane) ?? "No Session/Project evidence";
  return mode === "context" ? "Intelligent" : groupResolvers[mode](lane);
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
  const hi = Math.max(
    now,
    ...lanes.map((lane) => (lane.kind === "process" || lane.primaryProcess ? now : lane.end)),
  );
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
    processes: head.processes,
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

export function laneSecondaryLabel(lane: SessionLane) {
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

function contextLabel() {
  return "Unavailable";
}

function sessionEvidence(lane: SessionLane) {
  return lane.primaryProcess?.link?.provenance.join(",") ?? "—";
}

function processEvidence(lane: SessionLane) {
  return lane.primaryProcess ? "os process scan · exact observation" : "—";
}

function sessionIdentityConfidence(lane: SessionLane) {
  return lane.primaryProcess?.link?.grade ?? "—";
}

function readableTimestamp(value?: string) {
  const at = Date.parse(value ?? "");
  return Number.isFinite(at) ? new Date(at).toLocaleString() : "Unknown";
}

export function inspectorOperationalDetails(
  lane: SessionLane,
): ReadonlyArray<readonly [string, string | number]> {
  const runtime = runtimePresentation(lane);
  const lastObservedAt = lane.session.endedAt;
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
    ["Last Session evidence", readableTimestamp(lastObservedAt)],
    ["Duration", observedDuration],
    ["Turns", lane.session.turnCount],
    ["Requests", lane.session.requestCount],
    ["Total tokens", tokenUsageLabel(lane.session.usage.tokens)],
    ["Spend", costUsageLabel(lane.session.usage.cost)],
    ["Context usage", contextLabel()],
  ];
}

export function inspectorSessionIdentity(lane: SessionLane) {
  return lane.session.id;
}

export function inspectorDiagnosticDetails(
  lane: SessionLane,
): ReadonlyArray<readonly [string, string | number]> {
  const process = lane.primaryProcess;
  return [
    ["Working directory", lane.session.cwd],
    ["PID", process?.pid ?? "—"],
    ["Process instance", process?.id ?? "—"],
    ["Source", lane.session.source],
    ["Session identity confidence", sessionIdentityConfidence(lane).replaceAll("_", " ")],
    ["Session match", process?.link?.method.replaceAll("_", " ") ?? "—"],
    ["Session evidence", sessionEvidence(lane)],
    ["Session source", lane.session.source],
    ["Process evidence", processEvidence(lane)],
  ];
}

export function inspectorDetails(
  lane: SessionLane,
): ReadonlyArray<readonly [string, string | number]> {
  return [
    ["Session ID", inspectorSessionIdentity(lane)],
    ...inspectorOperationalDetails(lane),
    ...inspectorDiagnosticDetails(lane),
  ];
}
