import {
  RAREBIT_SESSION_STATUS_REASONS,
  RAREBIT_SUMMARY_RECEIPT_LIFECYCLE_BOUNDARIES,
  sha256,
} from "./rarebit-core.mjs";

const TERMINAL_STATUSES = new Set([
  "ok",
  "ineligible",
  "inhibited",
  "unavailable_overflow",
  "failure",
]);
const AVAILABILITY = new Set(["available", "missing", "unreadable"]);
const EXPECTATIONS = new Set(["owner_request", "agent_settled", "snapshot"]);

function timestamp(value) {
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : Number.NEGATIVE_INFINITY;
}

function nullableString(value) {
  return typeof value === "string" ? value : null;
}

function modelRef(value) {
  return value &&
    typeof value.provider === "string" &&
    typeof value.id === "string"
    ? { provider: value.provider, id: value.id }
    : null;
}

function ref(record) {
  if (!record) return null;
  return {
    jobId: nullableString(record.jobId),
    sessionId: nullableString(record.sessionId),
    branchLeafId: nullableString(record.branch?.leafId),
    selectionManifestHash: nullableString(record.selection?.manifestHash),
    selectorVersion: nullableString(record.selection?.selectorVersion),
    lifecycleBoundary: nullableString(record.lifecycleBoundary),
    promptVersion: nullableString(record.promptVersion),
    model: modelRef(record.model),
    observedAt: nullableString(record.observedAt),
    schemaVersion: Number.isInteger(record.schemaVersion)
      ? record.schemaVersion
      : null,
    implementationVersion: nullableString(record.implementationVersion),
  };
}

function projection(record) {
  if (record.status === "ok")
    return {
      status: record.sessionStatus,
      reason: record.statusReason,
      assessmentRef: ref(record),
    };
  if (record.status === "ineligible")
    return {
      status: "ineligible",
      reason: "intrinsic_policy",
      assessmentRef: ref(record),
    };
  const reason = {
    inhibited: "inhibited",
    unavailable_overflow: "overflow",
    failure: "synthesis_failure",
  }[record.status];
  return { status: "error", reason, assessmentRef: ref(record) };
}

function isOccurrence(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.occurrenceId === "string" &&
    value.occurrenceId &&
    (typeof value.sourceEntryId === "string" || value.sourceEntryId === null) &&
    Number.isInteger(value.order) &&
    (value.role === "user" || value.role === "assistant") &&
    ["user", "stop", "continuation"].includes(value.outcome) &&
    typeof value.contentHash === "string" &&
    value.contentHash
  );
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, required, optional = []) {
  if (!plainObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function sha256String(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validSelection(selection, { request = false, compact = false } = {}) {
  if (compact) {
    if (
      !exactKeys(selection, [
        "manifestHash",
        "selectorVersion",
        "occurrenceCount",
        "uniquePayloadCount",
        "latestUserSourceEntryId",
      ]) ||
      !sha256String(selection.manifestHash) ||
      !nonEmptyString(selection.selectorVersion) ||
      !Number.isInteger(selection.occurrenceCount) ||
      selection.occurrenceCount < 0 ||
      !Number.isInteger(selection.uniquePayloadCount) ||
      selection.uniquePayloadCount < 0 ||
      selection.uniquePayloadCount > selection.occurrenceCount ||
      !(
        selection.latestUserSourceEntryId === null ||
        nonEmptyString(selection.latestUserSourceEntryId)
      )
    )
      return false;
    return !request || nonEmptyString(selection.latestUserSourceEntryId);
  }
  if (
    !selection ||
    !sha256String(selection.manifestHash) ||
    !nonEmptyString(
      selection.selectorVersion ?? selection.manifest?.selectorVersion,
    )
  )
    return false;
  const occurrences = selection.occurrences;
  if (!Array.isArray(occurrences) || !occurrences.every(isOccurrence))
    return false;
  const ids = new Set();
  for (const occurrence of occurrences) {
    if (!request && occurrence.sourceEntryId === null) continue;
    if (
      !nonEmptyString(occurrence.sourceEntryId) ||
      ids.has(occurrence.sourceEntryId)
    )
      return false;
    ids.add(occurrence.sourceEntryId);
  }
  if (!request) return true;
  const last = occurrences.at(-1);
  return last?.role === "user" && last.outcome === "user";
}

function validBranch(branch) {
  return (
    exactKeys(branch, ["leafId", "entryCount", "pathHash"]) &&
    (branch.leafId === null || nonEmptyString(branch.leafId)) &&
    Number.isInteger(branch.entryCount) &&
    branch.entryCount >= 0 &&
    sha256String(branch.pathHash)
  );
}

function validModel(model) {
  return (
    model === null ||
    (exactKeys(model, ["provider", "id"]) &&
      nonEmptyString(model.provider) &&
      nonEmptyString(model.id))
  );
}

function validModelProvenance(value) {
  return (
    exactKeys(value, ["source", "status"], ["settingsKey"]) &&
    nonEmptyString(value.source) &&
    nonEmptyString(value.status) &&
    (!Object.hasOwn(value, "settingsKey") || nonEmptyString(value.settingsKey))
  );
}

function validError(value) {
  return (
    exactKeys(value, ["name", "message"]) &&
    nonEmptyString(value.name) &&
    typeof value.message === "string"
  );
}

function validOverflow(value) {
  return (
    exactKeys(value, ["promptChars", "maxPromptChars", "strategy"]) &&
    Number.isInteger(value.promptChars) &&
    value.promptChars >= 0 &&
    Number.isInteger(value.maxPromptChars) &&
    value.maxPromptChars > 0 &&
    value.strategy === "none"
  );
}

function validInputCoveragePolicy(value) {
  return (
    exactKeys(value, ["strategy", "maxPromptChars"]) &&
    value.strategy === "complete_or_explicit_overflow" &&
    Number.isInteger(value.maxPromptChars) &&
    value.maxPromptChars > 0
  );
}

function nullableStringValue(value) {
  return value === null || typeof value === "string";
}

function nullableNonNegative(value) {
  return value === null || (Number.isFinite(value) && value >= 0);
}

function validSynthesisReceipt(value) {
  const providerKeys = [
    "responseProvider",
    "responseProviderSource",
    "responseModel",
    "responseModelSource",
    "responseId",
    "responseIdSource",
    "requestId",
    "requestIdSource",
  ];
  const usageKeys = [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
    "estimatedCostUsd",
  ];
  return (
    exactKeys(value, [
      "schemaVersion",
      "kind",
      "outcome",
      "requestedModel",
      "timing",
      "provider",
      "usage",
    ]) &&
    value.schemaVersion === 1 &&
    value.kind === "rarebit_model_synthesis" &&
    nonEmptyString(value.outcome) &&
    validModel(value.requestedModel) &&
    exactKeys(value.timing, [
      "startedAt",
      "completedAt",
      "durationMs",
      "provenance",
    ]) &&
    nullableStringValue(value.timing.startedAt) &&
    nullableStringValue(value.timing.completedAt) &&
    nullableNonNegative(value.timing.durationMs) &&
    value.timing.provenance === "local_monotonic_clock" &&
    exactKeys(value.provider, providerKeys) &&
    providerKeys.every((key) => nullableStringValue(value.provider[key])) &&
    exactKeys(value.usage, ["availability", ...usageKeys, "provenance"]) &&
    ["unavailable", "partial", "reported"].includes(value.usage.availability) &&
    usageKeys.every((key) => nullableNonNegative(value.usage[key])) &&
    exactKeys(value.usage.provenance, usageKeys) &&
    usageKeys.every((key) => nullableStringValue(value.usage.provenance[key]))
  );
}

function validAutomaticSummaryPolicy(value) {
  return (
    exactKeys(value, [
      "contractVersion",
      "decision",
      "queryStatus",
      "queryId",
      "provider",
      "reason",
      "observedAt",
      "validUntil",
      "queriedAt",
      "provenance",
    ]) &&
    value.contractVersion === "rarebit-automatic-summary-policy/1" &&
    value.decision === "inhibit" &&
    value.queryStatus === "inhibited" &&
    [
      value.queryId,
      value.provider,
      value.reason,
      value.observedAt,
      value.validUntil,
      value.queriedAt,
    ].every(nonEmptyString) &&
    exactKeys(value.provenance, ["identity", "generation", "association"]) &&
    [
      value.provenance.identity,
      value.provenance.generation,
      value.provenance.association,
    ].every(nonEmptyString)
  );
}

/** Validate the exact schema-v4 Summary receipt without consulting prose. */
export function validateRarebitArtifactReceipt(record) {
  const common = [
    "schemaVersion",
    "type",
    "status",
    "jobId",
    "sessionId",
    "branch",
    "observedAt",
    "selection",
    "lifecycleBoundary",
    "implementationVersion",
    "synthesisMode",
    "inputCoveragePolicy",
    "promptVersion",
    "model",
    "modelProvenance",
  ];
  const variantKeys = {
    ok: ["summary", "sessionStatus", "statusReason", "synthesis"],
    ineligible: [],
    inhibited: ["automaticSummaryPolicy"],
    unavailable_overflow: ["overflow"],
    failure: ["retryable", "error"],
  };
  if (
    !plainObject(record) ||
    !TERMINAL_STATUSES.has(record.status) ||
    !exactKeys(record, [...common, ...variantKeys[record.status]]) ||
    record.type !== "rarebit_summary" ||
    record.schemaVersion !== 4 ||
    !sha256String(record.jobId) ||
    !nonEmptyString(record.sessionId) ||
    record.implementationVersion !== "hc-rarebit-summary-v4" ||
    !nonEmptyString(record.promptVersion) ||
    !validBranch(record.branch) ||
    !validSelection(record.selection, {
      request: record.lifecycleBoundary === "owner_request",
      compact: true,
    }) ||
    !RAREBIT_SUMMARY_RECEIPT_LIFECYCLE_BOUNDARIES.includes(
      record.lifecycleBoundary,
    ) ||
    !nonEmptyString(record.observedAt) ||
    !Number.isFinite(Date.parse(record.observedAt)) ||
    !["forced", "automatic"].includes(record.synthesisMode) ||
    !validInputCoveragePolicy(record.inputCoveragePolicy) ||
    !validModel(record.model) ||
    !validModelProvenance(record.modelProvenance)
  )
    return { valid: false, reason: "malformed" };

  if (
    record.status === "inhibited" &&
    !validAutomaticSummaryPolicy(record.automaticSummaryPolicy)
  )
    return { valid: false, reason: "malformed" };
  if (record.status === "failure") {
    if (typeof record.retryable !== "boolean" || !validError(record.error))
      return { valid: false, reason: "malformed" };
    return { valid: true, record };
  }
  if (record.status === "unavailable_overflow") {
    if (!validOverflow(record.overflow))
      return { valid: false, reason: "malformed" };
    return { valid: true, record };
  }
  if (record.status !== "ok") return { valid: true, record };
  if (
    typeof record.summary !== "string" ||
    !record.summary.trim() ||
    !validSynthesisReceipt(record.synthesis)
  )
    return { valid: false, reason: "malformed" };
  const legal = RAREBIT_SESSION_STATUS_REASONS[record.sessionStatus]?.includes(
    record.statusReason,
  );
  const owner = record.lifecycleBoundary === "owner_request";
  if (
    !legal ||
    (owner &&
      (record.sessionStatus !== "user_requested" ||
        record.statusReason !== "owner_request_recorded")) ||
    (!owner && record.sessionStatus === "user_requested")
  )
    return { valid: false, reason: "malformed" };
  return { valid: true, record };
}

export function validateRarebitTitleReceipt(record) {
  const common = [
    "schemaVersion",
    "type",
    "status",
    "jobId",
    "implementationVersion",
    "sessionId",
    "branch",
    "selectionManifestHash",
    "titleEvidence",
    "promptVersion",
    "model",
    "modelProvenance",
    "applicationMode",
    "priorTitle",
    "title",
    "observedAt",
  ];
  const resultKeys =
    record?.status === "failure" ? ["retryable", "error"] : ["synthesis"];
  if (
    !plainObject(record) ||
    ![
      "proposal",
      "applied",
      "skipped_session_changed",
      "skipped_title_changed",
      "skipped_existing_title",
      "failure",
    ].includes(record.status) ||
    !exactKeys(record, [...common, ...resultKeys]) ||
    record.schemaVersion !== 4 ||
    record.type !== "rarebit_title" ||
    !sha256String(record.jobId) ||
    record.implementationVersion !== "hc-rarebit-title-v4" ||
    !nonEmptyString(record.sessionId) ||
    !validBranch(record.branch) ||
    !sha256String(record.selectionManifestHash) ||
    !exactKeys(record.titleEvidence, ["provenance", "sourceEntryId"]) ||
    !nonEmptyString(record.titleEvidence.provenance) ||
    !(
      record.titleEvidence.sourceEntryId === null ||
      nonEmptyString(record.titleEvidence.sourceEntryId)
    ) ||
    !nonEmptyString(record.promptVersion) ||
    !validModel(record.model) ||
    !validModelProvenance(record.modelProvenance) ||
    !["apply", "proposal"].includes(record.applicationMode) ||
    !(record.priorTitle === null || typeof record.priorTitle === "string") ||
    !nonEmptyString(record.observedAt) ||
    !Number.isFinite(Date.parse(record.observedAt))
  )
    return { valid: false, reason: "malformed" };
  if (record.status === "failure") {
    if (
      record.title !== null ||
      typeof record.retryable !== "boolean" ||
      !validError(record.error)
    )
      return { valid: false, reason: "malformed" };
    return { valid: true, record };
  }
  const titleExpected =
    record.status === "proposal" || record.status === "applied";
  if (
    (titleExpected ? !nonEmptyString(record.title) : record.title !== null) ||
    !validSynthesisReceipt(record.synthesis)
  )
    return { valid: false, reason: "malformed" };
  return { valid: true, record };
}

function prefixManifest(selection, count) {
  if (
    !Array.isArray(selection?.occurrences) ||
    !Array.isArray(selection?.payloads)
  )
    return null;
  const occurrences = selection.occurrences
    .slice(0, count)
    .map(({ text, ...value }) => value);
  const ids = new Set(occurrences.map((occurrence) => occurrence.occurrenceId));
  const payloads = selection.payloads
    .map(({ text, ...payload }) => ({
      ...payload,
      occurrenceIds: payload.occurrenceIds.filter((id) => ids.has(id)),
    }))
    .filter((payload) => payload.occurrenceIds.length);
  return sha256({
    selectorVersion:
      selection.selectorVersion ?? selection.manifest?.selectorVersion,
    occurrences,
    payloads,
  });
}

export function exactSelectionApplies(receiptSelection, selection) {
  return (
    receiptSelection?.manifestHash === selection?.manifestHash &&
    receiptSelection?.selectorVersion ===
      (selection?.selectorVersion ?? selection?.manifest?.selectorVersion)
  );
}
export function requestPrefixApplies(receiptSelection, selection) {
  if (
    receiptSelection?.selectorVersion !==
    (selection?.selectorVersion ?? selection?.manifest?.selectorVersion)
  )
    return false;
  const count = receiptSelection?.occurrenceCount;
  return (
    Number.isInteger(count) &&
    count <= selection.occurrences.length &&
    prefixManifest(selection, count) === receiptSelection.manifestHash &&
    selection.occurrences
      .filter(
        (occurrence) =>
          occurrence.role === "user" && occurrence.outcome === "user",
      )
      .at(-1)?.sourceEntryId === receiptSelection.latestUserSourceEntryId
  );
}

function newerThan(left, right) {
  if (!right) return true;
  const leftAt = timestamp(left.record.observedAt);
  const rightAt = timestamp(right.record.observedAt);
  return leftAt > rightAt || (leftAt === rightAt && left.index > right.index);
}

function newest(records) {
  return records.reduce(
    (best, candidate) =>
      !best || newerThan(candidate, best) ? candidate : best,
    null,
  );
}

function retry(reason, deadlineExpired) {
  return { recommended: !deadlineExpired, reason, deadlineExpired };
}

function result({
  syncState,
  projection: projected = null,
  applicability = "none",
  nativeRef = null,
  receiptRef = null,
  retry: retryValue = null,
} = {}) {
  return {
    syncState,
    projection: projected,
    applicability,
    nativeRef,
    receiptRef,
    retry: retryValue,
  };
}

function terminalError(reason, input, receipt = null) {
  return result({
    syncState: "terminal_error",
    projection: { status: "error", reason, assessmentRef: ref(receipt) },
    nativeRef: nativeReference(input.native),
    receiptRef: ref(receipt),
    retry: retry(reason, true),
  });
}

function nativeReference(native) {
  return {
    availability: native?.availability ?? "missing",
    sessionId: native?.sessionId ?? null,
    selectionManifestHash: native?.selection?.manifestHash ?? null,
  };
}

/**
 * Compose native active-branch evidence and append-only materialization history.
 * The result is deliberately a producer projection: consumers do not walk
 * selection ancestry, inspect receipt prose, or infer artifact identity.
 */
export function projectRarebitArtifactState({
  native = { availability: "missing" },
  materialization = { availability: "missing", records: [] },
  expectation = "snapshot",
  deadlineExpired = false,
} = {}) {
  if (
    !AVAILABILITY.has(native.availability) ||
    !AVAILABILITY.has(materialization.availability)
  )
    throw new TypeError(
      "native and materialization availability must be available, missing, or unreadable",
    );
  if (!EXPECTATIONS.has(expectation))
    throw new TypeError("Unsupported Rarebit artifact expectation");
  const records = Array.isArray(materialization.records)
    ? materialization.records
    : [];
  const parsed = records.map((record, index) => ({
    record,
    index,
    ...validateRarebitArtifactReceipt(record),
  }));
  const valid = parsed.filter((candidate) => candidate.valid);
  const invalidReason = parsed.some(
    ({ record, valid: isValid }) =>
      !isValid &&
      record?.type === "rarebit_summary" &&
      record.schemaVersion !== 4,
  )
    ? "unsupported"
    : parsed.some(
          ({ record, valid: isValid }) =>
            !isValid && record?.type === "rarebit_summary",
        )
      ? "malformed"
      : null;
  const sidecarSessionIds = new Set(
    records
      .filter(
        (record) =>
          record?.type === "rarebit_summary" &&
          typeof record.sessionId === "string" &&
          record.sessionId,
      )
      .map((record) => record.sessionId),
  );
  if (sidecarSessionIds.size > 1)
    return terminalError("session_conflict", { native });
  const sidecarSessionId = [...sidecarSessionIds][0] ?? null;

  const materializationUnreadable =
    materialization.availability === "unreadable";

  const nativeAvailable = native.availability === "available";
  if (
    nativeAvailable &&
    (!native.sessionId || !validSelection(native.selection))
  )
    return terminalError("native_malformed", { native });
  if (
    nativeAvailable &&
    sidecarSessionId &&
    sidecarSessionId !== native.sessionId
  )
    return terminalError("session_conflict", { native });

  if (!nativeAvailable) {
    const candidates = valid.filter(({ record }) =>
      expectation === "owner_request"
        ? record.lifecycleBoundary === "owner_request"
        : expectation === "agent_settled"
          ? record.lifecycleBoundary === "agent_settled"
          : true,
    );
    const chosen = newest(candidates);
    const opposing = newest(
      valid.filter(({ record }) =>
        expectation === "owner_request"
          ? record.lifecycleBoundary === "agent_settled"
          : expectation === "agent_settled"
            ? record.lifecycleBoundary === "owner_request"
            : false,
      ),
    );
    if (chosen && (expectation === "snapshot" || newerThan(chosen, opposing))) {
      const state =
        chosen.record.lifecycleBoundary === "owner_request"
          ? "request_source_pending"
          : "assessment_source_pending";
      return result({
        syncState: state,
        projection: projection(chosen.record),
        applicability:
          chosen.record.lifecycleBoundary === "owner_request"
            ? "request_cut"
            : "materialization_only",
        nativeRef: nativeReference(native),
        receiptRef: ref(chosen.record),
        retry: retry("native_source_pending", deadlineExpired),
      });
    }
    if (!deadlineExpired)
      return result({
        syncState: "awaiting_artifacts",
        nativeRef: nativeReference(native),
        retry: retry(
          materializationUnreadable
            ? "materialization_unreadable"
            : native.availability === "unreadable"
              ? "native_unreadable"
              : "native_missing",
          false,
        ),
      });
    return terminalError(
      invalidReason ??
        (materializationUnreadable
          ? "materialization_unreadable"
          : native.availability === "unreadable"
            ? "native_unreadable"
            : "native_missing"),
      { native },
    );
  }

  const current = valid.filter(
    ({ record }) => record.sessionId === native.sessionId,
  );
  const exact = current.filter(({ record }) =>
    exactSelectionApplies(record.selection, native.selection),
  );
  const requests = current.filter(
    ({ record }) =>
      record.lifecycleBoundary === "owner_request" &&
      requestPrefixApplies(record.selection, native.selection),
  );
  const activeRequest = newest(requests);
  const settled = newest(
    exact.filter(({ record }) => record.lifecycleBoundary === "agent_settled"),
  );
  if (settled && (!activeRequest || newerThan(settled, activeRequest)))
    return result({
      syncState: "assessment_current",
      projection: projection(settled.record),
      applicability: "exact_selection",
      nativeRef: nativeReference(native),
      receiptRef: ref(settled.record),
      retry: null,
    });
  if (activeRequest) {
    const cutLength = activeRequest.record.selection.occurrenceCount;
    const settlementPending = native.selection.occurrences
      .slice(cutLength)
      .some(
        (occurrence) =>
          occurrence.role === "assistant" && occurrence.outcome === "stop",
      );
    return result({
      syncState: settlementPending ? "settlement_pending" : "request_current",
      projection: projection(activeRequest.record),
      applicability: "request_generation",
      nativeRef: nativeReference(native),
      receiptRef: ref(activeRequest.record),
      retry: settlementPending
        ? retry("settlement_pending", deadlineExpired)
        : null,
    });
  }
  const assessment = newest(
    exact.filter(({ record }) => record.lifecycleBoundary !== "owner_request"),
  );
  if (assessment)
    return result({
      syncState: "assessment_current",
      projection: projection(assessment.record),
      applicability: "exact_selection",
      nativeRef: nativeReference(native),
      receiptRef: ref(assessment.record),
      retry: null,
    });
  if (!deadlineExpired)
    return result({
      syncState: "awaiting_artifacts",
      nativeRef: nativeReference(native),
      retry: retry(
        materializationUnreadable
          ? "materialization_unreadable"
          : "materialization_pending",
        false,
      ),
    });
  return terminalError(
    invalidReason ??
      (materializationUnreadable
        ? "materialization_unreadable"
        : materialization.availability === "missing"
          ? "materialization_missing"
          : "settlement_timeout"),
    { native },
  );
}
