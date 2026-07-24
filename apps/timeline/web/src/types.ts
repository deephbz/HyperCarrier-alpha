export type AgentState =
  "idle" | "thinking" | "tool" | "waiting_input" | "blocked" | "settled" | "failed" | "unknown";
export const TIMELINE_SNAPSHOT_SCHEMA_VERSION = 3 as const;
export interface RarebitSummaryAttentionSource {
  kind: "rarebit_summary";
  schemaVersion: number | null;
  jobId: string | null;
  observedAt: string | null;
  selectorVersion: string | null;
  manifestHash: string | null;
  promptVersion: string | null;
  implementationVersion: string | null;
}
export type RarebitSummaryAttention =
  | {
      state: "known";
      needsHumanAttention: boolean;
      source: RarebitSummaryAttentionSource;
    }
  | {
      state: "unknown";
      reason:
        | "summary_stale"
        | "summary_missing"
        | "summary_unavailable"
        | "summary_not_successful"
        | "unsupported_summary_schema"
        | "attention_field_missing";
      source: RarebitSummaryAttentionSource;
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
  /**
   * Content-free projection of the newest Rarebit Summary's explicit
   * attention assessment. Missing legacy snapshot data is also unknown.
   */
  rarebitSummaryAttention?: RarebitSummaryAttention;
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
export interface LiveAgent {
  processInstanceId: string;
  pid: number;
  sessionId?: string;
  sessionName?: string;
  sessionConfidence?:
    | "inferred_tmux_window_name"
    | "inferred_process_start"
    | "inferred_process_start_batch"
    | "inferred_unique_recent_session"
    | "inferred_recent_named_session";
  sessionBinding?: {
    confidence: "exact" | NonNullable<LiveAgent["sessionConfidence"]>;
    kind:
      | "lifecycle_extension"
      | "pi_teams_session_file"
      | "tmux_window_name"
      | "process_start"
      | "process_start_batch"
      | "unique_recent_session"
      | "recent_named_session";
    evidenceSource?: string;
    sessionSource?: string;
    tmuxSource?: string;
    processSource?: string;
    value?: string;
  };
  processBinding?: { confidence: "exact"; source: "ps"; pid: number };
  processStartedAt?: string;
  cwd: string;
  /** Exact lifecycle state only; process-only observations omit this field. */
  state?: AgentState;
  processState: "running";
  process?: { pid: number; state: "running" };
  workState:
    | {
        availability: "observed";
        state: AgentState;
        evidenceSource: string;
        observedAt?: string;
      }
    | { availability: "unobserved"; reason: "lifecycle_evidence_unavailable" };
  activeTool?: string;
  heartbeatAt?: string;
  model?: string;
  context?: { tokens?: number; window?: number; percent?: number };
  confidence: string;
  coordination?: {
    kind: "pi-team";
    teamName: string;
    agentName: string;
    role: "lead" | "teammate";
    ready?: boolean;
    confidence?: "inferred_shared_window";
    source: string;
  };
  pane?: {
    serverSocket: string;
    sessionName: string;
    windowId?: string;
    windowIndex: number;
    windowName?: string;
    paneId: string;
    cwd: string;
  };
}
export interface Snapshot {
  schemaVersion: typeof TIMELINE_SNAPSHOT_SCHEMA_VERSION;
  generatedAt: string;
  sessions: Session[];
  turns: Turn[];
  requests: Request[];
  rarebits: RarebitMarker[];
  liveAgents: LiveAgent[];
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
export interface Lane {
  session: Session;
  turns: Turn[];
  requests: Request[];
  requestsByTurn: ReadonlyMap<string, Request[]>;
  rarebits: RarebitMarker[];
  responseOutcomes: ResponseOutcomeMarker[];
  live?: LiveAgent;
  /**
   * Evidence used for bounded timeline filtering. Historical sessions require
   * a recorded message; a live-only lane may use a runtime observation until
   * its session log is discoverable.
   */
  boundedTimeAnchor?: { at: number; source: "message" | "runtime-observation" };
  start: number;
  end: number;
}
