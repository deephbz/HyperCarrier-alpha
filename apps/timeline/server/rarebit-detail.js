import { readRarebitSession } from "@hypercarrier/rarebit/session";
import { readRarebitCurrent, rarebitSummaryPresentation } from "@hypercarrier/rarebit";

const DETAIL_AVAILABILITIES = new Set(["available", "missing", "unavailable"]);
const STATUSES = new Set(["user_requested", "finished", "needs_attention", "ineligible", "error"]);

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function string(value) {
  return typeof value === "string" ? value : null;
}
function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function nativeAvailability(error) {
  if (error?.code === "ENOENT") return "missing";
  return error?.name === "RarebitQueryError" &&
    /^Pi Session file not found:/.test(error?.message ?? "")
    ? "missing"
    : "unreadable";
}
function nativeSelection(selection) {
  return {
    ...selection,
    selectorVersion: selection?.selectorVersion ?? selection?.manifest?.selectorVersion,
  };
}

async function nativeArtifact(session) {
  try {
    const loaded = await readRarebitSession(session.source);
    return {
      availability: "available",
      sessionId: loaded.session.id,
      selection: nativeSelection(loaded.selection),
    };
  } catch (error) {
    return { availability: nativeAvailability(error) };
  }
}

function readerFailure(error) {
  const notAddressable =
    /outside the configured Session root|persisted Pi Session file is required/.test(
      error?.message ?? "",
    );
  return notAddressable
    ? { availability: "missing", reason: "sidecar_not_addressable" }
    : { availability: "unavailable", reason: "sidecar_reader_failed" };
}

async function currentArtifact(session, native, options) {
  try {
    return {
      current: await readRarebitCurrent({
        sessionFile: session.source,
        native,
        deadlineExpired: true,
        ...options,
      }),
    };
  } catch (error) {
    return { failure: readerFailure(error) };
  }
}

function compactSelection(receipt) {
  if (!receipt?.selection) return null;
  return {
    selectorVersion: string(receipt.selection.selectorVersion),
    manifestHash: string(receipt.selection.manifestHash),
    occurrenceCount: number(receipt.selection.occurrenceCount),
    uniquePayloadCount: number(receipt.selection.uniquePayloadCount),
  };
}

function compactModel(receipt) {
  return string(receipt?.model?.provider) && string(receipt?.model?.id)
    ? { provider: receipt.model.provider, id: receipt.model.id }
    : null;
}

function compactHead(head) {
  if (!head) return null;
  return {
    receiptOffset: number(head.receiptOffset),
    receiptLength: number(head.receiptLength),
    receiptHash: string(head.receiptHash),
  };
}

function projectCurrentArtifact(current) {
  const machine = current.artifactState;
  const receipt = current.receipt;
  const projection = machine?.projection;
  const sourcePending = new Set(["request_source_pending", "assessment_source_pending"]).has(
    machine?.syncState,
  );
  return {
    availability: current.availability === "unreadable" ? "unavailable" : current.availability,
    reason: projection?.reason ?? current.diagnostics?.reason ?? null,
    status: projection?.status ?? null,
    assessmentRef: projection?.assessmentRef ?? null,
    sourcePending,
    syncState: machine?.syncState ?? null,
    applicability: machine?.applicability ?? "none",
    schemaVersion: Number.isInteger(receipt?.schemaVersion) ? receipt.schemaVersion : null,
    jobId: string(receipt?.jobId),
    observedAt: string(receipt?.observedAt),
    selection: compactSelection(receipt),
    provenance: {
      model: compactModel(receipt),
      promptVersion: string(receipt?.promptVersion),
      implementationVersion: string(receipt?.implementationVersion),
      lifecycleBoundary: string(receipt?.lifecycleBoundary),
    },
    summary: typeof receipt?.summary === "string" ? receipt.summary : null,
    sidecar: {
      path: current.path,
      head: compactHead(current.head),
      diagnostics: object(current.diagnostics),
    },
  };
}

/**
 * The package owns bounded head reads, receipt selection, and native/receipt
 * applicability. Timeline only serializes its metadata-safe projection.
 */
export async function readSessionRarebitSummary(session, options = {}) {
  if (!session?.source || !session?.id)
    return { availability: "missing", reason: "sidecar_not_addressable" };
  const native = await nativeArtifact(session);
  const result = await currentArtifact(session, native, options);
  return result.failure ?? projectCurrentArtifact(result.current);
}

function safeAssessmentRef(value) {
  const ref = object(value);
  return {
    jobId: string(ref.jobId),
    sessionId: string(ref.sessionId),
    branchLeafId: string(ref.branchLeafId),
    selectionManifestHash: string(ref.selectionManifestHash),
    selectorVersion: string(ref.selectorVersion),
    lifecycleBoundary: string(ref.lifecycleBoundary),
    model:
      string(ref.model?.provider) && string(ref.model?.id)
        ? { provider: ref.model.provider, id: ref.model.id }
        : null,
    promptVersion: string(ref.promptVersion),
    implementationVersion: string(ref.implementationVersion),
    observedAt: string(ref.observedAt),
    schemaVersion: number(ref.schemaVersion),
  };
}
function safeDiagnostics(value) {
  const diagnostics = object(value);
  return {
    tornTail: diagnostics.tornTail === true,
    reason: string(diagnostics.reason),
    tailOffset: number(diagnostics.tailOffset),
  };
}
function source(detail) {
  return safeAssessmentRef(detail.assessmentRef);
}

/** The five-status projection is package-derived; prose never supplies status. */
export function projectRarebitSummaryStatus(detail) {
  const value = object(detail);
  const lineage = source(value);
  if (STATUSES.has(value.status)) {
    const sourcePending = value.sourcePending === true;
    return {
      state: "available",
      status: value.status,
      reason: string(value.reason),
      sourcePending,
      presentation: rarebitSummaryPresentation(value.status, { sourcePending }),
      source: lineage,
    };
  }
  if (value.availability !== "available")
    return {
      state: "unknown",
      reason: value.availability === "missing" ? "summary_missing" : "summary_unavailable",
      source: lineage,
    };
  if (!STATUSES.has(value.status))
    return { state: "unknown", reason: "summary_status_missing", source: lineage };
  throw new TypeError("Unreachable Summary status projection");
}

/** HTTP output remains metadata-safe even if a future package reader grows fields. */
export function sanitizeRarebitSummaryDetail(detail) {
  const value = object(detail);
  const sanitized = {
    availability: DETAIL_AVAILABILITIES.has(value.availability)
      ? value.availability
      : "unavailable",
    reason: string(value.reason),
    status: STATUSES.has(value.status) ? value.status : null,
    assessmentRef: safeAssessmentRef(value.assessmentRef),
    sourcePending: value.sourcePending === true,
    syncState: string(value.syncState),
    applicability: string(value.applicability),
    schemaVersion: number(value.schemaVersion),
    jobId: string(value.jobId),
    observedAt: string(value.observedAt),
    selection: value.selection
      ? {
          selectorVersion: string(value.selection.selectorVersion),
          manifestHash: string(value.selection.manifestHash),
          occurrenceCount: number(value.selection.occurrenceCount),
          uniquePayloadCount: number(value.selection.uniquePayloadCount),
        }
      : null,
    provenance: {
      model:
        string(value.provenance?.model?.provider) && string(value.provenance?.model?.id)
          ? { provider: value.provenance.model.provider, id: value.provenance.model.id }
          : null,
      promptVersion: string(value.provenance?.promptVersion),
      implementationVersion: string(value.provenance?.implementationVersion),
      lifecycleBoundary: string(value.provenance?.lifecycleBoundary),
    },
    summary: typeof value.summary === "string" ? value.summary : null,
    sidecar: {
      head: value.sidecar?.head
        ? {
            receiptOffset: number(value.sidecar.head.receiptOffset),
            receiptLength: number(value.sidecar.head.receiptLength),
            receiptHash: string(value.sidecar.head.receiptHash),
          }
        : null,
      diagnostics: safeDiagnostics(value.sidecar?.diagnostics),
    },
  };
  return { ...sanitized, summaryStatus: projectRarebitSummaryStatus(sanitized) };
}
