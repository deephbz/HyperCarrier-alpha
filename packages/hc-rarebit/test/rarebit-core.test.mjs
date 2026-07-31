import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import {
  DEFAULT_RAREBIT_SUMMARY_POLICY,
  RAREBIT_SUMMARY_PROMPT_VERSION,
  composeRarebitSummaryDerivationInput,
  composeRarebitSummaryPrompt,
  composeRarebitTitlePrompt,
  evaluateRarebitSummaryEligibility,
  measureRarebits,
  normalizeRarebitSummarySynthesis,
  rarebitJobIdentity,
  selectRarebits,
  titleWithDatePrefix,
} from "../src/rarebit-core.mjs";
import { createPiRarebitModelClient } from "../src/rarebit-model.mjs";
import {
  DEFAULT_RAREBIT_MAX_PROMPT_CHARS,
  processRarebitSummary,
  processRarebitTitle,
} from "../src/rarebit-service.mjs";

const entry = (id, message) => ({
  type: "message",
  id,
  timestamp: "2026-07-16T09:00:00.000Z",
  message,
});

test("Rarebit selection remains sparse evidence while measurement covers all readable message prose", () => {
  const branch = [
    entry("u", { role: "user", content: [{ type: "text", text: "goal" }] }),
    entry("tool", {
      role: "toolResult",
      content: [{ type: "text", text: "abcdefgh" }],
    }),
    entry("continuation", {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "text", text: "work" }],
    }),
    entry("final", {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "answer" }],
    }),
  ];
  const selection = selectRarebits(branch);
  assert.deepEqual(
    selection.occurrences.map(({ sourceEntryId, outcome, text }) => ({
      sourceEntryId,
      outcome,
      text,
    })),
    [
      { sourceEntryId: "u", outcome: "user", text: "goal" },
      { sourceEntryId: "continuation", outcome: "continuation", text: "work" },
      { sourceEntryId: "final", outcome: "stop", text: "answer" },
    ],
  );
  const measurement = measureRarebits(branch, selection);
  assert.equal(measurement.totalMessageProseChars, 22);
  assert.equal(measurement.rarebitChars, 14);
  assert.equal(measurement.estimatedTotalTokens, 6);
  assert.equal(measurement.estimatedRarebitTokens, 4);
  assert.equal(measurement.rarebitRatio, 14 / 22);
  assert.equal(measurement.estimateMethod, "ceil(chars_div_4)");
});

test("summary eligibility records a named estimated-token policy and exact threshold behavior", () => {
  const branch = [entry("u", { role: "user", content: "abcd" })];
  const selection = selectRarebits(branch);
  const measurement = measureRarebits(branch, selection);
  const atBoundary = evaluateRarebitSummaryEligibility(measurement, {
    ...DEFAULT_RAREBIT_SUMMARY_POLICY,
    minTotalLength: 1,
    maxRarebitRatio: 1,
  });
  assert.equal(atBoundary.eligible, true);
  const overShare = evaluateRarebitSummaryEligibility(measurement, {
    ...DEFAULT_RAREBIT_SUMMARY_POLICY,
    minTotalLength: 1,
    maxRarebitRatio: 0.999,
  });
  assert.deepEqual(overShare.reasons, ["rarebit_ratio_above_maximum"]);
  const below = evaluateRarebitSummaryEligibility(
    measurement,
    DEFAULT_RAREBIT_SUMMARY_POLICY,
  );
  assert.ok(below.reasons.includes("total_length_below_minimum"));
});

test("prompts contain semantic prose only and title is a separate date-prefixed proposal", () => {
  const selection = selectRarebits([
    entry("u", {
      role: "user",
      content: "Investigate a strange latency regression",
    }),
    entry("stop", {
      role: "assistant",
      stopReason: "stop",
      content: "Initial inspection complete",
    }),
  ]);
  const summaryPrompt = composeRarebitSummaryPrompt(selection);
  assert.match(summaryPrompt, /Investigate a strange latency regression/);
  assert.doesNotMatch(summaryPrompt, /sourceEntryId|contentHash|manifestHash/);
  assert.match(
    summaryPrompt,
    /Tool-call inputs, tool results.*deliberately absent/i,
  );
  assert.match(
    summaryPrompt,
    /Absence of a tool transcript.*never.*work was not performed/i,
  );
  assert.match(summaryPrompt, /concise 'done'.*appear accomplished/i);
  assert.match(summaryPrompt, /I will run tests next/i);
  const titlePrompt = composeRarebitTitlePrompt(selection);
  assert.match(titlePrompt, /Investigate a strange latency regression/);
  assert.doesNotMatch(titlePrompt, /Initial inspection complete/);
  assert.equal(
    titleWithDatePrefix("Title: Latency regression investigation", {
      date: "2026-07-16",
    }),
    "20260716-Latency regression investigation",
  );
});

test("bounded Summary input retains newest evidence and declares every omission", () => {
  const selection = selectRarebits([
    entry("old", { role: "user", content: `OLDEST-${"a".repeat(1_200)}` }),
    entry("middle", {
      role: "assistant",
      stopReason: "toolUse",
      content: `MIDDLE-${"b".repeat(1_200)}`,
    }),
    entry("new", {
      role: "assistant",
      stopReason: "stop",
      content: "NEWEST-EVIDENCE",
    }),
  ]);
  const input = composeRarebitSummaryDerivationInput(selection, {
    maxPromptChars: 3_200,
    lifecycleBoundary: "agent_settled",
  });
  assert.ok(input.prompt.length <= 3_200);
  assert.equal(input.coverage.totalMessageCount, 3);
  assert.ok(input.coverage.omittedMessageCount > 0);
  assert.equal(input.coverage.complete, false);
  assert.match(input.prompt, /messages before are trimmed/);
  assert.match(input.prompt, /NEWEST-EVIDENCE/);
  assert.doesNotMatch(input.prompt, /OLDEST-/);
  assert.match(input.prompt, /do not infer what was trimmed/i);
  assert.equal(DEFAULT_RAREBIT_MAX_PROMPT_CHARS, 256_000);
});

test("one oversized newest message is tail-bounded with an explicit character omission", () => {
  const selection = selectRarebits([
    entry("huge", {
      role: "user",
      content: `DISCARDED-PREFIX-${"x".repeat(20_000)}-RETAINED-SUFFIX`,
    }),
  ]);
  const input = composeRarebitSummaryDerivationInput(selection, {
    maxPromptChars: 4_000,
  });
  assert.ok(input.prompt.length <= 4_000);
  assert.equal(input.coverage.omittedMessageCount, 0);
  assert.ok(input.coverage.omittedTextChars > 0);
  assert.match(input.prompt, /leading characters.*trimmed/i);
  assert.match(input.prompt, /RETAINED-SUFFIX/);
  assert.doesNotMatch(input.prompt, /DISCARDED-PREFIX/);
});

test("Summary normalization accepts explicit uncertainty and conflicting evidence", () => {
  for (const statusReason of ["uncertain", "conflicting_evidence"]) {
    assert.deepEqual(
      normalizeRarebitSummarySynthesis(
        JSON.stringify({
          summary: "The supplied evidence does not support a reliable account.",
          sessionStatus: "needs_attention",
          statusReason,
        }),
      ),
      {
        summary: "The supplied evidence does not support a reliable account.",
        sessionStatus: "needs_attention",
        statusReason,
      },
    );
  }
});

test("Pi Summary model calls forward the stable Session cache identity", async () => {
  let receivedOptions;
  const client = await createPiRarebitModelClient(
    {
      modelRegistry: {
        find: () => ({ provider: "test", id: "cache-model" }),
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
      },
    },
    {
      model: { provider: "test", id: "cache-model" },
      piAi: {
        complete: async (_model, _context, options) => {
          receivedOptions = options;
          return { text: "ok" };
        },
      },
    },
  );
  await client.complete({ prompt: "prompt", cacheSessionId: "session-cache-1" });
  assert.equal(receivedOptions.sessionId, "session-cache-1");
});

test("job identity varies with an operation's semantic inputs, not raw source path", () => {
  const selection = selectRarebits([
    entry("u", { role: "user", content: "goal" }),
  ]);
  const base = {
    operation: "summary",
    sessionId: "session-1",
    branch: { leafId: "u" },
    selection,
    policy: { ...DEFAULT_RAREBIT_SUMMARY_POLICY, minTotalLength: 2 },
    promptVersion: "v1",
    model: { id: "cheap" },
  };
  assert.equal(rarebitJobIdentity(base), rarebitJobIdentity({ ...base }));
  assert.notEqual(
    rarebitJobIdentity({ ...base, promptVersion: "rarebit-summary-future" }),
    rarebitJobIdentity({
      ...base,
      promptVersion: RAREBIT_SUMMARY_PROMPT_VERSION,
    }),
    "a prompt-contract revision must materialize as a distinct job identity",
  );
  assert.notEqual(
    rarebitJobIdentity(base),
    rarebitJobIdentity({ ...base, operation: "title", policy: null }),
  );
});

test("shared imperative summary service persists a derived receipt without raw selected prose", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-rarebit-service-"));
  const sessionRoot = join(root, "sessions");
  const sessionDir = join(sessionRoot, "project");
  await mkdir(sessionDir, { recursive: true });
  const sessionFile = join(sessionDir, "alpha.jsonl");
  await writeFile(sessionFile, "{}\n");
  const branch = [entry("u", { role: "user", content: "owner context" })];
  const ctx = {
    sessionManager: {
      getHeader: () => ({ id: "alpha" }),
      getSessionFile: () => sessionFile,
      getBranch: () => branch,
    },
  };
  const result = await processRarebitSummary(ctx, {
    sessionRoot,
    rarebitRoot: join(root, "rarebit"),
    forceSynthesis: true,
    summaryPolicy: { minTotalLength: 999_999 },
    model: { provider: "test", id: "cheap" },
    modelClient: {
      complete: async () => ({
        provider: "test",
        model: "cheap",
        usage: { input: 3, output: 2, totalTokens: 5 },
        text: JSON.stringify({
          summary:
            "Progress: inspected | Findings: context | Questions/Requests: None stated | Next step: review",
          sessionStatus: "finished",
          statusReason: "all_requests_accomplished",
        }),
      }),
    },
  });
  assert.equal(result.record.status, "ok");
  assert.equal("eligibility" in result.record, false);
  assert.equal(
    result.record.inputCoveragePolicy.strategy,
    "newest_suffix_with_explicit_omission",
  );
  assert.equal(result.record.inputCoveragePolicy.maxPromptChars, 256_000);
  assert.deepEqual(result.record.inputCoverage, {
    totalMessageCount: 1,
    includedMessageCount: 1,
    omittedMessageCount: 0,
    omittedTextChars: 0,
    promptChars: result.record.inputCoverage.promptChars,
    complete: true,
  });
  assert.equal(result.record.synthesis.usage.inputTokens, 3);
  assert.equal(result.record.synthesis.usage.outputTokens, 2);
  assert.equal(JSON.stringify(result.record).includes("owner context"), false);
  const persisted = await readFile(result.record.path, "utf8");
  assert.equal(persisted.includes("owner context"), false);
});

test("new Summary derivation rejects the retired session_start boundary", async () => {
  await assert.rejects(
    processRarebitSummary(undefined, { lifecycleBoundary: "session_start" }),
    /Unsupported Summary lifecycle boundary/,
  );
  assert.throws(
    () =>
      composeRarebitSummaryPrompt(selectRarebits([]), {
        lifecycleBoundary: "session_start",
      }),
    /Unsupported Summary lifecycle boundary/,
  );
});

test("writer-aligned JSON Schema accepts every persisted Rarebit terminal status", async () => {
  const schema = JSON.parse(
    readFileSync(
      new URL("../schemas/rarebit.schema.json", import.meta.url),
      "utf8",
    ),
  );
  const validate = new Ajv({ allErrors: true }).compile(schema);
  const root = await mkdtemp(join(tmpdir(), "hc-rarebit-schema-"));
  const sessionRoot = join(root, "sessions");
  const rarebitRoot = join(root, "rarebit");
  const branch = [entry("u", { role: "user", content: "schema evidence" })];
  const run = async (name, config) => {
    const dir = join(sessionRoot, name);
    await mkdir(dir, { recursive: true });
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, "{}\n");
    const result = await processRarebitSummary(
      {
        sessionManager: {
          getHeader: () => ({ id: name }),
          getSessionFile: () => sessionFile,
          getBranch: () => branch,
        },
      },
      { sessionRoot, rarebitRoot, ...config },
    );
    const persisted = (await readFile(result.record.path, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse)
      .find((record) => record.type === "rarebit_summary");
    assert.equal(
      validate(persisted),
      true,
      `${name}: ${JSON.stringify(validate.errors)}`,
    );
    return persisted;
  };
  const ineligible = await run("ineligible", {});
  assert.equal(ineligible.status, "ineligible");
  const policyObservedAt = new Date();
  const inhibited = await run("inhibited", {
    summaryPolicy: { minTotalLength: 0, maxRarebitRatio: 1 },
    queryAutomaticSummaryPolicy: async () => ({
      contractVersion: "rarebit-automatic-summary-policy/1",
      queryId: "schema-query",
      decision: "inhibit",
      queryStatus: "inhibited",
      provider: "test-policy",
      reason: "exact_binding",
      observedAt: policyObservedAt.toISOString(),
      validUntil: new Date(policyObservedAt.getTime() + 1_000).toISOString(),
      queriedAt: policyObservedAt.toISOString(),
      provenance: {
        identity: "opaque-identity",
        generation: "opaque-generation",
        association: "opaque-association",
      },
    }),
  });
  assert.equal(inhibited.status, "inhibited");
  const failure = await run("failure", { forceSynthesis: true });
  assert.equal(failure.status, "failure");
  const overflow = await run("overflow", {
    forceSynthesis: true,
    model: { provider: "test", id: "cheap" },
    maxPromptChars: 1,
  });
  assert.equal(overflow.status, "unavailable_overflow");
  const ok = await run("ok", {
    forceSynthesis: true,
    model: { provider: "test", id: "cheap" },
    modelClient: {
      complete: async () => ({
        text: JSON.stringify({
          summary:
            "Progress: p | Findings: f | Questions/Requests: None stated | Next step: n",
          sessionStatus: "finished",
          statusReason: "all_requests_accomplished",
        }),
      }),
    },
  });
  assert.equal(ok.status, "ok");

  for (const status of [
    "proposal",
    "applied",
    "skipped_session_changed",
    "skipped_title_changed",
    "skipped_existing_title",
    "failure",
  ]) {
    const name = `title-${status}`;
    const dir = join(sessionRoot, name);
    await mkdir(dir, { recursive: true });
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, "{}\n");
    const title = await processRarebitTitle(
      {
        sessionManager: {
          getHeader: () => ({ id: name }),
          getSessionFile: () => sessionFile,
          getBranch: () => branch,
        },
      },
      {
        sessionRoot,
        rarebitRoot,
        sourceEntryId: "u",
        titleDate: "2026-07-16",
        model: { provider: "test", id: "cheap" },
        requestIdentity: status,
        ...(status === "failure"
          ? {
              modelClient: {
                complete: async () => {
                  throw new Error("test");
                },
              },
            }
          : {
              modelClient: { complete: async () => ({ text: "schema title" }) },
              ...(status === "proposal"
                ? {}
                : { applyTitle: async () => ({ status }) }),
            }),
      },
    );
    const record = JSON.parse(
      (await readFile(title.record.path, "utf8")).trim().split("\n").at(-1),
    );
    assert.equal(
      validate(record),
      true,
      `title ${status}: ${JSON.stringify(validate.errors)}`,
    );
  }
});
