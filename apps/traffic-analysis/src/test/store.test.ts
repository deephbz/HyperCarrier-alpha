import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySourceStore } from "../application/store.js";
test("prepared-source cache evicts least-recent disjoint materializations and rehydrates with cold parity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "traffic-cache-"));
  const files = await Promise.all(
    ["a", "b", "c"].map(async (id) => {
      const file = join(dir, `${id}.jsonl`);
      await writeFile(file, `{"type":"session","id":"${id}"}\n`);
      return file;
    }),
  );
  const store = new InMemorySourceStore();
  for (const file of files) await store.load(file);
  const before = store.snapshotFor([files[2]]);
  store.evict({
    maxEntries: 2,
    idleMs: Number.POSITIVE_INFINITY,
    retain: [files[2]],
  });
  assert.equal(store.cacheMetrics().preparedSources, 2);
  assert.equal(store.cacheMetrics().evictions, 1);
  await store.reconcile(files[0]);
  const cold = new InMemorySourceStore();
  await cold.load(files[0]);
  assert.deepEqual(store.snapshotFor([files[0]]), cold.snapshotFor([files[0]]));
  assert.equal(before.schema_version, "traffic-analysis-v1");
});

test("continuity failure rebuilds and snapshot matches cold replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "traffic-store-"));
  const file = join(dir, "s.jsonl");
  const first =
    '{"type":"session","id":"a"}\n{"timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"x"}}\n';
  await writeFile(file, first);
  const incremental = new InMemorySourceStore();
  await incremental.load(file);
  await writeFile(
    file,
    `${first}{"timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","timestamp":1,"usage":{"inputTokens":1,"outputTokens":2},"content":[]}}\n`,
  );
  await incremental.reconcile(file);
  const cold = new InMemorySourceStore();
  await cold.load(file);
  assert.deepEqual(
    incremental.snapshot().reconciliation,
    cold.snapshot().reconciliation,
  );
  const before = incremental.checkpoint(file)!;
  await writeFile(file, `${first}${first}${first}`);
  await incremental.reconcile(file);
  assert.notEqual(
    incremental.checkpoint(file)!.tail_fingerprint,
    before.tail_fingerprint,
  );
});
