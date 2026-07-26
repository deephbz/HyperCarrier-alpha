import type {
  RarebitSessionAssessmentRef,
  RarebitVisualPresentation,
} from "@hypercarrier/hc-rarebit";

export const TIMELINE_SNAPSHOT_SCHEMA_VERSION = 5 as const;
/** Exact package `assessmentRef`; Timeline serializes it without re-derivation. */
export type RarebitSummaryStatusSource = RarebitSessionAssessmentRef;
/** Package-derived Summary status; it is not runtime, Task, or Project state. */
export type RarebitSummaryStatus =
  | {
      state: "available";
      status: "user_requested" | "finished" | "needs_attention" | "ineligible" | "error";
      reason: string | null;
      sourcePending: boolean;
      presentation: Readonly<RarebitVisualPresentation>;
      source: RarebitSummaryStatusSource;
    }
  | {
      state: "unknown";
      reason: "summary_missing" | "summary_unavailable" | "summary_status_missing";
      source: RarebitSummaryStatusSource;
    };
export type SessionUsageMetric =
  { availability: "complete" | "partial"; value: number } | { availability: "unavailable" };
export interface SessionUsage {
  tokens: SessionUsageMetric;
  cost: SessionUsageMetric;
}
export type GroupMode =
  | "context"
  | "project"
  | "cwd"
  | "name"
  | "team"
  | "tmux-session"
  | "tmux-window"
  | "tmux-pane"
  | "state"
  | "none";
export type FilterMode = Exclude<GroupMode, "none" | "tmux-pane"> | "all";
export interface Session {
  id: string;
  startedAt: string;
  endedAt: string;
  /**
   * Timestamp of the latest recorded session message. This is conversation
   * evidence, so it is deliberately distinct from process liveness or a
   * collector heartbeat.
   */
  lastMessageAt?: string | null;
  /**
   * Catalog evidence state. `unknown` means the bounded tail scan exhausted
   * its byte budget, not that the Session has no message history.
   */
  lastMessageAtEvidence?: {
    state: "observed" | "absent" | "unknown";
    source: "bounded_tail_scan";
    reason?: "tail_scan_cap_exhausted";
  };
  cwd: string;
  source: string;
  name?: string;
  /**
   * An explicit Work Ledger/registry association when one is supplied by an
   * upstream adapter. A cwd basename is not a Project identity.
   */
  projectName?: string;
  turnCount: number;
  requestCount: number;
  /** Cumulative native assistant usage, with absence and observed subtotals preserved. */
  usage: SessionUsage;
  links?: { live: string; tps: string };
  /** Content-free current Summary status from the package-owned v4 projection. */
  rarebitSummaryStatus?: RarebitSummaryStatus;
}
export type SnapshotWindow = "15m" | "1h" | "6h" | "24h" | "all";
export interface SnapshotPage {
  window: SnapshotWindow;
  /** Opaque, stable cursor for the next older history page. */
  nextCursor: string | null;
  hasOlder: boolean;
  source: "last_message_at";
}
export interface Turn {
  id: string;
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  confidence: "exact" | "inferred";
  requestCount: number;
  cost: number;
  totalTokens: number;
}
export interface Request {
  id: string;
  sessionId: string;
  turnId?: string;
  at: string;
  model?: string;
  provider?: string;
  cost: number;
  totalTokens: number;
  output: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  stopReason?: string;
}
export interface ResponseOutcomeMarker {
  requestId: string;
  sessionId: string;
  at: string;
  visual: "continuation" | "stop" | "terminal";
  stopReason: string;
}
/**
 * A content-free projection of the shared Rarebit predicate. The native
 * JSONL remains the only transcript authority; this marker has no prose,
 * tool payload, reasoning, or content-derived hash.
 */
export interface RarebitMarker {
  sessionId: string;
  sourceEntryId: string | null;
  order: number;
  role: "user" | "assistant";
  outcome: "user" | "stop" | "continuation";
  producer: string | null;
  timestamp: string | null;
}
export interface CoordinationEvidence {
  kind: "pi-team";
  teamName: string;
  agentName: string;
  role: "lead" | "teammate";
  ready?: boolean;
  source: string;
}
export interface ProcessObservation {
  id: string;
  pid: number;
  processStartedAt?: string;
  observedAt: string;
  cwd?: string;
  process: { pid: number; state: "running" };
  locations: Array<{ provider: "tmux" | "herdr"; cwd?: string; [key: string]: unknown }>;
  coordination?: CoordinationEvidence;
  link?: {
    sessionId: string;
    grade: "provider_verified" | "heuristic";
    method: string;
    observedAt: string;
    provenance: string[];
  };
  issues: Array<{
    code:
      | "process_start_unknown"
      | "association_conflict"
      | "association_ambiguous"
      | "provider_session_unavailable"
      | "provider_process_ambiguous"
      | "provider_claim_malformed"
      | "provider_claim_future"
      | "provider_claim_stale"
      | "coordination_ambiguous"
      | "coordination_stale"
      | "coordination_target_mismatch";
    message: string;
  }>;
}
export interface Snapshot {
  schemaVersion: typeof TIMELINE_SNAPSHOT_SCHEMA_VERSION;
  generatedAt: string;
  sessions: Session[];
  turns: Turn[];
  requests: Request[];
  rarebits: RarebitMarker[];
  processes: ProcessObservation[];
  teams?: Array<{ name: string; createdAt?: string; source: string; memberCount: number }>;
  teamMemberships?: Array<{
    teamName: string;
    agentName: string;
    role: string;
    pid?: number;
    source: string;
  }>;
  page?: SnapshotPage;
  trace: {
    durationMs: number;
    sessionFiles: number;
    rejected: unknown[];
    refresh?: { at?: string; reason?: string; paths?: string[] };
    sessionCache?: {
      bytesRead: number;
      linesParsed: number;
      appendCount: number;
      rebuildCount: number;
    };
  };
}
export interface SessionLane {
  kind: "session";
  session: Session;
  turns: Turn[];
  requests: Request[];
  requestsByTurn: ReadonlyMap<string, Request[]>;
  rarebits: RarebitMarker[];
  responseOutcomes: ResponseOutcomeMarker[];
  /** All current OS Process observations linked to this historical Session. */
  processes: ProcessObservation[];
  /** Deterministic presentation choice; this never changes Process identity. */
  primaryProcess?: ProcessObservation;
  /**
   * Evidence used for bounded timeline filtering. Historical sessions require
   * a recorded message; a live-only lane may use a runtime observation until
   * its session log is discoverable.
   */
  boundedTimeAnchor?: { at: number; source: "message" | "runtime-observation" };
  start: number;
  end: number;
}
export interface ProcessLane {
  kind: "process";
  process: ProcessObservation;
  /** A process has only observed runtime time, never Session-message time. */
  boundedTimeAnchor: { at: number; source: "runtime-observation" };
  start: number;
  end: number;
}
/** Timeline lanes are discriminated; Process lanes never carry Session evidence. */
export type Lane = SessionLane | ProcessLane;
