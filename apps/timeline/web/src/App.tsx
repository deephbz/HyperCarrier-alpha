import { Fragment, useEffect, useMemo, useState } from "react";
import {
  InspectorTrafficAction,
  TrafficAgentToggle,
  TrafficLaunch,
  TrafficProvider,
} from "./TrafficLaunch";
import {
  compareIntelligentLanes,
  compact,
  countLabel,
  extent,
  filterKey,
  filterLanesByBoundedTime,
  groupKey,
  groupLabel,
  inspectorDiagnosticDetails,
  inspectorOperationalDetails,
  inspectorSessionIdentity,
  laneContextPresentation,
  laneDisplayLabel,
  laneIdentityEmphasis,
  laneMatchesQuery,
  laneSelectionKey,
  lanesFromSnapshot,
  laneSecondaryLabel,
  mergeSnapshotPages,
  position,
  primaryProcess,
  runtimePresentation,
  tmuxLocation,
  summaryStatusPresentation,
  windowHours,
} from "./model";
import { demoSnapshot } from "./demo";
import { parseTimelineSnapshot, SnapshotCompatibilityError } from "./snapshot-contract";
import type {
  FilterMode,
  GroupMode,
  Lane,
  ProcessLane,
  RarebitSummaryStatus,
  SessionLane,
  Snapshot,
  SnapshotWindow,
} from "./types";

const rangeOptions: Array<{ value: SnapshotWindow; label: string }> = [
  { value: "15m", label: "Last 15m" },
  { value: "1h", label: "Last 1h" },
  { value: "6h", label: "Last 6h" },
  { value: "24h", label: "Last 24h" },
  { value: "all", label: "All history" },
];
const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});
const forceDemo = new URLSearchParams(window.location.search).get("demo") === "1";
const diagnosticsEnabled = new URLSearchParams(window.location.search).get("diagnostics") === "1";
const DAY_MS = 24 * 3_600_000;

type Diagnostics = {
  fetches: number;
  invalidations: number;
  queuedRefreshes: number;
  lastFetchMs?: number;
  lastPayloadBytes?: number;
};

const queuedRefreshDiagnostics = (previous: Diagnostics): Diagnostics => ({
  ...previous,
  queuedRefreshes: previous.queuedRefreshes + 1,
});
const invalidationDiagnostics = (previous: Diagnostics): Diagnostics => ({
  ...previous,
  invalidations: previous.invalidations + 1,
});
const fetchedDiagnostics = (fetchStartedAt: number, body: string) => (previous: Diagnostics) => ({
  ...previous,
  fetches: previous.fetches + 1,
  lastFetchMs: performance.now() - fetchStartedAt,
  lastPayloadBytes: new TextEncoder().encode(body).byteLength,
});

function finiteTime(value: number | null) {
  return value !== null && Number.isFinite(value) ? value : null;
}

function selectedSnapshotWindow(
  windowMode: SnapshotWindow,
  start: number | null,
  rangeEnd: number,
) {
  if (windowMode === "all") return "all";
  if (start !== null && rangeEnd - start > DAY_MS) return "all";
  return windowMode;
}

function addTimeParameter(params: URLSearchParams, name: string, value: number | null) {
  if (value !== null) params.set(name, String(value));
}

export function snapshotSelection(
  windowMode: SnapshotWindow,
  customStartMs: number | null,
  customEndMs: number | null,
  now: number,
) {
  const start = finiteTime(customStartMs);
  const end = finiteTime(customEndMs);
  const window = selectedSnapshotWindow(windowMode, start, end === null ? now : end);
  const params = new URLSearchParams({ window });
  addTimeParameter(params, "from", start);
  addTimeParameter(params, "to", end);
  return { window, query: params.toString() };
}

function snapshotDiagnostic(snapshot: Snapshot | null, laneCount: number) {
  return snapshot
    ? `${countLabel(snapshot.sessions.length, "session")} · ${countLabel(laneCount, "lane")}`
    : "loading";
}

function collectorDiagnostic(snapshot: Snapshot | null) {
  return snapshot
    ? `${snapshot.trace.durationMs.toFixed(1)}ms · ${snapshot.trace.refresh?.reason ?? "unknown"}`
    : "—";
}

function cacheDiagnostic(snapshot: Snapshot | null) {
  const cache = snapshot?.trace.sessionCache;
  return cache
    ? `${compact(cache.bytesRead)}B read · ${cache.linesParsed} lines · ${cache.appendCount} append / ${cache.rebuildCount} rebuild`
    : "not reported";
}

function browserDiagnostic(diagnostics: Diagnostics) {
  const fetchMs = diagnostics.lastFetchMs?.toFixed(1) ?? "—";
  const payload =
    diagnostics.lastPayloadBytes === undefined ? "—" : `${compact(diagnostics.lastPayloadBytes)}B`;
  return `${diagnostics.fetches} fetches · ${diagnostics.invalidations} invalidations · ${diagnostics.queuedRefreshes} queued · ${fetchMs}ms · ${payload}`;
}

function filterVisibleLanes({
  lanes,
  from,
  to,
  alive,
  filterValue,
  filterMode,
  query,
}: {
  lanes: Lane[];
  from: number | null;
  to: number | null;
  alive: boolean;
  filterValue: string;
  filterMode: FilterMode;
  query: string;
}) {
  return filterLanesByBoundedTime(lanes, from, to).filter(
    (lane) =>
      (!alive || lane.kind === "process" || Boolean(lane.primaryProcess)) &&
      (!filterValue || filterKey(lane, filterMode) === filterValue) &&
      laneMatchesQuery(lane, query),
  );
}

function groupedLanes(lanes: Lane[], mode: GroupMode) {
  if (!lanes.length) return [];
  if (mode === "context") {
    const sessions = lanes.filter((lane): lane is SessionLane => lane.kind === "session");
    const processes = lanes.filter((lane): lane is ProcessLane => lane.kind === "process");
    return [
      ...(sessions.length
        ? [
            [
              "Intelligent",
              { label: "Intelligent", lanes: [...sessions].sort(compareIntelligentLanes) },
            ],
          ]
        : []),
      ...(processes.length
        ? [["Unbound live processes", { label: "Unbound live processes", lanes: processes }]]
        : []),
    ] as Array<[string, { label: string; lanes: Lane[] }]>;
  }
  const groups = new Map<string, { label: string; lanes: Lane[] }>();
  for (const lane of lanes) {
    const key = groupKey(lane, mode);
    const existing = groups.get(key);
    if (existing) existing.lanes.push(lane);
    else groups.set(key, { label: groupLabel(lane, mode), lanes: [lane] });
  }
  return [...groups.entries()];
}

function connectionLabel(connection: "live" | "demo" | "error") {
  if (connection === "live") return "Live";
  if (connection === "demo") return "Demo data";
  return "Reconnecting";
}

function DiagnosticsPanel({
  enabled,
  snapshot,
  laneCount,
  diagnostics,
}: {
  enabled: boolean;
  snapshot: Snapshot | null;
  laneCount: number;
  diagnostics: Diagnostics;
}) {
  if (!enabled) return null;
  const rows = [
    ["Snapshot", snapshotDiagnostic(snapshot, laneCount)],
    ["Collector", collectorDiagnostic(snapshot)],
    ["JSONL cache", cacheDiagnostic(snapshot)],
    ["Browser", browserDiagnostic(diagnostics)],
  ];
  return (
    <details className="diagnostics" open>
      <summary>Local diagnostics — safe to copy into a bug report</summary>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function Toolbar({
  window,
  setWindow,
  group,
  setGroup,
  filterMode,
  setFilterMode,
  filterValue,
  setFilterValue,
  filterOptions,
  alive,
  setAlive,
  query,
  setQuery,
  customStart,
  setCustomStart,
  customEnd,
  setCustomEnd,
}: {
  window: SnapshotWindow;
  setWindow: (value: SnapshotWindow) => void;
  group: GroupMode;
  setGroup: (v: GroupMode) => void;
  filterMode: FilterMode;
  setFilterMode: (v: FilterMode) => void;
  filterValue: string;
  setFilterValue: (v: string) => void;
  filterOptions: string[];
  alive: boolean;
  setAlive: (v: boolean) => void;
  query: string;
  setQuery: (v: string) => void;
  customStart: string;
  setCustomStart: (v: string) => void;
  customEnd: string;
  setCustomEnd: (v: string) => void;
}) {
  return (
    <div className="toolbar" aria-label="Timeline controls">
      <label>
        Activity
        <select
          aria-label="Activity window"
          value={window}
          onChange={(event) => {
            setWindow(event.target.value as SnapshotWindow);
            setCustomStart("");
            setCustomEnd("");
          }}
        >
          {rangeOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="time-input">
        From
        <input
          type="datetime-local"
          aria-label="From"
          value={customStart}
          onChange={(event) => {
            setCustomStart(event.target.value);
            if (window === "all") setWindow("24h");
          }}
        />
      </label>
      <label>
        Filter
        <select
          aria-label="Filter sessions by"
          value={filterMode}
          onChange={(e) => {
            setFilterMode(e.target.value as FilterMode);
            setFilterValue("");
          }}
        >
          <option value="all">No filter</option>
          <option value="project">Project</option>
          <option value="cwd">cwd</option>
          <option value="name">Session name</option>
          <option value="team">Pi Team</option>
          <option value="tmux-session">tmux session</option>
          <option value="tmux-window">tmux window</option>
          <option value="state">State</option>
        </select>
      </label>
      {filterMode !== "all" ? (
        <label>
          Value
          <select
            aria-label="Filter value"
            value={filterValue}
            onChange={(e) => setFilterValue(e.target.value)}
          >
            <option value="">Any</option>
            {filterOptions.map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        </label>
      ) : null}
      <label>
        Group
        <select value={group} onChange={(e) => setGroup(e.target.value as GroupMode)}>
          <option value="context">Intelligent</option>
          <option value="project">Project</option>
          <option value="cwd">cwd</option>
          <option value="name">Session name</option>
          <option value="team">Pi Team</option>
          <option value="tmux-session">tmux session</option>
          <option value="tmux-window">tmux window</option>
          <option value="tmux-pane">tmux pane</option>
          <option value="state">State</option>
          <option value="none">None</option>
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={alive} onChange={(e) => setAlive(e.target.checked)} /> Alive
        only
      </label>
      <label className="time-input">
        To
        <input
          type="datetime-local"
          aria-label="To"
          value={customEnd}
          onChange={(event) => {
            setCustomEnd(event.target.value);
            if (window === "all") setWindow("24h");
          }}
        />
      </label>
      <input
        className="search"
        aria-label="Search sessions"
        placeholder="Search ID, name, or cwd…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
    </div>
  );
}

function Ruler({ domain }: { domain: [number, number] }) {
  const ticks = Array.from({ length: 7 }, (_, i) => domain[1] - ((domain[1] - domain[0]) * i) / 6);
  return (
    <div className="ruler timeline-cell">
      {ticks.map((t, i) => (
        <span key={t} style={{ left: `${(i / 6) * 100}%` }}>
          {timeFmt.format(t)}
        </span>
      ))}
    </div>
  );
}

function markerX(at: number, domain: [number, number]) {
  return position(at, domain) * 10;
}

function circlePath(points: number[], radius: number) {
  return points
    .map(
      (x) =>
        `M ${x - radius} 20 a ${radius} ${radius} 0 1 0 ${radius * 2} 0 a ${radius} ${radius} 0 1 0 ${-radius * 2} 0`,
    )
    .join(" ");
}

function crossPath(points: number[]) {
  return points.map((x) => `M ${x - 3} 17 L ${x + 3} 23 M ${x + 3} 17 L ${x - 3} 23`).join(" ");
}

function squarePath(points: number[]) {
  return points.map((x) => `M ${x - 3} 17 h 6 v 6 h -6 Z`).join(" ");
}

export function laneMarkerPaths(lane: Lane, domain: [number, number]) {
  const users = lane.rarebits.flatMap((marker) => {
    const at = Date.parse(marker.timestamp ?? "");
    return marker.outcome === "user" && Number.isFinite(at) ? [markerX(at, domain)] : [];
  });
  const responsePoints = (visual: "continuation" | "stop" | "terminal") =>
    lane.responseOutcomes.flatMap((marker) => {
      const at = Date.parse(marker.at);
      return marker.visual === visual && Number.isFinite(at) ? [markerX(at, domain)] : [];
    });
  return {
    users: squarePath(users),
    continuation: circlePath(responsePoints("continuation"), 2),
    stop: circlePath(responsePoints("stop"), 3),
    terminal: crossPath(responsePoints("terminal")),
  };
}

export function laneOutcomeSummary(lane: Lane) {
  const counts = new Map<string, number>();
  for (const marker of lane.responseOutcomes)
    counts.set(marker.stopReason, (counts.get(marker.stopReason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, count]) => `${reason} ${count}`).join(", ");
}

function LaneRow({
  lane,
  visibleLanes,
  domain,
  selected,
  onSelect,
}: {
  lane: SessionLane;
  visibleLanes: SessionLane[];
  domain: [number, number];
  selected: boolean;
  onSelect: () => void;
}) {
  const runtime = runtimePresentation(lane);
  const context = laneContextPresentation(lane);
  const alias = laneDisplayLabel(lane, visibleLanes);
  const identityEmphasis = laneIdentityEmphasis(lane);
  const secondary = laneSecondaryLabel(lane);
  const paths = laneMarkerPaths(lane, domain);
  const outcomeSummary = laneOutcomeSummary(lane);
  const attention = summaryStatusPresentation(lane.session.rarebitSummaryStatus);
  return (
    <div className={`lane ${selected ? "selected" : ""}`}>
      <TrafficAgentToggle sessionId={lane.session.id} label={alias} />
      <div className="lane-label">
        <button
          className="lane-select"
          onClick={onSelect}
          aria-label={`${alias}, session ${lane.session.id}, context ${context.label}, ${attention ? `${attention.label}, ` : ""}${runtime.label}, ${secondary}`}
        >
          <span className="lane-status-cluster">
            <span className="lane-attention-slot" aria-hidden={attention ? undefined : true}>
              {attention ? (
                <span
                  className={`lane-attention ${attention.className}`}
                  role="img"
                  aria-label={attention.label}
                  title={attention.label}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path className="lane-attention-shape" d="M8 1.5 14.5 8 8 14.5 1.5 8Z" />
                    <path className="lane-attention-mark" d="M8 4.5v5M8 11.7v.1" />
                  </svg>
                </span>
              ) : null}
            </span>
            <span className={`state-dot ${runtime.className}`} aria-hidden="true" />
          </span>
          <span className="lane-copy">
            <strong
              className={`lane-context lane-context-${identityEmphasis}`}
              aria-label={context.label}
              title={context.label}
            >
              {context.parts.length === 0 ? (
                <span className="lane-context-part lane-context-session">{context.label}</span>
              ) : (
                context.parts.map((part, index) => (
                  <Fragment key={`${part.coordinate}:${part.value}`}>
                    {index > 0 && (
                      <span className="lane-context-separator" aria-hidden="true">
                        {index === 1 && context.identitySource === "verified-team-member"
                          ? " / "
                          : " | "}
                      </span>
                    )}
                    <span
                      className={`lane-context-part lane-context-${part.coordinate}`}
                      data-coordinate={part.coordinate}
                    >
                      {part.value}
                    </span>
                  </Fragment>
                ))
              )}
            </strong>
          </span>
        </button>
        <div className="lane-secondary">
          <small>
            {lane.primaryProcess?.link
              ? `${lane.primaryProcess.link.grade === "provider_verified" ? "Provider-verified link" : "Heuristic link"} · `
              : ""}
            {secondary}
          </small>
          {lane.session.links && (
            <nav className="lane-links" aria-label={`Inspect ${alias}`}>
              <a
                href={lane.session.links.live}
                target="_blank"
                rel="noreferrer"
                title="Open live session inspector"
                aria-label={`Open live inspector for ${alias}`}
              >
                ↗
              </a>
              <a
                href={lane.session.links.tps}
                target="_blank"
                rel="noreferrer"
                title="Open TPS inspector"
                aria-label={`Open TPS inspector for ${alias}`}
              >
                ϟ
              </a>
            </nav>
          )}
        </div>
      </div>
      <div
        className="track timeline-cell"
        role="img"
        aria-label={`User messages and response outcomes for ${lane.session.name ?? lane.session.id}: ${outcomeSummary || "no response outcomes"}`}
        onClick={onSelect}
      >
        <svg viewBox="0 0 1000 40" preserveAspectRatio="none" aria-hidden="true">
          <path className="user-marker" d={paths.users} />
          <path className="response-marker-continuation" d={paths.continuation} />
          <path className="response-marker-stop" d={paths.stop} />
          <path className="response-marker-terminal" d={paths.terminal} />
        </svg>
      </div>
    </div>
  );
}

type RarebitSummaryDetail = {
  availability: "available" | "missing" | "unavailable";
  summaryStatus?: RarebitSummaryStatus;
  reason?: string | null;
  status?: "user_requested" | "finished" | "needs_attention" | "ineligible" | "error" | null;
  jobId?: string | null;
  observedAt?: string | null;
  summary?: string | null;
  selection?: {
    selectorVersion: string | null;
    manifestHash: string | null;
    occurrenceCount: number | null;
    uniquePayloadCount: number | null;
  } | null;
  provenance?: {
    model?: { provider: string; id: string } | null;
    implementationVersion?: string | null;
    promptVersion?: string | null;
    lifecycleBoundary?: string | null;
  };
};

async function copyText(value: string | number) {
  const text = String(value);
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {}
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

function CopyablePair({ label, value }: { label: string; value: string | number }) {
  const copyUnlessSelecting = () => {
    if (window.getSelection()?.toString()) return;
    void copyText(value);
  };
  return (
    <div className="copyable-pair" onClick={copyUnlessSelecting} title={`Click to copy ${label}`}>
      <dt>{label}</dt>
      <dd>
        <span>{value}</span>
        <button
          className="copy-value"
          onClick={(event) => {
            event.stopPropagation();
            void copyText(value);
          }}
          aria-label={`Copy ${label}`}
        >
          Copy
        </button>
      </dd>
    </div>
  );
}

function RarebitSummaryStatusTrace({
  summaryStatus,
}: {
  summaryStatus: Lane["session"]["rarebitSummaryStatus"];
}) {
  const value =
    summaryStatus?.state === "available"
      ? `${summaryStatus.status.replaceAll("_", " ")}${summaryStatus.sourcePending ? " · source pending" : ""}`
      : "Unknown";
  return (
    <>
      <CopyablePair label="Lane Summary status" value={value} />
      {summaryStatus?.source.schemaVersion !== null &&
      summaryStatus?.source.schemaVersion !== undefined ? (
        <CopyablePair label="Snapshot summary schema" value={summaryStatus.source.schemaVersion} />
      ) : null}
      {summaryStatus?.source.observedAt ? (
        <CopyablePair label="Snapshot Summary as of" value={summaryStatus.source.observedAt} />
      ) : null}
      {summaryStatus?.source.jobId ? (
        <CopyablePair label="Snapshot summary job" value={summaryStatus.source.jobId} />
      ) : null}
      {summaryStatus?.source.selectionManifestHash ? (
        <CopyablePair
          label="Snapshot selection manifest"
          value={summaryStatus.source.selectionManifestHash}
        />
      ) : null}
    </>
  );
}

export type RarebitSummarySection = {
  label: "Progress" | "Findings" | "Questions/Requests" | "Next step" | "Summary";
  value: string;
};

export function rarebitSummarySections(summary?: string): RarebitSummarySection[] {
  const value = summary?.trim();
  if (!value) return [];
  const structured = value.match(
    /^Progress:\s*([\s\S]*?)\s*\|\s*Findings:\s*([\s\S]*?)\s*\|\s*Questions\/Requests:\s*([\s\S]*?)\s*\|\s*Next step:\s*([\s\S]*)$/i,
  );
  if (!structured) return [{ label: "Summary", value }];
  return [
    { label: "Progress", value: structured[1].trim() },
    { label: "Findings", value: structured[2].trim() },
    { label: "Questions/Requests", value: structured[3].trim() },
    { label: "Next step", value: structured[4].trim() },
  ];
}

function useRarebitSummaryDetail(sessionId: string) {
  const [loaded, setLoaded] = useState<{
    sessionId: string;
    detail: RarebitSummaryDetail;
  } | null>(null);
  const detail = loaded?.sessionId === sessionId ? loaded.detail : null;
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/rarebit-summary`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as RarebitSummaryDetail;
      })
      .then((value) => {
        if (!controller.signal.aborted) setLoaded({ sessionId, detail: value });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setLoaded({
            sessionId,
            detail: { availability: "unavailable", reason: "detail_request_failed" },
          });
      });
    return () => controller.abort();
  }, [sessionId]);
  return detail;
}

function summaryStatusAssessment(summary: Lane["session"]["rarebitSummaryStatus"]) {
  if (summary?.state === "available")
    return {
      state: summary.presentation.tone,
      label: summary.presentation.label,
      detail:
        "This package-derived Session assessment is distinct from runtime, Task, and Project state.",
      symbol: summary.presentation.mark ?? "",
    };
  return {
    state: "unknown",
    label: "Summary status unknown",
    detail: `Unknown because ${summary?.reason ?? "no current summary status is present"}.`,
    symbol: "?",
  };
}

function summaryAvailability(detail: RarebitSummaryDetail | null) {
  if (!detail)
    return {
      state: "loading",
      label: "Loading derived summary…",
      detail: "The lane remains available while detail loads.",
    };
  if (detail.summaryStatus?.state === "available" && detail.summaryStatus.status === "error")
    return {
      state: "unavailable",
      label: detail.summaryStatus.presentation.label,
      detail: `The package reader failed closed (${detail.summaryStatus.reason ?? "unknown reason"}).`,
    };
  if (detail.availability === "missing")
    return {
      state: "unknown",
      label: "No materialized summary",
      detail: "No current Rarebit Summary receipt is available.",
    };
  if (detail.availability === "unavailable")
    return {
      state: "unavailable",
      label: "Summary unavailable",
      detail: "The package reader could not safely read the current receipt.",
    };
  return {
    state: "available",
    label:
      detail.summaryStatus?.state === "available"
        ? detail.summaryStatus.presentation.label
        : "Summary status unknown",
    detail: "A lossy projection over selected Rarebit evidence.",
  };
}

function RarebitSummary({
  detail,
  summaryStatus,
}: {
  detail: RarebitSummaryDetail | null;
  summaryStatus: Lane["session"]["rarebitSummaryStatus"];
}) {
  const availability = summaryAvailability(detail);
  const assessment = summaryStatusAssessment(summaryStatus);
  const sections = rarebitSummarySections(detail?.summary);
  return (
    <section className="key-summary">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Rarebit Summary</p>
          <h3>What changed and what comes next</h3>
        </div>
        <span className={`summary-freshness summary-${availability.state}`}>
          {availability.label}
        </span>
      </div>
      <div className={`attention-assessment attention-${assessment.state}`} role="status">
        {assessment.symbol ? (
          <span className="attention-assessment-symbol" aria-hidden="true">
            <span>{assessment.symbol}</span>
          </span>
        ) : null}
        <span>
          <strong>{assessment.label}</strong>
          <small>{assessment.detail}</small>
        </span>
      </div>
      <p className="summary-availability-detail">{availability.detail}</p>
      {sections.length ? (
        <dl className="summary-sections">
          {sections.map((section) => (
            <div key={section.label}>
              <dt>{section.label}</dt>
              <dd className={/^None stated\.?$/i.test(section.value) ? "summary-none" : undefined}>
                {section.value || "None stated"}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

function OverviewFact({
  label,
  value,
  detail,
  wide = false,
}: {
  label: string;
  value: string | number;
  detail?: string;
  wide?: boolean;
}) {
  return (
    <div className={`overview-fact ${wide ? "overview-fact-wide" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

function OperationalOverview({
  lane,
  summaryStatus,
}: {
  lane: Lane;
  summaryStatus: RarebitSummaryStatus | undefined;
}) {
  const details = inspectorOperationalDetails(lane);
  const assessment = summaryStatusAssessment(summaryStatus);
  return (
    <section className="operational-overview" aria-labelledby="operational-overview-title">
      <p className="eyebrow" id="operational-overview-title">
        Operational overview
      </p>
      <div className="overview-grid">
        <OverviewFact label={details[0][0]} value={details[0][1]} />
        <OverviewFact label={details[1][0]} value={details[1][1]} />
        <OverviewFact
          label="Rarebit Summary status"
          value={assessment.label}
          detail={assessment.detail}
          wide
        />
        {details.slice(2).map(([label, value]) => (
          <OverviewFact key={label} label={label} value={value} />
        ))}
      </div>
    </section>
  );
}

function RarebitDiagnostics({
  detail,
  snapshotSummaryStatus,
}: {
  detail: RarebitSummaryDetail | null;
  snapshotSummaryStatus: Lane["session"]["rarebitSummaryStatus"];
}) {
  if (!detail)
    return (
      <>
        <p className="diagnostic-empty">
          Rarebit Summary provenance is loading; the lane snapshot lineage follows.
        </p>
        <dl>
          <RarebitSummaryStatusTrace summaryStatus={snapshotSummaryStatus} />
        </dl>
      </>
    );
  return (
    <dl>
      <RarebitSummaryStatusTrace summaryStatus={snapshotSummaryStatus} />
      <CopyablePair label="Materialization" value={detail.status ?? "unknown"} />
      {detail.jobId ? <CopyablePair label="Current summary job" value={detail.jobId} /> : null}
      {detail.observedAt ? (
        <CopyablePair label="Current summary observed" value={detail.observedAt} />
      ) : null}
      {detail.selection ? (
        <>
          <CopyablePair
            label="Coverage"
            value={`${detail.selection.occurrenceCount ?? "unknown"} selected / ${detail.selection.uniquePayloadCount ?? "unknown"} unique`}
          />
          {detail.selection.selectorVersion ? (
            <CopyablePair label="Selector version" value={detail.selection.selectorVersion} />
          ) : null}
          {detail.selection.manifestHash ? (
            <CopyablePair label="Selection manifest" value={detail.selection.manifestHash} />
          ) : null}
        </>
      ) : null}
      {detail.eligibility ? (
        <>
          <CopyablePair
            label="Eligibility"
            value={`${detail.eligibility.eligible ? "eligible" : "ineligible"}${detail.eligibility.forced ? " · forced" : ""}`}
          />
          {detail.eligibility.policyVersion ? (
            <CopyablePair label="Eligibility policy" value={detail.eligibility.policyVersion} />
          ) : null}
          {detail.eligibility.reasons.length ? (
            <CopyablePair
              label="Eligibility reasons"
              value={detail.eligibility.reasons.join(", ")}
            />
          ) : null}
        </>
      ) : null}
      {detail.provenance?.model ? (
        <CopyablePair
          label="Summary model"
          value={`${detail.provenance.model.provider}/${detail.provenance.model.id}`}
        />
      ) : null}
      {detail.provenance?.promptVersion ? (
        <CopyablePair label="Prompt version" value={detail.provenance.promptVersion} />
      ) : null}
      {detail.provenance?.implementationVersion ? (
        <CopyablePair
          label="Implementation version"
          value={detail.provenance.implementationVersion}
        />
      ) : null}
      {detail.provenance?.synthesis?.usage ? (
        <CopyablePair
          label="Synthesis usage"
          value={`${detail.provenance.synthesis.usage.availability ?? "unavailable"}${
            detail.provenance.synthesis.usage.totalTokens === null
              ? ""
              : ` · ${compact(detail.provenance.synthesis.usage.totalTokens)} tokens`
          }`}
        />
      ) : null}
    </dl>
  );
}

function DiagnosticsDisclosure({
  lane,
  summaryDetail,
}: {
  lane: SessionLane;
  summaryDetail: RarebitSummaryDetail | null;
}) {
  const details = inspectorDiagnosticDetails(lane);
  const process = primaryProcess(lane);
  const tmux = tmuxLocation(process);
  const model = lane.requests.at(-1)?.model ?? "Unknown";
  const snapshotJob = lane.session.rarebitSummaryStatus?.source.jobId;
  const detailJob = summaryDetail?.jobId;
  const jobMismatch = Boolean(snapshotJob && detailJob && snapshotJob !== detailJob);
  return (
    <details className="inspector-diagnostics">
      <summary tabIndex={0}>Native diagnostics &amp; provenance</summary>
      <div className="diagnostics-body">
        <section>
          <p className="eyebrow">Session and process identity</p>
          <dl>
            {details.map(([label, value]) => (
              <CopyablePair key={label} label={label} value={value} />
            ))}
            <CopyablePair label="Model" value={model} />
          </dl>
        </section>
        {process?.coordination ? (
          <section>
            <p className="eyebrow">Pi Team evidence</p>
            <dl>
              <CopyablePair label="Team" value={process.coordination.teamName} />
              <CopyablePair label="Agent" value={process.coordination.agentName} />
              <CopyablePair label="Role" value={process.coordination.role} />
              <CopyablePair label="Team source" value={process.coordination.source} />
            </dl>
            <InspectorTrafficAction teamName={process.coordination.teamName} />
          </section>
        ) : null}
        {tmux ? (
          <section>
            <p className="eyebrow">tmux location</p>
            <dl>
              <CopyablePair
                label="Pane"
                value={`${tmux.sessionName}:${tmux.windowIndex}${tmux.windowName ? `:${tmux.windowName}` : ""}.${tmux.paneId}`}
              />
              <CopyablePair label="Pane cwd" value={tmux.cwd} />
              <CopyablePair label="tmux socket" value={tmux.serverSocket} />
            </dl>
          </section>
        ) : null}
        <section>
          <p className="eyebrow">Rarebit Summary provenance</p>
          {jobMismatch ? (
            <p className="diagnostic-warning" role="status">
              Fleet snapshot job and fetched detail job differ. The owner view uses the fetched
              detail assessment; the lane still reflects its earlier snapshot.
            </p>
          ) : null}
          <RarebitDiagnostics
            detail={summaryDetail}
            snapshotSummaryStatus={lane.session.rarebitSummaryStatus}
          />
        </section>
      </div>
    </details>
  );
}

function Inspector({ lane, onClose }: { lane: SessionLane; onClose: () => void }) {
  const context = laneContextPresentation(lane);
  const summaryDetail = useRarebitSummaryDetail(lane.session.id);
  const inspectorSummaryStatus = summaryDetail?.summaryStatus ?? lane.session.rarebitSummaryStatus;
  return (
    <aside className="inspector">
      <button className="close" onClick={onClose} aria-label="Close inspector">
        ×
      </button>
      <p className="eyebrow">Session detail</p>
      <h2 className="inspector-context">{context.label}</h2>
      <dl className="session-identity">
        <CopyablePair label="Session ID" value={inspectorSessionIdentity(lane)} />
      </dl>
      {lane.session.links && (
        <nav className="session-links" aria-label="Session detail views">
          <a href={lane.session.links.live} target="_blank" rel="noreferrer">
            Open live
          </a>
          <a href={lane.session.links.tps} target="_blank" rel="noreferrer">
            Open TPS
          </a>
        </nav>
      )}
      <OperationalOverview lane={lane} summaryStatus={inspectorSummaryStatus} />
      <RarebitSummary detail={summaryDetail} summaryStatus={inspectorSummaryStatus} />
      <DiagnosticsDisclosure lane={lane} summaryDetail={summaryDetail} />
    </aside>
  );
}

function processLinkLabel(process: ProcessLane["process"]) {
  if (!process.link) return "No verified link";
  return process.link.grade === "provider_verified" ? "Provider-verified link" : "Heuristic link";
}

export function ProcessLaneRow({
  lane,
  selected,
  onSelect,
}: {
  lane: ProcessLane;
  selected: boolean;
  onSelect: () => void;
}) {
  const { process } = lane;
  const locations =
    process.locations.map((location) => location.provider).join(", ") || "OS observation";
  return (
    <div className={`lane process-lane ${selected ? "selected" : ""}`}>
      <div className="lane-label">
        <button
          className="lane-select"
          onClick={onSelect}
          aria-label={`Process ${process.pid}, running, work state unavailable`}
        >
          <strong>
            Running · PID {process.pid} · {processLinkLabel(process)}
          </strong>
          <small>
            {process.processStartedAt ?? process.observedAt} ·{" "}
            {process.cwd ?? "working directory unavailable"}
          </small>
          <small>
            {locations}
            {process.issues.length
              ? ` · ${process.issues.map((entry) => entry.message).join(", ")}`
              : ""}
          </small>
        </button>
      </div>
      <div
        className="lane-track"
        aria-label={`Process ${process.pid}; no Session markers`}
        onClick={onSelect}
      />
    </div>
  );
}

export function ProcessInspector({ lane, onClose }: { lane: ProcessLane; onClose: () => void }) {
  const { process } = lane;
  return (
    <aside className="inspector">
      <button className="close" onClick={onClose} aria-label="Close inspector">
        ×
      </button>
      <p className="eyebrow">Process observation</p>
      <h2 className="inspector-context">PID {process.pid}</h2>
      <p>Running OS process; work state is unavailable. This is not Session detail.</p>
      <dl className="session-identity">
        <CopyablePair label="Process instance" value={process.id} />
        <CopyablePair label="PID" value={process.pid} />
        <CopyablePair label="Started" value={process.processStartedAt ?? "Unknown"} />
        <CopyablePair label="Observed" value={process.observedAt} />
        <CopyablePair label="Working directory" value={process.cwd ?? "Unavailable"} />
        <CopyablePair label="Link" value={processLinkLabel(process)} />
        {process.link ? (
          <>
            <CopyablePair label="Associated Session" value={process.link.sessionId} />
            <CopyablePair label="Link method" value={process.link.method} />
            <CopyablePair label="Link observed" value={process.link.observedAt} />
            <CopyablePair label="Link provenance" value={process.link.provenance.join(", ")} />
          </>
        ) : null}
        <CopyablePair
          label="Locations"
          value={
            process.locations.map((location) => location.provider).join(", ") ||
            "No qualified location"
          }
        />
        <CopyablePair
          label="Coordination"
          value={
            process.coordination
              ? `${process.coordination.teamName} / ${process.coordination.agentName}`
              : "Unavailable"
          }
        />
        <CopyablePair
          label="Issues"
          value={process.issues.map((entry) => entry.message).join(", ") || "None observed"}
        />
      </dl>
    </aside>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(() =>
      forceDemo ? demoSnapshot() : null,
    ),
    [connection, setConnection] = useState<"live" | "demo" | "error">(forceDemo ? "demo" : "live");
  const [compatibilityError, setCompatibilityError] = useState<string | null>(null);
  const [windowMode, setWindowMode] = useState<SnapshotWindow>("24h"),
    [mountedAt] = useState(() => Date.now()),
    [customStart, setCustomStart] = useState(""),
    [customEnd, setCustomEnd] = useState(""),
    [olderPages, setOlderPages] = useState<Snapshot[]>([]),
    [loadingOlder, setLoadingOlder] = useState(false),
    [group, setGroup] = useState<GroupMode>("context"),
    [filterMode, setFilterMode] = useState<FilterMode>("all"),
    [filterValue, setFilterValue] = useState(""),
    [alive, setAlive] = useState(false),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState<string | null>(null),
    [diagnostics, setDiagnostics] = useState<Diagnostics>({
      fetches: 0,
      invalidations: 0,
      queuedRefreshes: 0,
    });
  const customStartMs = customStart ? Date.parse(customStart) : null;
  const customEndMs = customEnd ? Date.parse(customEnd) : null;
  const selection = useMemo(
    () => snapshotSelection(windowMode, customStartMs, customEndMs, mountedAt),
    [windowMode, customStartMs, customEndMs, mountedAt],
  );
  useEffect(() => {
    let active = true;
    let loading = false;
    let loadQueued = false;
    let refreshTimer: number | undefined;
    if (forceDemo) {
      return () => {
        active = false;
      };
    }
    const load = () => {
      if (loading) {
        loadQueued = true;
        if (diagnosticsEnabled) setDiagnostics(queuedRefreshDiagnostics);
        return;
      }
      loading = true;
      const fetchStartedAt = performance.now();
      fetch(`/api/snapshot?${selection.query}`)
        .then((r) => {
          if (!r.ok) throw Error();
          return r.text();
        })
        .then((body) => {
          const s = parseTimelineSnapshot(JSON.parse(body));
          if (active) {
            setSnapshot(s);
            setCompatibilityError(null);
            setOlderPages([]);
            setConnection("live");
            if (diagnosticsEnabled) setDiagnostics(fetchedDiagnostics(fetchStartedAt, body));
          }
        })
        .catch((error: unknown) => {
          if (active) {
            if (error instanceof SnapshotCompatibilityError) {
              setCompatibilityError(error.message);
              setConnection("error");
            } else {
              setSnapshot(demoSnapshot());
              setConnection("demo");
            }
          }
        })
        .finally(() => {
          loading = false;
          if (active && loadQueued) {
            loadQueued = false;
            load();
          }
        });
    };
    const scheduleLoad = () => {
      if (diagnosticsEnabled) setDiagnostics(invalidationDiagnostics);
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(load, 100);
    };
    load();
    let es: EventSource | undefined;
    try {
      es = new EventSource("/api/events");
      es.addEventListener("ready", scheduleLoad);
      es.addEventListener("invalidate", scheduleLoad);
      es.onerror = () => setConnection((c) => (c === "demo" ? "demo" : "error"));
    } catch {}
    return () => {
      active = false;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      es?.close();
    };
  }, [selection.query]);
  const mergedSnapshot = useMemo(
    () => (snapshot ? mergeSnapshotPages(snapshot, olderPages) : null),
    [snapshot, olderPages],
  );
  const all = useMemo(
    () => (mergedSnapshot ? lanesFromSnapshot(mergedSnapshot) : []),
    [mergedSnapshot],
  );
  const now = Date.parse(mergedSnapshot?.generatedAt ?? "1970-01-01T00:00:00.000Z");
  const rangeHours = windowHours(windowMode);
  const rangeStart = Number.isFinite(customStartMs)
    ? customStartMs
    : rangeHours
      ? now - rangeHours * 3_600_000
      : null;
  const rangeEnd = Number.isFinite(customEndMs) ? customEndMs : null;
  const filterOptions = useMemo(
    () =>
      filterMode === "all"
        ? []
        : [...new Set(all.map((lane) => filterKey(lane, filterMode)))].sort(),
    [all, filterMode],
  );
  const filtered = useMemo(
    () =>
      filterVisibleLanes({
        lanes: all,
        from: rangeStart,
        to: rangeEnd,
        alive,
        filterValue,
        filterMode,
        query,
      }),
    [all, alive, query, rangeStart, rangeEnd, filterMode, filterValue],
  );
  const domain = useMemo(
    () =>
      Number.isFinite(customStartMs) || Number.isFinite(customEndMs)
        ? ([
            Number.isFinite(customStartMs) ? customStartMs : extent(filtered, null, now)[0],
            Number.isFinite(customEndMs) ? customEndMs : now,
          ] as [number, number])
        : extent(filtered, rangeHours, now),
    [filtered, rangeHours, now, customStartMs, customEndMs],
  );
  const groups = useMemo(() => groupedLanes(filtered, group), [filtered, group]);
  const selectedLane = all.find((lane) => laneSelectionKey(lane) === selected);
  const rarebitCount = filtered.reduce(
    (total, lane) => total + (lane.kind === "session" ? lane.rarebits.length : 0),
    0,
  );
  const loadOlder = async () => {
    const cursor = olderPages.at(-1)?.page?.nextCursor ?? snapshot?.page?.nextCursor;
    if (selection.window !== "all" || loadingOlder || !cursor) return;
    setLoadingOlder(true);
    try {
      const params = new URLSearchParams({ window: "all", before: cursor });
      addTimeParameter(params, "from", finiteTime(customStartMs));
      addTimeParameter(params, "to", finiteTime(customEndMs));
      const response = await fetch(`/api/snapshot?${params.toString()}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const page = parseTimelineSnapshot(await response.json());
      setOlderPages((pages) => [...pages, page]);
      setCompatibilityError(null);
    } catch (error) {
      if (error instanceof SnapshotCompatibilityError) setCompatibilityError(error.message);
      else setConnection("error");
    } finally {
      setLoadingOlder(false);
    }
  };
  const hasOlder =
    selection.window === "all" &&
    Boolean(olderPages.at(-1)?.page?.hasOlder ?? snapshot?.page?.hasOlder);
  return (
    <TrafficProvider enabled={!forceDemo}>
      <main id="main-content">
        <header>
          <div>
            <p className="kicker">Local agent observatory</p>
            <h1>Pi session timeline</h1>
          </div>
          <div className="headline-metrics">
            <span>
              <b>
                {
                  filtered.filter((lane) => lane.kind === "process" || Boolean(lane.primaryProcess))
                    .length
                }
              </b>{" "}
              live
            </span>
            {snapshot && !compatibilityError ? (
              <span>{countLabel(rarebitCount, "Rarebit")}</span>
            ) : null}
          </div>
          <div className={`connection ${connection}`} aria-live="polite">
            <i aria-hidden="true" />
            {connectionLabel(connection)}
          </div>
        </header>
        <Toolbar
          {...{
            window: windowMode,
            setWindow: setWindowMode,
            group,
            setGroup,
            filterMode,
            setFilterMode,
            filterValue,
            setFilterValue,
            filterOptions,
            alive,
            setAlive,
            query,
            setQuery,
            customStart,
            setCustomStart,
            customEnd,
            setCustomEnd,
          }}
        />
        {compatibilityError ? (
          <section className="compatibility-error" role="alert">
            <strong>Timeline backend/frontend mismatch</strong>
            <span>{compatibilityError}</span>
          </section>
        ) : null}
        <DiagnosticsPanel
          enabled={diagnosticsEnabled}
          snapshot={mergedSnapshot}
          laneCount={all.length}
          diagnostics={diagnostics}
        />
        <TrafficLaunch
          snapshot={snapshot}
          filtered={filtered.filter((lane): lane is SessionLane => lane.kind === "session")}
          onShowAll={() => {
            setWindowMode("all");
            setCustomStart("");
            setCustomEnd("");
          }}
        />
        <div className="workspace">
          <div className="ledger">
            <div className="ruler-row">
              <div className="label-heading">
                <span>Sessions</span>
                <small>{filtered.length} visible</small>
              </div>
              <Ruler domain={domain} />
            </div>
            {!snapshot ? (
              <div className="empty">
                <div className="skeleton" />
                <div className="skeleton" />
                <p>Indexing local Pi sessions…</p>
              </div>
            ) : groups.length === 0 ? (
              <div className="empty">
                <h2>No matching sessions</h2>
                <p>Adjust the filters to return sessions to the wall-clock view.</p>
                <button
                  onClick={() => {
                    setAlive(false);
                    setQuery("");
                    setFilterValue("");
                  }}
                >
                  Clear filters
                </button>
              </div>
            ) : (
              groups.map(([key, value]) => (
                <section className="group" key={key}>
                  <div className="group-head">
                    <strong>{value.label}</strong>
                    <span>
                      {countLabel(value.lanes.length, "lane")} ·{" "}
                      {
                        value.lanes.filter(
                          (lane) => lane.kind === "process" || Boolean(lane.primaryProcess),
                        ).length
                      }{" "}
                      live ·{" "}
                      {countLabel(
                        value.lanes.reduce(
                          (total, lane) =>
                            total + (lane.kind === "session" ? lane.rarebits.length : 0),
                          0,
                        ),
                        "Rarebit",
                      )}
                    </span>
                  </div>
                  {value.lanes.map((lane) =>
                    lane.kind === "session" ? (
                      <LaneRow
                        key={laneSelectionKey(lane)}
                        lane={lane}
                        visibleLanes={filtered.filter(
                          (item): item is SessionLane => item.kind === "session",
                        )}
                        domain={domain}
                        selected={selected === laneSelectionKey(lane)}
                        onSelect={() => setSelected(laneSelectionKey(lane))}
                      />
                    ) : (
                      <ProcessLaneRow
                        key={laneSelectionKey(lane)}
                        lane={lane}
                        selected={selected === laneSelectionKey(lane)}
                        onSelect={() => setSelected(laneSelectionKey(lane))}
                      />
                    ),
                  )}
                </section>
              ))
            )}

            {hasOlder && (
              <div className="load-older">
                <button onClick={() => void loadOlder()} disabled={loadingOlder}>
                  {loadingOlder ? "Loading older Sessions…" : "Load older Sessions"}
                </button>
              </div>
            )}
          </div>
          {selectedLane?.kind === "session" && (
            <Inspector lane={selectedLane} onClose={() => setSelected(null)} />
          )}
          {selectedLane?.kind === "process" && (
            <ProcessInspector lane={selectedLane} onClose={() => setSelected(null)} />
          )}
        </div>
        <footer>
          <span>User + response outcomes · Rarebit evidence remains separate · metadata only</span>
          <span>
            {snapshot
              ? `Catalogued ${snapshot.trace.catalogSessions ?? snapshot.trace.sessionFiles} files; materialized ${snapshot.trace.responseSessions ?? snapshot.sessions.length} in ${snapshot.trace.durationMs.toFixed(1)}ms`
              : ""}
          </span>
        </footer>
      </main>
    </TrafficProvider>
  );
}
