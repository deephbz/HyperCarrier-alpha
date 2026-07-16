import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { preparePiJsonl } from "../adapters/pi/prepare.js";
import { analyze } from "../domain/analyze.js";
test("analysis preserves safe semantics and reconciles usage", async () => {
  const p = preparePiJsonl(
    await readFile(resolve(process.cwd(), "fixtures/team.jsonl"), "utf8"),
    "fixture",
  );
  const a = analyze(p);
  assert.equal(p.requests.length, 2);
  assert.equal(p.tool_spans.length, 1);
  assert.equal(p.tool_spans[0].interpretation, "not_tool_runtime");
  assert.equal(a.reconciliation.total_tokens, 27);
  assert.equal(a.reconciliation.reasoning_tokens, 4);
  assert.ok(!JSON.stringify(a).includes("TOP_SECRET"));
  assert.equal(
    a.rows.filter((r) => r.row_type === "active_agent_interval").length,
    2,
  );
});
test("unmatched tool calls remain unmatched rather than proximity paired", () => {
  const p = preparePiJsonl(
    '{"type":"session","id":"x"}\n{"timestamp":"2026-01-01T00:00:00Z","message":{"role":"assistant","timestamp":1,"content":[{"type":"toolCall","id":"a","name":"x"}]}}\n{"timestamp":"2026-01-01T00:00:01Z","message":{"role":"toolResult","toolCallId":"b"}}',
    "x",
  );
  assert.equal(p.tool_spans.length, 0);
  assert.equal(
    p.tool_events.find((e) => e.call_id === "a")?.pairing_state,
    "unmatched_call",
  );
});
