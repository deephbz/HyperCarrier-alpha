import "./bound.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkingSet, workingSetActivity } from "../src/pi/working-set.ts";
import type { Source } from "../src/pi/working-set-types.ts";
import { holdProseIndex } from "./prose-index-hold.ts";

function source(cacheDir: string, file: string, path: string): Source {
	mkdirSync(cacheDir, { recursive: true });
	writeFileSync(file, `${JSON.stringify({ type: "session", id: path, cwd: "/synthetic", timestamp: "2026-01-01T00:00:00Z" })}\n`);
	return { host: "fixture", cacheDir, path, file };
}

test("test-only prose hold is cache-scoped and disposal cannot dispatch held refreshes", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ampi-prose-hold-"));
	const heldSource = source(join(dir, "held-cache"), join(dir, "held.jsonl"), "/synthetic/held.jsonl");
	const otherSource = source(join(dir, "other-cache"), join(dir, "other.jsonl"), "/synthetic/other.jsonl");
	const heldStore = new WorkingSet("fixture", heldSource.cacheDir);
	const otherStore = new WorkingSet("other", otherSource.cacheDir);
	t.after(async () => { await heldStore.close(); await otherStore.close(); rmSync(dir, { recursive: true, force: true }); });
	await Promise.all([heldStore.ready, otherStore.ready]);

	const original = WorkingSet.prototype.refresh;
	const hold = holdProseIndex(heldSource.cacheDir);
	assert.throws(() => holdProseIndex(otherSource.cacheDir), /already installed/);
	const heldRefresh = heldStore.refresh(heldSource);
	await hold.held;
	assert.notEqual(WorkingSet.prototype.refresh, original, "the wrapper remains installed while held");
	assert.ok(await otherStore.refresh(otherSource), "a different cache refreshes normally");
	hold.release();
	assert.ok(await heldRefresh, "release dispatches the real derivation");
	assert.strictEqual(WorkingSet.prototype.refresh, original, "release restores the original method");
	hold.release();
	assert.strictEqual(WorkingSet.prototype.refresh, original, "release is idempotent");

	const stopping = holdProseIndex(heldSource.cacheDir);
	const before = workingSetActivity().ingestions;
	const cancelled = heldStore.refresh(heldSource);
	await stopping.held;
	stopping.dispose();
	await assert.rejects(cancelled, /Prose-index hold disposed/);
	await heldStore.close();
	stopping.release();
	assert.equal(workingSetActivity().ingestions, before, "dispose and late release dispatch no refresh after stop");
	assert.strictEqual(WorkingSet.prototype.refresh, original, "stop restores the original method");
});
