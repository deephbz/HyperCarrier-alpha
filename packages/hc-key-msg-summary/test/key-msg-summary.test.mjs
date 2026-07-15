import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  DEFAULT_PROMPT_VERSION,
  IMPLEMENTATION_VERSION,
  buildPrompt,
  createPiModelClient,
  defaultOutputPath,
  extractSynthesisReceipt,
  keyMessageMetadata,
  processKeyMessageSummary,
  registerKeyMessageSummary,
  selectKeyMessages,
} from "../src/index.mjs";
import registerPiKeyMessageSummary, {
  readConfiguredKeyMessageSummarySettings,
} from "../src/extension.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/branch-mixed.json", import.meta.url), "utf8"));
const TEST_MODEL = { provider: "test", id: "cheap" };
const ctxFor = (branch, id = "session-alpha", sessionFile) => ({
  sessionManager: {
    getHeader: () => ({ id }),
    getBranch: () => branch,
    ...(sessionFile ? { getSessionFile: () => sessionFile } : {}),
  },
});
const tempPath = async () => join(await mkdtemp(join(tmpdir(), "hc-key-msg-")), "private", "records.jsonl");

function denseBranch(toolCallCount) {
  return [
    {
      type: "message", id: "user-intent", timestamp: 1,
      message: { role: "user", content: [{ type: "text", text: "Keep the original owner goal." }] },
    },
    ...Array.from({ length: toolCallCount }, (_, index) => ({
      type: "message", id: `turn-${index}`, timestamp: index + 2,
      message: {
        role: "assistant", stopReason: "toolUse",
        content: [
          { type: "text", text: `Continuation report ${index}.` },
          { type: "toolCall", id: `tool-${index}`, name: "read", arguments: {} },
        ],
      },
    })),
    {
      type: "message", id: "final", timestamp: toolCallCount + 2,
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Final finding." }] },
    },
  ];
}

test("selects every user/stop/continuation prose occurrence, not tool payloads", () => {
  const selection = selectKeyMessages(fixture);
  assert.deepEqual(selection.occurrences.map((entry) => entry.sourceEntryId), [
    "u-1", "a-tool", "a-1", "a-2", "a-3", "a-3-duplicate-hook-view",
  ]);
  assert.equal(selection.occurrences[1].outcome, "continuation");
  assert.equal(selection.occurrences[1].text, "not final");
  assert.equal(selection.occurrences.some((entry) => entry.text.includes("result must not")), false);
  assert.equal(selection.occurrences.some((entry) => entry.text.includes("hidden")), false);
  assert.equal(selection.payloads.filter((payload) => payload.text === "Findings three").length, 1);
  assert.equal(selection.payloads.find((payload) => payload.text === "Findings three").occurrenceIds.length, 2);
  assert.equal(selection.toolCallCount, 1);
  assert.equal(selection.continuationCount, 1);
  assert.equal(selection.manifest.occurrences.length, 6);
  assert.equal(selection.manifest.payloads.some((payload) => "text" in payload), false);
});

test("exports a metadata-safe classifier with exactly the selection predicate", () => {
  const selection = selectKeyMessages(fixture);
  const metadata = fixture
    .map((entry, order) => keyMessageMetadata(entry, order))
    .filter(Boolean);
  assert.deepEqual(
    metadata,
    selection.occurrences.map(({ occurrenceId: _occurrenceId, contentHash: _contentHash, text: _text, ...item }) => item),
  );
  assert.equal(JSON.stringify(metadata).includes("Findings three"), false);
  assert.equal(JSON.stringify(metadata).includes("result must not"), false);
});

test("continuations and tool calls are branch-scoped and count even when continuation prose is empty", () => {
  const branch = denseBranch(50);
  branch[1].message.content = [{ type: "toolCall", id: "only-tool", name: "read", arguments: {} }];
  const selection = selectKeyMessages(branch);
  assert.equal(selection.toolCallCount, 50);
  assert.equal(selection.continuationCount, 50);
  assert.equal(selection.occurrences.some((entry) => entry.sourceEntryId === "turn-0"), false);
});

test("below the strict activation threshold persists inspectable selection without a model call", async () => {
  const outputPath = await tempPath();
  let calls = 0;
  const result = await processKeyMessageSummary(ctxFor(denseBranch(50)), {
    projectId: "alpha", outputPath,
    modelClient: { complete: async () => { calls += 1; return { text: "must not run" }; } },
  });
  assert.equal(result.record.status, "selection_only");
  assert.equal(result.record.activation.shouldSynthesize, false);
  assert.equal(calls, 0);
  const raw = await readFile(outputPath, "utf8");
  assert.equal(raw.includes("Continuation report 0."), false);
  assert.equal(JSON.parse(raw).selection.occurrences.length, 52);
  const repeated = await processKeyMessageSummary(ctxFor(denseBranch(50)), { projectId: "alpha", outputPath });
  assert.equal(repeated.duplicate, true);
});

test("above threshold sends the complete branch projection once, including early user and toolUse prose", async () => {
  const outputPath = await tempPath();
  let request;
  const result = await processKeyMessageSummary(ctxFor(denseBranch(51)), {
    projectId: "alpha", outputPath, model: TEST_MODEL,
    modelClient: { complete: async (value) => { request = value; return { text: "Progress: complete branch | Findings: final finding | Questions/Requests: None stated | Next step: owner review" }; } },
  });
  assert.equal(result.record.status, "ok");
  assert.equal(request.selection.occurrences.length, 53);
  assert.match(request.prompt, /Keep the original owner goal/);
  assert.match(request.prompt, /Continuation report 50/);
  assert.match(request.prompt, /Final finding/);
  assert.equal(result.record.selection.occurrences.length, 53);
  assert.equal(result.record.selection.payloads.some((payload) => "text" in payload), false);
  assert.equal(result.record.model.provider, "test");
});

test("records a machine-only Pi compat synthesis receipt without raw prompt or response text", async () => {
  const outputPath = await tempPath();
  const result = await processKeyMessageSummary(ctxFor(denseBranch(51)), {
    outputPath,
    model: TEST_MODEL,
    modelClient: {
      complete: async () => ({
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        responseModel: "gpt-5.6-sol-2026-07-15",
        responseId: "resp-private-123",
        requestId: "req-private-456",
        usage: {
          input: 120,
          output: 34,
          cacheRead: 56,
          cacheWrite: 7,
          reasoning: 11,
          totalTokens: 217,
          cost: { total: 0.00123 },
        },
        content: [{
          type: "text",
          text: "Progress: received | Findings: complete | Questions/Requests: None stated | Next step: inspect",
        }],
      }),
    },
  });
  const receipt = result.record.synthesis;
  assert.deepEqual(receipt.requestedModel, TEST_MODEL);
  assert.equal(receipt.outcome, "response");
  assert.equal(receipt.timing.provenance, "local_monotonic_clock");
  assert.equal(typeof receipt.timing.durationMs, "number");
  assert.equal(receipt.provider.responseProvider, "openai-codex");
  assert.equal(receipt.provider.responseModel, "gpt-5.6-sol-2026-07-15");
  assert.equal(receipt.provider.responseId, "resp-private-123");
  assert.equal(receipt.provider.requestId, "req-private-456");
  assert.equal(receipt.usage.availability, "reported");
  assert.equal(receipt.usage.inputTokens, 120);
  assert.equal(receipt.usage.outputTokens, 34);
  assert.equal(receipt.usage.totalTokens, 217);
  assert.equal(receipt.usage.cacheReadTokens, 56);
  assert.equal(receipt.usage.cacheWriteTokens, 7);
  assert.equal(receipt.usage.reasoningTokens, 11);
  assert.equal(receipt.usage.estimatedCostUsd, 0.00123);
  assert.equal(receipt.usage.provenance.inputTokens, "response.usage.input");
  assert.equal(JSON.stringify(receipt).includes("Keep the original owner goal."), false);
  assert.equal(JSON.stringify(receipt).includes("Progress: received"), false);
});

test("labels common partial usage shapes and absent usage honestly instead of deriving totals", () => {
  const partial = extractSynthesisReceipt({
    usage: { prompt_tokens: 100, completion_tokens: 20 },
    id: "provider-response-id",
  }, { requestedModel: TEST_MODEL, durationMs: 4 });
  assert.equal(partial.usage.availability, "partial");
  assert.equal(partial.usage.inputTokens, 100);
  assert.equal(partial.usage.outputTokens, 20);
  assert.equal(partial.usage.totalTokens, null);
  assert.equal(partial.usage.provenance.inputTokens, "response.usage.prompt_tokens");
  assert.equal(partial.provider.responseId, "provider-response-id");

  const unavailable = extractSynthesisReceipt({
    text: "unrecorded prose",
    usage: { input: "not-a-number", output: -1 },
  }, { requestedModel: TEST_MODEL, durationMs: 4 });
  assert.equal(unavailable.usage.availability, "unavailable");
  assert.equal(unavailable.usage.inputTokens, null);
  assert.equal(unavailable.usage.outputTokens, null);
  assert.equal(unavailable.usage.totalTokens, null);
  assert.equal(unavailable.provider.responseId, null);
});

test("Pi compat adapter preserves the AssistantMessage receipt rather than reducing it to text", async () => {
  const compatResponse = {
    provider: "openai-codex",
    model: "cheap",
    responseId: "resp-compat",
    usage: { input: 8, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 11 },
    content: [{ type: "text", text: "Progress: adapter" }],
  };
  const context = {
    modelRegistry: {
      find: (provider, id) => ({ provider, id, api: "openai-responses" }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {}, env: {} }),
    },
  };
  const client = await createPiModelClient(context, {
    model: TEST_MODEL,
    piAi: { complete: async () => compatResponse },
  });
  const received = await client.complete({ prompt: "not persisted", selection: {}, model: TEST_MODEL, promptVersion: "test" });
  assert.equal(received, compatResponse);
  assert.equal(extractSynthesisReceipt(received, { requestedModel: TEST_MODEL }).usage.totalTokens, 11);
});

test("overflow is explicit and never calls a provider or shortens to a tail", async () => {
  const outputPath = await tempPath();
  let calls = 0;
  const result = await processKeyMessageSummary(ctxFor(denseBranch(51)), {
    projectId: "alpha", outputPath, model: TEST_MODEL, maxPromptChars: 10,
    modelClient: { complete: async () => { calls += 1; return { text: "must not run" }; } },
  });
  assert.equal(result.record.status, "unavailable_overflow");
  assert.equal(result.record.overflow.strategy, "none");
  assert.equal(calls, 0);
  assert.equal(result.record.selection.occurrences.length, 53);
});

test("missing model fails closed only after activation, and an ephemeral session never writes", async () => {
  const outputPath = await tempPath();
  const activated = await processKeyMessageSummary(ctxFor(denseBranch(51)), { projectId: "alpha", outputPath });
  assert.equal(activated.record.status, "failure");
  assert.equal(activated.record.error.name, "ModelConfigurationError");
  const skippedPath = await tempPath();
  const skipped = await processKeyMessageSummary(ctxFor(denseBranch(51)), { model: TEST_MODEL });
  assert.equal(skipped.reason, "ephemeral_session");
  await assert.rejects(() => stat(skippedPath), /ENOENT/);
});

test("mirrors Pi session storage without requiring Project identity", async () => {
  const sessionFile = join(
    homedir(), ".pi", "agent", "sessions", "--Users-example-workspace--", "session-alpha.jsonl",
  );
  assert.equal(
    defaultOutputPath(sessionFile),
    join(homedir(), ".pi", "agent", "session-summaries", "--Users-example-workspace--", "session-alpha.jsonl"),
  );
  const outputPath = await tempPath();
  const result = await processKeyMessageSummary(ctxFor(denseBranch(1), "session-alpha", sessionFile), {
    outputPath,
    model: TEST_MODEL,
  });
  assert.equal(result.record.status, "selection_only");
  assert.equal(result.record.projectId, null);
  assert.equal(result.record.sessionFile, sessionFile);
});

test("inherits Pi default provider/model settings with trusted Project override", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-key-settings-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  await mkdir(join(projectDir, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "global",
    defaultModel: "cheap",
    hcKeyMsgSummary: { model: { provider: "ignored", id: "legacy" } },
  }));
  await writeFile(join(projectDir, ".pi", "settings.json"), JSON.stringify({
    defaultProvider: "project",
    defaultModel: "cheaper",
  }));
  const global = await readConfiguredKeyMessageSummarySettings({ agentDir, cwd: projectDir, projectTrusted: false });
  assert.deepEqual(global.model, { provider: "global", id: "cheap" });
  const trusted = await readConfiguredKeyMessageSummarySettings({ agentDir, cwd: projectDir, projectTrusted: true });
  assert.deepEqual(trusted.model, { provider: "project", id: "cheaper" });
  assert.equal(trusted.modelProvenance.settingsKey, "defaultProvider + defaultModel");
});

test("accepts a provider/model defaultModel when Pi has no separate defaultProvider", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-key-settings-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultModel: "openrouter/z-ai/glm-5.2",
  }));
  const resolved = await readConfiguredKeyMessageSummarySettings({ agentDir });
  assert.deepEqual(resolved.model, { provider: "openrouter", id: "z-ai/glm-5.2" });
});

test("registers documented session_start and agent_end hooks, not an invented settled hook", () => {
  const coreEvents = [];
  registerKeyMessageSummary({ on: (event) => coreEvents.push(event) });
  assert.deepEqual(coreEvents, ["session_start", "agent_end"]);

  const extensionEvents = [];
  registerPiKeyMessageSummary({ on: (event) => extensionEvents.push(event) });
  assert.deepEqual(extensionEvents, ["session_start", "agent_end"]);
});

test("interactive Pi gets human-only trigger and outcome notifications for synthesis", async () => {
  const handlers = new Map();
  const notices = [];
  const outputPath = await tempPath();
  registerPiKeyMessageSummary(
    { on: (event, handler) => handlers.set(event, handler) },
    {
      outputPath,
      model: TEST_MODEL,
      modelClient: {
        complete: async () => ({
          text: "Progress: projected | Findings: none | Questions/Requests: None stated | Next step: inspect",
        }),
      },
    },
  );
  await handlers.get("session_start")({}, {
    ...ctxFor(denseBranch(51)),
    hasUI: true,
    ui: { notify: (text, level) => notices.push({ text, level }) },
  });
  assert.deepEqual(notices, [
    { text: "Key Message Summary triggered (51 tool calls, 51 continuations)", level: "info" },
    { text: "Key Message Summary updated", level: "info" },
  ]);
  assert.equal((await readFile(outputPath, "utf8")).includes("Key Message Summary triggered"), false);
});

test("interactive Pi reports a generic failure without exposing provider errors", async () => {
  const handlers = new Map();
  const notices = [];
  registerPiKeyMessageSummary(
    { on: (event, handler) => handlers.set(event, handler) },
    {
      outputPath: await tempPath(),
      model: TEST_MODEL,
      modelClient: { complete: async () => { throw new Error("provider secret detail"); } },
    },
  );
  await handlers.get("agent_end")({}, {
    ...ctxFor(denseBranch(51)),
    hasUI: true,
    ui: { notify: (text, level) => notices.push({ text, level }) },
  });
  assert.deepEqual(notices, [
    { text: "Key Message Summary triggered (51 tool calls, 51 continuations)", level: "info" },
    { text: "Key Message Summary failed; inspect its private sidecar", level: "error" },
  ]);
  assert.equal(notices.some(({ text }) => text.includes("provider secret detail")), false);
});

test("default path and versions identify the new projection", () => {
  assert.match(
    defaultOutputPath(join(homedir(), ".pi", "agent", "sessions", "project", "session.jsonl")),
    /\.pi[\\/]agent[\\/]session-summaries[\\/]project[\\/]session\.jsonl$/,
  );
  assert.equal(DEFAULT_PROMPT_VERSION, "key-msg-summary-v1");
  assert.equal(IMPLEMENTATION_VERSION, "hc-key-msg-summary-v1");
  assert.match(buildPrompt(selectKeyMessages(denseBranch(1)), DEFAULT_PROMPT_VERSION), /complete selected Key Message projection/);
});
