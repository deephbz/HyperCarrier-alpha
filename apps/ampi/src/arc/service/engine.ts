// Temporary owner of Arc build comparison. Integration replaces this module
// with the shared AmPi build resolver; no mixed-build reads are permitted.
export type Stamp = { id: string; order: number; line: string | null };
export function compare(local: Stamp, remote: Stamp): "same" | "older" | "newer" {
 if (local.id === remote.id) return "same";
 if (local.order !== remote.order) return local.order > remote.order ? "newer" : "older";
 return local.id > remote.id ? "newer" : "older";
}
export function validStamp(value: unknown): value is Stamp {
 const s = value as Stamp | undefined;
 return Boolean(s && typeof s.id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(s.id)
  && (s.line === null || typeof s.line === "string") && (Number.isSafeInteger(s.order) && s.order >= 0));
}
