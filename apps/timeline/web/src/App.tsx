import { useEffect, useMemo, useState } from "react";
import {
  compact,
  duration,
  extent,
  filterKey,
  filterLanesByBoundedTime,
  groupKey,
  inspectorDetails,
  laneAlias,
  lanesFromSnapshot,
  money,
  position,
  sessionMatchesQuery,
  stateClass,
  stateLabel,
} from "./model";
import { demoSnapshot } from "./demo";
import type { ColorMode, Density, FilterMode, GroupMode, Lane, Snapshot } from "./types";

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
  density,
  setDensity,
  color,
  setColor,
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
  density: Density;
  setDensity: (v: Density) => void;
  color: ColorMode;
  setColor: (v: ColorMode) => void;
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
      <label>
        Detail
        <select value={density} onChange={(e) => setDensity(e.target.value as Density)}>
          <option value="summary">Summary</option>
          <option value="turns">Turns</option>
          <option value="requests">Requests</option>
        </select>
      </label>
      <label>
        Color
        <select value={color} onChange={(e) => setColor(e.target.value as ColorMode)}>
          <option value="cost">Spend</option>
          <option value="tokens">Tokens</option>
          <option value="state">State</option>
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
  density,
  color,
  selected,
  onSelect,
  heatMax,
  now,
}: {
  lane: Lane;
  domain: [number, number];
  density: Density;
  color: ColorMode;
  selected: boolean;
  onSelect: () => void;
  heatMax: number;
  now: number;
}) {
  const total = lane.session.cost;
  const liveState = lane.live?.state ?? "settled";
  const alias = laneAlias(lane);
  const height = density === "summary" ? 34 : density === "turns" ? 48 : 64;
  const stateFill: Record<string, string> = {
    thinking: "#0891b2",
    tool: "#7c3aed",
    waiting_input: "#d97706",
    blocked: "#dc2626",
    failed: "#dc2626",
    idle: "#a1a1aa",
    settled: "#52525b",
    unknown: "#a1a1aa",
  };
  return (
    <div className={`lane ${selected ? "selected" : ""}`} style={{ height }}>
      <button
        className="lane-label"
        onClick={onSelect}
        aria-label={`${alias}, session ${lane.live?.sessionId ?? lane.session.id}, ${stateLabel[liveState]}, ${lane.session.turnCount} turns, ${money(total)}`}
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
          <b>{lane.session.turnCount}</b> turns · <b>{money(total)}</b>
        </span>
      </button>
      <div
        className="track timeline-cell"
        role="list"
        aria-label={`Turns for ${lane.session.name ?? lane.session.id}`}
        onClick={onSelect}
      >
        {density === "summary" ? (
          <span
            className={`lifeline ${lane.live ? "live" : ""}`}
            style={{
              left: `${position(lane.start, domain)}%`,
              width: `${Math.max(0.2, position(lane.live ? now : lane.end, domain) - position(lane.start, domain))}%`,
            }}
          />
        ) : (
          lane.turns.map((turn, index) => {
            const start = Date.parse(turn.startedAt),
              end = Date.parse(turn.endedAt ?? turn.startedAt);
            const intensity =
              color === "cost"
                ? turn.cost / heatMax
                : color === "tokens"
                  ? turn.totalTokens / heatMax
                  : 0.55;
            const turnLabel = `Turn ${index + 1} · ${timeFmt.format(start)}–${timeFmt.format(end)} · ${duration(end - start)} · ${money(turn.cost)} · ${compact(turn.totalTokens)} tokens`;
            return (
              <span
                key={turn.id}
                role="listitem"
                tabIndex={0}
                className={`turn ${turn.confidence === "inferred" ? "inferred" : ""} ${turn.cost === 0 && color === "cost" ? "zero" : ""}`}
                aria-label={turnLabel}
                title={turnLabel}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect();
                  }
                }}
                style={
                  {
                    left: `${position(start, domain)}%`,
                    width: `${Math.max(0.25, position(end, domain) - position(start, domain))}%`,
                    "--heat": String(color === "state" ? 1 : 0.15 + 0.85 * intensity),
                    "--fill": color === "state" ? stateFill[liveState] : "#6d28d9",
                  } as React.CSSProperties
                }
              >
                {density === "requests" &&
                  (lane.requestsByTurn.get(turn.id) ?? []).map((r, k, all) => (
                    <i key={r.id} style={{ left: `${(k / all.length) * 100}%` }} />
                  ))}
              </span>
            );
          })
        )}
        {lane.live && (
          <span
            className={`live-cap ${stateClass[liveState]}`}
            style={{ left: `${position(now, domain)}%` }}
          />
        )}
      </div>
    </div>
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
    [density, setDensity] = useState<Density>("turns"),
    [color, setColor] = useState<ColorMode>("cost"),
    [alive, setAlive] = useState(false),
    [query, setQuery] = useState(""),
    [customStart, setCustomStart] = useState(""),
    [customEnd, setCustomEnd] = useState(""),
    [selected, setSelected] = useState<string | null>(null);
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
        return;
      }
      loading = true;
      fetch("/api/snapshot")
        .then((r) => {
          if (!r.ok) throw Error();
          return r.json();
        })
        .then((s) => {
          if (active) {
            setSnapshot(s);
            setConnection("live");
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
  const heatMax = useMemo(() => {
    const values = filtered.flatMap((lane) =>
      lane.turns.map((turn) => (color === "tokens" ? turn.totalTokens : turn.cost)),
    );
    return Math.max(...values, color === "tokens" ? 1 : 0.01);
  }, [filtered, color]);
  const selectedLane = all.find((l) => l.session.id === selected);
  const totals = filtered.reduce(
    (a, l) => ({
      cost: a.cost + l.session.cost,
      tokens: a.tokens + l.session.totalTokens,
      turns: a.turns + l.session.turnCount,
    }),
    { cost: 0, tokens: 0, turns: 0 },
  );
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
            <b>{totals.turns}</b> turns
          </span>
          <span>
            <b>{money(totals.cost)}</b> spend
          </span>
          <span>
            <b>{compact(totals.tokens)}</b> tokens
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
          density,
          setDensity,
          color,
          setColor,
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
      <div className="workspace">
        <div className="ledger">
          <div className="ruler-row">
            <div className="label-heading">
              <span>Sessions</span>
              <small>{filtered.length} visible</small>
            </div>
            <Ruler domain={domain} />
          </div>
          {density !== "summary" && color !== "state" && (
            <div
              className="heat-legend"
              aria-label={`${color === "cost" ? "Spend" : "Token"} heat scale`}
            >
              <span>Lower</span>
              <i aria-hidden="true" />
              <span>Higher</span>
              <b>
                shared visible max{" "}
                {color === "cost" ? money(heatMax) : `${compact(heatMax)} tokens`}
              </b>
            </div>
          )}
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
                    {money(lanes.reduce((s, l) => s + l.session.cost, 0))}
                  </span>
                </div>
                {lanes.map((l) => (
                  <LaneRow
                    key={l.session.id}
                    lane={l}
                    domain={domain}
                    density={density}
                    color={color}
                    selected={selected === l.session.id}
                    onSelect={() => setSelected(l.session.id)}
                    heatMax={heatMax}
                    now={now}
                  />
                ))}
              </section>
            ))
          )}
        </div>
        {selectedLane && <Inspector lane={selectedLane} onClose={() => setSelected(null)} />}
      </div>
      <footer>
        <span>All-entry totals · metadata only</span>
        <span>
          {snapshot
            ? `Indexed ${snapshot.trace.sessionFiles} files in ${snapshot.trace.durationMs.toFixed(1)}ms`
            : ""}
        </span>
      </footer>
    </main>
  );
}
