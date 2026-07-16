import { createHash } from "node:crypto";
import type {
  Aggregate,
  AnalysisEnvelope,
  AnalysisRow,
  PreparedTeamConversation,
  Request,
} from "./contracts.js";
import { ANALYSIS_CONTRACT_VERSION, SCHEMA_VERSION } from "./contracts.js";
import { toolOwner } from "../adapters/pi/tool-manifest.js";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const row = (
  prepared: PreparedTeamConversation,
  row_type: string,
  row_id: string,
  base: Record<string, unknown>,
): AnalysisRow => ({
  row_type,
  row_id,
  prepared_derivation_id: prepared.prepared_derivation_id,
  source_id: null,
  agent_id: null,
  turn_id: null,
  request_id: null,
  evidence: { class: "derived", basis: "analysis-v1" },
  provenance_refs:
    (base.provenance_refs as string[] | undefined) ??
    (base.source_id ? [`${String(base.source_id)}:row:${row_id}`] : []),
  ...base,
});

function staticCostMeasures(
  requests: Request[],
): Record<string, number | null> {
  const bases = new Set(requests.map((r) => r.usage.cost_basis));
  const exact =
    bases.size === 1 &&
    !bases.has(null) &&
    requests.every((r) => {
      const c = r.usage.cost_components;
      return (
        c !== undefined &&
        c.input_usd !== null &&
        c.cache_read_usd !== null &&
        c.cache_write_usd !== null &&
        c.output_usd !== null &&
        c.total_usd !== null
      );
    });
  if (!exact)
    return {
      static_input_cost_usd: null,
      static_reasoning_output_cost_usd: null,
      static_non_reasoning_output_cost_usd: null,
      static_total_cost_usd: null,
    };
  let input = 0,
    reasoning = 0,
    nonReasoning = 0,
    total = 0;
  for (const r of requests) {
    const c = r.usage.cost_components!;
    input += c.input_usd! + c.cache_read_usd! + c.cache_write_usd!;
    const outputTokens = r.usage.output_tokens;
    const reasoningFraction =
      outputTokens === 0 ? 0 : r.usage.reasoning_tokens / outputTokens;
    reasoning += c.output_usd! * reasoningFraction;
    nonReasoning += c.output_usd! * (1 - reasoningFraction);
    total += c.total_usd!;
  }
  // Component availability plus native total reconciliation was validated by the adapter.
  return {
    static_input_cost_usd: input,
    static_reasoning_output_cost_usd: reasoning,
    static_non_reasoning_output_cost_usd: nonReasoning,
    static_total_cost_usd: total,
  };
}

function requestMeasures(requests: Request[]): Record<string, number | null> {
  const validElapsed = requests.filter((r) => r.observed_elapsed_ms !== null);
  return {
    request_count: requests.length,
    observed_request_elapsed_ms: sum(
      validElapsed.map((r) => r.observed_elapsed_ms!),
    ),
    input_tokens: sum(
      requests.map(
        (r) =>
          r.usage.input_tokens +
          r.usage.cache_read_tokens +
          r.usage.cache_write_tokens,
      ),
    ),
    reasoning_output_tokens: sum(requests.map((r) => r.usage.reasoning_tokens)),
    non_reasoning_output_tokens: sum(
      requests.map((r) => r.usage.output_tokens - r.usage.reasoning_tokens),
    ),
    total_tokens: sum(requests.map((r) => r.usage.total_tokens)),
    ...staticCostMeasures(requests),
  };
}

export function analyze(prepared: PreparedTeamConversation): AnalysisEnvelope {
  const rows: AnalysisRow[] = [];
  prepared.agents.forEach((x) =>
    rows.push(
      row(prepared, "agent", x.agent_id, {
        ...x,
        source_id: x.source_id,
        agent_id: x.agent_id,
        evidence: x.evidence,
      }),
    ),
  );
  prepared.turns
    .slice()
    .sort(
      (a, b) =>
        (a.timestamp_ms ?? Infinity) - (b.timestamp_ms ?? Infinity) ||
        a.ordinal - b.ordinal,
    )
    .forEach((x, global_ordinal) =>
      rows.push(
        row(prepared, "turn", x.turn_id, {
          ...x,
          global_ordinal,
          source_id: x.source_id,
          agent_id: x.agent_id,
          turn_id: x.turn_id,
          evidence: x.evidence,
        }),
      ),
    );
  const cumulativeByAgent = new Map<
    string,
    { input: number; cost: number | null }
  >();
  prepared.requests
    .slice()
    .sort(
      (a, b) =>
        (a.assistant_response_recorded_ms ?? Infinity) -
        (b.assistant_response_recorded_ms ?? Infinity),
    )
    .forEach((x) => {
      const previous = cumulativeByAgent.get(x.agent_id) ?? {
        input: 0,
        cost: 0,
      };
      previous.input +=
        x.usage.input_tokens +
        x.usage.cache_read_tokens +
        x.usage.cache_write_tokens;
      previous.cost =
        previous.cost === null || x.usage.estimated_cost_usd === null
          ? null
          : previous.cost + x.usage.estimated_cost_usd;
      cumulativeByAgent.set(x.agent_id, previous);
      rows.push(
        row(prepared, "request_interval", x.request_id, {
          ...x,
          source_id: x.source_id,
          agent_id: x.agent_id,
          turn_id: x.turn_id,
          request_id: x.request_id,
          evidence: x.evidence,
        }),
      );
      if (x.assistant_response_recorded_ms !== null)
        rows.push(
          row(
            prepared,
            "cumulative_usage_point",
            `${x.request_id}:cumulative`,
            {
              source_id: x.source_id,
              agent_id: x.agent_id,
              request_id: x.request_id,
              at_ms: x.assistant_response_recorded_ms,
              input_increment:
                x.usage.input_tokens +
                x.usage.cache_read_tokens +
                x.usage.cache_write_tokens,
              cost_increment: x.usage.estimated_cost_usd,
              cumulative_input_tokens: previous.input,
              cumulative_estimated_cost_usd: previous.cost,
              evidence: {
                class: "derived",
                basis: "request-native response-recorded step",
              },
            },
          ),
        );
    });
  const exactQuiet = prepared.quiet_gaps.filter(
    (g) => g.end_ms !== null && g.qualification === "exact_next_user",
  );
  const cuts = [
    ...new Set(exactQuiet.flatMap((g) => [g.start_ms, g.end_ms!])),
  ].sort((a, b) => a - b);
  const globalSegments: { start: number; end: number }[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const start = cuts[i],
      end = cuts[i + 1];
    const coveredByEveryAgent = prepared.agents.every((a) =>
      exactQuiet.some(
        (g) =>
          g.agent_id === a.agent_id && g.start_ms <= start && g.end_ms! >= end,
      ),
    );
    const hasObservedRequest = prepared.requests.some(
      (r) =>
        r.assistant_request_start_ms !== null &&
        r.assistant_response_recorded_ms !== null &&
        r.assistant_request_start_ms < end &&
        r.assistant_response_recorded_ms > start,
    );
    const hasToolObservation = prepared.tool_events.some(
      (e) =>
        e.timestamp_ms !== null &&
        e.timestamp_ms >= start &&
        e.timestamp_ms < end,
    );
    if (coveredByEveryAgent && !hasObservedRequest && !hasToolObservation) {
      const prior = globalSegments.at(-1);
      if (prior?.end === start) prior.end = end;
      else globalSegments.push({ start, end });
    }
  }
  globalSegments.forEach((g, i) =>
    rows.push(
      row(prepared, "global_quiet_gap", `global:${i}`, {
        start_ms: g.start,
        end_ms: g.end,
        hidden_duration_ms: g.end - g.start,
        qualification: "exact_all_included_agents_quiet",
        provenance_refs: exactQuiet
          .filter((gap) => gap.start_ms <= g.start && gap.end_ms! >= g.end)
          .map((gap) => gap.gap_id),
        evidence: {
          class: "derived",
          basis:
            "intersection of exact quiet intervals for every included agent; excludes observed request and tool activity",
        },
      }),
    ),
  );
  prepared.content_parts.forEach((x) =>
    rows.push(
      row(prepared, "content_part", x.part_id, {
        ...x,
        source_id: x.source_id,
        agent_id: x.agent_id,
        turn_id: x.turn_id,
        request_id: x.request_id,
        evidence: x.evidence,
      }),
    ),
  );
  prepared.tool_events.forEach((x) =>
    rows.push(
      row(prepared, "tool_event", x.tool_event_id, {
        ...x,
        source_id: x.source_id,
        agent_id: x.agent_id,
        turn_id: x.turn_id,
        request_id: x.request_id,
        evidence: x.evidence,
      }),
    ),
  );
  prepared.tool_spans.forEach((x) =>
    rows.push(
      row(prepared, "tool_observation_span", x.span_id, {
        ...x,
        source_id: x.source_id,
        agent_id: x.agent_id,
        turn_id: x.turn_id,
        request_id: x.request_id,
        evidence: x.evidence,
      }),
    ),
  );
  prepared.quiet_gaps.forEach((x) =>
    rows.push(
      row(prepared, "quiet_gap", x.gap_id, {
        ...x,
        source_id: x.source_id,
        agent_id: x.agent_id,
        turn_id: x.after_turn_id,
        evidence: x.evidence,
      }),
    ),
  );
  const intervals = prepared.requests
    .filter(
      (r) =>
        r.assistant_request_start_ms !== null &&
        r.assistant_response_recorded_ms !== null,
    )
    .flatMap((r) => [
      { at: r.assistant_request_start_ms!, delta: 1, agent: r.agent_id },
      { at: r.assistant_response_recorded_ms!, delta: -1, agent: r.agent_id },
    ])
    .sort((a, b) => a.at - b.at || a.delta - b.delta);
  const active = new Map<string, number>();
  let last: number | null = null;
  for (const e of intervals) {
    if (last !== null && last < e.at && active.size)
      rows.push(
        row(prepared, "active_agent_interval", `active:${last}:${e.at}`, {
          start_ms: last,
          end_ms: e.at,
          distinct_active_agents: active.size,
          evidence: {
            class: "derived",
            basis: "half-open interval union distinct agent IDs",
          },
        }),
      );
    active.set(e.agent, (active.get(e.agent) ?? 0) + e.delta);
    if (active.get(e.agent) === 0) active.delete(e.agent);
    last = e.at;
  }
  const aggregates: Aggregate[] = [];
  const makeUsage = (agent: string | null) => {
    const rs = prepared.requests.filter(
      (r) => agent === null || r.agent_id === agent,
    );
    aggregates.push({
      aggregate_id: `usage:${agent ?? "team"}`,
      kind: "usage_aggregate",
      dimensions: { agent_id: agent },
      measures: requestMeasures(rs),
      semantics:
        "request-native usage; reasoning is output subset; static component cost requires one reconciled cost basis and output allocation is proportional to output tokens, not billed truth",
      evidence: { class: "derived", basis: "distinct request sum" },
    });
  };
  makeUsage(null);
  prepared.agents.forEach((a) => makeUsage(a.agent_id));
  const turnById = new Map(prepared.turns.map((t) => [t.turn_id, t]));
  const groupedRequests = new Map<
    string,
    { dimensions: Record<string, string | null>; requests: Request[] }
  >();
  for (const request of prepared.requests) {
    const trigger = request.turn_id
      ? (turnById.get(request.turn_id)?.classifier ?? "trigger_absent")
      : "trigger_absent";
    const dimensions = {
      agent_id: request.agent_id,
      turn_id: request.turn_id,
      trigger,
      provider: request.provider,
      model: request.model,
      outcome: request.outcome,
      cost_basis: request.usage.cost_basis,
    };
    const key = JSON.stringify(dimensions);
    const group: {
      dimensions: Record<string, string | null>;
      requests: Request[];
    } = groupedRequests.get(key) ?? { dimensions, requests: [] };
    group.requests.push(request);
    groupedRequests.set(key, group);
  }
  for (const [key, group] of groupedRequests)
    aggregates.push({
      aggregate_id: `request:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`,
      kind: "request_aggregate",
      dimensions: group.dimensions,
      measures: requestMeasures(group.requests),
      semantics:
        "request-native tokens/static cost and separately summed valid observed request envelopes; no interval-union or tool runtime claim",
      evidence: {
        class: "derived",
        basis: "parameterized distinct request grouping",
      },
    });
  const quietGroups = new Map<string, PreparedTeamConversation["quiet_gaps"]>();
  for (const gap of prepared.quiet_gaps) {
    const kind =
      gap.qualification === "right_censored_trace_end"
        ? "right_censored"
        : gap.qualification === "exact_next_user"
          ? "exact"
          : "qualified_other";
    const key = JSON.stringify({
      agent_id: gap.agent_id,
      source_id: gap.source_id,
      quiet_kind: kind,
    });
    const group: PreparedTeamConversation["quiet_gaps"] =
      quietGroups.get(key) ?? [];
    group.push(gap);
    quietGroups.set(key, group);
  }
  for (const [key, gaps] of quietGroups) {
    const dims = JSON.parse(key) as Record<string, string | null>;
    const exact = dims.quiet_kind === "exact";
    aggregates.push({
      aggregate_id: `quiet:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`,
      kind: "quiet_aggregate",
      dimensions: dims,
      measures: {
        gap_count: gaps.length,
        exact_quiet_ms: exact ? sum(gaps.map((g) => g.duration_ms ?? 0)) : null,
        right_censored_lower_bound_ms:
          dims.quiet_kind === "right_censored"
            ? sum(gaps.map((g) => g.duration_ms ?? 0))
            : null,
      },
      semantics:
        "exact quiet is stop-to-next-user endpoint separation; right-censored values are lower bounds and never included in exact totals",
      evidence: { class: "derived", basis: "qualified quiet-gap grouping" },
    });
  }
  const event = (agent: string | null) => {
    const rs = prepared.requests.filter(
        (r) => agent === null || r.agent_id === agent,
      ),
      ts = prepared.turns.filter((t) => agent === null || t.agent_id === agent),
      calls = prepared.tool_events.filter(
        (t) =>
          t.kind === "call_available" &&
          (agent === null || t.agent_id === agent),
      ),
      results = prepared.tool_events.filter(
        (t) =>
          t.kind === "result_recorded" &&
          (agent === null || t.agent_id === agent),
      );
    aggregates.push({
      aggregate_id: `inventory:${agent ?? "team"}`,
      kind: "event_inventory",
      dimensions: { agent_id: agent },
      measures: {
        user_turns: ts.length,
        user_alerts: ts.filter((t) => t.classifier === "user_alert").length,
        agent_continuations: rs.filter((r) => r.outcome === "continuation")
          .length,
        agent_stops: rs.filter((r) => r.outcome === "stop").length,
        agent_truncated: rs.filter((r) => r.outcome === "truncated").length,
        tool_calls: calls.length,
        tool_results: results.length,
      },
      semantics: "heterogeneous nested-grain inventory, not a turn partition",
      evidence: { class: "derived", basis: "row counts" },
    });
  };
  event(null);
  prepared.agents.forEach((a) => event(a.agent_id));
  const toolGroups = new Map<
    string,
    {
      calls: number;
      results: number;
      missing: number;
      errors: number;
      requests: Set<string>;
      turns: Set<string>;
    }
  >();
  for (const event of prepared.tool_events) {
    if (event.kind !== "call_available") continue;
    const owner = toolOwner(event.tool_name);
    const group = toolGroups.get(owner) ?? {
      calls: 0,
      results: 0,
      missing: 0,
      errors: 0,
      requests: new Set<string>(),
      turns: new Set<string>(),
    };
    group.calls++;
    if (event.pairing_state === "matched") {
      group.results++;
      const result = prepared.tool_events.find(
        (e) =>
          e.kind === "result_recorded" &&
          e.call_id === event.call_id &&
          e.source_id === event.source_id,
      );
      if (result?.status === "error") group.errors++;
    } else group.missing++;
    if (event.request_id) group.requests.add(event.request_id);
    if (event.turn_id) group.turns.add(event.turn_id);
    toolGroups.set(owner, group);
  }
  for (const [owner, group] of toolGroups) {
    const associated = prepared.requests.filter((r) =>
      group.requests.has(r.request_id),
    );
    aggregates.push({
      aggregate_id: `tool:${owner}`,
      kind: "tool_activity",
      dimensions: { tool_owner: owner },
      measures: {
        calls: group.calls,
        recorded_results: group.results,
        errors: group.errors,
        missing_results: group.missing,
        distinct_containing_turns: group.turns.size,
        distinct_containing_requests: group.requests.size,
        associated_request_tokens: sum(
          associated.map((r) => r.usage.total_tokens),
        ),
        associated_estimated_cost_usd: associated.every(
          (r) => r.usage.estimated_cost_usd !== null,
        )
          ? sum(associated.map((r) => r.usage.estimated_cost_usd!))
          : null,
      },
      semantics:
        "versioned tool-owner manifest; associated request usage is noncausal and nonadditive",
      evidence: {
        class: "associated",
        basis: "tool call contains request relation",
      },
    });
  }
  const reconciliation = {
    requests: prepared.requests.length,
    total_tokens: sum(prepared.requests.map((r) => r.usage.total_tokens)),
    input_tokens: sum(
      prepared.requests.map(
        (r) =>
          r.usage.input_tokens +
          r.usage.cache_read_tokens +
          r.usage.cache_write_tokens,
      ),
    ),
    output_tokens: sum(prepared.requests.map((r) => r.usage.output_tokens)),
    reasoning_tokens: sum(
      prepared.requests.map((r) => r.usage.reasoning_tokens),
    ),
    estimated_cost_usd: prepared.requests.every(
      (r) => r.usage.estimated_cost_usd !== null,
    )
      ? sum(prepared.requests.map((r) => r.usage.estimated_cost_usd!))
      : null,
    matched_tool_spans: prepared.tool_spans.length,
    exact_quiet_ms: sum(
      prepared.quiet_gaps.map((g) =>
        g.qualification === "exact_next_user" ? (g.duration_ms ?? 0) : 0,
      ),
    ),
    diagnostics: prepared.diagnostics.length,
  };
  const analysis_id = createHash("sha256")
    .update(`${prepared.prepared_derivation_id}|analysis-v2`)
    .digest("hex");
  return {
    schema_version: SCHEMA_VERSION,
    analysis_contract_version: ANALYSIS_CONTRACT_VERSION,
    prepared_derivation_id: prepared.prepared_derivation_id,
    analysis_id,
    parameters: {
      interval_policy: "half-open-distinct-agent-union",
      tool_span: "not_tool_runtime",
      aggregate_version: "v2-component-cost-and-qualified-quiet",
    },
    provenance: prepared.provenance,
    report: {
      title: "Agent-turns viz",
      team_name: prepared.team.team_name,
      leader_session_id: prepared.team.leader_session_id,
      leader_session_name: prepared.team.leader_session_name,
      coverage: prepared.coverage,
    },
    rows,
    aggregates,
    reconciliation,
    diagnostics: prepared.diagnostics,
  };
}
