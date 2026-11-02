// The on-disk shape of a Pi Host's copy index (`<cacheDir>/index.json`) and nothing else. It holds no state, no
// debounce and no copy-file reads; PiHost (#loadIndex, #saveIndex, #writeIndex) owns those, and the starting.json
// content and its pane filter. `replaceFile` is the cache-file write discipline that #writeIndex uses for both of
// its files; it is not a shared utility.

import { readFile, rename, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { setImmediate as yieldLoop } from "node:timers/promises";

/** One copy's entry, keyed by its source path, in #copies order. Old files may lack the optional fields. */
export type IndexEntry = { file: string; offset: number; closedAt?: number; lastKnownLive?: boolean };

/** The entry saved for a copy: key order file, offset, lastKnownLive, closedAt; closedAt only when set. */
export function indexEntry(c: { file: string; offset: number; lastKnownLive?: boolean; closedAt?: number }): IndexEntry {
	return { file: basename(c.file), offset: c.offset, lastKnownLive: c.lastKnownLive, ...(c.closedAt ? { closedAt: c.closedAt } : {}) };
}

/** The index file text. It builds one entry at a time and yields the event loop every 10 ms. */
export async function indexText(index: readonly (readonly [string, IndexEntry])[]): Promise<string> {
	const parts: string[] = [];
	let since = performance.now();
	for (const [path, meta] of index) {
		parts.push(JSON.stringify(path) + ":" + JSON.stringify(meta));
		if (performance.now() - since >= 10) { await yieldLoop(); since = performance.now(); }
	}
	return "{" + parts.join(",") + "}";
}

/** Parses the index file. A missing file is an empty index; every other error throws. */
export async function readIndex(file: string): Promise<Record<string, IndexEntry>> {
	let index: Record<string, IndexEntry> = {};
	try { index = JSON.parse(await readFile(file, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	return index;
}

/** Writes `file.tmp` (mode 600), then renames it over `file`. */
export async function replaceFile(file: string, data: string): Promise<void> {
	await writeFile(file + ".tmp", data, { mode: 0o600 });
	await rename(file + ".tmp", file);
}
