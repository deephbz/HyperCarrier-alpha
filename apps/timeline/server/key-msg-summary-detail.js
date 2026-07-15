import { readFileSync, statSync } from "node:fs";
import { defaultOutputPath } from "@hypercarrier/hc-key-msg-summary";

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
  if (source.kind && source.kind !== "key_message_summary_model_synthesis") return null;
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
 * Projects only the derived Key Message Summary record. In particular, it
 * intentionally omits sidecar path, sessionFile, branch records, selected
 * message prose, and all raw Session JSONL fields.
 */
export function projectKeyMessageSummaryRecord(record, session) {
  const selection = object(record.selection);
  const model = object(record.model);
  const modelProvenance = object(record.modelProvenance);
  const status = safeString(record.status) ?? "unknown";
  const lastMessageAt = finiteTimestamp(session.lastMessageAt);
  const summaryAsOf = finiteTimestamp(selection.asOf ?? record.validAt);
  const unavailable = status === "failure" || status === "unavailable_overflow";
  const stale =
    !unavailable && lastMessageAt !== null && (summaryAsOf === null || summaryAsOf < lastMessageAt);
  return {
    availability: unavailable ? "unavailable" : stale ? "stale" : "available",
    status,
    summaryId: safeString(record.summaryId),
    observedAt: safeString(record.observedAt),
    validAt: safeString(record.validAt),
    selection: {
      selectorVersion: safeString(selection.selectorVersion),
      dedupeVersion: safeString(selection.dedupeVersion),
      manifestHash: safeString(selection.manifestHash),
      occurrenceCount: Array.isArray(selection.occurrences) ? selection.occurrences.length : 0,
      uniquePayloadCount: Array.isArray(selection.payloads) ? selection.payloads.length : 0,
      asOf: safeString(selection.asOf),
      completeBranchProjection: selection.completeBranchProjection === true,
    },
    activation: {
      policyVersion: safeString(record.activation?.policyVersion),
      toolCallCount: safeNumber(record.activation?.toolCallCount),
      continuationCount: safeNumber(record.activation?.continuationCount),
      shouldSynthesize: record.activation?.shouldSynthesize === true,
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
      derivationVersion: safeString(record.derivationVersion),
      inputHash: safeString(record.inputHash),
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
        record?.type === "key_message_summary" &&
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
 * outside the native Pi sessions -> session-summaries mirror.
 */
export function readSessionKeyMessageSummary(session, options = {}) {
  let path;
  try {
    path = defaultOutputPath(session.source, options);
  } catch {
    return { availability: "missing", reason: "sidecar_not_addressable" };
  }
  try {
    if (statSync(path).size > (options.maxBytes ?? MAX_SIDECAR_BYTES))
      return { availability: "unavailable", reason: "sidecar_too_large" };
    const record = latestRecordForSession(readFileSync(path, "utf8"), session.id);
    return record
      ? projectKeyMessageSummaryRecord(record, session)
      : { availability: "missing", reason: "sidecar_missing" };
  } catch (error) {
    if (error?.code === "ENOENT") return { availability: "missing", reason: "sidecar_missing" };
    return { availability: "unavailable", reason: "sidecar_unreadable" };
  }
}

/**
 * Keeps the HTTP contract content-free even when a test or future adapter
 * provides an over-broad detail object. The server never serializes arbitrary
 * adapter fields.
 */
export function sanitizeKeyMessageSummaryDetail(detail) {
  const source = object(detail);
  const availability = ["available", "stale", "missing", "unavailable"].includes(
    source.availability,
  )
    ? source.availability
    : "unavailable";
  const result = { availability };
  if (typeof source.reason === "string") result.reason = source.reason;
  if (typeof source.status === "string") result.status = source.status;
  if (typeof source.summaryId === "string") result.summaryId = source.summaryId;
  if (typeof source.observedAt === "string") result.observedAt = source.observedAt;
  if (typeof source.validAt === "string") result.validAt = source.validAt;
  if (source.selection && typeof source.selection === "object") {
    result.selection = {
      selectorVersion: safeString(source.selection.selectorVersion),
      dedupeVersion: safeString(source.selection.dedupeVersion),
      manifestHash: safeString(source.selection.manifestHash),
      occurrenceCount: safeNumber(source.selection.occurrenceCount),
      uniquePayloadCount: safeNumber(source.selection.uniquePayloadCount),
      asOf: safeString(source.selection.asOf),
      completeBranchProjection: source.selection.completeBranchProjection === true,
    };
  }
  if (source.activation && typeof source.activation === "object") {
    result.activation = {
      policyVersion: safeString(source.activation.policyVersion),
      toolCallCount: safeNumber(source.activation.toolCallCount),
      continuationCount: safeNumber(source.activation.continuationCount),
      shouldSynthesize: source.activation.shouldSynthesize === true,
    };
  }
  if (source.provenance && typeof source.provenance === "object") {
    const provenance = source.provenance;
    result.provenance = {
      model:
        safeString(provenance.model?.provider) && safeString(provenance.model?.id)
          ? { provider: provenance.model.provider, id: provenance.model.id }
          : null,
      derivationVersion: safeString(provenance.derivationVersion),
      promptVersion: safeString(provenance.promptVersion),
      inputHash: safeString(provenance.inputHash),
      synthesis: provenance.synthesis ? projectSynthesis(provenance.synthesis) : null,
    };
  }
  if (typeof source.summary === "string") result.summary = source.summary;
  if (source.failure && typeof source.failure === "object")
    result.failure = {
      retryable: source.failure.retryable === true,
      kind: safeString(source.failure.kind),
    };
  return result;
}
