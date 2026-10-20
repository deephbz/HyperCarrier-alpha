import "./bound.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
// @ts-ignore: the perf scripts are plain ESM.
import { acquireRunLock } from "../scripts/perf/lock.mjs";

const run = fileURLToPath(new URL("../scripts/verify/run.mjs", import.meta.url));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	test(`journey lock: a journey run cancelled by ${signal} while it queues leaves the queue and the holder's lock`, async (t) => {
		const home = mkdtempSync(join(tmpdir(), "ampi-journey-lock-"));
		const lock = join(home, "journey.lock");
		const release = await acquireRunLock("holder", { lock });
		// The run checks for Playwright's Chromium before it queues; hosted CI installs none. With a channel named, it skips
		// that file check, and it is cancelled while it queues, so it never launches a browser.
		const waiter = spawn(process.execPath, [run, "--only", "T1"], { env: { ...process.env, AMPI_PERF_HOME: home, UX_CHROME_CHANNEL: "chrome" }, stdio: ["ignore", "pipe", "pipe"] });
		t.after(async () => {
			if (waiter.exitCode === null && waiter.signalCode === null) { waiter.kill("SIGKILL"); await once(waiter, "exit"); }
			release();
			rmSync(home, { recursive: true, force: true });
		});
		let said = "";
		waiter.stderr!.on("data", (chunk) => { said += chunk; });
		for await (const chunk of waiter.stdout!) if ((said += chunk).includes("; queued")) break;
		// A run that ends before it queues fails here with its own words, not at the test timeout.
		const ended = () => waiter.exitCode !== null || waiter.signalCode !== null;
		if (!said.includes("; queued")) {
			if (!ended()) await once(waiter, "exit");
			assert.fail(`the run ended before it queued (exit ${waiter.exitCode ?? waiter.signalCode}): ${said}`);
		}
		// The run lists itself in the queue just after it reports the holder, and its signal handlers come first.
		const queue = join(home, "journey.lock.wait");
		while (!existsSync(queue) || !readdirSync(queue).length) {
			assert.ok(!ended(), `the run ended before it joined the queue: ${said}`);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		waiter.kill(signal);
		await once(waiter, "exit");
		assert.deepEqual(readdirSync(queue), [], `queue after ${signal}: ${said}`);
		assert.equal(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).pid, process.pid);
	});
}
