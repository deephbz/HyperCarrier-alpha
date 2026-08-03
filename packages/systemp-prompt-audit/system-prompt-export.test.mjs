import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createSystemPromptExport,
  DEFAULT_SYSTEM_PROMPT_EXPORT_DIRECTORY,
  registerSystemPromptExportCommand,
  writeSystemPromptExport,
} from "./system-prompt-export.mjs";

const tools = [
  {
    name: "read",
    description: "Read a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    promptGuidelines: ["Use read before edit."],
    sourceInfo: { source: "builtin", path: "<builtin:read>" },
  },
  {
    name: "custom",
    description: "A custom tool.",
    parameters: { type: "object", additionalProperties: false },
    sourceInfo: { source: "extension", path: "<extension:custom>" },
  },
];

function input(cwd) {
  return {
    cwd,
    systemPrompt: "System instructions\n\nDo the work.",
    activeToolNames: ["custom", "read"],
    allTools: tools,
  };
}

test("captures the effective prompt and active tools in active order", () => {
  const artifact = createSystemPromptExport(
    input("/workspace"),
    new Date("2026-07-13T10:20:30.000Z"),
  );

  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.capturedAt, "2026-07-13T10:20:30.000Z");
  assert.equal(artifact.cwd, "/workspace");
  assert.equal(artifact.systemPrompt, "System instructions\n\nDo the work.");
  assert.deepEqual(artifact.activeTools, [tools[1], tools[0]]);
  assert.equal(
    artifact.integrity.contentSha256,
    createHash("sha256")
      .update(
        JSON.stringify({
          systemPrompt: artifact.systemPrompt,
          activeTools: artifact.activeTools,
        }),
      )
      .digest("hex"),
  );
});

test("writes a new JSON evidence artifact without overwriting it", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-prompt-export-"));
  const outputPath = `${DEFAULT_SYSTEM_PROMPT_EXPORT_DIRECTORY}/evidence.json`;
  const result = await writeSystemPromptExport(input(cwd), {
    now: new Date("2026-07-13T10:20:30.000Z"),
    outputPath,
  });

  assert.equal(result.outputPath, path.join(cwd, outputPath));
  assert.deepEqual(JSON.parse(await readFile(result.outputPath, "utf8")), result.artifact);
  await assert.rejects(
    writeSystemPromptExport(input(cwd), { outputPath }),
    (error) => error.code === "EEXIST",
  );
});

test("rejects external paths, non-JSON paths, and unknown active tools", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-prompt-export-"));
  await assert.rejects(
    writeSystemPromptExport(input(cwd), { outputPath: "../outside.json" }),
    /inside the current working directory/,
  );
  await assert.rejects(
    writeSystemPromptExport(input(cwd), { outputPath: "snapshot.txt" }),
    /must end in \.json/,
  );
  assert.throws(
    () => createSystemPromptExport({ ...input(cwd), activeToolNames: ["missing"] }),
    /Active tool 'missing'/,
  );
});

test("registers an operator command without a model-facing tool", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-prompt-export-command-"));
  let commandName;
  let registered;
  const notifications = [];
  const pi = {
    registerCommand(name, command) {
      commandName = name;
      registered = command;
    },
    registerTool() {
      throw new Error("The snapshot extension must not register model tools.");
    },
    getActiveTools() {
      return ["custom", "read"];
    },
    getAllTools() {
      return tools;
    },
  };

  registerSystemPromptExportCommand(pi);
  assert.equal(commandName, "export-system-prompt");
  const result = await registered.handler(
    ".pi/prompt-snapshots/live-shape.json",
    {
      cwd,
      getSystemPrompt() {
        return "Live prompt shape";
      },
      ui: { notify(message, level) { notifications.push({ message, level }); } },
    },
  );

  assert.equal(result.activeToolCount, 2);
  assert.equal(result.outputPath, path.join(cwd, ".pi/prompt-snapshots/live-shape.json"));
  assert.equal(notifications[0].level, "info");
  const artifact = JSON.parse(await readFile(result.outputPath, "utf8"));
  assert.equal(artifact.systemPrompt, "Live prompt shape");
  assert.deepEqual(
    artifact.activeTools.map((tool) => tool.name),
    ["custom", "read"],
  );
});

test("extension entry point contains no model tool registration", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /registerTool|registerSystemPromptReviewTool|registerSystemPromptExportTool/);
  assert.match(source, /registerSystemPromptExportCommand/);
});
