import { useEffect, useRef, useState } from "react";
import { alphaDemoSnapshot } from "./alpha-demo";
import { decisionSummaryModel, orderProjectsByIntervention } from "./alpha-decision";
export { decisionSummaryModel, orderProjectsByIntervention } from "./alpha-decision";
import type {
  AlphaAxis,
  AlphaProject,
  AlphaProvenance,
  AlphaRawRef,
  AlphaSnapshot,
} from "./alpha-types";
import "./alpha.css";

const forceDemo = new URLSearchParams(window.location.search).get("demo") === "1";

function Freshness({ value }: { value: AlphaProvenance }) {
  return (
    <span className={`alpha-chip ${value.freshness}`}>
      {value.freshness} · {value.confidence}
    </span>
  );
}

function DerivedFreshness({
  freshness,
  confidence,
}: {
  freshness: AlphaProvenance["freshness"];
  confidence: AlphaProvenance["confidence"];
}) {
  return (
    <span className={`alpha-chip ${freshness}`}>
      {freshness} · {confidence}
    </span>
  );
}

function refsFrom(value?: AlphaProvenance | AlphaRawRef[]) {
  return Array.isArray(value) ? value : (value?.rawRefs ?? []);
}

function LineageRefs({
  value,
  label = "refs",
}: {
  value?: AlphaProvenance | AlphaRawRef[];
  label?: string;
}) {
  const refs = refsFrom(value);
  if (!refs.length) return <small className="alpha-lineage alpha-unknown">no source refs</small>;
  return (
    <small
      className="alpha-lineage"
      aria-label={`${label}: ${refs.map((ref) => `${ref.kind}:${ref.id}`).join(", ")}`}
    >
      {label}:{" "}
      {refs
        .slice(0, 2)
        .map((ref) => `${ref.kind}:${ref.id}`)
        .join(" · ")}
      {refs.length > 2 ? ` · +${refs.length - 2}` : ""}
    </small>
  );
}

function Provenance({ value }: { value?: AlphaProvenance }) {
  if (!value) return <small className="alpha-unknown">No provenance</small>;
  return (
    <span className="alpha-provenance">
      <span>
        <Freshness value={value} /> · {value.source.kind} · observed{" "}
        {new Date(value.observedAt).toLocaleTimeString()}
      </span>
      <LineageRefs value={value} />
    </span>
  );
}

function objectItems(axis: AlphaAxis) {
  return (axis.items ?? []).filter(
    (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
  );
}

export function runtimeEmptyText(axis: AlphaAxis) {
  if (axis.reason === "no_current_runtime_observation") {
    return "Session associated; no current runtime observation";
  }
  if (axis.reason === "no_explicit_runtime_association") {
    return "No Session association configured";
  }
  return "Runtime observation unavailable";
}

function summaryTimestamp(item: Record<string, unknown>) {
  const provenance = item.provenance as AlphaProvenance | undefined;
  const candidate = [
    item.validAt,
    item.observedAt,
    provenance?.validAt,
    provenance?.observedAt,
  ].find(
    (value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)),
  );
  return candidate;
}

export function recentSummaryModels(axis: AlphaAxis) {
  return objectItems(axis)
    .map((item, index) => ({ item, index, timestamp: summaryTimestamp(item) }))
    .sort((left, right) => {
      const leftTime = left.timestamp ? Date.parse(left.timestamp) : Number.NEGATIVE_INFINITY;
      const rightTime = right.timestamp ? Date.parse(right.timestamp) : Number.NEGATIVE_INFINITY;
      return rightTime !== leftTime ? rightTime - leftTime : left.index - right.index;
    });
}

function traceValueRefs(value: Record<string, unknown>) {
  const refs: Array<{ label: string; value: AlphaRawRef[] }> = [];
  const add = (label: string, candidate: unknown) => {
    if (Array.isArray(candidate)) {
      refs.push({ label, value: candidate as AlphaRawRef[] });
    }
  };
  if (value.valueRefs && typeof value.valueRefs === "object") {
    Object.entries(value.valueRefs).forEach(([field, candidate]) =>
      add(`${field} refs`, candidate),
    );
  }
  Object.entries(value)
    .filter(([field]) => field.endsWith("Refs") && field !== "valueRefs")
    .forEach(([field, candidate]) => add(field, candidate));
  const nestedValues = [
    ...(Array.isArray(value.items) ? value.items : []),
    ...(Array.isArray(value.proposals) ? value.proposals : []),
    ...(value.canonicalRevision && typeof value.canonicalRevision === "object"
      ? [value.canonicalRevision]
      : []),
  ];
  nestedValues.forEach((nested, index) => {
    if (typeof nested !== "object" || nested === null) return;
    const provenance = (nested as { provenance?: AlphaProvenance }).provenance;
    if (provenance) add(`item ${index} refs`, provenance.rawRefs);
  });
  return refs;
}

export function axisCardModel(axis: AlphaAxis) {
  const state = typeof axis.state === "string" ? axis.state : "observed";
  return {
    state,
    reason: axis.reason?.replaceAll("_", " "),
    diagnosticCount: Array.isArray(axis.diagnostics) ? axis.diagnostics.length : 0,
  };
}

function AxisCard({
  label,
  axis,
  children,
  showState = true,
}: {
  label: string;
  axis: AlphaAxis;
  children: React.ReactNode;
  showState?: boolean;
}) {
  const model = axisCardModel(axis);
  return (
    <section className="alpha-axis" aria-label={`${label} axis`}>
      <div className="alpha-axis-head">
        <h3>{label}</h3>
        <span className="alpha-axis-status">
          <Freshness value={axis.provenance} />
          {showState && model.state !== "observed" ? (
            <span className={`alpha-state ${model.state}`}>{model.state}</span>
          ) : null}
        </span>
      </div>
      {children}
      {model.reason ? <p className="alpha-unknown">{model.reason}</p> : null}
    </section>
  );
}

function TraceDrawer({
  project,
  onClose,
  trigger,
}: {
  project: AlphaProject;
  onClose: () => void;
  trigger: HTMLButtonElement | null;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogId = `alpha-trace-${project.projectRef.id.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;
  useEffect(() => {
    closeRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = document.getElementById(dialogId);
      const focusable = Array.from(
        dialog?.querySelectorAll<HTMLElement>('button, [tabindex]:not([tabindex="-1"])') ?? [],
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      trigger?.focus();
    };
  }, [dialogId, onClose, trigger]);
  const entries = [
    ["identity", project.projectRef],
    ["runtime", project.runtime],
    ["rarebitSummary", project.rarebitSummary],
    ["intervention", project.intervention],
    ["eventDelta", project.eventDelta],
    ["evergreenDelta", project.evergreenDelta],
    ["workLedger", project.workLedger],
    ["delivery", project.delivery],
  ] as const;
  const axisDiagnostics = entries.flatMap(([key, value]) =>
    "diagnostics" in value && Array.isArray(value.diagnostics)
      ? value.diagnostics.map((diagnostic) => ({ axis: key, diagnostic }))
      : [],
  );
  const diagnostics = [
    ...(project.trace?.diagnostics ?? []).map((diagnostic) => ({ axis: "project", diagnostic })),
    ...axisDiagnostics,
  ];
  const rejected = project.trace?.rejected ?? [];
  return (
    <div
      className="alpha-trace-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        id={dialogId}
        className="alpha-trace"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${dialogId}-title`}
      >
        <button ref={closeRef} onClick={onClose} aria-label="Close trace">
          ×
        </button>
        <p className="alpha-eyebrow">Trace / raw refs</p>
        <h2 id={`${dialogId}-title`}>{project.projectRef.name}</h2>
        <p>Derivation: {project.projectRef.provenance.derivation.version}</p>
        <p>
          Project ID: <code>{project.projectRef.id}</code>
        </p>
        <LineageRefs value={project.projectRef.valueRefs?.id} label="identity refs" />
        {diagnostics.length || rejected.length ? (
          <section className="alpha-trace-diagnostics" aria-label="Source diagnostics">
            <h3>Integrity diagnostics</h3>
            <p>
              {diagnostics.length} source diagnostic(s) · {rejected.length} rejected record(s)
            </p>
            {diagnostics.slice(0, 12).map(({ axis, diagnostic }, index) => (
              <code key={`diagnostic-${index}`}>
                {axis}: {JSON.stringify(diagnostic)}
              </code>
            ))}
            {rejected.slice(0, 12).map((item, index) => (
              <code key={`rejected-${index}`}>rejected {JSON.stringify(item)}</code>
            ))}
          </section>
        ) : null}
        <dl>
          {entries.map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>
                <Provenance value={value.provenance} />
                {traceValueRefs(value).map(({ label, value: refs }) => (
                  <LineageRefs key={label} value={refs} label={label} />
                ))}
                {(value.provenance?.rawRefs ?? []).map((ref) => (
                  <code key={`${ref.kind}:${ref.id}`}>
                    {ref.kind}:{ref.id}
                    {ref.pathOrCommand ? ` · ${ref.pathOrCommand}` : ""}
                  </code>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

function ProjectRow({
  project,
  onTrace,
  traceOpen,
}: {
  project: AlphaProject;
  onTrace: (button: HTMLButtonElement) => void;
  traceOpen: boolean;
}) {
  const decision = decisionSummaryModel(project);
  const summaries = recentSummaryModels(project.rarebitSummary);
  const tasks = (project.workLedger.tasks ?? []) as Array<{
    id: string;
    title?: string;
    status?: string;
    provenance?: AlphaProvenance;
  }>;
  const proposals = (project.evergreenDelta.proposals ?? []) as Array<{
    id: string;
    status?: string;
    provenance?: AlphaProvenance;
  }>;
  const deliveryEvidence = Array.isArray(project.delivery.evidence)
    ? (project.delivery.evidence as Array<{
        id?: string;
        status?: string;
        delivery?: { artifact?: string; deliveredAt?: string; evidence?: string };
        provenance?: AlphaProvenance;
      }>)
    : [];
  const eventWindow = project.eventDelta.window as { kind?: string } | undefined;
  const traceId = `alpha-trace-${project.projectRef.id.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;
  const projectTitleId = `alpha-project-${project.projectRef.id.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;
  return (
    <article className="alpha-project" data-decision-bucket={decision.bucket}>
      <header className="alpha-project-head">
        <div className="alpha-project-identity">
          <p className="alpha-eyebrow">Project</p>
          <h2 id={projectTitleId}>{project.projectRef.name}</h2>
        </div>
        <button
          className="alpha-trace-button"
          onClick={(event) => onTrace(event.currentTarget)}
          aria-expanded={traceOpen}
          aria-controls={traceId}
          aria-haspopup="dialog"
        >
          Trace
        </button>
      </header>
      <section
        className={`alpha-decision ${decision.bucket}`}
        aria-labelledby={`${projectTitleId}-decision`}
      >
        <div className="alpha-decision-head">
          <p className="alpha-eyebrow">Operator decision</p>
          <DerivedFreshness freshness={decision.freshness} confidence={decision.confidence} />
        </div>
        <h3 id={`${projectTitleId}-decision`}>{decision.headline}</h3>
        <dl className="alpha-decision-details">
          <div>
            <dt>Why</dt>
            <dd>{decision.why}</dd>
          </div>
          <div>
            <dt>Changed</dt>
            <dd>{decision.whatChanged}</dd>
          </div>
        </dl>
      </section>
      <details className="alpha-evidence">
        <summary>Seven evidence axes</summary>
        <div className="alpha-axes">
          <AxisCard label="Runtime" axis={project.runtime}>
            {objectItems(project.runtime).length ? (
              <ul>
                {objectItems(project.runtime).map((item) => (
                  <li key={String(item.processInstanceId)}>
                    <strong>{String(item.state ?? "unknown")}</strong>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="alpha-unknown">{runtimeEmptyText(project.runtime)}</p>
            )}
          </AxisCard>
          <AxisCard label="Rarebit Summary" axis={project.rarebitSummary}>
            {summaries.length ? (
              summaries.map(({ item, index: sourceIndex, timestamp }, index) => (
                <details className="alpha-summary-details" key={sourceIndex} open={index === 0}>
                  <summary>
                    {index === 0 ? "Latest agent report" : "Earlier agent report"}
                    {timestamp ? (
                      <>
                        {" · "}
                        <time dateTime={timestamp}>{new Date(timestamp).toLocaleString()}</time>
                      </>
                    ) : (
                      " · time unavailable"
                    )}
                  </summary>
                  <p className="alpha-rarebit-summary">
                    <strong>Agent reported:</strong>{" "}
                    {String(item.summary ?? item.progress ?? "Summary available")}
                  </p>
                  <LineageRefs
                    value={item.provenance as AlphaProvenance | undefined}
                    label="source refs"
                  />
                </details>
              ))
            ) : (
              <p className="alpha-unknown">No summary source</p>
            )}
          </AxisCard>
          <AxisCard label="Intervention" axis={project.intervention}>
            {objectItems(project.intervention).length ? (
              objectItems(project.intervention).map((item, index) => (
                <p key={index}>
                  <strong>{String(item.assessment ?? "unknown")}</strong>
                  {item.reason ? ` · ${String(item.reason)}` : ""}
                </p>
              ))
            ) : (
              <p className="alpha-unknown">Needs review / no assessment</p>
            )}
          </AxisCard>
          <AxisCard
            label={
              eventWindow?.kind === "since-owner-watermark"
                ? "Events since owner watermark"
                : "Recorded event history"
            }
            axis={project.eventDelta}
          >
            <p>
              {String(project.eventDelta.count ?? 0)}{" "}
              {eventWindow?.kind === "since-owner-watermark"
                ? "event(s) since owner update"
                : "total recorded event(s)"}
            </p>
            {project.eventDelta.ownerWatermark ? (
              <p>Owner watermark {String(project.eventDelta.ownerWatermark)}</p>
            ) : project.eventDelta.latestEventAt ? (
              <p>Latest event {String(project.eventDelta.latestEventAt)}</p>
            ) : null}
          </AxisCard>
          <AxisCard label="Evergreen delta" axis={project.evergreenDelta}>
            <p>{String(project.evergreenDelta.changeCount ?? 0)} proposed change(s)</p>
            {proposals.map((proposal) => (
              <p key={proposal.id}>Proposal · {proposal.status ?? "unknown"}</p>
            ))}
          </AxisCard>
          <AxisCard label="Work ledger" axis={project.workLedger}>
            {tasks.length ? (
              <ul>
                {tasks.map((task) => (
                  <li key={task.id}>
                    {task.title ?? "Task recorded"} · {task.status ?? "unknown"}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="alpha-unknown">No Beads tasks available</p>
            )}
          </AxisCard>
          <AxisCard label="Delivery evidence" axis={project.delivery} showState={false}>
            {deliveryEvidence.length ? (
              <ul>
                {deliveryEvidence.map((evidence, index) => (
                  <li key={evidence.id ?? index}>
                    <strong>{evidence.id ? `Task ${evidence.id}` : "Task evidence"}</strong>
                    {evidence.delivery?.artifact
                      ? ` · delivery artifact ${evidence.delivery.artifact}`
                      : ` · ${evidence.status ?? "status unknown"} task evidence`}
                    {evidence.delivery?.deliveredAt
                      ? ` · recorded ${evidence.delivery.deliveredAt}`
                      : ""}
                    <LineageRefs value={evidence.provenance} label="delivery refs" />
                  </li>
                ))}
              </ul>
            ) : project.delivery.canonicalRevision ? (
              <p>Canonical context exists; no delivery or acceptance evidence recorded.</p>
            ) : (
              <p className="alpha-unknown">No delivery evidence recorded.</p>
            )}
          </AxisCard>
        </div>
      </details>
    </article>
  );
}

export function AlphaApp({ demo = forceDemo }: { demo?: boolean } = {}) {
  const [snapshot, setSnapshot] = useState<AlphaSnapshot | null>(() =>
    demo ? alphaDemoSnapshot() : null,
  );
  const [connection, setConnection] = useState(demo ? "demo" : "loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [traceProject, setTraceProject] = useState<AlphaProject | null>(null);
  const [traceTrigger, setTraceTrigger] = useState<HTMLButtonElement | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  useEffect(() => {
    if (demo) return undefined;
    let active = true;
    const load = () => {
      setConnection("loading");
      setErrorMessage(null);
      fetch("/api/alpha/snapshot")
        .then(async (response) => {
          if (!response.ok) throw new Error(`GET /api/alpha/snapshot returned ${response.status}`);
          return (await response.json()) as AlphaSnapshot;
        })
        .then((value) => {
          if (active) {
            setSnapshot(value);
            setConnection("live");
          }
        })
        .catch((error: unknown) => {
          if (active) {
            setSnapshot(null);
            setConnection("error");
            setErrorMessage(
              error instanceof Error ? error.message : "GET /api/alpha/snapshot failed",
            );
          }
        });
    };
    load();
    let events: EventSource | undefined;
    try {
      events = new EventSource("/api/alpha/events");
      events.addEventListener("ready", load);
      events.addEventListener("invalidate", load);
      events.onerror = () => setConnection((value) => (value === "error" ? value : "reconnecting"));
    } catch {
      // The initial snapshot request remains the source of truth in browsers without EventSource.
    }
    return () => {
      active = false;
      events?.close();
    };
  }, [demo, retryToken]);
  return (
    <main className="alpha-page">
      <header className="alpha-top">
        <div>
          <p className="alpha-eyebrow">HyperCarrier Alpha projection</p>
          <h1>Projects, evidence, and decisions</h1>
        </div>
        <div className={`alpha-connection ${connection}`} aria-live="polite">
          {connection}
        </div>
      </header>
      <section className="alpha-intro">
        <p>
          Read-only, provenance-first projection. Runtime, output, intervention, events, Evergreen,
          work, and delivery stay separate.
        </p>
        <code>/alpha</code>
      </section>
      {connection === "error" ? (
        <section className="alpha-error" role="alert">
          <h2>Alpha data unavailable</h2>
          <p>{errorMessage}</p>
          <button onClick={() => setRetryToken((value) => value + 1)}>Retry live snapshot</button>
          <a href="/alpha?demo=1">Open synthetic demo</a>
        </section>
      ) : snapshot ? (
        snapshot.projects.length ? (
          <div className="alpha-board">
            {orderProjectsByIntervention(snapshot.projects).map((project) => (
              <ProjectRow
                key={project.projectRef.id}
                project={project}
                traceOpen={traceProject?.projectRef.id === project.projectRef.id}
                onTrace={(button) => {
                  setTraceTrigger(button);
                  setTraceProject(project);
                }}
              />
            ))}
          </div>
        ) : (
          <section className="alpha-empty" role="status">
            <h2>No explicit Projects configured</h2>
            <p>The Alpha manifest loaded, but it contains no valid unique Project IDs.</p>
          </section>
        )
      ) : (
        <div className="alpha-loading" role="status" aria-live="polite">
          Loading explicit Project manifest…
        </div>
      )}
      {traceProject ? (
        <TraceDrawer
          project={traceProject}
          trigger={traceTrigger}
          onClose={() => {
            setTraceProject(null);
            setTraceTrigger(null);
          }}
        />
      ) : null}
      <footer className="alpha-footer">
        Observed {snapshot ? new Date(snapshot.generatedAt).toLocaleString() : "—"} · trace
        available per Project
      </footer>
    </main>
  );
}
