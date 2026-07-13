import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assistantCompletionSignature, createLiveDetailServer } from "../live-detail.js";
import { createNamedProxy } from "../local-proxy.js";
import { createTpsAdapterServer } from "../tps-adapter.js";

const sessionId = "019f-test-session";
const header = { type: "session", id: sessionId, timestamp: "2026-01-01T00:00:00Z", cwd: "/repo" };
const assistant = (id, timestamp, stopReason = "stop") => ({
  type: "message",
  id,
  timestamp,
  message: { role: "assistant", stopReason, content: [{ type: "text", text: "private" }] },
});

test("named proxy allowlists hosts and preserves streaming responses", async (t) => {
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: ready\ndata: {}\n\n");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const proxy = createNamedProxy({
    upstreams: new Map([["pi.localhost", upstream.address().port]]),
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    proxy.close();
    upstream.close();
  });
  const response = await fetch(`http://pi.localhost:${proxy.address().port}`);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "event: ready\ndata: {}\n\n");
  await reader.cancel();
  assert.equal((await fetch(`http://other.localhost:${proxy.address().port}`)).status, 404);
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-services-"));
  const project = join(root, "project");
  mkdirSync(project);
  const path = join(project, "session.jsonl");
  writeFileSync(
    path,
    `${JSON.stringify(header)}\n${JSON.stringify(assistant("a1", "2026-01-01T00:00:01Z"))}\n`,
  );
  return { root, path };
}

test("assistant completion signature changes only with completed assistant records", () => {
  const { path } = fixture();
  assert.equal(assistantCompletionSignature(path), "a1:2026-01-01T00:00:01Z:stop");
  writeFileSync(
    path,
    `${readFileSync(path, "utf8")}${JSON.stringify({ type: "message", id: "u2", timestamp: "2026-01-01T00:00:02Z", message: { role: "user", content: "private" } })}\n`,
  );
  assert.equal(assistantCompletionSignature(path), "a1:2026-01-01T00:00:01Z:stop");
  writeFileSync(
    path,
    `${readFileSync(path, "utf8")}${JSON.stringify(assistant("tool", "2026-01-01T00:00:03Z", "toolUse"))}\n`,
  );
  assert.equal(assistantCompletionSignature(path), "a1:2026-01-01T00:00:01Z:stop");
});

test("live detail has a stable URL and invalidates after assistant completion", async (t) => {
  const { root, path } = fixture();
  const cacheRoot = mkdtempSync(join(tmpdir(), "pi-live-cache-"));
  let notify;
  let closed = false;
  let exportCalls = 0;
  const server = createLiveDetailServer({
    sessionsRoot: root,
    cacheRoot,
    exporter: async (_source, output) => {
      exportCalls++;
      writeFileSync(output, "<!doctype html><title>Rendered</title>");
    },
    watchSources: (callback) => {
      notify = callback;
      return {
        close: () => {
          closed = true;
        },
      };
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    if (server.listening) server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const wrapper = await (await fetch(`${base}/session/${sessionId}`)).text();
  assert.match(wrapper, /EventSource/);
  assert.match(wrapper, /filter-btn\[data-filter="no-tools"\]/);
  assert.match(wrapper, /appendOnly/);
  assert.match(await (await fetch(`${base}/render/${sessionId}`)).text(), /Rendered/);
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events/${sessionId}`, { signal: controller.signal });
  const reader = response.body.getReader();
  await reader.read();
  writeFileSync(
    path,
    `${readFileSync(path, "utf8")}${JSON.stringify(assistant("tool", "2026-01-01T00:00:02Z", "toolUse"))}\n`,
  );
  notify({ paths: [path] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(exportCalls, 1);
  writeFileSync(
    path,
    `${readFileSync(path, "utf8")}${JSON.stringify(assistant("a2", "2026-01-01T00:00:03Z"))}\n`,
  );
  notify({ paths: [path] });
  const update = new TextDecoder().decode((await reader.read()).value);
  assert.match(update, /data:/);
  assert.equal(exportCalls, 2);
  controller.abort();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(closed, true);
});

test("TPS adapter serves pi-tps-web and session-selected raw JSONL", async (t) => {
  const { root } = fixture();
  const staticDir = mkdtempSync(join(tmpdir(), "pi-tps-static-"));
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>TPS</title>");
  const server = createTpsAdapterServer({
    sessionsRoot: root,
    staticDir,
    watchSources: () => ({ close() {} }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.match(await (await fetch(`${base}/?auto=1&session=${sessionId}`)).text(), /TPS/);
  assert.match(
    await (await fetch(`${base}/api/telemetry?session=${sessionId}`)).text(),
    new RegExp(sessionId),
  );
  assert.match(
    await (
      await fetch(`${base}/api/telemetry`, {
        headers: { referer: `${base}/?auto=1&session=${sessionId}` },
      })
    ).text(),
    new RegExp(sessionId),
  );
  assert.equal((await fetch(`${base}/api/telemetry?session=missing`)).status, 404);
});
