import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  parseRarebitCliArgs,
  readRarebitCliSettings,
  runRarebitCli,
} from "../src/rarebit-cli.mjs";
import { readConfiguredRarebitSettings } from "../src/extension.mjs";

const header = {
  type: "session",
  version: 3,
  id: "rarebit-cli",
  timestamp: "2026-07-16T00:00:00.000Z",
};
const user = {
  type: "message",
  id: "u",
  parentId: null,
  timestamp: "2026-07-16T00:00:01.000Z",
  message: { role: "user", content: "Find the slow path" },
};
const tool = {
  type: "message",
  id: "tool",
  parentId: "u",
  timestamp: "2026-07-16T00:00:02.000Z",
  message: {
    role: "toolResult",
    content: [{ type: "text", text: "verbose tool output" }],
  },
};
const stop = {
  type: "message",
  id: "a",
  parentId: "tool",
  timestamp: "2026-07-16T00:00:03.000Z",
  message: {
    role: "assistant",
    stopReason: "stop",
    content: "Found the slow path",
  },
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hc-rarebit-"));
  const project = join(root, "project");
  await mkdir(project);
  const file = join(project, "session.jsonl");
  await writeFile(
    file,
    [header, user, tool, stop].map(JSON.stringify).join("\n"),
  );
  return file;
}

test("query hides raw Rarebit prose while extract returns the deterministic raw evidence", async () => {
  const file = await fixture();
  const query = await runRarebitCli({ command: "query", session: file });
  assert.equal(query.rarebitCount, 2);
  assert.equal(JSON.stringify(query).includes("Find the slow path"), false);
  const extract = await runRarebitCli({ command: "extract", session: file });
  assert.deepEqual(
    extract.rarebits.map(({ text }) => text),
    ["Find the slow path", "Found the slow path"],
  );
});

test("on-demand summary is policy-gated unless a caller explicitly forces it", async () => {
  const file = await fixture();
  const calls = [];
  const result = await runRarebitCli(
    {
      command: "summarize",
      session: file,
      modelArgs: [],
      force: false,
    },
    {
      readSettings: async () => ({
        model: { provider: "test", id: "cheap" },
        summaryPolicy: {},
      }),
      processSummary: async (_ctx, config) => {
        calls.push(config);
        return {
          record: {
            status: config.forceSynthesis ? "ok" : "ineligible",
            summary: "fake",
          },
        };
      },
    },
  );
  assert.equal(result.status, "ineligible");
  assert.equal(calls.length, 1);
  const forced = await runRarebitCli(
    {
      command: "summarize",
      session: file,
      modelArgs: [],
      force: true,
    },
    {
      readSettings: async () => ({
        model: { provider: "test", id: "cheap" },
        summaryPolicy: {},
      }),
      processSummary: async (_ctx, config) => {
        calls.push(config);
        return {
          record: {
            status: config.forceSynthesis ? "ok" : "ineligible",
            summary: "fake",
          },
        };
      },
    },
  );
  assert.equal(forced.status, "ok");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].forceSynthesis, true);
});

test("title generates only a proposal with an explicit date prefix and never mutates the Session", async () => {
  const file = await fixture();
  const result = await runRarebitCli(
    {
      command: "title",
      session: file,
      modelArgs: [],
      date: "2026-07-16",
    },
    {
      readSettings: async () => ({
        model: { provider: "test", id: "cheap" },
        summaryPolicy: {},
      }),
      runPiModel: async () => "Title: Slow-path investigation",
      rarebitRoot: join(file, "..", "rarebit-test-state"),
    },
  );
  assert.equal(result.status, "proposal");
  assert.equal(result.title, "20260716-Slow-path investigation");
});

test("binary requires JSON and query never leaks an absolute source path", async () => {
  const file = await fixture();
  const cli = new URL("../bin/hc-rarebit.mjs", import.meta.url);
  const output = spawnSync(
    process.execPath,
    [cli.pathname, "query", "--session", file, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.stdout.includes(file), false);
  assert.equal(JSON.parse(output.stdout).rarebitCount, 2);
  assert.throws(
    () => parseRarebitCliArgs(["query", "--session", file]),
    /--json is required/,
  );
});

test("CLI and Pi extension resolve nested Rarebit settings identically", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-rarebit-settings-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  await mkdir(join(project, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      rarebit: {
        model: "test-provider/global-cheap",
        min_total_length: 80_000,
        auto_title: true,
      },
    }),
  );
  await writeFile(
    join(project, ".pi", "settings.json"),
    JSON.stringify({
      rarebit: {
        min_total_length: 12_345,
        max_rarebit_ratio: 0.25,
        auto_title: false,
      },
    }),
  );

  const [cli, extension] = await Promise.all([
    readRarebitCliSettings({ agentDir, cwd: project }),
    readConfiguredRarebitSettings({
      agentDir,
      cwd: project,
      projectTrusted: true,
    }),
  ]);
  assert.deepEqual(cli.model, extension.model);
  assert.deepEqual(cli.summaryPolicy, extension.summaryPolicy);
  assert.equal(cli.autoTitle, extension.autoTitle);
  assert.deepEqual(cli.model, {
    provider: "test-provider",
    id: "global-cheap",
  });
  assert.equal(cli.summaryPolicy.minTotalLength, 12_345);
  assert.equal(cli.summaryPolicy.maxRarebitRatio, 0.25);
  assert.equal(cli.autoTitle, false);
});
