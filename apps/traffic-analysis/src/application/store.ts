import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { analyze } from "../domain/analyze.js";
import type {
  AnalysisEnvelope,
  Diagnostic,
  Evidence,
  PreparedTeamConversation,
} from "../domain/contracts.js";
import { preparePiJsonl } from "../adapters/pi/prepare.js";

export interface Checkpoint {
  offset: number;
  prefix_fingerprint: string;
  tail_fingerprint: string;
  parser_version: string;
  dev: number;
  ino: number;
  mtime_ms: number;
}
/** Scope-local association projected over a shared, scope-neutral Session cache. */
export interface SourcePresentation {
  displayName: string | null;
  teamName: string;
  isLeader: boolean;
  evidence: Evidence;
}
export interface SourceSnapshotInput {
  locator: string;
  presentation?: SourcePresentation;
}

export interface ReconcileMetrics {
  stat_calls: number;
  bytes_read: number;
  cold_replays: number;
  unchanged_skips: number;
  append_candidates: number;
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const unavailable = (
  path: string,
  code: "source_missing" | "source_unreadable",
  error: unknown,
): Diagnostic => ({
  diagnostic_id: `source:${hash(path).slice(0, 16)}:${code}`,
  code,
  message: `Explicit source mapping unavailable: ${path}`,
  source_id: `location:${hash(path).slice(0, 24)}`,
  evidence: {
    class: "unavailable",
    basis: "filesystem acquisition",
    unavailable_reason:
      (error as { code?: string })?.code === "ENOENT"
        ? "missing"
        : "unreadable",
  },
});
const sourceDiagnostic = (path: string, error: unknown) =>
  unavailable(
    path,
    (error as { code?: string })?.code === "ENOENT"
      ? "source_missing"
      : "source_unreadable",
    error,
  );
export const mergePrepared = (
  ps: PreparedTeamConversation[],
  sourceDiagnostics: Diagnostic[],
): PreparedTeamConversation => {
  if (ps.length === 0)
    return {
      schema_version: "traffic-analysis-v1",
      prepared_derivation_id: hash("empty-source-selection"),
      provenance: {
        source_ids: [],
        source_artifacts: [],
        parser_version: "pi-0.80.6-byte-adapter-v1",
        content_policy: "approved-first-last-200-only",
        classifier: { id: "pi.teams.inbox-message-v1", version: "1" },
        tool_manifest_version: "tool-owner-manifest-v2",
      },
      agents: [],
      turns: [],
      requests: [],
      content_parts: [],
      tool_events: [],
      tool_spans: [],
      quiet_gaps: [],
      diagnostics: sourceDiagnostics.length
        ? sourceDiagnostics
        : [
            {
              diagnostic_id: "source-selection-unavailable",
              code: "source_selection_unavailable",
              message: "No explicitly selected readable source artifacts.",
              evidence: {
                class: "unavailable",
                basis: "source selection",
                unavailable_reason: "no_sources",
              },
            },
          ],
      team: {
        team_name: null,
        leader_session_id: null,
        leader_session_name: null,
        is_leader_source: false,
      },
      coverage: { start_ms: null, end_ms: null },
    };
  if (ps.length === 1)
    return {
      ...ps[0],
      diagnostics: [...ps[0].diagnostics, ...sourceDiagnostics],
    };
  const digest = hash(
    ps
      .map((p) => p.prepared_derivation_id)
      .sort()
      .join("|"),
  );
  return {
    schema_version: ps[0].schema_version,
    prepared_derivation_id: digest,
    provenance: {
      ...ps[0].provenance,
      source_ids: ps.flatMap((p) => p.provenance.source_ids),
      source_artifacts: ps.flatMap((p) => p.provenance.source_artifacts),
    },
    agents: ps.flatMap((p) => p.agents),
    turns: ps.flatMap((p) => p.turns),
    requests: ps.flatMap((p) => p.requests),
    content_parts: ps.flatMap((p) => p.content_parts),
    tool_events: ps.flatMap((p) => p.tool_events),
    tool_spans: ps.flatMap((p) => p.tool_spans),
    quiet_gaps: ps.flatMap((p) => p.quiet_gaps),
    diagnostics: [...ps.flatMap((p) => p.diagnostics), ...sourceDiagnostics],
    team: (ps.find((p) => p.team.is_leader_source) ?? ps[0]).team,
    coverage: {
      start_ms:
        Math.min(...ps.map((p) => p.coverage.start_ms ?? Infinity)) || null,
      end_ms: Math.max(...ps.map((p) => p.coverage.end_ms ?? 0)) || null,
    },
  };
};

export class InMemorySourceStore {
  private entries = new Map<
    string,
    {
      path: string;
      checkpoint: Checkpoint;
      prepared: PreparedTeamConversation;
      last_used_ms: number;
    }
  >();
  private sourceDiagnostics = new Map<string, Diagnostic>();
  readonly metrics: ReconcileMetrics = {
    stat_calls: 0,
    bytes_read: 0,
    cold_replays: 0,
    unchanged_skips: 0,
    append_candidates: 0,
  };
  revision = 0;
  evictions = 0;
  private async read(path: string) {
    const bytes = await readFile(path, "utf8");
    this.metrics.bytes_read += Buffer.byteLength(bytes);
    return bytes;
  }
  private makeCheckpoint(bytes: string, info: any): Checkpoint {
    return {
      offset: Buffer.byteLength(bytes),
      prefix_fingerprint: hash(bytes.slice(0, 4096)),
      tail_fingerprint: hash(bytes.slice(-4096)),
      parser_version: "pi-0.80.6-byte-adapter-v1",
      dev: Number(info.dev),
      ino: Number(info.ino),
      mtime_ms: info.mtimeMs,
    };
  }
  async load(path: string) {
    try {
      this.metrics.stat_calls++;
      const info = await stat(path);
      const bytes = await this.read(path);
      const source_id = `location:${hash(path).slice(0, 24)}`;
      const prepared = preparePiJsonl(bytes, source_id, { location: path });
      this.entries.set(path, {
        path,
        prepared,
        checkpoint: this.makeCheckpoint(bytes, info),
        last_used_ms: Date.now(),
      });
      this.sourceDiagnostics.delete(path);
      this.revision++;
      return prepared;
    } catch (error) {
      this.entries.delete(path);
      this.sourceDiagnostics.set(path, sourceDiagnostic(path, error));
      this.revision++;
      return undefined;
    }
  }
  async reconcile(path: string) {
    const old = this.entries.get(path);
    if (!old) return this.load(path);
    let info: any;
    try {
      this.metrics.stat_calls++;
      info = await stat(path);
    } catch (error) {
      this.entries.delete(path);
      this.sourceDiagnostics.set(path, sourceDiagnostic(path, error));
      this.revision++;
      return undefined;
    }
    const cp = old.checkpoint;
    old.last_used_ms = Date.now();
    if (
      Number(info.dev) === cp.dev &&
      Number(info.ino) === cp.ino &&
      info.size === cp.offset &&
      info.mtimeMs === cp.mtime_ms
    ) {
      this.metrics.unchanged_skips++;
      return old.prepared;
    }
    // Hybrid strategy: stat-before-read skips unchanged live sources. On any change we cold-replay the one source after continuity checks; it does not claim append parsing because source-local turns/tool pairing can cross the checkpoint.
    const bytes = await this.read(path);
    const continuous =
      Number(info.dev) === cp.dev &&
      Number(info.ino) === cp.ino &&
      Buffer.byteLength(bytes) >= cp.offset &&
      hash(bytes.slice(0, 4096)) === cp.prefix_fingerprint &&
      hash(bytes.slice(Math.max(0, cp.offset - 4096), cp.offset)) ===
        cp.tail_fingerprint;
    if (continuous && Buffer.byteLength(bytes) > cp.offset)
      this.metrics.append_candidates++;
    this.metrics.cold_replays++;
    const source_id = `location:${hash(path).slice(0, 24)}`;
    const prepared = preparePiJsonl(bytes, source_id, { location: path });
    this.entries.set(path, {
      path,
      prepared,
      checkpoint: this.makeCheckpoint(bytes, info),
      last_used_ms: Date.now(),
    });
    this.sourceDiagnostics.delete(path);
    this.revision++;
    return prepared;
  }
  snapshot(): AnalysisEnvelope {
    return analyze(
      mergePrepared(
        [...this.entries.values()].map((x) => x.prepared),
        [...this.sourceDiagnostics.values()],
      ),
    );
  }
  snapshotFor(
    inputs: readonly (string | SourceSnapshotInput)[],
  ): AnalysisEnvelope {
    const sources = inputs.map((input) =>
      typeof input === "string" ? { locator: input } : input,
    );
    const now = Date.now();
    for (const { locator } of sources) {
      const entry = this.entries.get(locator);
      if (entry) entry.last_used_ms = now;
    }
    const project = (
      prepared: PreparedTeamConversation,
      presentation: SourcePresentation | undefined,
    ): PreparedTeamConversation => {
      if (!presentation) return prepared;
      return {
        ...prepared,
        agents: prepared.agents.map((agent) => ({
          ...agent,
          display_name: presentation.displayName,
          display_name_evidence: presentation.evidence,
        })),
        team: {
          team_name: presentation.teamName,
          leader_session_id: presentation.isLeader
            ? (prepared.agents[0]?.session_trace_id ?? null)
            : null,
          leader_session_name: presentation.isLeader
            ? presentation.displayName
            : null,
          is_leader_source: presentation.isLeader,
        },
      };
    };
    return analyze(
      mergePrepared(
        sources
          .map(({ locator, presentation }) => {
            const prepared = this.entries.get(locator)?.prepared;
            return prepared ? project(prepared, presentation) : undefined;
          })
          .filter(
            (value): value is PreparedTeamConversation => value !== undefined,
          ),
        sources
          .map(({ locator }) => this.sourceDiagnostics.get(locator))
          .filter((value): value is Diagnostic => value !== undefined),
      ),
    );
  }
  evict({
    maxEntries,
    idleMs,
    retain = [],
  }: {
    maxEntries: number;
    idleMs: number;
    retain?: readonly string[];
  }) {
    const protectedPaths = new Set(retain);
    const now = Date.now();
    for (const [path, entry] of this.entries)
      if (!protectedPaths.has(path) && now - entry.last_used_ms > idleMs) {
        this.entries.delete(path);
        this.evictions++;
      }
    while (this.entries.size > maxEntries) {
      const candidate = [...this.entries.entries()]
        .filter(([path]) => !protectedPaths.has(path))
        .sort((a, b) => a[1].last_used_ms - b[1].last_used_ms)[0];
      if (!candidate) break;
      this.entries.delete(candidate[0]);
      this.evictions++;
    }
  }
  cacheMetrics() {
    return { preparedSources: this.entries.size, evictions: this.evictions };
  }
  has(path: string) {
    return this.entries.has(path);
  }
  checkpoint(path: string) {
    return this.entries.get(path)?.checkpoint;
  }
}
