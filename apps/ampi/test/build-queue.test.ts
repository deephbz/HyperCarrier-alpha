import "./bound.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type ModelPurpose, resolveHelperModel, useHubConfig } from "../src/hub/helper-models.ts";
import { buildQueue } from "../src/pi/derive-queue.ts";
import type { Chunk } from "../src/pi/views/cos-arc-chunks.ts";
import { buildArc } from "../src/pi/views/cos-arc.ts";
import type { PiViewContext, PiViewSession } from "../src/pi/views/types.ts";
import { HELPER_MODELS } from "./pi-host-fixtures.ts";

useHubConfig(undefined, HELPER_MODELS);

// The verify harness waits for hub-start Builds through /api/health before it counts a step's model calls.
// A Build counts from its start until its finally block settles, whether it ends done or in error.

const T = Date.parse("2026-10-19T00:00:00.000Z");
const chunks: Chunk[] = Array.from({ length: 2 }, (_, i) => ({ id: `c${i}`, index: i, hash: `h${i}`, startAt: new Date(T + i * 60_000).toISOString(), endAt: new Date(T + i * 60_000 + 30_000).toISOString(), firstEntryId: `u${i}`, lastEntryId: `a${i}`, firstAsk: `Step ${i}`, lastOwnerEntryId: `u${i}`, ownerTurns: 1, entries: 2, toolCalls: 0, where: null, idleBeforeMs: null, compactionEntryId: null }));
const session = { threadId: "pi:sess-q", ref: "devbox/pi:sess-q", sourceVersion: "v1",
	summary: { cwd: "/work/demo", live: true, activity: "idle", queued: 0 },
	data: { arc: { chunks, inputChars: 1000, shortenedChunks: 0, excludedEntries: 0 }, rarebit: { count: 4, fingerprint: "f".repeat(64) }, timeline: { stopped: true, marks: [] } },
	rarebits: () => ({ items: [], more: false, sourceVersion: "v1" }),
	arcEvidence: (ids: string[]) => new Map(ids.map((id) => [id, `[u${id.slice(1)}] USER: Run it.\n[a${id.slice(1)}] AGENT: Done.`])),
	entryTimes: (ids: string[]) => new Map(ids.map((id) => [id, T])) } as unknown as PiViewSession;

test("build queue: a running Build is pending until it settles, and an errored Build counts as done", async () => {
	let fail: ((error: Error) => void) | null = null, asked!: () => void;
	const first = new Promise<void>((ok) => { asked = ok; });
	const dir = mkdtempSync(join(tmpdir(), "ampi-build-queue-"));
	const ctx = { host: "devbox", stateDir: () => dir, session: () => session, lease: () => () => {}, invalidate() {}, snapshot: <T>(read: () => T) => read(), model: (p: ModelPurpose, o?: string) => resolveHelperModel(p, o),
		// The first model call waits for the test; once released, every call fails.
		ask: () => fail ? Promise.reject(new Error("model offline")) : (asked(), new Promise((_, no) => { fail = no; })) } satisfies Partial<PiViewContext> as unknown as PiViewContext;
	const { done } = buildQueue();
	buildArc(ctx, session);
	assert.equal(buildQueue().pending, 1, "the Build counts from its start");
	assert.equal(buildQueue().drainedAt, null);
	await first;
	assert.equal(buildQueue().pending, 1, "a Build waiting on the model is still pending");
	const before = Date.now();
	fail!(new Error("model offline"));
	for (let i = 0; i < 200 && buildQueue().pending; i++) await new Promise((r) => setTimeout(r, 5));
	const q = buildQueue();
	assert.equal(q.pending, 0);
	assert.equal(q.done, done + 1, "an errored Build counts as done");
	assert.ok(q.drainedAt !== null && q.drainedAt >= before);
});
