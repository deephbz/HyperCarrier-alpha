import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { collectSnapshot } from "../server/collector.js";
import {
  DENSE_SESSION_TURNS,
  FIXTURE_NOW,
  SESSION_COUNT,
  generateFixture,
} from "../scripts/generate-fixture.mjs";

function buildFixture() {
  return generateFixture(mkdtempSync(join(tmpdir(), "pi-synthetic-fixture-")));
}

test("synthetic fixture is deterministic, dense, and metadata-only", () => {
  const first = buildFixture();
  const second = buildFixture();
  const readJsonl = (path) => readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    readJsonl(join(first.sessionsRoot, "synthetic-session-01.jsonl")),
    readJsonl(join(second.sessionsRoot, "synthetic-session-01.jsonl")),
  );
  assert.equal(readdirSync(first.sessionsRoot).length, SESSION_COUNT);
  assert.ok(first.submissions >= 200);
  assert.ok(first.totalTokens > 10_000_000);
  const dense = readFileSync(join(first.sessionsRoot, "synthetic-session-01.jsonl"), "utf8");
  assert.equal(dense.match(/"role":"user"/g).length, DENSE_SESSION_TURNS);
  const wire = dense;
  for (const forbidden of ['"content"', '"prompt"', '"args"', '"result"', '"tool"'])
    assert.equal(wire.includes(forbidden), false, forbidden);
});

test("synthetic scale parses within the local performance budget", async () => {
  const fixture = buildFixture();
  const started = performance.now();
  const snapshot = await collectSnapshot({
    sessionFiles: readdirSync(fixture.sessionsRoot).map((file) => join(fixture.sessionsRoot, file)),
    run: () => "",
    processes: [],
    sockets: [],
    now: Date.parse(FIXTURE_NOW),
    alive: () => false,
  });
  const elapsed = performance.now() - started;
  assert.equal(snapshot.sessions.length, SESSION_COUNT);
  assert.ok(snapshot.turns.length >= 200);
  assert.ok(snapshot.requests.reduce((sum, request) => sum + request.totalTokens, 0) > 10_000_000);
  assert.ok(elapsed < 2_000, `fixture collection took ${elapsed.toFixed(1)}ms`);
});
