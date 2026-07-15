export type KeyMessageSummaryStatus =
  | "ok"
  | "selection_only"
  | "unavailable_overflow"
  | "failure"
  | "conflict";

export interface PiAiContract {
  complete: Function;
  getModel?: Function;
}

export interface KeyMessageSummaryConfig {
  promptVersion?: string;
  model?: { provider: string; id: string };
  modelConfigurationError?: string;
  modelProvenance?: Record<string, unknown>;
  outputPath?: string;
  projectId?: string;
  implementationVersion?: string;
  modelClient?: ModelClient;
  piAi?: PiAiContract;
  config?: Record<string, unknown>;
  maxPromptChars?: number;
  lockTimeoutMs?: number;
  leaseMs?: number;
  leaseRenewMs?: number;
  onSynthesisTriggered?: (detail: {
    sessionId: string;
    sessionFile?: string;
    branchLeafId: string | null;
    activation: {
      toolCallCount: number;
      continuationCount: number;
      shouldSynthesize: boolean;
    };
    keyMessageCount: number;
    model: { provider: string; id: string };
    estimatedInputTokens: number;
    inputTokenEstimateMethod: "utf16_chars_div_4_ceil";
  }) => void | Promise<void>;
}

export interface ModelRequest {
  prompt: string;
  model: { provider: string; id: string };
}

export interface ModelResponse {
  text?: string;
  content?: Array<{ type?: string; text?: string }>;
  provider?: string;
  model?: string;
  responseModel?: string;
  responseId?: string;
  requestId?: string;
  usage?: Record<string, unknown>;
  usageMetadata?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse | string>;
}

export interface KeyMessageSelection {
  occurrences: Array<Record<string, unknown>>;
  payloads: Array<Record<string, unknown>>;
  toolCallCount: number;
  continuationCount: number;
  manifest: Record<string, unknown>;
  manifestHash: string;
}

export function selectKeyMessages(branch: unknown[]): KeyMessageSelection;
export function buildPrompt(selection: KeyMessageSelection, promptVersion: string): string;
export function sha256(value: unknown): string;
export function computeInputHash(input: unknown): string;
export function resolveModelConfiguration(config?: KeyMessageSummaryConfig): {
  ok: boolean;
  model: { provider: string; id: string } | null;
  provenance: Record<string, unknown>;
  error?: string;
};
export function defaultOutputPath(sessionFile: string, options?: {
  sessionRoot?: string;
  outputRoot?: string;
}): string;
export function extractSynthesisReceipt(response: unknown, options?: {
  requestedModel?: { provider: string; id: string } | null;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  outcome?: "response" | "failure";
}): Record<string, unknown>;
export function appendUniqueRecord(path: string, record: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
export function createPiModelClient(ctx: unknown, config?: KeyMessageSummaryConfig): Promise<ModelClient>;
export function processKeyMessageSummary(ctx: unknown, config?: KeyMessageSummaryConfig): Promise<Record<string, unknown>>;
export function registerKeyMessageSummary(pi: unknown, config?: KeyMessageSummaryConfig): void;
