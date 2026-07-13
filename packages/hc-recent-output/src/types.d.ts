export type RecentOutputStatus =
  "ok" | "insufficient_window" | "failure" | "conflict";

export interface PiAiContract {
  complete: Function;
  getModel: Function;
}

export interface RecentOutputConfig {
  n?: number;
  promptVersion?: string;
  model?: { provider: string; id: string };
  outputPath?: string;
  projectId?: string;
  allowUnassociated?: boolean;
  implementationVersion?: string;
  modelClient?: ModelClient;
  piAi?: PiAiContract;
  config?: Record<string, unknown>;
  lockTimeoutMs?: number;
  leaseMs?: number;
  leaseRenewMs?: number;
}

export interface ModelRequest {
  prompt: string;
  messages: Array<{ id: string; text: string; contentHash: string }>;
  model: { provider: string; id: string };
  promptVersion: string;
}

export interface ModelResponse {
  text?: string;
  content?: Array<{ type?: string; text?: string }>;
}

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse | string>;
}

export function selectFinalMessages(
  branch: unknown[],
  n: number,
): {
  selected: Array<Record<string, unknown>>;
  eligibleCount: number;
};

export function buildPrompt(
  selected: Array<Record<string, unknown>>,
  promptVersion: string,
): string;
export function sha256(value: unknown): string;
export function computeInputHash(input: unknown): string;
export function defaultOutputPath(projectId: string): string;
export function appendUniqueRecord(
  path: string,
  record: Record<string, unknown>,
  timeoutMs?: number,
): Promise<Record<string, unknown>>;
export function createPiModelClient(
  ctx: unknown,
  config?: RecentOutputConfig,
): Promise<ModelClient>;
export function processSettlement(
  ctx: unknown,
  config?: RecentOutputConfig,
): Promise<Record<string, unknown>>;
export function registerRecentOutput(
  pi: unknown,
  config?: RecentOutputConfig,
): void;
