// The hub's home: the AmPi home directory that one hub process owns. The hub's own state lives here: the access key,
// pins, the port record, and by default the Pi copies under pi-cache. hub.json and a Pi Host's `cacheDir` can live in
// other directories, so every directory a hub writes is a root, and the hub locks each root (shared/home-lock.ts) at
// that exact directory before it reads it, even when the root lies inside its home: another hub can name that
// directory too. `HubHome.acquire` locks the home, the default pi-cache and the hub.json directory and is the only way
// to get a HubHome; `claim` locks any other root; every hub state writer takes a HubHome. So a second hub that shares
// any root cannot read or write it: it gets that root's owner instead.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type HomeLock, lockHome, ownerPid } from "../shared/home-lock.ts";

export function ampiHome(): string {
	return process.env.AMPI_HOME ?? join(homedir(), ".ampi");
}

/**
 * The hub that owns a root: its pid, the root, and for a home the port it last recorded (absent before its first
 * listen).
 */
export type HubOwner = { pid: number; dir: string; port?: number; /** Set when the root is not the home. */ use?: string };

/** Thrown when another hub owns a root this hub needs; the message names the owner and the root's use. */
export class RootOwned extends Error {
	readonly owner: HubOwner;
	constructor(owner: HubOwner, use: string) {
		super(`Another AmPi hub (${owner.pid ? `pid ${owner.pid}` : "starting"}) writes ${owner.dir}, which this hub needs for ${use}. Stop that hub, or give this hub its own directory.`);
		this.owner = owner;
	}
}

const KEY = /^[0-9a-f]{64}$/;

export class HubHome {
	readonly dir: string;
	/** Locks by the real path of their root. The home is one of them. */
	#locks: Map<string, HomeLock>;

	private constructor(dir: string, locks: Map<string, HomeLock>) {
		this.dir = dir;
		this.#locks = locks;
	}

	/**
	 * The home, or the hub that owns the home, its default pi-cache, or the hub.json directory. Roots lock in sorted
	 * order, so two hubs that share several roots refuse each other on the same one.
	 */
	static acquire(dir = ampiHome(), configPath?: string): HubHome | HubOwner {
		// Each root's use, for a refusal; the home itself needs none. A later set wins when roots coincide, so the home
		// and its pi-cache, which must lock, override an unwritable hub.json directory, which needs no lock.
		const uses = new Map<string, string | undefined>();
		const optional = new Set<string>();
		const config = configPath ? writableRoot(dirname(configPath)) : undefined;
		if (config) { uses.set(config, `its hub.json (${configPath})`); optional.add(config); }
		for (const [root, use] of [[realRoot(join(dir, "pi-cache")), "its Pi copies"], [realRoot(dir), undefined]] as const) { uses.set(root, use); optional.delete(root); }
		const locks = new Map<string, HomeLock>();
		for (const root of [...uses.keys()].sort()) {
			const use = uses.get(root);
			const lock = optional.has(root) ? lockOptional(root) : lockHome(root, "hub");
			if (!lock) continue;
			if ("owner" in lock) {
				for (const held of locks.values()) held.release();
				return use ? { pid: lock.owner, dir: root, use } : { pid: lock.owner, dir, ...recordedPort(root) };
			}
			locks.set(root, lock);
		}
		return new HubHome(dir, locks);
	}

	/** Locks another directory this hub writes, and returns it; throws RootOwned when another hub owns it. */
	claim(root: string, use: string): string {
		const real = writableRoot(root);
		if (!real || this.#locks.has(real)) return root;
		const lock = lockOptional(real);
		if (lock && "owner" in lock) throw new RootOwned({ pid: lock.owner, dir: real }, use);
		if (lock) this.#locks.set(real, lock);
		return root;
	}

	file(name: string): string {
		return join(this.dir, name);
	}

	/**
	 * The hub's access key: 32 random bytes in a 0600 file next to the node socket. The hub can type into terminals and
	 * run agents on every host, so it trusts exactly who the node socket trusts (the owner's own processes), not every
	 * process that can reach loopback. A missing or malformed file gets a new key.
	 */
	token(): string {
		return readHubToken(this.dir) ?? this.saveToken(newHubToken());
	}

	/**
	 * Replaces the stored key. The page, the app, and `ampi open` read the file each time, so they pick it up; browsers
	 * holding the old cookie must open the new link.
	 */
	saveToken(token: string): string {
		writePrivate(this.file("hub.token"), `${token}\n`);
		return token;
	}

	/** Remembered so `ampi open` and `ampi doctor` find this hub without being told the port again. */
	recordPort(port: number): void {
		writePrivate(this.file("hub.port"), `${port}\n`);
	}

	release(): void {
		for (const lock of this.#locks.values()) lock.release();
		this.#locks.clear();
	}
}

export function newHubToken(): string {
	return randomBytes(32).toString("hex");
}

/** The stored access key, for a client of the hub (`ampi open`, doctor). Reading never writes. */
export function readHubToken(dir = ampiHome()): string | undefined {
	try {
		const token = readFileSync(join(dir, "hub.token"), "utf8").trim();
		if (KEY.test(token)) return token;
	} catch {}
	return undefined;
}

/** The live hub that owns a home, for doctor. Reads the pid and port files only; the lock stays untouched. */
export function hubOwner(dir = ampiHome()): HubOwner | undefined {
	const pid = ownerPid(dir, "hub");
	if (!pid) return undefined;
	try { process.kill(pid, 0); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") return undefined; }
	return { pid, dir, ...recordedPort(dir) };
}

function realRoot(dir: string): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return realpathSync(dir);
}

// A root besides the home that nobody can write (a read-only hub.json directory) needs no lock: no hub can race on it.
function writableRoot(dir: string): string | undefined {
	try { return realRoot(dir); }
	catch (error) { if (unwritable(error)) return undefined; throw error; }
}

function lockOptional(root: string): HomeLock | { owner: number } | undefined {
	try { return lockHome(root, "hub"); }
	catch (error) { if (unwritable(error)) return undefined; throw error; }
}

function unwritable(error: unknown): boolean {
	return ["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "");
}

function recordedPort(dir: string): { port?: number } {
	try {
		const port = Number(readFileSync(join(dir, "hub.port"), "utf8").trim());
		return port > 0 ? { port } : {};
	} catch { return {}; }
}

function writePrivate(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	// Write then rename: a reader never sees a partial file, and the file is 0600 from its first byte.
	const next = `${path}.${process.pid}.tmp`;
	writeFileSync(next, text, { mode: 0o600 });
	renameSync(next, path);
}
