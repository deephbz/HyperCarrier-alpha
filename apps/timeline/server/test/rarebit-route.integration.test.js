import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { processRarebitSummary } from "../../../../packages/hc-rarebit/src/index.mjs";
import { rarebitMaterializationPath } from "@hypercarrier/hc-rarebit";
import { collectAlphaSnapshot } from "../alpha.js";
import { createTimelineServer } from "../app.js";

const noWatcher = () => ({ close() {} });

test("fake Rarebit model reaches canonical Alpha HTTP and HTML without network", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hc-recent-alpha-http-"));
  const repo = join(root, "repo");
  const privateRoot = join(root, "private");
  const sessionRoot = join(privateRoot, "sessions");
  const sessionFile = join(sessionRoot, "alpha", "alpha-session.jsonl");
  const rarebitRoot = join(privateRoot, "rarebit");
  const summaryPath = rarebitMaterializationPath(sessionFile, { sessionRoot, rarebitRoot });
  const evergreenPath = join(repo, "Evergreen.md");
  const registryPath = join(privateRoot, "project-registry.json");
  const staticDir = join(root, "web");
  await mkdir(repo, { recursive: true });
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  await mkdir(join(sessionRoot, "alpha"), { recursive: true, mode: 0o700 });
  await writeFile(sessionFile, "{}\n", { mode: 0o600 });
  await mkdir(staticDir, { recursive: true });
  await chmod(privateRoot, 0o700);
  await writeFile(evergreenPath, "# Alpha\n\nCanonical owner context.\n");
  await writeFile(
    join(staticDir, "index.html"),
    '<!doctype html><html><body><div id="root">HyperCarrier Alpha</div></body></html>',
  );

  let modelCalls = 0;
  const result = await processRarebitSummary(
    {
      sessionManager: {
        getHeader: () => ({ id: "alpha-session" }),
        getSessionFile: () => sessionFile,
        getBranch: () => [
          {
            type: "message",
            id: "owner",
            message: { role: "user", content: [{ type: "text", text: "Build Alpha." }] },
          },
          ...Array.from({ length: 51 }, (_, index) => ({
            type: "message",
            id: `turn-${index}`,
            message: {
              role: "assistant",
              stopReason: "toolUse",
              content: [
                { type: "text", text: `progress ${index}` },
                { type: "toolCall", id: `call-${index}`, name: "read", arguments: {} },
              ],
            },
          })),
          {
            type: "message",
            id: "assistant-final",
            timestamp: "2026-07-13T04:00:00.000Z",
            message: {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "Implemented the deterministic Alpha path." }],
            },
          },
        ],
      },
    },
    {
      sessionRoot,
      rarebitRoot,
      forceSynthesis: true,
      model: { provider: "fake", id: "deterministic" },
      modelClient: {
        complete: async () => {
          modelCalls += 1;
          return {
            text: JSON.stringify({
              summary:
                "Progress: deterministic path implemented | Findings: registry projection works | Questions/Requests: None stated | Next step: owner test",
              summaryNeedsHumanAttention: true,
            }),
          };
        },
      },
    },
  );
  assert.equal(result.record.status, "ok");
  assert.equal(modelCalls, 1);
  assert.equal((await stat(summaryPath)).mode & 0o777, 0o600);

  await writeFile(
    registryPath,
    JSON.stringify({
      schemaVersion: 1,
      registryVersion: "alpha-http-e2e-v1",
      correctionProvenance: { reason: "deterministic integration fixture" },
      projects: [
        {
          id: "alpha",
          name: "Alpha",
          locations: {
            repos: [repo],
            evergreen: evergreenPath,
            beadsRoot: null,
            summaries: [summaryPath],
            events: null,
            proposalDir: null,
            sourceDocs: [],
          },
          associations: { sessionIds: ["alpha-session"], taskIds: [] },
        },
      ],
    }),
    { mode: 0o600 },
  );

  const server = createTimelineServer({
    collect: () => ({
      generatedAt: "2026-07-13T04:01:00.000Z",
      sessions: [],
      liveAgents: [],
      trace: {},
    }),
    collectAlpha: ({ baseSnapshot }) =>
      collectAlphaSnapshot({
        manifestPath: registryPath,
        baseSnapshot,
        runBd: () => "[]",
        now: Date.parse("2026-07-13T04:01:00.000Z"),
      }),
    staticDir,
    watchSources: noWatcher,
    watchAlphaSources: noWatcher,
    reconciliationMs: 60_000,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const snapshotResponse = await fetch(`${base}/api/alpha/snapshot`);
  assert.equal(snapshotResponse.status, 200);
  const snapshot = await snapshotResponse.json();
  assert.equal(snapshot.trace.registryVersion, "alpha-http-e2e-v1");
  assert.equal(snapshot.projects[0].projectRef.id, "alpha");
  assert.equal(snapshot.projects[0].rarebitSummary.items[0].sessionId, "alpha-session");
  assert.match(snapshot.projects[0].rarebitSummary.items[0].summary, /deterministic path/);
  assert.match(await readFile(summaryPath, "utf8"), /registry projection works/);

  const htmlResponse = await fetch(`${base}/alpha`, {
    headers: { accept: "text/html" },
  });
  assert.equal(htmlResponse.status, 200);
  assert.match(htmlResponse.headers.get("content-type"), /^text\/html/);
  assert.match(await htmlResponse.text(), /HyperCarrier Alpha/);
});
