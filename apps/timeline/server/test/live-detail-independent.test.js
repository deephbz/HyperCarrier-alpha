import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseNativeSession, resolveActiveBranch } from "@hypercarrier/hc-rarebit/session";
import { selectRarebits } from "@hypercarrier/hc-rarebit/core";
import {
  analyzeSessionParentGraph,
  createIncrementalRarebitReader,
  createLiveDetailServer,
  nativeExportPreflight,
} from "../live-detail.js";
import { SessionRegistry } from "../session-registry.js";

const SESSION_ID = "independent-live-detail-session";

function header(id = SESSION_ID) {
  return {
    type: "session",
    version: 2,
    id,
    timestamp: "2026-07-20T00:00:00.000Z",
    cwd: "/sanitized",
  };
}

function user(id, parentId, text, producer = undefined) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: `2026-07-20T00:00:${id.length.toString().padStart(2, "0")}.000Z`,
    ...(producer ? { producer } : {}),
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function assistant(id, parentId, stopReason, text) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: `2026-07-20T00:01:${id.length.toString().padStart(2, "0")}.000Z`,
    message: {
      role: "assistant",
      stopReason,
      content: [{ type: "text", text }],
    },
  };
}

function toolResult(id, parentId, text) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: `2026-07-20T00:02:${id.length.toString().padStart(2, "0")}.000Z`,
    message: { role: "toolResult", content: [{ type: "text", text }] },
  };
}

function jsonl(records, { finalNewline = true } = {}) {
  return `${records.map(JSON.stringify).join("\n")}${finalNewline ? "\n" : ""}`;
}

function branchFixture(id = SESSION_ID) {
  return [
    header(id),
    user("u-root", null, "Owner root evidence.", "owner"),
    assistant("a-continuation", "u-root", "toolUse", "Agent continuation evidence."),
    toolResult("tool-secret", "a-continuation", "DO_NOT_TRANSPORT_TOOL_RESULT"),
    assistant("a-error", "tool-secret", "error", "DO_NOT_PROMOTE_ERROR"),
    assistant("a-before-fork", "a-error", "stop", "Shared stop evidence."),
    user("u-abandoned", "a-before-fork", "DO_NOT_TRANSPORT_ABANDONED_USER"),
    assistant("a-abandoned", "u-abandoned", "stop", "DO_NOT_TRANSPORT_ABANDONED_ASSISTANT"),
    user("u-active", "a-before-fork", "Active branch owner evidence."),
    assistant("a-active", "u-active", "stop", "Active branch stop evidence."),
  ];
}

function oracle(records, source = "independent fixture") {
  const parsed = parseNativeSession(jsonl(records), source);
  const branch = resolveActiveBranch(parsed, source);
  return {
    parsed,
    branch,
    selection: selectRarebits(branch),
  };
}

function occurrenceIds(result, { delta = false } = {}) {
  const occurrences = delta
    ? (result?.occurrences ?? [])
    : (result?.projection?.occurrences ?? result?.projection?.selection?.occurrences ?? []);
  return occurrences.map((occurrence) => occurrence.sourceEntryId);
}

function deepSession(depth = 6_000, id = `${SESSION_ID}-deep`) {
  assert.ok(depth >= 2);
  const records = [header(id)];
  let parentId = null;
  for (let index = 0; index < depth; index += 1) {
    const entryId = `deep-${index.toString().padStart(5, "0")}`;
    let entry;
    if (index === 0) entry = user(entryId, parentId, "Deep-chain owner evidence.", "owner");
    else if (index === depth - 1)
      entry = assistant(entryId, parentId, "stop", "Deep-chain stop evidence.");
    else entry = toolResult(entryId, parentId, "SANITIZED_MACHINE_TRAFFIC");
    records.push(entry);
    parentId = entryId;
  }
  return records;
}

function createSessionFile(records) {
  const root = mkdtempSync(join(tmpdir(), "live-detail-independent-"));
  const project = join(root, "project");
  mkdirSync(project);
  const path = join(project, "session.jsonl");
  writeFileSync(path, jsonl(records));
  return { root, path };
}

function writeSession(path, id, text = id) {
  writeFileSync(path, jsonl([header(id), user(`u-${id}`, null, text)]));
}

async function startServer(t, records, options = {}) {
  const { root, path } = createSessionFile(records);
  const cacheRoot = mkdtempSync(join(tmpdir(), "live-detail-independent-cache-"));
  let exportCalls = 0;
  let notify;
  const server = createLiveDetailServer({
    sessionsRoot: root,
    cacheRoot,
    exporter: async (_source, output) => {
      exportCalls += 1;
      writeFileSync(output, "<!doctype html><title>Native export sentinel</title>");
    },
    watchSources: (callback) => {
      notify = callback;
      return { close() {} };
    },
    ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    if (server.listening) server.close();
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    exportCalls: () => exportCalls,
    notify: (...args) => notify?.(...args),
    path,
    root,
  };
}

test("default Live Detail transport is exactly the shared-core active-branch Rarebit projection", async (t) => {
  const records = branchFixture();
  const expected = oracle(records).selection.occurrences;
  assert.deepEqual(
    expected.map(({ sourceEntryId, role, outcome }) => ({ sourceEntryId, role, outcome })),
    [
      { sourceEntryId: "u-root", role: "user", outcome: "user" },
      { sourceEntryId: "a-continuation", role: "assistant", outcome: "continuation" },
      { sourceEntryId: "a-before-fork", role: "assistant", outcome: "stop" },
      { sourceEntryId: "u-active", role: "user", outcome: "user" },
      { sourceEntryId: "a-active", role: "assistant", outcome: "stop" },
    ],
  );

  const live = await startServer(t, records);
  const response = await fetch(`${live.base}/session/${SESSION_ID}`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.equal(live.exportCalls(), 0, "the default request must not invoke Pi export");
  for (const occurrence of expected) assert.match(html, new RegExp(occurrence.text));
  for (const secret of [
    "DO_NOT_TRANSPORT_TOOL_RESULT",
    "DO_NOT_PROMOTE_ERROR",
    "DO_NOT_TRANSPORT_ABANDONED_USER",
    "DO_NOT_TRANSPORT_ABANDONED_ASSISTANT",
  ])
    assert.doesNotMatch(html, new RegExp(secret));
  assert.doesNotMatch(html, /<iframe[^>]+src=["']\/render\//i);
});

test("targeted SessionRegistry append and replacement leave unrelated headers unopened", () => {
  const root = mkdtempSync(join(tmpdir(), "live-detail-registry-targeted-"));
  const alphaPath = join(root, "alpha.jsonl");
  const betaPath = join(root, "beta.jsonl");
  writeSession(alphaPath, "session-alpha");
  writeSession(betaPath, "session-beta");
  const registry = new SessionRegistry({ sessionsRoot: root }).refresh();
  assert.equal(registry.byId.get("session-alpha"), alphaPath);
  assert.equal(registry.byId.get("session-beta"), betaPath);

  // Mutate Beta without reporting its path. If Alpha's exact-path refresh
  // reopens unrelated headers, this unreported identity would appear.
  writeSession(betaPath, "session-beta-unreported");
  appendFileSync(
    alphaPath,
    `${JSON.stringify(assistant("a-alpha", "u-session-alpha", "stop", "Alpha append."))}\n`,
  );
  registry.refreshPaths([alphaPath]);
  assert.deepEqual(registry.lastRefresh, { mode: "targeted", paths: [alphaPath] });
  assert.equal(registry.byId.get("session-alpha"), alphaPath);
  assert.equal(registry.byId.get("session-beta"), betaPath);
  assert.equal(registry.byId.has("session-beta-unreported"), false);

  const replacementPath = `${alphaPath}.replacement`;
  writeSession(replacementPath, "session-alpha-replaced");
  renameSync(replacementPath, alphaPath);
  registry.refreshPaths([alphaPath]);
  assert.equal(registry.byId.has("session-alpha"), false);
  assert.equal(registry.byId.get("session-alpha-replaced"), alphaPath);
  assert.equal(registry.byId.get("session-beta"), betaPath);
  assert.equal(registry.byId.has("session-beta-unreported"), false);
});

test("targeted SessionRegistry deletion invalidates the old ID and a new file registers", () => {
  const root = mkdtempSync(join(tmpdir(), "live-detail-registry-lifecycle-"));
  const removedPath = join(root, "removed.jsonl");
  const retainedPath = join(root, "retained.jsonl");
  writeSession(removedPath, "session-removed");
  writeSession(retainedPath, "session-retained");
  const registry = new SessionRegistry({ sessionsRoot: root }).refresh();

  unlinkSync(removedPath);
  registry.refreshPaths([removedPath]);
  assert.deepEqual(registry.lastRefresh, { mode: "targeted", paths: [removedPath] });
  assert.equal(registry.byId.has("session-removed"), false);
  assert.equal(registry.byId.get("session-retained"), retainedPath);

  const addedPath = join(root, "added.jsonl");
  writeSession(addedPath, "session-added");
  registry.refreshPaths([addedPath]);
  assert.deepEqual(registry.lastRefresh, { mode: "targeted", paths: [addedPath] });
  assert.equal(registry.byId.get("session-added"), addedPath);
  assert.equal(registry.byId.get("session-retained"), retainedPath);
});

test("ambiguous SessionRegistry events fall back to a complete reconciliation", () => {
  const root = mkdtempSync(join(tmpdir(), "live-detail-registry-full-"));
  const alphaPath = join(root, "alpha.jsonl");
  const betaPath = join(root, "beta.jsonl");
  writeSession(alphaPath, "session-alpha");
  writeSession(betaPath, "session-beta");
  const registry = new SessionRegistry({ sessionsRoot: root }).refresh();

  writeSession(betaPath, "session-beta-reconciled");
  registry.refreshPaths([]);
  assert.equal(registry.lastRefresh.mode, "full");
  assert.deepEqual(new Set(registry.lastRefresh.paths), new Set([alphaPath, betaPath]));
  assert.equal(registry.byId.has("session-beta"), false);
  assert.equal(registry.byId.get("session-beta-reconciled"), betaPath);

  writeSession(betaPath, "session-beta-root-event");
  registry.refreshPaths([root]);
  assert.equal(registry.lastRefresh.mode, "full");
  assert.equal(registry.byId.has("session-beta-reconciled"), false);
  assert.equal(registry.byId.get("session-beta-root-event"), betaPath);

  const nonJsonl = join(root, "watcher-marker.tmp");
  writeFileSync(nonJsonl, "marker");
  registry.refreshPaths([nonJsonl]);
  assert.equal(registry.lastRefresh.mode, "full");
});

test("native export is lazy and begins only at the explicit native route", async (t) => {
  const live = await startServer(t, branchFixture());
  await fetch(`${live.base}/session/${SESSION_ID}`);
  assert.equal(live.exportCalls(), 0);

  const response = await fetch(`${live.base}/render/${SESSION_ID}`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Native export sentinel/);
  assert.equal(live.exportCalls(), 1);
});

test("incremental reader carries a partial tail and never rereads its committed prefix", () => {
  const records = [
    header(),
    user("u-partial", null, "Complete prefix evidence."),
    assistant("a-partial", "u-partial", "toolUse", "Completed after the append."),
  ];
  const completePrefix = `${JSON.stringify(records[0])}\n${JSON.stringify(records[1])}\n`;
  const finalLine = `${JSON.stringify(records[2])}\n`;
  const split = Math.floor(finalLine.length / 2);
  const { path } = createSessionFile([]);
  writeFileSync(path, completePrefix + finalLine.slice(0, split));
  const firstSize = Buffer.byteLength(completePrefix + finalLine.slice(0, split));

  const reader = createIncrementalRarebitReader(path);
  const first = reader.refresh();
  assert.deepEqual(occurrenceIds(first), ["u-partial"]);
  assert.equal(first.io.startOffset, 0);
  assert.equal(first.io.contentBytesRead, firstSize);

  appendFileSync(path, finalLine.slice(split));
  const second = reader.refresh();
  assert.equal(second.kind, "append");
  assert.deepEqual(occurrenceIds(second, { delta: true }), ["a-partial"]);
  assert.equal(second.io.startOffset, firstSize);
  assert.equal(second.io.contentBytesRead, Buffer.byteLength(finalLine.slice(split)));
});

test("appended bytes may reset the active branch without rereading the source prefix", () => {
  const prefix = branchFixture().slice(0, -2);
  const { path } = createSessionFile(prefix);
  const reader = createIncrementalRarebitReader(path);
  const first = reader.refresh();
  const firstSize = Buffer.byteLength(jsonl(prefix));
  assert.deepEqual(occurrenceIds(first), [
    "u-root",
    "a-continuation",
    "a-before-fork",
    "u-abandoned",
    "a-abandoned",
  ]);

  const activeSuffix = branchFixture().slice(-2);
  appendFileSync(path, jsonl(activeSuffix));
  const second = reader.refresh();
  assert.equal(second.kind, "reset");
  assert.equal(second.io.startOffset, firstSize);
  assert.deepEqual(occurrenceIds(second), [
    "u-root",
    "a-continuation",
    "a-before-fork",
    "u-active",
    "a-active",
  ]);
});

test("truncate and same-size atomic replacement rebuild from byte zero", () => {
  const initial = [
    header(),
    user("u-alpha", null, "ALPHA"),
    assistant("a-alpha", "u-alpha", "stop", "OMEGA"),
  ];
  const truncated = [header(), user("u-short", null, "SHORT")];
  const { path } = createSessionFile(initial);
  const reader = createIncrementalRarebitReader(path);
  reader.refresh();

  writeFileSync(path, jsonl(truncated));
  const afterTruncate = reader.refresh();
  assert.equal(afterTruncate.kind, "reset");
  assert.equal(afterTruncate.io.startOffset, 0);
  assert.deepEqual(occurrenceIds(afterTruncate), ["u-short"]);

  const replacement = [header(), user("u-shore", null, "SHORE")];
  assert.equal(Buffer.byteLength(jsonl(replacement)), Buffer.byteLength(jsonl(truncated)));
  const replacementPath = `${path}.replacement`;
  writeFileSync(replacementPath, jsonl(replacement));
  renameSync(replacementPath, path);

  const afterReplacement = reader.refresh();
  assert.equal(afterReplacement.kind, "reset");
  assert.equal(afterReplacement.io.startOffset, 0);
  assert.deepEqual(occurrenceIds(afterReplacement), ["u-shore"]);
});

test(
  "same-path replacement with a different Session ID invalidates old SSE identity",
  { timeout: 2_000 },
  async (t) => {
    const live = await startServer(t, [header(), user("u-old", null, "Old identity evidence.")]);
    await fetch(`${live.base}/session/${SESSION_ID}`);
    const controller = new AbortController();
    t.after(() => controller.abort());
    const events = await fetch(`${live.base}/api/events/${SESSION_ID}`, {
      signal: controller.signal,
    });
    const stream = events.body.getReader();
    await stream.read();

    const newId = `${SESSION_ID}-replacement`;
    const replacement = [header(newId), user("u-new", null, "New identity evidence.")];
    const replacementPath = `${live.path}.replacement`;
    writeFileSync(replacementPath, jsonl(replacement));
    renameSync(replacementPath, live.path);
    live.notify({ paths: [live.path] });

    const invalidation = new TextDecoder().decode((await stream.read()).value);
    assert.match(invalidation, /"kind":"unavailable"/);
    assert.match(invalidation, /"reason":"exact_session_identity_changed"/);
    assert.doesNotMatch(invalidation, /New identity evidence/);
    assert.equal((await stream.read()).done, true);
    assert.equal((await fetch(`${live.base}/session/${SESSION_ID}`)).status, 404);
    const replacementHtml = await (await fetch(`${live.base}/session/${newId}`)).text();
    assert.match(replacementHtml, /New identity evidence/);
    assert.equal(live.exportCalls(), 0);
  },
);

test(
  "ambiguous root watcher event fully reconciles new and deleted Session identities",
  { timeout: 2_000 },
  async (t) => {
    const live = await startServer(t, [header(), user("u-old", null, "Old root event evidence.")]);
    await fetch(`${live.base}/session/${SESSION_ID}`);
    const controller = new AbortController();
    t.after(() => controller.abort());
    const events = await fetch(`${live.base}/api/events/${SESSION_ID}`, {
      signal: controller.signal,
    });
    const stream = events.body.getReader();
    await stream.read();

    unlinkSync(live.path);
    const newId = `${SESSION_ID}-root-added`;
    const addedPath = join(live.root, "project", "added.jsonl");
    writeSession(addedPath, newId, "New root event evidence.");
    live.notify({ paths: [live.root] });

    const invalidation = new TextDecoder().decode((await stream.read()).value);
    assert.match(invalidation, /"reason":"exact_session_identity_changed"/);
    assert.doesNotMatch(invalidation, /New root event evidence/);
    assert.equal((await stream.read()).done, true);
    assert.equal((await fetch(`${live.base}/session/${SESSION_ID}`)).status, 404);
    const addedHtml = await (await fetch(`${live.base}/session/${newId}`)).text();
    assert.match(addedHtml, /New root event evidence/);
    assert.equal(live.exportCalls(), 0);
  },
);

test("native route explains an unavailable Rarebit source instead of failing the response", async (t) => {
  const live = await startServer(t, [header(), user("u-valid", null, "Valid prefix evidence.")]);
  await fetch(`${live.base}/session/${SESSION_ID}`);
  appendFileSync(live.path, '{"type":"message","id":"broken"\n');
  live.notify({ paths: [live.path] });

  const nativeResponse = await fetch(`${live.base}/render/${SESSION_ID}`);
  const html = await nativeResponse.text();
  assert.equal(nativeResponse.status, 422);
  assert.equal(nativeResponse.headers.get("x-hypercarrier-degraded-reason"), "malformed_jsonl");
  assert.match(html, /malformed_jsonl/);
  assert.match(html, /Rarebit projection is unavailable/i);
  assert.ok(html.trim().length > 100);
  assert.equal(live.exportCalls(), 0);
});

test("an explicit legacy exporter degrades safely on a sanitized 6000-deep Session", async (t) => {
  const records = deepSession();
  const { parsed, branch, selection } = oracle(records, "deep fixture");
  assert.equal(branch.length, 6_000);
  assert.deepEqual(
    selection.occurrences.map((occurrence) => occurrence.sourceEntryId),
    ["deep-00000", "deep-05999"],
  );

  const graph = analyzeSessionParentGraph(parsed.entries, { linear: parsed.linear });
  assert.equal(graph.entryCount, 6_000);
  assert.equal(graph.maxDepth, 6_000);
  const preflight = nativeExportPreflight(graph, { maxDepth: 512 });
  assert.equal(preflight.status, "degraded");
  assert.equal(preflight.reason, "legacy_exporter_depth_compatibility");
  assert.deepEqual(
    {
      entryCount: preflight.entryCount,
      maxDepth: preflight.maxDepth,
      limit: preflight.limit,
    },
    { entryCount: 6_000, maxDepth: 6_000, limit: 512 },
  );
  assert.deepEqual(nativeExportPreflight(graph, { maxDepth: 512, stackSafe: true }), {
    status: "supported",
    reason: null,
    entryCount: 6_000,
    maxDepth: 6_000,
    limit: null,
  });

  const id = records[0].id;
  const live = await startServer(t, records, {
    maxNativeExportDepth: 512,
    exportCommand: process.execPath,
    exporterRevision: "explicit-legacy-test",
    exporterCapability: "legacy-recursive",
  });
  const defaultResponse = await fetch(`${live.base}/session/${encodeURIComponent(id)}`);
  const defaultHtml = await defaultResponse.text();
  assert.equal(defaultResponse.status, 200);
  assert.match(defaultHtml, /Deep-chain owner evidence/);
  assert.match(defaultHtml, /Deep-chain stop evidence/);
  assert.equal(live.exportCalls(), 0);

  const nativeResponse = await fetch(`${live.base}/render/${encodeURIComponent(id)}`);
  const degradedHtml = await nativeResponse.text();
  assert.equal(nativeResponse.status, 422);
  assert.equal(
    nativeResponse.headers.get("x-hypercarrier-degraded-reason"),
    "legacy_exporter_depth_compatibility",
  );
  assert.match(degradedHtml, /legacy_exporter_depth_compatibility/);
  assert.match(degradedHtml, /6,?000/);
  assert.ok(degradedHtml.trim().length > 100, "native failure must be an explicit nonblank UI");
  assert.equal(live.exportCalls(), 0, "known-incompatible depth must not invoke the exporter");
});
