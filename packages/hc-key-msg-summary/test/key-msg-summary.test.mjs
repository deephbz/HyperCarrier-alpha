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
import { createDetachedMaterializer } from "../src/lifecycle.mjs";

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

async function waitFor(predicate, message = "condition was not reached") {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

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
  assert.deepEqual(Object.keys(request).sort(), ["model", "prompt"]);
  assert.match(request.prompt, /Keep the original owner goal/);
  assert.match(request.prompt, /Continuation report 50/);
  assert.match(request.prompt, /Final finding/);
  for (const machineField of [
    "contentHash",
    "occurrenceId",
    "sourceEntryId",
    "selectorVersion",
    "dedupeVersion",
  ]) assert.doesNotMatch(request.prompt, new RegExp(machineField));
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

test("registers the human-input persistence and terminal-settlement hooks", () => {
  const coreEvents = [];
  registerKeyMessageSummary({ on: (event) => coreEvents.push(event) });
  assert.deepEqual(coreEvents, [
    "session_start",
    "agent_start",
    "input",
    "message_end",
    "before_provider_request",
    "agent_end",
    "agent_settled",
    "session_shutdown",
  ]);

  const extensionEvents = [];
  registerPiKeyMessageSummary({ on: (event) => extensionEvents.push(event) });
  assert.deepEqual(extensionEvents, coreEvents);
});

test("session bootstrap is detached so Pi can accept input while synthesis runs", async () => {
  const handlers = new Map();
  const notices = [];
  const outputPath = await tempPath();
  let finishModel;
  registerPiKeyMessageSummary(
    { on: (event, handler) => handlers.set(event, handler) },
    {
      outputPath,
      model: TEST_MODEL,
      modelClient: {
        complete: () => new Promise((resolve) => { finishModel = resolve; }),
      },
    },
  );
  const returned = handlers.get("session_start")({}, {
    ...ctxFor(denseBranch(51)),
    hasUI: true,
    ui: { notify: (text, level) => notices.push({ text, level }) },
  });
  assert.equal(returned, undefined);
  assert.deepEqual(notices, []);
  await waitFor(() => typeof finishModel === "function", "background synthesis did not start");
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /53 Key Messages/);
  assert.match(notices[0].text, /input tokens: ~\d+ estimated \(chars\/4\)/);
  assert.match(notices[0].text, /model test\/cheap/);
  finishModel({
    text: "Progress: projected | Findings: none | Questions/Requests: None stated | Next step: inspect",
    provider: "test",
    model: "cheap-reported",
    usage: { input: 120, output: 34 },
  });
  await waitFor(() => notices.length === 2, "background outcome was not reported");
  assert.match(notices[1].text, /input tokens: 120/);
  assert.match(notices[1].text, /output tokens: 34/);
  assert.match(notices[1].text, /model test\/cheap-reported/);
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
  handlers.get("session_start")({}, {
    ...ctxFor(denseBranch(51)),
    hasUI: true,
    ui: { notify: (text, level) => notices.push({ text, level }) },
  });
  await waitFor(() => notices.length === 2, "background failure was not reported");
  assert.match(notices[0].text, /53 Key Messages/);
  assert.match(notices[0].text, /input tokens: ~\d+ estimated/);
  assert.match(notices[0].text, /model test\/cheap/);
  assert.deepEqual(notices[1], {
    text: "Key Message Summary failed; inspect its private sidecar",
    level: "error",
  });
  assert.equal(notices.some(({ text }) => text.includes("provider secret detail")), false);
});

test("human input triggers only after its persisted user message reaches the provider boundary", async () => {
  const handlers = new Map();
  const outputPath = await tempPath();
  const branch = denseBranch(51);
  let request;
  registerPiKeyMessageSummary(
    { on: (event, handler) => handlers.set(event, handler) },
    {
      outputPath,
      model: TEST_MODEL,
      modelClient: {
        complete: async (value) => {
          request = value;
          return { text: "Progress: current | Findings: persisted | Questions/Requests: None stated | Next step: continue" };
        },
      },
    },
  );
  const ctx = ctxFor(branch);
  handlers.get("input")({ type: "input", source: "interactive", text: "New owner steer" }, ctx);
  assert.equal(request, undefined);
  handlers.get("message_end")({
    type: "message_end",
    message: { role: "user", content: [{ type: "text", text: "New owner steer" }] },
  }, ctx);
  branch.push({
    type: "message",
    id: "new-owner-steer",
    timestamp: 999,
    message: { role: "user", content: [{ type: "text", text: "New owner steer" }] },
  });
  assert.equal(request, undefined);
  handlers.get("before_provider_request")({ type: "before_provider_request" }, ctx);
  branch.push({
    type: "message",
    id: "too-late-for-captured-branch",
    timestamp: 1000,
    message: { role: "user", content: [{ type: "text", text: "Must not leak into captured branch" }] },
  });
  await waitFor(() => request !== undefined, "human input did not schedule synthesis");
  assert.match(request.prompt, /New owner steer/);
  assert.doesNotMatch(request.prompt, /Must not leak into captured branch/);
});

test("extension input and interruption settlement do not trigger materialization", async () => {
  const handlers = new Map();
  let calls = 0;
  registerPiKeyMessageSummary(
    { on: (event, handler) => handlers.set(event, handler) },
    {
      outputPath: await tempPath(),
      model: TEST_MODEL,
      modelClient: { complete: async () => { calls += 1; return { text: "must not run" }; } },
    },
  );
  const ctx = ctxFor(denseBranch(51));
  handlers.get("input")({ type: "input", source: "extension", text: "injected" }, ctx);
  handlers.get("message_end")({ type: "message_end", message: { role: "user", content: [] } }, ctx);
  handlers.get("before_provider_request")({ type: "before_provider_request" }, ctx);
  handlers.get("input")({ type: "input", source: "interactive", text: "queued before ESC" }, ctx);
  handlers.get("agent_end")({
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "aborted", content: [] }],
  }, ctx);
  handlers.get("message_end")({ type: "message_end", message: { role: "user", content: [] } }, ctx);
  handlers.get("before_provider_request")({ type: "before_provider_request" }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 0);
});

test("normal agent settlement materializes the full branch after a tool-call loop", async () => {
  const handlers = new Map();
  const branch = denseBranch(51);
  let calls = 0;
  let request;
  registerPiKeyMessageSummary(
    { on: (event, handler) => handlers.set(event, handler) },
    {
      outputPath: await tempPath(),
      model: TEST_MODEL,
      modelClient: {
        complete: async (value) => {
          calls += 1;
          request = value;
          return { text: "Progress: settled | Findings: complete | Questions/Requests: None stated | Next step: inspect" };
        },
      },
    },
  );
  const ctx = ctxFor(branch);
  branch.push({
    type: "message",
    id: "continuation-before-stop",
    timestamp: 1200,
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "text", text: "Running the final tool batch." }],
    },
  });
  branch.push({
    type: "message",
    id: "terminal-agent-stop",
    timestamp: 1201,
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "Final settled report." }],
    },
  });

  const returned = handlers.get("agent_end")({
    type: "agent_end",
    messages: [
      { role: "assistant", stopReason: "toolUse", content: [] },
      { role: "toolResult", content: [] },
      { role: "assistant", stopReason: "stop", content: [] },
    ],
  }, ctx);
  assert.equal(returned, undefined);
  assert.equal(calls, 0, "agent_end must wait for Pi's fully-settled boundary");
  handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
  await waitFor(() => calls === 1, "normal agent settlement did not schedule synthesis");
  assert.match(request.prompt, /Running the final tool batch/);
  assert.match(request.prompt, /Final settled report/);
});

test("agent_end without a terminal assistant stop does not materialize", async () => {
  const handlers = new Map();
  let calls = 0;
  registerPiKeyMessageSummary(
    { on: (event, handler) => handlers.set(event, handler) },
    {
      outputPath: await tempPath(),
      model: TEST_MODEL,
      modelClient: { complete: async () => { calls += 1; return { text: "must not run" }; } },
    },
  );
  const ctx = ctxFor(denseBranch(51));
  handlers.get("agent_end")({
    type: "agent_end",
    messages: [
      { role: "assistant", stopReason: "toolUse", content: [] },
      { role: "toolResult", content: [] },
    ],
  }, ctx);
  handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 0);
});

test("multiple queued inputs preserve origins, coalesce human triggers, and include RPC", async () => {
  const handlers = new Map();
  const branch = denseBranch(51);
  let calls = 0;
  let request;
  registerPiKeyMessageSummary(
    { on: (event, handler) => handlers.set(event, handler) },
    {
      outputPath: await tempPath(),
      model: TEST_MODEL,
      modelClient: {
        complete: async (value) => {
          calls += 1;
          request = value;
          return { text: "Progress: queued | Findings: origins preserved | Questions/Requests: None stated | Next step: continue" };
        },
      },
    },
  );
  const ctx = ctxFor(branch);
  for (const [source, text] of [
    ["interactive", "human steer one"],
    ["extension", "extension injection"],
    ["rpc", "human rpc two"],
  ]) {
    handlers.get("input")({ type: "input", source, text }, ctx);
  }
  for (const [index, text] of ["human steer one", "extension injection", "human rpc two"].entries()) {
    branch.push({
      type: "message",
      id: `queued-${index}`,
      timestamp: 1100 + index,
      message: { role: "user", content: [{ type: "text", text }] },
    });
    handlers.get("message_end")({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text }] },
    }, ctx);
  }
  handlers.get("before_provider_request")({ type: "before_provider_request" }, ctx);
  handlers.get("before_provider_request")({ type: "before_provider_request" }, ctx);
  await waitFor(() => calls === 1, "queued human inputs did not coalesce");
  assert.match(request.prompt, /human steer one/);
  assert.match(request.prompt, /human rpc two/);
  assert.equal(calls, 1);
});

test("session shutdown suppresses stale TUI outcomes without cancelling the durable run", async () => {
  const handlers = new Map();
  const notices = [];
  let finishModel;
  const outputPath = await tempPath();
  registerPiKeyMessageSummary(
    { on: (event, handler) => handlers.set(event, handler) },
    {
      outputPath,
      model: TEST_MODEL,
      modelClient: { complete: () => new Promise((resolve) => { finishModel = resolve; }) },
    },
  );
  const ctx = {
    ...ctxFor(denseBranch(51)),
    hasUI: true,
    ui: { notify: (text, level) => notices.push({ text, level }) },
  };
  handlers.get("session_start")({}, ctx);
  await waitFor(() => typeof finishModel === "function");
  assert.equal(notices.length, 1);
  handlers.get("session_shutdown")({}, ctx);
  finishModel({
    text: "Progress: done | Findings: durable | Questions/Requests: None stated | Next step: inspect",
  });
  await waitFor(async () => {
    try { return (await readFile(outputPath, "utf8")).length > 0; } catch { return false; }
  }, "durable materialization did not finish after shutdown");
  assert.equal(notices.length, 1);
});

test("detached scheduler serializes runs and coalesces pending triggers to the latest context", async () => {
  const started = [];
  const finishes = [];
  const schedule = createDetachedMaterializer(async (ctx) => {
    started.push(ctx.id);
    await new Promise((resolve) => finishes.push(resolve));
  });
  schedule({ id: "first" });
  await waitFor(() => started.length === 1);
  schedule({ id: "obsolete" });
  schedule({ id: "latest" });
  assert.deepEqual(started, ["first"]);
  finishes.shift()();
  await waitFor(() => started.length === 2);
  assert.deepEqual(started, ["first", "latest"]);
  finishes.shift()();
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
