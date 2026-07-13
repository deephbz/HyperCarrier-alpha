import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { collectSnapshot, parseTmuxPanes, readLiveSidecars } from "../server/collector.js";
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
  const wire = [dense, readFileSync(join(first.eventsDir, "synthetic-boot-1.jsonl"), "utf8")].join(
    "\n",
  );
  for (const forbidden of ['"content"', '"prompt"', '"args"', '"result"', '"tool"'])
    assert.equal(wire.includes(forbidden), false, forbidden);
});

test("synthetic lifecycle includes compactions and a live stale blocked team mesh", () => {
  const fixture = buildFixture();
  const events = readFileSync(join(fixture.eventsDir, "synthetic-boot-1.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(events.filter((event) => event.type === "compaction_completed").length, 4);
  const members = events.filter((event) => event.type === "coordination_membership");
  assert.equal(members.length, 6);
  assert.equal(members.filter((event) => event.state === "blocked").length, 1);
  const pane = parseTmuxPanes(
    "$1\tsynthetic\t@1\t0\t%101\t0\t900\t/dev/ttys001\t/work/atlas\tzsh\t0\n",
    "/tmp/tmux-synthetic/main",
  )[0];
  const result = readLiveSidecars({
    dir: fixture.liveDir,
    now: Date.parse(FIXTURE_NOW),
    panes: [pane],
    processes: [
      { pid: 900, ppid: 1, command: "zsh" },
      { pid: 50001, ppid: 900, command: "pi" },
      { pid: 50002, ppid: 900, command: "pi" },
    ],
    alive: () => true,
  });
  assert.equal(result.accepted[0].state, "blocked");
  assert.ok(result.rejected.some((item) => item.reason === "lease_expired"));
});

test("synthetic scale parses within the local performance budget", () => {
  const fixture = buildFixture();
  const started = performance.now();
  const snapshot = collectSnapshot({
    sessionFiles: readdirSync(fixture.sessionsRoot).map((file) => join(fixture.sessionsRoot, file)),
    run: () => "",
    processes: [],
    sockets: [],
    eventsDir: fixture.eventsDir,
    now: Date.parse(FIXTURE_NOW),
    alive: () => false,
  });
  const elapsed = performance.now() - started;
  assert.equal(snapshot.sessions.length, SESSION_COUNT);
  assert.ok(snapshot.turns.length >= 200);
  assert.ok(snapshot.requests.reduce((sum, request) => sum + request.totalTokens, 0) > 10_000_000);
  assert.ok(elapsed < 2_000, `fixture collection took ${elapsed.toFixed(1)}ms`);
});
