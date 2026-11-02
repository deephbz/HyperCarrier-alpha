// Search request and result types for the wire contract.
// Pi search produces these values; hub and web search consumers read them.
/** Session Find adds `prose` (the match is in user or agent text), `at` (scan position) and `prompt` (the user entry it answers). */
export type SearchHit = { entry: string; ref: string; threadId: string; snippet: string; kind?: string; title?: string; version: string; prose?: boolean; at?: number; prompt?: string };

export type SearchResult = { hits: SearchHit[]; more: boolean; scope: string; asOf: number | null; total?: number; proseTotal?: number; windows?: { all: FindWindow; prose: FindWindow }; anchored?: boolean; scanned?: number; invalidLines?: number; coverage?: { indexed: number; notIndexed: number; stale: number; invalidLines: number; updating?: number } };

/**
 * One scope's Find window: its hits' scan positions (`first`..`last`), the matches before it (`skipped`), its length
 * (`size`) and the index of its first match at or after `from` (`start`; equal to `size` when none lies after).
 * Match k of the window is match `skipped + k` of the scope.
 */
export type FindWindow = { first: number; last: number; skipped: number; start: number; size: number };

/**
 * Where a Find window lies: around the entry `from`, at the branch's end (`tail`), or at its start (neither). The hub
 * owns the branch's end; a client never guesses it.
 */
export type FindAsk = { from?: string; tail?: boolean };
