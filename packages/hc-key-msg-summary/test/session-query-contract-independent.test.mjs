import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { selectKeyMessages } from "../src/index.mjs";
import {
  parseNativeSession,
  queryKeyMessages,
  resolveActiveBranch,
} from "../src/session-query.mjs";

const header = (id, extra = {}) => ({
  type: "session",
  id,
  timestamp: "2026-07-15T00:00:00.000Z",
  cwd: "/private/workspace",
  ...extra,
});

const message = (id, parentId, role, text, stopReason) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-07-15T00:00:01.000Z",
  producer: "runtime-detail",
  message: {
    role,
    ...(stopReason ? { stopReason } : {}),
    content: [{ type: "text", text }],
  },
});

async function fixture(records) {
  const root = await mkdtemp(join(tmpdir(), "hc-key-query-independent-"));
  const project = join(root, "project");
  await mkdir(project);
  const file = join(project, "session.jsonl");
  const source = `${records.map(JSON.stringify).join("\n")}\n`;
  await writeFile(file, source);
  return { file, root, source };
}

test("default query is selector-equivalent and exposes only semantic content plus evidence coordinates", async () => {
  const records = [
    header("parity", { version: 3 }),
    message("root", null, "user", "Owner goal"),
    message("discarded", "root", "assistant", "Abandoned branch", "stop"),
    message("steer", "root", "user", "Latest steer"),
    message("continuation", "steer", "assistant", "Progress report", "toolUse"),
    message("leaf", "continuation", "assistant", "Current conclusion", "stop"),
  ];
  const { file } = await fixture(records);
  const parsed = parseNativeSession(records.map(JSON.stringify).join("\n"));
  const selected = selectKeyMessages(resolveActiveBranch(parsed));
  const output = await queryKeyMessages(file);

  assert.deepEqual(
    output.keyMessages,
    selected.occurrences.map(({ sourceEntryId, timestamp, role, outcome, text }) => ({
      sourceEntryId,
      timestamp,
      role,
      outcome,
      text,
    })),
  );
  assert.equal(output.keyMessageCount, selected.occurrences.length);
  assert.deepEqual(Object.keys(output.session).sort(), ["activeLeafId", "id"]);
  assert.deepEqual(Object.keys(output.keyMessages[0]).sort(), [
    "outcome",
    "role",
    "sourceEntryId",
    "text",
    "timestamp",
  ]);
  const serialized = JSON.stringify(output);
  for (const privateOrMachineField of [
    "/private/workspace",
    file,
    "contentHash",
    "manifestHash",
    "occurrenceId",
    "producer",
    "toolCallCount",
  ]) {
    assert.equal(serialized.includes(privateOrMachineField), false, privateOrMachineField);
  }
  assert.equal(serialized.includes("Abandoned branch"), false);
});

test("legacy v1 and versionless linear Sessions are queried without rewriting evidence", async () => {
  for (const legacyHeader of [header("v1", { version: 1 }), header("implicit-v1")]) {
    // Pi v1 entries predate entry IDs and parent links.
    const records = [
      legacyHeader,
      {
        type: "message",
        timestamp: "2026-07-15T00:00:01.000Z",
        message: { role: "user", content: "Legacy owner goal" },
      },
      {
        type: "message",
        timestamp: "2026-07-15T00:00:02.000Z",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Legacy conclusion" }],
        },
      },
    ];
    const { file, source } = await fixture(records);
    const before = await stat(file);
    const output = await queryKeyMessages(file);
    const after = await stat(file);

    assert.deepEqual(output.keyMessages.map(({ text }) => text), [
      "Legacy owner goal",
      "Legacy conclusion",
    ]);
    assert.equal(output.session.activeLeafId, null);
    assert.equal(await readFile(file, "utf8"), source);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
  }
});

test("query does not silently truncate a large selected Key Message", async () => {
  const text = `begin:${"x".repeat(300_000)}:end`;
  const { file } = await fixture([
    header("large", { version: 3 }),
    message("large-user", null, "user", text),
  ]);
  const output = await queryKeyMessages(file);
  assert.equal(output.keyMessageCount, 1);
  assert.equal(output.keyMessages[0].text.length, text.length);
  assert.equal(output.keyMessages[0].text, text);
});
