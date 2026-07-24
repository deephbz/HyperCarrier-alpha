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

export type RarebitSummarySynthesis = {
  summary: string;
  summaryNeedsHumanAttention: boolean;
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
  options?: { maxSectionChars?: number },
): RarebitSummarySynthesis;
export function normalizeRarebitTitle(value: unknown): string;
export function titleWithDatePrefix(
  value: unknown,
  options: { date: string; maxChars?: number },
): string;
export const RAREBIT_SUMMARY_SCHEMA_VERSION: 2;
export const RAREBIT_SUMMARY_IMPLEMENTATION_VERSION: "hc-rarebit-summary-v2";
export function processRarebitSummary(
  ctx: unknown,
  config?: {
    model?: RarebitModel;
    summaryPolicy?: RarebitSummaryPolicy;
    forceSynthesis?: boolean;
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
