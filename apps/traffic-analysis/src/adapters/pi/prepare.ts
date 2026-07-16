import { createHash } from "node:crypto";
import type {
  Agent,
  ContentPart,
  Diagnostic,
  Evidence,
  PreparedTeamConversation,
  QuietGap,
  Request,
  ToolEvent,
  ToolSpan,
  Turn,
  Usage,
} from "../../domain/contracts.js";
import { SCHEMA_VERSION } from "../../domain/contracts.js";
const observed = (basis: string): Evidence => ({
  class: "observed",
  basis,
  confidence: 1,
});
const derived = (basis: string): Evidence => ({
  class: "derived",
  basis,
  confidence: 1,
});
const id = (source: string, kind: string, n: number) =>
  `${source}:${kind}:${n}`;
const ms = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && Number.isFinite(Date.parse(v))
      ? Date.parse(v)
      : null;
const excerpt = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  return v.length <= 400 ? v : `${v.slice(0, 200)}…${v.slice(-200)}`;
};
const finite = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const usage = (u: any): Usage => {
  const input = Number(u?.input ?? u?.inputTokens ?? u?.input_tokens ?? 0),
    output = Number(u?.output ?? u?.outputTokens ?? u?.output_tokens ?? 0),
    cr = Number(
      u?.cacheRead ?? u?.cacheReadTokens ?? u?.cache_read_tokens ?? 0,
    ),
    cw = Number(
      u?.cacheWrite ?? u?.cacheWriteTokens ?? u?.cache_write_tokens ?? 0,
    ),
    reason = Number(
      u?.reasoning ?? u?.reasoningTokens ?? u?.reasoning_tokens ?? 0,
    );
  const total =
    Number.isFinite(Number(u?.totalTokens)) && Number(u.totalTokens) > 0
      ? Number(u.totalTokens)
      : input + output + cr + cw;
  const rawCost = u?.cost;
  const totalCost = finite(rawCost?.total) ?? finite(u?.estimated_cost_usd);
  const components = {
    input_usd: finite(rawCost?.input),
    cache_read_usd: finite(rawCost?.cacheRead ?? rawCost?.cache_read),
    cache_write_usd: finite(rawCost?.cacheWrite ?? rawCost?.cache_write),
    output_usd: finite(rawCost?.output),
    reasoning_usd: finite(rawCost?.reasoning),
    total_usd: totalCost,
  };
  const componentSum = [
    components.input_usd,
    components.cache_read_usd,
    components.cache_write_usd,
    components.output_usd,
  ].every((v): v is number => v !== null)
    ? components.input_usd! +
      components.cache_read_usd! +
      components.cache_write_usd! +
      components.output_usd!
    : null;
  const componentMismatch =
    componentSum !== null &&
    totalCost !== null &&
    Math.abs(componentSum - totalCost) > 1e-9;
  const hasComponents = [
    components.input_usd,
    components.cache_read_usd,
    components.cache_write_usd,
    components.output_usd,
    components.reasoning_usd,
  ].some((v) => v !== null);
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cr,
    cache_write_tokens: cw,
    reasoning_tokens: Math.min(reason, output),
    total_tokens: total,
    estimated_cost_usd: componentMismatch ? null : totalCost,
    cost_basis:
      totalCost === null || componentMismatch
        ? null
        : "pi_model_table_static_estimate",
    ...(hasComponents
      ? {
          cost_components: componentMismatch
            ? {
                input_usd: null,
                cache_read_usd: null,
                cache_write_usd: null,
                output_usd: null,
                reasoning_usd: null,
                total_usd: null,
              }
            : components,
        }
      : {}),
  };
};
export function preparePiJsonl(
  bytes: string,
  source_id: string,
  opts: {
    team_name?: string;
    agent_name?: string;
    is_leader?: boolean;
    location?: string;
  } = {},
): PreparedTeamConversation {
  const lines = bytes.split(/\r?\n/).filter(Boolean);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const entries: any[] = [];
  const diagnostics: Diagnostic[] = [];
  lines.forEach((line, i) => {
    try {
      entries.push({ ...JSON.parse(line), __ordinal: i });
    } catch {
      diagnostics.push({
        diagnostic_id: id(source_id, "diagnostic", i),
        code: "malformed_jsonl",
        message: "Malformed source line preserved as diagnostic",
        source_id,
        evidence: {
          class: "unavailable",
          basis: "raw-jsonl",
          unavailable_reason: "malformed_line",
        },
      });
    }
  });
  const header = entries.find((x) => x.type === "session") ?? {};
  const latestSessionInfo = entries
    .filter((x) => x.type === "session_info" || x.type === "session_name")
    .at(-1);
  const trace = String(header.id ?? header.sessionId ?? source_id);
  source_id = `source:${trace}`;
  diagnostics.forEach((d) => (d.source_id = source_id));
  const agent: Agent = {
    agent_id: `agent:${trace}`,
    session_trace_id: trace,
    source_id,
    display_name: opts.agent_name ?? null,
    display_name_evidence: opts.agent_name
      ? {
          class: "associated",
          basis: "PiTeams explicit member.sessionFile mapping",
          confidence: 1,
        }
      : {
          class: "unavailable",
          basis: "no external display attribution",
          unavailable_reason: "no_explicit_member_mapping",
        },
    evidence: observed("Pi session header UUID"),
  };
  const turns: Turn[] = [];
  const requests: Request[] = [];
  const parts: ContentPart[] = [];
  const events: ToolEvent[] = [];
  const spans: ToolSpan[] = [];
  const gaps: QuietGap[] = [];
  let current: Turn | null = null;
  let reqN = 0;
  const calls = new Map<
    string,
    Array<{ event: ToolEvent; request: Request }>
  >();
  const results = new Map<string, ToolEvent[]>();
  const allTimes: number[] = [];
  for (const e of entries) {
    const message = e.message ?? e;
    const role = message?.role;
    const time = ms(e.timestamp) ?? ms(message?.timestamp);
    if (time !== null) allTimes.push(time);
    if (role === "user") {
      const text =
        typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content)
            ? message.content.find((p: any) => p.type === "text")?.text
            : undefined;
      const alert =
        typeof text === "string" &&
        /\[PiTeams(?: direct)? Message|\[PiTeams/i.test(text);
      current = {
        turn_id: id(source_id, "turn", turns.length),
        source_id,
        agent_id: agent.agent_id,
        ordinal: turns.length,
        global_ordinal: null,
        agent_local_ordinal: turns.length,
        tool_count: 0,
        preceding_user_boundary: {
          source_id,
          ordinal: e.__ordinal,
          raw_id: e.id,
        },
        timestamp_ms: time,
        classifier: alert ? "user_alert" : "user_request",
        classifier_provenance: {
          id: "pi.teams.inbox-message-v1",
          version: "1",
          method: "allowlisted-regex",
          matched_attributes: alert ? ["content-pattern"] : [],
        },
        excerpt: excerpt(text),
        following_request_count: 0,
        following_total_tokens: 0,
        following_estimated_cost_usd: null,
        episode_outcome: null,
        evidence: observed("persisted role=user"),
      };
      turns.push(current);
      continue;
    }
    if (role === "assistant") {
      const u = usage(message.usage);
      const response = ms(e.timestamp);
      const start = ms(message.timestamp);
      const valid = start !== null && response !== null && start <= response;
      const stop = String(
        message.stopReason ?? message.stop_reason ?? "",
      ).toLowerCase();
      const outcome: Request["outcome"] =
        stop === "stop"
          ? "stop"
          : ["length", "error", "aborted"].includes(stop)
            ? "truncated"
            : "continuation";
      const request: Request = {
        request_id: id(source_id, "request", reqN++),
        source_id,
        agent_id: agent.agent_id,
        turn_id: current?.turn_id ?? null,
        ordinal: reqN - 1,
        assistant_request_start_ms: valid ? start : null,
        assistant_response_recorded_ms: valid ? response : null,
        observed_elapsed_ms: valid ? response! - start! : null,
        provider: message.provider ?? null,
        model: message.model ?? null,
        api: message.api ?? null,
        outcome,
        usage: u,
        part_count: 0,
        tool_call_count: 0,
        evidence: valid
          ? observed("Pi 0.80.6 assistant message and entry timestamps")
          : {
              class: "unavailable",
              basis: "Pi timestamp envelope",
              unavailable_reason: "missing_or_unordered_endpoint",
            },
        provenance_refs: [`${source_id}:${e.__ordinal}`],
      };
      requests.push(request);
      if (current) {
        current.following_request_count++;
        current.following_total_tokens += u.total_tokens;
        if (u.estimated_cost_usd === null)
          current.following_estimated_cost_usd = null;
        else if (current.following_request_count === 1)
          current.following_estimated_cost_usd = u.estimated_cost_usd;
        else if (current.following_estimated_cost_usd !== null)
          current.following_estimated_cost_usd += u.estimated_cost_usd;
        current.episode_outcome = outcome;
      }
      const content = Array.isArray(message.content) ? message.content : [];
      request.part_count = content.length;
      content.forEach((p: any, pi: number) => {
        const type = String(p.type ?? "unknown");
        const callId = p.id ?? p.callId ?? p.toolCallId ?? null;
        parts.push({
          part_id: `${request.request_id}:part:${pi}`,
          source_id,
          agent_id: agent.agent_id,
          turn_id: request.turn_id,
          request_id: request.request_id,
          part_index: pi,
          part_type: type,
          present: true,
          retention: type === "text" ? "approved_excerpt" : "metadata_only",
          visible_text_excerpt: type === "text" ? excerpt(p.text) : null,
          tool_call_id: callId,
          time_ms: null,
          usage: null,
          estimated_cost_usd: null,
          evidence: observed("ordered assistant content part"),
        });
        if (type === "toolCall" || type === "tool_call") {
          request.tool_call_count++;
          if (current) current.tool_count++;
          const ev: ToolEvent = {
            tool_event_id: id(source_id, "tool-call", events.length),
            source_id,
            agent_id: agent.agent_id,
            turn_id: request.turn_id,
            request_id: request.request_id,
            kind: "call_available",
            call_id: callId,
            tool_name: p.name ?? null,
            timestamp_ms: response,
            status: "unknown",
            pairing_state: callId ? "unmatched_call" : "ambiguous",
            evidence: observed("assistant tool-call part"),
          };
          events.push(ev);
          if (callId)
            (calls.get(callId) ?? calls.set(callId, []).get(callId)!).push({
              event: ev,
              request,
            });
        }
      });
      continue;
    }
    if (role === "toolResult" || message?.type === "toolResult") {
      const callId = message.toolCallId ?? message.callId ?? null;
      const ev: ToolEvent = {
        tool_event_id: id(source_id, "tool-result", events.length),
        source_id,
        agent_id: agent.agent_id,
        turn_id: current?.turn_id ?? null,
        request_id: null,
        kind: "orphan_result",
        call_id: callId,
        tool_name: message.toolName ?? message.name ?? null,
        timestamp_ms: time,
        status: message.isError ? "error" : "ok",
        pairing_state: callId ? "orphan_result" : "ambiguous",
        evidence: observed("persisted toolResult message"),
      };
      events.push(ev);
      if (callId)
        (results.get(callId) ?? results.set(callId, []).get(callId)!).push(ev);
    }
  }
  for (const [callId, cs] of calls) {
    const rs = results.get(callId) ?? [];
    if (cs.length !== 1 || rs.length > 1) {
      cs.forEach((c) => (c.event.pairing_state = "ambiguous"));
      rs.forEach((r) => (r.pairing_state = "ambiguous"));
      continue;
    }
    if (rs.length === 0) continue;
    const { event, request } = cs[0];
    if (
      event.timestamp_ms !== null &&
      rs[0].timestamp_ms !== null &&
      event.timestamp_ms <= rs[0].timestamp_ms
    ) {
      event.pairing_state = "matched";
      rs[0].pairing_state = "matched";
      rs[0].kind = "result_recorded";
      rs[0].request_id = request.request_id;
      spans.push({
        span_id: `${source_id}:span:${callId}`,
        source_id,
        agent_id: agent.agent_id,
        turn_id: request.turn_id,
        request_id: request.request_id,
        call_id: callId,
        tool_name: event.tool_name,
        start_ms: event.timestamp_ms,
        end_ms: rs[0].timestamp_ms,
        observed_span_ms: rs[0].timestamp_ms - event.timestamp_ms,
        interpretation: "not_tool_runtime",
        pairing_state: "matched",
        evidence: observed("exact source-scoped call ID pairing"),
      });
    }
  }
  const sortedTurns = turns.filter((t) => t.timestamp_ms !== null);
  const traceEnd = allTimes.length ? Math.max(...allTimes) : null;
  for (let i = 0; i < sortedTurns.length; i++) {
    const t = sortedTurns[i];
    const stopResponse = requests
      .filter((r) => r.turn_id === t.turn_id && r.outcome === "stop")
      .at(-1)?.assistant_response_recorded_ms;
    if (
      t.episode_outcome !== "stop" ||
      stopResponse === null ||
      stopResponse === undefined
    )
      continue;
    const next = sortedTurns[i + 1];
    const substantive =
      next &&
      requests.some(
        (r) =>
          r.turn_id !== t.turn_id &&
          r.assistant_response_recorded_ms !== null &&
          r.assistant_response_recorded_ms > stopResponse &&
          r.assistant_response_recorded_ms < next.timestamp_ms!,
      );
    gaps.push({
      gap_id: id(source_id, "gap", i),
      source_id,
      agent_id: agent.agent_id,
      after_turn_id: t.turn_id,
      start_ms: stopResponse,
      end_ms: next?.timestamp_ms ?? traceEnd,
      duration_ms: next
        ? next.timestamp_ms! - stopResponse
        : traceEnd === null
          ? null
          : Math.max(0, traceEnd - stopResponse),
      qualification: substantive
        ? "substantive_intervening_activity"
        : next
          ? "exact_next_user"
          : "right_censored_trace_end",
      evidence: next
        ? derived("stop response-recorded to next persisted user boundary")
        : {
            class: "inferred",
            basis: "trace end lower bound",
            unavailable_reason: "right_censored",
          },
    });
  }
  const coverage = {
    start_ms: allTimes.length ? Math.min(...allTimes) : null,
    end_ms: allTimes.length ? Math.max(...allTimes) : null,
  };
  return {
    schema_version: SCHEMA_VERSION,
    prepared_derivation_id: createHash("sha256")
      .update(
        `${digest}|pi-0.80.6-byte-adapter-v1|approved-first-last-200-only|pi.teams.inbox-message-v1:1|tool-owner-manifest-v2`,
      )
      .digest("hex"),
    provenance: {
      source_ids: [source_id],
      source_artifacts: [
        {
          source_id,
          sha256: digest,
          byte_count: Buffer.byteLength(bytes),
          record_count: entries.length,
          header_id: typeof header.id === "string" ? header.id : null,
          location: opts.location ?? null,
          parser_version: "pi-0.80.6-byte-adapter-v1",
        },
      ],
      parser_version: "pi-0.80.6-byte-adapter-v1",
      content_policy: "approved-first-last-200-only",
      classifier: { id: "pi.teams.inbox-message-v1", version: "1" },
      tool_manifest_version: "tool-owner-manifest-v2",
    },
    agents: [agent],
    turns,
    requests,
    content_parts: parts,
    tool_events: events,
    tool_spans: spans,
    quiet_gaps: gaps,
    diagnostics,
    team: {
      team_name: opts.team_name ?? null,
      leader_session_id: opts.is_leader ? trace : null,
      leader_session_name: opts.is_leader
        ? typeof latestSessionInfo?.name === "string"
          ? latestSessionInfo.name
          : typeof header.name === "string"
            ? header.name
            : typeof header.sessionName === "string"
              ? header.sessionName
              : null
        : null,
      is_leader_source: opts.is_leader === true,
    },
    coverage,
  };
}
