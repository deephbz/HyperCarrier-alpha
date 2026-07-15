import { useEffect, useMemo, useState } from "react";
import {
  compact,
  extent,
  filterKey,
  filterLanesByBoundedTime,
  groupKey,
  inspectorDetails,
  laneAlias,
  lanesFromSnapshot,
  position,
  sessionMatchesQuery,
  stateClass,
  stateLabel,
} from "./model";
import { demoSnapshot } from "./demo";
import type { FilterMode, GroupMode, Lane, Snapshot } from "./types";

const rangeOptions: [string, number | null][] = [
  ["1h", 1],
  ["6h", 6],
  ["24h", 24],
  ["All", null],
];
const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});
const forceDemo = new URLSearchParams(window.location.search).get("demo") === "1";
const diagnosticsEnabled = new URLSearchParams(window.location.search).get("diagnostics") === "1";

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

function Toolbar({
  range,
  setRange,
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
  range: number | null;
  setRange: (n: number | null) => void;
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
      <div className="segmented" aria-label="Time range">
        {rangeOptions.map(([label, value]) => (
          <button
            className={range === value ? "active" : ""}
            key={label}
            onClick={() => {
              setRange(value);
              setCustomStart("");
              setCustomEnd("");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <label className="time-input">
        From
        <input
          type="datetime-local"
          value={customStart}
          onChange={(e) => {
            setCustomStart(e.target.value);
            setRange(null);
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
      <label className="time-input">
        To
        <input
          type="datetime-local"
          value={customEnd}
          onChange={(e) => {
            setCustomEnd(e.target.value);
            setRange(null);
          }}
        />
      </label>
      <label>
        Group
        <select value={group} onChange={(e) => setGroup(e.target.value as GroupMode)}>
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
  const ticks = Array.from({ length: 7 }, (_, i) => domain[0] + ((domain[1] - domain[0]) * i) / 6);
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

function LaneRow({
  lane,
  domain,
  selected,
  onSelect,
}: {
  lane: Lane;
  domain: [number, number];
  selected: boolean;
  onSelect: () => void;
}) {
  const liveState = lane.live?.state ?? "settled";
  const alias = laneAlias(lane);
  return (
    <div className={`lane ${selected ? "selected" : ""}`}>
      <button
        className="lane-label"
        onClick={onSelect}
        aria-label={`${alias}, session ${lane.live?.sessionId ?? lane.session.id}, ${stateLabel[liveState]}, ${lane.keyMessages.length} key messages`}
      >
        <span className={`state-dot ${stateClass[liveState]}`} aria-hidden="true" />
        <span className="lane-copy">
          <strong>{alias}</strong>
          <small>
            {lane.live
              ? `PID ${lane.live.pid} · ${lane.live.sessionId ?? "session ID unavailable"}`
              : lane.session.id}
          </small>
        </span>
        <span className="lane-totals">
          <b>{lane.keyMessages.length}</b> key msgs
        </span>
      </button>
      <div
        className="track timeline-cell"
        role="list"
        aria-label={`Key messages for ${lane.session.name ?? lane.session.id}`}
        onClick={onSelect}
      >
        {lane.keyMessages.flatMap((marker) => {
          const at = marker.timestamp ? Date.parse(marker.timestamp) : Number.NaN;
          if (!Number.isFinite(at)) return [];
          const label = `${marker.outcome === "user" ? "User message" : marker.outcome === "stop" ? "Agent stop" : "Agent continuation"} · ${timeFmt.format(at)}`;
          return [
            <button
              key={`${marker.sourceEntryId ?? "entry"}:${marker.order}`}
              type="button"
              role="listitem"
              className={`key-marker key-marker-${marker.outcome}`}
              aria-label={label}
              title={label}
              onClick={(event) => {
                event.stopPropagation();
                onSelect();
              }}
              style={{ left: `${position(at, domain)}%` }}
            />,
          ];
        })}
      </div>
    </div>
  );
}

type KeyMessageSummaryDetail = {
  availability: "available" | "stale" | "missing" | "unavailable";
  reason?: string;
  status?: "ok" | "selection_only" | "unavailable_overflow" | "failure" | "conflict" | string;
  selection?: { occurrenceCount: number; uniquePayloadCount: number; asOf: string | null };
  provenance?: {
    model?: { provider: string; id: string } | null;
    derivationVersion?: string | null;
    synthesis?: {
      usage?: { availability: string | null; totalTokens: number | null } | null;
    } | null;
  };
  summary?: string;
  failure?: { retryable: boolean; kind: string | null };
};

function KeyMessageSummary({ sessionId }: { sessionId: string }) {
  const [loaded, setLoaded] = useState<{
    sessionId: string;
    detail: KeyMessageSummaryDetail;
  } | null>(null);
  const detail = loaded?.sessionId === sessionId ? loaded.detail : null;
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/key-message-summary`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as KeyMessageSummaryDetail;
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
      <p className="eyebrow">Key Message Summary</p>
      {!detail ? (
        <p>Loading derived sidecar…</p>
      ) : detail.availability === "missing" ? (
        <p>No materialized summary sidecar for this Session.</p>
      ) : (
        <>
          <p>
            {detail.availability === "stale"
              ? "Summary is stale against the latest recorded message."
              : detail.availability === "unavailable"
                ? "Summary sidecar is unavailable."
                : detail.status === "selection_only"
                  ? "Key Messages are materialized; synthesis was not required."
                  : "Derived summary is available."}
          </p>
          <dl>
            <div>
              <dt>Materialization</dt>
              <dd>{detail.status ?? "unknown"}</dd>
            </div>
            {detail.selection && (
              <div>
                <dt>Coverage</dt>
                <dd>
                  {detail.selection.occurrenceCount} selected /{" "}
                  {detail.selection.uniquePayloadCount} unique
                </dd>
              </div>
            )}
            {detail.provenance?.model && (
              <div>
                <dt>Summary model</dt>
                <dd>
                  {detail.provenance.model.provider}/{detail.provenance.model.id}
                </dd>
              </div>
            )}
            {detail.provenance?.synthesis?.usage && (
              <div>
                <dt>Usage</dt>
                <dd>
                  {detail.provenance.synthesis.usage.availability ?? "unavailable"}
                  {detail.provenance.synthesis.usage.totalTokens === null
                    ? ""
                    : ` · ${compact(detail.provenance.synthesis.usage.totalTokens)} tokens`}
                </dd>
              </div>
            )}
          </dl>
          {detail.failure && (
            <p>
              {detail.failure.kind ?? "Summary"} failure
              {detail.failure.retryable ? "; retryable." : "."}
            </p>
          )}
          {detail.summary && <p className="derived-summary">{detail.summary}</p>}
        </>
      )}
    </section>
  );
}

function Inspector({ lane, onClose }: { lane: Lane; onClose: () => void }) {
  const state = lane.live?.state ?? "settled";
  const details = inspectorDetails(lane);
  return (
    <aside className="inspector">
      <button className="close" onClick={onClose} aria-label="Close inspector">
        ×
      </button>
      <p className="eyebrow">Session detail</p>
      <h2>{laneAlias(lane)}</h2>
      <p className="path">{lane.session.cwd}</p>
      {lane.session.links && (
        <nav className="session-links" aria-label="Session detail views">
          <a href={lane.session.links.live} target="_blank" rel="noreferrer">
            Live session
          </a>
          <a href={lane.session.links.tps} target="_blank" rel="noreferrer">
            TPS inspector
          </a>
        </nav>
      )}
      <div className="status-line">
        <span className={`status-badge ${stateClass[state]}`}>
          <span className={`state-dot ${stateClass[state]}`} aria-hidden="true" />
          {stateLabel[state]}
        </span>
        {lane.live?.activeTool ? <span>{lane.live.activeTool}</span> : null}
      </div>
      <dl>
        {details.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
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
      <KeyMessageSummary sessionId={lane.session.id} />
    </aside>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(() =>
      forceDemo ? demoSnapshot() : null,
    ),
    [connection, setConnection] = useState<"live" | "demo" | "error">(forceDemo ? "demo" : "live");
  const [range, setRange] = useState<number | null>(24),
    [group, setGroup] = useState<GroupMode>("project"),
    [filterMode, setFilterMode] = useState<FilterMode>("all"),
    [filterValue, setFilterValue] = useState(""),
    [alive, setAlive] = useState(false),
    [query, setQuery] = useState(""),
    [customStart, setCustomStart] = useState(""),
    [customEnd, setCustomEnd] = useState(""),
    [selected, setSelected] = useState<string | null>(null),
    [diagnostics, setDiagnostics] = useState<Diagnostics>({
      fetches: 0,
      invalidations: 0,
      queuedRefreshes: 0,
    });
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
      fetch("/api/snapshot")
        .then((r) => {
          if (!r.ok) throw Error();
          return r.text();
        })
        .then((body) => {
          const s = JSON.parse(body) as Snapshot;
          if (active) {
            setSnapshot(s);
            setConnection("live");
            if (diagnosticsEnabled) setDiagnostics(fetchedDiagnostics(fetchStartedAt, body));
          }
        })
        .catch(() => {
          if (active) {
            setSnapshot(demoSnapshot());
            setConnection("demo");
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
  }, []);
  const all = useMemo(() => (snapshot ? lanesFromSnapshot(snapshot) : []), [snapshot]);
  const now = Date.parse(snapshot?.generatedAt ?? "1970-01-01T00:00:00.000Z");
  const customStartMs = customStart ? Date.parse(customStart) : null;
  const customEndMs = customEnd ? Date.parse(customEnd) : null;
  const rangeStart = range ? now - range * 3_600_000 : customStartMs;
  const rangeEnd = customEndMs;
  const filterOptions = useMemo(
    () =>
      filterMode === "all"
        ? []
        : [...new Set(all.map((lane) => filterKey(lane, filterMode)))].sort(),
    [all, filterMode],
  );
  const filtered = useMemo(
    () =>
      filterLanesByBoundedTime(all, rangeStart, rangeEnd).filter(
        (l) =>
          (!alive || !!l.live) &&
          (!filterValue || filterKey(l, filterMode) === filterValue) &&
          sessionMatchesQuery(l.session, query),
      ),
    [all, alive, query, rangeStart, rangeEnd, filterMode, filterValue],
  );
  const domain = useMemo(
    () =>
      customStartMs !== null || customEndMs !== null
        ? ([customStartMs ?? extent(filtered, null, now)[0], customEndMs ?? now] as [
            number,
            number,
          ])
        : extent(filtered, range, now),
    [filtered, range, customStartMs, customEndMs, now],
  );
  const groups = useMemo(() => {
    const m = new Map<string, Lane[]>();
    for (const lane of filtered) {
      const k = groupKey(lane, group);
      const groupLanes = m.get(k);
      if (groupLanes) groupLanes.push(lane);
      else m.set(k, [lane]);
    }
    return [...m.entries()];
  }, [filtered, group]);
  const selectedLane = all.find((l) => l.session.id === selected);
  const keyMessageCount = filtered.reduce((total, lane) => total + lane.keyMessages.length, 0);
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
          <span>
            <b>{keyMessageCount}</b> key msgs
          </span>
        </div>
        <div className={`connection ${connection}`} aria-live="polite">
          <i aria-hidden="true" />
          {connection === "live" ? "Live" : connection === "demo" ? "Demo data" : "Reconnecting"}
        </div>
      </header>
      <Toolbar
        {...{
          range,
          setRange,
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
      {diagnosticsEnabled && (
        <details className="diagnostics" open>
          <summary>Local diagnostics — safe to copy into a bug report</summary>
          <dl>
            <div>
              <dt>Snapshot</dt>
              <dd>
                {snapshot
                  ? `${snapshot.sessions.length} sessions · ${all.length} lanes`
                  : "loading"}
              </dd>
            </div>
            <div>
              <dt>Collector</dt>
              <dd>
                {snapshot
                  ? `${snapshot.trace.durationMs.toFixed(1)}ms · ${snapshot.trace.refresh?.reason ?? "unknown"}`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>JSONL cache</dt>
              <dd>
                {snapshot?.trace.sessionCache
                  ? `${compact(snapshot.trace.sessionCache.bytesRead)}B read · ${snapshot.trace.sessionCache.linesParsed} lines · ${snapshot.trace.sessionCache.appendCount} append / ${snapshot.trace.sessionCache.rebuildCount} rebuild`
                  : "not reported"}
              </dd>
            </div>
            <div>
              <dt>Browser</dt>
              <dd>
                {`${diagnostics.fetches} fetches · ${diagnostics.invalidations} invalidations · ${diagnostics.queuedRefreshes} queued · ${diagnostics.lastFetchMs?.toFixed(1) ?? "—"}ms · ${diagnostics.lastPayloadBytes === undefined ? "—" : `${compact(diagnostics.lastPayloadBytes)}B`}`}
              </dd>
            </div>
          </dl>
        </details>
      )}
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
            groups.map(([name, lanes]) => (
              <section className="group" key={name}>
                <div className="group-head">
                  <strong>{name}</strong>
                  <span>
                    {lanes.length} sessions · {lanes.filter((l) => l.live).length} live ·{" "}
                    {lanes.reduce((total, lane) => total + lane.keyMessages.length, 0)} key msgs
                  </span>
                </div>
                {lanes.map((l) => (
                  <LaneRow
                    key={l.session.id}
                    lane={l}
                    domain={domain}
                    selected={selected === l.session.id}
                    onSelect={() => setSelected(l.session.id)}
                  />
                ))}
              </section>
            ))
          )}
        </div>
        {selectedLane && <Inspector lane={selectedLane} onClose={() => setSelected(null)} />}
      </div>
      <footer>
        <span>Key Message markers · metadata only</span>
        <span>
          {snapshot
            ? `Indexed ${snapshot.trace.sessionFiles} files in ${snapshot.trace.durationMs.toFixed(1)}ms`
            : ""}
        </span>
      </footer>
    </main>
  );
}
