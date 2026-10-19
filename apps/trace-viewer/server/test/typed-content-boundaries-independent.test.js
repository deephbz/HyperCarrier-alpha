import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createIncrementalTraceReader, projectPiTrace } from "../live-detail.js";

const session = (id = "typed-content-session") => ({
  type: "session",
  version: 3,
  id,
  timestamp: "2026-09-21T00:00:00.000Z",
  cwd: "/safe",
});
const user = (id, content = "Owner request") => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "2026-09-21T00:00:01.000Z",
  message: { role: "user", content: [{ type: "text", text: content }] },
});
const assistant = (id, parentId, content) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-09-21T00:00:02.000Z",
  message: { role: "assistant", stopReason: "stop", content },
});
const toolResult = (id, parentId, toolCallId, content, extra = {}) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-09-21T00:00:03.000Z",
  message: {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content,
    ...extra,
  },
});
const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

function project(records) {
  const root = mkdtempSync(join(tmpdir(), "typed-trace-boundaries-"));
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot);
  const path = join(projectRoot, "session.jsonl");
  writeFileSync(path, jsonl(records));
  const update = createIncrementalTraceReader(path).refresh();
  assert.equal(update.projection?.availability, "available");
  return projectPiTrace(update.projection);
}

function record(trace, id) {
  const found = trace.records.find((item) => item.sourceEntryId === id);
  assert.ok(found, `missing trace record ${id}`);
  return found;
}

test("pi-trace/2 preserves mixed typed block boundaries, source order, and raw identity", () => {
  const image = { type: "image", mimeType: "image/png", data: "opaque-image" };
  const trace = project([
    session(),
    user("u1"),
    assistant("a-mixed", "u1", [
      { type: "thinking", thinking: "private reasoning marker" },
      { type: "text", text: "Visible prose before the call." },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "x" } },
      image,
      { type: "text", text: "Visible prose after the call." },
    ]),
  ]);

  assert.equal(trace.schemaVersion, "pi-trace/2");
  const mixed = record(trace, "a-mixed");
  assert.deepEqual(
    mixed.content.map(({ kind, sourceBlockIndex }) => ({ kind, sourceBlockIndex })),
    [
      { kind: "reasoning", sourceBlockIndex: 0 },
      { kind: "prose", sourceBlockIndex: 1 },
      { kind: "tool_call", sourceBlockIndex: 2 },
      { kind: "unsupported", sourceBlockIndex: 3 },
      { kind: "prose", sourceBlockIndex: 4 },
    ],
  );
  assert.equal(mixed.content[0].text, "private reasoning marker");
  assert.equal(mixed.content[1].text, "Visible prose before the call.");
  assert.equal(mixed.content[4].text, "Visible prose after the call.");
  assert.deepEqual(mixed.content[2], {
    kind: "tool_call",
    sourceBlockIndex: 2,
    id: "call-1",
    name: "read",
    arguments: { path: "x" },
    toolResultRecordId: null,
  });
  assert.equal(mixed.content[3].nativeType, "image");
  assert.deepEqual(mixed.content[3].raw, image);
  assert.match(mixed.content[3].reason, /not supported/i);
  assert.equal(mixed.raw.message.content[0].thinking, "private reasoning marker");
  assert.deepEqual(mixed.raw.message.content[2], {
    type: "toolCall",
    id: "call-1",
    name: "read",
    arguments: { path: "x" },
  });
  assert.equal("text" in mixed, false);
  assert.equal("toolCalls" in mixed.details, false);
});

test("pi-trace/2 keeps multiple calls, interleaved results, and tool-only or reasoning-only entries distinct", () => {
  const trace = project([
    session("multi-call-session"),
    user("u1"),
    assistant("a-calls", "u1", [
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "one" } },
      { type: "text", text: "I will inspect both files." },
      { type: "toolCall", id: "call-2", name: "read", arguments: { path: "two" } },
    ]),
    toolResult("result-2", "a-calls", "call-2", [
      { type: "text", text: "result two, first block" },
      { type: "text", text: "result two, second block" },
    ]),
    toolResult("result-1", "result-2", "call-1", [{ type: "text", text: "result one" }]),
    assistant("a-tools-only", "result-1", [
      { type: "toolCall", id: "call-3", name: "read", arguments: { path: "three" } },
    ]),
    assistant("a-reasoning-only", "a-tools-only", [
      { type: "thinking", thinking: "reasoning only" },
    ]),
  ]);

  const calls = record(trace, "a-calls");
  assert.deepEqual(
    calls.content.map((block) => block.sourceBlockIndex),
    [0, 1, 2],
  );
  assert.equal(calls.content[0].toolResultRecordId, "entry:result-1");
  assert.equal(calls.content[2].toolResultRecordId, "entry:result-2");
  assert.equal(record(trace, "result-2").toolCallRecordId, "entry:a-calls");
  assert.equal(record(trace, "result-1").toolCallRecordId, "entry:a-calls");
  assert.deepEqual(
    record(trace, "result-2").content.map(({ kind, sourceBlockIndex, text }) => ({
      kind,
      sourceBlockIndex,
      text,
    })),
    [
      { kind: "tool_result", sourceBlockIndex: 0, text: "result two, first block" },
      { kind: "tool_result", sourceBlockIndex: 1, text: "result two, second block" },
    ],
  );
  assert.equal(record(trace, "result-2").content[0].toolCallId, "call-2");
  assert.equal(record(trace, "result-2").content[1].toolCallId, "call-2");
  assert.equal(record(trace, "result-2").content[0].toolName, "read");
  assert.equal(record(trace, "result-2").content[0].isError, false);
  assert.deepEqual(
    record(trace, "a-tools-only").content.map(({ kind, sourceBlockIndex }) => ({
      kind,
      sourceBlockIndex,
    })),
    [{ kind: "tool_call", sourceBlockIndex: 0 }],
  );
  assert.deepEqual(record(trace, "a-reasoning-only").content, [
    { kind: "reasoning", sourceBlockIndex: 0, text: "reasoning only" },
  ]);
});

test("pi-trace/2 preserves empty and image-only records and rejects unknown blocks with incidental fields", () => {
  const trace = project([
    session("unsupported-content-session"),
    user("u1"),
    assistant("a-image-only", "u1", [{ type: "image", data: "image-only" }]),
    assistant("a-empty", "a-image-only", []),
    assistant("a-unknown", "a-empty", [
      { type: "mystery", text: "incidental prose", thinking: "incidental reasoning" },
    ]),
  ]);

  assert.deepEqual(record(trace, "a-image-only").content, [
    {
      kind: "unsupported",
      sourceBlockIndex: 0,
      nativeType: "image",
      reason: "Pi content block type is not supported by the typed trace contract.",
      raw: { type: "image", data: "image-only" },
    },
  ]);
  assert.deepEqual(record(trace, "a-empty").content, []);
  assert.deepEqual(record(trace, "a-unknown").content, [
    {
      kind: "unsupported",
      sourceBlockIndex: 0,
      nativeType: "mystery",
      reason: "Pi content block type is not supported by the typed trace contract.",
      raw: { type: "mystery", text: "incidental prose", thinking: "incidental reasoning" },
    },
  ]);
});

test("pi-trace/2 makes duplicate call IDs ambiguous without losing either call or result", () => {
  const trace = project([
    session("duplicate-call-session"),
    user("u1"),
    assistant("a-first", "u1", [
      { type: "toolCall", id: "duplicate", name: "read", arguments: { path: "one" } },
    ]),
    assistant("a-second", "a-first", [
      { type: "toolCall", id: "duplicate", name: "read", arguments: { path: "two" } },
    ]),
    toolResult("duplicate-result", "a-second", "duplicate", [
      { type: "text", text: "ambiguous result" },
    ]),
  ]);

  assert.equal(record(trace, "a-first").content[0].id, "duplicate");
  assert.equal(record(trace, "a-second").content[0].id, "duplicate");
  assert.equal(record(trace, "a-first").content[0].toolResultRecordId, null);
  assert.equal(record(trace, "a-second").content[0].toolResultRecordId, null);
  assert.equal(record(trace, "duplicate-result").toolCallRecordId, null);
  assert.equal(record(trace, "duplicate-result").content[0].text, "ambiguous result");
});
