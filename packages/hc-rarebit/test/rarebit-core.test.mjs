import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import {
  DEFAULT_RAREBIT_SUMMARY_POLICY,
  composeRarebitSummaryPrompt,
  composeRarebitTitlePrompt,
  evaluateRarebitSummaryEligibility,
  measureRarebits,
  rarebitJobIdentity,
  selectRarebits,
  titleWithDatePrefix,
} from "../src/rarebit-core.mjs";
import {
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
        text: "Progress: inspected | Findings: context | Questions/Requests: None stated | Next step: review",
      }),
    },
  });
  assert.equal(result.record.status, "ok");
  assert.equal(result.record.eligibility.forced, true);
  assert.equal(result.record.synthesis.usage.totalTokens, 5);
  assert.equal(JSON.stringify(result.record).includes("owner context"), false);
  const persisted = await readFile(result.record.path, "utf8");
  assert.equal(persisted.includes("owner context"), false);
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
    const persisted = JSON.parse(
      (await readFile(result.record.path, "utf8")).trim().split("\n").at(-1),
    );
    assert.equal(
      validate(persisted),
      true,
      `${name}: ${JSON.stringify(validate.errors)}`,
    );
    return persisted;
  };
  const ineligible = await run("ineligible", {});
  assert.equal(ineligible.status, "ineligible");
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
        text: "Progress: p | Findings: f | Questions/Requests: None stated | Next step: n",
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
