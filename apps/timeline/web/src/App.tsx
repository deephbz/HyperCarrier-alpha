import { Fragment, useEffect, useMemo, useState } from "react";
import {
  compareIntelligentLanes,
  compact,
  countLabel,
  extent,
  filterKey,
  filterLanesByBoundedTime,
  groupKey,
  groupLabel,
  inspectorDetails,
  laneContextPresentation,
  laneDisplayLabel,
  lanesFromSnapshot,
  mergeSnapshotPages,
  position,
  runtimePresentation,
  sessionMatchesQuery,
  windowHours,
} from "./model";
import { demoSnapshot } from "./demo";
import { parseTimelineSnapshot, SnapshotCompatibilityError } from "./snapshot-contract";
import type { FilterMode, GroupMode, Lane, Snapshot, SnapshotWindow } from "./types";

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
      (!alive || Boolean(lane.live)) &&
      (!filterValue || filterKey(lane, filterMode) === filterValue) &&
      sessionMatchesQuery(lane.session, query),
  );
}

function groupedLanes(lanes: Lane[], mode: GroupMode) {
  if (!lanes.length) return [];
  if (mode === "context") {
    return [
      ["Intelligent", { label: "Intelligent", lanes: [...lanes].sort(compareIntelligentLanes) }],
    ] as const;
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
  lane: Lane;
  visibleLanes: Lane[];
  domain: [number, number];
  selected: boolean;
  onSelect: () => void;
}) {
  const runtime = runtimePresentation(lane);
  const context = laneContextPresentation(lane);
  const alias = laneDisplayLabel(lane, visibleLanes);
  const paths = laneMarkerPaths(lane, domain);
  const outcomeSummary = laneOutcomeSummary(lane);
  return (
    <div className={`lane ${selected ? "selected" : ""}`}>
      <div className="lane-label">
        <button
          className="lane-select"
          onClick={onSelect}
          aria-label={`${alias}, session ${lane.session.id}, context ${context.label}, ${runtime.label}, ${countLabel(lane.rarebits.length, "Rarebit")}`}
        >
          <span className={`state-dot ${runtime.className}`} aria-hidden="true" />
          <span className="lane-copy">
            <strong className="lane-context" aria-label={context.label} title={context.label}>
              {context.parts.length === 0 ? (
                <span className="lane-context-part lane-context-session">{context.label}</span>
              ) : (
                context.parts.map((part, index) => (
                  <Fragment key={`${part.coordinate}:${part.value}`}>
                    {index > 0 && (
                      <span className="lane-context-separator" aria-hidden="true">
                        {" | "}
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
            {runtime.label} · {countLabel(lane.rarebits.length, "Rarebit")}
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
  availability: "available" | "stale" | "missing" | "unavailable";
  reason?: string;
  status?: "ok" | "ineligible" | "unavailable_overflow" | "failure" | string;
  selection?: { occurrenceCount: number | null; uniquePayloadCount: number | null };
  eligibility?: {
    eligible: boolean;
    forced: boolean;
    reasons: string[];
    policyVersion: string | null;
  };
  provenance?: {
    model?: { provider: string; id: string } | null;
    implementationVersion?: string | null;
    promptVersion?: string | null;
    synthesis?: {
      usage?: { availability: string | null; totalTokens: number | null } | null;
    } | null;
  };
  summary?: string;
  failure?: { retryable: boolean; kind: string | null };
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

function RarebitSummary({ sessionId }: { sessionId: string }) {
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

  return (
    <section className="key-summary">
      <p className="eyebrow">Rarebit Summary</p>
      {!detail ? (
        <p>Loading derived sidecar…</p>
      ) : detail.availability === "missing" ? (
        <p>No materialized summary sidecar for this Session.</p>
      ) : (
        <>
          {detail.summary && <p className="derived-summary">{detail.summary}</p>}
          <p>
            {detail.availability === "stale"
              ? "Summary is stale against the latest recorded message."
              : detail.availability === "unavailable"
                ? "Summary sidecar is unavailable."
                : detail.status === "ineligible"
                  ? "Rarebits are materialized; synthesis did not meet the configured policy."
                  : "Derived summary is available."}
          </p>
          <dl>
            <CopyablePair label="Materialization" value={detail.status ?? "unknown"} />
            {detail.selection && (
              <CopyablePair
                label="Coverage"
                value={`${detail.selection.occurrenceCount ?? "unknown"} selected / ${detail.selection.uniquePayloadCount ?? "unknown"} unique`}
              />
            )}
            {detail.provenance?.model && (
              <CopyablePair
                label="Summary model"
                value={`${detail.provenance.model.provider}/${detail.provenance.model.id}`}
              />
            )}
            {detail.provenance?.synthesis?.usage && (
              <CopyablePair
                label="Usage"
                value={`${detail.provenance.synthesis.usage.availability ?? "unavailable"}${
                  detail.provenance.synthesis.usage.totalTokens === null
                    ? ""
                    : ` · ${compact(detail.provenance.synthesis.usage.totalTokens)} tokens`
                }`}
              />
            )}
          </dl>
          {detail.failure && (
            <p>
              {detail.failure.kind ?? "Summary"} failure
              {detail.failure.retryable ? "; retryable." : "."}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function Inspector({ lane, onClose }: { lane: Lane; onClose: () => void }) {
  const runtime = runtimePresentation(lane);
  const context = laneContextPresentation(lane);
  const details = inspectorDetails(lane);
  return (
    <aside className="inspector">
      <button className="close" onClick={onClose} aria-label="Close inspector">
        ×
      </button>
      <p className="eyebrow">Session detail</p>
      <h2>{laneDisplayLabel(lane, [lane])}</h2>
      <p className="inspector-context" aria-label="Session context">
        {context.label}
      </p>
      <p className="path">{lane.session.cwd}</p>
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
      <div className="status-line">
        <span className={`status-badge ${runtime.className}`}>
          <span className={`state-dot ${runtime.className}`} aria-hidden="true" />
          {runtime.label}
        </span>
        {lane.live?.activeTool ? <span>{lane.live.activeTool}</span> : null}
      </div>
      <RarebitSummary sessionId={lane.session.id} />
      <dl>
        {details.map(([label, value]) => (
          <CopyablePair key={label} label={label} value={value} />
        ))}
      </dl>
      {lane.live?.coordination && (
        <section>
          <p className="eyebrow">Pi Team</p>
          <p>
            {lane.live.coordination.teamName} · {lane.live.coordination.agentName} ·{" "}
            {lane.live.coordination.role}
          </p>
        </section>
      )}
      {lane.live?.pane && (
        <section>
          <p className="eyebrow">tmux location</p>
          <code>
            {lane.live.pane.sessionName}:{lane.live.pane.windowIndex}
            {lane.live.pane.windowName ? `:${lane.live.pane.windowName}` : ""}.
            {lane.live.pane.paneId}
          </code>
          <p className="path">{lane.live.pane.cwd}</p>
        </section>
      )}
      <section>
        <p className="eyebrow">Model</p>
        <p>{lane.live?.model ?? lane.requests.at(-1)?.model ?? "Unknown"}</p>
      </section>
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
  const selectedLane = all.find((l) => l.session.id === selected);
  const rarebitCount = filtered.reduce((total, lane) => total + lane.rarebits.length, 0);
  const loadOlder = async () => {
    if (selection.window !== "all" || loadingOlder) return;
    const cursor = olderPages.at(-1)?.page?.nextCursor ?? snapshot?.page?.nextCursor;
    if (!cursor) return;
    setLoadingOlder(true);
    try {
      const params = new URLSearchParams({ window: "all", before: cursor });
      if (Number.isFinite(customStartMs)) params.set("from", String(customStartMs));
      if (Number.isFinite(customEndMs)) params.set("to", String(customEndMs));
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
    <main id="main-content">
      <header>
        <div>
          <p className="kicker">Local agent observatory</p>
          <h1>Pi session timeline</h1>
        </div>
        <div className="headline-metrics">
          <span>
            <b>{filtered.filter((l) => l.live).length}</b> live
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
                    {countLabel(value.lanes.length, "session")} ·{" "}
                    {value.lanes.filter((l) => l.live).length} live ·{" "}
                    {countLabel(
                      value.lanes.reduce((total, lane) => total + lane.rarebits.length, 0),
                      "Rarebit",
                    )}
                  </span>
                </div>
                {value.lanes.map((l) => (
                  <LaneRow
                    key={l.session.id}
                    lane={l}
                    visibleLanes={filtered}
                    domain={domain}
                    selected={selected === l.session.id}
                    onSelect={() => setSelected(l.session.id)}
                  />
                ))}
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
        {selectedLane && <Inspector lane={selectedLane} onClose={() => setSelected(null)} />}
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
  );
}
