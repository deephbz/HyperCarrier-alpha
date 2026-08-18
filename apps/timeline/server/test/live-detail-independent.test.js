import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createIncrementalTraceReader,
  createLiveDetailServer,
  projectPiTrace,
} from "../live-detail.js";

const SESSION_ID = "trace-viewer-session";

function header(id = SESSION_ID) {
  return { type: "session", version: 3, id, timestamp: "2026-08-17T00:00:00.000Z", cwd: "/safe" };
}

function user(id, parentId, text) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-17T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function assistant(id, parentId, stopReason, content) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-17T00:00:02.000Z",
    message: { role: "assistant", stopReason, content },
  };
}

function toolResult(id, parentId, toolCallId, text) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-17T00:00:03.000Z",
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "read",
      content: [{ type: "text", text }],
    },
  };
}

function jsonl(records) {
  return `${records.map(JSON.stringify).join("\n")}\n`;
}

function traceFixture(id = SESSION_ID) {
  return [
    header(id),
    user("u-root", null, "Owner request"),
    assistant("a-call", "u-root", "toolUse", [
      { type: "text", text: "I will inspect the file." },
      { type: "toolCall", id: "call-exact", name: "read", arguments: { path: "safe.txt" } },
    ]),
    toolResult("tool-exact", "a-call", "call-exact", "<img src=x onerror=alert(1)> tool result"),
    toolResult("tool-unmatched", "tool-exact", "call-missing", "unmatched tool result"),
    assistant("a-error", "tool-unmatched", "error", [{ type: "text", text: "The tool failed." }]),
    {
      type: "custom",
      id: "custom",
      parentId: "a-error",
      timestamp: "2026-08-17T00:00:04.000Z",
      customType: "test",
      data: { ok: true },
    },
    assistant("a-stop", "custom", "stop", [{ type: "text", text: "Shared handoff." }]),
    user("u-abandoned", "a-stop", "Abandoned branch"),
    assistant("a-abandoned", "u-abandoned", "stop", [{ type: "text", text: "Abandoned response" }]),
    user("u-active", "a-stop", "Continue active work"),
    assistant("a-active", "u-active", "stop", [{ type: "text", text: "Active handoff" }]),
  ];
}

function createSessionFile(records) {
  const root = mkdtempSync(join(tmpdir(), "trace-viewer-"));
  const project = join(root, "project");
  mkdirSync(project);
  const path = join(project, "session.jsonl");
  writeFileSync(path, jsonl(records));
  return { root, path };
}

async function startServer(t, records) {
  const { root, path } = createSessionFile(records);
  const staticDir = join(root, "trace-viewer");
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, "index.html"), '<!doctype html><div id="root"></div>');
  let notify;
  const server = createLiveDetailServer({
    sessionsRoot: root,
    staticDir,
    watchSources: (callback) => {
      notify = callback;
      return { close() {} };
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${server.address().port}`, root, path, notify };
}

test("Pi trace projection retains full active-branch evidence and attaches Rarebits by source entry", () => {
  const { path } = createSessionFile(traceFixture());
  const reader = createIncrementalTraceReader(path);
  const update = reader.refresh();
  const trace = projectPiTrace(update.projection);
  assert.equal(update.kind, "snapshot");
  assert.equal(trace.schemaVersion, "pi-trace/1");
  assert.deepEqual(
    trace.records.map((record) => record.sourceEntryId),
    [
      "u-root",
      "a-call",
      "tool-exact",
      "tool-unmatched",
      "a-error",
      "custom",
      "a-stop",
      "u-active",
      "a-active",
    ],
  );
  assert.deepEqual(
    trace.records.filter((record) => record.rarebit).map((record) => record.sourceEntryId),
    ["u-root", "a-call", "a-stop", "u-active", "a-active"],
  );
  assert.equal(trace.records.find((record) => record.sourceEntryId === "a-error")?.rarebit, false);
  assert.equal(trace.records.find((record) => record.sourceEntryId === "custom")?.kind, "custom");
  assert.equal(
    trace.records.find((record) => record.sourceEntryId === "tool-exact")?.toolCallRecordId,
    "entry:a-call",
  );
  assert.equal(
    trace.records.find((record) => record.sourceEntryId === "tool-unmatched")?.toolCallRecordId,
    null,
  );
  assert.match(
    trace.records.find((record) => record.sourceEntryId === "tool-exact")?.unavailable.toolSchema,
    /does not record/,
  );
});

test("trace API, static viewer, raw download, and SSE preserve exact-session boundaries", async (t) => {
  const live = await startServer(t, traceFixture());
  const traceResponse = await fetch(`${live.base}/api/trace/${SESSION_ID}`);
  const trace = await traceResponse.json();
  assert.equal(traceResponse.status, 200);
  assert.equal(trace.sessionId, SESSION_ID);
  assert.equal(
    trace.records.some((record) => record.sourceEntryId === "tool-exact"),
    true,
  );
  assert.equal(
    trace.records.some((record) => record.sourceEntryId === "u-abandoned"),
    false,
  );

  const page = await fetch(`${live.base}/session/${SESSION_ID}`);
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /<div id="root"><\/div>/);
  assert.doesNotMatch(pageHtml, /onerror=alert/);

  const raw = await fetch(`${live.base}/raw/${SESSION_ID}`);
  assert.equal(raw.status, 200);
  assert.match(raw.headers.get("content-disposition"), new RegExp(`${SESSION_ID}\\.jsonl`));
  assert.equal(raw.headers.get("x-hypercarrier-source-version"), trace.sourceVersion);
  assert.match(await raw.text(), /tool-unmatched/);

  const controller = new AbortController();
  t.after(() => controller.abort());
  const events = await fetch(`${live.base}/api/events/${SESSION_ID}`, {
    signal: controller.signal,
  });
  const stream = events.body.getReader();
  await stream.read();
  appendFileSync(
    live.path,
    `${JSON.stringify(assistant("a-live", "a-active", "stop", [{ type: "text", text: "Live update" }]))}\n`,
  );
  live.notify({ paths: [live.path] });
  const invalidation = new TextDecoder().decode((await stream.read()).value);
  assert.match(invalidation, /event: invalidate/);
  assert.match(invalidation, /"reason":"append"/);
  assert.doesNotMatch(invalidation, /Live update/);
  const refreshed = await (await fetch(`${live.base}/api/trace/${SESSION_ID}`)).json();
  assert.equal(refreshed.records.at(-1).sourceEntryId, "a-live");
});

test("same-path replacement fences the former Session identity", async (t) => {
  const live = await startServer(t, [header(), user("u-old", null, "old")]);
  assert.equal((await fetch(`${live.base}/api/trace/${SESSION_ID}`)).status, 200);
  const replacementId = `${SESSION_ID}-replacement`;
  const replacement = `${live.path}.replacement`;
  writeFileSync(replacement, jsonl([header(replacementId), user("u-new", null, "new")]));
  renameSync(replacement, live.path);
  live.notify({ paths: [live.path] });
  assert.equal((await fetch(`${live.base}/api/trace/${SESSION_ID}`)).status, 404);
  const replacementTrace = await (await fetch(`${live.base}/api/trace/${replacementId}`)).json();
  assert.equal(replacementTrace.sessionId, replacementId);
});
