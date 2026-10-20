import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveQueue, trackDerive } from "../src/pi/derive-queue.ts";

function deferred() {
	let resolve!: () => void, reject!: (error: Error) => void;
	const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
	return { promise, resolve, reject };
}

test("derive queue: fills, counts failed jobs as done, and stamps the drain only when the last job settles", async () => {
	assert.deepEqual(deriveQueue(), { pending: 0, done: 0, drainedAt: null }, "no drain before the first job");
	const jobs = [deferred(), deferred(), deferred()];
	const running = jobs.map((job) => trackDerive(() => job.promise));
	assert.deepEqual(deriveQueue(), { pending: 3, done: 0, drainedAt: null });

	jobs[0]!.resolve();
	jobs[1]!.reject(new Error("unreadable Session"));
	await Promise.allSettled(running.slice(0, 2));
	assert.deepEqual(deriveQueue(), { pending: 1, done: 2, drainedAt: null }, "a partial drain keeps drainedAt null");

	const before = Date.now();
	jobs[2]!.resolve();
	await running[2];
	const drained = deriveQueue();
	assert.equal(drained.pending, 0);
	assert.equal(drained.done, 3);
	assert.ok(drained.drainedAt !== null && drained.drainedAt >= before, "the drain time is the last settle");

	const late = deferred();
	const again = trackDerive(() => late.promise);
	assert.deepEqual(deriveQueue(), { pending: 1, done: 3, drainedAt: null }, "a new job clears the drain time");
	late.resolve();
	await again;
	assert.equal(deriveQueue().pending, 0);
});

test("derive queue: a job that throws before it returns a promise still settles", async () => {
	const { done } = deriveQueue();
	await assert.rejects(trackDerive(() => { throw new Error("stopped"); }), /stopped/);
	assert.equal(deriveQueue().pending, 0);
	assert.equal(deriveQueue().done, done + 1);
	assert.notEqual(deriveQueue().drainedAt, null);
});
