import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectAlphaSnapshot, loadProjectManifest } from "../alpha.js";
import { distillProject, loadRegistry, sha256 } from "@hypercarrier/hc-project-distill";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hc-registry-e2e-"));
  const repoA = join(root, "repo-a");
  const repoB = join(root, "repo-b");
  await mkdir(repoA, { recursive: true });
  await mkdir(repoB, { recursive: true });
  const evergreen = join(repoA, "Evergreen.md");
  const sourceDoc = join(repoB, "README.md");
  const summary = join(root, "rarebit.jsonl");
  const events = join(root, "events.jsonl");
  const proposalDir = join(root, "proposals");
  await writeFile(evergreen, "# Audited Alpha\n\nOutcome: integrate the evidence.\n");
  await writeFile(sourceDoc, "# Source\n\nA finding from the second repository.\n");
  await writeFile(
    summary,
    JSON.stringify({
      schemaVersion: 1,
      type: "rarebit_summary",
      summaryId: "summary-direct",
      projectId: "spanning-project",
      progress: "The direct producer contract is wired.",
      observedAt: "2026-07-13T00:00:30.000Z",
      validAt: "2026-07-13T00:00:10.000Z",
      selection: {
        manifestHash: "a".repeat(64),
        occurrences: [
          {
            occurrenceId: "message-a:0",
            contentHash: "hash-a",
            timestamp: "2026-07-13T00:00:00.000Z",
            sourceEntryId: "entry-a",
          },
          {
            occurrenceId: "message-b:1",
            contentHash: "hash-b",
            timestamp: "2026-07-13T00:00:10.000Z",
            sourceEntryId: "entry-b",
          },
        ],
        payloads: [{ contentHash: "hash-a", occurrenceIds: ["message-a:0"] }],
        asOf: "2026-07-13T00:00:10.000Z",
        completeBranchProjection: true,
      },
    }) + "\n",
  );
  const registryPath = join(root, "project-registry.json");
  await writeFile(
    registryPath,
    JSON.stringify({
      schemaVersion: 1,
      registryVersion: "test-registry-v1",
      correctionProvenance: { reason: "integration fixture" },
      projects: [
        {
          id: "spanning-project",
          name: "Spanning Project",
          locations: {
            repos: [repoA, repoB],
            evergreen,
            beadsRoot: repoA,
            summaries: [summary],
            events,
            proposalDir,
            sourceDocs: [sourceDoc],
          },
          associations: {},
          evergreen: { baseHash: sha256(await readFile(evergreen, "utf8")) },
        },
        {
          id: "shared-repo-one",
          name: "Shared Repo One",
          locations: {
            repos: [repoA],
            evergreen,
            beadsRoot: null,
            summaries: [],
            events: null,
            proposalDir: null,
          },
          associations: {},
        },
        {
          id: "shared-repo-two",
          name: "Shared Repo Two",
          locations: {
            repos: [repoA],
            evergreen,
            beadsRoot: null,
            summaries: [],
            events: null,
            proposalDir: null,
          },
          associations: {},
        },
      ],
    }),
  );
  const runner = async (command, args) => {
    if (command === "bd") return { code: 0, stdout: "[]\n", stderr: "" };
    if (command === "git" && args[0] === "rev-parse")
      return { code: 0, stdout: "a".repeat(40) + "\n", stderr: "" };
    if (command === "git" && args[0] === "status")
      return { code: 0, stdout: "## main\n", stderr: "" };
    if (command === "git" && args[0] === "log") return { code: 0, stdout: "\n", stderr: "" };
    if (command === "git" && args[0] === "diff") return { code: 0, stdout: "\n", stderr: "" };
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
  return { registryPath, runner, root };
}

test("canonical registry drives distiller output directly into timeline proposal metadata", async () => {
  const { registryPath, runner } = await fixture();
  const registry = await loadRegistry(registryPath);
  const project = registry.projects[0];
  const result = await distillProject({
    project,
    registryVersion: registry.registryVersion,
    baseHash: project.evergreen.baseHash,
    runner,
    now: "2026-07-13T00:01:00.000Z",
    trace: true,
  });
  assert.equal(result.proposal.status, "proposed");
  const canonical = await readFile(project.locations.evergreen, "utf8");
  const proposal = await readFile(result.proposal.paths.markdown, "utf8");
  assert.equal(proposal.startsWith(canonical), true);
  assert.match(proposal, /HYPERCARRIER_PROPOSAL_START/);
  assert.equal(
    JSON.parse(await readFile(result.proposal.paths.metadata, "utf8")).basePreserved,
    true,
  );
  assert.equal(result.trace.input.git.repositories.length, 2);

  const snapshot = collectAlphaSnapshot({
    manifestPath: registryPath,
    baseSnapshot: { sessions: [], liveAgents: [] },
    runBd: () => "[]",
    now: Date.parse("2026-07-13T00:02:00.000Z"),
  });
  const projected = snapshot.projects.find((item) => item.projectRef.id === project.id);
  assert.equal(projected.projectRef.repoRoots.length, 2);
  assert.equal(
    projected.rarebitSummary.items[0].progress,
    "The direct producer contract is wired.",
  );
  assert.equal(projected.rarebitSummary.items[0].observedAt, "2026-07-13T00:00:30.000Z");
  assert.equal(projected.rarebitSummary.items[0].validAt, "2026-07-13T00:00:10.000Z");
  assert.deepEqual(projected.rarebitSummary.items[0].selection.occurrences, [
    {
      occurrenceId: "message-a:0",
      contentHash: "hash-a",
      timestamp: "2026-07-13T00:00:00.000Z",
      sourceEntryId: "entry-a",
    },
    {
      occurrenceId: "message-b:1",
      contentHash: "hash-b",
      timestamp: "2026-07-13T00:00:10.000Z",
      sourceEntryId: "entry-b",
    },
  ]);
  assert.equal(projected.rarebitSummary.items[0].selection.asOf, "2026-07-13T00:00:10.000Z");
  const persistedEvents = (await readFile(project.locations.events, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  const summaryEvent = persistedEvents.find((event) => event.payload?.reportedSummary);
  assert.ok(summaryEvent);
  assert.deepEqual(
    projected.eventDelta.items.find((event) => event.id === summaryEvent.eventId).payload,
    summaryEvent.payload,
  );
  assert.equal(typeof summaryEvent.payload.reportedSummary, "object");
  assert.equal(projected.evergreenDelta.proposals[0].projectId, project.id);
  assert.equal(projected.evergreenDelta.proposals[0].status, "proposed");
  assert.match(
    projected.evergreenDelta.proposals[0].provenance.rawRefs[0].pathOrCommand,
    /metadata\.json$/,
  );
  assert.equal(snapshot.trace.registryVersion, "test-registry-v1");
});

test("timeline does not project a proposal as current after canonical Evergreen advances", async () => {
  const { registryPath, runner } = await fixture();
  const registry = await loadRegistry(registryPath);
  const project = registry.projects[0];
  await distillProject({
    project,
    registryVersion: registry.registryVersion,
    baseHash: project.evergreen.baseHash,
    runner,
    now: "2026-07-13T00:01:00.000Z",
  });
  await writeFile(project.locations.evergreen, "# Advanced canonical\n\nA newer owner revision.\n");

  const snapshot = collectAlphaSnapshot({
    manifestPath: registryPath,
    baseSnapshot: { sessions: [], liveAgents: [] },
    runBd: () => "[]",
    now: Date.parse("2026-07-13T00:02:00.000Z"),
  });
  const projected = snapshot.projects.find((item) => item.projectRef.id === project.id);
  const proposal = projected.evergreenDelta.proposals[0];
  assert.equal(proposal.status, "stale");
  assert.equal(proposal.storedStatus, "proposed");
  assert.equal(projected.evergreenDelta.changeCount, 0);
  assert.equal(projected.evergreenDelta.state, "ambiguous");
  assert.equal(projected.evergreenDelta.reason, "canonical_base_mismatch");
  assert.deepEqual(proposal.provenance.derivation.inputs, [
    project.evergreen.baseHash,
    sha256(await readFile(project.locations.evergreen, "utf8")),
  ]);
  assert.ok(
    proposal.provenance.rawRefs.some((ref) => ref.pathOrCommand === project.locations.evergreen),
  );
  assert.ok(proposal.provenance.rawRefs.some((ref) => /metadata\.json$/.test(ref.pathOrCommand)));
});

test("producer and timeline retain typed summary payloads and append one stable delta", async () => {
  const { registryPath, runner, root } = await fixture();
  const registry = await loadRegistry(registryPath);
  const project = registry.projects[0];
  await distillProject({
    project,
    registryVersion: registry.registryVersion,
    baseHash: project.evergreen.baseHash,
    runner,
    now: "2026-07-13T01:00:00.000Z",
  });
  const firstEvents = (await readFile(project.locations.events, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  await writeFile(
    join(root, "rarebit.jsonl"),
    `${await readFile(join(root, "rarebit.jsonl"), "utf8")}${JSON.stringify({ schemaVersion: 1, type: "rarebit_summary", summaryId: "summary-new", projectId: project.id, progress: "A second source fact.", observedAt: "2026-07-13T01:01:00.000Z", validAt: "2026-07-13T01:00:50.000Z", selection: { manifestHash: "c".repeat(64), occurrences: [{ occurrenceId: "message-c:0", contentHash: "hash-c", timestamp: "2026-07-13T01:00:50.000Z", sourceEntryId: "entry-c" }], payloads: [{ contentHash: "hash-c", occurrenceIds: ["message-c:0"] }], asOf: "2026-07-13T01:00:50.000Z", completeBranchProjection: true } })}\n`,
  );
  const second = await distillProject({
    project,
    registryVersion: registry.registryVersion,
    baseHash: project.evergreen.baseHash,
    runner,
    now: "2026-07-13T01:02:00.000Z",
  });
  const allEvents = (await readFile(project.locations.events, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(second.eventWrite.appended, 1);
  assert.deepEqual(
    allEvents.slice(0, firstEvents.length).map((event) => event.eventId),
    firstEvents.map((event) => event.eventId),
  );
  assert.equal(allEvents.length, firstEvents.length + 1);
  assert.equal(allEvents.at(-1).payload.reportedSummary.summaryId, "summary-new");
  assert.equal(allEvents.at(-1).at, "2026-07-13T01:00:50.000Z");
  const snapshot = collectAlphaSnapshot({
    manifestPath: registryPath,
    baseSnapshot: { sessions: [], liveAgents: [] },
    runBd: () => "[]",
    now: Date.parse("2026-07-13T01:03:00.000Z"),
  });
  const projected = snapshot.projects.find((item) => item.projectRef.id === project.id);
  const latest = projected.rarebitSummary.items.find((item) => item.id === "summary-new");
  assert.deepEqual(
    latest.selection.occurrences.map((item) => item.occurrenceId),
    ["message-c:0"],
  );
  assert.deepEqual(projected.eventDelta.items.at(-1).payload, allEvents.at(-1).payload);
  assert.equal(
    (await readFile(project.locations.evergreen, "utf8")).startsWith("# Audited Alpha\n"),
    true,
  );
});

test("same repo can hold two Projects and explicit overlapping Session identity stays ambiguous", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-registry-ambiguity-"));
  const shared = join(root, "shared");
  await mkdir(shared, { recursive: true });
  const summary = join(root, "summary.jsonl");
  await writeFile(
    summary,
    JSON.stringify({
      type: "rarebit_summary",
      summaryId: "same",
      sessionId: "ambiguous-session",
      summary: "must remain visible as ambiguous",
    }),
  );
  const registryPath = join(root, "registry.json");
  await writeFile(
    registryPath,
    JSON.stringify({
      schemaVersion: 1,
      registryVersion: "ambiguity-v1",
      projects: [
        ...["one", "two"].map((id) => ({
          id,
          name: id,
          locations: {
            repos: [shared],
            evergreen: null,
            beadsRoot: null,
            summaries: [summary],
            events: null,
            proposalDir: null,
          },
          associations: { sessionIds: ["ambiguous-session"] },
        })),
      ],
    }),
  );
  const snapshot = collectAlphaSnapshot({
    manifestPath: registryPath,
    baseSnapshot: { sessions: [{ id: "ambiguous-session", cwd: shared }], liveAgents: [] },
    now: Date.parse("2026-07-13T00:00:00.000Z"),
  });
  assert.equal(snapshot.projects.length, 2);
  for (const project of snapshot.projects) {
    assert.equal(project.rarebitSummary.state, "ambiguous");
    assert.equal(project.rarebitSummary.items?.length ?? 0, 0);
  }
  assert.ok(
    snapshot.trace.projectSources.every((source) =>
      source.diagnostics.some(
        (diagnostic) => diagnostic.reason === "overlapping_session_association",
      ),
    ),
  );
});

test("timeline loads a canonical registry from deployment configuration without copying it", async () => {
  const { registryPath } = await fixture();
  const loaded = loadProjectManifest({ path: registryPath });
  assert.equal(loaded.canonical, true);
  assert.equal(loaded.registryVersion, "test-registry-v1");
  assert.deepEqual(
    loaded.projects.map((project) => project.id),
    ["spanning-project", "shared-repo-one", "shared-repo-two"],
  );
  assert.deepEqual(
    loaded.projects.map((project) => project.sessionIds),
    [[], [], []],
  );
});
