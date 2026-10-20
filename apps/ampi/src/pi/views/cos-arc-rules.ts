// The chunk rules as numbers and as the one sentence the Arc page shows. Browser-safe: no Node imports.

export const OWNER_TURNS = 12;
/** Rarebit evidence chars (user, stop, continuation, error and compaction text) before the excerpt clip. */
export const RAREBIT_CHARS = 40_000;
/** Idle gap: from the owner-driven activity of one owner turn to the next owner turn. Harness wakes do not count. */
export const IDLE_MS = 2 * 3600_000;

/** The live chunk rule, for the Arc page legend. */
export const CHUNK_RULE = `A chunk starts at an owner turn after ${OWNER_TURNS} owner turns, ${RAREBIT_CHARS / 1000}k Rarebit characters, or more than ${IDLE_MS / 3600_000} h without owner-driven activity. Compactions, harness wakes and directory moves stay inside a chunk.`;

/** Rarebit messages (your prompts, agent replies and Team messages) a Session needs before its Arc builds automatically. */
export const AUTO_BUILD_MIN_MESSAGES = 4;
/** The automatic floor as the Arc value carries it; null at or above the floor. Build arc stays available below it. */
export const arcFloor = (messages: number) => messages < AUTO_BUILD_MIN_MESSAGES ? { min: AUTO_BUILD_MIN_MESSAGES, messages } : null;
