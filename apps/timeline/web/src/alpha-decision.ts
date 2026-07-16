import type { AlphaAxis, AlphaProject, AlphaProvenance } from "./alpha-types";

export type AlphaDecisionBucket = "owner-action" | "unresolved" | "team-action" | "no-action";
export type UnresolvedEvidenceCategory =
  "fresh-output-and-changes" | "fresh-output-only" | "changes-only" | "no-fresh-output";

export interface AlphaDecisionSummary {
  bucket: AlphaDecisionBucket;
  actor: string;
  action: string;
  headline: string;
  why: string;
  whatChanged: string;
  evidenceCategory: UnresolvedEvidenceCategory;
  evidenceBasis: string;
  freshness: AlphaProvenance["freshness"];
  confidence: AlphaProvenance["confidence"];
  uncertainty?: string;
}

const MAX_CHANGED_EXCERPT_LENGTH = 240;
const MAX_CHANGED_LENGTH = 320;

function objectItems(axis: AlphaAxis) {
  return (axis.items ?? []).filter(
    (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
  );
}

function textValue(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.trim())?.trim();
}

function lowerText(...values: unknown[]) {
  return values
    .filter((value): value is string => typeof value === "string" && value.trim())
    .join(" ")
    .toLocaleLowerCase();
}

function itemDate(item: Record<string, unknown>) {
  const candidate = textValue(item.at, item.validAt, item.observedAt);
  const time = candidate ? Date.parse(candidate) : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

function latestItem(items: Record<string, unknown>[]) {
  return [...items].sort((left, right) => itemDate(right) - itemDate(left))[0];
}

function markdownLineToPlainText(value: string) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/```/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|~~)/g, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/^\s{0,3}>\s?/, "")
    .replace(/[*_#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isMarkdownHeading(value: string) {
  return /^\s{0,3}#{1,6}\s+/.test(value);
}

function isSummarySectionLabel(value: string) {
  return /^(?:findings?|questions?|next(?:\s+step)?|risks?|decisions?|status|changed)\s*:?(?:\s|$)/i.test(
    markdownLineToPlainText(value),
  );
}

function progressSectionText(value: string) {
  const inline = markdownLineToPlainText(value).match(
    /^progress\s*:\s*(.*?)(?=\s+(?:\|\s+)?(?:findings?|questions\/?requests|next\s+step)\s*:|$)/i,
  );
  if (inline?.[1]?.trim()) return inline[1].trim();
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = markdownLineToPlainText(lines[index]);
    const match = line.match(/^progress\s*(?::\s*(.*))?$/i);
    if (!match) continue;
    if (match[1]?.trim()) return match[1].trim();
    for (const followingLine of lines.slice(index + 1)) {
      if (isMarkdownHeading(followingLine)) break;
      if (isSummarySectionLabel(followingLine)) break;
      const followingText = markdownLineToPlainText(followingLine);
      if (followingText) return followingText;
    }
  }
  return undefined;
}

function firstMeaningfulSentenceOrLine(value: string) {
  const firstLine = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(markdownLineToPlainText)
    .find(Boolean);
  if (!firstLine) return undefined;
  return firstLine.match(/^(.+?[.!?](?:["')\]]+)?)(?:\s|$)/)?.[1] ?? firstLine;
}

function clampText(value: string, maxLength: number) {
  const plain = firstMeaningfulSentenceOrLine(value) ?? "";
  if (plain.length <= maxLength) return plain;
  return `${plain.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function latestProgressExcerpt(output?: Record<string, unknown>) {
  if (!output) return undefined;
  const summary = textValue(output.summary);
  const directProgress = textValue(output.progress);
  const candidate =
    (directProgress ? progressSectionText(directProgress) : undefined) ??
    (summary ? progressSectionText(summary) : undefined) ??
    directProgress ??
    textValue(output.findings) ??
    summary;
  return candidate ? clampText(candidate, MAX_CHANGED_EXCERPT_LENGTH) : undefined;
}

function reportedPositiveCount(value: unknown) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function eventChangeCount(project: AlphaProject) {
  const count = reportedPositiveCount(project.eventDelta.count);
  return count || objectItems(project.eventDelta).length;
}

function proposalChangeCount(project: AlphaProject) {
  const count = reportedPositiveCount(project.evergreenDelta.changeCount);
  return count || objectItems(project.evergreenDelta.proposals).length;
}

function eventCountText(project: AlphaProject, count: number) {
  const window = project.eventDelta.window as { kind?: string } | undefined;
  return window?.kind === "since-owner-watermark"
    ? `${count} event${count === 1 ? "" : "s"} since owner update`
    : `${count} total recorded event${count === 1 ? "" : "s"}`;
}

function latestProvenance(values: Array<AlphaProvenance | undefined>) {
  const provenances = values.filter((value): value is AlphaProvenance => Boolean(value));
  if (provenances.some((value) => value.freshness === "unknown")) return "unknown" as const;
  if (provenances.some((value) => value.freshness === "stale")) return "stale" as const;
  return provenances.length ? ("fresh" as const) : ("unknown" as const);
}

function lowestConfidence(values: Array<AlphaProvenance | undefined>) {
  const provenances = values.filter((value): value is AlphaProvenance => Boolean(value));
  if (provenances.some((value) => value.confidence === "ambiguous")) return "ambiguous" as const;
  if (provenances.some((value) => value.confidence === "inferred")) return "inferred" as const;
  return provenances.length ? ("exact" as const) : ("ambiguous" as const);
}

function interventionText(project: AlphaProject) {
  const item = latestItem(objectItems(project.intervention));
  return {
    item,
    actor: textValue(item?.actor, item?.owner, item?.role),
    action: textValue(item?.action, item?.assessment, item?.label),
    why: textValue(item?.why, item?.reason, project.intervention.reason),
  };
}

function isNoAction(text: string) {
  return /^(no|none|not?)\s+(current\s+)?action|^(monitor|watch|continue|hold)\b/.test(text);
}

function decisionBucket(actor: string | undefined, action: string | undefined, why: string) {
  const text = lowerText(actor, action, why);
  if (isNoAction(text)) return "no-action" as const;
  if (/owner|human approval|human input|operator approval|user approval/.test(text)) {
    return "owner-action" as const;
  }
  if (/team[- ]?leader|watchdog|lead(?:er)?\b/.test(text)) return "team-action" as const;
  return "unresolved" as const;
}

function changeText(project: AlphaProject) {
  const output = latestItem(objectItems(project.rarebitSummary));
  const eventCount = eventChangeCount(project);
  const proposalCount = proposalChangeCount(project);
  const facts = eventCount
    ? [
        eventCountText(project, eventCount),
        ...(proposalCount ? ["Evergreen proposal available"] : []),
      ]
    : proposalCount
      ? [`${proposalCount} proposed Evergreen change${proposalCount === 1 ? "" : "s"}`]
      : [];
  const suffix = facts.join(" · ");
  const separator = suffix ? " · " : "";
  const excerpt = latestProgressExcerpt(output);
  if (!excerpt) return suffix || "No recent change evidence.";
  const reportedExcerpt = `Agent reported: ${excerpt}`;
  const excerptLimit = Math.min(
    MAX_CHANGED_EXCERPT_LENGTH,
    Math.max(1, MAX_CHANGED_LENGTH - suffix.length - separator.length),
  );
  const boundedExcerpt = clampText(reportedExcerpt, excerptLimit);
  return `${boundedExcerpt}${separator}${suffix}`;
}

function rarebitSummaryText(project: AlphaProject) {
  const output = latestItem(objectItems(project.rarebitSummary));
  return textValue(output?.findings, output?.progress, output?.summary);
}

function hasMeaningfulChangeEvidence(project: AlphaProject) {
  // Events and Evergreen proposals can describe the same underlying change.
  // Treat either as one categorical change signal instead of adding their counts.
  return eventChangeCount(project) > 0 || proposalChangeCount(project) > 0;
}

function unresolvedEvidenceCategory(project: AlphaProject): UnresolvedEvidenceCategory {
  const freshOutput =
    Boolean(rarebitSummaryText(project)) && project.rarebitSummary.provenance.freshness === "fresh";
  const meaningfulChanges = hasMeaningfulChangeEvidence(project);
  if (freshOutput && meaningfulChanges) return "fresh-output-and-changes";
  if (freshOutput) return "fresh-output-only";
  if (meaningfulChanges) return "changes-only";
  return "no-fresh-output";
}

function evidenceBasis(category: UnresolvedEvidenceCategory) {
  switch (category) {
    case "fresh-output-and-changes":
      return "Fresh Rarebit Summary and meaningful recorded changes are present.";
    case "fresh-output-only":
      return "Fresh Rarebit Summary is present; no meaningful change signal is present.";
    case "changes-only":
      return "Meaningful recorded changes are present; no fresh Rarebit Summary is present.";
    case "no-fresh-output":
      return "No fresh Rarebit Summary or meaningful change signal is present.";
  }
}

function unassessedAction(category: UnresolvedEvidenceCategory) {
  switch (category) {
    case "fresh-output-and-changes":
      return "Rarebit Summary and changes available; no owner action assigned.";
    case "fresh-output-only":
      return "Rarebit Summary available; no owner action assigned.";
    case "changes-only":
      return "changes available, no Rarebit Summary; no owner action assigned.";
    case "no-fresh-output":
      return "no fresh evidence; no owner action assigned.";
  }
}

export function decisionSummaryModel(project: AlphaProject): AlphaDecisionSummary {
  const intervention = interventionText(project);
  const actionText = intervention.action;
  const why =
    intervention.item && intervention.why ? intervention.why : "Assessment is unresolved.";
  const interventionKnown = Boolean(
    intervention.item && actionText && actionText.toLocaleLowerCase() !== "unknown",
  );
  const bucket = interventionKnown
    ? decisionBucket(intervention.actor, actionText, why)
    : ("unresolved" as const);
  const unresolvedCategory = unresolvedEvidenceCategory(project);
  const unresolvedBasis = evidenceBasis(unresolvedCategory);
  const actor =
    bucket === "owner-action"
      ? (intervention.actor ?? "Likely owner")
      : bucket === "team-action"
        ? (intervention.actor ?? "Team leader / watchdog")
        : bucket === "no-action"
          ? (intervention.actor ?? "No current action")
          : "Unassessed";
  const action =
    bucket === "unresolved" || !interventionKnown
      ? unassessedAction(unresolvedCategory)
      : bucket === "no-action"
        ? "No current action"
        : (actionText ?? "Assessment unresolved");
  const uncertainty = !interventionKnown
    ? "No intervention assessment is available; this does not assign owner action."
    : (project.intervention.provenance.reason ??
      (project.intervention.provenance.confidence === "ambiguous"
        ? "Intervention evidence is ambiguous."
        : undefined));
  const provenance = [
    project.intervention.provenance,
    project.rarebitSummary.provenance,
    ...objectItems(project.rarebitSummary).map(
      (item) => item.provenance as AlphaProvenance | undefined,
    ),
    ...objectItems(project.eventDelta).map(
      (item) => item.provenance as AlphaProvenance | undefined,
    ),
    ...objectItems(project.evergreenDelta.proposals).map(
      (item) => item.provenance as AlphaProvenance | undefined,
    ),
  ];
  const headline = bucket === "unresolved" ? `${actor} — ${action}` : `${actor}: ${action}`;
  return {
    bucket,
    actor,
    action,
    headline,
    why:
      bucket === "unresolved"
        ? `No intervention assessment. Evidence used for ordering: ${unresolvedBasis}`
        : why,
    whatChanged: changeText(project),
    evidenceCategory: unresolvedCategory,
    evidenceBasis: unresolvedBasis,
    freshness: latestProvenance(provenance),
    confidence: lowestConfidence(provenance),
    ...(uncertainty ? { uncertainty } : {}),
  };
}

function compareDecisionBuckets(left: AlphaDecisionBucket, right: AlphaDecisionBucket) {
  if (left === right) return 0;
  if (left === "owner-action") return -1;
  if (right === "owner-action") return 1;
  if (left === "unresolved") return -1;
  if (right === "unresolved") return 1;
  if (left === "team-action") return -1;
  return 1;
}

function compareUnresolvedEvidence(
  left: UnresolvedEvidenceCategory,
  right: UnresolvedEvidenceCategory,
) {
  const order: UnresolvedEvidenceCategory[] = [
    "fresh-output-and-changes",
    "fresh-output-only",
    "changes-only",
    "no-fresh-output",
  ];
  return order.indexOf(left) - order.indexOf(right);
}

export function orderProjectsByIntervention(projects: AlphaProject[]) {
  return projects
    .map((project, index) => ({ project, index, summary: decisionSummaryModel(project) }))
    .sort((left, right) => {
      const bucketOrder = compareDecisionBuckets(left.summary.bucket, right.summary.bucket);
      if (bucketOrder) return bucketOrder;
      if (left.summary.bucket === "unresolved" && right.summary.bucket === "unresolved") {
        const evidenceOrder = compareUnresolvedEvidence(
          left.summary.evidenceCategory,
          right.summary.evidenceCategory,
        );
        if (evidenceOrder) return evidenceOrder;
      }
      return left.index - right.index;
    })
    .map(({ project }) => project);
}
