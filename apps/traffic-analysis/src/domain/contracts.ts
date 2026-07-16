export const SCHEMA_VERSION = "traffic-analysis-v1";
export const ANALYSIS_CONTRACT_VERSION = "information-contract-v1";
export type EvidenceClass =
  "observed" | "derived" | "associated" | "inferred" | "unavailable";
export interface Evidence {
  class: EvidenceClass;
  basis: string;
  confidence?: number;
  unavailable_reason?: string;
}
export interface Provenance {
  source_ids: string[];
  source_artifacts: {
    source_id: string;
    sha256: string;
    byte_count: number;
    record_count: number;
    header_id: string | null;
    location: string | null;
    parser_version: string;
  }[];
  parser_version: string;
  content_policy: string;
  classifier: { id: string; version: string };
  tool_manifest_version: string;
}
export interface SourceRef {
  source_id: string;
  ordinal: number;
  raw_id?: string;
}
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number | null;
  cost_basis: string | null;
  cost_components?: {
    input_usd: number | null;
    cache_read_usd: number | null;
    cache_write_usd: number | null;
    output_usd: number | null;
    reasoning_usd: number | null;
    total_usd: number | null;
  };
}
export interface Agent {
  agent_id: string;
  session_trace_id: string;
  source_id: string;
  display_name: string | null;
  display_name_evidence: Evidence;
  evidence: Evidence;
}
export interface Turn {
  turn_id: string;
  source_id: string;
  agent_id: string;
  ordinal: number;
  global_ordinal: number | null;
  agent_local_ordinal: number;
  tool_count: number;
  preceding_user_boundary: SourceRef;
  timestamp_ms: number | null;
  classifier: "user_request" | "user_alert";
  classifier_provenance: {
    id: string;
    version: string;
    method: string;
    matched_attributes: string[];
  };
  excerpt: string | null;
  following_request_count: number;
  following_total_tokens: number;
  following_estimated_cost_usd: number | null;
  episode_outcome: "continuation" | "stop" | "truncated" | null;
  evidence: Evidence;
}
export interface Request {
  request_id: string;
  source_id: string;
  agent_id: string;
  turn_id: string | null;
  ordinal: number;
  assistant_request_start_ms: number | null;
  assistant_response_recorded_ms: number | null;
  observed_elapsed_ms: number | null;
  provider: string | null;
  model: string | null;
  api: string | null;
  outcome: "continuation" | "stop" | "truncated";
  usage: Usage;
  part_count: number;
  tool_call_count: number;
  evidence: Evidence;
  provenance_refs: string[];
}
export interface ContentPart {
  part_id: string;
  source_id: string;
  agent_id: string;
  turn_id: string | null;
  request_id: string;
  part_index: number;
  part_type: string;
  present: boolean;
  retention: "metadata_only" | "approved_excerpt";
  visible_text_excerpt: string | null;
  tool_call_id: string | null;
  time_ms: null;
  usage: null;
  estimated_cost_usd: null;
  evidence: Evidence;
}
export interface ToolEvent {
  tool_event_id: string;
  source_id: string;
  agent_id: string;
  turn_id: string | null;
  request_id: string | null;
  kind: "call_available" | "result_recorded" | "orphan_result";
  call_id: string | null;
  tool_name: string | null;
  timestamp_ms: number | null;
  status: "ok" | "error" | "unknown";
  pairing_state: "matched" | "unmatched_call" | "orphan_result" | "ambiguous";
  evidence: Evidence;
}
export interface ToolSpan {
  span_id: string;
  source_id: string;
  agent_id: string;
  turn_id: string | null;
  request_id: string | null;
  call_id: string;
  tool_name: string | null;
  start_ms: number;
  end_ms: number;
  observed_span_ms: number;
  interpretation: "not_tool_runtime";
  pairing_state: "matched";
  evidence: Evidence;
}
export interface QuietGap {
  gap_id: string;
  source_id: string;
  agent_id: string;
  after_turn_id: string;
  start_ms: number;
  end_ms: number | null;
  duration_ms: number | null;
  qualification:
    | "exact_next_user"
    | "right_censored_trace_end"
    | "substantive_intervening_activity";
  evidence: Evidence;
}
export interface PreparedTeamConversation {
  schema_version: string;
  prepared_derivation_id: string;
  provenance: Provenance;
  agents: Agent[];
  turns: Turn[];
  requests: Request[];
  content_parts: ContentPart[];
  tool_events: ToolEvent[];
  tool_spans: ToolSpan[];
  quiet_gaps: QuietGap[];
  diagnostics: Diagnostic[];
  team: {
    team_name: string | null;
    leader_session_id: string | null;
    leader_session_name: string | null;
    is_leader_source: boolean;
  };
  coverage: { start_ms: number | null; end_ms: number | null };
}
export interface Diagnostic {
  diagnostic_id: string;
  code: string;
  message: string;
  source_id?: string;
  evidence: Evidence;
}
export interface AnalysisRow {
  row_type: string;
  row_id: string;
  prepared_derivation_id: string;
  source_id: string | null;
  agent_id: string | null;
  turn_id: string | null;
  request_id: string | null;
  evidence: Evidence;
  provenance_refs: string[];
  [key: string]: unknown;
}
export interface Aggregate {
  aggregate_id: string;
  kind: string;
  dimensions: Record<string, string | null>;
  measures: Record<string, number | null>;
  semantics: string;
  evidence: Evidence;
}
export interface Reconciliation {
  requests: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  estimated_cost_usd: number | null;
  matched_tool_spans: number;
  exact_quiet_ms: number;
  diagnostics: number;
}
export interface AnalysisEnvelope {
  schema_version: string;
  analysis_contract_version: "information-contract-v1";
  prepared_derivation_id: string;
  analysis_id: string;
  parameters: Record<string, unknown>;
  provenance: Provenance;
  report: {
    title: "Agent-turns viz";
    team_name: string | null;
    leader_session_id: string | null;
    leader_session_name: string | null;
    coverage: { start_ms: number | null; end_ms: number | null };
  };
  rows: AnalysisRow[];
  aggregates: Aggregate[];
  reconciliation: Reconciliation;
  diagnostics: Diagnostic[];
}
