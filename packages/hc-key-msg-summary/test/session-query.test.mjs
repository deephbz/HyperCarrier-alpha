import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  parseNativeSession,
  queryKeyMessages,
  resolveActiveBranch,
  resolveSessionFile,
} from "../src/session-query.mjs";

const header = (id) => ({
  type: "session", version: 3, id, timestamp: "2026-07-15T00:00:00.000Z", cwd: "/workspace",
});
const user = (id, parentId, text) => ({
  type: "message", id, parentId, timestamp: "2026-07-15T00:00:01.000Z",
  message: { role: "user", content: [{ type: "text", text }] },
});
const assistant = (id, parentId, text, stopReason = "stop") => ({
  type: "message", id, parentId, timestamp: "2026-07-15T00:00:02.000Z",
  message: { role: "assistant", stopReason, content: [{ type: "text", text }] },
});

async function fixture(records, id = "session-alpha") {
  const root = await mkdtemp(join(tmpdir(), "hc-key-message-query-"));
  const project = join(root, "--workspace--");
  await mkdir(project);
  const file = join(project, `2026-07-15_${id}.jsonl`);
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return { root, file };
}

test("queries only the final persisted active branch using the shared selector", async () => {
  const records = [
    header("session-alpha"),
    user("root", null, "Owner goal"),
    assistant("abandoned", "root", "Abandoned answer"),
    user("active-user", "root", "Revised steer"),
    assistant("active-continuation", "active-user", "Working report", "toolUse"),
    assistant("active-final", "active-continuation", "Delivered answer"),
  ];
  const { root, file } = await fixture(records);
  const result = await queryKeyMessages("session-alpha", { sessionRoot: root });
  assert.equal(result.session.activeLeafId, "active-final");
  assert.deepEqual(result.keyMessages.map(({ text }) => text), [
    "Owner goal", "Revised steer", "Working report", "Delivered answer",
  ]);
  assert.equal(JSON.stringify(result).includes("Abandoned answer"), false);
  assert.equal(JSON.stringify(result).includes("contentHash"), false);
  assert.equal(JSON.stringify(result).includes("manifestHash"), false);
  assert.equal(JSON.stringify(result).includes(file), false);
  assert.equal(JSON.stringify(result).includes("/workspace"), false);
  assert.equal(JSON.stringify(result).includes("producer"), false);
  assert.equal(JSON.stringify(result).includes("occurrenceId"), false);
});

test("reads legacy v1 as one linear branch without inventing IDs or rewriting evidence", async () => {
  const legacyRecords = [
    { ...header("legacy-v1"), version: 1 },
    { type: "message", timestamp: "2026-07-15T00:00:01.000Z", message: { role: "user", content: "Legacy goal" } },
    { type: "message", timestamp: "2026-07-15T00:00:02.000Z", message: { role: "assistant", stopReason: "stop", content: "Legacy answer" } },
  ];
  const { file } = await fixture(legacyRecords, "legacy-v1");
  const before = await readFile(file);
  const result = await queryKeyMessages(file);
  const after = await readFile(file);
  assert.deepEqual(after, before);
  assert.equal(result.session.activeLeafId, null);
  assert.deepEqual(result.keyMessages.map(({ sourceEntryId, text }) => ({ sourceEntryId, text })), [
    { sourceEntryId: null, text: "Legacy goal" },
    { sourceEntryId: null, text: "Legacy answer" },
  ]);
});

test("accepts an exact path and rejects zero or ambiguous exact ID matches", async () => {
  const first = await fixture([header("same-id"), user("u1", null, "One")], "same-id");
  const secondProject = join(first.root, "copy");
  await mkdir(secondProject);
  await writeFile(
    join(secondProject, "copy.jsonl"),
    `${JSON.stringify(header("same-id"))}\n${JSON.stringify(user("u2", null, "Two"))}\n`,
  );
  assert.equal(await resolveSessionFile(first.file, { sessionRoot: first.root }), first.file);
  await assert.rejects(
    resolveSessionFile("same-id", { sessionRoot: first.root }),
    /ambiguous across 2 files/,
  );
  await assert.rejects(
    resolveSessionFile("missing-id", { sessionRoot: first.root }),
    /No persisted Pi Session has exact ID missing-id/,
  );
});

test("fails closed on malformed, duplicate, cyclic, and missing-parent evidence", () => {
  assert.throws(() => parseNativeSession(`${JSON.stringify(header("bad"))}\n{`), /malformed JSON at line 2/);
  assert.throws(
    () => parseNativeSession([
      header("duplicate"), user("same", null, "One"), user("same", "same", "Two"),
    ].map(JSON.stringify).join("\n")),
    /duplicate Session entry ID same/,
  );
  const cyclic = parseNativeSession([
    header("cyclic"), user("one", "two", "One"), user("two", "one", "Two"),
  ].map(JSON.stringify).join("\n"));
  assert.throws(() => resolveActiveBranch(cyclic), /cycle at Session entry two/);
  const orphaned = parseNativeSession([
    header("orphaned"), user("orphan", "absent", "One"),
  ].map(JSON.stringify).join("\n"));
  assert.throws(() => resolveActiveBranch(orphaned), /missing parent Session entry absent/);
});

test("CLI emits JSON for an exact path without modifying native evidence", async () => {
  const { file } = await fixture([
    header("cli-session"), user("u1", null, "CLI owner goal"), assistant("a1", "u1", "CLI answer"),
  ], "cli-session");
  const cli = new URL("../bin/hc-key-messages.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [cli.pathname, "--session", file, "--json"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.session.id, "cli-session");
  assert.deepEqual(Object.keys(output.session), ["id", "activeLeafId"]);
  assert.deepEqual(output.keyMessages.map(({ text }) => text), ["CLI owner goal", "CLI answer"]);
});
