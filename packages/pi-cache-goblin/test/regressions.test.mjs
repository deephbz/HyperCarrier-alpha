import assert from "node:assert/strict";
import { test } from "node:test";
import { headOf, isAnthropicMessagesPayload, placeMarkers } from "../src/plan.mjs";
import { findGlobalBoundary } from "../src/system-split.mjs";
const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const payload = () => ({ model: "claude-example", max_tokens: 100, stream: true,
  system: [{ type: "text", text: "global\n<cwd>\n/project\n</cwd>" }], messages: [user("held")] });
const plan = { sessionTtl: "5m", globalBoundary: (text) => text.indexOf("<cwd>") };

test("all request-head fields invalidate held pins, including new provider fields", () => {
  const first = placeMarkers(payload(), { ...plan, pins: [{ name: "held" }] });
  for (const change of [ { model: "claude-other" }, { tools: [{ name: "new", input_schema: {} }] },
    { thinking: { type: "disabled" } }, { tool_choice: { type: "auto" } },
    { output_config: { effort: "high" } }, { metadata: { user_id: "synthetic-user" } },
    { future_cache_key: "new" } ]) {
    const next = { ...payload(), ...change };
    next.messages.push(user("tail"));
    const result = placeMarkers(next, { ...plan, pins: first.pins });
    assert.equal(result.pins[0].status, "stale", JSON.stringify(change));
  }
});

test("system splitting does not invalidate a pin on replay of a transformed payload", () => {
  const first = placeMarkers(payload(), { ...plan, pins: [{ name: "held" }] });
  assert.deepEqual(headOf(first.payload), headOf(payload()));
  const next = structuredClone(first.payload);
  next.messages.push(user("tail"));
  const result = placeMarkers(next, { ...plan, pins: first.pins });
  assert.equal(result.pins[0].status, "placed");
});

test("malformed pin coordinates cannot throw or bind to a different block", () => {
  const valid = placeMarkers(payload(), { ...plan, pins: [{ name: "held" }] }).pins[0].at;
  for (const at of [null, {}, { ...valid, messageIndex: -1 }, { ...valid, messageIndex: 0.1 },
    { ...valid, blockIndex: "0" }, { ...valid, hash: "invalid" }, { ...valid, messageIndex: 999 }]) {
    const result = placeMarkers(payload(), { ...plan, pins: [{ name: "held", at }] });
    assert.equal(result.pins[0].status, "stale");
  }
});

test("planner retains only the latest held pin even when all pending pins share the tail", () => {
  const result = placeMarkers(payload(), { ...plan, pins: [{ name: "a" }, { name: "b" }, { name: "c" }] });
  assert.deepEqual(result.pins.map((p) => p.status), ["dropped", "dropped", "placed"]);
});

test("current Pi addendum never enters the global layer by accident", () => {
  const text = 'global rules\n\n<addendum>\n<project_instructions path="/project/AGENTS.md">\nproject\n</project_instructions>\n</addendum>\n<cwd>\n/project\n</cwd>';
  const at = findGlobalBoundary(text, { globalPaths: [] });
  assert.equal(text.slice(0, at), "global rules\n\n");
});

test("unknown and OpenAI-shaped content fails open at payload recognition", () => {
  for (const change of [{ response_format: {} }, { system: undefined },
    { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "synthetic" } }] }] },
    { tools: [{ type: "function", function: { name: "read" } }] },
    { messages: [{ role: "system", content: "instructions" }] },
    { messages: [{ role: "system", content: [{ type: "image", source: {} }] }] },
    { messages: [{ role: "system", content: [{ type: "tool_use", id: "synthetic", name: "read", input: {} }] }] },
    { messages: [{ role: "system", content: [{ type: "future_system_delta" }] }] }]) {
    assert.equal(isAnthropicMessagesPayload({ ...payload(), ...change }), false);
  }
});

test("raw multimodal blocks and message metadata remain unchanged apart from markers", () => {
  const input = payload();
  input.messages[0] = { role: "user", metadata: { synthetic: true }, content: [
    { type: "image", source: { type: "base64", media_type: "image/png", data: "synthetic-bytes" } },
    { type: "tool_result", tool_use_id: "synthetic-tool", content: "verbatim\n  whitespace" },
  ] };
  const before = structuredClone(input);
  const out = placeMarkers(input, plan).payload;
  delete out.messages[0].content[1].cache_control;
  assert.deepEqual(out.messages, before.messages);
  assert.deepEqual(input, before);
  assert.equal(out.system.map((b) => b.text).join(""), before.system[0].text);
});
