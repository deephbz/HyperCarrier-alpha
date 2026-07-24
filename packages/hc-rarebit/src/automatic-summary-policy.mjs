import { randomUUID } from "node:crypto";

export const RAREBIT_AUTOMATIC_SUMMARY_POLICY_CONTRACT =
  "rarebit-automatic-summary-policy/1";
export const RAREBIT_AUTOMATIC_SUMMARY_POLICY_EVENT =
  "rarebit:automatic-summary-policy-query";
export const DEFAULT_AUTOMATIC_SUMMARY_POLICY_TIMEOUT_MS = 100;
const MAX_PROVIDER_VALIDITY_MS = 5_000;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function finiteTime(value) {
  const millis = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(millis) ? millis : null;
}

function sanitizeOpaqueProvenance(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const identity = nonEmptyString(value.identity);
  const generation = nonEmptyString(value.generation);
  const association = nonEmptyString(value.association);
  if (!identity || !generation || !association) return null;
  return { identity, generation, association };
}

function validateResponse(response, query, receivedAt) {
  if (!response || typeof response !== "object" || Array.isArray(response))
    return { ok: false, reason: "malformed_response" };
  if (response.contractVersion !== RAREBIT_AUTOMATIC_SUMMARY_POLICY_CONTRACT)
    return { ok: false, reason: "incompatible_response" };
  if (response.queryId !== query.queryId)
    return { ok: false, reason: "uncorrelated_response" };
  if (response.decision !== "inhibit" && response.decision !== "abstain")
    return { ok: false, reason: "invalid_decision" };
  const provider = nonEmptyString(response.provider);
  const reason = nonEmptyString(response.reason);
  const observedAt = finiteTime(response.observedAt);
  const validUntil = finiteTime(response.validUntil);
  if (!provider || !reason || observedAt === null || validUntil === null)
    return { ok: false, reason: "malformed_response" };
  if (
    observedAt < query.issuedAtMillis ||
    observedAt > receivedAt ||
    validUntil < receivedAt ||
    validUntil <= observedAt ||
    validUntil - observedAt > MAX_PROVIDER_VALIDITY_MS
  )
    return { ok: false, reason: "stale_response" };
  const provenance =
    response.decision === "inhibit"
      ? sanitizeOpaqueProvenance(response.provenance)
      : null;
  if (response.decision === "inhibit" && !provenance)
    return { ok: false, reason: "malformed_inhibition_provenance" };
  return {
    ok: true,
    response: {
      contractVersion: RAREBIT_AUTOMATIC_SUMMARY_POLICY_CONTRACT,
      queryId: query.queryId,
      decision: response.decision,
      provider,
      reason,
      observedAt: new Date(observedAt).toISOString(),
      validUntil: new Date(validUntil).toISOString(),
      ...(provenance ? { provenance } : {}),
    },
  };
}

/**
 * Query the shared Pi extension event bus for one operation-specific negative
 * policy. Providers may inhibit or abstain; every other result fails open.
 */
export async function queryAutomaticSummaryPolicy(
  events,
  session,
  {
    timeoutMs = DEFAULT_AUTOMATIC_SUMMARY_POLICY_TIMEOUT_MS,
    now = () => Date.now(),
    queryId = `rarebit_policy_${randomUUID()}`,
  } = {},
) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
    throw new RangeError("automatic summary policy timeout must be positive");
  const sessionId = nonEmptyString(session?.sessionId);
  const durableAssociation = nonEmptyString(session?.durableAssociation);
  if (!sessionId || !durableAssociation || typeof events?.emit !== "function")
    return {
      decision: "abstain",
      queryStatus: "provider_absent",
      contractVersion: RAREBIT_AUTOMATIC_SUMMARY_POLICY_CONTRACT,
    };

  const issuedAtMillis = now();
  const deadlineMillis = issuedAtMillis + timeoutMs;
  const query = {
    contractVersion: RAREBIT_AUTOMATIC_SUMMARY_POLICY_CONTRACT,
    queryId,
    operation: "automatic_summary",
    session: { id: sessionId, durableAssociation },
    issuedAt: new Date(issuedAtMillis).toISOString(),
    deadlineAt: new Date(deadlineMillis).toISOString(),
    issuedAtMillis,
  };
  const received = [];
  let accepting = true;
  const respond = (response) => {
    const receivedAt = now();
    if (!accepting || receivedAt > deadlineMillis) return false;
    received.push(validateResponse(response, query, receivedAt));
    return true;
  };

  try {
    events.emit(RAREBIT_AUTOMATIC_SUMMARY_POLICY_EVENT, {
      contractVersion: query.contractVersion,
      queryId: query.queryId,
      operation: query.operation,
      session: query.session,
      issuedAt: query.issuedAt,
      deadlineAt: query.deadlineAt,
      respond,
    });
  } catch {
    accepting = false;
    return {
      decision: "abstain",
      queryStatus: "provider_failure",
      contractVersion: RAREBIT_AUTOMATIC_SUMMARY_POLICY_CONTRACT,
    };
  }

  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  accepting = false;
  if (received.some((entry) => !entry.ok))
    return {
      decision: "abstain",
      queryStatus: "invalid_response",
      contractVersion: RAREBIT_AUTOMATIC_SUMMARY_POLICY_CONTRACT,
    };
  const inhibitions = received
    .map((entry) => entry.response)
    .filter((response) => response.decision === "inhibit");
  if (inhibitions.length > 1)
    return {
      decision: "abstain",
      queryStatus: "conflict",
      contractVersion: RAREBIT_AUTOMATIC_SUMMARY_POLICY_CONTRACT,
    };
  if (inhibitions.length === 0)
    return {
      decision: "abstain",
      queryStatus:
        received.length === 0 ? "provider_absent" : "provider_abstained",
      contractVersion: RAREBIT_AUTOMATIC_SUMMARY_POLICY_CONTRACT,
    };
  const inhibition = inhibitions[0];
  const completedAt = now();
  if (finiteTime(inhibition.validUntil) <= completedAt)
    return {
      decision: "abstain",
      queryStatus: "stale_response",
      contractVersion: RAREBIT_AUTOMATIC_SUMMARY_POLICY_CONTRACT,
    };
  return {
    ...inhibition,
    queryStatus: "inhibited",
    queriedAt: new Date(completedAt).toISOString(),
  };
}

export function automaticSummaryInhibitionIdentity(
  inhibition,
  { now = () => Date.now() } = {},
) {
  const provenance = sanitizeOpaqueProvenance(inhibition?.provenance);
  const provider = nonEmptyString(inhibition?.provider);
  const reason = nonEmptyString(inhibition?.reason);
  const queryId = nonEmptyString(inhibition?.queryId);
  const observedAt = finiteTime(inhibition?.observedAt);
  const validUntil = finiteTime(inhibition?.validUntil);
  const queriedAt = finiteTime(inhibition?.queriedAt);
  const checkedAt = now();
  if (
    inhibition?.contractVersion !== RAREBIT_AUTOMATIC_SUMMARY_POLICY_CONTRACT ||
    inhibition?.decision !== "inhibit" ||
    inhibition?.queryStatus !== "inhibited" ||
    !queryId ||
    !provider ||
    !reason ||
    !provenance ||
    observedAt === null ||
    validUntil === null ||
    queriedAt === null ||
    observedAt > queriedAt ||
    queriedAt > checkedAt ||
    validUntil <= queriedAt ||
    validUntil <= checkedAt ||
    validUntil - observedAt > MAX_PROVIDER_VALIDITY_MS
  )
    return null;
  return {
    contractVersion: inhibition.contractVersion,
    provider,
    reason,
    provenance,
  };
}
