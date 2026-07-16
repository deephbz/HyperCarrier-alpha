import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { preparePiJsonl } from "../adapters/pi/prepare.js";
import { analyze } from "../domain/analyze.js";
import { InMemorySourceStore } from "../application/store.js";

const componentSource = `{"type":"session","id":"cost"}
{"timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"x"}}
{"timestamp":"2026-01-01T00:00:02Z","message":{"role":"assistant","timestamp":1000,"provider":"p","model":"m","stopReason":"stop","usage":{"input":10,"output":8,"reasoning":2,"cacheRead":1,"cacheWrite":1,"totalTokens":20,"cost":{"input":1,"cacheRead":0.1,"cacheWrite":0.1,"output":0.8,"total":2}},"content":[]}}
{"timestamp":"2026-01-01T00:00:04Z","message":{"role":"user","content":"y"}}`;

test("component costs allocate output proportionally and unavailable components stay null", () => {
  const analysis = analyze(preparePiJsonl(componentSource, "cost"));
  const usage = analysis.aggregates.find(
    (a) => a.kind === "usage_aggregate" && a.dimensions.agent_id === null,
  )!;
  assert.equal(usage.measures.request_count, 1);
  assert.equal(usage.measures.input_tokens, 12);
  assert.equal(usage.measures.reasoning_output_tokens, 2);
  assert.equal(usage.measures.non_reasoning_output_tokens, 6);
  assert.equal(usage.measures.total_tokens, 20);
  assert.ok((usage.measures.observed_request_elapsed_ms ?? 0) > 0);
  assert.ok(Math.abs((usage.measures.static_input_cost_usd ?? 0) - 1.2) < 1e-9);
  assert.equal(usage.measures.static_reasoning_output_cost_usd, 0.2);
  assert.equal(usage.measures.static_total_cost_usd, 2);
  const requests = analysis.aggregates.filter(
    (a) => a.kind === "request_aggregate",
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].dimensions.trigger, "user_request");
  assert.equal(requests[0].dimensions.provider, "p");
  const unavailable = analyze(
    preparePiJsonl(
      componentSource.replace(
        '"cost":{"input":1,"cacheRead":0.1,"cacheWrite":0.1,"output":0.8,"total":2}',
        '"cost":{"total":2}',
      ),
      "cost",
    ),
  );
  const unavailableUsage = unavailable.aggregates.find(
    (a) => a.kind === "usage_aggregate" && a.dimensions.agent_id === null,
  )!;
  assert.equal(unavailableUsage.measures.static_total_cost_usd, null);
  assert.equal(unavailableUsage.measures.static_input_cost_usd, null);
});

test("missing request cost never becomes a zero or partial turn/reconciliation total", () => {
  const mixed = componentSource.replace(
    '{"timestamp":"2026-01-01T00:00:04Z","message":{"role":"user","content":"y"}}',
    '{"timestamp":"2026-01-01T00:00:03Z","message":{"role":"assistant","timestamp":2000,"provider":"p","model":"m","stopReason":"stop","usage":{"input":1,"output":1,"totalTokens":2},"content":[]}}\n{"timestamp":"2026-01-01T00:00:04Z","message":{"role":"user","content":"y"}}',
  );
  const analysis = analyze(preparePiJsonl(mixed, "mixed-cost"));
  assert.equal(analysis.reconciliation.estimated_cost_usd, null);
  const turn = analysis.rows.find((row) => row.row_type === "turn")!;
  assert.equal(turn.following_estimated_cost_usd, null);
  const requestAggregates = analysis.aggregates.filter(
    (aggregate) => aggregate.kind === "request_aggregate",
  );
  assert.equal(requestAggregates.length, 2);
  assert.ok(
    requestAggregates.every(
      (aggregate) => typeof aggregate.dimensions.turn_id === "string",
    ),
  );
});

test("quiet aggregates keep exact and censored values separate", () => {
  const analysis = analyze(preparePiJsonl(componentSource, "quiet"));
  const quiet = analysis.aggregates.find((a) => a.kind === "quiet_aggregate")!;
  assert.equal(quiet.dimensions.quiet_kind, "exact");
  assert.equal(quiet.measures.exact_quiet_ms, 2000);
  assert.equal(quiet.measures.right_censored_lower_bound_ms, null);
});

test("stat-before-read skips unchanged inputs and deletion/reappearance is typed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "traffic-residual-"));
  const path = join(dir, "s.jsonl");
  await writeFile(path, componentSource);
  const store = new InMemorySourceStore();
  await store.load(path);
  const bytes = store.metrics.bytes_read;
  await store.reconcile(path);
  assert.equal(store.metrics.bytes_read, bytes);
  assert.equal(store.metrics.unchanged_skips, 1);
  await rm(path);
  await store.reconcile(path);
  assert.equal(
    store.snapshot().diagnostics.some((d) => d.code === "source_missing"),
    true,
  );
  await writeFile(path, componentSource);
  await store.reconcile(path);
  assert.equal(
    store.snapshot().diagnostics.some((d) => d.code === "source_missing"),
    false,
  );
  await rm(dir, { recursive: true, force: true });
});
