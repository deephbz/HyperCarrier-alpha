import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  terminalOccurrencePresentation,
  terminalSummaryPresentation,
} from "./visual.mjs";
import { sha256 } from "../../../packages/hc-rarebit/src/rarebit-core.mjs";
import { extractRarebitSynthesisReceipt } from "../../../packages/hc-rarebit/src/rarebit-model.mjs";
import {
  eventExpectation,
  normalizeNativeSelection,
  nativeAvailabilityForError,
  projectRarebitConsumerStatus,
  projectionTokens,
  rarebitNotificationSound,
  readMaterializationArtifact,
  reconcileRarebitPane,
  reportRarebitPane,
  shouldPublishRarebitMetadata,
} from "./rarebit.mjs";

const user = {
  occurrenceId: "o-user",
  sourceEntryId: "e-user",
  order: 0,
  role: "user",
  outcome: "user",
  contentHash: "h-user",
};
const continuation = {
  occurrenceId: "o-cont",
  sourceEntryId: "e-cont",
  order: 1,
  role: "assistant",
  outcome: "continuation",
  contentHash: "h-cont",
};
const stop = {
  occurrenceId: "o-stop",
  sourceEntryId: "e-stop",
  order: 2,
  role: "assistant",
  outcome: "stop",
  contentHash: "h-stop",
};
function selection(occurrences) {
  const selectorVersion = "rarebit-selector-v1";
  const payloads = [
    ...new Set(occurrences.map(({ contentHash }) => contentHash)),
  ].map((contentHash) => ({
    contentHash,
    occurrenceIds: occurrences
      .filter((occurrence) => occurrence.contentHash === contentHash)
      .map((occurrence) => occurrence.occurrenceId),
  }));
  return {
    manifestHash: sha256({ selectorVersion, occurrences, payloads }),
    selectorVersion,
    occurrences,
    payloads,
  };
}
function receipt({
  boundary = "owner_request",
  sessionStatus = "user_requested",
  reason = "owner_request_recorded",
  selected = selection([user]),
  observedAt = "2026-07-25T00:00:00.000Z",
} = {}) {
  const latestUser = selected.occurrences
    .filter(
      (occurrence) =>
        occurrence.role === "user" && occurrence.outcome === "user",
    )
    .at(-1);
  return {
    type: "rarebit_summary",
    schemaVersion: 4,
    status: "ok",
    sessionId: "session-1",
    branch: {
      leafId: "leaf-1",
      entryCount: selected.occurrences.length,
      pathHash: "b".repeat(64),
    },
    lifecycleBoundary: boundary,
    sessionStatus,
    statusReason: reason,
    summary: "Consumer must not use this prose.",
    observedAt,
    jobId: "a".repeat(64),
    selection: {
      manifestHash: selected.manifestHash,
      selectorVersion: selected.selectorVersion,
      occurrenceCount: selected.occurrences.length,
      uniquePayloadCount: selected.payloads.length,
      latestUserSourceEntryId: latestUser?.sourceEntryId ?? null,
    },
    implementationVersion: "hc-rarebit-summary-v4",
    synthesisMode: "forced",
    inputCoveragePolicy: {
      strategy: "complete_or_explicit_overflow",
      maxPromptChars: 1_000,
    },
    promptVersion: "rarebit-summary-v4",
    model: { provider: "test", id: "model" },
    modelProvenance: { source: "test", status: "resolved" },
    synthesis: extractRarebitSynthesisReceipt(
      {},
      {
        requestedModel: { provider: "test", id: "model" },
        startedAt: observedAt,
        completedAt: observedAt,
        durationMs: 0,
      },
    ),
  };
}
function project({
  native,
  records,
  expectation = "snapshot",
  deadlineExpired = false,
}) {
  return projectRarebitConsumerStatus({
    native,
    materialization: { availability: "available", records },
    expectation,
    deadlineExpired,
  });
}

test("plugin manifest declares the v4 consumer release without changing its identity", async () => {
  const manifest = await readFile(
    new URL("../herdr-plugin.toml", import.meta.url),
    "utf8",
  );
  assert.match(manifest, /^id = "rarebit-status"$/m);
  assert.match(manifest, /^version = "0\.4\.0"$/m);
  assert.match(manifest, /\[\[actions\]\]\nid = "open"/);
});

test("deck diagnoses the bounded v4 current head rather than implying a full sidecar scan", async () => {
  const source = await readFile(
    new URL("./rarebit-dashboard.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /headReference/);
  assert.match(source, /history is optional via the package reader/);
  assert.doesNotMatch(source, /unfiltered sidecar records/);
});

test("deck branding names Rarebit Status without lab or demo residue", async () => {
  const source = await readFile(
    new URL("./rarebit-dashboard.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /RAREBIT STATUS/);
  assert.match(source, /Exact Pi Session evidence/);
  assert.doesNotMatch(
    source,
    /HERDR UI LAB|REAL local Rarebit data|UI lab deck|Sentinel|demo|preview/i,
  );
});

test("deck renders the package-owned marker and Summary grammar", () => {
  const palette = {
    reset: "</>",
    bold: "<bold>",
    dim: "<dim>",
    red: "<red>",
    green: "<green>",
    yellow: "<yellow>",
    blue: "<blue>",
  };
  assert.deepEqual(terminalOccurrencePresentation(user, palette), {
    mark: "□",
    label: "user message",
    tone: "user",
    salience: "standard",
    marker: "<green>□</>",
  });
  assert.equal(
    terminalOccurrencePresentation(
      { ...user, producer: "extension-rpc" },
      palette,
    ).label,
    "user message",
  );
  assert.equal(
    terminalOccurrencePresentation(continuation, palette).marker,
    "<blue>•</>",
  );
  assert.equal(
    terminalOccurrencePresentation(continuation, palette).label,
    "agent continues",
  );
  assert.equal(
    terminalOccurrencePresentation(stop, palette).marker,
    "<bold>●</>",
  );
  assert.equal(
    terminalOccurrencePresentation(stop, palette).label,
    "agent stops",
  );
  assert.equal(
    terminalSummaryPresentation(
      { status: "needs_attention", sourcePending: false },
      palette,
    ).text,
    "<yellow><bold>◆! needs you</>",
  );
  assert.equal(
    terminalSummaryPresentation(
      { status: "needs_attention", sourcePending: true },
      palette,
    ).text,
    "needs you · source pending",
  );
  assert.equal(
    terminalSummaryPresentation(
      { status: "finished", sourcePending: false },
      palette,
    ).text,
    "appears finished",
  );
  assert.equal(
    terminalSummaryPresentation(
      { status: "error", sourcePending: false },
      palette,
    ).text,
    "<red>× error</>",
  );
});

test("sidebar projection uses mutually exclusive visual-tone tokens", () => {
  const emptyStates = {
    rarebit_state_neutral: null,
    rarebit_state_attention: null,
    rarebit_state_muted: null,
    rarebit_state_diagnostic: null,
  };
  assert.deepEqual(
    projectionTokens({
      summary: { status: "needs_attention", sourcePending: false },
    }),
    {
      rarebit_attention: "◆!",
      rarebit_error: null,
      ...emptyStates,
      rarebit_state_attention: "needs you",
    },
  );
  assert.deepEqual(
    projectionTokens({
      summary: { status: "needs_attention", sourcePending: true },
    }),
    {
      rarebit_attention: null,
      rarebit_error: null,
      ...emptyStates,
      rarebit_state_neutral: "needs you · source pending",
    },
  );
  assert.deepEqual(
    projectionTokens({ summary: { status: "finished", sourcePending: false } }),
    {
      rarebit_attention: null,
      rarebit_error: null,
      ...emptyStates,
      rarebit_state_neutral: "appears finished",
    },
  );
  assert.deepEqual(
    projectionTokens({
      summary: { status: "ineligible", sourcePending: false },
    }),
    {
      rarebit_attention: null,
      rarebit_error: null,
      ...emptyStates,
      rarebit_state_muted: "ineligible",
    },
  );
  assert.deepEqual(
    projectionTokens({ summary: { status: "error", sourcePending: false } }),
    {
      rarebit_attention: null,
      rarebit_error: "×",
      ...emptyStates,
      rarebit_state_diagnostic: "error",
    },
  );
});

test("sidecar-only owner request is qualified and does not claim current applicability", () => {
  const owner = receipt();
  const result = project({
    native: { availability: "missing" },
    records: [owner],
    expectation: "owner_request",
  });
  assert.deepEqual(
    {
      status: result.status,
      label: result.label,
      syncState: result.syncState,
      applicability: result.applicability,
      sourcePending: result.sourcePending,
    },
    {
      status: "user_requested",
      label: "request recorded · source pending",
      syncState: "request_source_pending",
      applicability: "request_cut",
      sourcePending: true,
    },
  );
  assert.equal(result.text, "Consumer must not use this prose.");
  assert.deepEqual(
    {
      sessionId: result.lineage.sessionId,
      manifestHash: result.lineage.selectionManifestHash,
      selectorVersion: result.lineage.selectorVersion,
    },
    {
      sessionId: "session-1",
      manifestHash: owner.selection.manifestHash,
      selectorVersion: owner.selection.selectorVersion,
    },
  );
});

test("native continuation preserves request generation and stopped continuation reports settlement pending", () => {
  const owner = receipt();
  const working = project({
    native: {
      availability: "available",
      sessionId: "session-1",
      selection: selection([user, continuation], "m2"),
    },
    records: [owner],
    expectation: "owner_request",
  });
  assert.equal(working.syncState, "request_current");
  assert.equal(working.applicability, "request_generation");
  const stopped = project({
    native: {
      availability: "available",
      sessionId: "session-1",
      selection: selection([user, continuation, stop], "m3"),
    },
    records: [owner],
    expectation: "agent_settled",
  });
  assert.equal(stopped.syncState, "settlement_pending");
  assert.equal(stopped.retry.reason, "settlement_pending");
});

test("settled exact selection supersedes the request and producer errors stay explicit", () => {
  const settled = receipt({
    boundary: "agent_settled",
    sessionStatus: "finished",
    reason: "all_requests_accomplished",
    selected: selection([user, continuation, stop], "m3"),
    observedAt: "2026-07-25T00:01:00.000Z",
  });
  const result = project({
    native: {
      availability: "available",
      sessionId: "session-1",
      selection: selection([user, continuation, stop], "m3"),
    },
    records: [receipt(), settled],
    expectation: "agent_settled",
  });
  assert.deepEqual(
    {
      status: result.status,
      label: result.label,
      syncState: result.syncState,
      applicability: result.applicability,
    },
    {
      status: "finished",
      label: "appears finished",
      syncState: "assessment_current",
      applicability: "exact_selection",
    },
  );
  const malformed = project({
    native: {
      availability: "available",
      sessionId: "session-1",
      selection: selection([user]),
    },
    records: [{ type: "rarebit_summary", schemaVersion: 999 }],
    deadlineExpired: true,
  });
  assert.equal(malformed.reason, "unsupported");
});

test("normalizes the native reader's manifest-shaped selector before producer projection", () => {
  const selected = selection([user]);
  const actualReaderShape = {
    manifestHash: selected.manifestHash,
    manifest: { selectorVersion: selected.selectorVersion },
    occurrences: selected.occurrences,
    payloads: selected.payloads,
  };
  const normalized = normalizeNativeSelection(actualReaderShape);
  assert.equal(normalized.selectorVersion, selected.selectorVersion);
  const result = project({
    native: {
      availability: "available",
      sessionId: "session-1",
      selection: normalized,
    },
    records: [receipt()],
  });
  assert.equal(result.syncState, "request_current");
});

test("classifies the producer's typed absent explicit path as missing", () => {
  assert.equal(
    nativeAvailabilityForError({
      name: "RarebitQueryError",
      message: "Pi Session file not found: /tmp/exact.jsonl",
    }),
    "missing",
  );
  assert.equal(
    nativeAvailabilityForError({
      name: "RarebitQueryError",
      message: "No persisted Pi Session has exact ID x",
    }),
    "unreadable",
  );
});

test("Herdr uses the package reader result and preserves its explicit unreadable state", async () => {
  const artifact = await readMaterializationArtifact("/tmp/session.jsonl", {
    readCurrent: async () => ({
      path: "/tmp/session.rarebit.jsonl",
      availability: "unreadable",
      receipt: null,
      records: [],
      head: null,
      diagnostics: { tornTail: true, reason: "sidecar_head_invalid" },
    }),
  });
  assert.equal(artifact.availability, "unreadable");
  assert.equal(artifact.reason, "sidecar_head_invalid");
  assert.equal(artifact.records.length, 0);
  const incomplete = projectRarebitConsumerStatus({
    native: {
      availability: "available",
      sessionId: "session-1",
      selection: selection([user]),
    },
    materialization: artifact,
  });
  assert.equal(incomplete.retry.reason, "materialization_unreadable");
});

test("maps runtime evidence to producer expectations and gates notification sound", () => {
  assert.equal(
    eventExpectation("pane.agent_status_changed", {
      data: { agent_status: "working" },
    }),
    "owner_request",
  );
  for (const agent_status of ["done", "blocked"])
    assert.equal(
      eventExpectation("pane.agent_status_changed", { data: { agent_status } }),
      "agent_settled",
    );
  for (const agent_status of ["idle", "unknown"])
    assert.equal(
      eventExpectation("pane.agent_status_changed", { data: { agent_status } }),
      "snapshot",
    );
  assert.equal(eventExpectation("pane.agent_detected", {}), "snapshot");
  assert.equal(
    rarebitNotificationSound({
      status: "needs_attention",
      sourcePending: false,
    }),
    "request",
  );
  assert.equal(
    rarebitNotificationSound({
      status: "needs_attention",
      sourcePending: true,
    }),
    "none",
  );
  assert.equal(
    rarebitNotificationSound({
      status: "user_requested",
      sourcePending: false,
    }),
    "none",
  );
});

test("reconciler publishes native/request and settled/final upgrades, including a delayed final receipt", async () => {
  const base = {
    paneId: "pane-reconcile",
    selection: { occurrences: [] },
    session: { id: "session-1" },
  };
  const reports = [];
  const reconcile = async (views, elapsedBySleep = 200) => {
    let elapsed = 0;
    return reconcileRarebitPane("pane-reconcile", {
      bindingForPane: () => ({ sessionFile: "/tmp/reconcile.jsonl" }),
      load: async () => ({ ...base, summary: views.shift() }),
      sleep: async () => {
        elapsed += elapsedBySleep;
      },
      now: () => elapsed,
      report: (view) => reports.push(view.summary.syncState),
      deadlineMs: 30_000,
    });
  };
  await reconcile([
    { syncState: "request_source_pending", sourcePending: true },
    { syncState: "request_current", sourcePending: false },
  ]);
  await reconcile([
    { syncState: "settlement_pending", sourcePending: false },
    { syncState: "assessment_current", sourcePending: false },
  ]);
  await reconcile(
    [
      { syncState: "awaiting_artifacts", sourcePending: false },
      { syncState: "assessment_current", sourcePending: false },
    ],
    2_000,
  );
  assert.deepEqual(reports, [
    "request_source_pending",
    "request_current",
    "settlement_pending",
    "assessment_current",
    "assessment_current",
  ]);
});

test("a newer pane/path reconciliation fences an older working loop", async () => {
  let releaseOldSleep;
  const reports = [];
  const base = {
    paneId: "pane-fence",
    selection: { occurrences: [] },
    session: { id: "session-1" },
  };
  const oldLoad = async () => ({
    ...base,
    summary: { syncState: "awaiting_artifacts" },
  });
  const old = reconcileRarebitPane("pane-fence", {
    bindingForPane: () => ({ sessionFile: "/tmp/fence.jsonl" }),
    load: oldLoad,
    sleep: () =>
      new Promise((resolve) => {
        releaseOldSleep = resolve;
      }),
    now: () => 0,
    report: (view) => reports.push(`old:${view.summary.syncState}`),
    deadlineMs: 30_000,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const newer = await reconcileRarebitPane("pane-fence", {
    bindingForPane: () => ({ sessionFile: "/tmp/fence.jsonl" }),
    load: async () => ({
      ...base,
      summary: { syncState: "assessment_current" },
    }),
    report: (view) => reports.push(`new:${view.summary.syncState}`),
    now: () => 0,
  });
  releaseOldSleep();
  await old;
  assert.ok(newer);
  assert.deepEqual(reports, ["new:assessment_current"]);
});

test("awaiting artifacts never publishes a syncing sidebar token", async () => {
  const root = await mkdtemp(join(tmpdir(), "rarebit-herdr-deferred-"));
  const fakeHerdr = join(root, "herdr");
  const stateDirectory = join(root, "state");
  const invoked = join(root, "invoked");
  await writeFile(
    fakeHerdr,
    `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(invoked)}, process.argv.slice(2).join(' '));\nprocess.stdout.write('{}\\n');\n`,
  );
  await chmod(fakeHerdr, 0o755);
  const oldBin = process.env.HERDR_BIN_PATH;
  const oldState = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_BIN_PATH = fakeHerdr;
  process.env.HERDR_PLUGIN_STATE_DIR = stateDirectory;
  try {
    const view = {
      paneId: "pane-await",
      sessionFile: "/tmp/await.jsonl",
      session: { id: null },
      nativeArtifact: { availability: "missing" },
      materialization: {
        path: "/tmp/await.rarebit.jsonl",
        availability: "missing",
      },
      summary: { syncState: "awaiting_artifacts", status: "error" },
    };
    assert.equal(shouldPublishRarebitMetadata(view), false);
    reportRarebitPane(view, "test:awaiting");
    await assert.rejects(readFile(invoked, "utf8"));
    const saved = JSON.parse(
      (await readFile(join(stateDirectory, "receipts.jsonl"), "utf8")).trim(),
    );
    assert.equal(saved.kind, "rarebit_refresh_deferred");
  } finally {
    if (oldBin === undefined) delete process.env.HERDR_BIN_PATH;
    else process.env.HERDR_BIN_PATH = oldBin;
    if (oldState === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = oldState;
  }
});

test("reports sync, applicability, and independent artifact refs", async () => {
  const root = await mkdtemp(join(tmpdir(), "rarebit-herdr-report-"));
  const fakeHerdr = join(root, "herdr");
  const stateDirectory = join(root, "state");
  const invoked = join(root, "invoked.json");
  await writeFile(
    fakeHerdr,
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(invoked)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write("{}\\n");\n`,
  );
  await chmod(fakeHerdr, 0o755);
  const oldBin = process.env.HERDR_BIN_PATH;
  const oldState = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_BIN_PATH = fakeHerdr;
  process.env.HERDR_PLUGIN_STATE_DIR = stateDirectory;
  try {
    reportRarebitPane(
      {
        paneId: "pane-1",
        sessionFile: "/tmp/session.jsonl",
        session: { id: "session-1" },
        selection: { manifestHash: "m1" },
        nativeArtifact: { availability: "missing" },
        materialization: {
          path: "/tmp/session.rarebit.jsonl",
          availability: "available",
          recordCount: 1,
        },
        summary: {
          status: "user_requested",
          reason: "owner_request_recorded",
          label: "request recorded · source pending",
          sourcePending: true,
          syncState: "request_source_pending",
          applicability: "request_cut",
          settled: false,
          lineage: { jobId: "job-1" },
        },
      },
      "test",
    );
    const saved = JSON.parse(
      (await readFile(join(stateDirectory, "receipts.jsonl"), "utf8")).trim(),
    );
    assert.equal(saved.syncState, "request_source_pending");
    assert.equal(saved.nativeArtifact.availability, "missing");
    assert.equal(
      saved.materializationArtifact.path,
      "/tmp/session.rarebit.jsonl",
    );
    const args = JSON.parse(await readFile(invoked, "utf8"));
    assert.ok(
      !args.includes("rarebit_state=request recorded · source pending"),
    );
    assert.ok(
      args.includes("rarebit_state_neutral=request recorded · source pending"),
    );
    assert.ok(!args.includes("rarebit_badge=RAREBIT"));
    for (const token of [
      "rarebit_badge",
      "rarebit_state",
      "rarebit_icon",
      "rarebit_attention",
      "rarebit_error",
      "rarebit_state_attention",
      "rarebit_state_muted",
      "rarebit_state_diagnostic",
    ]) {
      const index = args.indexOf(token);
      assert.ok(index > 0);
      assert.equal(args[index - 1], "--clear-token");
    }
  } finally {
    if (oldBin === undefined) delete process.env.HERDR_BIN_PATH;
    else process.env.HERDR_BIN_PATH = oldBin;
    if (oldState === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = oldState;
  }
});
