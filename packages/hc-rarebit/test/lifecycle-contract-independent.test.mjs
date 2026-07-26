import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import registerPiRarebit from "../src/extension.mjs";
import {
  composeRarebitSummaryPrompt,
  selectRarebits,
} from "../src/rarebit-core.mjs";
import { registerRarebitLifecycle } from "../src/lifecycle.mjs";
import { rarebitMaterializationPath } from "../src/rarebit-store.mjs";

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
          {
            type: "toolCall",
            id: `private-tool-${index}`,
            name: "bash",
            arguments: {},
          },
        ],
      },
    });
  }
  return branch;
}

function contextFor(branch, outputPath = "/tmp/unused-rarebit.jsonl") {
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
  const prompt = composeRarebitSummaryPrompt(
    selectRarebits(branchWithMachineMetadata(1)),
    {
      promptVersion: "contract-test",
    },
  );
  const payload = JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2));

  assert.match(prompt, /Keep the semantic owner request/);
  assert.match(prompt, /Semantic continuation 0/);
  assert.deepEqual(Object.keys(payload), ["messages"]);
  assert.deepEqual(
    payload.messages.map((message) => Object.keys(message)),
    [
      ["role", "outcome", "text"],
      ["role", "outcome", "text"],
    ],
  );
  assert.deepEqual(payload.messages, [
    { role: "user", outcome: "user", text: "Keep the semantic owner request." },
    {
      role: "assistant",
      outcome: "continuation",
      text: "Semantic continuation 0",
    },
  ]);
  assert.doesNotMatch(
    prompt,
    /\/private\/session-entry|machine-producer-identity/,
  );
});

test("mixed follow-up and steer delivery preserves source authority despite Pi queue reordering", () => {
  const handlers = new Map();
  const scheduled = [];
  registerRarebitLifecycle(
    { on: (event, handler) => handlers.set(event, handler) },
    (ctx) => scheduled.push(ctx),
  );
  const ctx = contextFor([]);
  handlers.get("session_start")({}, ctx);
  scheduled.length = 0;

  // Pi drains every steer before follow-ups, even when the follow-up was
  // enqueued first. Source attribution cannot use one global FIFO.
  handlers.get("input")(
    {
      source: "extension",
      text: "extension later",
      streamingBehavior: "followUp",
    },
    ctx,
  );
  handlers.get("input")(
    { source: "interactive", text: "human first", streamingBehavior: "steer" },
    ctx,
  );

  handlers.get("message_end")(
    {
      message: {
        role: "user",
        content: [{ type: "text", text: "human first" }],
      },
    },
    ctx,
  );
  handlers.get("before_provider_request")({}, ctx);
  assert.equal(
    scheduled.length,
    1,
    "persisted human steer must trigger immediately",
  );

  handlers.get("message_end")(
    {
      message: {
        role: "user",
        content: [{ type: "text", text: "extension later" }],
      },
    },
    ctx,
  );
  handlers.get("before_provider_request")({}, ctx);
  assert.equal(
    scheduled.length,
    1,
    "extension follow-up must not inherit human origin",
  );
});

test("auto-title callback fires exactly once for the first persisted direct owner message", () => {
  const handlers = new Map();
  const titles = [];
  registerRarebitLifecycle(
    { on: (event, handler) => handlers.set(event, handler) },
    () => {},
    {
      onFirstPersistedOwnerMessage: (ctx, message) =>
        titles.push({ ctx, message }),
    },
  );
  const ctx = contextFor([]);
  handlers.get("session_start")({}, ctx);

  handlers.get("input")(
    { source: "interactive", text: "queued", streamingBehavior: "steer" },
    ctx,
  );
  handlers.get("message_end")(
    { message: { role: "user", content: "queued" } },
    ctx,
  );
  handlers.get("before_provider_request")({}, ctx);
  assert.equal(titles.length, 0, "steer must not generate a title");

  handlers.get("input")({ source: "rpc", text: "first direct request" }, ctx);
  handlers.get("message_end")(
    { message: { role: "user", content: "first direct request" } },
    ctx,
  );
  handlers.get("before_provider_request")({}, ctx);
  assert.equal(titles.length, 1);
  assert.deepEqual(titles[0].message, {
    text: "first direct request",
    source: "rpc",
    sourceEntryId: null,
  });

  handlers.get("input")(
    { source: "interactive", text: "second direct request" },
    ctx,
  );
  handlers.get("message_end")(
    { message: { role: "user", content: "second direct request" } },
    ctx,
  );
  handlers.get("before_provider_request")({}, ctx);
  assert.equal(
    titles.length,
    1,
    "later owner messages must not retitle the Session",
  );
});

test("auto-title callback stays disabled for existing branches and extension input", () => {
  const handlers = new Map();
  const titles = [];
  registerRarebitLifecycle(
    { on: (event, handler) => handlers.set(event, handler) },
    () => {},
    { onFirstPersistedOwnerMessage: (...args) => titles.push(args) },
  );
  const ctx = contextFor(branchWithMachineMetadata(0));
  handlers.get("session_start")({}, ctx);
  handlers.get("input")({ source: "extension", text: "injected" }, ctx);
  handlers.get("message_end")(
    { message: { role: "user", content: "injected" } },
    ctx,
  );
  handlers.get("before_provider_request")({}, ctx);
  assert.equal(titles.length, 0);
});

test("extension auto-title applies once to the exact active Session and writes only Rarebit storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-rarebit-title-"));
  const sessionFile = join(root, "session.jsonl");
  const handlers = new Map();
  const commands = new Map();
  const notices = [];
  let sessionName;
  let titlePrompt;
  let titleCalls = 0;
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
    getSessionName: () => sessionName,
    setSessionName: (value) => {
      sessionName = value;
    },
  };
  registerPiRarebit(pi, {
    model: { provider: "test-provider", id: "cheap-model" },
    titleModelClient: {
      complete: async (request) => {
        titleCalls += 1;
        titlePrompt = request.prompt;
        return {
          text:
            titleCalls === 1
              ? "investigate flaky settlement"
              : "manual generated retitle",
        };
      },
    },
    sessionRoot: root,
    rarebitRoot: join(root, "rarebit"),
  });
  const user = {
    type: "message",
    id: "u1",
    message: { role: "user", content: "Investigate the settlement bug" },
  };
  const injected = {
    type: "message",
    id: "extension-user-role",
    message: { role: "user", content: "Harness-injected user-role content" },
  };
  const ctx = {
    ...contextFor([injected, user], sessionFile),
    hasUI: true,
    ui: { notify: (text, level) => notices.push({ text, level }) },
  };
  handlers.get("session_start")(
    {},
    { ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => [] } },
  );
  handlers.get("input")(
    { source: "interactive", text: "Investigate the settlement bug" },
    ctx,
  );
  handlers.get("message_end")({ message: user.message }, ctx);
  handlers.get("before_provider_request")({}, ctx);
  await waitFor(
    () => /^\d{8}-investigate flaky settlement$/.test(sessionName ?? ""),
    "auto-title did not apply",
  );
  assert.match(titlePrompt, /Investigate the settlement bug/);
  assert.doesNotMatch(titlePrompt, /Harness-injected/);
  assert.deepEqual([...commands.keys()], ["rarebit"]);
  assert.deepEqual(
    commands
      .get("rarebit")
      .getArgumentCompletions("auto-title ")
      .map(({ value }) => value),
    ["auto-title on", "auto-title off"],
  );
  const materialization = rarebitMaterializationPath(sessionFile, {
    sessionRoot: root,
    rarebitRoot: join(root, "rarebit"),
  });
  await waitFor(async () => {
    try {
      return await (
        await import("node:fs/promises")
      ).readFile(materialization, "utf8");
    } catch {
      return false;
    }
  }, "Rarebit title receipt was not persisted");
  assert.doesNotMatch(materialization, /session-summaries/);

  await commands.get("rarebit").handler("config max_rarebit_ratio 0.25", ctx);
  await commands.get("rarebit").handler("config min_total_length 120000", ctx);
  await commands.get("rarebit").handler("config", ctx);
  assert.match(
    notices.at(-1).text,
    /max_rarebit_ratio=0\.25 \(process_override\)/,
  );
  assert.match(notices.at(-1).text, /min_total_length=120000 estimated tokens/);
  await commands.get("rarebit").handler("config max_rarebit_ratio 2", ctx);
  assert.match(notices.at(-1).text, /Invalid Rarebit config value/);
  const beforeLiteral = sessionName;
  await commands.get("rarebit").handler("title literal override", ctx);
  assert.equal(sessionName, beforeLiteral);
  assert.match(notices.at(-1).text, /native \/name/);
  await commands.get("rarebit").handler("title", ctx);
  await waitFor(
    () => /^\d{8}-manual generated retitle$/.test(sessionName ?? ""),
    "manual generated title did not replace the unchanged prior title",
  );
});

test("manual generated title after resume uses the earliest persisted branch user as labelled fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-rarebit-resume-title-"));
  const sessionFile = join(root, "session.jsonl");
  const handlers = new Map();
  const commands = new Map();
  let sessionName = "20260701-old title";
  let prompt;
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
    getSessionName: () => sessionName,
    setSessionName: (value) => {
      sessionName = value;
    },
  };
  registerPiRarebit(pi, {
    model: { provider: "test-provider", id: "cheap-model" },
    titleModelClient: {
      complete: async (request) => {
        prompt = request.prompt;
        return { text: "resumed owner request" };
      },
    },
    sessionRoot: root,
    rarebitRoot: join(root, "rarebit"),
  });
  const branch = [
    {
      type: "message",
      id: "owner-1",
      message: { role: "user", content: "First persisted owner request" },
    },
    {
      type: "message",
      id: "assistant-1",
      message: { role: "assistant", stopReason: "stop", content: "Done" },
    },
  ];
  const ctx = {
    ...contextFor(branch, sessionFile),
    hasUI: true,
    ui: { notify() {} },
  };
  handlers.get("session_start")({}, ctx);
  await commands.get("rarebit").handler("title", ctx);
  await waitFor(
    () => /^\d{8}-resumed owner request$/.test(sessionName),
    "resume retitle did not apply",
  );
  assert.match(prompt, /First persisted owner request/);
  const path = rarebitMaterializationPath(sessionFile, {
    sessionRoot: root,
    rarebitRoot: join(root, "rarebit"),
  });
  await waitFor(async () => {
    try {
      return (
        await (await import("node:fs/promises")).readFile(path, "utf8")
      ).includes('"type":"rarebit_title"');
    } catch {
      return false;
    }
  }, "manual title receipt was not persisted");
  const records = (
    await (await import("node:fs/promises")).readFile(path, "utf8")
  )
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(
    records.find((record) => record.type === "rarebit_title")?.titleEvidence
      ?.provenance,
    "branch_user_fallback",
  );
});

test("TUI notices state input cardinality, clearly estimated trigger tokens, and model identity", async () => {
  const handlers = new Map();
  const notices = [];
  const root = await mkdtemp(join(tmpdir(), "hc-key-contract-"));
  const outputPath = join(root, "summary.jsonl");
  registerPiRarebit(
    { on: (event, handler) => handlers.set(event, handler) },
    {
      outputPath,
      sessionRoot: root,
      rarebitRoot: join(root, "rarebit"),
      summaryPolicy: { minTotalLength: 0, maxRarebitRatio: 1 },
      model: { provider: "test-provider", id: "cheap-model" },
      modelClient: {
        complete: async () => ({
          text: JSON.stringify({
            summary:
              "Progress: done | Findings: evidence | Questions/Requests: None stated | Next step: inspect",
            sessionStatus: "finished",
            statusReason: "all_requests_accomplished",
          }),
          provider: "test-provider",
          model: "cheap-model",
          usage: { input: 120, output: 34 },
        }),
      },
    },
  );

  handlers.get("session_start")(
    {},
    {
      ...contextFor(branchWithMachineMetadata(), outputPath),
      hasUI: true,
      ui: { notify: (text, level) => notices.push({ text, level }) },
    },
  );
  await waitFor(
    () => notices.length >= 2,
    "detached synthesis did not report both notices",
  );

  assert.match(notices[0].text, /52\s+Rarebits?/i);
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
  const root = await mkdtemp(join(tmpdir(), "hc-key-contract-"));
  const outputPath = join(root, "summary.jsonl");
  registerPiRarebit(
    { on: (event, handler) => handlers.set(event, handler) },
    {
      outputPath,
      sessionRoot: root,
      rarebitRoot: join(root, "rarebit"),
      summaryPolicy: { minTotalLength: 0, maxRarebitRatio: 1 },
      model: { provider: "requested-provider", id: "requested-model" },
      modelClient: {
        complete: async () => ({
          text: JSON.stringify({
            summary:
              "Progress: done | Findings: evidence | Questions/Requests: None stated | Next step: inspect",
            sessionStatus: "finished",
            statusReason: "all_requests_accomplished",
          }),
          provider: "actual-provider",
          responseModel: "actual-model",
        }),
      },
    },
  );

  handlers.get("session_start")(
    {},
    {
      ...contextFor(branchWithMachineMetadata(), outputPath),
      hasUI: true,
      ui: { notify: (text, level) => notices.push({ text, level }) },
    },
  );
  await waitFor(
    () => notices.length >= 2,
    "detached synthesis did not report both notices",
  );

  assert.match(notices[1].text, /input tokens?\s*[:=]?\s*unavailable/i);
  assert.match(notices[1].text, /output tokens?\s*[:=]?\s*unavailable/i);
  assert.match(notices[1].text, /actual-provider\/actual-model/);
  assert.doesNotMatch(notices[1].text, /~\d+/);
});
