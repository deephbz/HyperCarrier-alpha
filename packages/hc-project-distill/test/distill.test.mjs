import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendProjectEvents,
  createPiSynthesisClient,
  runCommand,
  sha256,
  distillProject,
  loadRegistry,
  normalizeEvergreenSynthesis,
  resolveSynthesisCitations,
  synthesizeEvergreen,
  SYNTHESIS_PROMPT_VERSION,
  writeProposal,
} from "../src/index.mjs";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "hc-distill-"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  const evergreen = join(repo, "evergreen.md");
  await writeFile(
    evergreen,
    "# Audited Evergreen\n\nOutcome: inspect the evidence.\n",
  );
  const summary = join(root, "summary.jsonl");
  await writeFile(
    summary,
    [
      JSON.stringify({
        schemaVersion: 1,
        type: "key_message_summary",
        summaryId: "sum-1",
        status: "ok",
        validAt: "2026-07-11T23:00:00Z",
        summary:
          "Progress: shipped a check. Findings: the check works. Questions/Requests: owner review requested. Next step: audit.",
      }),
      JSON.stringify({
        schemaVersion: 1,
        type: "key_message_summary",
        summaryId: "sum-2",
        validAt: "2026-07-11T23:01:00Z",
        summary:
          "Conflict: the old assumption is inconsistent with the new finding.",
      }),
      JSON.stringify({
        schemaVersion: 1,
        type: "key_message_summary",
        summaryId: "sum-3",
        validAt: "2026-07-11T23:02:00Z",
        summary: "Retired: the obsolete path is superseded.",
      }),
    ].join("\n") + "\n",
  );
  const source = join(root, "source.md");
  await writeFile(
    source,
    "# Evidence\n\nCONTRADICTION: old assumption conflicts with the new finding.\nRETIRE: obsolete path is superseded.\n",
  );
  const project = {
    id: "project-alpha",
    name: "Project Alpha",
    locations: {
      repo,
      beadsCwd: repo,
      evergreen,
      sourceDocs: [source],
      summaries: [summary],
      events: join(root, "events.jsonl"),
      proposalDir: join(root, "proposals"),
    },
  };
  const runner = async (command, args) => {
    if (command === "bd")
      return {
        code: 0,
        stdout:
          [
            JSON.stringify({
              id: "bd-1",
              title: "active",
              status: "open",
              assignee: "agent-a",
              updated_at: "2026-07-11T20:00:00Z",
            }),
            JSON.stringify({
              id: "bd-2",
              title: "blocked",
              status: "blocked",
              updated_at: "2026-07-11T20:01:00Z",
            }),
            JSON.stringify({
              id: "bd-3",
              title: "done",
              status: "closed",
              closed_at: "2026-07-11T20:02:00Z",
            }),
          ].join("\n") + "\n",
        stderr: "",
      };
    if (command === "git" && args[0] === "rev-parse")
      return { code: 0, stdout: "abc123\n", stderr: "" };
    if (command === "git" && args[0] === "status")
      return { code: 0, stdout: "## main\n M dirty.txt\n", stderr: "" };
    if (command === "git" && args[0] === "log")
      return {
        code: 0,
        stdout: "abc123\t2026-07-12T00:00:00Z\timplement evidence\n",
        stderr: "",
      };
    if (command === "git" && args[0] === "diff")
      return {
        code: 0,
        stdout: "diff --git a/dirty.txt b/dirty.txt\n",
        stderr: "",
      };
    throw new Error(`unexpected command ${command} ${args.join(" ")}`);
  };
  return {
    root,
    project,
    runner,
    baseHash: sha256(await readFile(evergreen, "utf8")),
  };
}

test("distills explicit Project sources, preserves dirty Git, contradiction/retirement, refs, and proposals", async () => {
  const fixture = await setup();
  const result = await distillProject({
    ...fixture,
    now: "2026-07-12T01:00:00.000Z",
    trace: true,
    registryVersion: "registry-v1",
  });
  assert.equal(result.projectId, "project-alpha");
  assert.ok(
    result.sourceStates.some(
      (state) => state.kind === "git" && state.status === "available",
    ),
  );
  assert.ok(result.trace.input.git.dirty);
  assert.ok(
    result.trace.events.some((event) => event.eventKind === "conflict"),
  );
  assert.ok(
    result.trace.events.some((event) => event.eventKind === "retirement"),
  );
  assert.ok(
    result.trace.events.some(
      (event) => event.eventKind === "delivery-evidence",
    ),
  );
  const narrowSummary = result.trace.events.find(
    (event) => event.payload.reportedSummary?.summaryId === "sum-1",
  );
  assert.deepEqual(narrowSummary.payload.reportedSummary.sections, {
    progress: "shipped a check.",
    findings: "the check works.",
    questionsrequests: "owner review requested.",
    nextstep: "audit.",
  });
  assert.equal(result.proposal.status, "proposed");
  const proposal = await readFile(result.proposal.paths.markdown, "utf8");
  assert.match(proposal, /status: proposed/);
  assert.match(proposal, /Contradictions and conflicts/);
  assert.match(proposal, /Retirements and supersessions/);
  assert.match(proposal, /audit_required: true/);
  assert.match(proposal, /project-alpha/);
  assert.equal(
    await readFile(fixture.project.locations.evergreen, "utf8"),
    "# Audited Evergreen\n\nOutcome: inspect the evidence.\n",
  );
  const canonical = await readFile(fixture.project.locations.evergreen, "utf8");
  assert.equal(proposal.startsWith(canonical), true);
  assert.match(proposal, /HYPERCARRIER_PROPOSAL_START/);
  const proposalPatch = await readFile(result.proposal.paths.patch, "utf8");
  assert.deepEqual(
    proposalPatch
      .split("\n")
      .filter((line) => line.startsWith("-") && !line.startsWith("---")),
    [],
  );
  assert.doesNotMatch(
    result.trace.events.map((item) => JSON.stringify(item.payload)).join("\n"),
    /reportedText/,
  );
  const eventLines = (await readFile(fixture.project.locations.events, "utf8"))
    .trim()
    .split("\n");
  assert.ok(eventLines.length >= 6);
  assert.ok(JSON.parse(eventLines[0]).sources.length > 0);
  assert.ok(
    result.trace.events.every((item) =>
      ["task", "commit", "reportedSummary"].includes(item.sourceFact.kind),
    ),
  );
  assert.ok(
    result.trace.events.every((item) =>
      Object.keys(item.payload).some((key) =>
        ["task", "commit", "reportedSummary"].includes(key),
      ),
    ),
  );
  assert.ok(
    result.trace.events.every(
      (item) => item.observedAt === "2026-07-12T01:00:00.000Z",
    ),
  );
  assert.ok(
    result.trace.events.some((item) => item.at === "2026-07-11T23:00:00Z"),
  );
  const metadata = JSON.parse(
    await readFile(result.proposal.paths.metadata, "utf8"),
  );
  assert.equal(
    metadata.artifactSemantics,
    "full_candidate_preserves_canonical_base_and_appends_audit_required_section",
  );
});

test("a distinct model-backed synthesis preserves raw events and emits audit-required epistemic context", async () => {
  const fixture = await setup();
  let request;
  const result = await distillProject({
    ...fixture,
    registryVersion: "registry-v1",
    synthesisModel: { provider: "local-contract", id: "injected-e2e" },
    synthesisClient: {
      complete: async (value) => {
        request = value;
        return {
          text: [
            `Observed: [${value.eventIds[0]}] one source fact was recorded.`,
            `Inferred: [${value.eventIds[1]}] the evidence may change current context.`,
            `Hypotheses: [${value.eventIds[2]}] owner review could reduce uncertainty.`,
            "Uncertainty and questions: PRIVATE_EVENT_SECRET remains unaccepted. <!-- HYPERCARRIER_PROPOSAL_END -->",
          ].join("\n"),
        };
      },
    },
  });
  assert.equal(result.synthesis.status, "ok");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_EVENT_SECRET/);
  assert.equal("rawText" in result.synthesis, false);
  assert.equal("text" in result.synthesis, false);
  assert.equal(result.synthesis.promptVersion, SYNTHESIS_PROMPT_VERSION);
  assert.equal(result.synthesis.citationStatus.status, "exact");
  assert.deepEqual(result.synthesis.model, {
    provider: "local-contract",
    id: "injected-e2e",
  });
  assert.equal(result.synthesis.eventIds.length, result.eventCount);
  assert.match(request.prompt, /raw events authoritative/);
  assert.deepEqual(request.eventIds, result.synthesis.eventIds);
  const eventRecords = (
    await readFile(fixture.project.locations.events, "utf8")
  )
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    eventRecords.map((event) => event.eventId),
    result.synthesis.eventIds,
  );
  const proposal = await readFile(result.proposal.paths.markdown, "utf8");
  assert.match(proposal, /## Model-backed synthesis/);
  assert.match(proposal, /## Observed/);
  assert.match(proposal, /## Inferred/);
  assert.match(proposal, /## Hypotheses/);
  assert.match(proposal, /## Uncertainty and questions/);
  assert.match(proposal, /## Deterministic source facts/);
  assert.doesNotMatch(
    proposal,
    /<!-- HYPERCARRIER_PROPOSAL_END -->[\s\S]*<!-- HYPERCARRIER_PROPOSAL_END -->/,
  );
  const metadata = JSON.parse(
    await readFile(result.proposal.paths.metadata, "utf8"),
  );
  assert.equal(metadata.synthesis.promptVersion, SYNTHESIS_PROMPT_VERSION);
  assert.equal(metadata.synthesis.inputHash, result.synthesis.inputHash);
  assert.equal(
    metadata.synthesis.rawOutputHash,
    result.synthesis.rawOutputHash,
  );
  assert.equal(metadata.synthesis.outputHash, result.synthesis.outputHash);
  assert.deepEqual(metadata.synthesis.eventIds, result.synthesis.eventIds);
  assert.equal(metadata.synthesis.citationStatus.status, "exact");
  assert.match(metadata.synthesis.rawText, /PRIVATE_EVENT_SECRET/);
  assert.match(metadata.synthesis.rawText, /HYPERCARRIER_PROPOSAL_END/);
  assert.equal(
    await readFile(fixture.project.locations.evergreen, "utf8"),
    "# Audited Evergreen\n\nOutcome: inspect the evidence.\n",
  );
});

test("model synthesis marks missing and unknown event citations partial", async () => {
  const eventId = "a".repeat(64);
  const result = await synthesizeEvergreen(
    {
      project: { id: "project-alpha", name: "Project Alpha" },
      sourceFrontierHash: "b".repeat(64),
      events: [{ eventId }],
    },
    {
      synthesisClient: {
        complete: async () => ({
          text: `Observed: [${"c".repeat(64)}] unknown. Inferred: uncited claim. Hypotheses: None stated. Uncertainty and questions: review needed.`,
        }),
      },
    },
  );
  assert.equal(result.status, "partial");
  assert.equal(result.citationStatus.status, "partial");
  assert.ok(
    result.citationStatus.diagnostics.some(
      (diagnostic) => diagnostic.reason === "unknown_event_citation",
    ),
  );
  assert.ok(
    result.citationStatus.diagnostics.some(
      (diagnostic) =>
        diagnostic.reason === "missing_event_citation" &&
        diagnostic.section === "Inferred",
    ),
  );
});

test("citation validation expands unique 8+ hex prefixes and rejects ambiguous or short refs", () => {
  const first = `12345678${"a".repeat(56)}`;
  const second = `87654321${"b".repeat(56)}`;
  const exact = resolveSynthesisCitations(
    normalizeEvergreenSynthesis(
      `Observed: [12345678..., 87654321] facts. Inferred: [12345678a] inference. Hypotheses: None stated. Uncertainty and questions: review.`,
    ),
    [first, second],
  );
  assert.equal(exact.status, "exact");
  assert.match(exact.text, new RegExp(`\\[${first}\\] \\[${second}\\]`));
  assert.equal(
    exact.diagnostics.filter(
      (diagnostic) => diagnostic.reason === "resolved_prefix",
    ).length,
    3,
  );

  const ambiguous = resolveSynthesisCitations(
    normalizeEvergreenSynthesis(
      "Observed: [abcdef12] fact. Inferred: [abc] claim. Hypotheses: None stated. Uncertainty and questions: review.",
    ),
    [`abcdef12${"0".repeat(56)}`, `abcdef12${"1".repeat(56)}`],
  );
  assert.equal(ambiguous.status, "partial");
  assert.ok(
    ambiguous.diagnostics.some(
      (diagnostic) => diagnostic.reason === "ambiguous_event_citation",
    ),
  );
  assert.ok(
    ambiguous.diagnostics.some(
      (diagnostic) => diagnostic.reason === "too_short_event_citation",
    ),
  );
});

test("Pi synthesis client uses an ephemeral no-tools argv and retains exact private provenance", async () => {
  let invocation;
  const client = createPiSynthesisClient({
    cwd: "/fixture/project",
    timeoutMs: 12_345,
    runner: async (command, argv, options) => {
      invocation = { command, argv, options };
      return { code: 0, stdout: "Observed: None stated.", stderr: "" };
    },
  });
  const response = await client.complete({
    prompt: "private prompt",
    model: { provider: "openrouter", id: "z-ai/glm-5.2" },
  });
  assert.equal(invocation.command, "pi");
  assert.deepEqual(invocation.argv.slice(0, -1), [
    "--print",
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--model",
    "openrouter/z-ai/glm-5.2",
    "--thinking",
    "low",
  ]);
  assert.equal(invocation.argv.at(-1), "private prompt");
  assert.equal(invocation.options.timeoutMs, 12_345);
  assert.deepEqual(
    response.operationalProvenance.argv,
    invocation.argv.slice(0, -1),
  );
  assert.equal(
    response.operationalProvenance.promptArg.sha256,
    sha256("private prompt"),
  );
  assert.equal(response.operationalProvenance.promptArg.bytes, 14);
  assert.equal(
    response.operationalProvenance.invocationArgvHash,
    sha256(invocation.argv),
  );
  assert.equal(response.operationalProvenance.cwd, "/fixture/project");
});

test("Evergreen synthesis normalization always exposes bounded epistemic labels", () => {
  const normalized = normalizeEvergreenSynthesis(
    `Observed: ${"x".repeat(1_400)}\nHypotheses: one possibility.`,
  );
  assert.match(
    normalized,
    /^## Observed\n\n.{1,1200}…?\n\n## Inferred\n\nNone stated\./s,
  );
  assert.match(normalized, /## Hypotheses\n\none possibility\./);
  assert.match(normalized, /## Uncertainty and questions\n\nNone stated\.$/);
});

test("reruns and overlapping distillers are duplicate-safe", async () => {
  const fixture = await setup();
  const options = { ...fixture, registryVersion: "registry-v1" };
  const results = await Promise.all([
    distillProject(options),
    distillProject(options),
    distillProject(options),
  ]);
  assert.ok(results.every((result) => result.proposal.status === "proposed"));
  const lines = (await readFile(fixture.project.locations.events, "utf8"))
    .trim()
    .split("\n");
  const ids = lines.map((line) => JSON.parse(line).eventId);
  assert.equal(new Set(ids).size, ids.length);
  const proposalFiles = (await import("node:fs/promises")).readdir(
    fixture.project.locations.proposalDir,
  );
  assert.equal((await proposalFiles).length, 1);
  assert.equal(
    (
      await stat(
        join(fixture.project.locations.proposalDir, (await proposalFiles)[0]),
      )
    ).mode & 0o777,
    0o700,
  );
});

test("a frontier change appends only the new source fact and keeps old event identity", async () => {
  const fixture = await setup();
  const first = await distillProject({
    ...fixture,
    registryVersion: "registry-v1",
    now: "2026-07-12T01:00:00.000Z",
  });
  const firstEvents = (await readFile(fixture.project.locations.events, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  await writeFile(
    join(fixture.root, "summary.jsonl"),
    `${await readFile(join(fixture.root, "summary.jsonl"), "utf8")}${JSON.stringify({ schemaVersion: 1, type: "key_message_summary", summaryId: "sum-new", validAt: "2026-07-12T00:59:00Z", summary: "Progress: one new independently identified fact." })}\n`,
  );
  const second = await distillProject({
    ...fixture,
    registryVersion: "registry-v1",
    now: "2026-07-12T02:00:00.000Z",
  });
  const allEvents = (await readFile(fixture.project.locations.events, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.notEqual(first.sourceFrontierHash, second.sourceFrontierHash);
  assert.equal(second.eventWrite.appended, 1);
  assert.equal(allEvents.length, firstEvents.length + 1);
  assert.deepEqual(
    allEvents.slice(0, firstEvents.length).map((item) => item.eventId),
    firstEvents.map((item) => item.eventId),
  );
  assert.equal(allEvents.at(-1).payload.reportedSummary.summaryId, "sum-new");
  assert.equal(allEvents.at(-1).at, "2026-07-12T00:59:00Z");
  assert.equal(allEvents.at(-1).observedAt, "2026-07-12T02:00:00.000Z");
});

test("a changed task snapshot gets a new event version without duplicating unchanged facts", async () => {
  const fixture = await setup();
  let title = "active";
  const runner = async (command, args, options) => {
    const result = await fixture.runner(command, args, options);
    if (command !== "bd") return result;
    const records = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .map((record) => (record.id === "bd-1" ? { ...record, title } : record));
    return {
      ...result,
      stdout: `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    };
  };
  await distillProject({ ...fixture, runner, registryVersion: "registry-v1" });
  const firstEvents = (await readFile(fixture.project.locations.events, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  title = "active, clarified";
  const second = await distillProject({
    ...fixture,
    runner,
    registryVersion: "registry-v1",
  });
  const allEvents = (await readFile(fixture.project.locations.events, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(second.eventWrite.appended, 1);
  assert.equal(allEvents.length, firstEvents.length + 1);
  assert.deepEqual(
    allEvents.slice(0, firstEvents.length).map((event) => event.eventId),
    firstEvents.map((event) => event.eventId),
  );
  assert.equal(allEvents.at(-1).payload.task.id, "bd-1");
  assert.equal(allEvents.at(-1).payload.task.title, "active, clarified");
  assert.notEqual(
    allEvents.at(-1).eventId,
    allEvents.find((event) => event.payload.task?.id === "bd-1").eventId,
  );
});

test("stale owner base rejects proposal without changing canonical Evergreen", async () => {
  const fixture = await setup();
  const first = await distillProject(fixture);
  assert.equal(first.proposal.status, "proposed");
  await writeFile(fixture.project.locations.evergreen, "# Owner revision\n");
  const stale = await distillProject(fixture);
  assert.equal(stale.proposal.status, "rejected_stale_base");
  assert.equal(stale.proposal.expectedBaseHash, fixture.baseHash);
  assert.equal(
    await readFile(fixture.project.locations.evergreen, "utf8"),
    "# Owner revision\n",
  );
});

test("Beads timeout, lock/unavailable, malformed JSONL, and partial sources stay structured", async () => {
  const fixture = await setup();
  const timeout = await distillProject({
    ...fixture,
    runner: async (command) =>
      command === "bd"
        ? {
            code: null,
            stdout: "",
            stderr: "",
            error: Object.assign(new Error("database LOCK"), {
              code: "ETIMEDOUT",
            }),
          }
        : { code: 0, stdout: "", stderr: "" },
  });
  assert.equal(
    timeout.sourceStates.find((state) => state.kind === "beads").status,
    "source_unavailable",
  );
  const malformedFixture = await readFile(
    new URL("./fixtures/beads-malformed.jsonl", import.meta.url),
    "utf8",
  );
  const malformed = await distillProject({
    ...fixture,
    runner: async (command, args, options) =>
      command === "bd"
        ? { code: 0, stdout: malformedFixture, stderr: "" }
        : fixture.runner(command, args, options),
  });
  assert.match(
    malformed.sourceStates.find((state) => state.kind === "beads").status,
    /^(partial|malformed)$/,
  );
  const partial = await distillProject({
    ...fixture,
    project: {
      ...fixture.project,
      locations: {
        ...fixture.project.locations,
        summaries: [join(fixture.root, "missing-summary.jsonl")],
        sourceDocs: [join(fixture.root, "missing-source.md")],
      },
    },
  });
  assert.equal(
    partial.sourceStates.find((state) => state.kind === "summary").status,
    "missing",
  );
  assert.equal(
    partial.sourceStates.find(
      (state) =>
        state.kind === "markdown" && state.ref.includes("missing-source"),
    ).status,
    "missing",
  );
});

test("event append remains independently retryable when proposal output fails", async () => {
  const fixture = await setup();
  const blocker = join(fixture.root, "not-a-directory");
  await writeFile(blocker, "a regular file");
  const independentEvents = join(fixture.root, "events-independent.jsonl");
  const result = await distillProject({
    ...fixture,
    eventsPath: independentEvents,
    proposalDir: blocker,
  });
  assert.equal(result.eventWrite.status, "ok");
  assert.equal(result.proposal.status, "failure");
  assert.ok((await readFile(independentEvents, "utf8")).length > 0);
});

test("registry requires explicit stable IDs and treats paths as locations", async () => {
  const fixture = await setup();
  const registryPath = join(fixture.root, "registry.json");
  await writeFile(
    registryPath,
    JSON.stringify({
      schemaVersion: 1,
      registryVersion: "v1",
      projects: [
        { id: "stable-id", name: "Moved project", locations: { repo: "repo" } },
      ],
    }),
  );
  const registry = await loadRegistry(registryPath);
  assert.equal(registry.projects[0].id, "stable-id");
  assert.equal(registry.projects[0].locations.repo, join(fixture.root, "repo"));
  await writeFile(
    registryPath,
    JSON.stringify({
      schemaVersion: 1,
      registryVersion: "v1",
      projects: [{ name: "no id", locations: {} }],
    }),
  );
  await assert.rejects(() => loadRegistry(registryPath), /explicit stable id/);
});

test("unsafe Project IDs are rejected before path or frontmatter interpolation", async () => {
  const fixture = await setup();
  for (const id of [
    "../escaped",
    "id/child",
    "id\nstatus: accepted",
    "",
    ".hidden",
  ]) {
    const registryPath = join(fixture.root, `registry-${Math.random()}.json`);
    await writeFile(
      registryPath,
      JSON.stringify({
        schemaVersion: 1,
        registryVersion: "v1",
        projects: [{ id, name: "Name", locations: {} }],
      }),
    );
    await assert.rejects(
      () => loadRegistry(registryPath),
      /explicit stable id/,
    );
  }
});

test("proposal frontmatter and headings remain safe for hostile Project names", async () => {
  const fixture = await setup();
  const result = await distillProject({
    ...fixture,
    project: {
      ...fixture.project,
      name: "Name\nowner: attacker\r\n# injected",
    },
  });
  assert.equal(result.proposal.status, "proposed");
  const markdown = await readFile(result.proposal.paths.markdown, "utf8");
  assert.match(markdown, /project_id: "project-alpha"/);
  assert.doesNotMatch(markdown, /^owner: attacker$/m);
  assert.doesNotMatch(markdown, /^# injected$/m);
});

test("truncated event tails are quarantined before the next append", async () => {
  const fixture = await setup();
  const eventPath = join(fixture.root, "truncated-events.jsonl");
  await writeFile(eventPath, '{"eventId":"partial"');
  const event = {
    eventId: "complete",
    idempotencyKey: "complete",
    type: "project_event",
    projectId: fixture.project.id,
  };
  await appendProjectEvents(eventPath, [event]);
  const lines = (await readFile(eventPath, "utf8")).trim().split("\n");
  assert.deepEqual(lines.map(JSON.parse), [event]);
  const quarantine = await readdir(`${eventPath}.quarantine`);
  assert.equal(quarantine.length, 1);
  assert.equal(
    await readFile(join(`${eventPath}.quarantine`, quarantine[0]), "utf8"),
    '{"eventId":"partial"',
  );
});

test("proposal publication repairs existing permissions and rejects symlinked private paths", async () => {
  const fixture = await setup();
  const proposalDir = join(fixture.root, "permissive-proposals");
  await mkdir(proposalDir, { mode: 0o755 });
  const result = await distillProject({ ...fixture, proposalDir });
  assert.equal(result.proposal.status, "proposed");
  assert.equal((await stat(proposalDir)).mode & 0o777, 0o700);
  const linkTarget = join(fixture.root, "real-events.jsonl");
  const link = join(fixture.root, "events-link.jsonl");
  await symlink(linkTarget, link);
  const failed = await distillProject({
    ...fixture,
    eventsPath: link,
    proposalDir: join(fixture.root, "another-proposals"),
  });
  assert.equal(failed.eventWrite.status, "failure");
  assert.match(failed.eventWrite.error.message, /symlink/);
});

test("missing canonical Evergreen is never converted into the empty-text hash", async () => {
  const fixture = await setup();
  const project = {
    ...fixture.project,
    locations: {
      ...fixture.project.locations,
      evergreen: join(fixture.root, "missing-evergreen.md"),
    },
  };
  const result = await distillProject({
    ...fixture,
    project,
    baseHash: sha256(""),
  });
  assert.equal(result.proposal.status, "rejected_missing_canonical");
  assert.notEqual(result.proposal.status, "proposed");
});

test("pre-existing direct artifacts are explicit partial state, never a proposed bundle", async () => {
  const fixture = await setup();
  const sourceFrontierHash = "frontier-known";
  const proposalId = sha256({
    projectId: fixture.project.id,
    baseHash: fixture.baseHash,
    sourceFrontierHash,
    derivationVersion: "hc-distiller-v2",
  });
  const proposalDir = join(fixture.root, "partial-proposals");
  await mkdir(proposalDir, { recursive: true });
  await writeFile(
    join(proposalDir, `${fixture.project.id}-${proposalId}.patch`),
    "CORRUPTED OLD PATCH\n",
  );
  const result = await writeProposal(
    {
      project: fixture.project,
      baseHash: fixture.baseHash,
      sourceFrontierHash,
      sourceStates: [],
      events: [],
    },
    { proposalDir },
  );
  assert.equal(result.status, "partial");
  assert.notEqual(result.status, "proposed");
});

test("real temporary Beads 1.1.0 export is consumed through the command path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hc-distill-real-bd-"));
  const initialized = await runCommand("bd", ["init"], {
    cwd: root,
    timeoutMs: 10000,
  });
  if (initialized.code !== 0)
    return t.skip(
      `bd init unavailable: ${initialized.error?.message ?? initialized.stderr}`,
    );
  const created = await runCommand(
    "bd",
    ["create", "real distiller probe", "--json"],
    { cwd: root, timeoutMs: 10000 },
  );
  if (created.code !== 0)
    return t.skip(
      `bd create unavailable: ${created.error?.message ?? created.stderr}`,
    );
  const exported = await runCommand("bd", ["--readonly", "--json", "export"], {
    cwd: root,
    timeoutMs: 10000,
  });
  assert.equal(exported.code, 0);
  assert.match(exported.stdout, /real distiller probe/);
});

test("command timeout escalates through the whole detached process group", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-distill-timeout-"));
  const script = join(root, "spawn-child.sh");
  const childPidFile = join(root, "child.pid");
  await writeFile(
    script,
    "#!/bin/sh\n(sleep 30) &\necho $! > \"$HC_CHILD_PID_FILE\"\ntrap '' TERM\nwait\n",
  );
  await chmod(script, 0o700);
  const result = await runCommand(script, [], {
    env: { ...process.env, HC_CHILD_PID_FILE: childPidFile },
    timeoutMs: 500,
    killGraceMs: 100,
  });
  assert.equal(result.error.code, "ETIMEDOUT");
  const childPid = Number((await readFile(childPidFile, "utf8")).trim());
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => process.kill(childPid, 0), /ESRCH|EINVAL/);
});
