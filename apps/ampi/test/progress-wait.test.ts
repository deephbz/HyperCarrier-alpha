import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForPhase, waitForProgress } from "./resize-edges-fixture.ts";

test("readiness accepts progress beyond one total-time budget", async () => {
	let now = 0, count = 0;
	const value = await waitForProgress(
		async () => ({ count: count += 400, indexing: false }),
		(state) => `${state?.count}:${state?.indexing}`,
		(state): state is { count: number; indexing: boolean } => !!state && state.count >= 1000,
		{ budgetMs: 50_000, intervalMs: 30_000, now: () => now, sleep: async (ms) => { now += ms; } },
	);
	assert.equal(now, 60_000, "a fixed 50s deadline would fail while progress continues");
	assert.equal(value.count, 1200);
});

test("a later readiness phase gets its own budget after progress extends startup", async () => {
	let now = 0, count = 0, transcriptPolls = 0;
	await waitForProgress(
		async () => ({ count: count += 400, indexing: false }),
		(state) => `${state?.count}:${state?.indexing}`,
		(state): state is { count: number; indexing: boolean } => !!state && state.count >= 1000,
		{ budgetMs: 50_000, intervalMs: 30_000, now: () => now, sleep: async (ms) => { now += ms; } },
	);
	const transcript = await waitForPhase("lead transcript", async () => {
		transcriptPolls++;
		return { ready: true };
	}, { budgetMs: 50_000, now: () => now, sleep: async (ms) => { now += ms; } });
	assert.equal(now, 60_000);
	assert.equal(transcriptPolls, 1, "the transcript phase must poll after feed progress passes 50 seconds");
	assert.equal(transcript.ready, true);
});
