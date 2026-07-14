import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Window } from "happy-dom";
import {
  assistantCompletionSignature,
  createLiveDetailServer,
  createLiveEntryProjection,
  defaultLiveEntryIds,
  isDefaultLiveEntry,
} from "../live-detail.js";
import { createNamedProxy } from "../local-proxy.js";
import { createTpsAdapterServer } from "../tps-adapter.js";
import { namedUpstreamsFromEnv, resolveCoreHost, resolveServicePort } from "../service-config.js";

const sessionId = "019f-test-session";
const header = { type: "session", id: sessionId, timestamp: "2026-01-01T00:00:00Z", cwd: "/repo" };
const assistant = (id, timestamp, stopReason = "stop") => ({
  type: "message",
  id,
  timestamp,
  message: { role: "assistant", stopReason, content: [{ type: "text", text: "private" }] },
});

function requestLoopback(port, host, { firstChunk = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, headers: { host } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => {
        chunks.push(chunk);
        if (firstChunk) {
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
          res.destroy();
        }
      });
      res.on("end", () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
      );
      res.on("error", (error) => {
        if (!firstChunk) reject(error);
      });
    });
    req.on("error", reject);
    req.end();
  });
}

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
  const response = await requestLoopback(proxy.address().port, "pi.localhost", {
    firstChunk: true,
  });
  assert.equal(response.status, 200);
  assert.equal(response.body, "event: ready\ndata: {}\n\n");
  assert.equal((await requestLoopback(proxy.address().port, "other.localhost")).status, 404);
});

test("service ports isolate a combined stack from inherited PORT and keep proxy parity", () => {
  const env = {
    PORT: "44999",
    PI_TIMELINE_PORT: "44018",
    PI_LIVE_DETAIL_PORT: "44019",
    PI_TPS_ADAPTER_PORT: "44020",
  };
  assert.equal(resolveServicePort("timeline", env), 44018);
  assert.equal(resolveServicePort("live", env), 44019);
  assert.equal(resolveServicePort("tps", env), 44020);
  assert.deepEqual(
    [...namedUpstreamsFromEnv(env)],
    [
      ["pi.localhost", 44018],
      ["live.pi.localhost", 44019],
      ["tps.pi.localhost", 44020],
    ],
  );
  assert.equal(resolveServicePort("timeline", { PORT: "4390" }), 4390);
  assert.equal(namedUpstreamsFromEnv({ PORT: "44999" }).get("pi.localhost"), 4318);
  const scripts = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ).scripts;
  for (const name of ["start:stack", "start:better-url"])
    for (const variable of ["PI_TIMELINE_PORT", "PI_LIVE_DETAIL_PORT", "PI_TPS_ADAPTER_PORT"])
      assert.match(scripts[name], new RegExp(`${variable}=\\\\?\\$\\{${variable}`));
  assert.doesNotMatch(scripts["start:better-url"], /PORT=43/);
});

test("TPS renderer dependency contract pins repository, revision, toolchain, and dist entrypoint", () => {
  const contract = JSON.parse(
    readFileSync(new URL("../../integrations/pi-tps-web.json", import.meta.url), "utf8"),
  );
  assert.equal(contract.repository, "https://github.com/monotykamary/pi-tps-web.git");
  assert.equal(contract.revision, "a8c99482f541acf945897b20b67cce6c2f119ee1");
  assert.equal(contract.packageManager, "pnpm@11.6.0");
  assert.deepEqual(contract.artifact, {
    path: "dist",
    entrypoint: "index.html",
    environmentVariable: "PI_TPS_WEB_DIST",
  });
  assert.equal(contract.license.declared, "MIT");
  assert.equal(contract.license.licenseFilePresentAtRevision, false);
});

test("core service binding is fixed to IPv4 loopback and ignores ambient HOST", () => {
  assert.equal(resolveCoreHost({}), "127.0.0.1");
  assert.equal(resolveCoreHost({ HOST: "::1" }), "127.0.0.1");
  assert.equal(resolveCoreHost({ HOST: "0.0.0.0" }), "127.0.0.1");
  assert.equal(resolveCoreHost({ HOST: "attacker.example" }), "127.0.0.1");
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

test("live-detail default projection is user messages plus terminal assistant messages", () => {
  assert.equal(isDefaultLiveEntry({ type: "message", message: { role: "user" } }), true);
  for (const stopReason of ["stop", "error", "aborted", "length"])
    assert.equal(
      isDefaultLiveEntry({ type: "message", message: { role: "assistant", stopReason } }),
      true,
    );
  assert.equal(
    isDefaultLiveEntry({
      type: "message",
      message: { role: "assistant", stopReason: "toolUse" },
    }),
    false,
  );
  assert.equal(isDefaultLiveEntry({ type: "message", message: { role: "assistant" } }), false);
  assert.equal(isDefaultLiveEntry({ type: "message", message: { role: "toolResult" } }), false);
  assert.equal(isDefaultLiveEntry({ type: "compaction" }), false);

  const { path } = fixture();
  writeFileSync(
    path,
    `${readFileSync(path, "utf8")}${JSON.stringify({ type: "message", id: "u2", message: { role: "user" } })}\n${JSON.stringify(assistant("tool", "2026-01-01T00:00:02Z", "toolUse"))}\n{incomplete\n${JSON.stringify(assistant("a2", "2026-01-01T00:00:03Z", "error"))}\n`,
  );
  assert.deepEqual(defaultLiveEntryIds(path), ["a1", "u2", "a2"]);
});

test("live-detail Turns projection survives rerenders and can opt out and return", async () => {
  const window = new Window();
  const { document } = window;
  document.body.innerHTML = `
    <div id="filters">
      <button class="filter-btn active" data-filter="default">Default</button>
      <button class="filter-btn" data-filter="no-tools">No-tools</button>
      <button class="filter-btn" data-filter="all">All</button>
    </div>
    <div id="tree-status"></div>
    <div id="tree-container">
      <div class="tree-node" data-id="u1"></div>
      <div class="tree-node" data-id="tool"></div>
      <div class="tree-node" data-id="a1"></div>
      <div class="tree-node" data-id="compact"></div>
    </div>
    <div id="messages">
      <div id="entry-u1"></div>
      <div id="entry-tool"></div>
      <div id="entry-a1"></div>
      <div id="entry-compact"></div>
    </div>`;
  const projection = createLiveEntryProjection(["u1", "a1"]);
  projection.prepare(document, { controls: true });

  const turns = document.querySelector('[data-filter="hc-default-turns"]');
  assert.equal(turns.textContent, "Turns");
  assert.equal(turns.classList.contains("active"), true);
  assert.deepEqual(
    [...document.querySelectorAll("#messages > *:not(.hc-default-turns-hidden)")].map(
      (node) => node.id,
    ),
    ["entry-u1", "entry-a1"],
  );
  assert.equal(document.querySelector("#tree-status").textContent, "2 / 4 entries");

  document.querySelector("#messages").innerHTML = `
    <div id="entry-u1"></div><div id="entry-tool"></div><div id="entry-a1"></div>`;
  await window.happyDOM.whenAsyncComplete();
  assert.equal(
    document.querySelector("#entry-tool").classList.contains("hc-default-turns-hidden"),
    true,
  );

  document.querySelector('[data-filter="no-tools"]').click();
  assert.equal(document.querySelectorAll(".hc-default-turns-hidden").length, 0);
  document.querySelector("#messages").innerHTML += '<div id="entry-compact"></div>';
  await window.happyDOM.whenAsyncComplete();
  assert.equal(document.querySelectorAll(".hc-default-turns-hidden").length, 0);

  turns.click();
  assert.equal(turns.classList.contains("active"), true);
  assert.deepEqual(
    [...document.querySelectorAll("#messages > *:not(.hc-default-turns-hidden)")].map(
      (node) => node.id,
    ),
    ["entry-u1", "entry-a1"],
  );
  window.close();
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
  assert.match(wrapper, /dataset\.filter = "hc-default-turns"/);
  assert.match(wrapper, /terminal assistant messages/);
  assert.match(wrapper, /}\)\(\["a1"\]\);/);
  assert.doesNotMatch(wrapper, /applyNoTools/);
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
  assert.match(update, /"defaultEntryIds":\["a1","a2"\]/);
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
  assert.equal(
    (await fetch(`${base}/api/telemetry?session=${sessionId}`)).headers.get(
      "access-control-allow-origin",
    ),
    null,
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

test("TPS adapter keeps telemetry healthy and reports a degraded renderer without a pinned dist", async (t) => {
  const { root } = fixture();
  const server = createTpsAdapterServer({
    sessionsRoot: root,
    staticDir: undefined,
    watchSources: () => ({ close() {} }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), {
    ok: true,
    sessions: 1,
    renderer: false,
  });
  assert.equal((await fetch(`${base}/api/telemetry?session=${sessionId}`)).status, 200);
  const renderer = await fetch(base);
  assert.equal(renderer.status, 404);
  assert.match(await renderer.text(), /PI_TPS_WEB_DIST/);
});
