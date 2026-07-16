import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTimelineServer } from "../app.js";

test("snapshot API forwards bounded windows and rejects malformed bounds before collection", async (t) => {
  const seen = [];
  const server = createTimelineServer({
    collect: (options) => {
      seen.push(options);
      return {
        generatedAt: "g1",
        sessions: [],
        turns: [],
        requests: [],
        rarebits: [],
        liveAgents: [],
        trace: {},
      };
    },
    reconciliationMs: 60_000,
    watchSources: () => ({ close() {} }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/snapshot`)).status, 200);
  assert.equal(seen.at(-1).window, "24h");
  assert.equal((await fetch(`${base}/api/snapshot?window=all&from=10&to=20`)).status, 200);
  assert.equal(seen.at(-1).window, "all");
  assert.equal(seen.at(-1).from, 10);
  assert.equal(seen.at(-1).to, 20);
  const invalid = await (await fetch(`${base}/api/snapshot?window=24h&from=20&to=10`)).json();
  assert.deepEqual(invalid, { error: "invalid_snapshot_bounds" });
});

test("snapshot, trace, health and filesystem-driven SSE expose one state model", async (t) => {
  let generation = 0;
  let notify;
  let watcherClosed = false;
  const collect = () => ({
    generatedAt: `g${++generation}`,
    sessions: [],
    turns: [],
    requests: [],
    liveAgents: [],
    trace: { rejected: [] },
  });
  const watchSources = (callback) => {
    notify = callback;
    return {
      close: () => {
        watcherClosed = true;
      },
    };
  };
  const server = createTimelineServer({ collect, reconciliationMs: 60_000, watchSources });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    if (server.listening) server.close();
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const snapshot = await (await fetch(`${base}/api/snapshot`)).json();
  assert.equal(snapshot.generatedAt, "g1");
  assert.deepEqual(await (await fetch(`${base}/api/trace`)).json(), {
    rejected: [],
    refresh: { at: "g1", reason: "request", paths: [] },
  });
  assert.equal((await (await fetch(`${base}/api/health`)).json()).ok, true);
  assert.equal((await fetch(`${base}/missing`)).status, 404);

  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, { signal: controller.signal });
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: ready/);
  notify({ reason: "filesystem", paths: ["/tmp/session.jsonl"] });
  const invalidation = new TextDecoder().decode((await reader.read()).value);
  assert.match(invalidation, /event: invalidate/);
  assert.match(invalidation, /g2/);
  const refreshed = await (await fetch(`${base}/api/snapshot`)).json();
  assert.equal(refreshed.trace.refresh.reason, "filesystem");
  assert.deepEqual(refreshed.trace.refresh.paths, ["/tmp/session.jsonl"]);
  controller.abort();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(watcherClosed, true);
});

test("installed server passes fixture roots only to collection and watching", async (t) => {
  let collection;
  let watcherOptions;
  const server = createTimelineServer({
    collectionOptions: { sessionsRoot: "/tmp/session-fixture", teamsRoot: "/tmp/team-fixture" },
    watchRoots: ["/tmp/session-fixture", "/tmp/team-fixture"],
    collect: (options) => {
      collection = options;
      return {
        generatedAt: "g1",
        sessions: [],
        turns: [],
        requests: [],
        liveAgents: [],
        trace: {},
      };
    },
    reconciliationMs: 60_000,
    watchSources: (_callback, options) => {
      watcherOptions = options;
      return { close() {} };
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const body = await (await fetch(`http://127.0.0.1:${server.address().port}/api/snapshot`)).text();
  assert.equal(body.includes("session-fixture"), false);
  assert.equal(body.includes("team-fixture"), false);
  assert.equal(collection.sessionsRoot, "/tmp/session-fixture");
  assert.equal(collection.teamsRoot, "/tmp/team-fixture");
  assert.equal(collection.cache instanceof Object, true);
  assert.deepEqual(watcherOptions, { roots: ["/tmp/session-fixture", "/tmp/team-fixture"] });
});

test("traffic launch config and health diagnostics remain a loopback adapter boundary", async (t) => {
  const traffic = createTimelineServer({
    collect: () => ({
      generatedAt: "g1",
      sessions: [],
      turns: [],
      requests: [],
      liveAgents: [],
      trace: {},
    }),
    reconciliationMs: 60_000,
    watchSources: () => ({ close() {} }),
    trafficBaseUrl: "http://127.0.0.1:4321",
  });
  await new Promise((resolve) => traffic.listen(0, "127.0.0.1", resolve));
  t.after(() => traffic.close());
  const base = `http://127.0.0.1:${traffic.address().port}`;
  assert.deepEqual(await (await fetch(`${base}/api/traffic/config`)).json(), {
    baseUrl: "http://127.0.0.1:4321",
    path: "/traffic",
  });
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), {
    ok: true,
    traffic: { baseUrl: "http://127.0.0.1:4321", health: "http://127.0.0.1:4321/health" },
  });
  assert.deepEqual(await (await fetch(`${base}/api/traffic/health`)).json(), {
    available: false,
    status: null,
    body: null,
  });
});

test("serves built assets and SPA routes without shadowing APIs or allowing traversal", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>Pi Timeline</title>");
  writeFileSync(join(root, "assets", "app.js"), "globalThis.PI_TIMELINE=true");
  const collect = () => ({
    generatedAt: "g1",
    sessions: [],
    turns: [],
    requests: [],
    liveAgents: [],
    trace: {},
  });
  const server = createTimelineServer({
    collect,
    staticDir: root,
    reconciliationMs: 60_000,
    watchSources: () => ({ close() {} }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type"), /text\/html/);
  const asset = await fetch(`${base}/assets/app.js`);
  assert.equal(await asset.text(), "globalThis.PI_TIMELINE=true");
  assert.match(asset.headers.get("cache-control"), /immutable/);
  const spa = await fetch(`${base}/sessions/one`, { headers: { accept: "text/html" } });
  assert.match(await spa.text(), /Pi Timeline/);
  assert.equal(
    (await fetch(`${base}/api/not-real`, { headers: { accept: "text/html" } })).status,
    404,
  );
  assert.equal(
    (await fetch(`${base}/%2e%2e%2fsecret`, { headers: { accept: "text/html" } })).status,
    400,
  );
  const head = await fetch(`${base}/assets/app.js`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("lazy Session summary is resolved server-side and stays outside the metadata snapshot", async (t) => {
  const rawSentinel = "RAW_SESSION_TRANSCRIPT_SENTINEL";
  let requestedSession;
  const collect = () => ({
    generatedAt: "g1",
    sessions: [
      {
        id: "s1",
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: "2026-01-01T00:01:00Z",
        lastMessageAt: "2026-01-01T00:01:00Z",
        cwd: "/repo",
        source: "/native/sessions/cwd/s1.jsonl",
        turnCount: 1,
        requestCount: 1,
        cost: 0,
        totalTokens: 1,
      },
    ],
    turns: [],
    requests: [],
    rarebits: [
      {
        sessionId: "s1",
        sourceEntryId: "u1",
        order: 1,
        role: "user",
        outcome: "user",
        producer: null,
        timestamp: "2026-01-01T00:01:00Z",
      },
    ],
    liveAgents: [],
    trace: {},
  });
  const server = createTimelineServer({
    collect,
    reconciliationMs: 60_000,
    watchSources: () => ({ close() {} }),
    watchAlphaSources: () => ({ close() {} }),
    readRarebitSummary: (session) => {
      requestedSession = session;
      return {
        availability: "available",
        status: "ok",
        summary: "Derived summary.",
        hidden: rawSentinel,
      };
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const snapshot = await (await fetch(`${base}/api/snapshot`)).text();
  assert.equal(snapshot.includes(rawSentinel), false);
  assert.equal(snapshot.includes("Derived summary."), false);
  const detail = await (await fetch(`${base}/api/sessions/s1/rarebit-summary`)).json();
  assert.equal(requestedSession.id, "s1");
  assert.equal(detail.summary, "Derived summary.");
  assert.equal(detail.hidden, undefined);
  assert.equal(JSON.stringify(detail).includes(rawSentinel), false);
  assert.equal((await fetch(`${base}/api/sessions/%2Ftmp%2Fbad/rarebit-summary`)).status, 404);
});

test("Alpha API and SSE are additive and isolated from the legacy metadata snapshot", async (t) => {
  let legacyNotify;
  let alphaNotify;
  let alphaCalls = 0;
  const server = createTimelineServer({
    reconciliationMs: 60_000,
    collect: () => ({
      generatedAt: "legacy-1",
      sessions: [],
      turns: [],
      requests: [],
      liveAgents: [],
      secretSentinel: "legacy-only-secret",
      trace: { rejected: [] },
    }),
    collectAlpha: ({ baseSnapshot }) => {
      alphaCalls += 1;
      return {
        schemaVersion: 1,
        generatedAt: `alpha-${alphaCalls}`,
        projects: [
          {
            projectRef: { id: "p1", name: "Project", provenance: {} },
            runtime: {},
            rarebitSummary: { summary: "safe-derived-summary" },
            intervention: {},
            eventDelta: {},
            evergreenDelta: {},
            workLedger: {},
            delivery: {},
          },
        ],
        trace: { baseGeneratedAt: baseSnapshot.generatedAt },
      };
    },
    watchSources: (callback) => {
      legacyNotify = callback;
      return { close() {} };
    },
    watchAlphaSources: (callback) => {
      alphaNotify = callback;
      return { close() {} };
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const legacy = await (await fetch(`${base}/api/snapshot`)).json();
  assert.equal("secretSentinel" in legacy, true);
  const alpha = await (await fetch(`${base}/api/alpha/snapshot`)).json();
  assert.equal(alpha.projects[0].rarebitSummary.summary, "safe-derived-summary");
  assert.equal("secretSentinel" in alpha, false);
  assert.deepEqual(await (await fetch(`${base}/api/alpha/trace`)).json(), {
    baseGeneratedAt: "legacy-1",
    refresh: { at: "alpha-1", reason: "request", paths: [], sources: [] },
  });

  const controller = new AbortController();
  const response = await fetch(`${base}/api/alpha/events`, { signal: controller.signal });
  const reader = response.body.getReader();
  await reader.read();
  alphaNotify({ reason: "alpha-filesystem", sourceKinds: ["summary"], paths: ["summary.jsonl"] });
  const invalidation = new TextDecoder().decode((await reader.read()).value);
  assert.match(invalidation, /"summary"/);
  assert.match(invalidation, /alpha-2/);
  controller.abort();
  assert.equal(typeof legacyNotify, "function");
});
