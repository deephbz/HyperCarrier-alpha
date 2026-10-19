// The perf run lock: one measured window at a time on this machine, across worktrees and Teams. Builds stay parallel.
// The lock is a directory, so a shell takes it with one `mkdir` (see README.md). `owner.json` names the holder.
// A runner refuses to start while the lock is held, unless it asked to wait. Nobody takes or removes a lock whose owner
// pid is alive, or whose owner cannot be read. A dead-pid lock is cleared only after the same owner stays in place for
// the grace period. A holder removes only the lock it owns, on release, on exit, and on SIGINT, SIGTERM, or SIGHUP.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const PERF_HOME = process.env.AMPI_PERF_HOME ?? join(homedir(), ".cache", "ampi-perf");
export const RUN_LOCK = join(PERF_HOME, "run.lock");
/** A holder may name a child pid and release a little after that child exits; its lock is not stale in that window. */
export const STALE_GRACE_MS = 60_000;

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
};

/** The lock as one observation: its directory identity, the raw owner text, and the parsed owner. Undefined when free. */
function observe(lock) {
	let ino;
	try {
		ino = statSync(lock).ino;
	} catch {
		return undefined;
	}
	let text = "";
	try {
		text = readFileSync(join(lock, "owner.json"), "utf8");
	} catch {}
	let owner;
	try {
		owner = JSON.parse(text);
	} catch {}
	const pid = Number.isInteger(owner?.pid) && owner.pid > 0 ? owner.pid : 0;
	return { ino, text, owner: { pid, label: owner?.label ?? "unknown", started: owner?.started ?? 0, token: owner?.token }, dead: pid > 0 && !alive(pid) };
}

/** The current holder, or undefined when the lock is free. A holder with a dead pid still holds until a waiter clears it. */
export function lockHolder(lock = RUN_LOCK) {
	return observe(lock)?.owner;
}

/** Moves a stale lock aside and deletes it, unless the directory changed since it was judged stale. */
function clearStale(lock, seen) {
	const tomb = `${lock}.stale-${process.pid}-${randomUUID()}`;
	try {
		renameSync(lock, tomb);
	} catch (error) {
		if (error.code === "ENOENT") return;
		throw error;
	}
	if (observe(tomb)?.ino === seen.ino && observe(tomb).text === seen.text) {
		rmSync(tomb, { recursive: true, force: true });
		return;
	}
	// Another waiter cleared the stale lock first and a new holder took the path; give its lock back.
	try {
		renameSync(tomb, lock);
	} catch (error) {
		throw new Error(`perf run lock: moved a live lock to ${tomb} and cannot restore it (${error.code}); restore it by hand before any timed run`);
	}
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/** Removes the lock when the process exits or is stopped by a signal, until `release` runs. */
function releaseOnExit(release) {
	const onSignal = (signal) => {
		release();
		process.kill(process.pid, signal);
	};
	const handlers = SIGNALS.map((signal) => [signal, () => onSignal(signal)]);
	for (const [signal, handler] of handlers) process.once(signal, handler);
	process.once("exit", release);
	return () => {
		for (const [signal, handler] of handlers) process.off(signal, handler);
		process.off("exit", release);
	};
}

/**
 * Takes the lock and returns its release function. A live or unreadable owner makes it throw at once; with `wait`, it
 * waits up to `timeoutMs` instead, and `onWait` hears about each holder once.
 */
export async function acquireRunLock(label, { lock = RUN_LOCK, wait = false, timeoutMs = 30 * 60_000, graceMs = STALE_GRACE_MS, pollMs = 200, onWait } = {}) {
	mkdirSync(join(lock, ".."), { recursive: true });
	const deadline = Date.now() + timeoutMs;
	let reported, stale;
	for (;;) {
		try {
			mkdirSync(lock);
			const token = randomUUID();
			const { ino } = statSync(lock);
			try {
				writeFileSync(join(lock, "owner.tmp"), JSON.stringify({ pid: process.pid, label, started: Date.now(), token }));
				renameSync(join(lock, "owner.tmp"), join(lock, "owner.json"));
			} catch (error) {
				// An ownerless lock is never cleared by others; remove it before failing.
				rmSync(lock, { recursive: true, force: true });
				throw new Error(`perf run lock: cannot write its owner: ${error.message}`);
			}
			let released = false, detach = () => {};
			const release = () => {
				if (released) return;
				released = true;
				detach();
				const now = observe(lock);
				if (now?.ino === ino && now.owner.token === token) rmSync(lock, { recursive: true, force: true });
			};
			detach = releaseOnExit(release);
			return release;
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
		}
		const seen = observe(lock);
		if (!seen) continue;
		// The grace clock restarts whenever the directory or its owner text changes.
		if (!seen.dead) stale = undefined;
		else if (stale?.ino !== seen.ino || stale.text !== seen.text) stale = { ...seen, since: Date.now() };
		else if (Date.now() - stale.since >= graceMs) {
			clearStale(lock, stale);
			stale = undefined;
			continue;
		}
		// Without `wait`, only a dead-pid owner is watched, for at most the grace period, as it may be stale.
		if (!wait && !seen.dead) throw new Error(`perf run lock is held by ${seen.owner.label} (pid ${seen.owner.pid}): ${lock}. Run again when it is free, or pass --wait to queue.`);
		if (reported !== seen.text) {
			reported = seen.text;
			onWait?.(seen.owner);
		}
		if (Date.now() > deadline) throw new Error(`perf run lock still held by ${seen.owner.label} (pid ${seen.owner.pid}) after ${timeoutMs} ms: ${lock}`);
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}
