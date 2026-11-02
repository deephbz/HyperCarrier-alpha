// Rebuildable Pi working-set values. Source evidence stays in the copied JSONL.
import type { PiEntry } from "../shared/protocol.ts";
import type { Kinds, RarebitItem } from "./views/rarebit.ts";
import type { FindAsk } from "../shared/search.ts";

/** Bump when the entry index changes; every Session then rebuilds its entries. */
export const DERIVATION_VERSION = 8;
export const derivedVersion = (source: string) => `${DERIVATION_VERSION}:${source}`;
export const sameIndex = (version: string) => version.startsWith(`${DERIVATION_VERSION}:`);
/** Bump when `derive` adds or changes a Session summary field; unchanged Sessions then re-derive without an index rebuild. */
export const SUMMARY_VERSION = 6;
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
 | { op: "find"; source: Source; query: string; version: string; ask?: FindAsk }
 | { op: "forget"; source: Source; version: string; watermark?: unknown };
type Series = {
 start: number; end: number; buckets: [number, number, number][];
 entries: [number, string][]; marks: [number, string, "stop" | "error"][];
 stopped: boolean; priced: boolean; entryCount: number; omittedHints: number; omittedMarks: number;
};
/** What lists a Session without its derived head: the Pi header and the last activity (session-identity.ts). */
export type SessionIdentity = { id: string; session: string; ref: string; cwd?: string | null; started?: number | null; updated?: number | null };
export type Derived = {
 version: string; bytes: number; asOf: number; invalidLines: number; count: number; tip: string | null;
 session: SessionIdentity & { title?: string | null };
 summaryVersion?: number;
 /** `cost` sums the entries' prices; `priced` says whether any entry reported one (else the figure is no price). */
 cost: number; priced: boolean; model?: string; contextTokens?: number; cacheHit?: number; preview?: string;
 /** The active branch's latest hc-auto-compact `/auto-compact budget` override; absent for the default. */
 budgetOverride?: number;
 /** Tool calls of the last turn that are still open (src/shared/tool-state.ts). */
 openCalls?: number;
 timeline: Series;
 rarebit: { stats: { user: number; continuation: number; stop: number; compactions: number; rarebitTokens: number; totalTokens: number; ratio: number | null };
 diagnosis: { session: Kinds; live: Kinds; entries: number; ms: number }; selector: string;
  /** Rarebit messages and compactions on the active branch; with `fingerprint`, the Arc staleness input. */
  count: number; fingerprint: string; lastStopAt?: string; trigger?: { id: string; kind: "user" | "stop" } };
};
export type StoredEntry = { id: string; position: number; t: number | null; ui?: PiEntry; rarebit?: RarebitItem };
export const indexFile = (source: Source) => `${source.file}.index.sqlite`;
