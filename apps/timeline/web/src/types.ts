export type AgentState =
  "idle" | "thinking" | "tool" | "waiting_input" | "blocked" | "settled" | "failed" | "unknown";
export type GroupMode =
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
export type ColorMode = "cost" | "tokens" | "state";
export type Density = "summary" | "turns" | "requests";

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
  cwd: string;
  source: string;
  name?: string;
  turnCount: number;
  requestCount: number;
  cost: number;
  totalTokens: number;
  links?: { live: string; tps: string };
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
    | "inferred_recent_named_session";
  sessionBinding?: {
    confidence: "exact" | NonNullable<LiveAgent["sessionConfidence"]>;
    kind:
      | "lifecycle_extension"
      | "tmux_window_name"
      | "process_start"
      | "process_start_batch"
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
  state: AgentState;
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
  generatedAt: string;
  sourceVersion: number;
  sessions: Session[];
  turns: Turn[];
  requests: Request[];
  liveAgents: LiveAgent[];
  teams?: Array<{ name: string; createdAt?: string; source: string; memberCount: number }>;
  teamMemberships?: Array<{
    teamName: string;
    agentName: string;
    role: string;
    pid?: number;
    source: string;
  }>;
  trace: { durationMs: number; sessionFiles: number; rejected: unknown[] };
}
export interface Lane {
  session: Session;
  turns: Turn[];
  requests: Request[];
  requestsByTurn: ReadonlyMap<string, Request[]>;
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
