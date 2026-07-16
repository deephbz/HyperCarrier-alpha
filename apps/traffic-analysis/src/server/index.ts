import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { homedir } from "node:os";
import { InMemorySourceStore } from "../application/store.js";
import {
  LocalSessionRegistry,
  TrafficScopeManager,
  TrafficScopeResolver,
  type TrafficSelection,
} from "../application/scopes.js";
import type { AnalysisEnvelope } from "../domain/contracts.js";
import {
  matrixInspectorWire,
  matrixWire,
  secondaryWire,
  ordinalDisclosureWire,
  ordinalWire,
} from "../application/matrix.js";
import { readAllowlistedAttribution } from "../adapters/pi-teams/attribution.js";
const store = new InMemorySourceStore();
const configuredSessionRoots = () => {
  const raw = process.env.PI_TRAFFIC_SESSION_ROOTS;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) &&
      parsed.every((value) => typeof value === "string")
      ? parsed
      : undefined;
  } catch {
    return raw.split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  }
};
const scopeManager = new TrafficScopeManager(
  new TrafficScopeResolver(
    new LocalSessionRegistry(),
    process.env.PI_TRAFFIC_TEAMS_ROOT,
    configuredSessionRoots(),
  ),
);
const fixtureSnapshot: AnalysisEnvelope | null =
  process.env.TRAFFIC_ANALYSIS_FIXTURE === "dense"
    ? (JSON.parse(
        await readFile(
          new URL(
            "../../fixtures/dense-analysis-envelope.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ) as AnalysisEnvelope)
    : null;
const discoveryTeamName = process.env.PI_TEAM_NAME;
const teamDirectory =
  process.env.TRAFFIC_ANALYSIS_TEAM_DIR ??
  (discoveryTeamName
    ? resolve(homedir(), ".pi", "teams", discoveryTeamName)
    : undefined);
const explicitAttribution = teamDirectory
  ? await readAllowlistedAttribution(teamDirectory)
  : [];
const teamName = explicitAttribution.at(0)?.team_name ?? null;
const sourceSpecs = fixtureSnapshot
  ? []
  : process.env.TRAFFIC_ANALYSIS_SOURCE
    ? [
        {
          path: process.env.TRAFFIC_ANALYSIS_SOURCE,
          member_name: undefined,
          is_leader: false,
          presentation: undefined,
        },
      ]
    : [
        ...new Map(
          explicitAttribution.map((x) => [
            x.session_file,
            {
              path: x.session_file,
              member_name: x.member_name ?? undefined,
              is_leader: x.is_leader,
              presentation: {
                displayName: x.member_name,
                teamName: x.team_name,
                isLeader: x.is_leader,
                evidence: x.evidence,
              },
            },
          ]),
        ).values(),
      ];
const inputs = sourceSpecs.map((x) => x.path);
const leadFile = sourceSpecs.find((x) => x.is_leader)?.path;
for (const source of sourceSpecs) await store.load(source.path);
const snapshot = () =>
  fixtureSnapshot ??
  store.snapshotFor(
    sourceSpecs.map((source) => ({
      locator: source.path,
      presentation: source.presentation,
    })),
  );
const revision = () => (fixtureSnapshot ? "fixture:dense:v1" : store.revision);
const port = Number(process.env.PI_TRAFFIC_PORT ?? 4321),
  webRoot = resolve(new URL("../web/", import.meta.url).pathname);
const clients = new Set<any>();
let lastPublishedRevision = revision();
const ISSUED_SNAPSHOT_LIMIT = 128;
const ISSUED_SNAPSHOT_TTL_MS = 5 * 60_000;
type Issued<T> = T & { issued_at_ms: number };
const ordinalSnapshots = new Map<string, Issued<{ analysis_id: string }>>();
const matrixSnapshots = new Map<
  string,
  Issued<{
    analysis_id: string;
    options: {
      start_ms?: number;
      end_ms?: number;
      detail?: "marks" | "summary";
      row_budget?: number;
    };
  }>
>();
/** Bounded current-process capability registry; snapshot IDs are never durable authority. */
const issueSnapshot = <T>(
  registry: Map<string, Issued<T>>,
  id: string,
  value: T,
) => {
  const now = Date.now();
  for (const [key, issued] of registry)
    if (now - issued.issued_at_ms > ISSUED_SNAPSHOT_TTL_MS)
      registry.delete(key);
  registry.delete(id);
  registry.set(id, { ...value, issued_at_ms: now });
  while (registry.size > ISSUED_SNAPSHOT_LIMIT)
    registry.delete(registry.keys().next().value!);
};
const currentIssued = <T>(registry: Map<string, Issued<T>>, id: string) => {
  const issued = registry.get(id);
  if (!issued || Date.now() - issued.issued_at_ms > ISSUED_SNAPSHOT_TTL_MS) {
    registry.delete(id);
    return undefined;
  }
  // Touch a valid entry to make eviction least-recently-used.
  registry.delete(id);
  registry.set(id, issued);
  return issued;
};
const publicScope = (scope: any) => ({
  schemaVersion: scope.schemaVersion,
  scopeRef: scope.scopeRef,
  selection: scope.selection,
  resolvedAtMs: scope.resolvedAtMs,
  resolverVersion: scope.resolverVersion,
  attributionFingerprint: scope.attributionFingerprint,
  sources: scope.sources.map((source: any) => ({
    agentRef: source.agentRef,
    attribution: source.attribution,
    displayName: source.presentation?.displayName ?? null,
    teamName: source.presentation?.teamName ?? null,
    isLeader: source.presentation?.isLeader ?? false,
  })),
  diagnostics: scope.diagnostics.map((diagnostic: any) => ({
    code: diagnostic.code,
    ref: diagnostic.ref.startsWith("/")
      ? "adapter-locator-redacted"
      : diagnostic.ref,
    message: diagnostic.message,
  })),
  limitations: scope.limitations,
});
const json = (res: any, value: any, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};
const staleMatrixSnapshot = () => ({
  error: {
    code: "stale_snapshot",
    reason: "analysis_rotated_or_process_restarted",
    message:
      "Requested matrix snapshot is unavailable because live matrix inspection is current-analysis/process-only.",
  },
});
const staleOrdinalSnapshot = () => ({
  error: {
    code: "stale_snapshot",
    reason: "analysis_rotated_or_process_restarted",
    message:
      "Requested ordinal disclosure is unavailable because its issued ordinal snapshot is stale or unknown.",
  },
});
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname === "/health")
    return json(res, {
      ok: true,
      revision: revision(),
      scopes: scopeManager.health(),
    });
  if (url.pathname === "/api/traffic/scopes" && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      const selection = JSON.parse(raw).selection as TrafficSelection;
      if (
        !selection ||
        (selection.kind !== "team_trace" && selection.kind !== "agents")
      )
        throw Error("invalid selection");
      const opened = await scopeManager.open(selection);
      return json(res, {
        schemaVersion: "traffic-scope-v1",
        scope: publicScope(opened.scope),
      });
    } catch {
      return json(
        res,
        {
          error: {
            code: "invalid_scope_request",
            message:
              "Body must contain one typed team_trace or agents selection.",
          },
        },
        400,
      );
    }
  }
  const scoped = url.pathname.match(
    /^\/api\/traffic\/scopes\/([^/]+)(?:\/(.*))?$/,
  );
  if (scoped) {
    let scopeRef: string;
    try {
      scopeRef = decodeURIComponent(scoped[1]);
    } catch {
      return json(res, { error: { code: "invalid_scope_ref" } }, 400);
    }
    if (!/^traffic:[a-f0-9]{24}$/.test(scopeRef))
      return json(res, { error: { code: "invalid_scope_ref" } }, 400);
    const tail = scoped[2] ?? "";
    const scope = scopeManager.get(scopeRef);
    if (!scope)
      return json(
        res,
        {
          error: {
            code: "scope_unavailable",
            message: "Scope is unknown, evicted, or from a previous process.",
          },
        },
        404,
      );
    if (!tail)
      return json(res, {
        schemaVersion: "traffic-scope-v1",
        scope: publicScope(scope),
      });
    const currentSnapshot = await scopeManager.snapshot(scopeRef);
    if (!currentSnapshot)
      return json(
        res,
        {
          error: {
            code: "scope_unavailable",
            message: "Scope is unavailable.",
          },
        },
        404,
      );
    const scopeSnapshotId = (id: string) => `${scopeRef}:${id}`;
    if (tail === "matrix") {
      try {
        const options = {
          start_ms: url.searchParams.has("startMs")
            ? Number(url.searchParams.get("startMs"))
            : undefined,
          end_ms: url.searchParams.has("endMs")
            ? Number(url.searchParams.get("endMs"))
            : undefined,
          detail:
            url.searchParams.get("detail") === "summary"
              ? ("summary" as const)
              : ("marks" as const),
          row_budget: url.searchParams.has("rowBudget")
            ? Number(url.searchParams.get("rowBudget"))
            : undefined,
        };
        const body = matrixWire(currentSnapshot, options);
        const id = scopeSnapshotId(body.snapshot.id);
        issueSnapshot(matrixSnapshots, id, {
          analysis_id: currentSnapshot.analysis_id,
          options,
          scope_ref: scopeRef,
        } as any);
        return json(res, { ...body, snapshot: { ...body.snapshot, id } });
      } catch {
        return json(
          res,
          {
            error: {
              code: "invalid_matrix_request",
              message: "Invalid matrix window.",
            },
          },
          400,
        );
      }
    }
    if (
      tail === "secondary" ||
      tail.startsWith("matrix/events/") ||
      tail.startsWith("ordinal") ||
      tail === "events"
    ) {
      const supplied = url.searchParams.get("snapshotId");
      if (tail === "events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        let published = currentSnapshot.analysis_id;
        res.write(`event: revision\ndata: ${published}\n\n`);
        const timer = setInterval(async () => {
          const next = await scopeManager.snapshot(scopeRef);
          if (!next) {
            res.write(`event: scope_rotated\ndata: ${scopeRef}\n\n`);
            res.end();
            clearInterval(timer);
            return;
          }
          if (next.analysis_id === published) return;
          published = next.analysis_id;
          res.write(`event: revision\ndata: ${published}\n\n`);
        }, 2_000);
        req.on("close", () => clearInterval(timer));
        return;
      }
      if (tail === "ordinal") {
        const body = ordinalWire(currentSnapshot);
        const id = scopeSnapshotId(body.snapshot.id);
        issueSnapshot(ordinalSnapshots, id, {
          analysis_id: currentSnapshot.analysis_id,
          scope_ref: scopeRef,
        } as any);
        return json(res, { ...body, snapshot: { ...body.snapshot, id } });
      }
      if (tail.startsWith("ordinal/disclosures/")) {
        const disclosure = decodeURIComponent(
          tail.slice("ordinal/disclosures/".length),
        );
        const ordinal = currentIssued(ordinalSnapshots, supplied ?? "") as any;
        if (
          !ordinal ||
          ordinal.scope_ref !== scopeRef ||
          ordinal.analysis_id !== currentSnapshot.analysis_id
        )
          return json(res, staleOrdinalSnapshot(), 409);
        const body = ordinalDisclosureWire(
          currentSnapshot,
          supplied!.slice(scopeRef.length + 1),
          disclosure,
        );
        return body ? json(res, body) : json(res, staleOrdinalSnapshot(), 409);
      }
      const remembered = supplied
        ? (currentIssued(matrixSnapshots, supplied) as any)
        : undefined;
      if (
        !remembered ||
        remembered.scope_ref !== scopeRef ||
        remembered.analysis_id !== currentSnapshot.analysis_id
      )
        return json(res, staleMatrixSnapshot(), 409);
      if (tail === "secondary") {
        try {
          return json(
            res,
            secondaryWire(
              currentSnapshot,
              supplied!.slice(scopeRef.length + 1),
              remembered.options,
            ),
          );
        } catch {
          return json(res, staleMatrixSnapshot(), 409);
        }
      }
      if (tail.startsWith("matrix/events/")) {
        const event = decodeURIComponent(tail.slice("matrix/events/".length));
        const inspection = matrixInspectorWire(
          currentSnapshot,
          supplied!.slice(scopeRef.length + 1),
          event,
          remembered.options,
        );
        return inspection
          ? json(res, inspection)
          : json(
              res,
              {
                error: {
                  code: "event_unavailable",
                  message: "Matrix event is unavailable in this snapshot.",
                },
              },
              404,
            );
      }
      if (tail.startsWith("ordinal/disclosures/")) {
        const disclosure = decodeURIComponent(
          tail.slice("ordinal/disclosures/".length),
        );
        const ordinal = currentIssued(ordinalSnapshots, supplied ?? "") as any;
        if (
          !ordinal ||
          ordinal.scope_ref !== scopeRef ||
          ordinal.analysis_id !== currentSnapshot.analysis_id
        )
          return json(res, staleOrdinalSnapshot(), 409);
        const body = ordinalDisclosureWire(
          currentSnapshot,
          supplied!,
          disclosure,
        );
        return body ? json(res, body) : json(res, staleOrdinalSnapshot(), 409);
      }
    }
    return json(res, { error: { code: "not_found" } }, 404);
  }
  if (url.pathname === "/api/snapshot" || url.pathname === "/api/analysis")
    return json(res, snapshot());
  if (url.pathname === "/api/ordinal-evidence") {
    const body = ordinalWire(snapshot());
    issueSnapshot(ordinalSnapshots, body.snapshot.id, {
      analysis_id: body.snapshot.analysisId,
    });
    return json(res, body);
  }
  if (url.pathname.startsWith("/api/ordinal-evidence/disclosures/")) {
    const snapshotId = url.searchParams.get("snapshotId");
    const disclosureRef = decodeURIComponent(
      url.pathname.slice("/api/ordinal-evidence/disclosures/".length),
    );
    if (!snapshotId || !disclosureRef)
      return json(
        res,
        {
          error: {
            code: "invalid_ordinal_request",
            message: "snapshotId and disclosure reference are required.",
          },
        },
        400,
      );
    const currentSnapshot = snapshot();
    const remembered = currentIssued(ordinalSnapshots, snapshotId);
    if (!remembered || remembered.analysis_id !== currentSnapshot.analysis_id)
      return json(res, staleOrdinalSnapshot(), 409);
    try {
      const disclosure = ordinalDisclosureWire(
        currentSnapshot,
        snapshotId,
        disclosureRef,
      );
      return disclosure
        ? json(res, disclosure)
        : json(res, staleOrdinalSnapshot(), 409);
    } catch {
      return json(res, staleOrdinalSnapshot(), 409);
    }
  }
  if (url.pathname === "/api/matrix") {
    const start_ms = url.searchParams.has("startMs")
      ? Number(url.searchParams.get("startMs"))
      : undefined;
    const end_ms = url.searchParams.has("endMs")
      ? Number(url.searchParams.get("endMs"))
      : undefined;
    const detail: "marks" | "summary" =
      url.searchParams.get("detail") === "summary" ? "summary" : "marks";
    const row_budget = url.searchParams.has("rowBudget")
      ? Number(url.searchParams.get("rowBudget"))
      : undefined;
    try {
      const currentSnapshot = snapshot();
      const options = { start_ms, end_ms, detail, row_budget };
      const body = matrixWire(currentSnapshot, options);
      issueSnapshot(matrixSnapshots, body.snapshot.id, {
        analysis_id: currentSnapshot.analysis_id,
        options,
      });
      const requested = url.searchParams.get("snapshotId");
      if (requested && requested !== body.snapshot.id)
        return json(res, staleMatrixSnapshot(), 409);
      return json(res, body);
    } catch {
      return json(
        res,
        {
          error: {
            code: "invalid_matrix_request",
            message: "Invalid matrix window or schema request.",
          },
        },
        400,
      );
    }
  }
  if (url.pathname === "/api/secondary") {
    const snapshotId = url.searchParams.get("snapshotId");
    if (!snapshotId)
      return json(
        res,
        {
          error: {
            code: "invalid_secondary_request",
            message: "snapshotId is required.",
          },
        },
        400,
      );
    const currentSnapshot = snapshot();
    const remembered = currentIssued(matrixSnapshots, snapshotId);
    if (!remembered || remembered.analysis_id !== currentSnapshot.analysis_id)
      return json(res, staleMatrixSnapshot(), 409);
    try {
      return json(
        res,
        secondaryWire(currentSnapshot, snapshotId, remembered.options),
      );
    } catch {
      return json(res, staleMatrixSnapshot(), 409);
    }
  }
  if (url.pathname.startsWith("/api/matrix/events/")) {
    const snapshotId = url.searchParams.get("snapshotId");
    const eventRef = decodeURIComponent(
      url.pathname.slice("/api/matrix/events/".length),
    );
    if (!snapshotId || !eventRef)
      return json(
        res,
        {
          error: {
            code: "invalid_matrix_request",
            message: "snapshotId and event reference are required.",
          },
        },
        400,
      );
    try {
      const currentSnapshot = snapshot();
      const remembered = currentIssued(matrixSnapshots, snapshotId);
      if (!remembered || remembered.analysis_id !== currentSnapshot.analysis_id)
        return json(res, staleMatrixSnapshot(), 409);
      const inspector = matrixInspectorWire(
        currentSnapshot,
        snapshotId,
        eventRef,
        remembered.options,
      );
      return inspector
        ? json(res, inspector)
        : json(
            res,
            {
              error: {
                code: "event_unavailable",
                message: "Matrix event is unavailable in this snapshot.",
              },
            },
            404,
          );
    } catch {
      return json(res, staleMatrixSnapshot(), 409);
    }
  }
  if (url.pathname === "/api/catalog")
    return json(res, {
      team_name: teamName,
      source_count: fixtureSnapshot
        ? fixtureSnapshot.provenance.source_ids.length
        : inputs.length,
      leader_source_available: Boolean(leadFile),
      revision: revision(),
    });
  if (url.pathname === "/api/trace")
    return json(res, {
      revision: revision(),
      checkpoint_count: inputs.filter((input) => store.checkpoint(input))
        .length,
    });
  if (url.pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`event: revision\ndata: ${revision()}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  try {
    const requested =
      url.pathname === "/" || url.pathname === "/traffic"
        ? "index.html"
        : url.pathname.replace(/^\//, "");
    if (requested.includes("..")) throw Error("unsafe path");
    const bytes = await readFile(resolve(webRoot, requested));
    res.writeHead(200, {
      "content-type": mime[extname(requested)] ?? "application/octet-stream",
    });
    res.end(bytes);
  } catch {
    json(res, { error: "not_found" }, 404);
  }
});
setInterval(async () => {
  if (fixtureSnapshot || !inputs.length) return;
  await Promise.all(sourceSpecs.map((source) => store.reconcile(source.path)));
  if (revision() === lastPublishedRevision) return;
  lastPublishedRevision = revision();
  for (const c of clients) c.write(`event: revision\ndata: ${revision()}\n\n`);
}, 2000).unref();
server.listen(port, "127.0.0.1", () =>
  console.log(`traffic-analysis listening http://127.0.0.1:${port}`),
);
