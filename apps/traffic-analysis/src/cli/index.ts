#!/usr/bin/env node
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { analyze } from "../domain/analyze.js";
import { preparePiJsonl } from "../adapters/pi/prepare.js";
import { InMemorySourceStore } from "../application/store.js";

const args = process.argv.slice(2);
if (args[0] === "open") {
  const teams = args
    .flatMap((value, index) => (value === "--team" ? [args[index + 1]] : []))
    .filter((value): value is string => Boolean(value));
  const agents = args
    .flatMap((value, index) => (value === "--agent" ? [args[index + 1]] : []))
    .filter((value): value is string => Boolean(value));
  const safeTeam = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const sessionUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    (teams.length === 1 && agents.length === 0 && safeTeam.test(teams[0])) ||
    (teams.length === 0 &&
      agents.length > 0 &&
      agents.every((agent) => sessionUuid.test(agent)))
  ) {
    const query = teams.length
      ? `team=${encodeURIComponent(`piteams:${teams[0]}`)}`
      : agents
          .map((agent) => `agent=${encodeURIComponent(`pi-session:${agent}`)}`)
          .join("&");
    const origin =
      process.env.TRAFFIC_ANALYSIS_ORIGIN ??
      `http://127.0.0.1:${process.env.PI_TRAFFIC_PORT ?? 4321}`;
    process.stdout.write(`${origin}/traffic?${query}\n`);
    process.exit(0);
  }
  console.error(
    "Usage: traffic-analysis open --team <team-ref> | --agent <session-uuid> [--agent <session-uuid> ...]",
  );
  process.exit(2);
}
const [command, input, output] = args;
if (!input) {
  console.error(
    "Usage: traffic-analysis <prepare|analyze|benchmark> <session.jsonl> [output.json]",
  );
  process.exit(2);
}
if (command === "benchmark") {
  const bytes = await readFile(input, "utf8");
  const dir = await mkdtemp(join(tmpdir(), "traffic-analysis-benchmark-"));
  const fixture = join(dir, "append.jsonl");
  await writeFile(fixture, bytes);
  const store = new InMemorySourceStore();
  const coldStart = performance.now();
  await store.load(fixture);
  const coldBuildMs = performance.now() - coldStart;
  const noChangeStart = performance.now();
  await store.reconcile(fixture);
  const noChangeReconcileMs = performance.now() - noChangeStart;
  const appended = `${bytes.endsWith("\n") ? "" : "\n"}{"timestamp":"2099-01-01T00:00:00Z","message":{"role":"user","content":"benchmark append fixture"}}\n`;
  await writeFile(fixture, `${bytes}${appended}`);
  const appendStart = performance.now();
  await store.reconcile(fixture);
  const appendReconcileMs = performance.now() - appendStart;
  const analysisStart = performance.now();
  const envelope = store.snapshot();
  const analysisMs = performance.now() - analysisStart;
  const payloadBytes = Buffer.byteLength(JSON.stringify(envelope));
  const rssBytes = process.memoryUsage().rss;
  const report = {
    schema_version: "traffic-analysis-benchmark-v1",
    selected_sources: [
      { location: input, byte_count: Buffer.byteLength(bytes) },
    ],
    rows: envelope.rows.length,
    cold_build_ms: coldBuildMs,
    no_change_reconcile_ms: noChangeReconcileMs,
    one_file_append_fixture_reconcile_ms: appendReconcileMs,
    analysis_ms: analysisMs,
    api_payload_bytes: payloadBytes,
    rss_bytes: rssBytes,
    incremental_strategy:
      "stat-before-read unchanged skip; changed source cold replay",
    store_metrics: store.metrics,
  };
  await rm(dir, { recursive: true, force: true });
  const json = JSON.stringify(report, null, 2);
  if (output) await writeFile(output, json);
  else process.stdout.write(`${json}\n`);
} else {
  const bytes = await readFile(input, "utf8");
  const prepared = preparePiJsonl(bytes, basename(input));
  const value = command === "prepare" ? prepared : analyze(prepared);
  const json = JSON.stringify(value, null, 2);
  if (output) await writeFile(output, json);
  else process.stdout.write(`${json}\n`);
}
