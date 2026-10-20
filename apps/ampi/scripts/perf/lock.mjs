// The perf run lock: one measured window at a time on this machine, across worktrees and Teams. Builds stay parallel.
// The lock is a directory, so a shell takes it with one `mkdir` (see README.md). `owner.json` names the holder.
// A runner refuses to start while the lock is held, unless it asked to wait. Nobody takes or removes a lock whose owner
// pid is alive, or whose owner cannot be read. A dead-pid lock is cleared only after the same owner stays in place for
// the grace period. A holder removes only the lock it owns, on release, on exit, and on SIGINT, SIGTERM, or SIGHUP.
// A cleared lock stays as a tomb named by its inode for TOMB_KEEP_MS, so a second clearer of the same stale lock fails
// its rename onto that tomb and never moves a newer lock. A waiter never writes into the lock: it lists itself in the
// queue directory beside it, so a status read names the holder and the waiters apart.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const PERF_HOME = process.env.AMPI_PERF_HOME ?? join(homedir(), ".cache", "ampi-perf");
export const RUN_LOCK = join(PERF_HOME, "run.lock");
/** A holder may name a child pid and release a little after that child exits; its lock is not stale in that window. */
export const STALE_GRACE_MS = 60_000;
/** A clearer acts within milliseconds of its last look, so a tomb kept this long outlives every clearer that saw it. */
export const TOMB_KEEP_MS = 10 * 60_000;

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

const queueDir = (lock) => `${lock}.wait`;

/** Lists this waiter in the queue until the returned function runs, the process exits, or a signal stops it. */
function joinQueue(lock, label) {
	const file = join(queueDir(lock), `${process.pid}-${randomUUID()}.json`);
	// Handlers first: a signal between the write and the handlers would leave a stale entry.
	const leave = () => rmSync(file, { force: true });
	const detach = releaseOnExit(leave);
	mkdirSync(queueDir(lock), { recursive: true });
	writeFileSync(file, JSON.stringify({ pid: process.pid, label, since: Date.now() }));
	return () => {
		detach();
		leave();
	};
}

/** The holder (undefined when free) and the live waiters, oldest first. Waiters never count as holders. */
export function lockStatus(lock = RUN_LOCK) {
	const seen = observe(lock);
	let names = [];
	try {
		names = readdirSync(queueDir(lock));
	} catch {}
	const waiters = names
		.map((name) => {
			try {
				return JSON.parse(readFileSync(join(queueDir(lock), name), "utf8"));
			} catch {}
		})
		.filter((w) => Number.isInteger(w?.pid) && alive(w.pid))
		.sort((a, b) => a.since - b.since);
	return { holder: seen && { ...seen.owner, dead: seen.dead }, waiters };
}

/** Removes tombs older than TOMB_KEEP_MS. */
function sweepTombs(lock) {
	const prefix = `${basename(lock)}.stale-`;
	for (const name of readdirSync(dirname(lock)).filter((n) => n.startsWith(prefix))) {
		const tomb = join(dirname(lock), name);
		try {
			if (Date.now() - statSync(tomb).mtimeMs > TOMB_KEEP_MS) rmSync(tomb, { recursive: true, force: true });
		} catch {}
	}
}

/**
 * Moves the stale lock `seen` to its tomb. The rename is the only step that acts on the lock path. It fails when the
 * tomb exists, because the tomb holds the stale owner and is not empty: another clearer moved this lock already, and
 * whatever stands at the path now is newer.
 */
async function clearStale(lock, seen, pause) {
	sweepTombs(lock);
	const tomb = `${lock}.stale-${seen.ino}`;
	try {
		renameSync(lock, tomb);
	} catch (error) {
		if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) return;
		throw error;
	}
	await pause?.("after-move");
	const moved = observe(tomb);
	if (moved?.ino === seen.ino && moved.text === seen.text) {
		// The tomb's mtime starts its keep time.
		writeFileSync(join(tomb, "cleared.json"), JSON.stringify({ pid: process.pid, at: Date.now() }));
		return;
	}
	// The stale holder released and a new lock took the path with a reused inode; give it back.
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
 * waits up to `timeoutMs` instead, and `onWait` hears about each holder once. While it waits, it is in the queue.
 * `pause` is a test hook: it is awaited at "before-clear" and "after-move", so a test can force one schedule.
 */
export async function acquireRunLock(label, { lock = RUN_LOCK, wait = false, timeoutMs = 30 * 60_000, graceMs = STALE_GRACE_MS, pollMs = 200, onWait, pause } = {}) {
	mkdirSync(join(lock, ".."), { recursive: true });
	let leaveQueue;
	try {
		return await takeLock(lock, label, { wait, timeoutMs, graceMs, pollMs, onWait, pause }, () => (leaveQueue ??= joinQueue(lock, label)));
	} finally {
		leaveQueue?.();
	}
}

async function takeLock(lock, label, { wait, timeoutMs, graceMs, pollMs, onWait, pause }, queue) {
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
				// An ownerless lock is never cleared by others; remove it before failing, if it is still this one.
				if (observe(lock)?.ino === ino) rmSync(lock, { recursive: true, force: true });
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
			await pause?.("before-clear");
			await clearStale(lock, stale, pause);
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
		queue();
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}
