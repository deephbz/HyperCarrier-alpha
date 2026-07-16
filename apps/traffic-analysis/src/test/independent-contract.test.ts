import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preparePiJsonl } from "../adapters/pi/prepare.js";
import { analyze } from "../domain/analyze.js";
import { InMemorySourceStore } from "../application/store.js";
import { readAllowlistedAttribution } from "../adapters/pi-teams/attribution.js";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

test("independent: native Pi-style usage fields preserve cache and reasoning-subset reconciliation", () => {
  const prepared = preparePiJsonl(
    line({ type: "session", id: "native-fields" }) +
      line({
        timestamp: "2026-07-14T00:00:00.000Z",
        message: { role: "user", content: "approved excerpt" },
      }) +
      line({
        timestamp: "2026-07-14T00:00:02.000Z",
        message: {
          role: "assistant",
          timestamp: 1783987200000,
          usage: {
            input: 10,
            output: 8,
            cacheRead: 3,
            cacheWrite: 2,
            reasoning: 5,
            totalTokens: 23,
            cost: { total: 0.25 },
          },
          content: [],
        },
      }),
    "test-native",
  );
  const usage = prepared.requests[0].usage;
  assert.deepEqual(usage, {
    input_tokens: 10,
    output_tokens: 8,
    cache_read_tokens: 3,
    cache_write_tokens: 2,
    reasoning_tokens: 5,
    total_tokens: 23,
    estimated_cost_usd: 0.25,
    cost_basis: "pi_model_table_static_estimate",
  });
  const aggregate = analyze(prepared).aggregates.find(
    (x) => x.aggregate_id === "usage:team",
  )!;
  assert.equal(aggregate.measures.input_tokens, 15);
  assert.equal(aggregate.measures.reasoning_output_tokens, 5);
  assert.equal(aggregate.measures.non_reasoning_output_tokens, 3);
  assert.equal(aggregate.measures.total_tokens, 23);
});

test("independent: exact tool call IDs are source-scoped, not cross-source", () => {
  const source = (id: string, at: string) =>
    preparePiJsonl(
      line({ type: "session", id }) +
        line({
          timestamp: at,
          message: {
            role: "assistant",
            timestamp: Date.parse(at),
            content: [{ type: "toolCall", id: "same-id", name: "read" }],
          },
        }) +
        line({
          timestamp: new Date(Date.parse(at) + 1_000).toISOString(),
          message: { role: "toolResult", toolCallId: "same-id" },
        }),
      id,
    );
  const one = source("source-one", "2026-07-14T00:00:00.000Z");
  const two = source("source-two", "2026-07-14T00:01:00.000Z");
  assert.equal(one.tool_spans.length, 1);
  assert.equal(two.tool_spans.length, 1);
  assert.notEqual(one.tool_spans[0].span_id, two.tool_spans[0].span_id);
  assert.equal(one.tool_spans[0].call_id, "same-id");
  assert.equal(two.tool_spans[0].call_id, "same-id");
});

test("independent: active-interval union counts a repeated agent once", () => {
  const first = preparePiJsonl(
    line({ type: "session", id: "agent-a" }) +
      line({
        timestamp: "2026-07-14T00:00:10.000Z",
        message: { role: "assistant", timestamp: 1783987200000, content: [] },
      }) +
      line({
        timestamp: "2026-07-14T00:00:12.000Z",
        message: { role: "assistant", timestamp: 1783987202000, content: [] },
      }),
    "a",
  );
  const second = preparePiJsonl(
    line({ type: "session", id: "agent-b" }) +
      line({
        timestamp: "2026-07-14T00:00:08.000Z",
        message: { role: "assistant", timestamp: 1783987204000, content: [] },
      }),
    "b",
  );
  const merged = {
    ...first,
    agents: [...first.agents, ...second.agents],
    requests: [...first.requests, ...second.requests],
    turns: [],
    content_parts: [],
    tool_events: [],
    tool_spans: [],
    quiet_gaps: [],
    diagnostics: [],
  };
  const intervals = analyze(merged).rows.filter(
    (x) => x.row_type === "active_agent_interval",
  );
  assert.deepEqual(
    intervals.map((x) => [x.start_ms, x.end_ms, x.distinct_active_agents]),
    [
      [1783987200000, 1783987202000, 1],
      [1783987202000, 1783987204000, 1],
      [1783987204000, 1783987208000, 2],
      [1783987208000, 1783987210000, 1],
      [1783987210000, 1783987212000, 1],
    ],
  );
});

test("independent: thinking, tool payload, custom payload, and malformed raw text never cross the analysis envelope", async () => {
  const sentinels = [
    "THINKING_SECRET",
    "TOOL_ARGUMENT_SECRET",
    "TOOL_RESULT_SECRET",
    "CUSTOM_SECRET",
    "MALFORMED_SECRET",
  ];
  const bytes =
    line({ type: "session", id: "privacy" }) +
    line({
      timestamp: "2026-07-14T00:00:00.000Z",
      message: {
        role: "assistant",
        timestamp: 1783987200000,
        content: [
          { type: "thinking", thinking: sentinels[0] },
          { type: "toolCall", id: "c", name: "read", arguments: sentinels[1] },
          { type: "custom", data: sentinels[3] },
        ],
      },
    }) +
    line({
      timestamp: "2026-07-14T00:00:01.000Z",
      message: { role: "toolResult", toolCallId: "c", content: sentinels[2] },
    }) +
    `{bad:${sentinels[4]}}\n`;
  const output = JSON.stringify(analyze(preparePiJsonl(bytes, "privacy")));
  for (const sentinel of sentinels)
    assert.equal(output.includes(sentinel), false, sentinel);
  const dir = await mkdtemp(join(tmpdir(), "traffic-independence-"));
  const file = join(dir, "privacy.jsonl");
  await writeFile(file, bytes);
  assert.equal(
    (await readFile(file, "utf8")).includes("THINKING_SECRET"),
    true,
    "fixture retains raw evidence while output is safe",
  );
});

test("independent: Pi camelCase usage aliases remain a separate compatibility path", () => {
  const prepared = preparePiJsonl(
    line({ type: "session", id: "aliases" }) +
      line({
        timestamp: "2026-07-14T00:00:01.000Z",
        message: {
          role: "assistant",
          timestamp: 1783987200000,
          usage: {
            inputTokens: 2,
            outputTokens: 3,
            cacheReadTokens: 4,
            cacheWriteTokens: 5,
            reasoningTokens: 1,
          },
          content: [],
        },
      }),
    "aliases",
  );
  assert.deepEqual(prepared.requests[0].usage, {
    input_tokens: 2,
    output_tokens: 3,
    cache_read_tokens: 4,
    cache_write_tokens: 5,
    reasoning_tokens: 1,
    total_tokens: 14,
    estimated_cost_usd: null,
    cost_basis: null,
  });
});

test("independent: duplicate and orphan same-source IDs stay explicit rather than being paired by convenience", () => {
  const prepared = preparePiJsonl(
    line({ type: "session", id: "duplicates" }) +
      line({
        timestamp: "2026-07-14T00:00:00.000Z",
        message: {
          role: "assistant",
          timestamp: 1783987200000,
          content: [{ type: "toolCall", id: "duplicate", name: "read" }],
        },
      }) +
      line({
        timestamp: "2026-07-14T00:00:01.000Z",
        message: {
          role: "assistant",
          timestamp: 1783987201000,
          content: [{ type: "toolCall", id: "duplicate", name: "read" }],
        },
      }) +
      line({
        timestamp: "2026-07-14T00:00:02.000Z",
        message: { role: "toolResult", toolCallId: "duplicate" },
      }) +
      line({
        timestamp: "2026-07-14T00:00:03.000Z",
        message: { role: "toolResult", toolCallId: "orphan" },
      }),
    "duplicates",
  );
  assert.equal(prepared.tool_spans.length, 0);
  assert.equal(
    prepared.tool_events.filter(
      (x) => x.call_id === "duplicate" && x.pairing_state === "ambiguous",
    ).length,
    3,
  );
  assert.equal(
    prepared.tool_events.find((x) => x.call_id === "orphan")?.kind,
    "orphan_result",
  );
  assert.equal(
    prepared.tool_events.find((x) => x.call_id === "orphan")?.pairing_state,
    "orphan_result",
  );
});

test("independent: append preserves header-derived source/row IDs and store replay parity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "traffic-identities-"));
  const file = join(dir, "source.jsonl");
  const base =
    line({ type: "session", id: "stable-session" }) +
    line({
      timestamp: "2026-07-14T00:00:00.000Z",
      message: { role: "user", content: "x" },
    });
  await writeFile(file, base);
  const store = new InMemorySourceStore();
  await store.load(file);
  const before = store
    .snapshot()
    .rows.filter((x) => x.row_type === "turn")
    .map((x) => x.row_id);
  const appended = line({
    timestamp: "2026-07-14T00:00:01.000Z",
    message: { role: "assistant", timestamp: 1783987200000, content: [] },
  });
  await writeFile(file, base + appended);
  await store.reconcile(file);
  const after = store
    .snapshot()
    .rows.filter((x) => x.row_type === "turn")
    .map((x) => x.row_id);
  assert.deepEqual(after, before);
  const cold = new InMemorySourceStore();
  await cold.load(file);
  assert.deepEqual(store.snapshot(), cold.snapshot());
});

test("independent: exact and right-censored quiet gaps begin at the persisted stop response", () => {
  const prepared = preparePiJsonl(
    line({ type: "session", id: "gaps" }) +
      line({
        timestamp: "2026-07-14T00:00:00.000Z",
        message: { role: "user", content: "one" },
      }) +
      line({
        timestamp: "2026-07-14T00:00:10.000Z",
        message: {
          role: "assistant",
          timestamp: 1783987202000,
          stopReason: "stop",
          content: [],
        },
      }) +
      line({
        timestamp: "2026-07-14T00:00:15.000Z",
        message: { role: "user", content: "two" },
      }) +
      line({
        timestamp: "2026-07-14T00:00:20.000Z",
        message: {
          role: "assistant",
          timestamp: 1783987216000,
          stopReason: "stop",
          content: [],
        },
      }),
    "gaps",
  );
  assert.deepEqual(
    prepared.quiet_gaps.map((x) => [
      x.start_ms,
      x.end_ms,
      x.duration_ms,
      x.qualification,
    ]),
    [
      [1783987210000, 1783987215000, 5000, "exact_next_user"],
      [1783987220000, 1783987220000, 0, "right_censored_trace_end"],
    ],
  );
});

test("independent: allowlisted PiTeams member and lead mappings preserve separate source evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "traffic-team-"));
  await writeFile(
    join(dir, "config.json"),
    JSON.stringify({
      name: "independent-team",
      members: [
        { name: "worker", sessionFile: "/sessions/worker.jsonl" },
        { name: "unmapped" },
      ],
    }),
  );
  await writeFile(
    join(dir, "lead-session.json"),
    JSON.stringify({ sessionFile: "/sessions/lead.jsonl" }),
  );
  assert.deepEqual(await readAllowlistedAttribution(dir), [
    {
      session_file: "/sessions/worker.jsonl",
      member_name: "worker",
      team_name: "independent-team",
      is_leader: false,
      evidence: {
        class: "observed",
        basis: "PiTeams config explicit member.sessionFile",
      },
    },
    {
      session_file: "/sessions/lead.jsonl",
      member_name: "team-lead",
      team_name: "independent-team",
      is_leader: true,
      evidence: {
        class: "observed",
        basis: "PiTeams lead-session explicit sessionFile",
      },
    },
  ]);
});

test("independent: global quiet gaps require every agent quiet and exclude observed request intervals", () => {
  const source = (id: string, extraRequest: boolean) =>
    preparePiJsonl(
      line({ type: "session", id }) +
        line({
          timestamp: "2026-07-14T00:00:00.000Z",
          message: { role: "user", content: "start" },
        }) +
        line({
          timestamp: "2026-07-14T00:00:10.000Z",
          message: {
            role: "assistant",
            timestamp: 1783987202000,
            stopReason: "stop",
            content: [],
          },
        }) +
        (extraRequest
          ? line({
              timestamp: "2026-07-14T00:00:16.000Z",
              message: {
                role: "assistant",
                timestamp: 1783987212000,
                content: [],
              },
            })
          : "") +
        line({
          timestamp: "2026-07-14T00:00:20.000Z",
          message: { role: "user", content: "next" },
        }),
      id,
    );
  const left = source("global-left", false),
    right = source("global-right", false);
  const merge = (a: typeof left, b: typeof right) => ({
    ...a,
    agents: [...a.agents, ...b.agents],
    turns: [...a.turns, ...b.turns],
    requests: [...a.requests, ...b.requests],
    content_parts: [],
    tool_events: [],
    tool_spans: [],
    quiet_gaps: [...a.quiet_gaps, ...b.quiet_gaps],
    diagnostics: [],
  });
  const exact = analyze(merge(left, right)).rows.filter(
    (x) => x.row_type === "global_quiet_gap",
  );
  assert.deepEqual(
    exact.map((x) => [
      x.start_ms,
      x.end_ms,
      x.hidden_duration_ms,
      x.qualification,
      x.agent_id,
      x.provenance_refs.length,
    ]),
    [
      [
        1783987210000,
        1783987220000,
        10000,
        "exact_all_included_agents_quiet",
        null,
        2,
      ],
    ],
  );
  const active = analyze(
    merge(left, source("global-active", true)),
  ).rows.filter((x) => x.row_type === "global_quiet_gap");
  assert.equal(active.length, 0);
});

test("independent: malformed/partial append has cold-replay parity rather than silently retaining old projection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "traffic-partial-"));
  const file = join(dir, "source.jsonl");
  const base =
    line({ type: "session", id: "tail" }) +
    line({
      timestamp: "2026-07-14T00:00:00.000Z",
      message: { role: "user", content: "x" },
    });
  await writeFile(file, base);
  const incremental = new InMemorySourceStore();
  await incremental.load(file);
  await writeFile(file, `${base}{"timestamp":"partial`);
  await incremental.reconcile(file);
  const cold = new InMemorySourceStore();
  await cold.load(file);
  assert.deepEqual(incremental.snapshot(), cold.snapshot());
});
