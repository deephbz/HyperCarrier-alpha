import { readFileSync, statSync } from "node:fs";
import { rarebitMaterializationPath } from "@hypercarrier/hc-rarebit";

const MAX_SIDECAR_BYTES = 5 * 1024 * 1024;

function finiteTimestamp(value) {
  const millis = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(millis) ? millis : null;
}

function safeString(value) {
  return typeof value === "string" ? value : null;
}

function safeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalBoolean(key, value) {
  return typeof value === "boolean" ? { [key]: value } : {};
}

function optionalNumber(key, value) {
  return typeof value === "number" && Number.isFinite(value) ? { [key]: value } : {};
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function projectSynthesis(synthesis) {
  const source = object(synthesis);
  if (source.kind && source.kind !== "rarebit_model_synthesis") return null;
  const timing = object(source.timing);
  const provider = object(source.provider);
  const usage = object(source.usage);
  return {
    outcome: safeString(source.outcome),
    timing: {
      startedAt: safeString(timing.startedAt),
      completedAt: safeString(timing.completedAt),
      durationMs: safeNumber(timing.durationMs),
      provenance: safeString(timing.provenance),
    },
    provider: {
      responseProvider: safeString(provider.responseProvider),
      responseModel: safeString(provider.responseModel),
      responseId: safeString(provider.responseId),
      requestId: safeString(provider.requestId),
    },
    usage: {
      availability: safeString(usage.availability),
      inputTokens: safeNumber(usage.inputTokens),
      outputTokens: safeNumber(usage.outputTokens),
      totalTokens: safeNumber(usage.totalTokens),
      cacheReadTokens: safeNumber(usage.cacheReadTokens),
      cacheWriteTokens: safeNumber(usage.cacheWriteTokens),
      reasoningTokens: safeNumber(usage.reasoningTokens),
      estimatedCostUsd: safeNumber(usage.estimatedCostUsd),
    },
  };
}

function projectAutomaticSummaryPolicy(policy, nowMillis) {
  const source = object(policy);
  const provenance = object(source.provenance);
  const observedAtMillis = finiteTimestamp(source.observedAt);
  const validUntilMillis = finiteTimestamp(source.validUntil);
  const queriedAtMillis = finiteTimestamp(source.queriedAt);
  if (
    source.contractVersion !== "rarebit-automatic-summary-policy/1" ||
    source.decision !== "inhibit" ||
    source.queryStatus !== "inhibited" ||
    !safeString(source.queryId) ||
    !safeString(source.provider) ||
    !safeString(source.reason) ||
    !safeString(provenance.identity) ||
    !safeString(provenance.generation) ||
    !safeString(provenance.association) ||
    observedAtMillis === null ||
    validUntilMillis === null ||
    queriedAtMillis === null ||
    observedAtMillis > queriedAtMillis ||
    queriedAtMillis >= validUntilMillis
  )
    return null;
  const current = validUntilMillis > nowMillis;
  return {
    state: current ? "inhibited" : "inhibition_receipt_expired",
    wording: current
      ? "automatic summary inhibited by team-management policy"
      : "latest automatic-summary inhibition receipt has expired",
    contractVersion: safeString(source.contractVersion),
    provider: safeString(source.provider),
    reason: safeString(source.reason),
    observedAt: safeString(source.observedAt),
    validUntil: safeString(source.validUntil),
  };
}

function projectedSummaryAvailability({ historical, status, unavailable, stale }) {
  if (historical) return historical.availability;
  if (status === "inhibited") return "missing";
  if (unavailable) return "unavailable";
  return stale ? "stale" : "available";
}

function projectedSummaryText(record, historical) {
  if (typeof record.summary === "string") return { summary: record.summary };
  return typeof historical?.summary === "string" ? { summary: historical.summary } : {};
}

function projectedHistoricalSummary(status, historical) {
  if (status !== "inhibited") return {};
  return {
    historicalSummary: historical
      ? {
          availability: historical.availability,
          status: historical.status,
          observedAt: historical.observedAt,
          jobId: historical.jobId,
        }
      : { availability: "missing" },
  };
}

/**
 * Projects only the derived Rarebit Summary record. In particular, it
 * intentionally omits sidecar path, sessionFile, branch records, selected
 * message prose, and all raw Session JSONL fields.
 */
export function projectRarebitSummaryRecord(
  record,
  session,
  historicalRecord = null,
  nowMillis = Date.now(),
) {
  const selection = object(record.selection);
  const model = object(record.model);
  const modelProvenance = object(record.modelProvenance);
  const status = safeString(record.status) ?? "unknown";
  const lastMessageAt = finiteTimestamp(session.lastMessageAt);
  const summaryAsOf = finiteTimestamp(record.observedAt);
  const unavailable = status === "failure" || status === "unavailable_overflow";
  const stale =
    !unavailable && lastMessageAt !== null && (summaryAsOf === null || summaryAsOf < lastMessageAt);
  const currentPolicy = projectAutomaticSummaryPolicy(record.automaticSummaryPolicy, nowMillis);
  const historical =
    status === "inhibited" && historicalRecord
      ? projectRarebitSummaryRecord(historicalRecord, session, null, nowMillis)
      : null;
  return {
    availability: projectedSummaryAvailability({
      historical,
      status,
      unavailable,
      stale,
    }),
    ...optionalNumber("schemaVersion", historical?.schemaVersion ?? record.schemaVersion),
    status,
    jobId: safeString(record.jobId),
    observedAt: safeString(record.observedAt),
    selection: {
      selectorVersion: safeString(selection.selectorVersion),
      manifestHash: safeString(selection.manifestHash),
      occurrenceCount: safeNumber(selection.occurrenceCount),
      uniquePayloadCount: safeNumber(selection.uniquePayloadCount),
    },
    eligibility: {
      eligible: record.eligibility?.eligible === true,
      forced: record.eligibility?.forced === true,
      reasons: Array.isArray(record.eligibility?.reasons)
        ? record.eligibility.reasons.filter((value) => typeof value === "string")
        : [],
      policyVersion: safeString(record.eligibility?.policy?.policyVersion),
    },
    provenance: historical?.provenance ?? {
      model:
        safeString(model.provider) && safeString(model.id)
          ? { provider: model.provider, id: model.id }
          : null,
      modelResolution: {
        source: safeString(modelProvenance.source),
        status: safeString(modelProvenance.status),
        settingsKey: safeString(modelProvenance.settingsKey),
      },
      promptVersion: safeString(record.promptVersion),
      implementationVersion: safeString(record.implementationVersion),
      jobId: safeString(record.jobId),
      synthesis: projectSynthesis(record.synthesis),
    },
    ...optionalBoolean(
      "summaryNeedsHumanAttention",
      historical?.summaryNeedsHumanAttention ?? record.summaryNeedsHumanAttention,
    ),
    ...projectedSummaryText(record, historical),
    ...(currentPolicy ? { automaticSummaryPolicy: currentPolicy } : {}),
    ...projectedHistoricalSummary(status, historical),
    ...(status === "failure"
      ? {
          failure: {
            retryable: record.retryable === true,
            kind: safeString(record.error?.name),
          },
        }
      : {}),
  };
}

function latestRecordForSession(raw, sessionId) {
  let latest = null;
  let latestSuccessfulSummary = null;
  const synthesisByLeaf = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (
        record?.type === "rarebit_summary" &&
        record.sessionId === sessionId &&
        typeof record.status === "string"
      ) {
        latest = record;
        if (record.status === "ok" && typeof record.summary === "string")
          latestSuccessfulSummary = record;
        const leafId = safeString(record.branch?.leafId);
        if (
          leafId &&
          (record.status === "ok" ||
            record.status === "failure" ||
            record.status === "unavailable_overflow")
        )
          synthesisByLeaf.set(leafId, record);
      }
    } catch {
      // Sidecar history is evidence. A malformed historical line must not
      // make an otherwise valid newest materialization unsafe to inspect.
    }
  }
  // An automatic eligibility check is an observation about whether to launch
  // new synthesis, not a replacement for an existing synthesis outcome. On
  // exact-Session resume, Rarebit can append an ineligible record for the same
  // unchanged branch after a forced summary. Preserve that branch's latest
  // actual outcome, while a new branch remains free to supersede it and an
  // explicit failure/overflow remains visible instead of reviving older text.
  if (latest?.status === "ineligible") {
    const leafId = safeString(latest.branch?.leafId);
    if (leafId && synthesisByLeaf.has(leafId))
      return { record: synthesisByLeaf.get(leafId), historicalSummary: null };
  }
  return {
    record: latest,
    historicalSummary: latest?.status === "inhibited" ? latestSuccessfulSummary : null,
  };
}

/**
 * Resolves only the mirrored sidecar for this already-discovered Session.
 * The HTTP request never supplies a filesystem path, so it cannot traverse
 * outside the native Pi sessions -> Rarebit materializations mirror.
 */
export function readSessionRarebitSummary(session, options = {}) {
  let path;
  try {
    path = rarebitMaterializationPath(session.source, options);
  } catch {
    return { availability: "missing", reason: "sidecar_not_addressable" };
  }
  try {
    if (statSync(path).size > (options.maxBytes ?? MAX_SIDECAR_BYTES))
      return { availability: "unavailable", reason: "sidecar_too_large" };
    const result = latestRecordForSession(readFileSync(path, "utf8"), session.id);
    return result.record
      ? projectRarebitSummaryRecord(
          result.record,
          session,
          result.historicalSummary,
          typeof options.now === "function" ? options.now() : Date.now(),
        )
      : { availability: "missing", reason: "sidecar_missing" };
  } catch (error) {
    if (error?.code === "ENOENT") return { availability: "missing", reason: "sidecar_missing" };
    return { availability: "unavailable", reason: "sidecar_unreadable" };
  }
}

const DETAIL_AVAILABILITIES = new Set(["available", "stale", "missing", "unavailable"]);

function optionalString(key, value) {
  return typeof value === "string" ? { [key]: value } : {};
}

function optionalRecord(key, value, project) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { [key]: project(value) }
    : {};
}

function sanitizeSelection(selection) {
  return {
    selectorVersion: safeString(selection.selectorVersion),
    manifestHash: safeString(selection.manifestHash),
    occurrenceCount: safeNumber(selection.occurrenceCount),
    uniquePayloadCount: safeNumber(selection.uniquePayloadCount),
  };
}

function sanitizeEligibility(eligibility) {
  return {
    eligible: eligibility.eligible === true,
    forced: eligibility.forced === true,
    reasons: Array.isArray(eligibility.reasons)
      ? eligibility.reasons.filter((value) => typeof value === "string")
      : [],
    policyVersion: safeString(eligibility.policyVersion),
  };
}

function sanitizeProvenance(provenance) {
  const model = object(provenance.model);
  return {
    model:
      safeString(model.provider) && safeString(model.id)
        ? { provider: model.provider, id: model.id }
        : null,
    implementationVersion: safeString(provenance.implementationVersion),
    promptVersion: safeString(provenance.promptVersion),
    jobId: safeString(provenance.jobId),
    synthesis: provenance.synthesis ? projectSynthesis(provenance.synthesis) : null,
  };
}

function sanitizeFailure(failure) {
  return {
    retryable: failure.retryable === true,
    kind: safeString(failure.kind),
  };
}

function sanitizeAutomaticSummaryPolicy(policy) {
  return {
    state:
      policy.state === "inhibited" || policy.state === "inhibition_receipt_expired"
        ? policy.state
        : "unknown",
    wording: safeString(policy.wording),
    contractVersion: safeString(policy.contractVersion),
    provider: safeString(policy.provider),
    reason: safeString(policy.reason),
    observedAt: safeString(policy.observedAt),
    validUntil: safeString(policy.validUntil),
  };
}

function sanitizeHistoricalSummary(summary) {
  return {
    availability: DETAIL_AVAILABILITIES.has(summary.availability)
      ? summary.availability
      : "unavailable",
    status: safeString(summary.status),
    observedAt: safeString(summary.observedAt),
    jobId: safeString(summary.jobId),
  };
}

/**
 * Keeps the HTTP contract content-free even when a test or future adapter
 * provides an over-broad detail object. The server never serializes arbitrary
 * adapter fields.
 */
export function sanitizeRarebitSummaryDetail(detail) {
  const source = object(detail);
  const sanitized = {
    availability: DETAIL_AVAILABILITIES.has(source.availability)
      ? source.availability
      : "unavailable",
    ...optionalNumber("schemaVersion", source.schemaVersion),
    ...optionalString("reason", source.reason),
    ...optionalString("status", source.status),
    ...optionalString("jobId", source.jobId),
    ...optionalString("observedAt", source.observedAt),
    ...optionalRecord("selection", source.selection, sanitizeSelection),
    ...optionalRecord("eligibility", source.eligibility, sanitizeEligibility),
    ...optionalRecord("provenance", source.provenance, sanitizeProvenance),
    ...optionalBoolean("summaryNeedsHumanAttention", source.summaryNeedsHumanAttention),
    ...optionalString("summary", source.summary),
    ...optionalRecord(
      "automaticSummaryPolicy",
      source.automaticSummaryPolicy,
      sanitizeAutomaticSummaryPolicy,
    ),
    ...optionalRecord("historicalSummary", source.historicalSummary, sanitizeHistoricalSummary),
    ...optionalRecord("failure", source.failure, sanitizeFailure),
  };
  return {
    ...sanitized,
    attention: projectRarebitSummaryAttention(sanitized),
  };
}

function attentionLineage(detail) {
  const source = object(detail);
  const selection = object(source.selection);
  const provenance = object(source.provenance);
  return {
    kind: "rarebit_summary",
    schemaVersion: safeNumber(source.schemaVersion),
    jobId: safeString(source.jobId),
    observedAt: safeString(source.observedAt),
    selectorVersion: safeString(selection.selectorVersion),
    manifestHash: safeString(selection.manifestHash),
    promptVersion: safeString(provenance.promptVersion),
    implementationVersion: safeString(provenance.implementationVersion),
  };
}

function unknownAttention(detail, reason) {
  return {
    state: "unknown",
    reason,
    source: attentionLineage(detail),
  };
}

/**
 * Projects the explicit summary assessment into the fleet snapshot. The
 * consumer never derives attention from summary prose. A historical record
 * without the field, or a record that is no longer fresh and successful,
 * stays unknown rather than becoming a false negative.
 */
export function projectRarebitSummaryAttention(detail) {
  const source = object(detail);
  if (source.availability === "stale") return unknownAttention(source, "summary_stale");
  if (source.availability === "missing") return unknownAttention(source, "summary_missing");
  if (source.availability !== "available") return unknownAttention(source, "summary_unavailable");
  if (source.status !== "ok") return unknownAttention(source, "summary_not_successful");
  if (source.schemaVersion !== 2) return unknownAttention(source, "unsupported_summary_schema");
  if (typeof source.summaryNeedsHumanAttention !== "boolean")
    return unknownAttention(source, "attention_field_missing");
  return {
    state: "known",
    needsHumanAttention: source.summaryNeedsHumanAttention,
    source: attentionLineage(source),
  };
}
