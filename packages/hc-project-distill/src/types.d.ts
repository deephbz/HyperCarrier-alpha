export type SourceStatus =
  "available" | "missing" | "source_unavailable" | "malformed" | "partial";
export type ProposalStatus =
  | "proposed"
  | "partial"
  | "corrupt"
  | "rejected_stale_base"
  | "rejected_missing_canonical"
  | "rejected_missing_base_hash"
  | "failure";

export interface SourceState {
  kind: string;
  status: SourceStatus;
  ref: string;
  hash?: string;
  observedAt: string;
  recordCount?: number;
  error?: { name: string; message: string; code?: string };
}

export interface ProjectLocationConfig {
  repos?: string[];
  repo?: string;
  evergreen?: string | null;
  beadsRoot?: string | null;
  sourceDocs?: string[];
  summaries?: string[];
  summaryStreams?: string[];
  beadsCwd?: string;
  events?: string;
  eventStream?: string;
  proposalDir?: string;
  proposalDirectory?: string;
}

export interface ProjectAssociations {
  sessionIds?: string[];
  taskIds?: string[];
  rules?: Array<Record<string, unknown>>;
}

export interface ProjectConfig {
  id: string;
  name: string;
  locations: ProjectLocationConfig;
  associations?: ProjectAssociations;
  evergreen?: { baseHash?: string };
}

export interface ProjectRegistry {
  schemaVersion: 1;
  registryVersion: string;
  correctionProvenance?: Record<string, unknown>;
  projects: ProjectConfig[];
}

export interface DistillOptions {
  project: ProjectConfig;
  baseHash?: string;
  runner?: Function;
  now?: string;
  trace?: boolean;
  timeoutMs?: number;
  eventsPath?: string;
  proposalDir?: string;
  synthesisClient?: {
    complete(input: {
      prompt: string;
      model: { provider: string; id: string };
      promptVersion: string;
      inputHash: string;
      eventIds: string[];
    }): Promise<unknown>;
  };
  synthesisModel?: { provider: string; id: string };
  synthesisPromptVersion?: string;
}

export type ProjectEventKind =
  | "progress"
  | "finding"
  | "decision-candidate"
  | "conflict"
  | "retirement"
  | "delivery-evidence";

export interface SourceRef {
  kind: string;
  ref: string;
  hash: string;
}

export interface ProjectEvent {
  schemaVersion: 1;
  type: "project_event";
  eventId: string;
  projectId: string;
  eventKind: ProjectEventKind;
  at: string | null;
  validAt: string | null;
  observedAt: string;
  sources: SourceRef[];
  sourceFrontierHash: string;
  derivationVersion: string;
  idempotencyKey: string;
  sourceFact: {
    kind: "task" | "commit" | "reportedSummary";
    id: string;
    version: string;
    sourceRef?: string;
  };
  payload: {
    task?: Record<string, unknown>;
    commit?: Record<string, unknown>;
    reportedSummary?: Record<string, unknown>;
  };
}

export interface DistillationResult {
  schemaVersion: 1;
  type: "project_distillation";
  projectId: string;
  derivationVersion: string;
  sourceStates: SourceState[];
  sourceFrontierHash: string;
  eventCount: number;
  eventWrite?: Record<string, unknown>;
  synthesis?: Record<string, unknown>;
  proposal?: Record<string, unknown>;
  trace?: Record<string, unknown>;
}

export interface ProposalResult {
  status: ProposalStatus;
  proposalId?: string;
  paths?: { markdown: string; patch: string; metadata: string };
  baseHash?: string;
  sourceFrontierHash?: string;
  reason?: string;
}

export function loadRegistry(path: string): Promise<ProjectRegistry>;
export function deriveProjectEvents(
  input: unknown,
): Array<Record<string, unknown>>;
export function distillProject(
  options: DistillOptions,
): Promise<Record<string, unknown>>;
export function synthesizeEvergreen(
  input: unknown,
  options?: DistillOptions,
): Promise<Record<string, unknown>>;
export function normalizeEvergreenSynthesis(value: unknown): string;
export function validateSynthesisCitations(
  text: string,
  eventIds: string[],
): Record<string, unknown>;
export function resolveSynthesisCitations(
  text: string,
  eventIds: string[],
): Record<string, unknown>;
export function buildEvergreenSynthesisPrompt(input: unknown): string;
export function appendProjectEvents(
  path: string,
  events: Array<Record<string, unknown>>,
  options?: unknown,
): Promise<Record<string, unknown>>;
export function writeProposal(
  input: unknown,
  options?: unknown,
): Promise<Record<string, unknown>>;
export function runCommand(
  command: string,
  args: string[],
  options?: Record<string, unknown>,
): Promise<Record<string, unknown>>;
export function createPiSynthesisClient(options?: {
  runner?: Function;
  executable?: string;
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
}): {
  complete(input: Record<string, unknown>): Promise<Record<string, unknown>>;
};
