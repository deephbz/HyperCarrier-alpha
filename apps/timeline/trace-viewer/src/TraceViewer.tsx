import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  clampTraceRange,
  normalizeTraceQuery,
  reconcileTraceRange,
  recordMatchesNormalizedTraceQuery,
  recordWithinTraceRange,
  traceBounds,
  traceTransition,
  type TraceRange,
  type TraceTransition,
} from "./trajectory-projection";
import type { PiTrace, TraceLane, TraceRecord, TraceUnavailable } from "./types";

const MINIMUM_DRAG_PX = 3;
const MINIMUM_VIEWPORT_RECORDS = 4;
const INSPECTOR_MIN_WIDTH = 320;
const INSPECTOR_MAX_WIDTH = 720;
const OVERVIEW_HEIGHT = 126;
const LEDGER_ROW_HEIGHT = 62;
const FOLD_SUMMARY_HEIGHT = 32;
const VIRTUAL_OVERSCAN = 8;

const traceLanes = ["input", "model", "tools"] as const;
const lanePresentation: Record<TraceLane, { label: string; paint: string; top: number }> = {
  input: { label: "Input", paint: "#54a79d", top: 8 },
  model: { label: "Model", paint: "#7f8ed0", top: 49 },
  tools: { label: "Tools", paint: "#c9995d", top: 90 },
};

interface LedgerRecordItem {
  readonly height: typeof LEDGER_ROW_HEIGHT;
  readonly kind: "record";
  readonly record: TraceRecord;
  readonly top: number;
}

interface LedgerFoldItem {
  readonly height: typeof FOLD_SUMMARY_HEIGHT;
  readonly hiddenCount: number;
  readonly kind: "fold";
  readonly top: number;
  readonly turn: number;
}

type LedgerItem = LedgerRecordItem | LedgerFoldItem;

function sessionIdFromPathname(pathname: string) {
  const match = pathname.match(/^\/session\/([^/]+)$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function timestampLabel(value: TraceRecord["timestamp"]) {
  if (value === null) return "Time unavailable";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Time unavailable" : date.toLocaleString();
}

function recordSummary(record: TraceRecord) {
  const text = record.text.replaceAll(/\s+/g, " ").trim();
  return text || record.label;
}

function traceUrl(sessionId: string) {
  return `/api/trace/${encodeURIComponent(sessionId)}`;
}

function rangeLabel(range: TraceRange | null, end: number) {
  if (range === null) return `Active-branch order #1–#${end}`;
  return `Focus #${range.start + 1}–#${range.end}`;
}

function rangeAtClientX(clientX: number, rect: DOMRect, domain: TraceRange): number {
  const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
  return domain.start + fraction * (domain.end - domain.start);
}

function nearestRecord(records: readonly TraceRecord[], order: number) {
  return records.reduce<TraceRecord | null>((nearest, record) => {
    if (nearest === null || Math.abs(record.order - order) < Math.abs(nearest.order - order))
      return record;
    return nearest;
  }, null);
}

function turnRecordCounts(records: readonly TraceRecord[]) {
  const counts = new Map<number, number>();
  for (const record of records)
    if (record.turn !== null) counts.set(record.turn, (counts.get(record.turn) ?? 0) + 1);
  return counts;
}

function collapsibleCallRecordIds(records: readonly TraceRecord[]) {
  const callsWithResults = new Set(
    records.flatMap((record) =>
      typeof record.toolCallRecordId === "string" ? [record.toolCallRecordId] : [],
    ),
  );
  return records
    .filter((record) => callsWithResults.has(record.recordId))
    .map((record) => record.recordId);
}

function foldedLedgerRecords(
  records: readonly TraceRecord[],
  collapsedTurns: ReadonlySet<number>,
  collapsedCalls: ReadonlySet<string>,
) {
  const firstByTurn = new Map<number, string>();
  for (const record of records)
    if (record.turn !== null && !firstByTurn.has(record.turn))
      firstByTurn.set(record.turn, record.recordId);
  return records.filter((record) => {
    if (
      record.turn !== null &&
      collapsedTurns.has(record.turn) &&
      firstByTurn.get(record.turn) !== record.recordId
    )
      return false;
    return (
      typeof record.toolCallRecordId !== "string" || !collapsedCalls.has(record.toolCallRecordId)
    );
  });
}

function ledgerItems(
  records: readonly TraceRecord[],
  collapsedTurns: ReadonlySet<number>,
  collapsedCalls: ReadonlySet<string>,
) {
  const counts = turnRecordCounts(records);
  const shown = foldedLedgerRecords(records, collapsedTurns, collapsedCalls);
  const items: LedgerItem[] = [];
  let top = 0;
  for (const record of shown) {
    items.push({ kind: "record", record, top, height: LEDGER_ROW_HEIGHT });
    top += LEDGER_ROW_HEIGHT;
    if (record.turn !== null && collapsedTurns.has(record.turn) && counts.get(record.turn)! > 1) {
      items.push({
        kind: "fold",
        turn: record.turn,
        hiddenCount: counts.get(record.turn)! - 1,
        top,
        height: FOLD_SUMMARY_HEIGHT,
      });
      top += FOLD_SUMMARY_HEIGHT;
    }
  }
  return { items, height: top };
}

function virtualItems(items: readonly LedgerItem[], scrollTop: number, viewportHeight: number) {
  const lower = Math.max(0, scrollTop - VIRTUAL_OVERSCAN * LEDGER_ROW_HEIGHT);
  const upper = scrollTop + viewportHeight + VIRTUAL_OVERSCAN * LEDGER_ROW_HEIGHT;
  return items.filter((item) => item.top + item.height > lower && item.top < upper);
}

function ledgerClass(
  record: TraceRecord,
  selectedId: string | null,
  matches: boolean,
  range: TraceRange | null,
) {
  return [
    "ledger-row",
    record.lane,
    record.recordId === selectedId ? "selected" : "",
    record.rarebit ? "rarebit" : "",
    !matches ? "dimmed" : "",
    !recordWithinTraceRange(record, range) ? "outside-focus" : "",
    record.turn !== null && record.step === null ? "turn-start" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function Overview({
  records,
  fullBounds,
  selectedId,
  matchedRecords,
  range,
  onRangeChange,
  onSelect,
}: {
  records: readonly TraceRecord[];
  fullBounds: TraceRange | null;
  selectedId: string | null;
  matchedRecords: ReadonlySet<string> | null;
  range: TraceRange | null;
  onRangeChange: (range: TraceRange | null) => void;
  onSelect: (record: TraceRecord) => void;
}) {
  const scopedBounds = useMemo(() => traceBounds(records), [records]);
  const bounds = fullBounds ?? scopedBounds;
  const rootRef = useRef<HTMLElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ anchor: number; clientX: number; pointerId: number } | null>(null);
  const panRef = useRef<{ clientX: number; start: number; pointerId: number } | null>(null);
  const [draftRange, setDraftRange] = useState<TraceRange | null>(null);
  const [viewport, setViewport] = useState<TraceRange | null>(null);
  const [canvasWidth, setCanvasWidth] = useState(0);

  const domain =
    bounds === null ? null : viewport === null ? bounds : clampTraceRange(viewport, bounds);
  const activeRange = draftRange ?? range;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const measure = () => setCanvasWidth(canvas.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    const track = trackRef.current;
    if (root === null || track === null || bounds === null || domain === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = track.getBoundingClientRect();
      const anchor = rangeAtClientX(event.clientX, rect, domain);
      const fullDuration = bounds.end - bounds.start;
      const duration = domain.end - domain.start;
      const nextDuration = Math.min(
        fullDuration,
        Math.max(MINIMUM_VIEWPORT_RECORDS, duration * Math.exp(event.deltaY * 0.0015)),
      );
      if (nextDuration >= fullDuration * 0.999) {
        setViewport(null);
        return;
      }
      const fraction = (anchor - domain.start) / duration;
      setViewport(
        clampTraceRange(
          { start: anchor - fraction * nextDuration, end: anchor + (1 - fraction) * nextDuration },
          bounds,
        ),
      );
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [bounds, domain]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || domain === null || canvasWidth === 0) return;
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.ceil(canvasWidth * scale);
    canvas.height = Math.ceil(OVERVIEW_HEIGHT * scale);
    const context = canvas.getContext("2d");
    if (context === null) return;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, canvasWidth, OVERVIEW_HEIGHT);
    const columns = Math.max(1, Math.ceil(canvasWidth));
    const lanes = traceLanes;
    const buckets = lanes.map(() =>
      Array.from({ length: columns }, () => ({
        errors: 0,
        focused: 0,
        matches: 0,
        rarebits: 0,
        total: 0,
      })),
    );
    for (const record of records) {
      if (record.order < domain.start || record.order >= domain.end) continue;
      const lane = lanes.indexOf(record.lane);
      const column = Math.min(
        columns - 1,
        Math.max(
          0,
          Math.floor(((record.order - domain.start) / (domain.end - domain.start)) * columns),
        ),
      );
      const bucket = buckets[lane][column];
      bucket.total += 1;
      if (matchedRecords === null || matchedRecords.has(record.recordId)) bucket.matches += 1;
      if (recordWithinTraceRange(record, range)) bucket.focused += 1;
      if (record.rarebit) bucket.rarebits += 1;
      if (record.details.isError) bucket.errors += 1;
    }
    for (const [lane, laneBuckets] of lanes.map((name, index) => [name, buckets[index]] as const))
      for (const [column, bucket] of laneBuckets.entries()) {
        if (bucket.total === 0) continue;
        const density = Math.min(0.95, 0.3 + Math.log2(bucket.total + 1) * 0.16);
        const matchRatio = bucket.matches / bucket.total;
        const focusRatio = bucket.focused / bucket.total;
        context.globalAlpha =
          density * (matchRatio > 0 ? matchRatio : 0.18) * (0.45 + focusRatio * 0.55);
        context.fillStyle = bucket.errors > 0 ? "#d06470" : lanePresentation[lane].paint;
        context.fillRect(column, lanePresentation[lane].top, 1, 25);
        if (bucket.rarebits > 0) {
          context.globalAlpha = 1;
          context.fillStyle = "#f4d078";
          context.fillRect(column, lanePresentation[lane].top, 1, 2);
        }
      }
    const selected = records.find((record) => record.recordId === selectedId);
    if (selected && selected.order >= domain.start && selected.order < domain.end) {
      const column = ((selected.order - domain.start) / (domain.end - domain.start)) * columns;
      context.globalAlpha = 1;
      context.strokeStyle = "#eef8ff";
      context.lineWidth = 2;
      context.strokeRect(column, lanePresentation[selected.lane].top, 2, 25);
    }
    context.globalAlpha = 1;
  }, [canvasWidth, domain, matchedRecords, range, records, selectedId]);

  if (records.length === 0 || bounds === null || domain === null)
    return <section className="overview empty">No records in this scope.</section>;

  const selection = activeRange === null ? null : clampTraceRange(activeRange, bounds);
  const selectNearest = (order: number) => {
    const record = nearestRecord(records, order);
    if (record) onSelect(record);
  };

  const finishPointer = (clientX: number, pointerId: number, rect: DOMRect) => {
    const pan = panRef.current;
    if (pan?.pointerId === pointerId) {
      panRef.current = null;
      return;
    }
    const drag = dragRef.current;
    if (drag?.pointerId !== pointerId) return;
    dragRef.current = null;
    setDraftRange(null);
    const point = rangeAtClientX(clientX, rect, domain);
    if (Math.abs(clientX - drag.clientX) < MINIMUM_DRAG_PX) return selectNearest(point);
    onRangeChange(
      clampTraceRange(
        { start: Math.min(drag.anchor, point), end: Math.max(drag.anchor, point) },
        bounds,
      ),
    );
  };

  return (
    <section className="overview" ref={rootRef} aria-label="Trajectory overview">
      <div className="overview-labels" aria-hidden="true">
        {traceLanes.map((lane) => (
          <span key={lane}>{lanePresentation[lane].label}</span>
        ))}
      </div>
      <div className="overview-main">
        <div className="overview-caption">
          <span>{rangeLabel(range, bounds.end)}</span>
          <span>Dense full trace · wheel zoom · right-drag pan · drag to focus</span>
        </div>
        <div
          aria-label="Active-branch order overview. Use arrow keys to select a record. Drag to focus records."
          className="overview-track"
          onContextMenu={(event) => event.preventDefault()}
          onDoubleClick={() => {
            setViewport(null);
            onRangeChange(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setViewport(null);
              onRangeChange(null);
              return;
            }
            const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
            if (direction === 0) return;
            event.preventDefault();
            const current = records.findIndex((record) => record.recordId === selectedId);
            const next = records[Math.max(0, Math.min(records.length - 1, current + direction))];
            if (next) onSelect(next);
          }}
          onPointerCancel={() => {
            dragRef.current = null;
            panRef.current = null;
            setDraftRange(null);
          }}
          onPointerDown={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            if (event.button === 2) {
              panRef.current = {
                clientX: event.clientX,
                start: domain.start,
                pointerId: event.pointerId,
              };
            } else if (event.button === 0) {
              const anchor = rangeAtClientX(event.clientX, rect, domain);
              dragRef.current = { anchor, clientX: event.clientX, pointerId: event.pointerId };
              setDraftRange({ start: anchor, end: anchor });
            } else return;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const pan = panRef.current;
            if (pan?.pointerId === event.pointerId) {
              const duration = domain.end - domain.start;
              const delta = ((event.clientX - pan.clientX) / Math.max(1, rect.width)) * duration;
              setViewport(
                clampTraceRange(
                  { start: pan.start - delta, end: pan.start - delta + duration },
                  bounds,
                ),
              );
              return;
            }
            const drag = dragRef.current;
            if (drag?.pointerId !== event.pointerId) return;
            setDraftRange({ start: drag.anchor, end: rangeAtClientX(event.clientX, rect, domain) });
          }}
          onPointerUp={(event) =>
            finishPointer(
              event.clientX,
              event.pointerId,
              event.currentTarget.getBoundingClientRect(),
            )
          }
          ref={trackRef}
          tabIndex={0}
        >
          {selection !== null && (
            <div
              aria-hidden="true"
              className="overview-selection"
              style={{
                left: `${((selection.start - domain.start) / (domain.end - domain.start)) * 100}%`,
                width: `${((selection.end - selection.start) / (domain.end - domain.start)) * 100}%`,
              }}
            />
          )}
          <canvas aria-hidden="true" className="overview-canvas" ref={canvasRef} />
        </div>
      </div>
    </section>
  );
}

function RecordLedger({
  records,
  collapsedTurns,
  collapsedCalls,
  selectedId,
  matchedRecords,
  range,
  revision,
  transition,
  onSelect,
}: {
  records: readonly TraceRecord[];
  collapsedTurns: ReadonlySet<number>;
  collapsedCalls: ReadonlySet<string>;
  selectedId: string | null;
  matchedRecords: ReadonlySet<string> | null;
  range: TraceRange | null;
  revision: string;
  transition: TraceTransition;
  onSelect: (record: TraceRecord) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atTailRef = useRef(true);
  const previousSelectionRef = useRef<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(450);
  const model = useMemo(
    () => ledgerItems(records, collapsedTurns, collapsedCalls),
    [collapsedCalls, collapsedTurns, records],
  );
  const visible = useMemo(
    () => virtualItems(model.items, scrollTop, viewportHeight),
    [model.items, scrollTop, viewportHeight],
  );

  const scrollToRecord = useCallback(
    (recordId: string) => {
      const scroll = scrollRef.current;
      const item = model.items.find(
        (candidate): candidate is LedgerRecordItem =>
          candidate.kind === "record" && candidate.record.recordId === recordId,
      );
      if (scroll === null || item === undefined) return;
      const maximum = Math.max(0, model.height - scroll.clientHeight);
      scroll.scrollTop = Math.max(0, Math.min(maximum, item.top - scroll.clientHeight / 2));
    },
    [model.height, model.items],
  );

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (scroll === null) return;
    const measure = () => setViewportHeight(scroll.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (scroll === null) return;
    if (transition === "append" && atTailRef.current) scroll.scrollTop = model.height;
    if (transition === "reset" && selectedId) scrollToRecord(selectedId);
  }, [model.height, revision, scrollToRecord, selectedId, transition]);

  useLayoutEffect(() => {
    if (selectedId && previousSelectionRef.current !== selectedId) scrollToRecord(selectedId);
    previousSelectionRef.current = selectedId;
  }, [scrollToRecord, selectedId]);

  return (
    <section className="ledger" aria-label="Trace ledger">
      <div className="ledger-heading">
        <span>Order</span>
        <span>Event</span>
        <span>Time</span>
      </div>
      <div
        className="ledger-scroll"
        onScroll={(event) => {
          const target = event.currentTarget;
          setScrollTop(target.scrollTop);
          atTailRef.current =
            target.scrollHeight - target.clientHeight - target.scrollTop <= LEDGER_ROW_HEIGHT / 2;
        }}
        ref={scrollRef}
      >
        <div className="ledger-virtual-space" style={{ height: model.height }}>
          {visible.map((item) =>
            item.kind === "fold" ? (
              <p
                className="ledger-fold-summary ledger-virtual-item"
                key={`fold:${item.turn}:${item.top}`}
                style={{ height: item.height, top: item.top }}
              >
                Turn {item.turn} folded · {item.hiddenCount} records hidden
              </p>
            ) : (
              <button
                className={`${ledgerClass(
                  item.record,
                  selectedId,
                  matchedRecords === null || matchedRecords.has(item.record.recordId),
                  range,
                )} ledger-virtual-item`}
                data-record-id={item.record.recordId}
                key={item.record.recordId}
                onClick={() => onSelect(item.record)}
                style={{ height: item.height, top: item.top }}
                type="button"
              >
                <span className="record-number">#{item.record.order + 1}</span>
                <span className="record-main">
                  <span className="record-kind">
                    {item.record.label}
                    {item.record.turn !== null &&
                      ` · T${item.record.turn}${item.record.step === null ? "" : ` S${item.record.step}`}`}
                  </span>
                  <span className="record-text">{recordSummary(item.record)}</span>
                </span>
                <time>{timestampLabel(item.record.timestamp)}</time>
              </button>
            ),
          )}
        </div>
      </div>
    </section>
  );
}

function Inspector({
  record,
  inspectorWidth,
  onResizeBy,
  onResizeStart,
  onSelectLinkedRecord,
}: {
  record: TraceRecord | null;
  inspectorWidth: number;
  onResizeBy: (pixels: number) => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onSelectLinkedRecord: (id: string) => void;
}) {
  const [tab, setTab] = useState<"summary" | "content" | "raw" | "unavailable">("summary");
  if (record === null)
    return (
      <aside className="inspector empty">
        <h2>Inspector</h2>
        <p>Select a trace record.</p>
      </aside>
    );
  const tabs = ["summary", "content", "raw", "unavailable"] as const;
  return (
    <aside className="inspector" aria-label="Exact record inspector">
      <div
        aria-label="Resize inspector"
        aria-orientation="vertical"
        aria-valuemax={INSPECTOR_MAX_WIDTH}
        aria-valuemin={INSPECTOR_MIN_WIDTH}
        aria-valuenow={inspectorWidth}
        className="inspector-resize"
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") onResizeBy(16);
          if (event.key === "ArrowRight") onResizeBy(-16);
        }}
        onPointerDown={onResizeStart}
        role="separator"
        tabIndex={0}
      />
      <header>
        <div>
          <p className="eyebrow">Exact record</p>
          <h2>{record.label}</h2>
          <p className="muted">{record.sourceEntryId ?? "Source entry unavailable"}</p>
        </div>
      </header>
      <div className="inspector-tabs" role="tablist" aria-label="Record inspector tabs">
        {tabs.map((item) => (
          <button
            aria-selected={tab === item}
            className={tab === item ? "active" : ""}
            key={item}
            onClick={() => setTab(item)}
            role="tab"
            type="button"
          >
            {item}
          </button>
        ))}
      </div>
      {tab === "summary" && (
        <dl className="record-summary">
          <div>
            <dt>Source entry</dt>
            <dd>{record.sourceEntryId ?? "Unavailable"}</dd>
          </div>
          <div>
            <dt>Branch order</dt>
            <dd>{record.order + 1}</dd>
          </div>
          <div>
            <dt>Turn / step</dt>
            <dd>
              {record.turn ?? "Unavailable"} / {record.step ?? "Unavailable"}
            </dd>
          </div>
          <div>
            <dt>Rarebit</dt>
            <dd>{record.rarebit ? "Selected by the Rarebit semantic backend" : "Not selected"}</dd>
          </div>
          <div>
            <dt>Time</dt>
            <dd>{timestampLabel(record.timestamp)}</dd>
          </div>
          {record.details.stopReason && (
            <div>
              <dt>Stop reason</dt>
              <dd>{record.details.stopReason}</dd>
            </div>
          )}
          {record.details.provider && (
            <div>
              <dt>Provider</dt>
              <dd>{record.details.provider}</dd>
            </div>
          )}
          {record.details.model && (
            <div>
              <dt>Model</dt>
              <dd>{record.details.model}</dd>
            </div>
          )}
          {record.details.toolCallId && (
            <div>
              <dt>Tool call</dt>
              <dd>
                {record.toolCallRecordId ? (
                  <button
                    className="linked-record"
                    onClick={() => onSelectLinkedRecord(record.toolCallRecordId!)}
                    type="button"
                  >
                    {record.details.toolCallId}
                  </button>
                ) : (
                  `${record.details.toolCallId} (source call unavailable)`
                )}
              </dd>
            </div>
          )}
        </dl>
      )}
      {tab === "content" && (
        <pre className="record-content">{record.text || "No readable text content."}</pre>
      )}
      {tab === "raw" && <pre className="record-content">{JSON.stringify(record.raw, null, 2)}</pre>}
      {tab === "unavailable" && (
        <dl className="record-summary">
          {Object.entries(record.unavailable).map(([field, reason]) => (
            <div key={field}>
              <dt>{field}</dt>
              <dd>{reason}</dd>
            </div>
          ))}
        </dl>
      )}
    </aside>
  );
}

function traceWorkspaceStyle(inspectorWidth: number): CSSProperties {
  return { "--trace-inspector-width": `${inspectorWidth}px` } as CSSProperties;
}

export function TraceViewer() {
  const sessionId = sessionIdFromPathname(window.location.pathname);
  const [trace, setTrace] = useState<PiTrace | null>(null);
  const [problem, setProblem] = useState<TraceUnavailable | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [rarebitOnly, setRarebitOnly] = useState(false);
  const [range, setRange] = useState<TraceRange | null>(null);
  const [inspectorWidth, setInspectorWidth] = useState(500);
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(new Set());
  const [collapsedCalls, setCollapsedCalls] = useState<ReadonlySet<string>>(new Set());
  const [transition, setTransition] = useState<TraceTransition>("initial");
  const [overviewEpoch, setOverviewEpoch] = useState(0);
  const traceRef = useRef<PiTrace | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const rangeRef = useRef<TraceRange | null>(null);
  const collapsedTurnsRef = useRef<ReadonlySet<number>>(new Set());
  const collapsedCallsRef = useRef<ReadonlySet<string>>(new Set());
  const requestInFlight = useRef(false);
  const refetchRequested = useRef(false);

  const changeSelection = useCallback((next: string | null) => {
    selectedIdRef.current = next;
    setSelectedId(next);
  }, []);
  const changeRange = useCallback((next: TraceRange | null) => {
    rangeRef.current = next;
    setRange(next);
  }, []);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    if (requestInFlight.current) {
      refetchRequested.current = true;
      return;
    }
    requestInFlight.current = true;
    do {
      refetchRequested.current = false;
      try {
        const response = await fetch(traceUrl(sessionId), { cache: "no-store" });
        const body = (await response.json()) as PiTrace | TraceUnavailable;
        if (!response.ok || body.availability !== "available") {
          setProblem(body as TraceUnavailable);
          setTrace(null);
          traceRef.current = null;
          continue;
        }
        const nextTransition = traceTransition(traceRef.current?.records ?? null, body.records);
        const nextSelection = selectedIdRef.current;
        const retainedSelection =
          nextSelection && body.records.some((record) => record.recordId === nextSelection)
            ? nextSelection
            : (body.records.at(-1)?.recordId ?? null);
        const nextRange = reconcileTraceRange(rangeRef.current, body.records, nextTransition);
        const nextTurns = new Set(
          [...collapsedTurnsRef.current].filter((turn) =>
            body.records.some((record) => record.turn === turn),
          ),
        );
        const nextCalls = new Set(
          [...collapsedCallsRef.current].filter((id) =>
            body.records.some((record) => record.recordId === id),
          ),
        );
        traceRef.current = body;
        selectedIdRef.current = retainedSelection;
        rangeRef.current = nextRange;
        collapsedTurnsRef.current = nextTurns;
        collapsedCallsRef.current = nextCalls;
        setTransition(nextTransition);
        if (nextTransition === "reset") setOverviewEpoch((current) => current + 1);
        setTrace(body);
        setProblem(null);
        setSelectedId(retainedSelection);
        setRange(nextRange);
        setCollapsedTurns(nextTurns);
        setCollapsedCalls(nextCalls);
      } catch {
        setProblem({
          availability: "unavailable",
          reason: "trace_request_failed",
          message: "The exact trace could not be loaded.",
        });
        setTrace(null);
        traceRef.current = null;
      }
    } while (refetchRequested.current);
    requestInFlight.current = false;
  }, [sessionId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);
  useEffect(() => {
    if (!sessionId) return;
    const events = new EventSource(`/api/events/${encodeURIComponent(sessionId)}`);
    events.addEventListener("invalidate", () => {
      void refresh();
    });
    return () => events.close();
  }, [refresh, sessionId]);

  const activeBounds = useMemo(() => traceBounds(trace?.records ?? []), [trace?.records]);
  const scopedRecords = useMemo(
    () =>
      rarebitOnly
        ? (trace?.records ?? []).filter((record) => record.rarebit)
        : (trace?.records ?? []),
    [rarebitOnly, trace?.records],
  );
  const normalizedQuery = useMemo(() => normalizeTraceQuery(query), [query]);
  const matchedRecords = useMemo(
    () =>
      normalizedQuery === ""
        ? null
        : new Set(
            scopedRecords
              .filter((record) => recordMatchesNormalizedTraceQuery(record, normalizedQuery))
              .map((record) => record.recordId),
          ),
    [normalizedQuery, scopedRecords],
  );
  const selected = scopedRecords.find((record) => record.recordId === selectedId) ?? null;
  const collapsibleTurns = useMemo(
    () =>
      [...turnRecordCounts(scopedRecords)].filter(([, count]) => count > 1).map(([turn]) => turn),
    [scopedRecords],
  );
  const collapsibleCalls = useMemo(() => collapsibleCallRecordIds(scopedRecords), [scopedRecords]);
  const allTurnsCollapsed =
    collapsibleTurns.length > 0 && collapsibleTurns.every((turn) => collapsedTurns.has(turn));
  const allCallsCollapsed =
    collapsibleCalls.length > 0 && collapsibleCalls.every((call) => collapsedCalls.has(call));
  const applyFolds = useCallback(
    (nextTurns: ReadonlySet<number>, nextCalls: ReadonlySet<string>) => {
      collapsedTurnsRef.current = nextTurns;
      collapsedCallsRef.current = nextCalls;
      setCollapsedTurns(nextTurns);
      setCollapsedCalls(nextCalls);
      if (
        selectedIdRef.current &&
        !foldedLedgerRecords(scopedRecords, nextTurns, nextCalls).some(
          (record) => record.recordId === selectedIdRef.current,
        )
      )
        changeSelection(null);
    },
    [changeSelection, scopedRecords],
  );
  const selectRecord = useCallback(
    (record: TraceRecord) => changeSelection(record.recordId),
    [changeSelection],
  );
  const resizeInspector = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const startX = event.clientX;
      const startWidth = inspectorWidth;
      const move = (next: PointerEvent) => {
        setInspectorWidth(
          Math.min(
            INSPECTOR_MAX_WIDTH,
            Math.max(INSPECTOR_MIN_WIDTH, startWidth + startX - next.clientX),
          ),
        );
      };
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop, { once: true });
    },
    [inspectorWidth],
  );

  if (!sessionId)
    return <main className="trace-error">This route requires an exact Session ID.</main>;
  if (problem)
    return (
      <main className="trace-error">
        <h1>Trace unavailable</h1>
        <p>{problem.message}</p>
        <code>{problem.reason}</code>
        <a className="raw-download" href={`/raw/${encodeURIComponent(sessionId)}`}>
          Download raw JSONL
        </a>
      </main>
    );

  return (
    <main className="trace-viewer">
      <header className="trace-toolbar">
        <div>
          <p className="eyebrow">Pi active branch</p>
          <h1>Trace viewer</h1>
          <p className="session-id">{sessionId}</p>
        </div>
        <div className="trace-actions" role="toolbar" aria-label="Trace controls">
          <label className="search">
            <span>Search trace</span>
            <input
              onChange={(event) => setQuery(event.currentTarget.value)}
              type="search"
              value={query}
            />
          </label>
          <label className="filter">
            <input
              checked={rarebitOnly}
              onChange={(event) => {
                const next = event.currentTarget.checked;
                setRarebitOnly(next);
                if (
                  next &&
                  selectedIdRef.current &&
                  !trace?.records.find((record) => record.recordId === selectedIdRef.current)
                    ?.rarebit
                )
                  changeSelection(null);
              }}
              type="checkbox"
            />{" "}
            Rarebits only
          </label>
          <button
            className="range-reset"
            disabled={range === null}
            onClick={() => changeRange(null)}
            type="button"
          >
            Reset focus
          </button>
          <button
            className="range-reset"
            disabled={collapsibleTurns.length === 0}
            onClick={() =>
              applyFolds(
                allTurnsCollapsed ? new Set<number>() : new Set(collapsibleTurns),
                collapsedCalls,
              )
            }
            type="button"
          >
            {allTurnsCollapsed ? "Expand turns" : "Collapse turns"}
          </button>
          <button
            className="range-reset"
            disabled={collapsibleCalls.length === 0}
            onClick={() =>
              applyFolds(
                collapsedTurns,
                allCallsCollapsed ? new Set<string>() : new Set(collapsibleCalls),
              )
            }
            type="button"
          >
            {allCallsCollapsed ? "Expand calls" : "Collapse calls"}
          </button>
          <a className="raw-download" href={`/raw/${encodeURIComponent(sessionId)}`}>
            Download raw JSONL
          </a>
        </div>
      </header>
      {trace === null ? (
        <p className="loading">Loading exact active-branch trace…</p>
      ) : (
        <>
          <Overview
            key={overviewEpoch}
            fullBounds={activeBounds}
            matchedRecords={matchedRecords}
            onRangeChange={changeRange}
            onSelect={selectRecord}
            range={range}
            records={scopedRecords}
            selectedId={selectedId}
          />
          <p className="trace-scope-note">
            {query.trim() === ""
              ? "The dense overview and virtual ledger keep all active-branch evidence in scope."
              : "Search dims non-matches; focus keeps all evidence visible."}
          </p>
          <div className="trace-workspace" style={traceWorkspaceStyle(inspectorWidth)}>
            <RecordLedger
              collapsedCalls={collapsedCalls}
              collapsedTurns={collapsedTurns}
              matchedRecords={matchedRecords}
              onSelect={selectRecord}
              range={range}
              records={scopedRecords}
              revision={trace.sourceVersion}
              selectedId={selectedId}
              transition={transition}
            />
            <Inspector
              key={selected?.recordId ?? "none"}
              inspectorWidth={inspectorWidth}
              onResizeBy={(pixels) =>
                setInspectorWidth((current) =>
                  Math.min(INSPECTOR_MAX_WIDTH, Math.max(INSPECTOR_MIN_WIDTH, current + pixels)),
                )
              }
              onResizeStart={resizeInspector}
              onSelectLinkedRecord={(id) => {
                const target = trace.records.find((record) => record.recordId === id);
                if (!target) return;
                if (rarebitOnly && !target.rarebit) setRarebitOnly(false);
                selectRecord(target);
              }}
              record={selected}
            />
          </div>
          <footer className="trace-footer">
            {trace.records.length} active-branch records · {scopedRecords.length} in scope ·{" "}
            {trace.selection.rarebitSourceEntryIds.length} Rarebits · source {trace.sourceVersion}
          </footer>
        </>
      )}
    </main>
  );
}
