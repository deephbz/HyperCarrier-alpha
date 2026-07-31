export type RarebitModel = { provider: string; id: string };

export type RarebitAutomaticSummaryPolicyDecision =
  | {
      contractVersion: "rarebit-automatic-summary-policy/1";
      decision: "inhibit";
      queryStatus: "inhibited";
      queryId: string;
      provider: string;
      reason: string;
      observedAt: string;
      validUntil: string;
      queriedAt: string;
      provenance: {
        identity: string;
        generation: string;
        association: string;
      };
    }
  | {
      contractVersion: "rarebit-automatic-summary-policy/1";
      decision: "abstain";
      queryStatus: string;
    };

export type RarebitSummaryPolicy = {
  policyVersion?: string;
  measurementVersion?: string;
  minTotalLength?: number;
  minTotalLengthUnit?: "estimated_tokens_chars_div_4_ceil";
  maxRarebitRatio?: number;
};

export type RarebitMeasurement = {
  measurementVersion: string;
  rawUnit: "utf16_code_units_of_human_readable_message_text";
  estimateMethod: "ceil(chars_div_4)";
  totalMessageProseChars: number;
  rarebitChars: number;
  estimatedTotalTokens: number;
  estimatedRarebitTokens: number;
  rarebitRatio: number | null;
  rarebitOccurrenceCount: number;
};

export type RarebitSessionStatus =
  | { status: "user_requested"; reason: "owner_request_recorded" }
  | { status: "finished"; reason: "all_requests_accomplished" }
  | {
      status: "needs_attention";
      reason:
        | "decision"
        | "input"
        | "approval"
        | "blocker"
        | "unfinished"
        | "uncertain"
        | "conflicting_evidence";
    }
  | { status: "ineligible"; reason: "intrinsic_policy" }
  | {
      status: "error";
      reason:
        | "missing"
        | "stale"
        | "inhibited"
        | "synthesis_failure"
        | "malformed"
        | "unsupported"
        | "binding_failure"
        | "overflow"
        | "settlement_timeout"
        | "native_missing"
        | "native_unreadable"
        | "native_malformed"
        | "materialization_missing"
        | "materialization_unreadable"
        | "session_conflict";
    };

export type RarebitSummarySynthesis = {
  summary: string;
  sessionStatus: "user_requested" | "finished" | "needs_attention";
  statusReason:
    | "owner_request_recorded"
    | "all_requests_accomplished"
    | "decision"
    | "input"
    | "approval"
    | "blocker"
    | "unfinished"
    | "uncertain"
    | "conflicting_evidence";
};

export type RarebitOccurrence = {
  occurrenceId: string;
  sourceEntryId: string | null;
  order: number;
  role: "user" | "assistant";
  outcome: "user" | "stop" | "continuation";
  producer: string | null;
  timestamp: string | null;
  contentHash: string;
  text: string;
};

export type RarebitSessionActivityOccurrence = {
  sourceEntryId: string | null;
  timestamp: string | null;
};
export type RarebitSessionActivity = {
  schemaVersion: 1;
  selectorVersion: string | null;
  selectionManifestHash: string | null;
  latestUser: RarebitSessionActivityOccurrence | null;
  latestAgentStop: RarebitSessionActivityOccurrence | null;
};
export function projectRarebitSessionActivity(selection: {
  occurrences?: RarebitOccurrence[];
  manifest?: { selectorVersion?: string };
  manifestHash?: string;
}): RarebitSessionActivity;

export type RarebitVisualTone =
  | "neutral"
  | "user"
  | "continuation"
  | "boundary"
  | "attention"
  | "diagnostic"
  | "muted";
export type RarebitEventKind =
  "user_message" | "agent_continuation" | "agent_stop" | "terminal_error";
export type RarebitVisualPresentation = {
  mark: string | null;
  label: string;
  tone: RarebitVisualTone;
  salience:
    | "standard"
    | "smaller"
    | "larger"
    | "ordinary"
    | "attention"
    | "muted"
    | "diagnostic";
};
export const RAREBIT_EVENT_PRESENTATION: Readonly<
  Record<RarebitEventKind, Readonly<RarebitVisualPresentation>>
>;
export const RAREBIT_SUMMARY_PRESENTATION: Readonly<
  Record<RarebitSessionStatus["status"], Readonly<RarebitVisualPresentation>>
>;
export function rarebitEventPresentation(
  kind: RarebitEventKind,
): Readonly<RarebitVisualPresentation>;
export function rarebitOccurrencePresentation(
  occurrence: Pick<RarebitOccurrence, "role" | "outcome">,
): Readonly<RarebitVisualPresentation>;
export function rarebitSummaryPresentation(
  status: RarebitSessionStatus["status"],
  options?: { sourcePending?: boolean },
): Readonly<RarebitVisualPresentation>;

export function selectRarebits(branch: unknown[]): {
  occurrences: RarebitOccurrence[];
  payloads: Array<{
    contentHash: string;
    text: string;
    occurrenceIds: string[];
  }>;
  manifest: Record<string, unknown>;
  manifestHash: string;
};
export function measureRarebits(
  branch: unknown[],
  selection?: ReturnType<typeof selectRarebits>,
): RarebitMeasurement;
export function evaluateRarebitSummaryEligibility(
  measurement: RarebitMeasurement,
  policy?: RarebitSummaryPolicy,
): {
  eligible: boolean;
  reasons: string[];
  policy: Required<RarebitSummaryPolicy>;
  measurement: RarebitMeasurement;
};
export type RarebitSummaryInputCoverage = {
  totalMessageCount: number;
  includedMessageCount: number;
  omittedMessageCount: number;
  omittedTextChars: number;
  promptChars: number;
  complete: boolean;
};
export function composeRarebitSummaryDerivationInput(
  selection: ReturnType<typeof selectRarebits>,
  options?: {
    promptVersion?: string;
    lifecycleBoundary?: "owner_request" | "agent_settled" | "manual";
    maxPromptChars?: number;
  },
): { prompt: string; coverage: RarebitSummaryInputCoverage };
export function composeRarebitSummaryPrompt(
  selection: ReturnType<typeof selectRarebits>,
  options?: {
    promptVersion?: string;
    lifecycleBoundary?: "owner_request" | "agent_settled" | "manual";
    maxPromptChars?: number;
  },
): string;
export function composeRarebitTitlePrompt(
  selection: ReturnType<typeof selectRarebits>,
): string;
export function normalizeRarebitSummary(value: unknown): string;
export function normalizeRarebitSummarySynthesis(
  value: unknown,
  options?: { maxChars?: number },
): RarebitSummarySynthesis;
export function normalizeRarebitTitle(value: unknown): string;
export function titleWithDatePrefix(
  value: unknown,
  options: { date: string; maxChars?: number },
): string;
export type RarebitBranchRef = {
  leafId: string | null;
  entryCount: number;
  pathHash: string;
};
export type RarebitSelectionRef = {
  manifestHash: string;
  selectorVersion: string;
  occurrenceCount: number;
  uniquePayloadCount: number;
  latestUserSourceEntryId: string | null;
};
export type RarebitModelProvenance = {
  source: string;
  status: string;
  settingsKey?: string;
};
export type RarebitInputCoveragePolicy = {
  strategy:
    | "complete_or_explicit_overflow"
    | "newest_suffix_with_explicit_omission";
  maxPromptChars: number;
};
export type RarebitSynthesisReceipt = {
  schemaVersion: 1;
  kind: "rarebit_model_synthesis";
  outcome: string;
  requestedModel: RarebitModel | null;
  timing: {
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    provenance: "local_monotonic_clock";
  };
  provider: {
    responseProvider: string | null;
    responseProviderSource: string | null;
    responseModel: string | null;
    responseModelSource: string | null;
    responseId: string | null;
    responseIdSource: string | null;
    requestId: string | null;
    requestIdSource: string | null;
  };
  usage: {
    availability: "unavailable" | "partial" | "reported";
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    reasoningTokens: number | null;
    estimatedCostUsd: number | null;
    provenance: {
      inputTokens: string | null;
      outputTokens: string | null;
      totalTokens: string | null;
      cacheReadTokens: string | null;
      cacheWriteTokens: string | null;
      reasoningTokens: string | null;
      estimatedCostUsd: string | null;
    };
  };
};
type RarebitSummaryReceiptCommon = {
  schemaVersion: 4;
  type: "rarebit_summary";
  jobId: string;
  sessionId: string;
  branch: RarebitBranchRef;
  observedAt: string;
  selection: RarebitSelectionRef;
  lifecycleBoundary:
    "owner_request" | "agent_settled" | "session_start" | "manual";
  implementationVersion:
    | "hc-rarebit-summary-v4"
    | "hc-rarebit-summary-v5"
    | "hc-rarebit-summary-v6";
  synthesisMode: "forced" | "automatic";
  inputCoveragePolicy: RarebitInputCoveragePolicy;
  promptVersion: string;
  model: RarebitModel | null;
  modelProvenance: RarebitModelProvenance;
};
export type RarebitSummaryReceiptV4 =
  | (RarebitSummaryReceiptCommon & {
      status: "ok";
      summary: string;
      sessionStatus: "user_requested" | "finished" | "needs_attention";
      statusReason:
        | "owner_request_recorded"
        | "all_requests_accomplished"
        | "decision"
        | "input"
        | "approval"
        | "blocker"
        | "unfinished"
        | "uncertain"
        | "conflicting_evidence";
      inputCoverage?: RarebitSummaryInputCoverage;
      synthesis: RarebitSynthesisReceipt;
    })
  | (RarebitSummaryReceiptCommon & { status: "ineligible" })
  | (RarebitSummaryReceiptCommon & {
      status: "inhibited";
      automaticSummaryPolicy: Extract<
        RarebitAutomaticSummaryPolicyDecision,
        { decision: "inhibit" }
      >;
    })
  | (RarebitSummaryReceiptCommon & {
      status: "unavailable_overflow";
      overflow: {
        promptChars: number;
        maxPromptChars: number;
        strategy: "none" | "fixed_contract_exceeds_limit";
      };
    })
  | (RarebitSummaryReceiptCommon & {
      status: "failure";
      retryable: boolean;
      error: { name: string; message: string };
    });
export type RarebitHeadV1 = {
  type: "rarebit_head";
  protocolVersion: 1;
  sessionId: string;
  receiptOffset: number;
  receiptLength: number;
  receiptHash: string;
};
export type RarebitNativeObservation =
  | {
      availability: "available";
      sessionId: string;
      selection: ReturnType<typeof selectRarebits> & {
        selectorVersion: string;
      };
    }
  | { availability: "missing" | "unreadable" };

export const RAREBIT_SUMMARY_SCHEMA_VERSION: 4;
export const RAREBIT_SUMMARY_IMPLEMENTATION_VERSION: "hc-rarebit-summary-v6";
export function processRarebitSummary(
  ctx: unknown,
  config?: {
    model?: RarebitModel;
    summaryPolicy?: RarebitSummaryPolicy;
    forceSynthesis?: boolean;
    // New derivation accepts only evidence-transition or explicit boundaries;
    // RarebitSummaryReceiptV4 retains session_start for historical reads.
    lifecycleBoundary?: "owner_request" | "agent_settled" | "manual";
    queryAutomaticSummaryPolicy?: (session: {
      sessionId: string;
      durableAssociation: string | null;
    }) => Promise<RarebitAutomaticSummaryPolicyDecision>;
    modelClient?: {
      complete(request: {
        prompt: string;
        model: RarebitModel;
      }): Promise<unknown>;
    };
  },
): Promise<{
  duplicate: boolean;
  inFlight?: boolean;
  skipped?: boolean;
  record:
    | (RarebitSummaryReceiptV4 & { path?: string })
    | {
        schemaVersion: 4;
        type: "rarebit_summary";
        status: "skipped_ephemeral_session";
        reason: "ephemeral_session";
        jobId: string;
        sessionId: string;
      };
}>;
export type RarebitSessionAssessmentRef = {
  jobId: string | null;
  sessionId: string | null;
  branchLeafId: string | null;
  selectionManifestHash: string | null;
  selectorVersion: string | null;
  lifecycleBoundary: string | null;
  promptVersion: string | null;
  model: RarebitModel | null;
  observedAt: string | null;
  schemaVersion: number | null;
  implementationVersion: string | null;
};

export type RarebitArtifactAvailability =
  "available" | "missing" | "unreadable";
export type RarebitArtifactSyncState =
  | "awaiting_artifacts"
  | "request_source_pending"
  | "request_current"
  | "settlement_pending"
  | "assessment_source_pending"
  | "assessment_current"
  | "terminal_error";
export type RarebitArtifactApplicability =
  | "none"
  | "request_cut"
  | "request_generation"
  | "exact_selection"
  | "materialization_only";
export type RarebitArtifactState = {
  syncState: RarebitArtifactSyncState;
  projection:
    | (RarebitSessionStatus & {
        assessmentRef: RarebitSessionAssessmentRef | null;
      })
    | null;
  applicability: RarebitArtifactApplicability;
  nativeRef: {
    availability: RarebitArtifactAvailability;
    sessionId: string | null;
    selectionManifestHash: string | null;
  } | null;
  receiptRef: RarebitSessionAssessmentRef | null;
  retry: {
    recommended: boolean;
    reason: string;
    deadlineExpired: boolean;
  } | null;
};
export function validateRarebitArtifactReceipt(
  record: unknown,
):
  | { valid: true; record: RarebitSummaryReceiptV4 }
  | { valid: false; reason: "malformed" };
export function projectRarebitArtifactState(input?: {
  native?: RarebitNativeObservation;
  materialization?: {
    availability: RarebitArtifactAvailability;
    records: unknown[];
  };
  expectation?: "owner_request" | "agent_settled" | "snapshot";
  deadlineExpired?: boolean;
}): RarebitArtifactState;

export type RarebitSidecarDiagnostics = {
  tornTail: boolean;
  reason?:
    | "sidecar_missing"
    | "sidecar_empty"
    | "sidecar_head_missing"
    | "sidecar_head_invalid"
    | "sidecar_uncommitted_tail"
    | "sidecar_unreadable";
  tailOffset?: number;
};
export type RarebitSidecarCurrent = {
  availability: RarebitArtifactAvailability;
  path: string;
  receipt: RarebitSummaryReceiptV4 | null;
  records: RarebitSummaryReceiptV4[];
  head: RarebitHeadV1 | null;
  diagnostics: RarebitSidecarDiagnostics;
  artifactState: RarebitArtifactState;
};
export function readRarebitCurrent(input: {
  sessionFile: string;
  native?: RarebitNativeObservation;
  expectation?: "owner_request" | "agent_settled" | "snapshot";
  deadlineExpired?: boolean;
  sessionRoot?: string;
  rarebitRoot?: string;
  allowExternalSession?: boolean;
}): Promise<RarebitSidecarCurrent>;
export function readRarebitHistory(input: {
  sessionFile: string;
  fromOffset?: number;
  limit?: number;
  sessionRoot?: string;
  rarebitRoot?: string;
  allowExternalSession?: boolean;
}): Promise<{
  availability: RarebitArtifactAvailability;
  path: string;
  records: Array<{
    offset: number;
    record: RarebitSummaryReceiptV4 | RarebitTitleReceiptV4;
  }>;
  nextOffset: number | null;
}>;
export function exactSelectionApplies(
  receiptSelection: RarebitSelectionRef,
  selection: ReturnType<typeof selectRarebits>,
): boolean;
export function requestPrefixApplies(
  receiptSelection: RarebitSelectionRef,
  selection: ReturnType<typeof selectRarebits>,
): boolean;

type RarebitTitleReceiptCommon = {
  schemaVersion: 4;
  type: "rarebit_title";
  jobId: string;
  implementationVersion: "hc-rarebit-title-v4";
  sessionId: string;
  branch: RarebitBranchRef;
  selectionManifestHash: string;
  titleEvidence: { provenance: string; sourceEntryId: string | null };
  promptVersion: string;
  model: RarebitModel | null;
  modelProvenance: RarebitModelProvenance;
  applicationMode: "apply" | "proposal";
  priorTitle: string | null;
  observedAt: string;
};
export type RarebitTitleReceiptV4 =
  | (RarebitTitleReceiptCommon & {
      status: "proposal" | "applied";
      title: string;
      synthesis: RarebitSynthesisReceipt;
    })
  | (RarebitTitleReceiptCommon & {
      status:
        | "skipped_session_changed"
        | "skipped_title_changed"
        | "skipped_existing_title";
      title: null;
      synthesis: RarebitSynthesisReceipt;
    })
  | (RarebitTitleReceiptCommon & {
      status: "failure";
      title: null;
      retryable: boolean;
      error: { name: string; message: string };
    });

export function validateRarebitTitleReceipt(
  record: unknown,
):
  | { valid: true; record: RarebitTitleReceiptV4 }
  | { valid: false; reason: "malformed" };

export function processRarebitTitle(
  ctx: unknown,
  config: {
    model?: RarebitModel;
    sourceEntryId?: string;
    sourceText?: string;
    allowFirstUserFallback?: boolean;
    evidenceProvenance?: string;
    titleDate: string;
    priorTitle?: string | null;
    requestIdentity?: string;
    titleModelClient?: {
      complete(request: {
        prompt: string;
        model: RarebitModel;
      }): Promise<unknown>;
    };
    modelClient?: {
      complete(request: {
        prompt: string;
        model: RarebitModel;
      }): Promise<unknown>;
    };
    applyTitle?: (request: {
      title: string;
      priorTitle: string | null;
      sessionId: string;
      sessionFile: string;
      sourceEntryId: string | null;
    }) => Promise<{ status: string }> | { status: string };
  },
): Promise<{
  duplicate: boolean;
  inFlight?: boolean;
  record:
    | (RarebitTitleReceiptV4 & { path?: string })
    | (RarebitTitleReceiptCommon & { status: "pending"; title: null });
}>;
