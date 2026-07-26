#!/usr/bin/env node
/** Generate a deterministic, metadata-only scale fixture for the collector. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

export const FIXTURE_NOW = "2026-07-11T12:00:00.000Z";
export const SESSION_COUNT = 13;
export const DENSE_SESSION_TURNS = 240;

const projects = ["atlas", "beacon", "cipher", "delta", "ember", "fjord", "grove", "harbor"];
const iso = (seconds) =>
  new Date(Date.parse("2026-07-10T08:00:00.000Z") + seconds * 1_000).toISOString();
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const writeJsonl = (path, records) =>
  writeFileSync(path, `${records.map(JSON.stringify).join("\n")}\n`);

function usageFor(sessionNumber, turn) {
  const dense = sessionNumber === 1;
  const input = dense ? 42_000 + (turn % 5) * 1_000 : 8_000 + sessionNumber * 500;
  const output = dense ? 1_200 + (turn % 7) * 100 : 700 + (turn % 4) * 75;
  return {
    input,
    output,
    cacheRead: Math.floor(input * 0.7),
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { total: Number((input * 0.000003 + output * 0.000015).toFixed(6)) },
  };
}

function sessionRecords(number) {
  const id = `synthetic-session-${String(number).padStart(2, "0")}`;
  const turns = number === 1 ? DENSE_SESSION_TURNS : 4 + (number % 5);
  const start = number * 3_600;
  const records = [
    {
      type: "session",
      id,
      timestamp: iso(start),
      cwd: `/work/${projects[(number - 1) % projects.length]}`,
    },
    {
      type: "session_name",
      timestamp: iso(start + 1),
      name: `synthetic-${projects[(number - 1) % projects.length]}-${number}`,
    },
  ];
  for (let turn = 1; turn <= turns; turn++) {
    const at = start + turn * 35;
    records.push({
      type: "message",
      id: `${id}-user-${turn}`,
      timestamp: iso(at),
      message: { role: "user" },
    });
    records.push({
      type: "message",
      id: `${id}-assistant-${turn}`,
      timestamp: iso(at + 12),
      message: {
        role: "assistant",
        provider: "synthetic-provider",
        model: "synthetic-model-v1",
        stopReason: "stop",
        usage: usageFor(number, turn),
      },
    });
  }
  return records;
}

/**
 * Create native Session fixtures under `root`.
 * The returned paths and manifest make tests independent of the caller's cwd.
 */
export function generateFixture(root) {
  const fixtureRoot = resolve(root);
  const sessionsRoot = join(fixtureRoot, "sessions");
  mkdirSync(sessionsRoot, { recursive: true });

  let totalTokens = 0;
  let submissions = 0;
  for (let number = 1; number <= SESSION_COUNT; number++) {
    const id = `synthetic-session-${String(number).padStart(2, "0")}`;
    const records = sessionRecords(number);
    writeJsonl(join(sessionsRoot, `${id}.jsonl`), records);
    for (const record of records) {
      if (record.message?.role === "user") submissions++;
      if (record.message?.role === "assistant") totalTokens += record.message.usage.totalTokens;
    }
  }
  const manifest = {
    generatedAt: FIXTURE_NOW,
    sessionsRoot,
    sessionCount: SESSION_COUNT,
    submissions,
    totalTokens,
  };
  writeJson(join(fixtureRoot, "manifest.json"), manifest);
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const manifest = generateFixture(process.argv[2] ?? "synthetic-fixture");
  console.log(JSON.stringify(manifest));
}
