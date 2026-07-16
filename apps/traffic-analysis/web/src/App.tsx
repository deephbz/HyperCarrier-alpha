import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { fixtureInspector, matrixFixture, ordinalFixture } from "./fixture";
import { CompressedTimeMap, globalGaps } from "./timeMap";
import analysisFixtureRaw from "../../fixtures/analysis-envelope.json";
import { field, rowsOf, type AnalysisEnvelope, type Aggregate } from "./types";
import { WallClockPlot, type RendererName } from "./plot/WallClockPlot";
import {
  formatUtc,
  isMatrixProjection,
  isOrdinalDisclosureProjection,
  isOrdinalProjection,
  type MatrixMark,
  type OrdinalDisclosureWireProjection,
  type OrdinalWireProjection,
  type MatrixWireInspector,
  type MatrixWireProjection,
} from "./matrixTypes";

type Selection = { snapshotId: string; eventRef: string };
const renderers: Array<{ value: RendererName; label: string }> = [
  { value: "echarts", label: "ECharts Canvas" },
  { value: "plotly", label: "Plotly.js" },
];
const initialRenderer = (): RendererName => {
  if (typeof window === "undefined") return "echarts";
  const value = new URLSearchParams(window.location.search).get("renderer");
  return renderers.some((renderer) => renderer.value === value)
    ? (value as RendererName)
    : "echarts";
};
type FetchError = {
  code?: string;
  reason?: "analysis_rotated_or_process_restarted";
  message?: string;
};
const safeError = (value: unknown): FetchError => {
  if (!value || typeof value !== "object") return {};
  const body = value as FetchError & { error?: FetchError };
  return body.error ?? body;
};

type OrdinalBinding = Pick<
  MatrixWireProjection["snapshot"],
  "analysisId" | "preparedDerivationId"
>;

export const isBoundOrdinalProjection = (
  value: unknown,
  binding: OrdinalBinding,
): value is OrdinalWireProjection =>
  isOrdinalProjection(value) &&
  value.snapshot.analysisId === binding.analysisId &&
  value.snapshot.preparedDerivationId === binding.preparedDerivationId;

const secondaryEnvelope = (value: unknown): AnalysisEnvelope | null => {
  if (!value || typeof value !== "object") return null;
  const wire = value as {
    schemaVersion?: unknown;
    report?: Record<string, unknown>;
    aggregates?: Array<Record<string, unknown>>;
    rows?: Array<Record<string, unknown>>;
  };
  if (
    wire.schemaVersion !== "traffic-secondary-v1" ||
    !wire.report ||
    !wire.aggregates ||
    !wire.rows
  )
    return null;
  const coverage = wire.report.coverage as Record<string, unknown> | undefined;
  return {
    report: {
      ...wire.report,
      coverage: {
        ...coverage,
        start_ms: coverage?.startMs ?? null,
        end_ms: coverage?.endMs ?? null,
      },
    },
    aggregates: wire.aggregates.map((aggregate) => ({
      ...aggregate,
      aggregate_id: aggregate.aggregateId,
    })),
    rows: wire.rows.map((row) =>
      row.kind === "cumulative_usage_point"
        ? {
            ...row,
            row_type: row.kind,
            row_id: row.ref,
            agent_id: row.agentRef,
            at_ms: row.atMs,
            cumulative_input_tokens: row.cumulativeInputTokens,
            cumulative_estimated_cost_usd: row.cumulativeEstimatedCostUsd,
          }
        : {
            ...row,
            row_type: row.kind,
            row_id: row.ref,
            start_ms: row.startMs,
            end_ms: row.endMs,
            distinct_active_agents: row.distinctActiveAgents,
          },
    ),
  } as unknown as AnalysisEnvelope;
};
const utcInputValue = (ms: number) => new Date(ms).toISOString().slice(0, 16);
export const compactUtc = (ms: number | null | undefined) => {
  if (ms == null) return "Unavailable";
  const date = new Date(ms);
  const padded = (value: number) => String(value).padStart(2, "0");
  const month = new Intl.DateTimeFormat("en", {
    month: "short",
    timeZone: "UTC",
  }).format(date);
  return `${padded(date.getUTCDate())} ${month} ${padded(date.getUTCHours())}:${padded(date.getUTCMinutes())}`;
};
const formatElapsed = (startMs: number | null, endMs: number | null) => {
  if (startMs == null || endMs == null) return "Unavailable";
  let seconds = Math.max(0, Math.floor((endMs - startMs) / 1_000));
  const hours = Math.floor(seconds / 3_600);
  seconds %= 3_600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  return `${hours}h ${minutes}m ${seconds}s`;
};
const utcInputMs = (value: string) => Date.parse(`${value}:00Z`);
const MATRIX_ROW_BUDGET = "5000";
const projectionQuery = (window?: { startMs: number; endMs: number }) =>
  new URLSearchParams({
    ...(window
      ? { startMs: String(window.startMs), endMs: String(window.endMs) }
      : {}),
    detail: "marks",
    rowBudget: MATRIX_ROW_BUDGET,
  });

type OrdinalSelection = {
  snapshotId: string;
  disclosureRef: string;
  label: string;
};
const ordinalGlyph = (
  display: OrdinalWireProjection["rows"][number]["cells"][number]["display"],
) => {
  switch (display.kind) {
    case "user_request":
    case "user_alert":
      return "■";
    case "agent_continuation":
      return "○";
    case "agent_stop":
      return "●";
    case "agent_truncated":
    case "agent_response_unavailable":
      return "⊗";
    case "tool_observation":
      return "┃";
    default:
      return "–";
  }
};

/** Fixed-height virtual rows keep the sequence bounded while preserving exactly one Agent grid column per Agent. */
function OrdinalGrid({
  ordinal,
  onSelect,
}: {
  ordinal: OrdinalWireProjection | null;
  onSelect: (selection: OrdinalSelection) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const rows = ordinal?.rows ?? [];
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 42,
    overscan: 8,
  });
  if (!ordinal)
    return <p className="muted">Open this section to load ordinal evidence.</p>;
  const columns = ordinal.columns;
  const gridStyle = {
    gridTemplateColumns: `repeat(${columns.length}, minmax(150px, 1fr))`,
  };
  return (
    <>
      <p className="muted">
        {ordinal.ordering.basis}; equal timestamps:{" "}
        {ordinal.ordering.equalTimestamp}; adjacency is not duration or
        causality.
      </p>
      <p
        className="ordinal-scroll-affordance"
        aria-label={`Scroll sideways to view all ${columns.length} Agents`}
      >
        ↔ Scroll sideways to view all {columns.length} Agents.
      </p>
      <div
        className="ordinal-grid"
        ref={parentRef}
        role="grid"
        aria-label="Ordinal evidence grid"
      >
        <div className="ordinal-header" role="row" style={gridStyle}>
          {columns.map((column) => (
            <strong key={column.agentRef} role="columnheader">
              {column.label}
            </strong>
          ))}
        </div>
        <div
          style={{ height: virtualizer.getTotalSize(), position: "relative" }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index]!;
            const cell = row.cells[0];
            return (
              <div
                className="ordinal-row"
                data-ordinal-row={row.globalOrdinal}
                key={virtualRow.key}
                role="row"
                style={{
                  ...gridStyle,
                  height: virtualRow.size,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {columns.map((column) => {
                  const owner =
                    cell?.ownerAgentRef === column.agentRef ? cell : null;
                  return (
                    <div
                      className="ordinal-agent-cell"
                      key={column.agentRef}
                      role="gridcell"
                    >
                      {owner && (
                        <button
                          type="button"
                          onClick={() =>
                            onSelect({
                              snapshotId: ordinal.snapshot.id,
                              disclosureRef: owner.disclosureRef,
                              label: owner.label,
                            })
                          }
                        >
                          <span
                            className={`ordinal-marker ordinal-${owner.display.kind}`}
                            aria-hidden="true"
                          >
                            {ordinalGlyph(owner.display)}
                          </span>{" "}
                          {owner.label} · G#{owner.globalOrdinal}
                          {owner.agentLocalOrdinal != null
                            ? ` · L#${owner.agentLocalOrdinal}`
                            : ""}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function OrdinalDisclosurePanel({
  selection,
  detail,
  status,
}: {
  selection: OrdinalSelection | null;
  detail: OrdinalDisclosureWireProjection | null;
  status: string;
}) {
  return (
    <aside className="inspector ordinal-inspector" aria-live="polite">
      <h3>Ordinal disclosure</h3>
      {!selection ? (
        <p>Select an owning ordinal cell to request its safe disclosure.</p>
      ) : status ? (
        <p>{status}</p>
      ) : !detail ? (
        <p aria-busy="true">Loading selected disclosure…</p>
      ) : (
        <>
          <h4>{selection.label}</h4>
          <blockquote className="semantic-quote">
            <p>
              {detail.disclosure?.approvedExcerpt?.text ??
                "No approved excerpt"}
            </p>
          </blockquote>
          <p className="muted">
            {detail.disclosure?.compactSummary.toolCount ?? 0} tools ·{" "}
            {compact(detail.disclosure?.compactSummary.totalTokens)} tokens ·{" "}
            {compact(detail.disclosure?.compactSummary.estimatedCostUsd)}{" "}
            dollars ·{" "}
            {detail.disclosure?.compactSummary.outcome ?? "outcome unavailable"}
          </p>
          <details>
            <summary>Safe source / request metadata</summary>
            <code>
              {detail.disclosure?.sourceRef.sourceId} ·{" "}
              {detail.disclosure?.sourceRef.turnId}
            </code>
            {detail.disclosure?.requests.map((request) => (
              <p key={request.sourceRef.requestId}>
                {request.provider ?? "provider unavailable"} ·{" "}
                {request.model ?? "model unavailable"} · request{" "}
                {request.sourceRef.requestId} ·{" "}
                {request.content
                  .map((part) => `${part.type}:${part.retention}`)
                  .join(", ")}{" "}
                ·{" "}
                {request.toolEvents
                  .map((event) => `${event.kind}:${event.status}`)
                  .join(", ") || "no tool metadata"}
              </p>
            ))}
          </details>
        </>
      )}
    </aside>
  );
}

const compact = (value: number | null | undefined) =>
  value == null
    ? "—"
    : value.toLocaleString(undefined, { maximumFractionDigits: 3 });
const humanize = (value: string) =>
  value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
function AggregateTable({
  title,
  rows,
  agentLabels,
}: {
  title: string;
  rows: Aggregate[];
  agentLabels: ReadonlyMap<string, string>;
}) {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row.measures)))];
  return (
    <section className="stat-table">
      <h3>{title}</h3>
      <p className="muted">
        {rows[0]?.semantics ?? "Backend-prepared aggregate rows."}
      </p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Grain</th>
              {keys.map((key) => (
                <th key={key}>{humanize(key)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.aggregate_id}>
                <th>
                  {Object.values(row.dimensions)
                    .filter(Boolean)
                    .map(
                      (value) =>
                        agentLabels.get(String(value)) ?? String(value),
                    )
                    .join(" · ") || "Team"}
                </th>
                {keys.map((key) => (
                  <td key={key}>{compact(row.measures[key])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
function PreparedStepOverlay({
  rows,
  toDisplay,
}: {
  rows: ReturnType<typeof rowsOf>;
  toDisplay: (ms: number) => number;
}) {
  const points = rows
    .map((row) => ({
      at: field<number>(row, "at_ms"),
      value: field<number>(row, "cumulative_input_tokens"),
    }))
    .filter(
      (point): point is { at: number; value: number } =>
        point.at != null && point.value != null,
    );
  if (!points.length)
    return <p className="muted">No backend-prepared cumulative points.</p>;
  const start = Math.min(...points.map((point) => point.at));
  const end = Math.max(...points.map((point) => point.at));
  const max = Math.max(...points.map((point) => point.value), 1);
  const path = points
    .map((point, index) => {
      const x =
        20 +
        ((toDisplay(point.at) - toDisplay(start)) /
          Math.max(1, toDisplay(end) - toDisplay(start))) *
          560;
      const y = 130 - (point.value / max) * 110;
      return `${index ? "L" : "M"}${x} ${y}`;
    })
    .join(" ");
  return (
    <svg
      className="prepared-overlay"
      viewBox="0 0 600 150"
      role="img"
      aria-label="Backend-prepared cumulative input token step overlay"
    >
      <path d={path} fill="none" stroke="#75b7ff" strokeWidth="3" />
      <text x="20" y="146">
        response-recorded cumulative steps
      </text>
    </svg>
  );
}

function ActiveIntervalOverlay({
  rows,
  toDisplay,
}: {
  rows: ReturnType<typeof rowsOf>;
  toDisplay: (ms: number) => number;
}) {
  const intervals = rows
    .map((row) => ({
      start: field<number>(row, "start_ms"),
      end: field<number>(row, "end_ms"),
      count: field<number>(row, "distinct_active_agents"),
    }))
    .filter(
      (row): row is { start: number; end: number; count: number } =>
        row.start != null && row.end != null && row.count != null,
    );
  if (!intervals.length)
    return <p className="muted">No backend-prepared active-agent intervals.</p>;
  const start = Math.min(...intervals.map((row) => row.start));
  const end = Math.max(...intervals.map((row) => row.end));
  return (
    <svg
      className="prepared-overlay"
      viewBox="0 0 600 110"
      role="img"
      aria-label="Qualified active-agent interval view"
    >
      {intervals.map((row, index) => (
        <rect
          key={`${row.start}:${index}`}
          x={
            20 +
            ((toDisplay(row.start) - toDisplay(start)) /
              Math.max(1, toDisplay(end) - toDisplay(start))) *
              560
          }
          y={80 - Math.min(row.count, 6) * 10}
          width={Math.max(
            2,
            ((toDisplay(row.end) - toDisplay(row.start)) /
              Math.max(1, toDisplay(end) - toDisplay(start))) *
              560,
          )}
          height={Math.min(row.count, 6) * 10}
          fill="#cb9aff"
          opacity=".75"
        />
      ))}
      <text x="20" y="103">
        qualified observed request/response intervals; not runtime or
        utilization
      </text>
    </svg>
  );
}

function SecondaryEvidence({
  data,
  agentLabels,
}: {
  data: AnalysisEnvelope | null;
  agentLabels: ReadonlyMap<string, string>;
}) {
  if (!data)
    return (
      <p className="muted">
        Secondary evidence is unavailable for this source.
      </p>
    );
  const points = rowsOf(data, "cumulative_usage_point");
  const active = rowsOf(data, "active_agent_interval");
  const gaps = globalGaps(rowsOf(data, "global_quiet_gap"));
  const map = new CompressedTimeMap(
    data.report.coverage.start_ms ?? 0,
    data.report.coverage.end_ms ?? 1,
    0,
    1000,
    gaps,
  );
  const toDisplay = (ms: number) => map.toY(ms);
  return (
    <>
      <AggregateTable
        title="Exact usage"
        rows={data.aggregates.filter((row) => row.kind === "usage_aggregate")}
        agentLabels={agentLabels}
      />
      <AggregateTable
        title="Tool activity"
        rows={data.aggregates.filter((row) => row.kind === "tool_activity")}
        agentLabels={agentLabels}
      />
      <AggregateTable
        title="Event inventory"
        rows={data.aggregates.filter((row) => row.kind === "event_inventory")}
        agentLabels={agentLabels}
      />
      <section>
        <h3>Cumulative input tokens</h3>
        <p className="muted">
          Backend-prepared response-recorded cumulative steps.
        </p>
        <PreparedStepOverlay rows={points} toDisplay={toDisplay} />
        <p className="muted">
          Static estimates are not billed truth; individual points are not
          enumerated here.
        </p>
      </section>
      <section>
        <h3>Cumulative estimated dollars</h3>
        <p className="muted">
          Shown beside the same backend-prepared cumulative steps; static
          estimates are not billed truth.
        </p>
      </section>
      <section>
        <h3>Concurrency rail</h3>
        <p className="muted">
          Agents with an active recorded request/response interval; not
          utilization, progress, or tool runtime.
        </p>
        <ActiveIntervalOverlay rows={active} toDisplay={toDisplay} />
      </section>
    </>
  );
}

function Inspector({
  inspector,
  selection,
  status,
}: {
  inspector: MatrixWireInspector | null;
  selection: Selection | null;
  status: string;
}) {
  if (status)
    return (
      <aside className="inspector" aria-live="polite">
        <h2>Selected event</h2>
        <p>{status}</p>
      </aside>
    );
  if (!selection)
    return (
      <aside className="inspector">
        <h2>Selected event</h2>
        <p>Select a matrix mark to inspect evidence.</p>
      </aside>
    );
  if (!inspector)
    return (
      <aside className="inspector" aria-busy="true">
        <h2>Selected event</h2>
        <p>Loading selected event…</p>
      </aside>
    );
  return (
    <aside className="inspector">
      <h2>{inspector.label}</h2>
      <dl>
        <dt>Time</dt>
        <dd>
          {formatUtc(inspector.startMs)}
          {inspector.endMs && ` → ${formatUtc(inspector.endMs)}`}
        </dd>
        <dt>Evidence</dt>
        <dd>
          {inspector.evidence.class} · {inspector.evidence.basis}
        </dd>
        <dt>Qualification</dt>
        <dd>{inspector.qualification ?? inspector.precision}</dd>
        <dt>Source tokens</dt>
        <dd>{inspector.provenanceRefs.join(", ") || "Unavailable"}</dd>
      </dl>
      <p className="muted">
        Priority and intervention are unassessed. Tool spans are not runtime;
        request intervals do not prove progress.
      </p>
    </aside>
  );
}

export function App({
  initialProjection,
  initialSource = typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("source") === "fixture"
    ? "fixture"
    : "live",
}: {
  initialProjection?: MatrixWireProjection;
  initialSource?: "live" | "fixture";
}) {
  const [projection, setProjection] = useState<MatrixWireProjection>(
    () => initialProjection ?? matrixFixture,
  );
  const [renderer, setRenderer] = useState<RendererName>(initialRenderer);
  const debug =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("debug") === "1";
  const [mobileAgentRef, setMobileAgentRef] = useState<string | null>(null);
  const [source, setSource] = useState(initialSource);
  const [scopeBase, setScopeBase] = useState<string | null>(null);
  const [scopeBootstrapFailed, setScopeBootstrapFailed] = useState(false);
  const [scopeDeclaration, setScopeDeclaration] = useState<string | null>(null);
  const [loadingSource, setLoadingSource] = useState(initialSource === "live");
  const [liveOrdinalBinding, setLiveOrdinalBinding] =
    useState<OrdinalBinding | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [inspector, setInspector] = useState<MatrixWireInspector | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [ordinalOpen, setOrdinalOpen] = useState(true);
  const [ordinal, setOrdinal] = useState<OrdinalWireProjection | null>(null);
  const [ordinalSelection, setOrdinalSelection] =
    useState<OrdinalSelection | null>(null);
  const [ordinalDisclosure, setOrdinalDisclosure] =
    useState<OrdinalDisclosureWireProjection | null>(null);
  const [ordinalDisclosureStatus, setOrdinalDisclosureStatus] = useState("");
  const [secondaryOpen, setSecondaryOpen] = useState(true);
  const [secondary, setSecondary] = useState<AnalysisEnvelope | null>(
    initialSource === "fixture"
      ? (analysisFixtureRaw as unknown as AnalysisEnvelope)
      : null,
  );
  const [requestedWindow, setRequestedWindow] = useState(
    projection.coverage.currentWindow,
  );
  // The last applied UTC window is independent of a draft in the datetime
  // inputs, and is what a live revision must retain.
  const requestedWindowRef = useRef(projection.coverage.currentWindow);
  const [narrow, setNarrow] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 800px)").matches,
  );
  const requestVersion = useRef(0);
  const liveProjectionReady = useRef(false);
  // SSE revisions are source invalidations, not commands to re-fetch the
  // snapshot that just emitted the same revision.
  const liveAnalysisId = useRef<string | null>(null);
  // A direct UTC gesture owns its in-flight matrix request. An SSE revision
  // during it must not supersede that request with a duplicate stale response.
  const pendingNavigation = useRef(false);
  const liveApi = scopeBase ?? "/api";
  const ordinalEndpoint = scopeBase
    ? `${scopeBase}/ordinal`
    : "/api/ordinal-evidence";
  const eventsEndpoint = scopeBase ? `${scopeBase}/events` : "/api/events";

  const load = async (
    window?: { startMs: number; endMs: number },
    snapshotId?: string,
  ) => {
    // Publish explicit navigation intent before starting I/O: an SSE revision
    // may arrive while this request is still in flight.
    if (window) requestedWindowRef.current = window;
    if (source === "fixture") {
      if (window) {
        // Fixture is a local projection, so common zoom/pan/reset must mutate its window without a fetch.
        setProjection((current) => ({
          ...current,
          coverage: { ...current.coverage, currentWindow: window },
        }));
        setRequestedWindow(window);
        requestedWindowRef.current = window;
      }
      return;
    }
    const requestId = ++requestVersion.current;
    const query = `?${projectionQuery(window)}${snapshotId ? `&snapshotId=${encodeURIComponent(snapshotId)}` : ""}`;
    const response = await fetch(`${liveApi}/matrix${query}`);
    const body = await response.json().catch(() => ({}));
    if (requestId === requestVersion.current) pendingNavigation.current = false;
    if (requestId !== requestVersion.current) return;
    if (!response.ok || !isMatrixProjection(body)) {
      setLoadingSource(false);
      setStatus(
        safeError(body).reason === "analysis_rotated_or_process_restarted"
          ? "The selected live snapshot is stale after analysis rotation or process restart; it is not retained."
          : "Matrix projection is unavailable.",
      );
      return;
    }
    setProjection(body);
    setRequestedWindow(body.coverage.currentWindow);
    requestedWindowRef.current = body.coverage.currentWindow;
    liveProjectionReady.current = true;
    liveAnalysisId.current = body.snapshot.analysisId;
    setLiveOrdinalBinding({
      analysisId: body.snapshot.analysisId,
      preparedDerivationId: body.snapshot.preparedDerivationId,
    });
    setLoadingSource(false);
    if (selection && selection.snapshotId !== body.snapshot.id) {
      setSelection(null);
      setInspector(null);
      setStatus("The selected event is stale or unavailable.");
    }
  };
  const deepSelection = () => {
    if (typeof window === "undefined") return null;
    const query = new URLSearchParams(window.location.search);
    const team = query.get("team");
    const agents = query.getAll("agent");
    if (team && agents.length === 0)
      return { kind: "team_trace", teamRef: team };
    if (!team && agents.length > 0)
      return { kind: "agents", agentRefs: agents };
    return null;
  };
  const requiresScope = deepSelection() !== null;
  useEffect(() => {
    const selection = deepSelection();
    if (!selection || source !== "live") return;
    let active = true;
    fetch("/api/traffic/scopes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection }),
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        const ref = body?.scope?.scopeRef;
        if (active && typeof ref === "string") {
          const sources = Array.isArray(body?.scope?.sources)
            ? body.scope.sources.length
            : 0;
          const diagnostics = Array.isArray(body?.scope?.diagnostics)
            ? body.scope.diagnostics.length
            : 0;
          if (sources === 0) {
            setScopeBootstrapFailed(true);
            setLoadingSource(false);
            const code =
              typeof body?.scope?.diagnostics?.[0]?.code === "string"
                ? body.scope.diagnostics[0].code
                : "agent_unavailable";
            setStatus(
              `${code}: Evidence scope unavailable; no readable explicitly selected sources.`,
            );
            return;
          }
          const limitation =
            body?.scope?.limitations?.membershipInterval === "unavailable"
              ? " Membership interval is unavailable; Session extent may exceed it."
              : "";
          setScopeDeclaration(
            `Resolved scope: ${sources} explicit Agent/Session sources; ${diagnostics} diagnostics.${limitation}`,
          );
          setScopeBase(`/api/traffic/scopes/${encodeURIComponent(ref)}`);
        } else if (active) {
          setScopeBootstrapFailed(true);
          setLoadingSource(false);
          setStatus(
            "Selected evidence scope could not be resolved; no projection was loaded.",
          );
        }
      })
      .catch(() => {
        if (!active) return;
        setScopeBootstrapFailed(true);
        setLoadingSource(false);
        setStatus(
          "Selected evidence scope could not be resolved; no projection was loaded.",
        );
      });
    return () => {
      active = false;
    };
  }, [source]);
  useEffect(() => {
    if (source === "live" && (!requiresScope || scopeBase)) void load();
  }, [source, scopeBase, scopeBootstrapFailed]);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 800px)");
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (
      !mobileAgentRef ||
      !projection.columns.some((column) => column.agentRef === mobileAgentRef)
    )
      setMobileAgentRef(projection.columns[0]?.agentRef ?? null);
  }, [mobileAgentRef, projection.columns]);
  useEffect(() => {
    if (source !== "live" || !ordinalOpen) {
      if (source !== "live") setOrdinal(ordinalFixture);
      return;
    }
    // The initial render carries a fixture placeholder; ordinal must bind to one live analysis/derivation.
    if (!liveOrdinalBinding) return;
    const binding = liveOrdinalBinding;
    let active = true;
    fetch(ordinalEndpoint)
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (active)
          setOrdinal(isBoundOrdinalProjection(body, binding) ? body : null);
      })
      .catch(() => active && setOrdinal(null));
    return () => {
      active = false;
    };
  }, [
    source,
    ordinalOpen,
    liveOrdinalBinding?.analysisId,
    liveOrdinalBinding?.preparedDerivationId,
  ]);
  useEffect(() => {
    if (source !== "live") {
      setSecondary(analysisFixtureRaw as unknown as AnalysisEnvelope);
      return;
    }
    if (!secondaryOpen) {
      setSecondary(null);
      return;
    }
    // The initial render carries a fixture placeholder; wait for its live snapshot.
    if (!liveProjectionReady.current) return;
    let active = true;
    fetch(
      `${liveApi}/secondary?snapshotId=${encodeURIComponent(projection.snapshot.id)}`,
    )
      .then((response) => (response.ok ? response.json() : null))
      // The backend's slim wire retains aggregate field names; this temporary
      // renderer adaptation only restores the existing aggregate/chart view.
      .then((body) => active && setSecondary(secondaryEnvelope(body)))
      .catch(() => active && setSecondary(null));
    return () => {
      active = false;
    };
  }, [
    source,
    secondaryOpen,
    projection.snapshot.id,
    liveOrdinalBinding?.analysisId,
    liveOrdinalBinding?.preparedDerivationId,
  ]);
  useEffect(() => {
    if (!ordinalSelection || source !== "live") return;
    let active = true;
    setOrdinalDisclosure(null);
    setOrdinalDisclosureStatus("");
    fetch(
      `${scopeBase ? `${scopeBase}/ordinal/disclosures` : "/api/ordinal-evidence/disclosures"}/${encodeURIComponent(ordinalSelection.disclosureRef)}?snapshotId=${encodeURIComponent(ordinalSelection.snapshotId)}`,
    )
      .then(async (response) => ({
        response,
        body: await response.json().catch(() => ({})),
      }))
      .then(({ response, body }) => {
        if (!active) return;
        if (!response.ok || !isOrdinalDisclosureProjection(body)) {
          setOrdinalDisclosureStatus(
            safeError(body).reason === "analysis_rotated_or_process_restarted"
              ? "The selected ordinal disclosure is stale after analysis rotation or process restart; it is not retained."
              : "The selected ordinal disclosure is unavailable.",
          );
          return;
        }
        setOrdinalDisclosure(body);
      })
      .catch(
        () =>
          active &&
          setOrdinalDisclosureStatus(
            "The selected ordinal disclosure is unavailable.",
          ),
      );
    return () => {
      active = false;
    };
  }, [ordinalSelection, source]);
  useEffect(() => {
    // A scoped EventSource must not briefly subscribe to the unscoped endpoint:
    // its initial revision can race the first scoped matrix and stale optional
    // projection requests.
    if (
      source !== "live" ||
      typeof EventSource === "undefined" ||
      (requiresScope && !scopeBase)
    )
      return;
    const events = new EventSource(eventsEndpoint);
    events.addEventListener("revision", (event) => {
      const revision = event instanceof MessageEvent ? event.data : null;
      if (
        liveProjectionReady.current &&
        !pendingNavigation.current &&
        (!revision || revision !== liveAnalysisId.current)
      )
        void load(requestedWindowRef.current);
    });
    return () => events.close();
  }, [eventsEndpoint, requiresScope, scopeBase, source]);
  useEffect(() => {
    if (!selection) return;
    setInspector(null);
    setStatus("");
    if (source === "fixture") {
      const mark = projection.marks.find(
        (item) => item.eventRef === selection.eventRef,
      );
      if (!mark) {
        setSelection(null);
        setStatus("The selected event is unavailable.");
        return;
      }
      const fixtureResult = fixtureInspector(
        selection.snapshotId,
        selection.eventRef,
      );
      if (!fixtureResult) {
        setSelection(null);
        setStatus("The selected fixture event is unavailable.");
        return;
      }
      setInspector(fixtureResult);
      return;
    }
    fetch(
      `${liveApi}/matrix/events/${encodeURIComponent(selection.eventRef)}?snapshotId=${encodeURIComponent(selection.snapshotId)}`,
    )
      .then(async (response) => ({
        response,
        body: await response.json().catch(() => ({})),
      }))
      .then(({ response, body }) => {
        if (!response.ok) {
          setSelection(null);
          setStatus(
            safeError(body).reason === "analysis_rotated_or_process_restarted"
              ? "The selected live event is stale after analysis rotation or process restart; it is not retained."
              : "The selected event is unavailable.",
          );
          return;
        }
        setInspector(body as MatrixWireInspector);
      })
      .catch(() => {
        setSelection(null);
        setStatus("The selected event is unavailable.");
      });
  }, [selection]);
  const select = (mark: MatrixMark) => {
    setStatus("");
    setSelection({
      snapshotId: projection.snapshot.id,
      eventRef: mark.eventRef,
    });
  };
  const switchSource = (next: "live" | "fixture") => {
    // Invalidate any in-flight live response before changing the provenance label.
    requestVersion.current += 1;
    setSelection(null);
    setInspector(null);
    setHover(null);
    setStatus("");
    setOrdinalSelection(null);
    setOrdinalDisclosure(null);
    setOrdinalDisclosureStatus("");
    setLiveOrdinalBinding(null);
    if (next === "fixture") {
      setLoadingSource(false);
      setProjection(matrixFixture);
      setRequestedWindow(matrixFixture.coverage.currentWindow);
      requestedWindowRef.current = matrixFixture.coverage.currentWindow;
      setSource("fixture");
      return;
    }
    liveProjectionReady.current = false;
    liveAnalysisId.current = null;
    setLoadingSource(true);
    setSource("live");
  };
  const changeWindow = (next: { startMs: number; endMs: number }) => {
    if (
      !Number.isFinite(next.startMs) ||
      !Number.isFinite(next.endMs) ||
      next.endMs < next.startMs
    )
      return;
    setSelection(null);
    setInspector(null);
    setStatus("Selection cleared while requesting the changed time window.");
    setRequestedWindow(next);
    requestedWindowRef.current = next;
    pendingNavigation.current = true;
    void load(next);
  };
  const hoveredMark = projection.marks.find((mark) => mark.eventRef === hover);
  const matrixReport = projection.snapshot.report;
  const leaderLabel =
    matrixReport.leaderSessionName ??
    matrixReport.leaderSessionId ??
    "Leader unavailable";
  const teamLabel = matrixReport.teamName ?? "Team unavailable";
  const reportStart = matrixReport.coverage.startMs;
  const reportEnd = matrixReport.coverage.endMs;
  const elapsedSpan = formatElapsed(reportStart, reportEnd);
  const inspectNext = projection.columns
    .filter((column) => column.inspectionCue.latestObservedEventRef)
    .sort(
      (a, b) =>
        (b.inspectionCue.latestObservedAtMs ?? 0) -
          (a.inspectionCue.latestObservedAtMs ?? 0) ||
        a.agentRef.localeCompare(b.agentRef),
    );

  const displayedProjection =
    narrow && mobileAgentRef
      ? {
          ...projection,
          columns: projection.columns.filter(
            (column) => column.agentRef === mobileAgentRef,
          ),
          marks: projection.marks.filter(
            (mark) => mark.agentRef === mobileAgentRef,
          ),
        }
      : projection;
  const changeRenderer = (next: RendererName) => {
    setRenderer(next);
    const url = new URL(window.location.href);
    url.searchParams.set("renderer", next);
    url.searchParams.delete("direction");
    window.history.replaceState({}, "", url);
  };

  if (requiresScope && scopeBootstrapFailed)
    return (
      <main>
        <header className="mast">
          <div>
            <p className="eyebrow">
              METADATA-ONLY / BACKEND PREPARED PROJECTION
            </p>
            <h1>Evidence scope unavailable</h1>
            <p role="alert">{status}</p>
          </div>
        </header>
      </main>
    );

  if (loadingSource)
    return (
      <main>
        <header className="mast">
          <div>
            <p className="eyebrow">
              METADATA-ONLY / BACKEND PREPARED PROJECTION
            </p>
            <h1>Agent-turns viz</h1>
            <p>Agent evidence matrix</p>
            {scopeDeclaration && <p>{scopeDeclaration}</p>}
            <p role="status">
              Loading selected live source; no prior projection is displayed.
            </p>
          </div>
          {debug && (
            <label>
              Source{" "}
              <select
                value={source}
                onChange={(event) =>
                  switchSource(event.target.value as "live" | "fixture")
                }
              >
                <option value="live">Live loopback API</option>
                <option value="fixture">Checked-in matrix fixture</option>
              </select>
            </label>
          )}
        </header>
      </main>
    );

  return (
    <main>
      <header className="mast">
        <div className="mast-identity">
          {scopeDeclaration && <p>{scopeDeclaration}</p>}
          {debug && (
            <p className="eyebrow">
              METADATA-ONLY / BACKEND PREPARED PROJECTION
            </p>
          )}
          <h1>Agent-turns viz</h1>
          <p className="mast-subtitle">Agent evidence matrix</p>
          <dl className="report-facts">
            <div>
              <dt>Team</dt>
              <dd>{teamLabel}</dd>
            </div>
            <div>
              <dt>Recorded UTC window</dt>
              <dd>
                {compactUtc(reportStart)} → {compactUtc(reportEnd)} UTC
              </dd>
            </div>
            <div>
              <dt>Elapsed span</dt>
              <dd>{elapsedSpan}</dd>
            </div>
            <div>
              <dt>Lead session</dt>
              <dd>{leaderLabel}</dd>
            </div>
          </dl>
          {debug && (
            <p className="provenance-line">
              {projection.coverage.freshness} ·{" "}
              <code>{projection.snapshot.id.slice(0, 12)}</code>
            </p>
          )}
        </div>
        <div className="mast-controls">
          <label>
            Renderer
            <select
              aria-label="Renderer"
              value={renderer}
              onChange={(event) =>
                changeRenderer(event.target.value as RendererName)
              }
            >
              {renderers.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          {debug && (
            <label>
              Source
              <select
                value={source}
                onChange={(event) =>
                  switchSource(event.target.value as "live" | "fixture")
                }
              >
                <option value="live">Live loopback API</option>
                <option value="fixture">Checked-in matrix fixture</option>
              </select>
            </label>
          )}
        </div>
      </header>
      <nav aria-label="Table of contents" className="section-nav">
        <a href="#wall-clock">Wall-clock plot</a>
        <a href="#aggregational-stats">Aggregational stats</a>
        <a href="#ordinal-events">Ordinal events</a>
      </nav>
      <section id="wall-clock" className="matrix-workspace">
        <h2>Wall-clock plot</h2>
        <div className="toolbar">
          <label>
            Start UTC
            <input
              aria-label="Window start UTC"
              type="datetime-local"
              value={utcInputValue(requestedWindow.startMs)}
              onChange={(event) =>
                setRequestedWindow((value) => ({
                  ...value,
                  startMs: utcInputMs(event.target.value),
                }))
              }
            />
          </label>
          <label>
            End UTC
            <input
              aria-label="Window end UTC"
              type="datetime-local"
              value={utcInputValue(requestedWindow.endMs)}
              onChange={(event) =>
                setRequestedWindow((value) => ({
                  ...value,
                  endMs: utcInputMs(event.target.value),
                }))
              }
            />
          </label>
          <button type="button" onClick={() => changeWindow(requestedWindow)}>
            Apply window
          </button>
          <span>
            {projection.columns.length} Agents
            {debug && (
              <>
                {" "}
                · {projection.marks.length} marks returned · request cap{" "}
                {projection.coverage.rowBudget} · detail:{" "}
                {projection.coverage.detail}
              </>
            )}
          </span>
        </div>
        <div className="inspect-cue" aria-label="Evidence candidates">
          <strong>Evidence candidates (not priority)</strong>
          {inspectNext.length ? (
            <ul>
              {inspectNext.map((column) => {
                const mark = projection.marks.find(
                  (item) =>
                    item.eventRef ===
                    column.inspectionCue.latestObservedEventRef,
                );
                return (
                  <li key={column.agentRef}>
                    <button
                      type="button"
                      disabled={!mark}
                      onClick={() => mark && select(mark)}
                    >
                      Inspect {column.header.label}:{" "}
                      {formatUtc(column.inspectionCue.latestObservedAtMs)}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p>
              No Agent has an observed mark in this window; priority and
              intervention remain unassessed.
            </p>
          )}
        </div>
        <div className="matrix-layout">
          <div className="plot-column">
            {debug && (
              <p className="muted plot-intro">
                Bounded, backend-prepared marks. The independently requested
                ordinal sequence is shown below.
              </p>
            )}
            <div className="mobile-agent-switcher" aria-label="Selected Agent">
              <span>Selected Agent</span>
              <div>
                {projection.columns.map((column) => (
                  <button
                    type="button"
                    key={column.agentRef}
                    aria-pressed={mobileAgentRef === column.agentRef}
                    onClick={() => setMobileAgentRef(column.agentRef)}
                  >
                    {column.header.label}
                  </button>
                ))}
              </div>
            </div>
            <WallClockPlot
              projection={displayedProjection}
              globalGapProjection={projection}
              renderer={renderer}
              selectedEventRef={selection?.eventRef ?? null}
              onHover={setHover}
              onSelect={(eventRef) => {
                const mark = projection.marks.find(
                  (item) => item.eventRef === eventRef,
                );
                if (mark) select(mark);
              }}
              onWindowChange={changeWindow}
            />
            <aside className="legend" aria-label="Evidence legend">
              <strong>Legend</strong>
              <ul>
                <li>
                  <i className="legend-swatch legend-request" />
                  Request
                </li>
                <li>
                  <i className="legend-swatch legend-continuation" />
                  Continuation
                </li>
                <li>
                  <i className="legend-swatch legend-stop" />
                  Stop
                </li>
                <li>
                  <i className="legend-swatch legend-alert" />
                  Alert
                </li>
                <li>
                  <i className="legend-swatch legend-unavailable" />
                  Unavailable
                </li>
                <li>
                  <i className="legend-swatch legend-request-interval" />
                  Request → response
                </li>
                <li>
                  <i className="legend-swatch legend-tool" />
                  Tool observation (not runtime)
                </li>
                <li>
                  <i className="legend-swatch legend-gap" />
                  Global quiet gap
                </li>
              </ul>
            </aside>
            {hoveredMark && (
              <p className="muted">
                Hover: {hoveredMark.label} ({formatUtc(hoveredMark.startMs)})
              </p>
            )}
          </div>
          <Inspector
            inspector={inspector}
            selection={selection}
            status={status}
          />
        </div>
      </section>
      <section id="aggregational-stats" className="secondary">
        <h2>Aggregational stats</h2>
        <details
          open={secondaryOpen}
          onToggle={(event) => setSecondaryOpen(event.currentTarget.open)}
        >
          <summary>Aggregate charts and tables</summary>
          <SecondaryEvidence
            data={secondary}
            agentLabels={
              new Map(
                displayedProjection.columns.map((column) => [
                  column.agentRef,
                  column.header.label,
                ]),
              )
            }
          />
        </details>
        <details className="provenance-details" open={debug}>
          <summary>Evidence provenance</summary>
          <p>
            Source/derivation identity:{" "}
            <code>{projection.snapshot.preparedDerivationId}</code> ·{" "}
            <code>{projection.snapshot.analysisId}</code>. Replay:{" "}
            {projection.snapshot.replay}. Inspector availability:{" "}
            {projection.snapshot.inspectorAvailability?.scope ?? "unspecified"}
            {projection.snapshot.inspectorAvailability?.staleReason
              ? `; stale after ${projection.snapshot.inspectorAvailability.staleReason.replaceAll("_", " ")}.`
              : "."}{" "}
            Raw record enumeration and unsupported runtime claims remain
            disclosed rather than inferred; the active-agent concurrency view
            above is a qualified observed-request projection.
          </p>
        </details>
      </section>
      <section id="ordinal-events">
        <h2>Ordinal events</h2>
        <details
          className="ordinal-disclosure-section"
          open={ordinalOpen}
          onToggle={(event) => setOrdinalOpen(event.currentTarget.open)}
        >
          <summary>Ordinal sequence</summary>
          <p className="muted">
            The ordered skeleton is shown while this section is open. Each row
            has exactly the Agent columns above; only its owning Agent cell is
            populated.
          </p>
          <OrdinalGrid ordinal={ordinal} onSelect={setOrdinalSelection} />
          <OrdinalDisclosurePanel
            selection={ordinalSelection}
            detail={ordinalDisclosure}
            status={ordinalDisclosureStatus}
          />
        </details>
      </section>
    </main>
  );
}
