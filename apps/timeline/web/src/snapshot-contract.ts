import { TIMELINE_SNAPSHOT_SCHEMA_VERSION } from "./types";
import type { Snapshot } from "./types";

export class SnapshotCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotCompatibilityError";
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Fail visibly at the HTTP adapter boundary. A stale backend must never be
 * interpreted as a legitimate empty projection by a newer frontend.
 */
export function parseTimelineSnapshot(value: unknown): Snapshot {
  const record = objectValue(value);
  if (!record)
    throw new SnapshotCompatibilityError("Timeline backend returned a non-object snapshot.");
  if (record.schemaVersion !== TIMELINE_SNAPSHOT_SCHEMA_VERSION) {
    const actual =
      record.schemaVersion === undefined
        ? "legacy/unversioned"
        : `v${String(record.schemaVersion)}`;
    throw new SnapshotCompatibilityError(
      `Timeline snapshot schema mismatch: this UI expects v${TIMELINE_SNAPSHOT_SCHEMA_VERSION}, but the backend returned ${actual}. Restart the Timeline stack so its backend and built frontend use the same release.`,
    );
  }
  for (const field of ["sessions", "turns", "requests", "rarebits", "liveAgents"] as const) {
    if (!Array.isArray(record[field])) {
      throw new SnapshotCompatibilityError(
        `Timeline snapshot v${TIMELINE_SNAPSHOT_SCHEMA_VERSION} is missing required ${field} evidence.`,
      );
    }
  }
  return record as unknown as Snapshot;
}
