import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createNamedProxy } from "../local-proxy.js";
import { SessionRegistry } from "../session-registry.js";
import {
  namedUpstreamsFromEnv,
  resolveCoreHost,
  resolveServicePort,
  resolveTimelineSourceOptions,
  resolveTrafficBaseUrl,
} from "../service-config.js";
import { createTpsAdapterServer } from "../tps-adapter.js";

const sessionId = "019f-test-session";
const header = { type: "session", id: sessionId, timestamp: "2026-01-01T00:00:00Z", cwd: "/repo" };

function requestLoopback(port, host) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, headers: { host } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-services-"));
  const project = join(root, "project");
  mkdirSync(project);
  const path = join(project, "session.jsonl");
  writeFileSync(
    path,
    `${JSON.stringify(header)}\n${JSON.stringify({
      type: "message",
      id: "a1",
      parentId: null,
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "private" }],
      },
    })}\n`,
  );
  return { root, path };
}

test("named proxy allowlists hosts and preserves streaming responses", async (t) => {
  const upstream = createServer((_req, res) => res.end("healthy"));
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
  assert.deepEqual(await requestLoopback(proxy.address().port, "pi.localhost"), {
    status: 200,
    body: "healthy",
  });
  assert.equal((await requestLoopback(proxy.address().port, "other.localhost")).status, 404);
});

test("service ports isolate the stack from inherited PORT", () => {
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
  assert.equal(resolveCoreHost({ HOST: "attacker.example" }), "127.0.0.1");
});

test("fixture roots and traffic origin remain local-only launch configuration", () => {
  assert.deepEqual(resolveTimelineSourceOptions({}), {});
  assert.deepEqual(
    resolveTimelineSourceOptions({
      PI_TIMELINE_SESSIONS_ROOT: "/tmp/sessions",
      PI_TIMELINE_TEAMS_ROOT: "/tmp/teams",
    }),
    { sessionsRoot: "/tmp/sessions", teamsRoot: "/tmp/teams" },
  );
  assert.equal(resolveTrafficBaseUrl({}), "http://127.0.0.1:4321");
  assert.equal(
    resolveTrafficBaseUrl({ PI_TRAFFIC_BASE_URL: "http://traffic.pi.localhost:1355" }),
    "http://traffic.pi.localhost:1355",
  );
  assert.throws(() => resolveTrafficBaseUrl({ PI_TRAFFIC_BASE_URL: "https://example.com" }));
});

test("Session registry refreshes exact changed paths and reconciles ambiguous events", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-registry-"));
  const project = join(root, "project");
  mkdirSync(project);
  const first = join(project, "first.jsonl");
  const second = join(project, "second.jsonl");
  writeFileSync(first, `${JSON.stringify({ ...header, id: "registry-first" })}\n`);
  writeFileSync(second, `${JSON.stringify({ ...header, id: "registry-second" })}\n`);
  const registry = new SessionRegistry({ sessionsRoot: root }).refresh();
  writeFileSync(first, `${JSON.stringify({ ...header, id: "registry-replaced" })}\n`);
  registry.refreshPaths([first]);
  assert.equal(registry.byId.has("registry-first"), false);
  assert.equal(registry.byId.get("registry-replaced"), first);
  unlinkSync(first);
  registry.refreshPaths([project]);
  assert.equal(registry.byId.has("registry-replaced"), false);
});

test("Session registry refuses duplicate Session headers until one source is removed", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-registry-duplicate-"));
  const firstProject = join(root, "first-project");
  const secondProject = join(root, "second-project");
  mkdirSync(firstProject);
  mkdirSync(secondProject);
  const first = join(firstProject, "first.jsonl");
  const second = join(secondProject, "second.jsonl");
  const id = "registry-duplicate";
  writeFileSync(first, `${JSON.stringify({ ...header, id })}\n`);
  writeFileSync(second, `${JSON.stringify({ ...header, id })}\n`);

  const registry = new SessionRegistry({ sessionsRoot: root }).refresh();
  assert.equal(registry.get(id), undefined);
  assert.deepEqual(registry.resolve(id), { kind: "ambiguous" });

  unlinkSync(second);
  registry.refreshPaths([second]);
  assert.deepEqual(registry.resolve(id), { kind: "resolved", source: first });
});

test("TPS adapter serves the pinned renderer and exact raw Session telemetry", async (t) => {
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
  assert.equal((await fetch(`${base}/api/telemetry?session=missing`)).status, 404);
});

test("TPS adapter reports a degraded renderer without a pinned dist", async (t) => {
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
  assert.equal((await fetch(base)).status, 404);
});

test("TPS dependency record retains source and artifact provenance", () => {
  const contract = JSON.parse(
    readFileSync(new URL("../../integrations/pi-tps-web.json", import.meta.url), "utf8"),
  );
  assert.equal(contract.repository, "https://github.com/monotykamary/pi-tps-web.git");
  assert.equal(contract.revision, "a8c99482f541acf945897b20b67cce6c2f119ee1");
  assert.equal(contract.artifact.entrypoint, "index.html");
});
