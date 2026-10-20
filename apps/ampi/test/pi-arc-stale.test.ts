import "./bound.ts";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkingSet } from "../src/pi/working-set.ts";
import type { Source } from "../src/pi/working-set-types.ts";
import { arcHead } from "../src/pi/views/cos-arc.ts";

const line = (o: unknown) => JSON.stringify(o) + "\n";
const msg = (id: string, parentId: string | null, text: string, role = "user") => ({ type: "message", id, parentId, timestamp: new Date(1_770_000_000_000 + Number(id.replace(/\D/g, "")) * 1000).toISOString(), message: { role, content: [{ type: "text", text }], ...(role === "assistant" ? { stopReason: "stop", usage: { input: 20, output: 10, cost: { total: 0.1 } } } : {}) } });

test("arc stale: a bare compaction after the Build marks the Arc stale (failure: compaction did not raise the stale count)", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ampi-arc-stale-"));
	const source: Source = { host: "fixture", cacheDir: join(dir, "cache"), path: "/synthetic/session.jsonl", file: join(dir, "copy.jsonl") };
	mkdirSync(source.cacheDir);
	writeFileSync(source.file, line({ type: "session", id: "fixture-session", cwd: "/synthetic", timestamp: "2026-01-01T00:00:00Z" }) + line(msg("e1", null, "Fix the parser.")) + line(msg("e2", "e1", "Fixed the parser.", "assistant")));
	const store = new WorkingSet(source.host, source.cacheDir);
	t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
	const built = (await store.refresh(source))!;
	const head = { v: 2 as const, at: "2026-01-01T00:00:00Z", n: built.rarebit.count, fp: built.rarebit.fingerprint.slice(0, 16), open: [0, 0, 0, 0] };
	assert.equal(arcHead({ data: built } as any, head).newMessages, 0);
	appendFileSync(source.file, line({ type: "compaction", id: "e3", parentId: "e2", timestamp: new Date(1_770_000_003_000).toISOString(), summary: "Parser fixed.", firstKeptEntryId: "e2", tokensBefore: 1000 }));
	const after = (await store.refresh(source))!;
	assert.equal(after.rarebit.count, built.rarebit.count + 1);
	assert.notEqual(after.rarebit.fingerprint, built.rarebit.fingerprint);
	assert.equal(arcHead({ data: after } as any, head).newMessages, 1);
});
