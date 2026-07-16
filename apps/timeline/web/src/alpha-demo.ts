import type { AlphaProvenance, AlphaSnapshot } from "./alpha-types";

const at = new Date().toISOString();
const meta = (
  kind: string,
  id: string,
  freshness: AlphaProvenance["freshness"] = "fresh",
  confidence: AlphaProvenance["confidence"] = "exact",
): AlphaProvenance => ({
  source: { kind, instance: "demo", rawId: id },
  validAt: at,
  observedAt: at,
  freshness,
  confidence,
  derivation: { version: "hc-timeline-alpha-v1", inputs: [id] },
  rawRefs: [{ kind, id }],
});

export function alphaDemoSnapshot(): AlphaSnapshot {
  const project = (
    id: string,
    name: string,
    state: string,
    freshness: AlphaProvenance["freshness"],
    confidence: AlphaProvenance["confidence"] = "exact",
  ) => {
    const projectMeta = meta("manifest", id, "fresh", confidence);
    return {
      projectRef: {
        id,
        name,
        repoRoots: [`/work/${id}`],
        worktreeRoots: [],
        provenance: projectMeta,
        valueRefs: {
          id: projectMeta.rawRefs,
          name: projectMeta.rawRefs,
          repoRoots: projectMeta.rawRefs,
          worktreeRoots: projectMeta.rawRefs,
        },
      },
      runtime:
        state === "unknown"
          ? {
              state: "unknown",
              reason: "no_explicit_runtime_association",
              provenance: meta("timeline-runtime", id, "unknown", "ambiguous"),
            }
          : {
              state: "observed",
              items: [
                {
                  processInstanceId: `${id}-runtime`,
                  sessionId: `${id}-session`,
                  state,
                  pid: 7001,
                  provenance: meta("timeline-runtime", id),
                },
              ],
              provenance: meta("timeline-runtime", id),
            },
      rarebitSummary: {
        state: freshness === "unknown" ? "unknown" : "observed",
        items:
          freshness === "unknown"
            ? []
            : [
                {
                  id: `${id}-summary`,
                  summary:
                    state === "waiting"
                      ? "Progress: waiting on owner input. Findings: the current path is constrained. Questions: approve the next branch. Next: hold for a steer."
                      : "Progress: implementation is moving. Findings: the source contract is stable. Questions: none. Next: verify the delivery evidence.",
                  provenance: meta("summary", `${id}-summary`, freshness),
                },
              ],
        provenance: meta("summary", id, freshness, confidence),
      },
      intervention:
        id === "alpha-review"
          ? {
              state: "assessed",
              items: [
                {
                  assessment: "human approval needed",
                  reason: "owner decision watermark is behind",
                  provenance: meta("project-events", `${id}-intervention`),
                },
              ],
              provenance: meta("project-events", `${id}-intervention`),
            }
          : {
              state: "unknown",
              reason: "no_intervention_assessment",
              provenance: meta("intervention", id, "unknown", "ambiguous"),
            },
      ...(id === "alpha-watchdog"
        ? {
            intervention: {
              state: "assessed",
              items: [
                {
                  assessment: "watchdog review needed",
                  reason: "the source update is stale",
                  provenance: meta("project-events", `${id}-intervention`, "stale"),
                },
              ],
              provenance: meta("project-events", `${id}-intervention`, "stale"),
            },
          }
        : {}),
      eventDelta:
        id === "alpha-review"
          ? {
              count: 2,
              countRefs: meta("project-events", `${id}-event`).rawRefs,
              items: [
                {
                  eventKind: "decision-candidate",
                  id: `${id}-event`,
                  provenance: meta("project-events", `${id}-event`),
                },
              ],
              provenance: meta("project-events", id),
            }
          : {
              state: "unknown",
              reason: "no_project_events",
              provenance: meta("project-events", id, "unknown", "ambiguous"),
            },
      evergreenDelta: {
        changeCount: id === "alpha-review" ? 1 : 0,
        changeCountRefs: meta("evergreen", id).rawRefs,
        canonicalRevision: {
          revisionId: `${id}-revision`,
          provenance: meta("markdown", `${id}-revision`, freshness),
        },
        proposals: [],
        provenance: meta("evergreen", id, freshness, confidence),
      },
      workLedger: {
        tasks: [
          {
            id: `${id}-task`,
            title: id === "alpha-review" ? "Review proposed decision" : "Implement source adapter",
            status: id === "alpha-review" ? "open" : "in_progress",
            provenance: meta("beads", `${id}-task`, freshness),
          },
        ],
        provenance: meta("beads", id, freshness),
      },
      delivery:
        id === "alpha-review"
          ? {
              state: "partial",
              evidence: [],
              canonicalRevision: `${id}-revision`,
              canonicalRevisionRefs: meta("markdown", `${id}-revision`).rawRefs,
              provenance: meta("markdown", `${id}-revision`, freshness),
            }
          : {
              state: "unknown",
              reason: "no_delivery_evidence",
              provenance: meta("delivery", id, "unknown", "ambiguous"),
            },
    };
  };
  return {
    schemaVersion: 1,
    generatedAt: at,
    projects: [
      project("alpha-review", "Alpha review", "waiting", "fresh"),
      project("alpha-watchdog", "Watchdog lane", "thinking", "stale"),
      project("alpha-ambiguous", "Needs review", "unknown", "unknown", "ambiguous"),
    ],
    trace: {
      schemaVersion: 1,
      derivationVersion: "hc-timeline-alpha-v1",
      generatedAt: at,
      manifest: "fixtures/alpha/project-manifest.json",
      sources: [],
      diagnostics: [],
      assumptions: [
        "Demo data is browser-only",
        "Project identity is explicit",
        "Axes are not collapsed into one status",
      ],
    },
  };
}
