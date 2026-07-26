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
      reason: "decision" | "input" | "approval" | "blocker" | "unfinished";
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
    | "unfinished";
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
export function composeRarebitSummaryPrompt(
  selection: ReturnType<typeof selectRarebits>,
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
export const RAREBIT_SUMMARY_SCHEMA_VERSION: 3;
export const RAREBIT_SUMMARY_IMPLEMENTATION_VERSION: "hc-rarebit-summary-v3";
export function processRarebitSummary(
  ctx: unknown,
  config?: {
    model?: RarebitModel;
    summaryPolicy?: RarebitSummaryPolicy;
    forceSynthesis?: boolean;
    lifecycleBoundary?:
      "owner_request" | "agent_settled" | "session_start" | "manual";
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
  record: Record<string, unknown>;
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

export function selectRarebitSummaryReceipt(input: {
  records: Record<string, unknown>[];
  selection: ReturnType<typeof selectRarebits>;
}): Record<string, unknown> | null;

export function projectRarebitSessionStatus(input: {
  records: Record<string, unknown>[];
  selection: ReturnType<typeof selectRarebits>;
  now?: number;
  maxAgeMs?: number | null;
}): RarebitSessionStatus & {
  assessmentRef: RarebitSessionAssessmentRef | null;
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
export function validateRarebitArtifactReceipt(record: unknown): {
  valid: boolean;
  reason?: "malformed";
  record?: Record<string, unknown>;
};
export function projectRarebitArtifactState(input?: {
  native?: {
    availability: RarebitArtifactAvailability;
    sessionId?: string;
    selection?: Pick<ReturnType<typeof selectRarebits>, "manifestHash"> & {
      selectorVersion: string;
      occurrences: RarebitOccurrence[];
    };
  };
  materialization?: {
    availability: RarebitArtifactAvailability;
    records: Record<string, unknown>[];
  };
  expectation?: "owner_request" | "agent_settled" | "snapshot";
  deadlineExpired?: boolean;
}): RarebitArtifactState;

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
  record: Record<string, unknown>;
}>;
