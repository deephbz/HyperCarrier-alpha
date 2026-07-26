import {
  RAREBIT_SESSION_STATUS_REASONS,
  RAREBIT_SUMMARY_LIFECYCLE_BOUNDARIES,
} from "./rarebit-core.mjs";

const ERROR_REASONS = new Set([
  "missing",
  "stale",
  "inhibited",
  "synthesis_failure",
  "malformed",
  "unsupported",
  "binding_failure",
  "overflow",
  "settlement_timeout",
  "native_missing",
  "native_unreadable",
  "native_malformed",
  "materialization_missing",
  "materialization_unreadable",
  "session_conflict",
]);

function assessmentRef(record) {
  return {
    jobId: record.jobId ?? null,
    sessionId: record.sessionId ?? null,
    branchLeafId: record.branch?.leafId ?? null,
    selectionManifestHash: record.selection?.manifestHash ?? null,
    selectorVersion: record.selection?.selectorVersion ?? null,
    lifecycleBoundary: record.lifecycleBoundary ?? null,
    promptVersion: record.promptVersion ?? null,
    model: record.model ?? null,
    observedAt: record.observedAt ?? null,
    schemaVersion: record.schemaVersion ?? null,
    implementationVersion: record.implementationVersion ?? null,
  };
}

function error(reason, record = null) {
  return {
    status: "error",
    reason,
    assessmentRef: record ? assessmentRef(record) : null,
  };
}

function isLegalV3Success(record) {
  return (
    record?.schemaVersion === 3 &&
    record?.status === "ok" &&
    typeof record.summary === "string" &&
    RAREBIT_SESSION_STATUS_REASONS[record.sessionStatus]?.includes(
      record.statusReason,
    ) &&
    RAREBIT_SUMMARY_LIFECYCLE_BOUNDARIES.includes(record.lifecycleBoundary) &&
    (record.lifecycleBoundary === "owner_request"
      ? record.sessionStatus === "user_requested" &&
        record.statusReason === "owner_request_recorded"
      : record.sessionStatus !== "user_requested")
  );
}

export function selectRarebitSummaryReceipt({ records, selection } = {}) {
  if (!selection?.manifestHash)
    throw new TypeError("A current Rarebit selection manifestHash is required");
  return newestExactSelectionRecord(records, selection.manifestHash);
}

function newestExactSelectionRecord(records, selectionManifestHash) {
  let newest = null;
  let newestAt = Number.NaN;
  for (const record of Array.isArray(records) ? records : []) {
    if (
      record?.type !== "rarebit_summary" ||
      record?.selection?.manifestHash !== selectionManifestHash
    )
      continue;
    const observedAt = Date.parse(record.observedAt);
    // Persisted observedAt is the semantic trigger-cut recency. Append order
    // only resolves equal or unavailable timestamps, so a delayed old job
    // cannot supersede a later settled assessment for this same selection.
    if (
      !newest ||
      (Number.isFinite(observedAt) &&
        (!Number.isFinite(newestAt) || observedAt >= newestAt)) ||
      (!Number.isFinite(observedAt) && !Number.isFinite(newestAt))
    ) {
      newest = record;
      newestAt = observedAt;
    }
  }
  return newest;
}

/**
 * Project the newest semantic trigger-cut Summary receipt matching one exact
 * current selection. The returned status is deliberately flat while
 * assessmentRef preserves the record lineage needed to inspect the raw
 * technical outcome.
 */
export function projectRarebitSessionStatus({
  records,
  selection,
  now = Date.now(),
  maxAgeMs = null,
} = {}) {
  const record = selectRarebitSummaryReceipt({ records, selection });
  if (!record) return error("missing");
  if (
    maxAgeMs !== null &&
    (!Number.isFinite(maxAgeMs) ||
      maxAgeMs < 0 ||
      !Number.isFinite(Date.parse(record.observedAt)) ||
      now - Date.parse(record.observedAt) > maxAgeMs)
  )
    return error("stale", record);
  if (record.schemaVersion !== 3) return error("unsupported", record);
  if (record.status === "ineligible")
    return {
      status: "ineligible",
      reason: "intrinsic_policy",
      assessmentRef: assessmentRef(record),
    };
  if (record.status === "inhibited") return error("inhibited", record);
  if (record.status === "failure") return error("synthesis_failure", record);
  if (record.status === "unavailable_overflow")
    return error("overflow", record);
  if (!isLegalV3Success(record)) return error("malformed", record);
  return {
    status: record.sessionStatus,
    reason: record.statusReason,
    assessmentRef: assessmentRef(record),
  };
}

export function isRarebitSessionStatus(value) {
  if (!value || typeof value !== "object") return false;
  if (value.status === "ineligible") return value.reason === "intrinsic_policy";
  return (
    (ERROR_REASONS.has(value.reason) && value.status === "error") ||
    RAREBIT_SESSION_STATUS_REASONS[value.status]?.includes(value.reason)
  );
}
