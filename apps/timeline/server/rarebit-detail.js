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

/**
 * Projects only the derived Rarebit Summary record. In particular, it
 * intentionally omits sidecar path, sessionFile, branch records, selected
 * message prose, and all raw Session JSONL fields.
 */
export function projectRarebitSummaryRecord(record, session) {
  const selection = object(record.selection);
  const model = object(record.model);
  const modelProvenance = object(record.modelProvenance);
  const status = safeString(record.status) ?? "unknown";
  const lastMessageAt = finiteTimestamp(session.lastMessageAt);
  const summaryAsOf = finiteTimestamp(record.observedAt);
  const unavailable = status === "failure" || status === "unavailable_overflow";
  const stale =
    !unavailable && lastMessageAt !== null && (summaryAsOf === null || summaryAsOf < lastMessageAt);
  return {
    availability: unavailable ? "unavailable" : stale ? "stale" : "available",
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
    provenance: {
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
    ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
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
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (
        record?.type === "rarebit_summary" &&
        record.sessionId === sessionId &&
        typeof record.status === "string"
      )
        latest = record;
    } catch {
      // Sidecar history is evidence. A malformed historical line must not
      // make an otherwise valid newest materialization unsafe to inspect.
    }
  }
  return latest;
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
    const record = latestRecordForSession(readFileSync(path, "utf8"), session.id);
    return record
      ? projectRarebitSummaryRecord(record, session)
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

/**
 * Keeps the HTTP contract content-free even when a test or future adapter
 * provides an over-broad detail object. The server never serializes arbitrary
 * adapter fields.
 */
export function sanitizeRarebitSummaryDetail(detail) {
  const source = object(detail);
  return {
    availability: DETAIL_AVAILABILITIES.has(source.availability)
      ? source.availability
      : "unavailable",
    ...optionalString("reason", source.reason),
    ...optionalString("status", source.status),
    ...optionalString("jobId", source.jobId),
    ...optionalString("observedAt", source.observedAt),
    ...optionalRecord("selection", source.selection, sanitizeSelection),
    ...optionalRecord("eligibility", source.eligibility, sanitizeEligibility),
    ...optionalRecord("provenance", source.provenance, sanitizeProvenance),
    ...optionalString("summary", source.summary),
    ...optionalRecord("failure", source.failure, sanitizeFailure),
  };
}
