import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTpsAdapterServer } from "../tps-adapter.js";

const sessionId = "019f-test-session";
const header = {
  type: "session",
  id: sessionId,
  timestamp: "2026-01-01T00:00:00Z",
  cwd: "/synthetic/project",
};
const importedRarebitMarker = {
  version: "rarebit-fork-entry/1",
  kind: "import",
  sourceSessionId: "source-session",
  sourceEntryId: "source-entry",
  occurrenceId: "source-occurrence",
  role: "assistant",
  outcome: "stop",
  originalTimestamp: "2026-01-01T00:00:00Z",
  ancestry: [],
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "trace-tps-sessions-"));
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
        content: [{ type: "text", text: "synthetic telemetry" }],
      },
    })}\n`,
  );
  return { root, path };
}

async function startServer(t, options) {
  const server = createTpsAdapterServer({
    ...options,
    watchSources: options.watchSources ?? (() => ({ close() {} })),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test("TPS adapter serves a pinned renderer and the selected Session's telemetry", async (t) => {
  const { root } = fixture();
  const staticDir = mkdtempSync(join(tmpdir(), "trace-tps-static-"));
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>TPS</title>");
  const base = await startServer(t, { sessionsRoot: root, staticDir });
  assert.match(await (await fetch(`${base}/?auto=1&session=${sessionId}`)).text(), /TPS/);
  assert.match(
    await (await fetch(`${base}/api/telemetry?session=${sessionId}`)).text(),
    new RegExp(sessionId),
  );
  assert.equal((await fetch(`${base}/api/telemetry?session=missing`)).status, 404);
  assert.ok((await (await fetch(`${base}/api/version?session=${sessionId}`)).json()).version);
});

test("TPS telemetry excludes imported Rarebit rows while retaining fresh rows", async (t) => {
  const { root, path } = fixture();
  appendFileSync(
    path,
    `${JSON.stringify({
      type: "message",
      id: "imported-tps",
      timestamp: "2026-01-01T00:01:00Z",
      rarebitFork: importedRarebitMarker,
      message: {
        role: "assistant",
        stopReason: "stop",
        usage: { input: 900, output: 500, totalTokens: 1_400, cost: { total: 99 } },
        content: [{ type: "text", text: "Imported telemetry" }],
      },
    })}\n`,
  );
  const base = await startServer(t, { sessionsRoot: root, staticDir: undefined });
  const response = await fetch(`${base}/api/telemetry?session=${sessionId}`);
  const body = await response.text();
  assert.equal(response.headers.get("x-hypercarrier-imported-history"), "excluded-from-telemetry");
  assert.match(body, /"id":"a1"/);
  assert.doesNotMatch(body, /imported-tps|Imported telemetry/);
});

test("TPS telemetry ends with an error when the indexed source disappears", async (t) => {
  const { root, path } = fixture();
  const base = await startServer(t, { sessionsRoot: root, staticDir: undefined });
  unlinkSync(path);
  const outcome = await Promise.race([
    fetch(`${base}/api/telemetry?session=${sessionId}`).then(
      async (response) => {
        await response.text();
        return "resolved";
      },
      () => "rejected",
    ),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
  ]);
  assert.equal(outcome, "rejected");
});

test("TPS adapter reports a missing renderer while keeping its telemetry route available", async (t) => {
  const { root } = fixture();
  const base = await startServer(t, { sessionsRoot: root, staticDir: undefined });
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
