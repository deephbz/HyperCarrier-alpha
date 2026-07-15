import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import registerPiKeyMessageSummary from "../src/extension.mjs";
import { buildPrompt, selectKeyMessages } from "../src/index.mjs";
import { registerKeyMessageSummaryLifecycle } from "../src/lifecycle.mjs";

const waitFor = async (predicate, message) => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
};

function branchWithMachineMetadata(toolCalls = 51) {
  const branch = [
    {
      type: "message",
      id: "/private/session-entry-owner",
      producer: "owner-device-identity",
      timestamp: "2026-07-15T01:02:03.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "Keep the semantic owner request." }],
      },
    },
  ];
  for (let index = 0; index < toolCalls; index += 1) {
    branch.push({
      type: "message",
      id: `/private/session-entry-assistant-${index}`,
      producer: "machine-producer-identity",
      timestamp: `2026-07-15T01:03:${String(index % 60).padStart(2, "0")}.000Z`,
      message: {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "text", text: `Semantic continuation ${index}` },
          { type: "toolCall", id: `private-tool-${index}`, name: "bash", arguments: {} },
        ],
      },
    });
  }
  return branch;
}

function contextFor(branch, outputPath = "/tmp/unused-key-msg-summary.jsonl") {
  return {
    cwd: "/tmp",
    sessionId: "private-session-id",
    isProjectTrusted: () => true,
    sessionManager: {
      getHeader: () => ({ id: "private-session-id" }),
      getBranch: () => branch,
      getSessionFile: () => outputPath,
    },
  };
}

test("provider prompt exposes semantic ordered messages, not machine lineage metadata", () => {
  const prompt = buildPrompt(selectKeyMessages(branchWithMachineMetadata(1)), "contract-test");
  const payload = JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2));

  assert.match(prompt, /Keep the semantic owner request/);
  assert.match(prompt, /Semantic continuation 0/);
  assert.deepEqual(Object.keys(payload), ["messages"]);
  assert.deepEqual(payload.messages.map((message) => Object.keys(message)), [
    ["role", "outcome", "text"],
    ["role", "outcome", "text"],
  ]);
  assert.deepEqual(payload.messages, [
    { role: "user", outcome: "user", text: "Keep the semantic owner request." },
    { role: "assistant", outcome: "continuation", text: "Semantic continuation 0" },
  ]);
  assert.doesNotMatch(prompt, /\/private\/session-entry|machine-producer-identity/);
});

test("mixed follow-up and steer delivery preserves source authority despite Pi queue reordering", () => {
  const handlers = new Map();
  const scheduled = [];
  registerKeyMessageSummaryLifecycle(
    { on: (event, handler) => handlers.set(event, handler) },
    (ctx) => scheduled.push(ctx),
  );
  const ctx = contextFor([]);
  handlers.get("session_start")({}, ctx);
  scheduled.length = 0;

  // Pi drains every steer before follow-ups, even when the follow-up was
  // enqueued first. Source attribution cannot use one global FIFO.
  handlers.get("input")({ source: "extension", text: "extension later", streamingBehavior: "followUp" }, ctx);
  handlers.get("input")({ source: "interactive", text: "human first", streamingBehavior: "steer" }, ctx);

  handlers.get("message_end")({ message: { role: "user", content: [{ type: "text", text: "human first" }] } }, ctx);
  handlers.get("before_provider_request")({}, ctx);
  assert.equal(scheduled.length, 1, "persisted human steer must trigger immediately");

  handlers.get("message_end")({ message: { role: "user", content: [{ type: "text", text: "extension later" }] } }, ctx);
  handlers.get("before_provider_request")({}, ctx);
  assert.equal(scheduled.length, 1, "extension follow-up must not inherit human origin");
});

test("TUI notices state input cardinality, clearly estimated trigger tokens, and model identity", async () => {
  const handlers = new Map();
  const notices = [];
  const outputPath = join(await mkdtemp(join(tmpdir(), "hc-key-contract-")), "summary.jsonl");
  registerPiKeyMessageSummary(
    { on: (event, handler) => handlers.set(event, handler) },
    {
      outputPath,
      model: { provider: "test-provider", id: "cheap-model" },
      modelClient: {
        complete: async () => ({
          text: "Progress: done | Findings: evidence | Questions/Requests: None stated | Next step: inspect",
          provider: "test-provider",
          model: "cheap-model",
          usage: { input: 120, output: 34 },
        }),
      },
    },
  );

  handlers.get("session_start")({}, {
    ...contextFor(branchWithMachineMetadata(), outputPath),
    hasUI: true,
    ui: { notify: (text, level) => notices.push({ text, level }) },
  });
  await waitFor(() => notices.length >= 2, "detached synthesis did not report both notices");

  assert.match(notices[0].text, /52\s+Key Messages?/i);
  assert.match(notices[0].text, /estimated/i);
  assert.match(notices[0].text, /input tokens?/i);
  assert.match(notices[0].text, /~\d+/);
  assert.match(notices[0].text, /test-provider\/cheap-model/);
  assert.match(notices[1].text, /input tokens?\s*[:=]?\s*120/i);
  assert.match(notices[1].text, /output tokens?\s*[:=]?\s*34/i);
  assert.match(notices[1].text, /test-provider\/cheap-model/);
});

test("updated notice never substitutes the local estimate for absent provider usage", async () => {
  const handlers = new Map();
  const notices = [];
  const outputPath = join(await mkdtemp(join(tmpdir(), "hc-key-contract-")), "summary.jsonl");
  registerPiKeyMessageSummary(
    { on: (event, handler) => handlers.set(event, handler) },
    {
      outputPath,
      model: { provider: "requested-provider", id: "requested-model" },
      modelClient: {
        complete: async () => ({
          text: "Progress: done | Findings: evidence | Questions/Requests: None stated | Next step: inspect",
          provider: "actual-provider",
          responseModel: "actual-model",
        }),
      },
    },
  );

  handlers.get("session_start")({}, {
    ...contextFor(branchWithMachineMetadata(), outputPath),
    hasUI: true,
    ui: { notify: (text, level) => notices.push({ text, level }) },
  });
  await waitFor(() => notices.length >= 2, "detached synthesis did not report both notices");

  assert.match(notices[1].text, /input tokens?\s*[:=]?\s*unavailable/i);
  assert.match(notices[1].text, /output tokens?\s*[:=]?\s*unavailable/i);
  assert.match(notices[1].text, /actual-provider\/actual-model/);
  assert.doesNotMatch(notices[1].text, /~\d+/);
});
