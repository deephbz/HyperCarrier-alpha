// The one reader for a working-set copy. A Pi copy is Pi JSONL; a durable copy is the hub's
// cache of a node conversation (trace-analytics durable-copy.mjs). Both serve the same range
// surface, so derive, Find and entry pages never branch on the harness.
// @ts-ignore: shared reader is plain ESM.
import { openPiSessionRange } from "../../../trace-analytics/src/sources/transcript-range.mjs";
// @ts-ignore: shared reader is plain ESM.
import { openDurableCopy } from "../../../trace-analytics/src/sources/durable-copy.mjs";
import { indexFile, type Source } from "./working-set-types.ts";

export type CopyReader = any;

export function openCopyReader(source: Source): CopyReader {
 if (source.harness !== "pi-durable") return openPiSessionRange(source.file, { host: source.host, indexPath: indexFile(source) });
 // A Pi range reads its index at open; a durable copy loads its committed meta on refresh, so open loads it here.
 const reader = openDurableCopy(source.file, { host: source.host });
 try { reader.refresh(); } catch (error) { reader.close(); throw error; }
 return reader;
}

/** The reader's source version inside a derived version (working-set-types.ts derivedVersion). */
export const sourceVersionOf = (derived: string) => derived.slice(derived.indexOf(":") + 1);
