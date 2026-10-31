import "../../test/home.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MAX_TRACE_SOURCE_BYTES,
  createIncrementalTraceReader,
  createLiveDetailServer,
  openPinnedSource,
  projectPiTrace,
} from "../live-detail.js";

const MEBIBYTE = 1024 * 1024;
const session = (id) => ({ type: "session", version: 3, id });
const message = (id, parentId, role, content) => ({
  type: "message",
  id,
  parentId,
  message: { role, content },
});
const jsonl = (records) => `${records.map(JSON.stringify).join("\n")}\n`;

function createSessionSource(id, records = [message("u1", null, "user", "request")]) {
  const root = mkdtempSync(join(tmpdir(), "trace-viewer-adversarial-"));
  const project = join(root, "project");
  mkdirSync(project);
  const path = join(project, "session.jsonl");
  writeFileSync(path, jsonl([session(id), ...records]));
  return { root, path };
}

async function startServer(t, root) {
  const staticDir = join(root, "trace-viewer");
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, "index.html"), '<!doctype html><div id="root"></div>');
  const server = createLiveDetailServer({
    sessionsRoot: root,
    staticDir,
    watchSources: () => ({ close() {} }),
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test("non-append prefix mutation cannot leave stale trace evidence", () => {
  const { path } = createSessionSource("adversarial-prefix-mutation");
  const originalText = "A".repeat(2_048);
  const changedText = `B${originalText.slice(1)}`;
  const original = [
    session("adversarial-prefix-mutation"),
    message("u1", null, "user", [{ type: "text", text: originalText }]),
  ];
  writeFileSync(path, jsonl(original));

  const reader = createIncrementalTraceReader(path);
  reader.refresh();
  writeFileSync(
    path,
    jsonl([original[0], message("u1", null, "user", [{ type: "text", text: changedText }])]),
  );
  appendFileSync(path, `${JSON.stringify(message("a1", "u1", "assistant", "append"))}\n`);

  const update = reader.refresh();
  const trace = projectPiTrace(update.projection);
  assert.equal(update.io.mode, "reset");
  assert.equal(
    trace.records.find((record) => record.sourceEntryId === "u1")?.content[0]?.text,
    changedText,
  );
});

test("duplicate tool call IDs across records do not fabricate a link", () => {
  const trace = projectPiTrace({
    availability: "available",
    sessionId: "adversarial-duplicate-tool-call",
    version: "fixture",
    activeLeafId: "tool-result",
    activeBranchIds: ["u1", "a1", "a2", "tool-result"],
    activeBranch: [
      message("u1", null, "user", "request"),
      message("a1", "u1", "assistant", [
        { type: "toolCall", id: "same-call", name: "first", arguments: {} },
      ]),
      message("a2", "a1", "assistant", [
        { type: "toolCall", id: "same-call", name: "second", arguments: {} },
      ]),
      {
        ...message("tool-result", "a2", "toolResult", "result"),
        message: { role: "toolResult", toolCallId: "same-call", content: "result" },
      },
    ],
  });

  assert.equal(
    trace.records.find((record) => record.sourceEntryId === "tool-result")?.toolCallRecordId,
    null,
  );
});

test("duplicate tool call IDs in one record do not fabricate a link", () => {
  const trace = projectPiTrace({
    availability: "available",
    sessionId: "adversarial-same-record-tool-call",
    version: "fixture",
    activeLeafId: "tool-result",
    activeBranchIds: ["u1", "a1", "tool-result"],
    activeBranch: [
      message("u1", null, "user", "request"),
      message("a1", "u1", "assistant", [
        { type: "toolCall", id: "same-call", name: "first", arguments: {} },
        { type: "toolCall", id: "same-call", name: "second", arguments: {} },
      ]),
      {
        ...message("tool-result", "a1", "toolResult", "result"),
        message: { role: "toolResult", toolCallId: "same-call", content: "result" },
      },
    ],
  });

  assert.equal(
    trace.records.find((record) => record.sourceEntryId === "tool-result")?.toolCallRecordId,
    null,
  );
});

test("pinned raw source keeps the projected inode when its path is replaced", () => {
  const { path } = createSessionSource("pinned-raw");
  const original = jsonl([session("pinned-raw"), message("u1", null, "user", "old evidence")]);
  const replacement = jsonl([
    session("pinned-raw"),
    message("u1", null, "user", "replacement evidence"),
  ]);
  writeFileSync(path, original);

  const reader = createIncrementalTraceReader(path);
  const update = reader.refresh();
  const pinned = openPinnedSource(path, update.version);
  assert.ok(pinned);
  const replacementPath = `${path}.replacement`;
  writeFileSync(replacementPath, replacement);
  renameSync(replacementPath, path);

  try {
    const buffer = Buffer.alloc(pinned.size);
    const bytesRead = readSync(pinned.fd, buffer, 0, buffer.length, 0);
    assert.equal(buffer.subarray(0, bytesRead).toString("utf8"), original);
  } finally {
    closeSync(pinned.fd);
  }
});

test("malformed encoded exact-Session paths return errors without crashing", () => {
  const { root } = createSessionSource("safe-session");
  const staticDir = join(root, "static");
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, "index.html"), "<!doctype html>");

  const liveDetailUrl = new URL("../live-detail.js", import.meta.url).href;
  const script = `
      import { createLiveDetailServer } from ${JSON.stringify(liveDetailUrl)};
      let uncaught = null;
      process.once("uncaughtException", (error) => { uncaught = \`${"${error.name}"}: ${"${error.message}"}\`; });
      const server = createLiveDetailServer({
        sessionsRoot: ${JSON.stringify(root)},
        staticDir: ${JSON.stringify(staticDir)},
        watchSources: () => ({ close() {} }),
      });
      await new Promise((done) => server.listen(0, "127.0.0.1", done));
      const base = \`http://127.0.0.1:\${server.address().port}\`;
      let statuses = null;
      try {
        statuses = await Promise.all([
          \`${"${base}"}/api/trace/%E0%A4%A\`,
          \`${"${base}"}/raw/%E0%A4%A\`,
          \`${"${base}"}/api/events/%E0%A4%A\`,
          \`${"${base}"}/session/%E0%A4%A\`,
        ].map(async (url) => (await fetch(url, { signal: AbortSignal.timeout(250) })).status));
      } catch {}
      console.log(JSON.stringify({ statuses, uncaught }));
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    `;
  const result = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      encoding: "utf8",
    }),
  );

  assert.equal(result.uncaught, null);
  assert.deepEqual(result.statuses, [400, 400, 400, 400]);
});

test("trailing JSONL stays pending, but a completed malformed record fails closed", () => {
  const { path } = createSessionSource("malformed-jsonl");
  writeFileSync(
    path,
    `${jsonl([session("malformed-jsonl"), message("u1", null, "user", "ok")])}{"type":`,
  );
  const reader = createIncrementalTraceReader(path);
  assert.equal(reader.refresh().projection.availability, "available");

  writeFileSync(
    path,
    `${jsonl([session("malformed-jsonl"), message("u1", null, "user", "ok")])}{"type":not-json}\n`,
  );
  const completed = reader.refresh().projection;
  assert.equal(completed.availability, "unavailable");
  assert.equal(completed.reason, "malformed_jsonl");
});

test("missing IDs and broken lineage fail closed, while unknown entries remain inspectable", () => {
  const missing = createSessionSource("missing-entry", [{ type: "custom", parentId: null }]);
  const missingProjection = createIncrementalTraceReader(missing.path).refresh().projection;
  assert.equal(missingProjection.availability, "unavailable");
  assert.equal(missingProjection.reason, "entry_without_id");

  const broken = createSessionSource("broken-lineage", [
    message("orphan", "not-in-source", "user", "orphaned"),
  ]);
  const brokenProjection = createIncrementalTraceReader(broken.path).refresh().projection;
  assert.equal(brokenProjection.availability, "unavailable");
  assert.equal(brokenProjection.reason, "active_branch_unavailable");

  const unknown = createSessionSource("unknown-entry", [
    { type: "future_pi_entry", id: "future", parentId: null, payload: { preserved: true } },
  ]);
  const trace = projectPiTrace(createIncrementalTraceReader(unknown.path).refresh().projection);
  assert.equal(trace.availability, "available");
  assert.equal(trace.records[0].kind, "unknown");
  assert.equal(trace.records[0].label, "Unknown: future_pi_entry");
  assert.deepEqual(trace.records[0].raw, {
    type: "future_pi_entry",
    id: "future",
    parentId: null,
    payload: { preserved: true },
  });
});

test("the trace stays complete below its cap and rejects oversized sources", () => {
  const completeText = "x".repeat(8 * MEBIBYTE);
  const complete = createSessionSource("complete-eight-mebibytes", [
    message("u1", null, "user", completeText),
  ]);
  const trace = projectPiTrace(createIncrementalTraceReader(complete.path).refresh().projection);
  assert.equal(trace.availability, "available");
  assert.equal(trace.records[0].content[0]?.text, completeText);

  const oversized = createSessionSource("oversized-sixty-four-mebibytes", [
    message("u1", null, "user", "y".repeat(64 * MEBIBYTE)),
  ]);
  const projection = createIncrementalTraceReader(oversized.path).refresh().projection;
  assert.equal(projection.availability, "unavailable");
  assert.equal(projection.reason, "trace_source_too_large");
  assert.ok(projection.sourceBytes > MAX_TRACE_SOURCE_BYTES);
});

test("an oversized trace returns failure while raw exact JSONL stays downloadable", async (t) => {
  const sourceText = "z".repeat(64 * MEBIBYTE);
  const { root, path } = createSessionSource("oversized-download", [
    message("u1", null, "user", sourceText),
  ]);
  const sourceBytes = statSync(path).size;
  const base = await startServer(t, root);

  const trace = await fetch(`${base}/api/trace/oversized-download`);
  assert.equal(trace.status, 413);
  assert.equal((await trace.json()).reason, "trace_source_too_large");

  const raw = await fetch(`${base}/raw/oversized-download`);
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get("content-length"), String(sourceBytes));
  await raw.body.cancel();
});

test("duplicate Session headers make every exact-Session route unavailable", async (t) => {
  const id = "ambiguous-session";
  const { root } = createSessionSource(id);
  const duplicateProject = join(root, "duplicate-project");
  mkdirSync(duplicateProject);
  writeFileSync(
    join(duplicateProject, "duplicate.jsonl"),
    jsonl([session(id), message("u2", null, "user", "second source")]),
  );
  const base = await startServer(t, root);

  for (const route of ["/api/trace", "/raw", "/api/events", "/session"]) {
    const response = await fetch(`${base}${route}/${id}`);
    assert.equal(response.status, 409, route);
    const body = await response.json();
    assert.equal(body.availability, "unavailable");
    assert.equal(body.reason, "ambiguous_session_source");
  }
});
