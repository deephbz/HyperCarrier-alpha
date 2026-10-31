// One store owner per home, shared by the daemon and offline restore. The lock is the `node` home lock
// (shared/home-lock.ts): node-owner.sqlite holds it, and node.pid is diagnostic metadata.
import { type HomeLock, lockHome } from "../shared/home-lock.ts";

export class NodeOwnerError extends Error {
	readonly code = "node_owner_busy";
	readonly owner: number;
	constructor(home: string, owner: number) {
		super(`An AmPi node already runs for ${home} (pid ${owner})`);
		this.owner = owner;
	}
}

export function lock(home: string): HomeLock | { owner: number } {
	return lockHome(home, "node");
}
