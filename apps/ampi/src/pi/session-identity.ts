// The identity of a Session copy from its Source bytes alone: the header line and the last entries. The hub lists a
// Session by its identity while the derive Worker rebuilds a head that another build's derivation wrote (WorkingSet.load
// hides that head).
import { open, type FileHandle } from "node:fs/promises";
// @ts-ignore: shared reader is plain ESM.
import { sessionRef } from "../../../trace-analytics/src/sources/session-state.mjs";
import type { SessionIdentity } from "./working-set-types.ts";

// A list after an upgrade reads every copy before its first publish, so each read stays small. A Pi header fits in
// HEAD_BYTES; a first line longer than LINE_BYTES is not a Session header. The tail window starts at TAIL_BYTES and
// doubles while it holds no complete entry with a timestamp (a large tool result); past LINE_BYTES, `updated` falls back.
const HEAD_BYTES = 4 * 1024, TAIL_BYTES = 16 * 1024, LINE_BYTES = 1024 * 1024;

const time = (value: unknown) => {
	const t = typeof value === "number" ? value : Date.parse(String(value));
	return Number.isFinite(t) ? t : null;
};
const json = (line: string): Record<string, unknown> | undefined => { try { return JSON.parse(line); } catch { return undefined; } };

async function read(handle: FileHandle, position: number, length: number): Promise<string> {
	const buffer = Buffer.allocUnsafe(length);
	const { bytesRead } = await handle.read(buffer, 0, length, position);
	return buffer.subarray(0, bytesRead).toString("utf8");
}

/** The first line, or undefined when it is longer than LINE_BYTES or has no newline. */
async function firstLine(handle: FileHandle, size: number): Promise<string | undefined> {
	for (let length = HEAD_BYTES; ; length *= 4) {
		const head = await read(handle, 0, Math.min(size, length));
		const end = head.indexOf("\n");
		if (end >= 0) return head.slice(0, end);
		if (length >= size || length >= LINE_BYTES) return undefined;
	}
}

/** The latest timestamp of the complete entries in the smallest tail window that holds one; null when none does. */
async function latestTime(handle: FileHandle, size: number): Promise<number | null> {
	for (let length = TAIL_BYTES; ; length *= 2) {
		const start = Math.max(0, size - length), tail = await read(handle, start, size - start);
		// Complete lines end with a newline (repairReplicaTail). Before the window's first newline, a line may be cut.
		const lines = tail.slice(start > 0 ? tail.indexOf("\n") + 1 : 0, tail.lastIndexOf("\n")).split("\n");
		const times = lines.map((line) => time(json(line)?.timestamp)).filter((t) => t !== null);
		if (times.length) return Math.max(...times);
		if (start === 0 || length >= LINE_BYTES) return null;
	}
}

/**
 * Reads the Pi header `{ type: "session", id, cwd, timestamp }` of a copy file, with the same `id`, `ref`, `cwd` and
 * `started` that the derivation writes. `updated` is the latest timestamp of the complete entries in the tail window
 * (the derivation's rule, session-state.mjs observe, which takes the whole file), else the caller's fallback. The two
 * differ only when every entry in the window is older than one before it; Pi appends entries in time order, so the row
 * then moves at most once, when its re-derive lands. A user-set name is a later
 * `session_info` entry, so the identity has no title. Undefined when the first line is not a Pi header.
 */
export async function identityOf(host: string, file: string, fallbackUpdated: number): Promise<SessionIdentity | undefined> {
	const handle = await open(file, "r");
	try {
		const { size } = await handle.stat();
		const line = await firstLine(handle, size);
		const header = line === undefined ? undefined : json(line);
		if (header?.type !== "session" || typeof header.id !== "string" || !header.id) return undefined;
		const id = `pi:${header.id}`;
		return {
			id, session: header.id, ref: sessionRef(host, id) as string,
			cwd: typeof header.cwd === "string" ? header.cwd : null,
			started: time(header.timestamp),
			updated: (await latestTime(handle, size)) ?? fallbackUpdated,
		};
	} finally { await handle.close(); }
}
