import { isDeepStrictEqual } from 'node:util';

// Snapshot finalized Session entries before an operation, then compare against getEntries().
// Branch movement is allowed; rewriting an existing entry is not.
export function assertEntriesPreserved(before, after) {
  const current = new Map(after.map(entry => [entry.id, entry]));
  for (const entry of before) {
    if (!current.has(entry.id) || !isDeepStrictEqual(entry, current.get(entry.id))) {
      const error = new Error(`session-entry-preserved failed for entry ${entry.id}`);
      error.evidence = { before: entry, after: current.get(entry.id) }; throw error;
    }
  }
}

export function eventsOf(history, kind) { return history.filter(event => event.kind === kind); }
