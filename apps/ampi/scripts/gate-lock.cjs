// Serialize heavy AmPi gates and named test lanes across worktrees. Focused tests stay independent.
require("./stdio-sync.cjs");
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

exports.acquireGateLock = async function acquireGateLock(label) {
	const rawTimeout = process.env.AMPI_GATE_LOCK_TIMEOUT_MIN ?? "45";
	const minutes = Number(rawTimeout);
	if (!rawTimeout.trim() || !Number.isFinite(minutes) || minutes < 0 || !Number.isFinite(minutes * 60_000)) {
		console.error("gate lock: usage error: AMPI_GATE_LOCK_TIMEOUT_MIN must be a finite non-negative number of minutes (0 waits forever)");
		process.exit(2);
	}
	const timeoutMs = minutes === 0 ? Infinity : minutes * 60_000;
	const { acquireRunLock, PERF_HOME, lockHolder } = await import("./perf/lock.mjs");
	const lock = join(PERF_HOME, "gate.lock");
	const started = Date.now();
	let queued = false, timer;
	const report = (owner) => console.log(`gate lock held by ${owner?.label ?? "unknown"} (pid ${owner?.pid ?? 0}); queued ${((Date.now() - started) / 1000).toFixed(1)} s`);
	try {
		const release = await acquireRunLock(label, {
			lock, wait: true, timeoutMs,
			onWait(owner) {
				if (!queued) console.log("gate lock: focused file runs (npm test -- <file>) do not queue");
				queued = true;
				report(owner);
				timer ??= setInterval(() => report(lockHolder(lock)), 10_000);
			},
		});
		const gateQueueMs = queued ? Date.now() - started : 0;
		if (queued) console.log(`gate lock: waited ${(gateQueueMs / 1000).toFixed(1)} s`);
		return { release, gateQueueMs };
	} catch (error) {
		if (!error.message.startsWith("perf run lock still held by ")) throw error;
		const owner = lockHolder(lock);
		const pid = owner?.pid ?? 0;
		let command = "no process";
		if (pid > 0) {
			try {
				command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim().replace(/\s+/g, " ") || "no process";
			} catch {}
		}
		const age = owner?.started > 0 ? `${((Date.now() - owner.started) / 1000).toFixed(1)} s` : "unknown";
		console.error(`gate lock: timeout after ${minutes} min; holder pid ${pid}; command: ${command}; lock age: ${age}; recovery: read ${join(lock, "owner.json")}, then remove the gate.lock directory if the holder is dead or pid 0 for more than a minute`);
		process.exit(1);
	} finally {
		clearInterval(timer);
	}
};
