export type AlphaFreshness = "fresh" | "stale" | "unknown";
export type AlphaConfidence = "exact" | "inferred" | "ambiguous";

export interface AlphaRawRef {
  kind: string;
  id: string;
  pathOrCommand?: string;
}

export interface AlphaProvenance {
  source: { kind: string; instance?: string; rawId?: string; path?: string };
  validAt?: string;
  observedAt: string;
  freshness: AlphaFreshness;
  confidence: AlphaConfidence;
  reason?: string;
  derivation: { version: string; inputs: string[] };
  rawRefs: AlphaRawRef[];
}

export interface AlphaAxis<T = unknown> {
  state?: "observed" | "assessed" | "evidence" | "partial" | "ambiguous" | "unknown" | string;
  reason?: string;
  provenance: AlphaProvenance;
  diagnostics?: unknown[];
  [key: string]: unknown;
  items?: T[];
}

export interface AlphaProject {
  projectRef: {
    id: string;
    name: string;
    repoRoots: string[];
    worktreeRoots: string[];
    provenance: AlphaProvenance;
    valueRefs?: Record<string, AlphaRawRef[]>;
    valueProvenance?: Record<string, AlphaProvenance>;
  };
  runtime: AlphaAxis;
  rarebitSummary: AlphaAxis;
  intervention: AlphaAxis;
  eventDelta: AlphaAxis;
  evergreenDelta: AlphaAxis;
  workLedger: AlphaAxis;
  delivery: AlphaAxis;
  trace?: { diagnostics?: unknown[]; rejected?: unknown[] };
}

export interface AlphaTrace {
  schemaVersion: number;
  derivationVersion: string;
  generatedAt: string;
  manifest?: string;
  sources: unknown[];
  diagnostics: unknown[];
  assumptions: string[];
  refresh?: { at: string; reason: string; paths: string[]; sources?: string[] };
}

export interface AlphaSnapshot {
  schemaVersion: number;
  generatedAt: string;
  projects: AlphaProject[];
  trace: AlphaTrace;
}
