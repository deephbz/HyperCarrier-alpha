// Rebuildable Pi working-set values. Source evidence stays in the copied JSONL.
import type { UiEntry } from "../node/projection.ts";
import type { Chunk } from "./views/cos-arc-chunks.ts";
import type { Kinds, RarebitItem } from "./views/rarebit.ts";

export const DERIVATION_VERSION = 5;
/** Bump when `derive` adds or changes a Session summary field; unchanged Sessions then re-derive without an index rebuild. */
export const SUMMARY_VERSION = 2;
export const WINDOW_ENTRIES = 400;
/** UTF-8 bytes in one page of a full projected entry. */
export const ENTRY_PAGE_BYTES = 64 * 1024;
export const WINDOW_BYTES = 512 * 1024;
export const PROSE_CHARS = 1024;
/** User and assistant prose stay whole in a preview up to this size; the largest live message was 13,616 chars. */
export const MESSAGE_CHARS = 16 * 1024;
export const TOOL_CHARS = 256;
/** Tool-call arguments up to this JSON size stay whole in a preview; larger ones keep only path and command keys. */
export const TOOL_ARGS_CHARS = 2048;
export type Source = { host: string; cacheDir: string; file: string; path: string };
export type WorkerJob =
 | { op: "init"; cacheDir: string }
 | { op: "derive"; source: Source; urgent?: boolean }
 | { op: "find"; source: Source; query: string; version: string }
 | { op: "forget"; source: Source; version: string; watermark?: unknown };
export type Series = {
 start: number; end: number; buckets: [number, number, number][];
 entries: [number, string][]; marks: [number, string, "stop" | "error"][];
 stopped: boolean; entryCount: number; omittedHints: number; omittedMarks: number;
};
export type Derived = {
 version: string; bytes: number; asOf: number; invalidLines: number; count: number; tip: string | null;
 session: { id: string; session: string; ref: string; cwd?: string | null; started?: number | null; updated?: number | null; title?: string | null };
 summaryVersion?: number;
 cost: number; model?: string; contextTokens?: number; cacheHit?: number; preview?: string;
 /** Tool calls of the last turn that are still open (src/shared/tool-state.ts). */
 openCalls?: number;
 timeline: Series;
 arc: { chunks: Chunk[]; excludedEntries: number; shortenedChunks: number; inputChars: number };
 rarebit: { stats: { user: number; continuation: number; stop: number; compactions: number; rarebitTokens: number; totalTokens: number; ratio: number | null };
 diagnosis: { session: Kinds; live: Kinds; entries: number; ms: number }; selector: string;
  /** Rarebit messages and compactions on the active branch; with `fingerprint`, the Arc staleness input. */
  count: number; fingerprint: string };
};
export type StoredEntry = { id: string; position: number; t: number | null; ui?: UiEntry; rarebit?: RarebitItem };
export const indexFile = (source: Source) => `${source.file}.index.sqlite`;
