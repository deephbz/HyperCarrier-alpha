// One store owner per home, shared by the daemon and offline restore. Never unlink the lock database:
// the exclusive SQLite transaction owns the inode until release or process death. node.pid is diagnostic metadata.
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

function ownerPid(path: string): number {
	try { return Number(readFileSync(path, "utf8").trim()) || 0; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
}

export class NodeOwnerError extends Error {
	readonly code = "node_owner_busy";
	readonly owner: number;
	constructor(home: string, owner: number) {
		super(`An AmPi node already runs for ${home} (pid ${owner})`);
		this.owner = owner;
	}
}

export function lock(home: string): { release(): void } | { owner: number } {
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const path = join(home, "node-owner.sqlite");
	const pidPath = join(home, "node.pid");
	closeSync(openSync(path, "a", 0o600));
	const database = new DatabaseSync(path);
	try {
		database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
	} catch (error) {
		database.close();
		if ((error as { errcode?: number }).errcode === 5) return { owner: ownerPid(pidPath) };
		throw error;
	}
	try {
		writeFileSync(pidPath, `${process.pid}\n`, { mode: 0o600 });
	} catch (error) { database.close(); throw error; }
	let released = false;
	return {
		release() {
			if (released) return;
			released = true;
			try { if (ownerPid(pidPath) === process.pid) unlinkSync(pidPath); }
			finally { database.close(); }
		},
	};
}
