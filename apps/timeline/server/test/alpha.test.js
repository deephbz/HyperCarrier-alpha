import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectAlphaSnapshot,
  CANONICAL_PROJECT_ID_PATTERN,
  createAlphaSourceWatcher,
  defaultAlphaWatchRoots,
  freshnessFor,
  loadProjectManifest,
  readCanonicalMarkdown,
  readBeads,
  readEvergreenProposals,
  readSummaryJsonl,
} from "../alpha.js";
import { sanitizeAlphaEvent } from "../app.js";
import { PROJECT_ID_PATTERN } from "@hypercarrier/hc-project-distill";

test("legacy watcher metadata is sanitized before Alpha refresh/SSE payloads", () => {
  const safe = sanitizeAlphaEvent({
    reason: "filesystem",
    paths: [Buffer.from("secret"), "/safe/path", { toString: () => "leak" }, "x".repeat(700)],
    sourceKinds: ["summary", "not-a-source", { toString: () => "leak" }],
  });
  assert.deepEqual(safe, {
    reason: "filesystem",
    paths: ["/safe/path", "x".repeat(500)],
    sourceKinds: ["summary"],
  });
  assert.deepEqual(sanitizeAlphaEvent(), { reason: "request", paths: [], sourceKinds: [] });
});

test("Alpha watcher reports source kinds independently", async () => {
  const root = mkdtempSync(join(tmpdir(), "alpha-watch-"));
  let callback;
  const watcher = createAlphaSourceWatcher(() => {}, {
    roots: [root],
    debounceMs: 2,
    watchImpl: (_root, _options, onEvent) => {
      callback = onEvent;
      const emitter = new EventEmitter();
      emitter.close = () => {};
      return emitter;
    },
  });
  const events = [];
  watcher.close();
  const activeWatcher = createAlphaSourceWatcher((event) => events.push(event), {
    roots: [root],
    debounceMs: 2,
    watchImpl: (_root, _options, onEvent) => {
      callback = onEvent;
      const emitter = new EventEmitter();
      emitter.close = () => {};
      return emitter;
    },
  });
  callback("change", "summary.jsonl");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events[0].sourceKinds, ["summary"]);
  activeWatcher.close();
});

test("Alpha watcher classifies configured rarebit paths before timeline substrings", async () => {
  const root = mkdtempSync(join(tmpdir(), "central-vault-timeline-e2e-"));
  let callback;
  const events = [];
  const watcher = createAlphaSourceWatcher((event) => events.push(event), {
    roots: [root],
    debounceMs: 2,
    watchImpl: (_root, _options, onEvent) => {
      callback = onEvent;
      const emitter = new EventEmitter();
      emitter.close = () => {};
      return emitter;
    },
  });
  callback("change", "rarebit.jsonl");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events[0].sourceKinds, ["summary"]);
  watcher.close();
});

test("default Alpha watcher keeps configured summary invalidations exact without cwd noise", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "alpha-watch-cwd-"));
  const configRoot = mkdtempSync(join(tmpdir(), "alpha-watch-config-"));
  const summaryRoot = mkdtempSync(join(tmpdir(), "central-vault-timeline-summary-"));
  const manifestPath = join(configRoot, "manifest.json");
  const summaryPath = join(summaryRoot, "rarebit.jsonl");
  mkdirSync(join(cwd, ".beads"));
  writeFileSync(join(cwd, ".beads", "noise.jsonl"), "{}\n");
  writeFileSync(summaryPath, "");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ id: "p", summaryPath }],
    }),
  );

  const registrations = [];
  const events = [];
  const watcher = createAlphaSourceWatcher((event) => events.push(event), {
    roots: defaultAlphaWatchRoots({ cwd, manifestPath }),
    debounceMs: 2,
    watchImpl: (root, _options, onEvent) => {
      registrations.push({ root, onEvent });
      const emitter = new EventEmitter();
      emitter.close = () => {};
      return emitter;
    },
  });

  assert.equal(watcher.roots.includes(cwd), false);
  const summaryRegistration = registrations.find(({ root }) => root === summaryRoot);
  assert.ok(summaryRegistration);
  summaryRegistration.onEvent("change", "rarebit.jsonl");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events, [
    {
      reason: "alpha-filesystem",
      source: "alpha",
      sourceKinds: ["summary"],
      paths: [summaryPath],
    },
  ]);
  assert.equal(
    events[0].paths.some((path) => path.includes("/.beads/")),
    false,
  );
  watcher.close();
});

test("Alpha keeps explicit Projects separate and does not associate runtime by cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "alpha-contract-"));
  writeFileSync(
    join(root, "summary.jsonl"),
    '{"type":"rarebit_summary","projectId":"one","summary":"one","observedAt":"2026-07-12T10:00:00.000Z"}\n',
  );
  writeFileSync(
    join(root, "events.jsonl"),
    '{"type":"intervention","eventId":"i-1","projectId":"one","eventKind":"intervention","payload":{"assessment":"approval needed"},"observedAt":"2026-07-12T10:00:00.000Z"}\n',
  );
  writeFileSync(join(root, "evergreen.md"), "# canonical\n");
  const snapshot = collectAlphaSnapshot({
    cwd: root,
    manifest: {
      schemaVersion: 1,
      projects: [
        {
          id: "one",
          name: "One",
          repoRoots: ["/same"],
          sessionIds: ["s-one"],
          summaryPath: "summary.jsonl",
          eventsPath: "events.jsonl",
          evergreenPath: "evergreen.md",
        },
        {
          id: "two",
          name: "Two",
          repoRoots: ["/same"],
          sessionIds: ["s-two"],
          summaryPath: "summary.jsonl",
          eventsPath: "events.jsonl",
          evergreenPath: "evergreen.md",
        },
      ],
    },
    baseSnapshot: {
      sessions: [
        { id: "s-one", cwd: "/same/project" },
        { id: "s-two", cwd: "/same/project" },
      ],
      liveAgents: [
        {
          processInstanceId: "p-one",
          sessionId: "s-one",
          cwd: "/same/project",
          state: "waiting_input",
          pid: 1,
        },
      ],
    },
    runBd: () => "[]",
    now: Date.parse("2026-07-12T12:00:00.000Z"),
  });
  assert.deepEqual(
    snapshot.projects.map((project) => project.projectRef.id),
    ["one", "two"],
  );
  assert.equal(snapshot.projects[0].runtime.items[0].state, "waiting_input");
  assert.equal(snapshot.projects[1].runtime.state, "unknown");
  assert.equal(snapshot.projects[0].intervention.items[0].assessment, "approval needed");
  assert.equal("status" in snapshot.projects[0], false);
  for (const project of snapshot.projects) {
    for (const axis of [
      project.runtime,
      project.rarebitSummary,
      project.intervention,
      project.eventDelta,
      project.evergreenDelta,
      project.workLedger,
      project.delivery,
    ]) {
      assert.ok(axis.provenance.source);
      assert.ok(axis.provenance.observedAt);
      assert.ok(axis.provenance.freshness);
      assert.ok(axis.provenance.confidence);
      assert.ok(axis.provenance.derivation.version);
      assert.ok(Array.isArray(axis.provenance.rawRefs));
    }
  }
});

test("Alpha distinguishes absent, explicit-but-not-live, and matching runtime associations", () => {
  const root = mkdtempSync(join(tmpdir(), "alpha-runtime-association-"));
  const snapshot = collectAlphaSnapshot({
    cwd: root,
    manifest: {
      schemaVersion: 1,
      projects: [
        { id: "absent", name: "Absent" },
        { id: "configured", name: "Configured", sessionIds: ["session-configured"] },
        { id: "live", name: "Live", sessionIds: ["session-live"] },
      ],
    },
    baseSnapshot: {
      sessions: [{ id: "session-configured" }, { id: "session-live" }],
      liveAgents: [
        {
          processInstanceId: "runtime-live",
          sessionId: "session-live",
          state: "waiting_input",
          heartbeatAt: "2026-07-12T11:59:00.000Z",
        },
      ],
    },
    runBd: () => "[]",
    now: Date.parse("2026-07-12T12:00:00.000Z"),
  });

  assert.equal(snapshot.projects[0].runtime.state, "unknown");
  assert.equal(snapshot.projects[0].runtime.reason, "no_explicit_runtime_association");
  assert.equal(snapshot.projects[1].runtime.state, "unknown");
  assert.equal(snapshot.projects[1].runtime.reason, "no_current_runtime_observation");
  assert.equal(snapshot.projects[2].runtime.state, "observed");
  assert.equal(snapshot.projects[2].runtime.items[0].state, "waiting_input");
});

test("Alpha adapters preserve stale/malformed states and avoid bd list --limit 0 semantics", () => {
  const root = mkdtempSync(join(tmpdir(), "alpha-adapters-"));
  const summaryPath = join(root, "summary.jsonl");
  writeFileSync(
    summaryPath,
    '{"type":"rarebit_summary","summaryId":"old","summary":"visible summary","observedAt":"2026-07-01T00:00:00.000Z"}\nnot-json\n',
  );
  const summary = readSummaryJsonl({
    path: summaryPath,
    now: Date.parse("2026-07-12T00:00:00.000Z"),
  });
  assert.equal(summary.records[0].provenance.freshness, "stale");
  assert.equal(summary.diagnostic.status, "partial");
  assert.deepEqual(summary.rejected, [{ line: 2, reason: "malformed_jsonl" }]);

  const calls = [];
  const beads = readBeads({
    root: "/fixture/project",
    run: (file, args, options) => {
      if (args.includes("--limit") && args.includes("0")) return "[]";
      assert.deepEqual(args, ["-C", "/fixture/project", "export", "--readonly", "--json"]);
      assert.equal(options.encoding, "utf8");
      assert.equal(file, "bd");
      const result = [
        JSON.stringify({
          _type: "issue",
          id: "bd-1",
          title: "Task",
          status: "open",
          secret: "must-not-project",
          dependencies: [{ id: "bd-0" }],
        }),
        "",
      ].join("\n");
      const argsAndResult = [file, args, options, result];
      calls.push(argsAndResult);
      return result;
    },
    now: Date.parse("2026-07-12T12:00:00.000Z"),
  });
  assert.deepEqual(calls[0][0], "bd");
  assert.deepEqual(calls[0][1], ["-C", "/fixture/project", "export", "--readonly", "--json"]);
  assert.equal(beads.tasks[0].title, "Task");
  assert.equal("secret" in beads.tasks[0], false);
  assert.deepEqual(beads.tasks[0].dependencies, ["bd-0"]);
  assert.equal(beads.diagnostic.sourceCount, 1);
  assert.deepEqual(beads.diagnostic.provenance.derivation.inputs, [
    "bd -C /fixture/project export --readonly --json",
  ]);
});

test("Alpha distinguishes a non-empty Beads source from absent task associations", () => {
  const snapshot = collectAlphaSnapshot({
    manifest: {
      schemaVersion: 1,
      projects: [{ id: "project", beadsRoot: "/fixture/project" }],
    },
    runBd: () => '{"_type":"issue","id":"bd-1","title":"Unassociated"}\n',
    now: Date.parse("2026-07-12T12:00:00.000Z"),
  });
  const project = snapshot.projects[0];
  assert.equal(project.workLedger.state, "unknown");
  assert.equal(project.workLedger.reason, "no_associated_beads_tasks");
  assert.equal(project.workLedger.diagnostics[0].sourceCount, 1);
});

test("Alpha Beads adapter rejects a malformed JSONL export", () => {
  const beads = readBeads({
    root: "/fixture/project",
    run: () => '{"_type":"issue","id":"bd-1"}\nnot-json\n',
    now: Date.parse("2026-07-12T12:00:00.000Z"),
  });
  assert.deepEqual(beads.tasks, []);
  assert.equal(beads.diagnostic.status, "malformed");
  assert.equal(beads.diagnostic.reason, "invalid_json");
});

test("Alpha manifest loader reports missing and malformed manifests without guessing", () => {
  const root = mkdtempSync(join(tmpdir(), "alpha-manifest-"));
  const missing = loadProjectManifest({ cwd: root, now: Date.parse("2026-07-12T12:00:00.000Z") });
  assert.equal(missing.projects.length, 0);
  assert.equal(missing.diagnostics[0].status, "missing");
  const path = join(root, "manifest.json");
  writeFileSync(path, "not-json");
  const malformed = loadProjectManifest({ path, now: Date.parse("2026-07-12T12:00:00.000Z") });
  assert.equal(malformed.diagnostics[0].status, "malformed");
  assert.equal(malformed.projects.length, 0);
});

test("Alpha enforces v1 and unique non-empty Project IDs", () => {
  const root = mkdtempSync(join(tmpdir(), "alpha-identity-"));
  const path = join(root, "manifest.json");
  writeFileSync(path, JSON.stringify({ schemaVersion: 999, projects: [] }));
  const unsupported = loadProjectManifest({ path, now: Date.parse("2026-07-12T12:00:00.000Z") });
  assert.equal(unsupported.projects.length, 0);
  assert.equal(unsupported.diagnostics.at(-1).reason, "unsupported_schema_version");
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ id: "dup" }, { id: "dup" }, { id: "   " }, { name: "missing" }],
    }),
  );
  const invalid = loadProjectManifest({ path, now: Date.parse("2026-07-12T12:00:00.000Z") });
  assert.deepEqual(invalid.projects, []);
  assert.ok(invalid.diagnostics.some((diagnostic) => diagnostic.reason === "duplicate_project_id"));
  assert.ok(invalid.diagnostics.some((diagnostic) => diagnostic.reason === "project_id_required"));
});

test("canonical registry validation stays in parity with the distiller and fails closed", () => {
  assert.equal(CANONICAL_PROJECT_ID_PATTERN, PROJECT_ID_PATTERN);
  const fixture = JSON.parse(
    readFileSync(new URL("../../fixtures/alpha/canonical-registry-parity.json", import.meta.url)),
  );
  const valid = loadProjectManifest({ manifestValue: fixture });
  assert.equal(valid.canonical, true);
  assert.deepEqual(
    valid.projects.map((project) => project.id),
    ["parity-project"],
  );
  assert.equal(valid.diagnostics[0].status, "ok");

  const cases = [
    {
      name: "duplicate IDs",
      reason: "duplicate_project_id",
      build: (value) => {
        value.projects.push(structuredClone(value.projects[0]));
        return value;
      },
    },
    {
      name: "unsafe IDs",
      reason: "unsafe_project_id",
      build: (value) => {
        value.projects[0].id = "../unsafe";
        return value;
      },
    },
    {
      name: "wrong schema version",
      reason: "unsupported_schema_version",
      build: (value) => {
        value.schemaVersion = 2;
        return value;
      },
    },
    {
      name: "empty registry version",
      reason: "registry_version_required",
      build: (value) => {
        value.registryVersion = "";
        return value;
      },
    },
    {
      name: "missing registry version",
      reason: "registry_version_required",
      build: (value) => {
        delete value.registryVersion;
        return value;
      },
    },
    {
      name: "wrong projects type",
      reason: "projects_array_required",
      build: (value) => {
        value.projects = {};
        return value;
      },
    },
    {
      name: "wrong association type",
      reason: "canonical_associations_required",
      build: (value) => {
        value.projects[0].associations = [];
        return value;
      },
    },
    {
      name: "wrong list type",
      reason: "canonical_location_list_type",
      build: (value) => {
        value.projects[0].locations.summaries = "rarebit.jsonl";
        return value;
      },
    },
    {
      name: "wrong association list type",
      reason: "canonical_association_list_type",
      build: (value) => {
        value.projects[0].associations.sessionIds = ["ok", 42];
        return value;
      },
    },
    {
      name: "wrong location scalar type",
      reason: "canonical_location_value_type",
      build: (value) => {
        value.projects[0].locations.evergreen = {};
        return value;
      },
    },
    {
      name: "wrong evergreen type",
      reason: "canonical_evergreen_type",
      build: (value) => {
        value.projects[0].evergreen = [];
        return value;
      },
    },
  ];
  for (const parityCase of cases) {
    const loaded = loadProjectManifest({
      manifestValue: parityCase.build(structuredClone(fixture)),
    });
    assert.equal(loaded.canonical, true, parityCase.name);
    assert.equal(loaded.manifest, undefined, parityCase.name);
    assert.deepEqual(loaded.projects, [], parityCase.name);
    assert.equal(loaded.diagnostics[0].status, "malformed", parityCase.name);
    assert.ok(
      loaded.diagnostics.some((diagnostic) => diagnostic.reason === parityCase.reason),
      parityCase.name,
    );
    assert.equal(
      loaded.diagnostics.some((diagnostic) => diagnostic.status === "ok"),
      false,
      parityCase.name,
    );
  }
});

test("Alpha surfaces partial input, deduplicates stable IDs, and retains conflicts", () => {
  const root = mkdtempSync(join(tmpdir(), "alpha-integrity-"));
  const path = join(root, "summary.jsonl");
  writeFileSync(
    path,
    [
      JSON.stringify({
        schemaVersion: 1,
        type: "rarebit_summary",
        summaryId: "same",
        summary: "one",
      }),
      JSON.stringify({
        schemaVersion: 1,
        type: "rarebit_summary",
        summaryId: "same",
        summary: "one",
      }),
      JSON.stringify({
        schemaVersion: 1,
        type: "rarebit_summary",
        summaryId: "same",
        summary: "two",
        value: "secret",
      }),
      "{truncated",
    ].join("\n"),
  );
  const summary = readSummaryJsonl({ path, now: Date.parse("2026-07-12T12:00:00.000Z") });
  assert.equal(summary.records.length, 2);
  assert.equal(summary.records[0].summary, "one");
  assert.equal("value" in summary.records[1], false);
  assert.equal(summary.diagnostic.status, "ambiguous");
  assert.equal(summary.diagnostic.rejectedCount, 1);
  assert.equal(summary.diagnostic.deduplicatedCount, 1);
  assert.equal(summary.diagnostic.conflictCount, 1);
  assert.ok(
    summary.diagnostic.diagnostics.some(
      (diagnostic) => diagnostic.reason === "conflicting_stable_id",
    ),
  );
});

test("Alpha retains summary failure records as diagnostics instead of crashing", () => {
  const root = mkdtempSync(join(tmpdir(), "alpha-summary-failure-"));
  const path = join(root, "rarebit.jsonl");
  writeFileSync(
    path,
    [
      JSON.stringify({
        schemaVersion: 1,
        type: "rarebit_summary",
        summaryId: "failed-materialization",
        status: "failure",
        error: { name: "Error", message: "model unavailable" },
      }),
      JSON.stringify({
        schemaVersion: 1,
        type: "rarebit_summary",
        summaryId: "successful-materialization",
        status: "ok",
        summary: "Progress: recovered",
      }),
    ].join("\n"),
  );

  const summary = readSummaryJsonl({ path, now: Date.parse("2026-07-13T00:00:00.000Z") });
  assert.equal(summary.records.length, 1);
  assert.equal(summary.records[0].id, "successful-materialization");
  assert.equal(summary.rejected.length, 1);
  assert.equal(summary.rejected[0].reason, "summary_fields_required");
  assert.equal(summary.diagnostic.status, "partial");
});

test("Alpha reads proposal bundles directly and keeps partial/corrupt states visible", () => {
  const root = mkdtempSync(join(tmpdir(), "alpha-proposal-bundles-"));
  const partial = join(root, "partial");
  mkdirSync(join(partial, "bundle-1"), { recursive: true });
  const metadata = {
    schemaVersion: 1,
    type: "evergreen_proposal",
    status: "proposed",
    proposalId: "proposal-1",
    projectId: "p",
    baseHash: "base",
    sourceFrontierHash: "frontier",
    artifactHashes: { markdown: "markdown", patch: "patch" },
  };
  writeFileSync(join(partial, "bundle-1", "metadata.json"), JSON.stringify(metadata));
  writeFileSync(join(partial, "bundle-1", "proposal.md"), "proposal");
  const partialResult = readEvergreenProposals({
    path: partial,
    now: Date.parse("2026-07-13T00:00:00Z"),
  });
  assert.equal(partialResult.records[0].status, "partial");
  assert.equal(partialResult.diagnostic.status, "partial");
  assert.deepEqual(partialResult.rejected[0].missing, ["proposal.patch"]);

  const corrupt = join(root, "corrupt");
  mkdirSync(join(corrupt, "bundle-1"), { recursive: true });
  writeFileSync(join(corrupt, "bundle-1", "metadata.json"), JSON.stringify(metadata));
  writeFileSync(join(corrupt, "bundle-1", "proposal.md"), "proposal");
  writeFileSync(join(corrupt, "bundle-1", "proposal.patch"), "patch");
  const corruptResult = readEvergreenProposals({
    path: corrupt,
    now: Date.parse("2026-07-13T00:00:00Z"),
  });
  assert.equal(corruptResult.records[0].status, "corrupt");
  assert.equal(corruptResult.diagnostic.status, "ambiguous");
});

test("Alpha keeps citation-partial model synthesis ambiguous and excludes it from current change counts", () => {
  const root = mkdtempSync(join(tmpdir(), "alpha-synthesis-citations-"));
  const proposalRoot = join(root, "proposals");
  const bundle = join(proposalRoot, "bundle-1");
  mkdirSync(bundle, { recursive: true });
  const canonical = "# Owner canonical\n";
  const proposal = `${canonical}\n# Audit-required proposal\n`;
  const patch = "+# Audit-required proposal\n";
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  writeFileSync(join(root, "Evergreen.md"), canonical);
  writeFileSync(join(bundle, "proposal.md"), proposal);
  writeFileSync(join(bundle, "proposal.patch"), patch);
  writeFileSync(
    join(bundle, "metadata.json"),
    JSON.stringify({
      schemaVersion: 1,
      type: "evergreen_proposal",
      status: "proposed",
      proposalId: "proposal-citation-partial",
      projectId: "p",
      baseHash: digest(canonical),
      sourceFrontierHash: "frontier",
      artifactHashes: { markdown: digest(proposal), patch: digest(patch) },
      eventIds: ["event-1"],
      synthesis: {
        status: "partial",
        promptVersion: "evergreen-synthesis-v1",
        model: { provider: "openrouter", id: "z-ai/glm-5.2" },
        inputHash: "input",
        outputHash: "output",
        eventIds: ["event-1"],
        rawText: "must-not-project",
        operationalProvenance: { argv: ["must-not-project"] },
        citationStatus: {
          status: "partial",
          diagnostics: [{ reason: "missing_event_citation", section: "Inferred" }],
        },
      },
    }),
  );
  const snapshot = collectAlphaSnapshot({
    cwd: root,
    manifest: {
      schemaVersion: 1,
      projects: [
        {
          id: "p",
          evergreenProposalsPath: "proposals",
          evergreenPath: "Evergreen.md",
        },
      ],
    },
    now: Date.parse("2026-07-13T00:00:00Z"),
    runBd: () => "[]",
  });
  const axis = snapshot.projects[0].evergreenDelta;
  assert.equal(axis.state, "ambiguous");
  assert.equal(axis.reason, "synthesis_citations_partial");
  assert.equal(axis.changeCount, 0);
  assert.equal(axis.proposals[0].status, "partial");
  assert.equal(axis.proposals[0].provenance.reason, "synthesis_citations_partial");
  assert.equal(axis.proposals[0].synthesis.citationStatus.status, "partial");
  assert.equal(JSON.stringify(axis).includes("must-not-project"), false);
});

test("Alpha marks a proposed Evergreen revision stale when its base differs from canonical", () => {
  const root = mkdtempSync(join(tmpdir(), "alpha-stale-evergreen-"));
  const canonicalPath = join(root, "Evergreen.md");
  const proposalPath = join(root, "proposals.jsonl");
  writeFileSync(canonicalPath, "# current canonical\n");
  writeFileSync(
    proposalPath,
    JSON.stringify({
      schemaVersion: 1,
      type: "evergreen_proposal",
      proposalId: "proposal-old-base",
      projectId: "p",
      status: "proposed",
      baseHash: "not-the-current-canonical-hash",
      changeCount: 3,
    }),
  );

  const snapshot = collectAlphaSnapshot({
    cwd: root,
    manifest: {
      schemaVersion: 1,
      projects: [
        {
          id: "p",
          evergreenProposalsPath: "proposals.jsonl",
          evergreenPath: "Evergreen.md",
        },
      ],
    },
    now: Date.parse("2026-07-13T00:00:00Z"),
    runBd: () => "[]",
  });
  const axis = snapshot.projects[0].evergreenDelta;
  const proposal = axis.proposals[0];
  assert.equal(proposal.status, "stale");
  assert.equal(proposal.storedStatus, "proposed");
  assert.equal(proposal.baseState, "mismatch");
  assert.equal(proposal.reason, "canonical_base_mismatch");
  assert.equal(proposal.baseComparison.proposalBaseHash, "not-the-current-canonical-hash");
  assert.equal(proposal.baseComparison.canonicalRevisionId, axis.canonicalRevision.revisionId);
  assert.deepEqual(proposal.provenance.derivation.inputs, [
    "not-the-current-canonical-hash",
    axis.canonicalRevision.revisionId,
  ]);
  assert.ok(proposal.provenance.rawRefs.some((ref) => ref.pathOrCommand === proposalPath));
  assert.ok(proposal.provenance.rawRefs.some((ref) => ref.pathOrCommand === canonicalPath));
  assert.equal(axis.changeCount, 0);
  assert.equal(axis.staleChangeCount, 3);
  assert.equal(axis.state, "ambiguous");
  assert.equal(axis.reason, "canonical_base_mismatch");
  assert.ok(
    snapshot.trace.projectSources[0].diagnostics.some(
      (diagnostic) => diagnostic.reason === "canonical_base_mismatch",
    ),
  );
});

test("Alpha marks overlapping session and source associations ambiguous", () => {
  const root = mkdtempSync(join(tmpdir(), "alpha-overlap-"));
  writeFileSync(
    join(root, "summary.jsonl"),
    JSON.stringify({
      schemaVersion: 1,
      type: "rarebit_summary",
      summaryId: "shared",
      sessionId: "shared",
      summary: "must not copy",
    }),
  );
  const snapshot = collectAlphaSnapshot({
    cwd: root,
    manifest: {
      schemaVersion: 1,
      projects: [
        {
          id: "one",
          sessionIds: ["shared"],
          taskIds: ["task-shared"],
          summaryPath: "summary.jsonl",
          beadsRoot: "beads",
        },
        {
          id: "two",
          sessionIds: ["shared"],
          taskIds: ["task-shared"],
          summaryPath: "summary.jsonl",
          beadsRoot: "beads",
        },
      ],
    },
    baseSnapshot: {
      sessions: [{ id: "shared", cwd: "/shared" }],
      liveAgents: [{ processInstanceId: "runtime-1", sessionId: "shared", state: "waiting_input" }],
    },
    runBd: () => JSON.stringify([{ id: "task-shared", title: "ambiguous task" }]),
    now: Date.parse("2026-07-12T12:00:00.000Z"),
  });
  for (const project of snapshot.projects) {
    assert.equal(project.rarebitSummary.state, "ambiguous");
    assert.equal(project.rarebitSummary.items?.length ?? 0, 0);
    assert.equal(project.runtime.state, "ambiguous");
    assert.equal(project.workLedger.tasks?.length ?? 0, 0);
  }
  assert.ok(
    snapshot.trace.projectSources[0].diagnostics.some(
      (diagnostic) => diagnostic.reason === "overlapping_session_association",
    ),
  );
  assert.ok(
    snapshot.trace.projectSources[0].diagnostics.some(
      (diagnostic) => diagnostic.reason === "overlapping_task_association",
    ),
  );
});

test("Alpha treats future records and Markdown mtimes as unknown", () => {
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  assert.equal(freshnessFor({ observedAt: "2099-01-01T00:00:00.000Z", now }), "unknown");
  const root = mkdtempSync(join(tmpdir(), "alpha-future-"));
  const markdown = join(root, "Evergreen.md");
  writeFileSync(markdown, "# future\n");
  const future = new Date(now + 60 * 60 * 1000);
  utimesSync(markdown, future, future);
  const result = readCanonicalMarkdown({ path: markdown, now });
  assert.equal(result.record.provenance.freshness, "unknown");
  assert.equal(result.record.provenance.confidence, "ambiguous");
  assert.equal(result.diagnostic.reason, "future_timestamp");
});

test("Alpha watcher roots include configured source parents and Beads roots", () => {
  const root = mkdtempSync(join(tmpdir(), "alpha-roots-"));
  const manifestPath = join(root, "manifest.json");
  const sourceDir = join(root, "outside");
  const beadsDir = join(root, "beads");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ id: "p", summaryPath: join("outside", "summary.jsonl"), beadsRoot: "beads" }],
    }),
  );
  mkdirSync(sourceDir);
  writeFileSync(join(sourceDir, "summary.jsonl"), "");
  const roots = defaultAlphaWatchRoots({ cwd: root, manifestPath });
  assert.ok(roots.includes(join(sourceDir, "summary.jsonl")));
  assert.ok(roots.includes(beadsDir));
});

test("Alpha exposes per-value lineage for identity and aggregates", () => {
  const root = mkdtempSync(join(tmpdir(), "alpha-lineage-"));
  writeFileSync(
    join(root, "events.jsonl"),
    JSON.stringify({
      schemaVersion: 1,
      type: "project_event",
      eventId: "event-1",
      projectId: "p",
      eventKind: "decision-candidate",
      at: "2026-07-12T11:00:00.000Z",
    }),
  );
  const snapshot = collectAlphaSnapshot({
    cwd: root,
    manifest: {
      schemaVersion: 1,
      projects: [{ id: "p", name: "Project", eventsPath: "events.jsonl" }],
    },
    now: Date.parse("2026-07-12T12:00:00.000Z"),
    runBd: () => "[]",
  });
  const project = snapshot.projects[0];
  assert.deepEqual(project.projectRef.valueRefs.id[0].id, "p");
  assert.ok(project.eventDelta.countRefs.some((ref) => ref.id === "event-1"));
  assert.ok(project.eventDelta.countProvenance.rawRefs.some((ref) => ref.id === "event-1"));
  assert.equal(project.eventDelta.window.kind, "all-recorded");
  assert.equal(project.eventDelta.ownerWatermark, undefined);
  assert.equal(project.eventDelta.latestEventAt, "2026-07-12T11:00:00.000Z");
});

test("Alpha event projection uses only an explicit owner watermark as a delta anchor", () => {
  const root = mkdtempSync(join(tmpdir(), "alpha-event-window-"));
  writeFileSync(
    join(root, "events.jsonl"),
    [
      {
        schemaVersion: 1,
        type: "project_event",
        eventId: "owner-anchor",
        projectId: "p",
        eventKind: "owner-update",
        at: "2026-07-12T10:00:00.000Z",
        ownerWatermark: "2026-07-12T10:00:00.000Z",
      },
      {
        schemaVersion: 1,
        type: "project_event",
        eventId: "after-anchor",
        projectId: "p",
        eventKind: "source-change",
        at: "2026-07-12T11:00:00.000Z",
      },
    ]
      .map(JSON.stringify)
      .join("\n"),
  );
  const snapshot = collectAlphaSnapshot({
    cwd: root,
    manifest: {
      schemaVersion: 1,
      projects: [{ id: "p", eventsPath: "events.jsonl" }],
    },
    now: Date.parse("2026-07-12T12:00:00.000Z"),
    runBd: () => "[]",
  });
  const axis = snapshot.projects[0].eventDelta;
  assert.equal(axis.window.kind, "since-owner-watermark");
  assert.equal(axis.ownerWatermark, "2026-07-12T10:00:00.000Z");
  assert.equal(axis.count, 1);
  assert.deepEqual(
    axis.items.map((event) => event.id),
    ["after-anchor"],
  );
  assert.equal(axis.latestEventAt, "2026-07-12T11:00:00.000Z");
});
