import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Window } from "happy-dom";
import {
  analyzeSessionParentGraph,
  createIncrementalRarebitReader,
  createLiveDetailServer,
  isDefaultLiveEntry,
  nativeExportPreflight,
  resolveNativeExporter,
} from "../live-detail.js";
import { createNamedProxy } from "../local-proxy.js";
import { renderRarebitMarkdown } from "../rarebit-markdown.js";
import { SessionRegistry } from "../session-registry.js";
import { createTpsAdapterServer } from "../tps-adapter.js";
import {
  namedUpstreamsFromEnv,
  resolveCoreHost,
  resolveServicePort,
  resolveTimelineSourceOptions,
  resolveTrafficBaseUrl,
} from "../service-config.js";

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
    PI_TRAFFIC_PORT: "44021",
  };
  assert.equal(resolveServicePort("timeline", env), 44018);
  assert.equal(resolveServicePort("live", env), 44019);
  assert.equal(resolveServicePort("tps", env), 44020);
  assert.equal(resolveServicePort("traffic", env), 44021);
  assert.deepEqual(
    [...namedUpstreamsFromEnv(env)],
    [
      ["pi.localhost", 44018],
      ["live.pi.localhost", 44019],
      ["tps.pi.localhost", 44020],
      ["traffic.pi.localhost", 44021],
    ],
  );
  assert.equal(resolveServicePort("timeline", { PORT: "4390" }), 4390);
  assert.equal(namedUpstreamsFromEnv({ PORT: "44999" }).get("pi.localhost"), 4318);
  const scripts = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ).scripts;
  for (const name of ["start:stack", "start:better-url"])
    for (const variable of [
      "PI_TIMELINE_PORT",
      "PI_LIVE_DETAIL_PORT",
      "PI_TPS_ADAPTER_PORT",
      "PI_TRAFFIC_PORT",
    ])
      assert.match(scripts[name], new RegExp(`${variable}=\\\\?\\$\\{${variable}`));
  assert.doesNotMatch(scripts["start:better-url"], /(?<!_)PORT=43/);
  assert.match(
    scripts["start:better-url"],
    /PI_TRAFFIC_BASE_URL=http:\/\/traffic\.pi\.localhost:1355/,
  );
});

test("installed Timeline accepts trusted process-local fixture roots without publishing them", () => {
  assert.deepEqual(resolveTimelineSourceOptions({}), {});
  assert.deepEqual(
    resolveTimelineSourceOptions({
      PI_TIMELINE_SESSIONS_ROOT: "/tmp/sessions",
      PI_TIMELINE_TEAMS_ROOT: "/tmp/teams",
    }),
    { sessionsRoot: "/tmp/sessions", teamsRoot: "/tmp/teams" },
  );
});

test("traffic origin is independently configured and stays loopback allowlisted", () => {
  assert.equal(resolveTrafficBaseUrl({}), "http://127.0.0.1:4321");
  assert.equal(resolveTrafficBaseUrl({ PI_TRAFFIC_PORT: "44121" }), "http://127.0.0.1:44121");
  assert.equal(
    resolveTrafficBaseUrl({ PI_TRAFFIC_BASE_URL: "http://traffic.pi.localhost:1355" }),
    "http://traffic.pi.localhost:1355",
  );
  assert.throws(() => resolveTrafficBaseUrl({ PI_TRAFFIC_BASE_URL: "https://example.com" }));
  assert.throws(() =>
    resolveTrafficBaseUrl({ PI_TRAFFIC_BASE_URL: "http://127.0.0.1:4321/traffic" }),
  );
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

test("Rarebit Markdown renders readable structure while neutralizing HTML and unsafe links", () => {
  const rendered = renderRarebitMarkdown(
    "## Result\n\n- one\n- two\n\n```js\nconst answer = 42;\n```\n\n[docs](https://example.com)\n\n<script>alert('x')</script>\n\n[bad](javascript:alert(1))\n\n<img src=x onerror=alert(2)>",
  );
  assert.match(rendered, /<h2>Result<\/h2>/);
  assert.match(rendered, /<ul>[\s\S]*<li>one<\/li>/);
  assert.match(rendered, /<pre><code class="language-js">/);
  assert.match(rendered, /href="https:\/\/example\.com"/);
  assert.match(rendered, /rel="noopener noreferrer"/);
  assert.doesNotMatch(rendered, /<script|javascript:|<[^>]*onerror=/i);
  assert.match(rendered, /&lt;script&gt;/);
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

test("Session registry refreshes exact changed JSONL paths and fully reconciles ambiguous events", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-registry-targeted-"));
  const project = join(root, "project");
  mkdirSync(project);
  const first = join(project, "first.jsonl");
  const second = join(project, "second.jsonl");
  writeFileSync(first, `${JSON.stringify({ ...header, id: "registry-first" })}\n`);
  writeFileSync(second, `${JSON.stringify({ ...header, id: "registry-second" })}\n`);
  const registry = new SessionRegistry({ sessionsRoot: root }).refresh();
  assert.equal(registry.lastRefresh.mode, "full");

  writeFileSync(second, "{malformed\n");
  appendFileSync(first, `${JSON.stringify({ type: "custom", id: "append" })}\n`);
  registry.refreshPaths([first]);
  assert.deepEqual(registry.lastRefresh, { mode: "targeted", paths: [first] });
  assert.equal(registry.byId.get("registry-second"), second, "unrelated headers stay unread");

  writeFileSync(first, `${JSON.stringify({ ...header, id: "registry-replaced" })}\n`);
  registry.refreshPaths([first]);
  assert.equal(registry.byId.has("registry-first"), false);
  assert.equal(registry.byId.get("registry-replaced"), first);

  unlinkSync(first);
  registry.refreshPaths([first]);
  assert.equal(registry.byId.has("registry-replaced"), false);
  registry.refreshPaths([project]);
  assert.equal(registry.lastRefresh.mode, "full");
  assert.equal(registry.byId.has("registry-second"), false, "directory events fully reconcile");
});

test("incremental Rarebit reader consumes only appended complete JSONL records", () => {
  const { path } = fixture();
  const reader = createIncrementalRarebitReader(path);
  const initial = reader.refresh();
  assert.equal(initial.kind, "snapshot");
  assert.equal(initial.io.startOffset, 0);
  assert.deepEqual(
    initial.projection.occurrences.map((item) => item.sourceEntryId),
    ["a1"],
  );
  const user = JSON.stringify({
    type: "message",
    id: "u2",
    timestamp: "2026-01-01T00:00:02Z",
    message: { role: "user", content: "private user" },
  });
  appendFileSync(path, user);
  const partial = reader.refresh();
  assert.equal(partial.kind, "append");
  assert.equal(partial.io.startOffset, initial.io.contentBytesRead);
  assert.deepEqual(partial.occurrences, []);
  appendFileSync(path, "\n");
  const completed = reader.refresh();
  assert.deepEqual(
    completed.occurrences.map((item) => item.sourceEntryId),
    ["u2"],
  );
  assert.equal(completed.io.contentBytesRead, 1);
});

test("live-detail default delegates exactly to Rarebit message semantics", () => {
  assert.equal(
    isDefaultLiveEntry({ type: "message", message: { role: "user", content: "owner" } }),
    true,
  );
  for (const stopReason of ["stop", "toolUse"])
    assert.equal(
      isDefaultLiveEntry({
        type: "message",
        message: { role: "assistant", stopReason, content: "agent" },
      }),
      true,
    );
  for (const stopReason of ["error", "aborted", "length"])
    assert.equal(
      isDefaultLiveEntry({
        type: "message",
        message: { role: "assistant", stopReason, content: "exception" },
      }),
      false,
    );
  assert.equal(
    isDefaultLiveEntry({
      type: "message",
      message: { role: "assistant", stopReason: "stop", content: [] },
    }),
    false,
  );
  assert.equal(isDefaultLiveEntry({ type: "message", message: { role: "assistant" } }), false);
  assert.equal(isDefaultLiveEntry({ type: "message", message: { role: "toolResult" } }), false);
  assert.equal(isDefaultLiveEntry({ type: "compaction" }), false);
});

test("native exporter preflight is iterative and identifies only compatibility degradation", () => {
  const entries = [];
  for (let index = 0; index < 6_000; index += 1)
    entries.push({ id: `e${index}`, parentId: index ? `e${index - 1}` : null });
  const graph = analyzeSessionParentGraph(entries);
  assert.deepEqual(graph, { status: "available", entryCount: 6_000, maxDepth: 6_000 });
  assert.deepEqual(nativeExportPreflight({ preflight: graph }, { maxDepth: 2_000 }), {
    status: "degraded",
    reason: "legacy_exporter_depth_compatibility",
    entryCount: 6_000,
    maxDepth: 6_000,
    limit: 2_000,
  });
});

test("native exporter identity is pinned, stack-safe, observable, and rejects empty output", async (t) => {
  assert.throws(
    () => resolveNativeExporter({ env: { PI_LIVE_DETAIL_EXPORTER: process.execPath } }),
    /revision must be nonempty/,
  );
  assert.throws(
    () =>
      resolveNativeExporter({
        env: {
          PI_LIVE_DETAIL_EXPORTER: "pi",
          PI_LIVE_DETAIL_EXPORTER_REVISION: "dev",
          PI_LIVE_DETAIL_EXPORTER_CAPABILITY: "stack-safe",
        },
      }),
    /must be an absolute path/,
  );
  const identity = resolveNativeExporter({
    env: {
      PI_LIVE_DETAIL_EXPORTER: process.execPath,
      PI_LIVE_DETAIL_EXPORTER_REVISION: "pi-core-stack-safe-abc123",
      PI_LIVE_DETAIL_EXPORTER_CAPABILITY: "stack-safe",
    },
  });
  assert.deepEqual(identity, {
    executable: process.execPath,
    revision: "pi-core-stack-safe-abc123",
    capability: "stack-safe",
    identity: `${process.execPath}@pi-core-stack-safe-abc123#stack-safe`,
    provider: { kind: "development-override" },
  });

  const root = mkdtempSync(join(tmpdir(), "pi-stack-safe-exporter-"));
  const project = join(root, "project");
  mkdirSync(project);
  const id = "stack-safe-export";
  writeFileSync(
    join(project, "session.jsonl"),
    `${JSON.stringify({ ...header, version: 2, id })}\n${JSON.stringify({ type: "message", id: "u", parentId: null, message: { role: "user", content: "owner" } })}\n${JSON.stringify({ ...assistant("a", "2026-01-01T00:00:01Z"), parentId: "u" })}\n`,
  );
  const cacheRoot = mkdtempSync(join(tmpdir(), "pi-stack-safe-cache-"));
  let calls = 0;
  const server = createLiveDetailServer({
    sessionsRoot: root,
    cacheRoot,
    exportCommand: identity.executable,
    exporterRevision: identity.revision,
    exporterCapability: identity.capability,
    maxNativeExportDepth: 1,
    exporter: async (_source, output) => {
      calls += 1;
      writeFileSync(output, calls === 1 ? "" : "<!doctype html><title>Stack safe</title>");
    },
    watchSources: () => ({ close() {} }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual((await (await fetch(`${base}/api/health`)).json()).exporter, identity);
  const wrapper = await (await fetch(`${base}/session/${id}`)).text();
  const inlineScript = wrapper.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(inlineScript);
  const window = new Window({ url: `${base}/session/${id}` });
  class FakeEventSource {
    static instance;
    constructor() {
      FakeEventSource.instance = this;
    }
  }
  window.EventSource = FakeEventSource;
  window.document.write(wrapper.replace(/<script>[\s\S]*<\/script>/, ""));
  window.eval(inlineScript);
  t.after(() => window.close());
  const { document } = window;
  assert.equal(
    document.querySelector('[role="group"]')?.getAttribute("aria-label"),
    "Session detail views",
  );
  for (const control of document.querySelectorAll("#rarebit-button,#native-button,#raw-link")) {
    const tooltip = document.getElementById(control.getAttribute("aria-describedby"));
    assert.equal(tooltip?.getAttribute("role"), "tooltip");
    assert.ok(control.textContent.trim().length > 1);
  }
  const style = document.querySelector("style").textContent;
  assert.match(style, /\.tool-wrap:hover>\.tooltip/);
  assert.match(style, /\.tool-wrap:focus-within>\.tooltip/);
  assert.match(style, /html,body\{max-width:100%;overflow-x:hidden\}/);
  assert.match(style, /\.collapse-wrap\{flex:0 0 auto\}/);
  assert.match(style, /\.tooltip\{display:none;/);
  assert.match(
    style,
    /\.tool-wrap:hover>\.tooltip,\.tool-wrap:focus-within>\.tooltip\{display:block\}/,
  );
  assert.match(style, /@media\(max-width:560px\)/);
  assert.match(style, /\.control-group\{flex:1 1 auto;overflow-x:auto;/);
  const collapse = document.querySelector("#collapse-button");
  assert.equal(collapse.parentElement.classList.contains("collapse-wrap"), true);
  assert.equal(collapse.getAttribute("aria-expanded"), "true");
  collapse.click();
  assert.equal(document.querySelector("#toolbar").classList.contains("collapsed"), true);
  assert.equal(collapse.getAttribute("aria-expanded"), "false");

  const jump = document.querySelector('.jump-native[data-entry-id="u"]');
  const jumpUrl = new URL(jump.href);
  assert.equal(jumpUrl.pathname, `/session/${id}`);
  assert.equal(jumpUrl.searchParams.get("view"), "native");
  assert.equal(jumpUrl.searchParams.get("leaf"), "a");
  assert.equal(jumpUrl.searchParams.get("entry"), "u");
  const pinnedWindow = new Window({ url: jump.href });
  pinnedWindow.EventSource = FakeEventSource;
  pinnedWindow.document.write(wrapper.replace(/<script>[\s\S]*<\/script>/, ""));
  pinnedWindow.eval(inlineScript);
  t.after(() => pinnedWindow.close());
  const nativeView = pinnedWindow.document.querySelector("#native-view");
  const pinnedUrl = new URL(nativeView.src);
  assert.equal(pinnedUrl.searchParams.get("leafId"), "a");
  assert.equal(pinnedUrl.searchParams.get("targetId"), "u");
  const pinnedSource = nativeView.src;
  FakeEventSource.instance.onmessage({
    data: JSON.stringify({
      kind: "append",
      version: "new-version",
      occurrences: [],
      activeLeafId: "new-leaf",
      rarebitCount: 2,
      otherEntryCount: 1,
    }),
  });
  assert.equal(nativeView.src, pinnedSource, "pinned source must not move on append");

  assert.equal((await fetch(`${base}/render/${id}`)).status, 500);
  assert.deepEqual(readdirSync(cacheRoot), [], "failed empty temp output must be removed");
  const retried = await fetch(`${base}/render/${id}`);
  assert.equal(retried.status, 200, "stack-safe capability bypasses the legacy depth guard");
  assert.match(await retried.text(), /Stack safe/);
  assert.equal(calls, 2);
  const validPin = await fetch(`${base}/render/${id}?leafId=a&targetId=u`);
  assert.equal(validPin.status, 200);
  const invalidPin = await fetch(`${base}/render/${id}?leafId=u&targetId=a`);
  assert.equal(invalidPin.status, 422);
  assert.equal(
    invalidPin.headers.get("x-hypercarrier-degraded-reason"),
    "target_not_on_leaf_ancestry",
  );
  assert.equal(calls, 2, "invalid pins must not invoke or fall back to the exporter");
});

test("native exports serialize generations and never publish stale in-flight HTML", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-native-export-generation-"));
  const id = "native-export-generation";
  const source = join(root, "session.jsonl");
  writeFileSync(
    source,
    `${JSON.stringify({ ...header, version: 3, id })}\n${JSON.stringify({ type: "message", id: "u", parentId: null, message: { role: "user", content: "owner" } })}\n${JSON.stringify({ ...assistant("a", "2026-01-01T00:00:01Z"), parentId: "u" })}\n`,
  );
  let calls = 0;
  let releaseFirst;
  let signalFirst;
  let signalSecond;
  const firstStarted = new Promise((resolve) => {
    signalFirst = resolve;
  });
  const secondStarted = new Promise((resolve) => {
    signalSecond = resolve;
  });
  const firstMayFinish = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const server = createLiveDetailServer({
    sessionsRoot: root,
    cacheRoot: join(root, "cache"),
    exportCommand: process.execPath,
    exporterRevision: "generation-test",
    exporterCapability: "stack-safe",
    exporter: async (_path, output) => {
      calls += 1;
      if (calls === 1) {
        signalFirst();
        await firstMayFinish;
        writeFileSync(output, "<!doctype html><title>stale generation</title>");
        return;
      }
      signalSecond();
      writeFileSync(output, "<!doctype html><title>fresh generation</title>");
    },
    watchSources: () => ({ close() {} }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const firstResponse = fetch(`${base}/render/${id}`);
  await firstStarted;
  appendFileSync(
    source,
    `${JSON.stringify({ ...assistant("b", "2026-01-01T00:00:02Z"), parentId: "a" })}\n`,
  );
  const secondResponse = fetch(`${base}/render/${id}`);
  const startedBeforeRelease = await Promise.race([
    secondStarted.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 50)),
  ]);
  assert.equal(startedBeforeRelease, false, "different generations must serialize per Session");
  releaseFirst();
  await secondStarted;

  const responses = await Promise.all([firstResponse, secondResponse]);
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200],
  );
  assert.deepEqual(await Promise.all(responses.map((response) => response.text())), [
    "<!doctype html><title>fresh generation</title>",
    "<!doctype html><title>fresh generation</title>",
  ]);
  assert.equal(calls, 2);
});

test("live detail transports Rarebits first and lazily exports the native trace", async (t) => {
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
  assert.match(wrapper, /Load the full native trace/);
  assert.match(wrapper, /Rarebits ·.*other entries not loaded/);
  assert.match(wrapper, /"otherEntryCount":0/);
  assert.match(wrapper, /"sourceEntryId":"a1"/);
  assert.equal(exportCalls, 0, "default Rarebit response must not invoke Pi export");
  assert.match(await (await fetch(`${base}/render/${sessionId}`)).text(), /Rendered/);
  assert.equal(exportCalls, 1);
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events/${sessionId}`, { signal: controller.signal });
  const reader = response.body.getReader();
  await reader.read();
  writeFileSync(
    path,
    `${readFileSync(path, "utf8")}${JSON.stringify(assistant("tool", "2026-01-01T00:00:02Z", "toolUse"))}\n`,
  );
  notify({ paths: [path] });
  const continuation = new TextDecoder().decode((await reader.read()).value);
  assert.match(continuation, /"kind":"append"/);
  assert.match(continuation, /"sourceEntryId":"tool"/);
  assert.equal(exportCalls, 1);
  writeFileSync(
    path,
    `${readFileSync(path, "utf8")}${JSON.stringify(assistant("a2", "2026-01-01T00:00:03Z"))}\n`,
  );
  notify({ paths: [path] });
  const update = new TextDecoder().decode((await reader.read()).value);
  assert.match(update, /data:/);
  assert.match(update, /"sourceEntryId":"a2"/);
  assert.equal(exportCalls, 1, "watch updates must not eagerly regenerate native HTML");
  assert.match(await (await fetch(`${base}/render/${sessionId}`)).text(), /Rendered/);
  assert.equal(exportCalls, 2);
  assert.match(await (await fetch(`${base}/raw/${sessionId}`)).text(), new RegExp(sessionId));
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
