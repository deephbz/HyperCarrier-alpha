import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AUTO_COMPACT_USAGE,
  getAutoCompactArgumentCompletions,
  parseAutoCompactCommand,
} from "../src/command.mjs";
import {
  DEFAULT_AUTO_COMPACT_SETTINGS,
  isValidThreshold,
  mergeAutoCompactSettings,
  readConfiguredAutoCompactSettings,
  resolveAutoCompactSettings,
  writeConfiguredAutoCompactSettings,
} from "../src/settings.mjs";

test("command grammar defaults to status and keeps a small explicit surface", () => {
  assert.deepEqual(parseAutoCompactCommand(), {
    ok: true,
    subcommand: "status",
  });
  assert.deepEqual(parseAutoCompactCommand("  status  "), {
    ok: true,
    subcommand: "status",
  });
  for (const subcommand of ["on", "off", "run"]) {
    assert.deepEqual(parseAutoCompactCommand(subcommand), {
      ok: true,
      subcommand,
    });
  }
  assert.deepEqual(parseAutoCompactCommand("threshold 87.5"), {
    ok: true,
    subcommand: "threshold",
    threshold: 87.5,
  });
  assert.deepEqual(
    parseAutoCompactCommand("run Continue exactly; keep  spacing.  "),
    {
      ok: true,
      subcommand: "run",
      prompt: "Continue exactly; keep  spacing.  ",
    },
  );

  for (const input of [
    "unknown",
    "status extra",
    "on extra",
    "threshold",
    "threshold 80 extra",
  ]) {
    const result = parseAutoCompactCommand(input);
    assert.equal(result.ok, false, input);
    assert.equal(result.usage, AUTO_COMPACT_USAGE, input);
  }

  assert.deepEqual(
    getAutoCompactArgumentCompletions("t").map(({ value }) => value),
    ["threshold"],
  );
  assert.deepEqual(
    getAutoCompactArgumentCompletions("").map(({ value }) => value),
    ["status", "on", "off", "threshold", "run"],
  );
  assert.equal(getAutoCompactArgumentCompletions("threshold "), null);
});

test("threshold validation accepts only finite percentages strictly between 1 and 110", () => {
  for (const value of [Number.NaN, -1, 0, 1, 110, Infinity, "90"]) {
    assert.equal(isValidThreshold(value), false, String(value));
  }
  for (const value of [1.001, 90, 100, 109.999]) {
    assert.equal(isValidThreshold(value), true, String(value));
  }

  for (const input of [
    "threshold NaN",
    "threshold Infinity",
    "threshold 0",
    "threshold 1",
    "threshold -1",
    "threshold 110",
  ]) {
    assert.equal(parseAutoCompactCommand(input).ok, false, input);
  }
});

test("project settings merge fieldwise over global settings and invalid fields fall back safely", () => {
  assert.equal(DEFAULT_AUTO_COMPACT_SETTINGS.enabled, true);
  assert.equal(DEFAULT_AUTO_COMPACT_SETTINGS.threshold, 90);
  assert.deepEqual(
    mergeAutoCompactSettings(
      {
        auto_compact: {
          enabled: false,
          threshold: 82,
          pre_compact_prompt: "global",
        },
      },
      { auto_compact: { threshold: 88 } },
    ),
    {
      enabled: false,
      threshold: 88,
      pre_compact_prompt: "global",
    },
  );

  const resolved = resolveAutoCompactSettings(
    {
      auto_compact: {
        enabled: "yes",
        threshold: 110,
        pre_compact_prompt: " ",
      },
    },
    {},
  );
  assert.deepEqual(resolved.settings, DEFAULT_AUTO_COMPACT_SETTINGS);
  assert.equal(resolved.errors.length, 3);
});

test("settings read honors trusted project scope and ignores untrusted project overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-auto-compact-settings-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await writeConfiguredAutoCompactSettings({
    cwd,
    projectTrusted: false,
    agentDir,
    patch: { enabled: false, threshold: 81 },
  });
  await writeConfiguredAutoCompactSettings({
    cwd,
    projectTrusted: true,
    agentDir,
    patch: { threshold: 89 },
  });

  const trusted = await readConfiguredAutoCompactSettings({
    cwd,
    projectTrusted: true,
    agentDir,
  });
  assert.equal(trusted.settings.enabled, false);
  assert.equal(trusted.settings.threshold, 89);
  assert.deepEqual(trusted.rawRefs, [
    join(agentDir, "settings.json"),
    join(cwd, ".pi", "settings.json"),
  ]);

  const untrusted = await readConfiguredAutoCompactSettings({
    cwd,
    projectTrusted: false,
    agentDir,
  });
  assert.equal(untrusted.settings.threshold, 81);
  assert.deepEqual(untrusted.rawRefs, [join(agentDir, "settings.json")]);
});

test("concurrent extension writes preserve unrelated root and namespace keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-auto-compact-write-"));
  const agentDir = join(root, "agent");
  const path = join(agentDir, "settings.json");
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(agentDir, { recursive: true }),
  );
  await writeFile(
    path,
    `${JSON.stringify(
      {
        provider: "unchanged",
        nested: { retained: true },
        auto_compact: {
          pre_compact_prompt: "keep this guidance",
          foreign_extension_key: "keep this too",
        },
      },
      null,
      2,
    )}\n`,
  );

  await Promise.all([
    writeConfiguredAutoCompactSettings({
      agentDir,
      projectTrusted: false,
      patch: { enabled: false },
    }),
    writeConfiguredAutoCompactSettings({
      agentDir,
      projectTrusted: false,
      patch: { threshold: 84 },
    }),
  ]);

  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.provider, "unchanged");
  assert.deepEqual(persisted.nested, { retained: true });
  assert.deepEqual(persisted.auto_compact, {
    pre_compact_prompt: "keep this guidance",
    foreign_extension_key: "keep this too",
    enabled: false,
    threshold: 84,
  });
});
