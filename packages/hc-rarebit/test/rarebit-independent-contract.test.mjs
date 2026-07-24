import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_RAREBIT_SUMMARY_POLICY,
  evaluateRarebitSummaryEligibility,
  measureRarebits,
  selectRarebits,
} from "../src/rarebit-core.mjs";
import { registerRarebitLifecycle } from "../src/lifecycle.mjs";
import {
  processRarebitSummary,
  processRarebitTitle,
} from "../src/rarebit-service.mjs";

const entry = (id, message, parentId = null) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-07-16T00:00:00.000Z",
  message,
});

test("default eligibility is exact at ceil(chars/4)=80k and ratio=0.4", () => {
  const atBoundary = [
    entry("u", { role: "user", content: "u".repeat(127_999) }),
    entry("tool", { role: "toolResult", content: "t".repeat(192_001) }),
  ];
  const selected = selectRarebits(atBoundary);
  const measurement = measureRarebits(atBoundary, selected);
  assert.equal(measurement.estimatedTotalTokens, 80_000);
  assert.equal(measurement.rarebitRatio, 0.399996875);
  assert.equal(
    evaluateRarebitSummaryEligibility(
      measurement,
      DEFAULT_RAREBIT_SUMMARY_POLICY,
    ).eligible,
    true,
  );

  const belowLength = [
    entry("u", { role: "user", content: "u".repeat(127_999) }),
    entry("tool", { role: "toolResult", content: "t".repeat(191_997) }),
  ];
  const below = measureRarebits(belowLength);
  assert.equal(below.estimatedTotalTokens, 79_999);
  assert.deepEqual(
    evaluateRarebitSummaryEligibility(below, DEFAULT_RAREBIT_SUMMARY_POLICY)
      .reasons,
    ["total_length_below_minimum", "rarebit_ratio_above_maximum"],
  );
});

test("automatic ineligible does not suppress forced synthesis, whose duplicate returns its settled receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "rarebit-dedupe-"));
  const sessionRoot = join(root, "sessions");
  await mkdir(sessionRoot);
  const sessionFile = join(sessionRoot, "session.jsonl");
  await writeFile(sessionFile, "{}\n");
  const branch = [entry("u", { role: "user", content: "owner" })];
  const ctx = {
    sessionManager: {
      getHeader: () => ({ id: "dedupe" }),
      getSessionFile: () => sessionFile,
      getBranch: () => branch,
    },
  };
  let calls = 0;
  const config = {
    sessionRoot,
    rarebitRoot: join(root, "rarebit"),
    model: { provider: "test", id: "fake" },
    modelClient: {
      complete: async () => {
        calls += 1;
        return {
          text: JSON.stringify({
            summary:
              "Progress: one | Findings: two | Questions/Requests: None stated | Next step: three",
            summaryNeedsHumanAttention: false,
          }),
        };
      },
    },
  };
  const automatic = await processRarebitSummary(ctx, config);
  const forced = await processRarebitSummary(ctx, {
    ...config,
    forceSynthesis: true,
  });
  const repeatedForced = await processRarebitSummary(ctx, {
    ...config,
    forceSynthesis: true,
  });
  assert.equal(automatic.record.status, "ineligible");
  assert.equal(automatic.record.synthesisMode, "automatic");
  assert.equal(forced.record.status, "ok");
  assert.equal(forced.record.synthesisMode, "forced");
  assert.notEqual(automatic.record.jobId, forced.record.jobId);
  assert.equal(repeatedForced.duplicate, true);
  assert.equal(repeatedForced.record.status, "ok");
  assert.equal(repeatedForced.record.summary, forced.record.summary);
  assert.equal(calls, 1);
});

test("overflow receipt does not suppress a retry with a larger complete-input limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "rarebit-overflow-"));
  const sessionRoot = join(root, "sessions");
  await mkdir(sessionRoot);
  const sessionFile = join(sessionRoot, "session.jsonl");
  await writeFile(sessionFile, "{}\n");
  const branch = [entry("u", { role: "user", content: "owner evidence" })];
  const ctx = {
    sessionManager: {
      getHeader: () => ({ id: "overflow" }),
      getSessionFile: () => sessionFile,
      getBranch: () => branch,
    },
  };
  let calls = 0;
  const common = {
    sessionRoot,
    rarebitRoot: join(root, "rarebit"),
    forceSynthesis: true,
    model: { provider: "test", id: "fake" },
    modelClient: {
      complete: async () => {
        calls += 1;
        return {
          text: JSON.stringify({
            summary:
              "Progress: retried | Findings: complete | Questions/Requests: None stated | Next step: inspect",
            summaryNeedsHumanAttention: false,
          }),
        };
      },
    },
  };
  const overflow = await processRarebitSummary(ctx, {
    ...common,
    maxPromptChars: 1,
  });
  const enlarged = await processRarebitSummary(ctx, {
    ...common,
    maxPromptChars: 20_000,
  });
  const repeated = await processRarebitSummary(ctx, {
    ...common,
    maxPromptChars: 20_000,
  });
  assert.equal(overflow.record.status, "unavailable_overflow");
  assert.equal(enlarged.record.status, "ok");
  assert.notEqual(overflow.record.jobId, enlarged.record.jobId);
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.record.status, "ok");
  assert.equal(calls, 1);
});

test("shared title service produces the same prompt and durable proposal/apply receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "rarebit-title-service-"));
  const sessionRoot = join(root, "sessions");
  await mkdir(sessionRoot);
  const sessionFile = join(sessionRoot, "session.jsonl");
  await writeFile(sessionFile, "{}\n");
  const branch = [
    entry("u", { role: "user", content: "Investigate queue latency" }),
  ];
  const ctx = {
    sessionManager: {
      getHeader: () => ({ id: "title-service" }),
      getSessionFile: () => sessionFile,
      getBranch: () => branch,
    },
  };
  const prompts = [];
  const common = {
    sessionRoot,
    rarebitRoot: join(root, "rarebit"),
    sourceEntryId: "u",
    titleDate: "2026-07-16",
    model: { provider: "test", id: "fake" },
    modelClient: {
      complete: async ({ prompt }) => {
        prompts.push(prompt);
        return { text: "Queue latency investigation" };
      },
    },
  };
  const proposal = await processRarebitTitle(ctx, common);
  let applied;
  const application = await processRarebitTitle(ctx, {
    ...common,
    applyTitle: ({ title }) => {
      applied = title;
      return { status: "applied" };
    },
  });
  assert.equal(proposal.record.status, "proposal");
  assert.equal(application.record.status, "applied");
  assert.equal(applied, "20260716-Queue latency investigation");
  assert.equal(prompts[0], prompts[1]);
  assert.equal(
    JSON.stringify(proposal.record).includes("Investigate queue latency"),
    false,
  );
});

test("lifecycle snapshots persisted user and settled full branches but not ESC", () => {
  const handlers = new Map();
  const scheduled = [];
  registerRarebitLifecycle(
    { on: (event, handler) => handlers.set(event, handler) },
    (ctx) => scheduled.push(ctx.sessionManager.getBranch()),
  );
  const branch = [entry("u", { role: "user", content: "goal" })];
  const ctx = {
    sessionManager: {
      getHeader: () => ({ id: "lifecycle" }),
      getSessionFile: () => "/tmp/lifecycle.jsonl",
      getBranch: () => branch,
    },
  };
  handlers.get("session_start")({}, ctx);
  scheduled.length = 0;
  handlers.get("input")({ source: "interactive", text: "goal" }, ctx);
  handlers.get("message_end")(
    { message: { role: "user", content: "goal" } },
    ctx,
  );
  handlers.get("before_provider_request")({}, ctx);
  assert.equal(scheduled.length, 1);
  handlers.get("agent_end")(
    { messages: [{ role: "assistant", stopReason: "aborted" }] },
    ctx,
  );
  handlers.get("agent_settled")({}, ctx);
  assert.equal(scheduled.length, 1, "ESC/aborted must not schedule a summary");
  branch.push({
    type: "compaction",
    id: "c",
    parentId: "u",
    summary: "derived compacted view",
  });
  branch.push(
    entry("a", { role: "assistant", stopReason: "stop", content: "done" }, "c"),
  );
  handlers.get("agent_end")(
    { messages: [{ role: "assistant", stopReason: "stop" }] },
    ctx,
  );
  handlers.get("agent_settled")({}, ctx);
  assert.equal(scheduled.length, 2);
  assert.deepEqual(
    scheduled[1].map((item) => item.id),
    ["u", "c", "a"],
  );
});
