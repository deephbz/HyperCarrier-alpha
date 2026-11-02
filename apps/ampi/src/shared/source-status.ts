// Source availability types for view values.
// Pi views produce this status; hub and web view consumers read it.
export type SourceStatus = { version: string; asOf: number; state: "ready" | "stale" | "unavailable" };
