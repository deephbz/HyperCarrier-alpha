import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { InMemorySourceStore, type SourcePresentation } from "./store.js";
import type { AnalysisEnvelope, Diagnostic } from "../domain/contracts.js";
import { readAllowlistedAttribution } from "../adapters/pi-teams/attribution.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const sessionRef = (id: string) => `pi-session:${id}`;
const teamRef = (name: string) => `piteams:${name}`;
const TEAM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TrafficSelection =
  | { kind: "team_trace"; teamRef: string }
  | { kind: "agents"; agentRefs: readonly [string, ...string[]] };
export interface ScopeDiagnostic {
  code:
    | "team_unavailable"
    | "agent_unavailable"
    | "agent_ambiguous"
    | "source_outside_trusted_root"
    | "invalid_selection";
  ref: string;
  message: string;
}
export interface ResolvedSource {
  agentRef: string;
  locator: string;
  attribution: string;
  presentation?: SourcePresentation;
}
export interface ResolvedEvidenceScope {
  schemaVersion: "traffic-scope-v1";
  scopeRef: string;
  selection: TrafficSelection;
  resolvedAtMs: number;
  resolverVersion: "traffic-scope-resolver-v1";
  attributionFingerprint: string;
  sources: readonly ResolvedSource[];
  diagnostics: readonly ScopeDiagnostic[];
  limitations: {
    membershipInterval: "unavailable";
    sessionExtentMayExceedMembership: boolean;
  } | null;
}

/** Adapter-local registry: Session UUID is the public key; a locator is never accepted from HTTP. */
export class LocalSessionRegistry {
  private readonly locations = new Map<string, Set<string>>();
  register(id: string, locator: string) {
    if (!UUID.test(id)) return;
    const values = this.locations.get(id) ?? new Set<string>();
    values.add(locator);
    this.locations.set(id, values);
  }
  resolve(ref: string): { locator?: string; diagnostic?: ScopeDiagnostic } {
    if (!ref.startsWith("pi-session:") || !UUID.test(ref.slice(11)))
      return {
        diagnostic: {
          code: "invalid_selection",
          ref,
          message: "Agent references must be pi-session:<UUID>.",
        },
      };
    const values = [...(this.locations.get(ref.slice(11)) ?? [])];
    if (values.length === 1) return { locator: values[0] };
    return {
      diagnostic: {
        code: values.length ? "agent_ambiguous" : "agent_unavailable",
        ref,
        message: values.length
          ? "Session UUID maps to multiple local evidence locators."
          : "No explicit local Session registry mapping exists for this UUID.",
      },
    };
  }
}

const sessionIdAt = async (locator: string) => {
  try {
    const first = (await readFile(locator, "utf8")).split("\n", 1)[0];
    const parsed = JSON.parse(first);
    return typeof parsed.id === "string" && UUID.test(parsed.id)
      ? parsed.id
      : undefined;
  } catch {
    return undefined;
  }
};

export class TrafficScopeResolver {
  constructor(
    private readonly registry: LocalSessionRegistry,
    private readonly teamsRoot = join(homedir(), ".pi", "teams"),
    private readonly sessionRoots: readonly string[] = [
      join(homedir(), ".pi", "agent", "sessions"),
    ],
  ) {}
  private async trustedLocator(locator: string) {
    const within = (candidate: string, root: string) =>
      candidate === root || candidate.startsWith(`${root}/`);
    const lexical = resolve(locator);
    const allowedRoots = this.sessionRoots.map((root) => resolve(root));
    if (!allowedRoots.some((root) => within(lexical, root)))
      return { trusted: false, exists: false };
    const roots = await Promise.all(
      allowedRoots.map(async (root) => {
        try {
          return await realpath(root);
        } catch {
          return root;
        }
      }),
    );
    try {
      const target = await realpath(locator);
      return {
        trusted: roots.some((root) => within(target, root)),
        exists: true,
      };
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT")
        return { trusted: false, exists: false };
      // A missing leaf is allowed only when its existing parent still resolves
      // below a trusted root; this rejects a missing leaf through a symlink escape.
      let parent = dirname(lexical);
      while (parent !== dirname(parent)) {
        try {
          const resolvedParent = await realpath(parent);
          return {
            trusted: roots.some((root) => within(resolvedParent, root)),
            exists: false,
          };
        } catch (parentError) {
          if ((parentError as { code?: string }).code !== "ENOENT")
            return { trusted: false, exists: false };
          parent = dirname(parent);
        }
      }
      return { trusted: false, exists: false };
    }
  }
  private async registerSessionFiles(root: string) {
    try {
      for (const entry of await readdir(root, { recursive: true })) {
        if (typeof entry !== "string" || !entry.endsWith(".jsonl")) continue;
        const locator = join(root, entry);
        if (!(await this.trustedLocator(locator)).trusted) continue;
        const id = await sessionIdAt(locator);
        if (id) this.registry.register(id, locator);
      }
    } catch {
      /* configured local roots are evidence adapters, never HTTP input */
    }
  }
  async refreshKnownTeams() {
    await Promise.all(
      this.sessionRoots.map((root) => this.registerSessionFiles(root)),
    );
    try {
      for (const name of await readdir(this.teamsRoot)) {
        if (!TEAM_NAME.test(name)) continue;
        for (const row of await readAllowlistedAttribution(
          resolve(this.teamsRoot, name),
        )) {
          if (!(await this.trustedLocator(row.session_file)).trusted) continue;
          const id = await sessionIdAt(row.session_file);
          if (id) this.registry.register(id, row.session_file);
        }
      }
    } catch {
      /* absent local adapter data is an unavailable, not a fallback */
    }
  }
  async resolve(selection: TrafficSelection): Promise<ResolvedEvidenceScope> {
    await this.refreshKnownTeams();
    if (selection.kind === "agents") return this.resolveAgents(selection);
    return this.resolveTeam(selection);
  }
  private async resolveAgents(
    selection: Extract<TrafficSelection, { kind: "agents" }>,
  ): Promise<ResolvedEvidenceScope> {
    const refs = [...new Set(selection.agentRefs)].sort();
    const diagnostics: ScopeDiagnostic[] = [],
      sources: ResolvedSource[] = [];
    for (const ref of refs) {
      const result = this.registry.resolve(ref);
      if (result.locator) {
        const trusted = await this.trustedLocator(result.locator);
        if (trusted.trusted)
          sources.push({
            agentRef: ref,
            locator: result.locator,
            attribution: "explicit local Session registry",
          });
        else
          diagnostics.push({
            code: "source_outside_trusted_root",
            ref,
            message:
              "Explicit local Session mapping is outside configured trusted Session roots.",
          });
      } else if (result.diagnostic) diagnostics.push(result.diagnostic);
    }
    const canonical: TrafficSelection = {
      kind: "agents",
      agentRefs: refs as [string, ...string[]],
    };
    const fingerprint = hash(
      JSON.stringify({
        canonical,
        sources: sources.map((x) => [x.agentRef, x.locator]),
      }),
    );
    return {
      schemaVersion: "traffic-scope-v1",
      scopeRef: `traffic:${fingerprint.slice(0, 24)}`,
      selection: canonical,
      resolvedAtMs: Date.now(),
      resolverVersion: "traffic-scope-resolver-v1",
      attributionFingerprint: fingerprint,
      sources,
      diagnostics,
      limitations: null,
    };
  }
  private async resolveTeam(
    selection: Extract<TrafficSelection, { kind: "team_trace" }>,
  ): Promise<ResolvedEvidenceScope> {
    const name = selection.teamRef.startsWith("piteams:")
      ? selection.teamRef.slice(8)
      : "";
    const diagnostics: ScopeDiagnostic[] = [],
      sources: ResolvedSource[] = [];
    if (!TEAM_NAME.test(name))
      diagnostics.push({
        code: "invalid_selection",
        ref: selection.teamRef,
        message: "Team references must be piteams:<safe-team-name>.",
      });
    else {
      const rows = await readAllowlistedAttribution(
        resolve(this.teamsRoot, name),
      );
      if (!rows.length)
        diagnostics.push({
          code: "team_unavailable",
          ref: selection.teamRef,
          message:
            "No explicit PiTeams member or lead Session mappings are available.",
        });
      for (const row of rows) {
        const trusted = await this.trustedLocator(row.session_file);
        if (!trusted.trusted) {
          diagnostics.push({
            code: "source_outside_trusted_root",
            ref: `mapping:${hash(row.evidence.basis).slice(0, 16)}`,
            message:
              "Explicit mapped source is outside configured trusted Session roots.",
          });
          continue;
        }
        if (!trusted.exists) {
          diagnostics.push({
            code: "agent_unavailable",
            ref: `mapping:${hash(row.evidence.basis).slice(0, 16)}`,
            message: "Explicit mapped Session evidence is unavailable.",
          });
          continue;
        }
        const id = await sessionIdAt(row.session_file);
        if (!id) {
          diagnostics.push({
            code: "agent_unavailable",
            ref: `mapping:${hash(row.evidence.basis).slice(0, 16)}`,
            message:
              "Explicit mapped Session evidence is unavailable or lacks a UUID header.",
          });
          continue;
        }
        this.registry.register(id, row.session_file);
        sources.push({
          agentRef: sessionRef(id),
          locator: row.session_file,
          attribution: row.evidence.basis,
          presentation: {
            displayName: row.member_name,
            teamName: row.team_name,
            isLeader: row.is_leader,
            evidence: row.evidence,
          },
        });
      }
    }
    const canonical: TrafficSelection = {
      kind: "team_trace",
      teamRef: teamRef(name),
    };
    const unique = [
      ...new Map(sources.map((x) => [x.agentRef, x])).values(),
    ].sort((a, b) => a.agentRef.localeCompare(b.agentRef));
    const fingerprint = hash(
      JSON.stringify({
        canonical,
        sources: unique.map((x) => [
          x.agentRef,
          x.locator,
          x.attribution,
          x.presentation?.displayName,
          x.presentation?.teamName,
          x.presentation?.isLeader,
        ]),
        diagnostics: diagnostics.map((x) => [x.code, x.ref]),
      }),
    );
    return {
      schemaVersion: "traffic-scope-v1",
      scopeRef: `traffic:${fingerprint.slice(0, 24)}`,
      selection: canonical,
      resolvedAtMs: Date.now(),
      resolverVersion: "traffic-scope-resolver-v1",
      attributionFingerprint: fingerprint,
      sources: unique,
      diagnostics,
      limitations: {
        membershipInterval: "unavailable",
        sessionExtentMayExceedMembership: true,
      },
    };
  }
}

export class TrafficScopeManager {
  readonly sourceStore = new InMemorySourceStore();
  private readonly scopes = new Map<
    string,
    { scope: ResolvedEvidenceScope; lastUsed: number; revision: string }
  >();
  private readonly maxPreparedSources = Number(
    process.env.TRAFFIC_ANALYSIS_MAX_PREPARED_SOURCES ?? 8,
  );
  private readonly sourceIdleMs = Number(
    process.env.TRAFFIC_ANALYSIS_SOURCE_IDLE_MS ?? 300_000,
  );
  constructor(
    private readonly resolver: TrafficScopeResolver,
    private readonly maxScopes = Number(
      process.env.TRAFFIC_ANALYSIS_MAX_SCOPES ?? 2,
    ),
  ) {}
  async open(selection: TrafficSelection) {
    const scope = await this.resolver.resolve(selection);
    for (const source of scope.sources) {
      if (this.sourceStore.has(source.locator))
        await this.sourceStore.reconcile(source.locator);
      else await this.sourceStore.load(source.locator);
    }
    const envelope = this.sourceStore.snapshotFor(scope.sources);
    this.scopes.set(scope.scopeRef, {
      scope,
      lastUsed: Date.now(),
      revision: envelope.analysis_id,
    });
    this.evict();
    this.sourceStore.evict({
      maxEntries: Math.max(this.maxPreparedSources, scope.sources.length),
      idleMs: this.sourceIdleMs,
      retain: scope.sources.map((source) => source.locator),
    });
    return { scope, envelope };
  }
  get(scopeRef: string) {
    const value = this.scopes.get(scopeRef);
    if (value) value.lastUsed = Date.now();
    return value?.scope;
  }
  async snapshot(scopeRef: string): Promise<AnalysisEnvelope | undefined> {
    const scope = this.get(scopeRef);
    if (!scope) return undefined;
    // Team attribution is evidence, not a startup-only setting. A changed mapping
    // deliberately rotates the capability instead of silently broadening it.
    const refreshed = await this.resolver.resolve(scope.selection);
    if (refreshed.scopeRef !== scopeRef) {
      this.scopes.delete(scopeRef);
      return undefined;
    }
    for (const source of scope.sources)
      await this.sourceStore.reconcile(source.locator);
    const envelope = this.sourceStore.snapshotFor(scope.sources);
    this.sourceStore.evict({
      maxEntries: Math.max(this.maxPreparedSources, scope.sources.length),
      idleMs: this.sourceIdleMs,
      retain: scope.sources.map((source) => source.locator),
    });
    return envelope;
  }
  health() {
    return {
      active: this.scopes.size,
      max: this.maxScopes,
      sourceCache: {
        retainedInactiveMax: this.maxPreparedSources,
        idleMs: this.sourceIdleMs,
        activeScopeWorkingSet: [...this.scopes.values()].reduce(
          (count, entry) => count + entry.scope.sources.length,
          0,
        ),
        ...this.sourceStore.cacheMetrics(),
      },
    };
  }
  private evict() {
    while (this.scopes.size > this.maxScopes) {
      const victim = [...this.scopes.entries()].sort(
        (a, b) => a[1].lastUsed - b[1].lastUsed,
      )[0];
      this.scopes.delete(victim[0]);
    }
  }
}
