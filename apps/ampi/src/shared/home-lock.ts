// One owner process per AmPi directory and role (`hub` or `node`). The lock is an exclusive SQLite transaction on
// `<role>-owner.sqlite`: the kernel's file lock ends with the process, so a crash or a kill releases it, and nothing
// ever unlinks the lock file, so two starters cannot take two locks. `<role>.pid` names the owner for messages only.
//
// POSIX file locks belong to a process and an inode, and closing any descriptor of that inode drops all of them. Only
// SQLite opens a lock file, because its VFS defers such closes while a lock is held. A process never opens a lock it
// already holds: `held` answers a second call from memory.
import { chmodSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type HomeLock = { release(): void };

// Every lock this process holds, by the real path of its lock file. The map also keeps each database reachable:
// garbage collection closes an unreachable database, and the close drops its lock.
const held = new Map<string, DatabaseSync>();

export function ownerPid(home: string, role: string): number {
	try { return Number(readFileSync(join(home, `${role}.pid`), "utf8").trim()) || 0; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
}

/** Takes the lock, or returns the pid that `<role>.pid` names (0 while the owner has not written it yet). */
export function lockHome(home: string, role: string): HomeLock | { owner: number } {
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const path = join(realpathSync(home), `${role}-owner.sqlite`);
	if (held.has(path)) return { owner: process.pid };
	const database = new DatabaseSync(path);
	try {
		database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
	} catch (error) {
		database.close();
		if ((error as { errcode?: number }).errcode === 5) return { owner: ownerPid(home, role) };
		throw error;
	}
	try {
		chmodSync(path, 0o600);
		writeFileSync(join(home, `${role}.pid`), `${process.pid}\n`, { mode: 0o600 });
	} catch (error) { database.close(); throw error; }
	held.set(path, database);
	let released = false;
	return {
		release() {
			if (released) return;
			released = true;
			try { if (ownerPid(home, role) === process.pid) unlinkSync(join(home, `${role}.pid`)); }
			finally { held.delete(path); database.close(); }
		},
	};
}
