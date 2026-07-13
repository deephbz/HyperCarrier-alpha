import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, watch } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const ALPHA_SCHEMA_VERSION = 1;
export const ALPHA_DERIVATION_VERSION = "hc-timeline-alpha-v1";
export const CANONICAL_PROJECT_ID_PATTERN = "^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$";
const CANONICAL_PROJECT_ID_RE = new RegExp(CANONICAL_PROJECT_ID_PATTERN);

const DEFAULT_MANIFEST_NAMES = [
  ".hypercarrier/project-manifest.json",
  ".hypercarrier/projects.json",
  "hypercarrier.projects.json",
];
const CANONICAL_REGISTRY_ENV_NAMES = ["PI_TIMELINE_PROJECT_REGISTRY", "HC_PROJECT_REGISTRY"];
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function rawRef(kind, id, pathOrCommand) {
  return { kind, id: String(id), ...(pathOrCommand ? { pathOrCommand } : {}) };
}

export function provenance({
  source,
  observedAt,
  validAt,
  freshness,
  confidence = "exact",
  reason,
  inputs = [],
  rawRefs = [],
}) {
  return {
    source,
    ...(validAt ? { validAt } : {}),
    observedAt,
    freshness,
    confidence,
    ...(reason ? { reason } : {}),
    derivation: { version: ALPHA_DERIVATION_VERSION, inputs },
    rawRefs,
  };
}

export function freshnessFor({
  observedAt,
  validAt,
  freshness,
  now = Date.now(),
  maxAgeMs = MAX_AGE_MS,
}) {
  const time = Date.parse(validAt ?? observedAt ?? "");
  if (Number.isFinite(time) && time - now > MAX_FUTURE_SKEW_MS) return "unknown";
  if (freshness === "fresh" || freshness === "stale" || freshness === "unknown") return freshness;
  if (!Number.isFinite(time)) return "unknown";
  const age = now - time;
  if (age < -MAX_FUTURE_SKEW_MS) return "unknown";
  return age <= maxAgeMs ? "fresh" : "stale";
}

function stateRecord({ source, observedAt, status, reason, pathOrCommand, now, rawRefs = [] }) {
  const validAt = observedAt;
  return {
    status,
    ...(reason ? { reason } : {}),
    provenance: provenance({
      source: { kind: source, instance: "alpha", rawId: reason ?? status },
      observedAt,
      validAt,
      freshness:
        status === "missing" ||
        status === "malformed" ||
        status === "partial" ||
        status === "ambiguous"
          ? "unknown"
          : freshnessFor({ validAt, now }),
      confidence: status === "ok" ? "exact" : "ambiguous",
      inputs: [pathOrCommand ?? source],
      rawRefs,
    }),
  };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFutureTimestamp(value, now) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) && time - now > MAX_FUTURE_SKEW_MS;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function contentHash(value) {
  return hash(stableJson(value));
}

function uniqueStrings(values) {
  return [
    ...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === "string")),
  ];
}

function projectDiagnostic(projectId, source, reason, extra = {}) {
  return {
    projectId,
    source,
    status: "ambiguous",
    reason,
    ...extra,
  };
}

function resolveSource(path, base) {
  if (!path || typeof path !== "string") return undefined;
  return isAbsolute(path) ? path : resolve(base, path);
}

function safeReadJson(path) {
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { error: error?.code === "ENOENT" ? "missing" : "malformed" };
  }
}

function normalizeProjects(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.projects)) return value.projects;
  if (value?.project && typeof value.project === "object") return [value.project];
  return [];
}

function configuredList(value, fallback = []) {
  if (Array.isArray(value)) return value;
  return value === undefined ? fallback : [value];
}

function resolveConfiguredList(values, base) {
  return configuredList(values)
    .map((value) => resolveSource(value, base))
    .filter(Boolean);
}

function canonicalProject(project, manifestPath, base) {
  const locations = project.locations;
  if (!isObject(locations)) return undefined;
  const repos = resolveConfiguredList(locations.repos, base);
  const summaries = resolveConfiguredList(locations.summaries, base);
  const sourceDocs = resolveConfiguredList(locations.sourceDocs, base);
  const evergreen = resolveSource(locations.evergreen, base);
  const beadsRoot = resolveSource(locations.beadsRoot, base);
  const events = resolveSource(locations.events, base);
  const proposalDir = resolveSource(locations.proposalDir, base);
  const associations = isObject(project.associations) ? project.associations : {};
  const sessionIds = uniqueStrings(associations.sessionIds);
  const taskIds = uniqueStrings(associations.taskIds);
  return {
    ...project,
    repoRoots: repos,
    worktreeRoots: [],
    locations: {
      ...locations,
      repos,
      evergreen,
      beadsRoot,
      summaries,
      events,
      proposalDir,
      sourceDocs,
    },
    sessionIds,
    taskIds,
    associations: { ...associations, sessionIds, taskIds },
    manifestPath,
    manifestBase: base,
    registryVersion: undefined,
  };
}

function canonicalValidationDiagnostic({
  manifestPath,
  now,
  observedAt,
  reason,
  project,
  projectIndex,
  field,
  expected,
}) {
  const projectId = typeof project?.id === "string" ? project.id : undefined;
  return {
    ...stateRecord({
      source: "project-registry",
      observedAt,
      status: "malformed",
      reason,
      pathOrCommand: manifestPath,
      now,
      rawRefs: [rawRef("registry", projectId ?? `project-${projectIndex + 1}`, manifestPath)],
    }),
    ...(projectId ? { projectId } : {}),
    ...(projectIndex === undefined ? {} : { projectIndex }),
    ...(field ? { field } : {}),
    ...(expected ? { expected } : {}),
  };
}

function validateCanonicalLocations(project, projectIndex, locations, add) {
  for (const field of ["repos", "evergreen", "beadsRoot", "summaries", "events", "proposalDir"]) {
    if (!(field in locations))
      add({
        reason: "canonical_location_required",
        project,
        projectIndex,
        field: `locations.${field}`,
      });
  }
  for (const field of ["repos", "summaries", "sourceDocs"]) {
    if (
      locations[field] !== undefined &&
      (!Array.isArray(locations[field]) ||
        !locations[field].every((item) => typeof item === "string"))
    )
      add({
        reason: "canonical_location_list_type",
        project,
        projectIndex,
        field: `locations.${field}`,
        expected: "array of strings",
      });
  }
  for (const field of ["evergreen", "beadsRoot", "events", "proposalDir"]) {
    if (
      locations[field] !== undefined &&
      locations[field] !== null &&
      typeof locations[field] !== "string"
    )
      add({
        reason: "canonical_location_value_type",
        project,
        projectIndex,
        field: `locations.${field}`,
        expected: "string or null",
      });
  }
}

function validateCanonicalAssociations(project, projectIndex, associations, add) {
  for (const field of ["sessionIds", "taskIds"]) {
    if (
      associations[field] !== undefined &&
      (!Array.isArray(associations[field]) ||
        !associations[field].every((item) => typeof item === "string"))
    )
      add({
        reason: "canonical_association_list_type",
        project,
        projectIndex,
        field: `associations.${field}`,
        expected: "array of strings",
      });
  }
  if (
    associations.rules !== undefined &&
    (!Array.isArray(associations.rules) || !associations.rules.every((rule) => isObject(rule)))
  )
    add({
      reason: "canonical_association_rules_type",
      project,
      projectIndex,
      field: "associations.rules",
      expected: "array of objects",
    });
}

function validateCanonicalProject(project, projectIndex, ids, add) {
  if (!isObject(project)) {
    add({ reason: "project_object_required", projectIndex, expected: "object" });
    return;
  }
  const id = typeof project.id === "string" ? project.id : undefined;
  if (!id) add({ reason: "project_id_required", project, projectIndex, field: "id" });
  else if (!CANONICAL_PROJECT_ID_RE.test(id))
    add({
      reason: "unsafe_project_id",
      project,
      projectIndex,
      field: "id",
      expected: CANONICAL_PROJECT_ID_PATTERN,
    });
  else {
    const previous = ids.get(id);
    if (previous !== undefined)
      add({
        reason: "duplicate_project_id",
        project,
        projectIndex,
        field: "id",
        expected: `unique; first declared at project ${previous + 1}`,
      });
    else ids.set(id, projectIndex);
  }
  if (typeof project.name !== "string" || !project.name.trim())
    add({ reason: "project_name_required", project, projectIndex, field: "name" });

  if (!isObject(project.locations))
    add({
      reason: "canonical_locations_required",
      project,
      projectIndex,
      field: "locations",
      expected: "object",
    });
  else validateCanonicalLocations(project, projectIndex, project.locations, add);

  if (!isObject(project.associations))
    add({
      reason: "canonical_associations_required",
      project,
      projectIndex,
      field: "associations",
      expected: "object",
    });
  else validateCanonicalAssociations(project, projectIndex, project.associations, add);

  if (project.evergreen !== undefined && !isObject(project.evergreen))
    add({
      reason: "canonical_evergreen_type",
      project,
      projectIndex,
      field: "evergreen",
      expected: "object",
    });
}

function validateCanonicalRegistry(value, { manifestPath, now, observedAt }) {
  const diagnostics = [];
  const add = (details) =>
    diagnostics.push(
      canonicalValidationDiagnostic({
        manifestPath,
        now,
        observedAt,
        ...details,
      }),
    );

  if (!isObject(value)) {
    add({ reason: "registry_object_required", projectIndex: 0, expected: "object" });
    return diagnostics;
  }
  if (value.schemaVersion !== ALPHA_SCHEMA_VERSION)
    add({ reason: "unsupported_schema_version", projectIndex: 0, expected: "1" });
  if (typeof value.registryVersion !== "string" || !value.registryVersion.trim())
    add({ reason: "registry_version_required", projectIndex: 0, field: "registryVersion" });
  if (!Array.isArray(value.projects)) {
    add({ reason: "projects_array_required", projectIndex: 0, field: "projects" });
    return diagnostics;
  }
  if (value.correctionProvenance !== undefined && !isObject(value.correctionProvenance))
    add({
      reason: "correction_provenance_type",
      projectIndex: 0,
      field: "correctionProvenance",
      expected: "object",
    });

  const ids = new Map();
  value.projects.forEach((project, projectIndex) =>
    validateCanonicalProject(project, projectIndex, ids, add),
  );
  return diagnostics;
}

function hasRegistryVersionField(value) {
  return isObject(value) && Object.prototype.hasOwnProperty.call(value, "registryVersion");
}

function isCanonicalRegistryCandidate(value, rawProjects, canonicalEnvRequested) {
  return (
    canonicalEnvRequested ||
    hasRegistryVersionField(value) ||
    rawProjects.some(
      (project) =>
        isObject(project) &&
        (Object.prototype.hasOwnProperty.call(project, "locations") ||
          Object.prototype.hasOwnProperty.call(project, "associations")),
    )
  );
}

function loadCanonicalRegistry({
  value,
  rawProjects,
  canonicalEnvRequested,
  manifestPath,
  inline,
  cwd,
  now,
  observedAt,
}) {
  if (!isCanonicalRegistryCandidate(value, rawProjects, canonicalEnvRequested)) return undefined;
  const validationDiagnostics = validateCanonicalRegistry(value, {
    manifestPath,
    now,
    observedAt,
  });
  if (validationDiagnostics.length > 0)
    return {
      manifest: undefined,
      path: manifestPath,
      projects: [],
      registryVersion:
        typeof value.registryVersion === "string" ? value.registryVersion : undefined,
      canonical: true,
      diagnostics: [
        stateRecord({
          source: "project-registry",
          observedAt,
          status: "malformed",
          reason: "canonical_registry_invalid",
          pathOrCommand: manifestPath,
          now,
          rawRefs: [rawRef("registry", "v1", manifestPath)],
        }),
        ...validationDiagnostics,
      ],
    };
  const base = inline ? cwd : dirname(manifestPath);
  return {
    manifest: value,
    path: manifestPath,
    projects: rawProjects.map((project) => canonicalProject(project, manifestPath, base)),
    registryVersion: value.registryVersion,
    correctionProvenance: value.correctionProvenance,
    canonical: true,
    diagnostics: [
      stateRecord({
        source: "project-registry",
        observedAt,
        status: "ok",
        pathOrCommand: manifestPath,
        now,
        rawRefs: [rawRef("registry", "v1", manifestPath)],
      }),
    ],
  };
}

function unsupportedSchemaResult({ value, manifestPath, canonicalEnvRequested, now, observedAt }) {
  const canonical = canonicalEnvRequested || hasRegistryVersionField(value);
  return {
    manifest: undefined,
    path: manifestPath,
    projects: [],
    canonical,
    diagnostics: [
      {
        ...stateRecord({
          source: canonical ? "project-registry" : "project-manifest",
          observedAt,
          status: "malformed",
          reason: "unsupported_schema_version",
          pathOrCommand: manifestPath,
          now,
          rawRefs: [rawRef("manifest", "schema", manifestPath)],
        }),
        schemaVersion: value?.schemaVersion,
      },
    ],
  };
}

/** The only supported Project identity source: an explicit v1 manifest. */
export function loadProjectManifest({
  path,
  cwd = process.cwd(),
  env = process.env,
  readJson = safeReadJson,
  manifestValue,
  now = Date.now(),
} = {}) {
  const canonicalEnvPath = CANONICAL_REGISTRY_ENV_NAMES.map((name) => env[name]).find(Boolean);
  const canonicalEnvRequested =
    manifestValue === undefined && path === undefined && Boolean(canonicalEnvPath);
  const requested =
    path ?? canonicalEnvPath ?? env.PI_TIMELINE_ALPHA_MANIFEST ?? env.HC_ALPHA_MANIFEST;
  const candidates = requested
    ? [resolveSource(requested, cwd)]
    : DEFAULT_MANIFEST_NAMES.map((name) => join(cwd, name));
  const inline = manifestValue !== undefined;
  const manifestPath = inline
    ? (requested ?? "inline")
    : candidates.find((candidate) => candidate && existsSync(candidate));
  const observedAt = nowIso(now);
  if (!manifestPath) {
    return {
      manifest: undefined,
      path: candidates[0],
      projects: [],
      diagnostics: [
        stateRecord({
          source: "project-manifest",
          observedAt,
          status: "missing",
          reason: "manifest_not_found",
          pathOrCommand: candidates[0],
          now,
        }),
      ],
    };
  }
  const result = inline ? { value: manifestValue } : readJson(manifestPath);
  if (result.error) {
    return {
      manifest: undefined,
      path: manifestPath,
      projects: [],
      canonical: canonicalEnvRequested,
      diagnostics: [
        stateRecord({
          source: "project-manifest",
          observedAt,
          status: result.error,
          reason: "manifest_unreadable",
          pathOrCommand: manifestPath,
          now,
          rawRefs: [rawRef("manifest", "v1", manifestPath)],
        }),
      ],
    };
  }
  if (!isObject(result.value) || result.value.schemaVersion !== ALPHA_SCHEMA_VERSION)
    return unsupportedSchemaResult({
      value: result.value,
      manifestPath,
      canonicalEnvRequested,
      now,
      observedAt,
    });
  const rawProjects = normalizeProjects(result.value);
  const canonicalResult = loadCanonicalRegistry({
    value: result.value,
    rawProjects,
    canonicalEnvRequested,
    manifestPath,
    inline,
    cwd,
    now,
    observedAt,
  });
  if (canonicalResult) return canonicalResult;
  const idCounts = new Map();
  for (const project of rawProjects) {
    const id = typeof project?.id === "string" ? project.id.trim() : "";
    if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }
  const manifestDiagnostics = [];
  const projects = rawProjects.flatMap((project, index) => {
    const id = typeof project?.id === "string" ? project.id.trim() : "";
    if (!isObject(project) || !id) {
      manifestDiagnostics.push({
        ...stateRecord({
          source: "project-manifest",
          observedAt,
          status: "malformed",
          reason: "project_id_required",
          pathOrCommand: manifestPath,
          now,
          rawRefs: [rawRef("manifest", `project-${index + 1}`, manifestPath)],
        }),
        projectIndex: index,
      });
      return [];
    }
    if (idCounts.get(id) !== 1) {
      manifestDiagnostics.push({
        ...stateRecord({
          source: "project-manifest",
          observedAt,
          status: "malformed",
          reason: "duplicate_project_id",
          pathOrCommand: manifestPath,
          now,
          rawRefs: [rawRef("manifest", id, manifestPath)],
        }),
        projectId: id,
      });
      return [];
    }
    const base = inline ? cwd : dirname(manifestPath);
    return [
      {
        ...project,
        id,
        name: typeof project.name === "string" && project.name.trim() ? project.name : id,
        repoRoots: Array.isArray(project.repoRoots)
          ? project.repoRoots.map((root) => resolveSource(root, base)).filter(Boolean)
          : [],
        worktreeRoots: Array.isArray(project.worktreeRoots)
          ? project.worktreeRoots.map((root) => resolveSource(root, base)).filter(Boolean)
          : [],
        sessionIds: Array.isArray(project.sessionIds)
          ? project.sessionIds.filter((id) => typeof id === "string")
          : [],
        sessionSelection: isObject(project.sessionSelection)
          ? {
              ...project.sessionSelection,
              sessionIds: uniqueStrings(project.sessionSelection.sessionIds),
              taskIds: uniqueStrings(project.sessionSelection.taskIds),
            }
          : {},
        taskIds: uniqueStrings(project.taskIds),
        manifestPath,
        manifestBase: base,
      },
    ];
  });
  return {
    manifest: result.value,
    path: manifestPath,
    projects,
    registryVersion:
      typeof result.value.registryVersion === "string" ? result.value.registryVersion : undefined,
    correctionProvenance: result.value.correctionProvenance,
    canonical: false,
    diagnostics: [
      stateRecord({
        source: "project-manifest",
        observedAt,
        status: "ok",
        pathOrCommand: manifestPath,
        now,
        rawRefs: [rawRef("manifest", "v1", manifestPath)],
      }),
      ...manifestDiagnostics,
    ],
  };
}

function linesFromJsonl(path, source, now) {
  if (!path || !existsSync(path))
    return {
      records: [],
      rejected: [],
      diagnostic: stateRecord({
        source,
        observedAt: nowIso(now),
        status: "missing",
        reason: "source_not_found",
        pathOrCommand: path,
        now,
        rawRefs: [rawRef(source, "missing", path)],
      }),
    };
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {
      records: [],
      rejected: [],
      diagnostic: stateRecord({
        source,
        observedAt: nowIso(now),
        status: "malformed",
        reason: "source_unreadable",
        pathOrCommand: path,
        now,
      }),
    };
  }
  const observedAt = nowIso(now);
  const records = [];
  const rejected = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (
        value &&
        typeof value === "object" &&
        (value.schemaVersion === undefined || value.schemaVersion === ALPHA_SCHEMA_VERSION)
      )
        records.push({ value, line: index + 1 });
      else if (value && typeof value === "object")
        rejected.push({ line: index + 1, reason: "unsupported_schema_version" });
      else rejected.push({ line: index + 1, reason: "record_not_object" });
    } catch {
      rejected.push({ line: index + 1, reason: "malformed_jsonl" });
    }
  }
  const status = rejected.length ? "partial" : "ok";
  return {
    records,
    diagnostic: {
      ...stateRecord({
        source,
        observedAt,
        status,
        reason: rejected.length ? "partial_source" : undefined,
        pathOrCommand: path,
        now,
        rawRefs: [rawRef(source, hash(text).slice(0, 16), path)],
      }),
      ...(rejected.length ? { rejectedCount: rejected.length, rejected } : {}),
    },
    rejected,
  };
}

function deduplicateRecords(records, source) {
  const seen = new Map();
  const diagnostics = [];
  const result = [];
  for (const record of records) {
    const { _contentHash, _stableId, ...publicRecord } = record;
    if (!_stableId) {
      result.push(publicRecord);
      continue;
    }
    const previous = seen.get(publicRecord.id);
    if (!previous) {
      seen.set(publicRecord.id, { hash: _contentHash, record: publicRecord });
      result.push(publicRecord);
      continue;
    }
    if (previous.hash === _contentHash) {
      diagnostics.push({
        source,
        status: "deduplicated",
        reason: "duplicate_stable_id",
        id: publicRecord.id,
      });
      continue;
    }
    diagnostics.push({
      source,
      status: "ambiguous",
      reason: "conflicting_stable_id",
      id: publicRecord.id,
      refs: [
        ...(previous.record.provenance?.rawRefs ?? []),
        ...(publicRecord.provenance?.rawRefs ?? []),
      ],
    });
    publicRecord.conflict = true;
    publicRecord.provenance = {
      ...publicRecord.provenance,
      confidence: "ambiguous",
    };
    result.push(publicRecord);
  }
  return { records: result, diagnostics };
}

function sourceDiagnostic(parsed, source, extras = {}) {
  const hasConflict = (extras.diagnostics ?? []).some(
    (item) => item.reason === "conflicting_stable_id",
  );
  const status = hasConflict
    ? "ambiguous"
    : parsed.diagnostic.status !== "ok"
      ? parsed.diagnostic.status
      : parsed.rejected.length
        ? "partial"
        : "ok";
  return {
    ...parsed.diagnostic,
    status,
    ...(status === "ok" ? { reason: undefined } : {}),
    ...(extras.diagnostics?.length ? { diagnostics: extras.diagnostics } : {}),
    ...(extras.deduplicatedCount ? { deduplicatedCount: extras.deduplicatedCount } : {}),
    ...(extras.conflictCount ? { conflictCount: extras.conflictCount } : {}),
  };
}

function projectRecordMeta(record, path, source, now, fallbackId) {
  const observedAt = record.observedAt ?? nowIso(now);
  const validAt = record.validAt ?? record.at ?? record.eventTime;
  const id = record.summaryId ?? record.eventId ?? record.id ?? fallbackId;
  const futureTimestamp = isFutureTimestamp(validAt, now);
  return {
    source: { kind: source, instance: record.source?.instance ?? source, rawId: String(id), path },
    validAt,
    observedAt,
    freshness: freshnessFor({ observedAt, validAt, freshness: record.freshness, now }),
    confidence: futureTimestamp
      ? "ambiguous"
      : ["exact", "inferred", "ambiguous"].includes(record.confidence)
        ? record.confidence
        : "exact",
    ...(futureTimestamp ? { reason: "future_timestamp" } : {}),
    derivation: {
      version: record.derivationVersion ?? record.derivation?.version ?? ALPHA_DERIVATION_VERSION,
      inputs: Array.isArray(record.derivation?.inputs) ? record.derivation.inputs : [String(id)],
    },
    rawRefs: [
      rawRef(source, id, path),
      ...(Array.isArray(record.rawRefs)
        ? record.rawRefs.filter((ref) => ref && typeof ref === "object")
        : []),
    ],
  };
}

function projectSummary(record, path, line, now) {
  if (record.type !== "output_summary" && record.type !== "recent_output_summary") return undefined;
  const allowedFields = [
    "progress",
    "findings",
    "questions",
    "questionsRequests",
    "nextStep",
    "summary",
  ];
  const unsupportedFields = Object.entries(record)
    .filter(
      ([key, value]) =>
        key === "value" ||
        (allowedFields.includes(key) && value !== undefined && typeof value !== "string"),
    )
    .map(([key]) => key);
  const summaryFields = Object.fromEntries(
    allowedFields.filter((key) => typeof record[key] === "string").map((key) => [key, record[key]]),
  );
  if (!Object.keys(summaryFields).length)
    return { rejected: [{ line, reason: "summary_fields_required" }] };
  const meta = projectRecordMeta(record, path, "summary", now, `line-${line}`);
  return {
    record: {
      id: String(record.summaryId ?? record.eventId ?? record.id ?? `summary-${line}`),
      observedAt: record.observedAt,
      validAt: record.validAt,
      sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
      projectId: typeof record.projectId === "string" ? record.projectId : undefined,
      ...summaryFields,
      window:
        record.window && typeof record.window === "object"
          ? {
              ...record.window,
              ...(Array.isArray(record.window.selectedMessageIds)
                ? { selectedMessageIds: [...record.window.selectedMessageIds] }
                : {}),
              ...(Array.isArray(record.window.selectedMessages)
                ? {
                    selectedMessages: record.window.selectedMessages.map((message) => ({
                      ...message,
                    })),
                  }
                : {}),
              ...(Array.isArray(record.window.messageIds)
                ? { messageIds: [...record.window.messageIds] }
                : {}),
            }
          : undefined,
      status: record.status ?? "ok",
      provenance: meta,
      _contentHash: contentHash(record),
      _stableId: Boolean(record.summaryId ?? record.eventId ?? record.id),
    },
    ...(unsupportedFields.length
      ? {
          rejected: unsupportedFields.map((reason) => ({
            line,
            reason: `unsupported_field:${reason}`,
          })),
        }
      : {}),
  };
}

function typedProjectPayload(payload, eventKind) {
  if (!isObject(payload)) return undefined;
  const typedKeys = ["task", "commit", "reportedSummary"].filter((key) => isObject(payload[key]));
  if (typedKeys.length === 1 && Object.keys(payload).every((key) => typedKeys.includes(key)))
    return { [typedKeys[0]]: payload[typedKeys[0]] };
  if (eventKind === "intervention" || eventKind === "intervention-assessment")
    return {
      ...(typeof payload.assessment === "string" ? { assessment: payload.assessment } : {}),
      ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
      ...(typeof payload.ownerWatermark === "string"
        ? { ownerWatermark: payload.ownerWatermark }
        : {}),
      ...(typeof payload.label === "string" ? { label: payload.label } : {}),
    };
  return undefined;
}

export function readSummaryJsonl({ path, now = Date.now() } = {}) {
  const parsed = linesFromJsonl(path, "summary", now);
  const rejected = [...parsed.rejected];
  const projected = [];
  for (const { value, line } of parsed.records) {
    const result = projectSummary(value, path, line, now);
    if (!result) {
      rejected.push({ line, reason: "unsupported_record_type" });
      continue;
    }
    if (result.rejected) rejected.push(...result.rejected);
    if (result.record) projected.push(result.record);
  }
  const deduped = deduplicateRecords(projected, "summary");
  const enriched = { ...parsed, rejected };
  return {
    records: deduped.records,
    rejected,
    diagnostic: sourceDiagnostic(enriched, "summary", {
      diagnostics: deduped.diagnostics,
      deduplicatedCount: deduped.diagnostics.filter((item) => item.reason === "duplicate_stable_id")
        .length,
      conflictCount: deduped.diagnostics.filter((item) => item.reason === "conflicting_stable_id")
        .length,
    }),
  };
}

function mergeSourceReads(results, source, now) {
  const diagnostics = results.map((result) => result.diagnostic).filter(Boolean);
  const rejected = results.flatMap((result) => result.rejected ?? []);
  const records = results.flatMap((result) => result.records ?? []);
  const hasAmbiguity = diagnostics.some((diagnostic) => diagnostic.status === "ambiguous");
  const hasPartial = diagnostics.some((diagnostic) =>
    ["partial", "malformed"].includes(diagnostic.status),
  );
  const hasObserved = diagnostics.some((diagnostic) => diagnostic.status === "ok");
  const status = hasAmbiguity
    ? "ambiguous"
    : hasPartial
      ? "partial"
      : hasObserved
        ? "ok"
        : "missing";
  return {
    records,
    rejected,
    diagnostic: {
      ...stateRecord({
        source,
        observedAt: nowIso(now),
        status,
        reason:
          status === "partial"
            ? "partial_source"
            : status === "missing"
              ? "source_not_found"
              : undefined,
        pathOrCommand: diagnostics
          .map((diagnostic) => diagnostic.provenance?.source?.path)
          .filter(Boolean)
          .join(","),
        now,
        rawRefs: diagnostics.flatMap((diagnostic) => diagnostic.provenance?.rawRefs ?? []),
      }),
      sourceCount: results.length,
      ...(rejected.length ? { rejectedCount: rejected.length } : {}),
      ...(diagnostics.length > 1 ? { diagnostics } : {}),
    },
  };
}

function readSummarySources(paths, now) {
  const configured = paths.length ? paths : [undefined];
  return mergeSourceReads(
    configured.map((path) => readSummaryJsonl({ path, now })),
    "summary",
    now,
  );
}

export function readProjectEvents({ path, now = Date.now() } = {}) {
  const parsed = linesFromJsonl(path, "project-events", now);
  const rejected = [...parsed.rejected];
  const projected = parsed.records.flatMap(({ value, line }) => {
    if (value.type !== "project_event" && value.type !== "intervention" && value.type !== "event") {
      rejected.push({ line, reason: "unsupported_record_type" });
      return [];
    }
    const meta = projectRecordMeta(value, path, "project-events", now, `line-${line}`);
    return [
      {
        id: String(value.eventId ?? value.id ?? `event-${line}`),
        projectId: typeof value.projectId === "string" ? value.projectId : undefined,
        eventKind: value.eventKind ?? value.kind ?? "unknown",
        at: value.at ?? value.validAt ?? value.eventTime,
        validAt: value.validAt ?? value.at ?? value.eventTime,
        observedAt: value.observedAt,
        ownerWatermark: value.ownerWatermark ?? value.payload?.ownerWatermark,
        payload: typedProjectPayload(value.payload, value.eventKind ?? value.kind),
        provenance: meta,
        _contentHash: contentHash(value),
        _stableId: Boolean(value.eventId ?? value.id),
      },
    ];
  });
  const deduped = deduplicateRecords(projected, "project-events");
  const enriched = { ...parsed, rejected };
  return {
    records: deduped.records,
    rejected,
    diagnostic: sourceDiagnostic(enriched, "project-events", {
      diagnostics: deduped.diagnostics,
      deduplicatedCount: deduped.diagnostics.filter((item) => item.reason === "duplicate_stable_id")
        .length,
      conflictCount: deduped.diagnostics.filter((item) => item.reason === "conflicting_stable_id")
        .length,
    }),
  };
}

function proposalMetadataRecord(metadata, metadataPath, now, statusOverride) {
  const citationStatus = metadata.synthesis?.citationStatus?.status;
  const citationPartial = !statusOverride && citationStatus === "partial";
  const status = statusOverride ?? (citationPartial ? "partial" : metadata.status) ?? "unknown";
  const sourceProvenance = projectRecordMeta(
    metadata,
    metadataPath,
    "evergreen",
    now,
    metadataPath,
  );
  return {
    id: String(metadata.proposalId ?? metadata.revisionId ?? metadata.id ?? metadataPath),
    projectId: typeof metadata.projectId === "string" ? metadata.projectId : undefined,
    status,
    baseHash: metadata.baseHash,
    sourceFrontierHash: metadata.sourceFrontierHash,
    revisionId: metadata.revisionId,
    changeCount: Number(
      metadata.changeCount ?? metadata.changeRecords?.length ?? metadata.eventIds?.length ?? 0,
    ),
    changeRecords: Array.isArray(metadata.changeRecords)
      ? metadata.changeRecords.flatMap((change) =>
          change && typeof change === "object"
            ? [{ id: change.id, kind: change.kind, label: change.label }]
            : [],
        )
      : [],
    ownerWatermark: metadata.ownerWatermark,
    synthesis:
      metadata.synthesis && typeof metadata.synthesis === "object"
        ? {
            status: metadata.synthesis.status,
            promptVersion: metadata.synthesis.promptVersion,
            model: metadata.synthesis.model,
            inputHash: metadata.synthesis.inputHash,
            outputHash: metadata.synthesis.outputHash,
            eventIds: Array.isArray(metadata.synthesis.eventIds)
              ? metadata.synthesis.eventIds.filter((id) => typeof id === "string")
              : [],
            citationStatus: {
              status: citationStatus,
              diagnostics: Array.isArray(metadata.synthesis.citationStatus?.diagnostics)
                ? metadata.synthesis.citationStatus.diagnostics.map((diagnostic) => ({
                    reason: diagnostic?.reason,
                    section: diagnostic?.section,
                    eventId: diagnostic?.eventId,
                  }))
                : [],
            },
          }
        : undefined,
    provenance: citationPartial
      ? { ...sourceProvenance, confidence: "ambiguous", reason: "synthesis_citations_partial" }
      : sourceProvenance,
    _contentHash: contentHash(metadata),
    _stableId: Boolean(metadata.proposalId ?? metadata.revisionId ?? metadata.id),
  };
}

function readProposalDirectory(path, now) {
  const records = [];
  const rejected = [];
  try {
    for (const entry of readdirSync(path).sort()) {
      const bundlePath = join(path, entry);
      const info = lstatSync(bundlePath);
      if (info.isSymbolicLink()) {
        rejected.push({ bundle: entry, reason: "symlink_bundle" });
        continue;
      }
      if (!info.isDirectory()) continue;
      const metadataPath = join(bundlePath, "metadata.json");
      let metadata;
      try {
        if (!lstatSync(metadataPath).isFile()) throw new Error("metadata is not a regular file");
        metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      } catch (error) {
        rejected.push({
          bundle: entry,
          reason: "partial_or_corrupt_bundle",
          detail: error.message,
        });
        continue;
      }
      const requiredMetadata = [
        "schemaVersion",
        "type",
        "status",
        "proposalId",
        "projectId",
        "baseHash",
        "sourceFrontierHash",
        "artifactHashes",
      ];
      if (
        !metadata ||
        typeof metadata !== "object" ||
        Array.isArray(metadata) ||
        requiredMetadata.some((field) => metadata[field] === undefined)
      ) {
        rejected.push({ bundle: entry, reason: "corrupt_bundle_metadata" });
        continue;
      }
      const missing = ["proposal.md", "proposal.patch"].filter((name) => {
        try {
          return !lstatSync(join(bundlePath, name)).isFile();
        } catch {
          return true;
        }
      });
      if (missing.length) {
        rejected.push({ bundle: entry, reason: "partial_bundle", missing });
        records.push(proposalMetadataRecord(metadata, metadataPath, now, "partial"));
        continue;
      }
      const hashMismatch = ["proposal.md", "proposal.patch"].some((name) => {
        const expected = metadata.artifactHashes?.[name === "proposal.md" ? "markdown" : "patch"];
        return (
          typeof expected === "string" &&
          expected !== hash(readFileSync(join(bundlePath, name), "utf8"))
        );
      });
      if (hashMismatch) {
        rejected.push({ bundle: entry, reason: "corrupt_bundle_hash" });
        records.push(proposalMetadataRecord(metadata, metadataPath, now, "corrupt"));
        continue;
      }
      records.push(proposalMetadataRecord(metadata, metadataPath, now));
    }
  } catch (error) {
    rejected.push({ reason: "proposal_directory_unreadable", detail: error.message });
  }
  const deduped = deduplicateRecords(records, "evergreen");
  const status = rejected.length
    ? deduped.records.some((record) => record.status === "corrupt")
      ? "ambiguous"
      : "partial"
    : deduped.records.length
      ? "ok"
      : "missing";
  return {
    records: deduped.records,
    rejected,
    diagnostic: {
      ...stateRecord({
        source: "evergreen",
        observedAt: nowIso(now),
        status,
        reason: rejected.length
          ? "partial_or_corrupt_bundle"
          : deduped.records.length
            ? undefined
            : "no_proposal_bundles",
        pathOrCommand: path,
        now,
        rawRefs: [rawRef("evergreen", hash(path).slice(0, 16), path)],
      }),
      ...(rejected.length ? { rejectedCount: rejected.length, rejected } : {}),
      ...(deduped.diagnostics.length ? { diagnostics: deduped.diagnostics } : {}),
    },
  };
}

export function readEvergreenProposals({ path, now = Date.now() } = {}) {
  if (path && existsSync(path)) {
    try {
      if (statSync(path).isDirectory()) return readProposalDirectory(path, now);
    } catch {
      // The normal JSONL path below retains the existing malformed/unavailable state.
    }
  }
  const parsed = linesFromJsonl(path, "evergreen", now);
  const rejected = [...parsed.rejected];
  const projected = parsed.records.flatMap(({ value, line }) => {
    if (value.type !== "evergreen_proposal" && value.type !== "evergreen_revision") {
      rejected.push({ line, reason: "unsupported_record_type" });
      return [];
    }
    return [
      {
        id: String(value.proposalId ?? value.revisionId ?? value.id ?? `proposal-${line}`),
        projectId: typeof value.projectId === "string" ? value.projectId : undefined,
        status: value.status ?? "proposed",
        baseHash: value.baseHash,
        revisionId: value.revisionId,
        changeCount: Number(value.changeCount ?? 0),
        changeRecords: Array.isArray(value.changeRecords)
          ? value.changeRecords.flatMap((change) =>
              change && typeof change === "object"
                ? [{ id: change.id, kind: change.kind, label: change.label }]
                : [],
            )
          : [],
        ownerWatermark: value.ownerWatermark,
        provenance: projectRecordMeta(value, path, "evergreen", now, `line-${line}`),
        _contentHash: contentHash(value),
        _stableId: Boolean(value.proposalId ?? value.revisionId ?? value.id),
      },
    ];
  });
  const deduped = deduplicateRecords(projected, "evergreen");
  const enriched = { ...parsed, rejected };
  return {
    records: deduped.records,
    rejected,
    diagnostic: sourceDiagnostic(enriched, "evergreen", {
      diagnostics: deduped.diagnostics,
      deduplicatedCount:
        projected.length -
        deduped.records.length -
        deduped.diagnostics.filter((item) => item.reason === "conflicting_stable_id").length,
      conflictCount: deduped.diagnostics.filter((item) => item.reason === "conflicting_stable_id")
        .length,
    }),
  };
}

export function readCanonicalMarkdown({ path, now = Date.now() } = {}) {
  const observedAt = nowIso(now);
  if (!path || !existsSync(path))
    return {
      record: undefined,
      diagnostic: stateRecord({
        source: "markdown",
        observedAt,
        status: "missing",
        reason: "canonical_markdown_not_found",
        pathOrCommand: path,
        now,
      }),
    };
  try {
    const text = readFileSync(path, "utf8");
    const stat = statSync(path);
    const revisionId = hash(text);
    const futureTimestamp = isFutureTimestamp(stat.mtime.toISOString(), now);
    return {
      record: {
        revisionId,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        provenance: provenance({
          source: { kind: "markdown", instance: "canonical", rawId: revisionId, path },
          observedAt,
          validAt: stat.mtime.toISOString(),
          freshness: freshnessFor({ validAt: stat.mtime.toISOString(), now }),
          confidence: futureTimestamp ? "ambiguous" : "exact",
          ...(futureTimestamp ? { reason: "future_timestamp" } : {}),
          inputs: [revisionId],
          rawRefs: [rawRef("markdown", revisionId, path)],
        }),
      },
      diagnostic: stateRecord({
        source: "markdown",
        observedAt,
        status: futureTimestamp ? "ambiguous" : "ok",
        reason: futureTimestamp ? "future_timestamp" : undefined,
        pathOrCommand: path,
        now,
        rawRefs: [rawRef("markdown", revisionId, path)],
      }),
    };
  } catch {
    return {
      record: undefined,
      diagnostic: stateRecord({
        source: "markdown",
        observedAt,
        status: "malformed",
        reason: "canonical_markdown_unreadable",
        pathOrCommand: path,
        now,
      }),
    };
  }
}

function parseBdJson(text) {
  try {
    const value = JSON.parse(text);
    if (Array.isArray(value)) return value;
    if (Array.isArray(value?.issues)) return value.issues;
    return value && typeof value === "object" ? [value] : [];
  } catch {
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) return [];
    try {
      return lines.map((line) => JSON.parse(line));
    } catch {
      return undefined;
    }
  }
}

export function readBeads({ root, run = execFileSync, timeoutMs = 2_500, now = Date.now() } = {}) {
  const observedAt = nowIso(now);
  const command = ["bd", "-C", root, "export", "--readonly", "--json"];
  if (!root)
    return {
      tasks: [],
      diagnostic: stateRecord({
        source: "beads",
        observedAt,
        status: "missing",
        reason: "beads_root_not_configured",
        pathOrCommand: command.join(" "),
        now,
      }),
    };
  let output;
  try {
    output = String(
      run("bd", command.slice(1), {
        encoding: "utf8",
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (error) {
    return {
      tasks: [],
      diagnostic: {
        ...stateRecord({
          source: "beads",
          observedAt,
          status: "unavailable",
          reason: error?.code === "ETIMEDOUT" ? "command_timeout" : "command_failed",
          pathOrCommand: command.join(" "),
          now,
        }),
        code: typeof error?.code === "string" ? error.code : undefined,
      },
    };
  }
  const issues = parseBdJson(output);
  if (!issues)
    return {
      tasks: [],
      diagnostic: stateRecord({
        source: "beads",
        observedAt,
        status: "malformed",
        reason: "invalid_json",
        pathOrCommand: command.join(" "),
        now,
      }),
    };
  const projectedTasks = issues.flatMap((issue, index) => {
    if (!issue || typeof issue !== "object" || typeof issue.id !== "string") return [];
    const id = issue.id;
    return [
      {
        id,
        title: typeof issue.title === "string" ? issue.title : "",
        projectId: typeof issue.projectId === "string" ? issue.projectId : issue.project_id,
        type: issue.issue_type ?? issue.type,
        status: issue.status,
        priority: issue.priority,
        assignee: issue.assignee,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
        labels: Array.isArray(issue.labels)
          ? issue.labels.filter((label) => typeof label === "string")
          : [],
        dependencies: Array.isArray(issue.dependencies)
          ? issue.dependencies
              .map((dependency) => (typeof dependency === "string" ? dependency : dependency?.id))
              .filter(Boolean)
          : [],
        dependencyCount: Number(issue.dependency_count ?? issue.dependencies_count ?? 0),
        acceptance:
          typeof issue.acceptance_criteria === "string" ? issue.acceptance_criteria : undefined,
        delivery:
          issue.delivery && typeof issue.delivery === "object"
            ? {
                artifact: issue.delivery.artifact,
                deliveredAt: issue.delivery.deliveredAt,
                evidence: issue.delivery.evidence,
              }
            : undefined,
        provenance: provenance({
          source: { kind: "beads", instance: root, rawId: id, path: command.join(" ") },
          observedAt,
          validAt: issue.updated_at ?? issue.created_at,
          freshness: freshnessFor({
            observedAt,
            validAt: issue.updated_at ?? issue.created_at,
            now,
          }),
          confidence: "exact",
          inputs: [id, String(index)],
          rawRefs: [rawRef("beads", id, command.join(" "))],
        }),
        _contentHash: contentHash(issue),
        _stableId: true,
      },
    ];
  });
  const deduped = deduplicateRecords(projectedTasks, "beads");
  const futureTask = deduped.records.some((task) => task.provenance.reason === "future_timestamp");
  return {
    tasks: deduped.records,
    diagnostic: {
      ...stateRecord({
        source: "beads",
        observedAt,
        status:
          deduped.diagnostics.some((item) => item.reason === "conflicting_stable_id") || futureTask
            ? "ambiguous"
            : "ok",
        reason: deduped.diagnostics.some((item) => item.reason === "conflicting_stable_id")
          ? "conflicting_stable_id"
          : futureTask
            ? "future_timestamp"
            : undefined,
        pathOrCommand: command.join(" "),
        now,
        rawRefs: [rawRef("beads", hash(output).slice(0, 16), command.join(" "))],
      }),
      ...(deduped.diagnostics.length ? { diagnostics: deduped.diagnostics } : {}),
      sourceCount: deduped.records.length,
      ...(deduped.diagnostics.filter((item) => item.reason === "duplicate_stable_id").length
        ? {
            deduplicatedCount: deduped.diagnostics.filter(
              (item) => item.reason === "duplicate_stable_id",
            ).length,
          }
        : {}),
      ...(deduped.diagnostics.filter((item) => item.reason === "conflicting_stable_id").length
        ? {
            conflictCount: deduped.diagnostics.filter(
              (item) => item.reason === "conflicting_stable_id",
            ).length,
          }
        : {}),
    },
  };
}

function projectSourcePaths(project, cwd) {
  const base = project.manifestBase ?? cwd;
  const locations = project.locations ?? {};
  const legacySummaries = configuredList(
    project.summaryPath ?? project.sources?.summaryPath ?? project.summary?.path,
  );
  return {
    summaries: locations.summaries?.length
      ? locations.summaries
      : resolveConfiguredList(legacySummaries, base),
    events:
      locations.events ??
      configuredPath(
        project,
        "eventsPath",
        project.eventStreamPath ?? project.distiller?.eventsPath,
      ),
    proposals:
      locations.proposalDir ??
      configuredPath(
        project,
        "evergreenProposalsPath",
        project.evergreen?.proposalsPath ?? project.distiller?.evergreenProposalsPath,
      ),
    markdown:
      locations.evergreen ??
      configuredPath(project, "evergreenPath", project.canonicalEvergreenPath),
    beads: locations.beadsRoot ?? resolveSource(project.beadsRoot ?? project.beads?.root, base),
  };
}

function configuredSessionIds(project) {
  return uniqueStrings([
    ...(project.sessionIds ?? []),
    ...(project.sessionSelection?.sessionIds ?? []),
  ]);
}

function buildAssociationIndex(projects) {
  const sessions = new Map();
  const tasks = new Map();
  const add = (map, key, projectId) => {
    if (!key) return;
    const ids = map.get(key) ?? new Set();
    ids.add(projectId);
    map.set(key, ids);
  };
  for (const project of projects) {
    for (const sessionId of configuredSessionIds(project)) add(sessions, sessionId, project.id);
    for (const taskId of [...(project.taskIds ?? []), ...(project.sessionSelection?.taskIds ?? [])])
      add(tasks, taskId, project.id);
  }
  return { sessions, tasks, projects };
}

function associationBySession(project, record, index) {
  const sessionId = record?.sessionId;
  if (!sessionId) return undefined;
  const sessionProjects = [...(index.sessions.get(sessionId) ?? [])];
  if (sessionProjects.length > 1)
    return {
      matched: false,
      ambiguous: true,
      confidence: "ambiguous",
      reason: "overlapping_session_association",
    };
  if (sessionProjects[0] === project.id)
    return { matched: true, confidence: "exact", reason: "manifest_session_id" };
  return undefined;
}

function associationForRecord(project, record, _baseSnapshot, index) {
  if (record?.projectId)
    return record.projectId === project.id
      ? { matched: true, confidence: "exact", reason: "record_project_id" }
      : { matched: false };
  return (
    associationBySession(project, record, index) ?? {
      matched: false,
      ambiguous: true,
      confidence: "ambiguous",
      reason: "no_explicit_record_association",
    }
  );
}

function associationForRuntime(project, runtime, _baseSnapshot, index) {
  const id = runtime.sessionId;
  const sessionProjects = [...(index.sessions.get(id) ?? [])];
  if (sessionProjects.length > 1)
    return {
      matched: false,
      ambiguous: true,
      confidence: "ambiguous",
      reason: "overlapping_session_association",
    };
  if (sessionProjects[0] === project.id)
    return { matched: true, confidence: "exact", reason: "manifest_session_id" };
  return { matched: false, confidence: "ambiguous", reason: "no_explicit_runtime_association" };
}

function axisMeta(source, observedAt, inputs, rawRefs, now, validAt) {
  const futureTimestamp = isFutureTimestamp(validAt, now);
  return provenance({
    source,
    observedAt,
    validAt,
    freshness: freshnessFor({ observedAt, validAt, now }),
    confidence: futureTimestamp ? "ambiguous" : "exact",
    ...(futureTimestamp ? { reason: "future_timestamp" } : {}),
    inputs,
    rawRefs,
  });
}

function unknownAxis(kind, reason, observedAt) {
  return {
    state: "unknown",
    reason,
    provenance: provenance({
      source: { kind, instance: "alpha", rawId: reason },
      observedAt,
      freshness: "unknown",
      confidence: "ambiguous",
      inputs: [reason],
      rawRefs: [],
    }),
  };
}

function sourceStatus(diagnostic, hasRecords, ambiguous = false) {
  if (ambiguous) return "ambiguous";
  if (diagnostic?.status === "ambiguous") return "ambiguous";
  if (diagnostic?.status === "partial") return "partial";
  if (hasRecords) return "observed";
  return "unknown";
}

function sourceReason(diagnostic, fallback) {
  return diagnostic?.reason === "partial_source" ? "partial_source" : fallback;
}

function aggregateProvenance(source, records, now, fallbackId) {
  const refs = records.flatMap((record) => record.provenance?.rawRefs ?? []);
  const inputs = records.flatMap((record) => record.provenance?.derivation?.inputs ?? []);
  const first = records[0]?.provenance;
  const confidence = records.some((record) => record.provenance?.confidence === "ambiguous")
    ? "ambiguous"
    : records.some((record) => record.provenance?.confidence === "inferred")
      ? "inferred"
      : "exact";
  return provenance({
    source: { kind: source, instance: "alpha", rawId: fallbackId },
    observedAt: nowIso(now),
    validAt: records.at(-1)?.provenance?.validAt,
    freshness: first?.freshness ?? "unknown",
    confidence,
    inputs: [...new Set(inputs.length ? inputs : [fallbackId])],
    rawRefs: [...new Map(refs.map((ref) => [`${ref.kind}:${ref.id}`, ref])).values()],
  });
}

function reconcileEvergreenProposalBases(records, canonicalRevision, now) {
  if (!canonicalRevision?.revisionId) return { records, mismatches: [] };
  const mismatches = [];
  const reconciled = records.map((record) => {
    if (typeof record.baseHash !== "string" || record.baseHash === canonicalRevision.revisionId)
      return record;
    const sourceProvenance = record.provenance;
    const rawRefs = [...sourceProvenance.rawRefs, ...canonicalRevision.provenance.rawRefs];
    const comparisonProvenance = provenance({
      source: {
        kind: "evergreen",
        instance: "alpha-base-comparison",
        rawId: record.id,
      },
      observedAt: nowIso(now),
      validAt: canonicalRevision.provenance.validAt,
      freshness: canonicalRevision.provenance.freshness,
      confidence:
        sourceProvenance.confidence === "ambiguous" ||
        canonicalRevision.provenance.confidence === "ambiguous"
          ? "ambiguous"
          : "exact",
      reason: "canonical_base_mismatch",
      inputs: [record.baseHash, canonicalRevision.revisionId],
      rawRefs: [...new Map(rawRefs.map((ref) => [`${ref.kind}:${ref.id}`, ref])).values()],
    });
    const reconciledRecord = {
      ...record,
      storedStatus: record.status,
      ...(record.status === "proposed" ? { status: "stale" } : {}),
      baseState: "mismatch",
      reason: "canonical_base_mismatch",
      baseComparison: {
        proposalBaseHash: record.baseHash,
        canonicalRevisionId: canonicalRevision.revisionId,
        proposalRefs: sourceProvenance.rawRefs,
        canonicalRevisionRefs: canonicalRevision.provenance.rawRefs,
        provenance: comparisonProvenance,
      },
      sourceProvenance,
      provenance: comparisonProvenance,
    };
    mismatches.push(reconciledRecord);
    return reconciledRecord;
  });
  return { records: reconciled, mismatches };
}

function axisWithState(axis, diagnostic, hasRecords, ambiguous = false, reason) {
  const state = sourceStatus(diagnostic, hasRecords, ambiguous);
  return {
    ...axis,
    state,
    ...(state === "unknown" || state === "partial" || state === "ambiguous"
      ? { reason: reason ?? sourceReason(diagnostic, axis.reason) }
      : {}),
    ...(diagnostic ? { diagnostics: [diagnostic] } : {}),
  };
}

function configuredPath(project, key, fallback) {
  const value = project[key] ?? project.sources?.[key] ?? fallback;
  return resolveSource(value, project.manifestBase ?? process.cwd());
}

export function collectAlphaSnapshot({
  baseSnapshot = {},
  manifestPath,
  manifest,
  cwd = process.cwd(),
  now = Date.now(),
  runBd = execFileSync,
} = {}) {
  const observedAt = nowIso(now);
  const loaded = loadProjectManifest({ path: manifestPath, manifestValue: manifest, cwd, now });
  const associationIndex = buildAssociationIndex(loaded.projects);
  const projectDiagnostics = [];
  // This mapper intentionally keeps all seven independently-provenanced axes together at the
  // projection boundary; the adapters above remain separately testable.
  // eslint-disable-next-line complexity, sonarjs/cognitive-complexity
  const projects = loaded.projects.map((project) => {
    const sourcePaths = projectSourcePaths(project, cwd);
    const summaries = readSummarySources(sourcePaths.summaries, now);
    const events = readProjectEvents({
      path: sourcePaths.events,
      now,
    });
    const evergreen = readEvergreenProposals({
      path: sourcePaths.proposals,
      now,
    });
    const markdown = readCanonicalMarkdown({
      path: sourcePaths.markdown,
      now,
    });
    const beads = readBeads({
      root: sourcePaths.beads,
      run: runBd,
      now,
    });
    const projectAssociationDiagnostics = [];
    for (const [kind, map] of [
      ["session", associationIndex.sessions],
      ["task", associationIndex.tasks],
    ]) {
      for (const [value, projectIds] of map) {
        if (projectIds.has(project.id) && projectIds.size > 1)
          projectAssociationDiagnostics.push(
            projectDiagnostic(project.id, kind, `overlapping_${kind}_association`, {
              value,
              projectIds: [...projectIds],
            }),
          );
      }
    }
    const projectSummaries = [];
    for (const record of summaries.records) {
      const association = associationForRecord(project, record, baseSnapshot, associationIndex);
      if (association.ambiguous)
        projectAssociationDiagnostics.push(
          projectDiagnostic(project.id, "summary", association.reason, {
            value: record.id,
            refs: record.provenance.rawRefs,
          }),
        );
      else if (association.matched) projectSummaries.push(record);
    }
    const projectEvents = [];
    for (const record of events.records) {
      const association = associationForRecord(project, record, baseSnapshot, associationIndex);
      if (association.ambiguous)
        projectAssociationDiagnostics.push(
          projectDiagnostic(project.id, "project-events", association.reason, {
            value: record.id,
            refs: record.provenance.rawRefs,
          }),
        );
      else if (association.matched) projectEvents.push(record);
    }
    const associatedEvergreen = [];
    for (const record of evergreen.records) {
      const association = associationForRecord(project, record, baseSnapshot, associationIndex);
      if (association.ambiguous)
        projectAssociationDiagnostics.push(
          projectDiagnostic(project.id, "evergreen", association.reason, {
            value: record.id,
            refs: record.provenance.rawRefs,
          }),
        );
      else if (association.matched) associatedEvergreen.push(record);
    }
    const reconciledEvergreen = reconcileEvergreenProposalBases(
      associatedEvergreen,
      markdown.record,
      now,
    );
    const projectEvergreen = reconciledEvergreen.records;
    for (const record of reconciledEvergreen.mismatches)
      projectAssociationDiagnostics.push(
        projectDiagnostic(project.id, "evergreen", "canonical_base_mismatch", {
          value: record.id,
          proposalBaseHash: record.baseComparison.proposalBaseHash,
          canonicalRevisionId: record.baseComparison.canonicalRevisionId,
          refs: record.provenance.rawRefs,
        }),
      );
    const runtimes = (baseSnapshot.liveAgents ?? [])
      .map((runtime) => ({
        runtime,
        association: associationForRuntime(project, runtime, baseSnapshot, associationIndex),
      }))
      .filter(({ association }) => association.matched)
      .map(({ runtime }) => ({
        processInstanceId: runtime.processInstanceId,
        sessionId: runtime.sessionId,
        state: runtime.state,
        pid: runtime.pid,
        cwd: runtime.cwd,
        heartbeatAt: runtime.heartbeatAt,
        model: runtime.model,
        provenance: axisMeta(
          { kind: "timeline-runtime", instance: "base-snapshot", rawId: runtime.processInstanceId },
          observedAt,
          [runtime.processInstanceId],
          [rawRef("timeline", runtime.processInstanceId)],
          now,
          runtime.heartbeatAt,
        ),
      }));
    const ambiguousRuntime = (baseSnapshot.liveAgents ?? []).some(
      (runtime) =>
        associationForRuntime(project, runtime, baseSnapshot, associationIndex).ambiguous,
    );
    if (ambiguousRuntime)
      projectAssociationDiagnostics.push(
        projectDiagnostic(project.id, "timeline-runtime", "overlapping_session_association"),
      );
    const hasConfiguredSessionIds = configuredSessionIds(project).length > 0;
    const runtimeFuture = runtimes.some(
      (runtime) => runtime.provenance.reason === "future_timestamp",
    );
    const runtimeAxis = axisWithState(
      runtimes.length
        ? { items: runtimes, provenance: runtimes[0].provenance }
        : unknownAxis(
            "timeline-runtime",
            hasConfiguredSessionIds
              ? "no_current_runtime_observation"
              : "no_explicit_runtime_association",
            observedAt,
          ),
      undefined,
      runtimes.length > 0,
      ambiguousRuntime || runtimeFuture,
      runtimeFuture ? "future_timestamp" : undefined,
    );
    const summaryFuture = projectSummaries.some(
      (record) => record.provenance.reason === "future_timestamp",
    );
    const outputAxis = axisWithState(
      projectSummaries.length
        ? {
            items: projectSummaries,
            provenance: aggregateProvenance("summary", projectSummaries, now, project.id),
          }
        : unknownAxis("summary", "no_summary_records", observedAt),
      summaries.diagnostic,
      projectSummaries.length > 0,
      summaryFuture ||
        projectAssociationDiagnostics.some(
          (diagnostic) =>
            diagnostic.source === "summary" && diagnostic.reason?.startsWith("overlapping_"),
        ),
      summaryFuture ? "future_timestamp" : undefined,
    );
    const interventionRecords = projectEvents.filter(
      (record) =>
        record.eventKind === "intervention" || record.eventKind === "intervention-assessment",
    );
    const interventionAxis = axisWithState(
      interventionRecords.length
        ? {
            items: interventionRecords.map((record) => ({
              assessment: record.payload?.assessment ?? record.payload?.label ?? "unknown",
              reason: record.payload?.reason,
              provenance: record.provenance,
            })),
            provenance: aggregateProvenance(
              "project-events",
              interventionRecords,
              now,
              `${project.id}:intervention`,
            ),
          }
        : unknownAxis("intervention", "no_intervention_assessment", observedAt),
      events.diagnostic,
      interventionRecords.length > 0,
      interventionRecords.some((record) => record.provenance.reason === "future_timestamp"),
    );
    const ownerAnchorEvent = projectEvents
      .filter(
        (event) =>
          typeof event.ownerWatermark === "string" &&
          Number.isFinite(Date.parse(event.ownerWatermark)),
      )
      .sort((left, right) => Date.parse(left.ownerWatermark) - Date.parse(right.ownerWatermark))
      .at(-1);
    const ownerWatermark = ownerAnchorEvent?.ownerWatermark;
    const eventWindow = ownerWatermark
      ? projectEvents.filter(
          (event) =>
            typeof event.at === "string" && Date.parse(event.at) > Date.parse(ownerWatermark),
        )
      : projectEvents;
    const eventCountProvenance = aggregateProvenance(
      "project-events",
      eventWindow,
      now,
      `${project.id}:count`,
    );
    const latestEvent = projectEvents
      .filter((event) => typeof event.at === "string" && Number.isFinite(Date.parse(event.at)))
      .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
      .at(-1);
    const eventAxis = axisWithState(
      projectEvents.length
        ? {
            count: eventWindow.length,
            countRefs: eventCountProvenance.rawRefs,
            countProvenance: eventCountProvenance,
            items: eventWindow,
            window: {
              kind: ownerWatermark ? "since-owner-watermark" : "all-recorded",
              ...(ownerWatermark ? { ownerWatermark } : {}),
              ...(latestEvent?.at ? { latestEventAt: latestEvent.at } : {}),
            },
            ...(ownerWatermark
              ? {
                  ownerWatermark,
                  ownerWatermarkRefs: ownerAnchorEvent.provenance.rawRefs ?? [],
                  ownerWatermarkProvenance: ownerAnchorEvent.provenance,
                }
              : {}),
            latestEventAt: latestEvent?.at,
            latestEventAtRefs: latestEvent?.provenance.rawRefs ?? [],
            latestEventAtProvenance: latestEvent?.provenance,
            provenance: eventCountProvenance,
          }
        : unknownAxis("project-events", "no_project_events", observedAt),
      events.diagnostic,
      projectEvents.length > 0,
      projectEvents.some((record) => record.provenance.reason === "future_timestamp") ||
        projectAssociationDiagnostics.some(
          (diagnostic) =>
            diagnostic.source === "project-events" && diagnostic.reason?.startsWith("overlapping_"),
        ),
    );
    const changeCountProvenance = aggregateProvenance(
      "evergreen",
      projectEvergreen,
      now,
      `${project.id}:change-count`,
    );
    const evergreenAxis = axisWithState(
      projectEvergreen.length || markdown.record
        ? {
            proposals: projectEvergreen,
            canonicalRevision: markdown.record
              ? {
                  revisionId: markdown.record.revisionId,
                  size: markdown.record.size,
                  modifiedAt: markdown.record.modifiedAt,
                  provenance: markdown.record.provenance,
                  refs: markdown.record.provenance.rawRefs,
                }
              : undefined,
            changeCount: projectEvergreen.reduce(
              (sum, item) => sum + (item.status === "proposed" ? item.changeCount : 0),
              0,
            ),
            staleChangeCount: projectEvergreen.reduce(
              (sum, item) => sum + (item.status === "stale" ? item.changeCount : 0),
              0,
            ),
            changeCountRefs: changeCountProvenance.rawRefs,
            changeCountProvenance,
            provenance:
              projectEvergreen[0]?.provenance ??
              markdown.record?.provenance ??
              changeCountProvenance,
          }
        : unknownAxis("evergreen", "no_evergreen_source", observedAt),
      markdown.diagnostic,
      Boolean(projectEvergreen.length || markdown.record),
      projectEvergreen.some((record) => record.provenance.reason === "future_timestamp") ||
        projectEvergreen.some(
          (record) => record.provenance.reason === "synthesis_citations_partial",
        ) ||
        markdown.record?.provenance.reason === "future_timestamp" ||
        reconciledEvergreen.mismatches.length > 0 ||
        projectAssociationDiagnostics.some(
          (diagnostic) =>
            diagnostic.source === "evergreen" && diagnostic.reason?.startsWith("overlapping_"),
        ),
      reconciledEvergreen.mismatches.length
        ? "canonical_base_mismatch"
        : projectEvergreen.some(
              (record) => record.provenance.reason === "synthesis_citations_partial",
            )
          ? "synthesis_citations_partial"
          : markdown.record?.provenance.reason === "future_timestamp"
            ? "future_timestamp"
            : undefined,
    );
    const projectTasks = [];
    for (const task of beads.tasks) {
      let association;
      const selectedTaskProjects = [...(associationIndex.tasks.get(task.id) ?? [])];
      if (
        selectedTaskProjects.length > 1 &&
        (selectedTaskProjects.includes(project.id) || task.projectId === project.id)
      ) {
        association = {
          matched: false,
          ambiguous: true,
          confidence: "ambiguous",
          reason: "overlapping_task_association",
        };
      } else if (task.projectId) {
        association =
          task.projectId === project.id
            ? { matched: true, confidence: "exact", reason: "task_project_id" }
            : { matched: false };
      } else {
        if (selectedTaskProjects.length > 1)
          association = {
            matched: false,
            ambiguous: true,
            confidence: "ambiguous",
            reason: "overlapping_task_association",
          };
        else if (selectedTaskProjects[0] === project.id)
          association = { matched: true, confidence: "exact", reason: "manifest_task_id" };
        else association = { matched: false };
      }
      if (association.ambiguous)
        projectAssociationDiagnostics.push(
          projectDiagnostic(project.id, "beads", association.reason, {
            value: task.id,
            refs: task.provenance.rawRefs,
          }),
        );
      else if (association.matched) projectTasks.push(task);
    }
    const workLedger = axisWithState(
      projectTasks.length
        ? {
            tasks: projectTasks,
            provenance: aggregateProvenance("beads", projectTasks, now, project.id),
          }
        : unknownAxis(
            "beads",
            beads.tasks.length ? "no_associated_beads_tasks" : "no_beads_tasks",
            observedAt,
          ),
      beads.diagnostic,
      projectTasks.length > 0,
      projectAssociationDiagnostics.some(
        (diagnostic) =>
          diagnostic.source === "beads" && diagnostic.reason?.startsWith("overlapping_"),
      ) || projectTasks.some((task) => task.provenance.reason === "future_timestamp"),
      projectTasks.some((task) => task.provenance.reason === "future_timestamp")
        ? "future_timestamp"
        : undefined,
    );
    const deliveryItems = projectTasks.filter(
      (task) => task.delivery || ["delivered", "closed", "done"].includes(task.status),
    );
    const delivery =
      deliveryItems.length || markdown.record
        ? {
            evidence: deliveryItems.map((task) => ({
              id: task.id,
              status: task.status,
              delivery: task.delivery,
              provenance: task.provenance,
            })),
            canonicalRevision: markdown.record?.revisionId,
            canonicalRevisionRefs: markdown.record?.provenance.rawRefs ?? [],
            state: deliveryItems.length ? "evidence" : "partial",
            provenance: deliveryItems[0]?.provenance ?? markdown.record?.provenance,
          }
        : unknownAxis("delivery", "no_delivery_evidence", observedAt);
    const projectIdentityProvenance = axisMeta(
      {
        kind: loaded.canonical ? "project-registry" : "project-manifest",
        instance: loaded.path ?? "inline",
        rawId: project.id,
        path: loaded.path,
      },
      observedAt,
      [project.id],
      [rawRef(loaded.canonical ? "registry" : "manifest", project.id, loaded.path)],
      now,
    );
    const projectRef = {
      id: project.id,
      name: project.name,
      repoRoots: project.repoRoots,
      worktreeRoots: project.worktreeRoots,
      provenance: projectIdentityProvenance,
      valueRefs: {
        id: projectIdentityProvenance.rawRefs,
        name: projectIdentityProvenance.rawRefs,
        repoRoots: projectIdentityProvenance.rawRefs,
        worktreeRoots: projectIdentityProvenance.rawRefs,
      },
      valueProvenance: {
        id: projectIdentityProvenance,
        name: projectIdentityProvenance,
        repoRoots: projectIdentityProvenance,
        worktreeRoots: projectIdentityProvenance,
      },
    };
    projectDiagnostics.push({
      projectId: project.id,
      diagnostics: [
        summaries.diagnostic,
        events.diagnostic,
        evergreen.diagnostic,
        markdown.diagnostic,
        beads.diagnostic,
        ...projectAssociationDiagnostics,
      ],
      rejected: [...summaries.rejected, ...events.rejected, ...evergreen.rejected],
    });
    return {
      projectRef,
      runtime: runtimeAxis,
      recentOutput: outputAxis,
      intervention: interventionAxis,
      eventDelta: eventAxis,
      evergreenDelta: evergreenAxis,
      workLedger,
      delivery,
      trace: {
        diagnostics: projectDiagnostics.at(-1)?.diagnostics ?? [],
        rejected: projectDiagnostics.at(-1)?.rejected ?? [],
      },
    };
  });
  const diagnostics = [...(loaded.diagnostics ?? [])];
  return {
    schemaVersion: ALPHA_SCHEMA_VERSION,
    generatedAt: observedAt,
    projects,
    trace: {
      schemaVersion: ALPHA_SCHEMA_VERSION,
      derivationVersion: ALPHA_DERIVATION_VERSION,
      generatedAt: observedAt,
      manifest: loaded.path,
      registryVersion: loaded.registryVersion,
      correctionProvenance: loaded.correctionProvenance,
      sources: projects.map((project) => ({
        projectId: project.projectRef.id,
        runtime: project.runtime.provenance,
        summary: project.recentOutput.provenance,
        intervention: project.intervention.provenance,
        events: project.eventDelta.provenance,
        evergreen: project.evergreenDelta.provenance,
        workLedger: project.workLedger.provenance,
        delivery: project.delivery.provenance,
      })),
      diagnostics,
      projectSources: projectDiagnostics,
      assumptions: [
        "Project identity comes only from the explicit v1 registry/legacy manifest or source projectId",
        "No cwd, repo basename, PID, or timestamp is used for association",
        "Beads is queried with --readonly",
      ],
    },
  };
}

export function defaultAlphaWatchRoots({ cwd = process.cwd(), manifestPath } = {}) {
  const requested =
    manifestPath ??
    process.env.PI_TIMELINE_PROJECT_REGISTRY ??
    process.env.HC_PROJECT_REGISTRY ??
    process.env.PI_TIMELINE_ALPHA_MANIFEST ??
    process.env.HC_ALPHA_MANIFEST;
  const loaded = loadProjectManifest({ path: requested, cwd });
  const configuredRoots = loaded.projects.flatMap((project) =>
    Object.values(projectSourcePaths(project, cwd)).flatMap((value) =>
      Array.isArray(value) ? value : [value],
    ),
  );
  const optionalHyperCarrierRoot = join(cwd, ".hypercarrier");
  return [
    manifestPath,
    loaded.path,
    ...(existsSync(optionalHyperCarrierRoot) ? [optionalHyperCarrierRoot] : []),
    join(homedir(), ".pi", "agent", "timeline"),
    ...configuredRoots,
  ].filter(Boolean);
}

function nearestExistingDirectory(path) {
  let candidate = path;
  while (candidate && !existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
  if (!candidate) return undefined;
  try {
    return statSync(candidate).isDirectory() ? candidate : dirname(candidate);
  } catch {
    return undefined;
  }
}

function alphaSourceKind(path) {
  const value = String(path).toLowerCase();
  if (value.includes("manifest") || value.includes("projects.json")) return "project-manifest";
  if (value.includes("summary") || basename(value) === "recent-output.jsonl") return "summary";
  if (value.includes("evergreen") || value.includes("proposal") || value.endsWith(".md"))
    return "evergreen";
  if (value.includes("beads")) return "beads";
  if (value.includes("event") || value.includes("distill")) return "project-events";
  if (value.includes("timeline")) return "timeline-runtime";
  return "alpha-source";
}

export function createAlphaSourceWatcher(
  onChange,
  { roots = defaultAlphaWatchRoots(), debounceMs = 75, watchImpl = watch } = {},
) {
  const watchers = [];
  let timer;
  let closed = false;
  const pending = new Set();
  const flush = () => {
    timer = undefined;
    if (closed || pending.size === 0) return;
    const paths = [...pending].sort();
    pending.clear();
    onChange({
      reason: "alpha-filesystem",
      source: "alpha",
      sourceKinds: [...new Set(paths.map(alphaSourceKind))],
      paths,
    });
  };
  const enqueue = (root, filename) => {
    const relativePath = typeof filename === "string" ? filename.slice(0, 500) : undefined;
    pending.add(relativePath ? join(root, relativePath) : root);
    clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
    timer.unref?.();
  };
  const watchRoots = [
    ...new Set(roots.map((candidate) => nearestExistingDirectory(candidate)).filter(Boolean)),
  ];
  for (const root of watchRoots) {
    try {
      const watcher = watchImpl(root, { recursive: true, persistent: false }, (_event, filename) =>
        enqueue(root, filename),
      );
      watcher.on?.("error", () => {});
      watchers.push(watcher);
    } catch {}
  }
  return {
    roots: watchRoots,
    close() {
      closed = true;
      clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    },
  };
}
