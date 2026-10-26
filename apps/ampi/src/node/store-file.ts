// Store files around pi-durable's SQLite storage: `store.json` names the pi-durable version that last opened the store,
// and consistent backups come only from SQLite's online backup API. pi-durable migrates stores forward only, so the
// node backs a store up before a different (or unknown) version opens it. Never copy `harness.sqlite` alone: under WAL
// the newest commits live in `-wal`.

import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { validateSqliteSchemaPrefix } from "@earendil-works/chord/sqlite";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
import { createSession } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

/** The installed pi-durable version: `store.json` records it, so a version change is seen before the next open. */
export const PI_DURABLE_VERSION: string = createRequire(import.meta.url)("@earendil-works/pi-durable/package.json").version;

/** The node opens every store with pi-durable's default table prefix. */
export const STORE_PREFIX = "";

/** `threads/<storeId>/store.json`. */
export type StoreFile = { piDurable: string; openedAt: number };
/** `backups/<storeId>/<name>.sqlite.json`: what a backup holds, written after the copy is checked. */
export type BackupFile = { storeId: string; piDurable?: string; schemaVersion: number; prefix: string; reason: string; at: number };

const STORE_ID = /^[rt][0-9a-z]+$/;

export function storeDir(home: string, storeId: string): string {
	if (!STORE_ID.test(storeId)) throw new Error(`Not a store ID: ${JSON.stringify(storeId)}`);
	return join(home, "threads", storeId);
}

/** The recorded version, or `undefined` when `store.json` is missing or unreadable: the caller treats both as unknown. */
export function readStoreFile(dir: string): StoreFile | undefined {
	try {
		const value = JSON.parse(readFileSync(join(dir, "store.json"), "utf8")) as Partial<StoreFile>;
		return typeof value.piDurable === "string" ? { piDurable: value.piDurable, openedAt: Number(value.openedAt) || 0 } : undefined;
	} catch {
		return undefined;
	}
}

export function writeStoreFile(dir: string, piDurable = PI_DURABLE_VERSION): void {
	writeAtomic(join(dir, "store.json"), `${JSON.stringify({ piDurable, openedAt: Date.now() } satisfies StoreFile)}\n`);
}

/**
 * Why an existing store needs a backup before this build opens it: `store.json` names another pi-durable version, or
 * it is missing or unreadable (an unknown version counts as another one). `undefined` for a new or current store.
 */
export function backupReason(dir: string): string | undefined {
	if (!existsSync(join(dir, "harness.sqlite"))) return undefined;
	const recorded = readStoreFile(dir);
	if (!recorded) return "unknown-version";
	return recorded.piDurable === PI_DURABLE_VERSION ? undefined : `from-${recorded.piDurable}`;
}

/**
 * A consistent copy of a store through SQLite's backup API, into `backups/<storeId>/`. The copy is written under a
 * temporary name, checked with `validateBackup`, and only then renamed and described by its sidecar.
 */
export async function backupStore(home: string, storeId: string, reason: string): Promise<string> {
	const source = join(storeDir(home, storeId), "harness.sqlite");
	if (!existsSync(source)) throw new Error(`Store ${storeId} has no harness.sqlite`);
	const dir = join(home, "backups", storeId);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${reason.replace(/[^\w.-]/g, "_")}`;
	const target = join(dir, `${name}.sqlite`);
	const temp = `${target}.tmp`;
	const database = new DatabaseSync(source);
	try {
		await backup(database, temp);
	} finally {
		database.close();
	}
	chmodSync(temp, 0o600);
	fsyncPath(temp);
	const checked = validateBackup(temp);
	renameSync(temp, target);
	const recorded = readStoreFile(storeDir(home, storeId));
	const sidecar: BackupFile = { storeId, ...(recorded ? { piDurable: recorded.piDurable } : {}), schemaVersion: checked.schemaVersion, prefix: STORE_PREFIX, reason, at: Date.now() };
	writeAtomic(`${target}.json`, `${JSON.stringify(sidecar)}\n`);
	return target;
}

export function listBackups(home: string, storeId: string): string[] {
	const dir = join(home, "backups", storeId);
	return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".sqlite")).sort().map((name) => join(dir, name)) : [];
}

/**
 * Checks that `path` is a whole pi-durable store for `prefix`: the SQLite header, the prefixed schema table with a
 * version this build can open, the prefixed conversation table, and `quick_check`. Throws with the first failure.
 */
export function validateBackup(path: string, prefix = STORE_PREFIX): { schemaVersion: number } {
	if (prefix !== "") validateSqliteSchemaPrefix(prefix);
	const header = Buffer.alloc(16);
	const fd = openSync(path, "r");
	try {
		readSync(fd, header, 0, 16, 0);
	} finally {
		closeSync(fd);
	}
	if (header.toString("latin1") !== "SQLite format 3\0") throw new Error(`${basename(path)} is not a SQLite database`);
	const database = new DatabaseSync(path, { readOnly: true });
	try {
		const has = (table: string) => database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) !== undefined;
		if (!has(`${prefix}durable_schema`) || !has(`${prefix}conversations`))
			throw new Error(`${basename(path)} has no pi-durable tables with prefix ${JSON.stringify(prefix)}`);
		const row = database.prepare(`SELECT version FROM ${prefix}durable_schema WHERE singleton = 1`).get() as { version?: number } | undefined;
		const schemaVersion = Number(row?.version);
		if (!Number.isInteger(schemaVersion)) throw new Error(`${basename(path)} has no schema version`);
		if (schemaVersion > CURRENT_SQLITE_SCHEMA_VERSION)
			throw new Error(`${basename(path)} has schema version ${schemaVersion}, newer than this build's ${CURRENT_SQLITE_SCHEMA_VERSION}`);
		const check = database.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
		if (check.length !== 1 || check[0]!.quick_check !== "ok") throw new Error(`${basename(path)} failed quick_check: ${check.map((r) => r.quick_check).join("; ").slice(0, 200)}`);
		return { schemaVersion };
	} finally {
		database.close();
	}
}

/**
 * Replaces a store with a backup. The caller holds the node lock, so no node has the store open. The backup must
 * validate and its committed MetaDoc.store must match, regardless of its sidecar. Identity is read through a Session
 * kernel on the staged copy; no scheduler runs and the backup stays unchanged. The current store is backed up before
 * replacement. Opening the staged copy applies this build's migrations, so store.json records the installed version.
 */
export async function restoreStore(home: string, storeId: string, backupPath: string): Promise<{ restored: string; previous?: string }> {
	validateBackup(backupPath);
	let sidecar: BackupFile | undefined;
	try {
		sidecar = JSON.parse(readFileSync(`${backupPath}.json`, "utf8")) as BackupFile;
	} catch {}
	if (sidecar && sidecar.storeId !== storeId) throw new Error(`${basename(backupPath)} is a backup of store ${sidecar.storeId}, not ${storeId}`);
	if (sidecar && sidecar.prefix !== STORE_PREFIX) throw new Error(`${basename(backupPath)} uses table prefix ${JSON.stringify(sidecar.prefix)}`);
	const dir = storeDir(home, storeId);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const temp = join(dir, "harness.sqlite.restore");
	// A killed identity check can leave a staged WAL. It must never accompany another candidate copy.
	for (const suffix of ["", "-wal", "-shm"]) rmSync(`${temp}${suffix}`, { force: true });
	try {
		writeFileSync(temp, readFileSync(backupPath), { mode: 0o600 });
		const session = createSession(await openNodeSqliteStorage(temp));
		try {
			// Use the node's one document definition, without constructing a NodeRuntime or starting tasks.
			const { MetaDoc } = await import("./runtime.ts");
			const identity = (await session.snapshot(MetaDoc, BACKGROUND_CONTEXT))?.store;
			if (identity !== storeId) throw new Error(`Backup identity ${JSON.stringify(identity ?? "missing")} does not match store ${storeId}`);
		} finally { await session.close(BACKGROUND_CONTEXT); }
		const previous = existsSync(join(dir, "harness.sqlite")) ? await backupStore(home, storeId, "pre-restore") : undefined;
		fsyncPath(temp);
		// backupStore closes the final source connection and checkpoints its WAL before this replacement.
		for (const suffix of ["-wal", "-shm"]) rmSync(join(dir, `harness.sqlite${suffix}`), { force: true });
		renameSync(temp, join(dir, "harness.sqlite"));
		writeStoreFile(dir);
		fsyncPath(dir);
		return { restored: backupPath, ...(previous ? { previous } : {}) };
	} finally {
		for (const suffix of ["", "-wal", "-shm"]) rmSync(`${temp}${suffix}`, { force: true });
	}
}

/** What `ampi node inventory` reports for one store: read only, without pi-durable, so no migration can run. */
export type StoreInventory = {
	storeId: string;
	piDurable?: string;
	schemaVersion: number;
	threads: number;
	entries: number;
	last?: { id: number; conversation: number; commitSeq: number; type?: string };
};

/** Reads one store read-only. Throws when the file is not a pi-durable store or is newer than this build. */
export function inventoryStore(home: string, storeId: string): StoreInventory {
	const dir = storeDir(home, storeId);
	const { schemaVersion } = validateBackup(join(dir, "harness.sqlite"));
	const database = new DatabaseSync(join(dir, "harness.sqlite"), { readOnly: true });
	try {
		const count = (sql: string) => Number((database.prepare(sql).get() as { n: number }).n);
		const last = database.prepare(`SELECT id, conversation_id, commit_seq, json_extract(record, '$.type') AS type FROM ${STORE_PREFIX}entries ORDER BY id DESC LIMIT 1`).get() as
			| { id: number; conversation_id: number; commit_seq: number; type: string | null }
			| undefined;
		return {
			storeId,
			...(readStoreFile(dir) ? { piDurable: readStoreFile(dir)!.piDurable } : {}),
			schemaVersion,
			threads: count(`SELECT count(*) AS n FROM ${STORE_PREFIX}conversations WHERE owner_conversation_id IS NULL`),
			entries: count(`SELECT count(*) AS n FROM ${STORE_PREFIX}entries`),
			...(last ? { last: { id: Number(last.id), conversation: Number(last.conversation_id), commitSeq: Number(last.commit_seq), ...(last.type ? { type: last.type } : {}) } } : {}),
		};
	} finally {
		database.close();
	}
}

/**
 * The root conversations of a store that does not open, read without pi-durable, so a failed store still shows its
 * threads. Empty when the file cannot be read this way.
 */
export function rootConversations(dir: string): number[] {
	try {
		const database = new DatabaseSync(join(dir, "harness.sqlite"), { readOnly: true });
		try {
			return (database.prepare(`SELECT id FROM ${STORE_PREFIX}conversations WHERE owner_conversation_id IS NULL ORDER BY id`).all() as { id: number }[]).map((row) => Number(row.id));
		} finally {
			database.close();
		}
	} catch {
		return [];
	}
}

function writeAtomic(path: string, text: string): void {
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, text, { mode: 0o600 });
	renameSync(temp, path);
}

function fsyncPath(path: string): void {
	const fd = openSync(path, statSync(path).isDirectory() ? "r" : "r+");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
