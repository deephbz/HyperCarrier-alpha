import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readRarebitSession } from "../../../packages/hc-rarebit/src/rarebit-session.mjs";
import { readRarebitCurrent } from "../../../packages/hc-rarebit/src/rarebit-store.mjs";
import { projectRarebitArtifactState } from "../../../packages/hc-rarebit/src/rarebit-artifact-state.mjs";
import { rarebitSummaryPresentation } from "../../../packages/hc-rarebit/src/rarebit-visual-language.mjs";
import {
  SOURCE,
  appendReceipt,
  listAgents,
  paneInfo,
  runHerdr,
} from "./lib.mjs";

const RECONCILE_DEADLINE_MS = 30_000;
const RAREBIT_TOKEN_NAMES = [
  "rarebit_badge",
  "rarebit_state",
  "rarebit_summary",
  "rarebit_metrics",
  "rarebit_icon",
  "rarebit_attention",
  "rarebit_error",
  "rarebit_state_neutral",
  "rarebit_state_attention",
  "rarebit_state_muted",
  "rarebit_state_diagnostic",
];
const reconcileLeases = new Map();
function leaseDirectory() {
  const directory = join(
    process.env.HERDR_PLUGIN_STATE_DIR ||
      join(
        process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
        "herdr",
        "plugins",
        "rarebit-status",
      ),
    "rarebit-leases",
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}
function leasePaths(key) {
  const safe = Buffer.from(key).toString("base64url");
  return {
    state: join(leaseDirectory(), `${safe}.json`),
    lock: join(leaseDirectory(), `${safe}.lock`),
  };
}
function acquireDurableLease(key) {
  const paths = leasePaths(key);
  let fd;
  // The short critical section serializes separate event.mjs processes.
  for (let attempt = 0; attempt < 40 && !fd; attempt += 1) {
    try {
      fd = openSync(paths.lock, "wx", 0o600);
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  if (!fd) throw new Error(`Rarebit reconciler lease is busy for ${key}`);
  try {
    let prior = 0;
    try {
      prior = JSON.parse(readFileSync(paths.state, "utf8")).generation ?? 0;
    } catch {}
    const lease = { generation: prior + 1, issuedAt: new Date().toISOString() };
    const temporary = `${paths.state}.${process.pid}.${lease.generation}.tmp`;
    writeFileSync(temporary, JSON.stringify(lease), { mode: 0o600 });
    renameSync(temporary, paths.state);
    return { paths, ...lease };
  } finally {
    closeSync(fd);
    rmSync(paths.lock, { force: true });
  }
}
function ownsDurableLease(lease) {
  try {
    return (
      JSON.parse(readFileSync(lease.paths.state, "utf8")).generation ===
      lease.generation
    );
  } catch {
    return false;
  }
}

function cleanInline(value, max = 320) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function exactPiSessionForPane(paneId) {
  const agent = listAgents().find((entry) => entry.pane_id === paneId);
  const binding = agent?.agent_session;
  if (
    agent?.agent !== "pi" ||
    binding?.agent !== "pi" ||
    binding?.kind !== "path" ||
    typeof binding.value !== "string" ||
    !isAbsolute(binding.value) ||
    !binding.value.endsWith(".jsonl")
  )
    throw new Error(
      `Pane ${paneId} has no exact Herdr-reported Pi Session path`,
    );
  return { agent, sessionFile: binding.value };
}

/** The package owns bounded tail/head reads and every sidecar layout detail. */
export async function readMaterializationArtifact(sessionFile, options = {}) {
  const result = await (options.readCurrent ?? readRarebitCurrent)({
    sessionFile,
    ...options,
  });
  return {
    ...result,
    reason: result.diagnostics?.reason ?? null,
  };
}

export function nativeAvailabilityForError(error) {
  if (error?.code === "ENOENT") return "missing";
  // hc-rarebit's explicit-path resolver currently carries this typed query
  // condition without an error code; it is still an absent source, not a read failure.
  if (
    error?.name === "RarebitQueryError" &&
    /^Pi Session file not found:/.test(error?.message ?? "")
  )
    return "missing";
  return "unreadable";
}
// The native reader's UI-shaped selection nests selector version in `manifest`.
// Normalize only at this adapter boundary; the producer machine keeps its strict
// normalized artifact contract.
export function normalizeNativeSelection(selection) {
  return {
    ...selection,
    selectorVersion:
      selection?.selectorVersion ?? selection?.manifest?.selectorVersion,
  };
}
async function readNativeArtifact(sessionFile) {
  try {
    const loaded = await readRarebitSession(sessionFile);
    return {
      availability: "available",
      loaded,
      native: {
        availability: "available",
        sessionId: loaded.session.id,
        selection: normalizeNativeSelection(loaded.selection),
      },
    };
  } catch (error) {
    const availability = nativeAvailabilityForError(error);
    return {
      availability,
      error: error?.message ?? String(error),
      loaded: null,
      native: { availability },
    };
  }
}

function summaryTextForReceipt(records, receiptRef) {
  if (!receiptRef?.jobId) return null;
  const record = (records ?? []).find(
    (candidate) =>
      candidate?.jobId === receiptRef.jobId &&
      candidate?.sessionId === receiptRef.sessionId &&
      candidate?.observedAt === receiptRef.observedAt,
  );
  return typeof record?.summary === "string" ? record.summary : null;
}

function presentation(machine, records = []) {
  const projection = machine.projection;
  const sourcePending =
    machine.syncState === "request_source_pending" ||
    machine.syncState === "assessment_source_pending";
  const label = projection
    ? rarebitSummaryPresentation(projection.status, { sourcePending }).label
    : "syncing";
  return {
    status: projection?.status ?? "error",
    reason: projection?.reason ?? machine.retry?.reason ?? "artifact_pending",
    label,
    sourcePending,
    settled: machine.syncState === "assessment_current",
    // The producer chose receiptRef. This only retrieves its lossy prose; it
    // never selects a receipt or exposes native selected-message text.
    text: summaryTextForReceipt(records, machine.receiptRef),
    observedAt: machine.receiptRef?.observedAt ?? null,
    lineage: machine.receiptRef,
    syncState: machine.syncState,
    applicability: machine.applicability,
    retry: machine.retry,
  };
}

/** Presentation-only adapter. Receipt selection and ancestry stay in the producer machine. */
export function projectRarebitConsumerStatus({
  native,
  materialization,
  expectation = "snapshot",
  deadlineExpired = false,
} = {}) {
  const machine =
    materialization?.artifactState ??
    projectRarebitArtifactState({
      native,
      materialization,
      expectation,
      deadlineExpired,
    });
  return { machine, ...presentation(machine, materialization?.records) };
}

export async function loadRarebitPane(
  paneId,
  { expectation = "snapshot", deadlineExpired = false } = {},
) {
  if (!paneId)
    throw new Error("No affected Herdr pane is available in plugin context");
  const pane = paneInfo(paneId);
  if (!pane) throw new Error(`Herdr pane ${paneId} is unavailable`);
  const { agent, sessionFile } = exactPiSessionForPane(paneId);
  const nativeArtifact = await readNativeArtifact(sessionFile);
  const materialization = await readMaterializationArtifact(sessionFile, {
    native: nativeArtifact.native,
    expectation,
    deadlineExpired,
  });
  const summary = projectRarebitConsumerStatus({
    native: nativeArtifact.native,
    materialization,
    expectation,
    deadlineExpired,
  });
  const loaded = nativeArtifact.loaded;
  return {
    schemaVersion: 4,
    paneId,
    pane,
    agent,
    sessionFile,
    session: loaded?.session ?? {
      id: summary.lineage?.sessionId ?? null,
      activeLeafId: summary.lineage?.branchLeafId ?? null,
    },
    selection: loaded?.selection ?? {
      manifestHash: summary.lineage?.selectionManifestHash ?? null,
      manifest: { selectorVersion: summary.lineage?.selectorVersion ?? null },
      occurrences: [],
    },
    measurement: loaded?.measurement ?? {
      estimatedRarebitTokens: null,
      rarebitRatio: null,
    },
    nativeArtifact: {
      availability: nativeArtifact.availability,
      error: nativeArtifact.error ?? null,
    },
    materialization: {
      path: materialization.path,
      availability: materialization.availability,
      reason: materialization.reason ?? null,
      recordCount: materialization.records.length,
      head: materialization.head ?? null,
      diagnostics: materialization.diagnostics ?? null,
    },
    summary,
    loadedAt: new Date().toISOString(),
  };
}

export function projectionTokens(view) {
  const status = view.summary;
  const presentation = rarebitSummaryPresentation(status.status, {
    sourcePending: status.sourcePending,
  });
  return {
    rarebit_attention:
      presentation.tone === "attention" ? presentation.mark : null,
    rarebit_error:
      presentation.tone === "diagnostic" ? presentation.mark : null,
    rarebit_state_neutral:
      presentation.tone === "neutral" ? presentation.label : null,
    rarebit_state_attention:
      presentation.tone === "attention" ? presentation.label : null,
    rarebit_state_muted:
      presentation.tone === "muted" ? presentation.label : null,
    rarebit_state_diagnostic:
      presentation.tone === "diagnostic" ? presentation.label : null,
  };
}

export function shouldPublishRarebitMetadata(view) {
  // `awaiting_artifacts` is operational progress, not a sixth Rarebit status.
  // Preserve prior sidebar metadata; the popup alone may disclose this sync state.
  return Boolean(
    view?.summary?.machine?.projection ??
    view?.summary?.syncState !== "awaiting_artifacts",
  );
}

export function reportRarebitPane(view, reason) {
  if (!shouldPublishRarebitMetadata(view)) {
    appendReceipt("rarebit_refresh_deferred", {
      paneId: view.paneId,
      sessionId: view.session.id,
      syncState: view.summary.syncState,
      nativeArtifact: {
        path: view.sessionFile,
        availability: view.nativeArtifact.availability,
      },
      materializationArtifact: view.materialization,
      reason,
    });
    return view;
  }
  const tokens = projectionTokens(view);
  const args = [
    "pane",
    "report-metadata",
    view.paneId,
    "--source",
    SOURCE,
    "--clear-token",
    "rarebit_badge",
    "--clear-token",
    "rarebit_state",
    "--clear-token",
    "rarebit_summary",
    "--clear-token",
    "rarebit_metrics",
    "--clear-token",
    "rarebit_icon",
  ];
  for (const name of [
    "rarebit_attention",
    "rarebit_error",
    "rarebit_state_neutral",
    "rarebit_state_attention",
    "rarebit_state_muted",
    "rarebit_state_diagnostic",
  ]) {
    if (tokens[name]) args.push("--token", `${name}=${tokens[name]}`);
    else args.push("--clear-token", name);
  }
  runHerdr(args);
  appendReceipt("rarebit_refreshed", {
    paneId: view.paneId,
    sessionId: view.session.id,
    selectionManifestHash: view.selection.manifestHash,
    rarebitStatus: view.summary.status,
    statusReason: view.summary.reason,
    syncState: view.summary.syncState,
    applicability: view.summary.applicability,
    settled: view.summary.settled,
    jobId: view.summary.lineage?.jobId ?? null,
    nativeArtifact: {
      path: view.sessionFile,
      availability: view.nativeArtifact.availability,
    },
    materializationArtifact: view.materialization,
    reason,
  });
  return view;
}

export async function refreshRarebitPane(
  paneId,
  reason = "manual",
  options = {},
) {
  return reportRarebitPane(await loadRarebitPane(paneId, options), reason);
}

export function eventExpectation(eventName, event = {}) {
  const runtime =
    event?.data?.agent_status ??
    event?.data?.status ??
    event?.data?.runtime_status;
  if (
    eventName === "pane.agent_status_changed" &&
    ["done", "blocked"].includes(runtime)
  )
    return "agent_settled";
  if (
    eventName === "pane.agent_status_changed" &&
    ["working", "running", "thinking", "tool"].includes(runtime)
  )
    return "owner_request";
  return "snapshot";
}

/** A pane/path lease prevents an old working event loop from publishing over a newer settlement. */
export async function reconcileRarebitPane(
  paneId,
  {
    reason = "event",
    expectation = "snapshot",
    deadlineMs = RECONCILE_DEADLINE_MS,
    now = () => Date.now(),
    sleep = wait,
    load = loadRarebitPane,
    bindingForPane = exactPiSessionForPane,
    report = reportRarebitPane,
  } = {},
) {
  const binding = bindingForPane(paneId);
  const key = `${paneId}:${binding.sessionFile}`;
  const durableLease = acquireDurableLease(key);
  const generation = durableLease.generation;
  reconcileLeases.set(key, { generation });
  const ownsLease = () =>
    reconcileLeases.get(key)?.generation === generation &&
    ownsDurableLease(durableLease);
  const deadline = now() + deadlineMs;
  let delay = 0;
  let lastView = null;
  let sourcePendingPublished = false;
  let settlementPendingPublished = false;
  while (ownsLease()) {
    if (delay) await sleep(delay);
    const expired = now() >= deadline;
    const view = await load(paneId, { expectation, deadlineExpired: expired });
    lastView = view;
    // A source-pending record is useful immediately, but its native source is
    // still being reconciled under this same lease. Do not strand it forever.
    if (view.summary.sourcePending && !sourcePendingPublished) {
      if (!ownsLease()) return null;
      report(view, `${reason}:source-pending`);
      sourcePendingPublished = true;
    }
    // Preserve the requested/settlement-pending disclosure, then continue
    // waiting rather than converting an ordinary materialization delay to error.
    if (
      view.summary.syncState === "settlement_pending" &&
      !settlementPendingPublished
    ) {
      if (!ownsLease()) return null;
      report(view, `${reason}:settlement-pending`);
      settlementPendingPublished = true;
    }
    // Await both missing artifacts and a stopped request generation. This avoids
    // publishing a transient timeout before the producer's exact settlement.
    const stillReconciling =
      view.summary.sourcePending ||
      ["awaiting_artifacts", "settlement_pending"].includes(
        view.summary.syncState,
      );
    if (!stillReconciling || expired) {
      // An interim publication must never suppress this reconciled projection:
      // it may upgrade source-pending/request or settlement-pending metadata.
      if (ownsLease()) return report(view, reason);
      return null;
    }
    delay = Math.min(delay ? Math.ceil(delay * 1.7) : 150, 2_000);
  }
  if (lastView && ownsLease()) return report(lastView, `${reason}:deadline`);
  return null;
}

export async function refreshRarebitPaneAfterSettlement(
  paneId,
  reason = "event",
  event = {},
) {
  return reconcileRarebitPane(paneId, {
    reason,
    expectation: eventExpectation(reason.replace(/^event:/, ""), event),
  });
}

export function compactRarebitView(view) {
  return {
    paneId: view.paneId,
    sessionId: view.session.id,
    selectionManifestHash: view.selection.manifestHash,
    rarebitCount: view.selection.occurrences.length,
    rarebitStatus: view.summary.status,
    statusReason: view.summary.reason,
    syncState: view.summary.syncState,
    applicability: view.summary.applicability,
    settled: view.summary.settled,
  };
}
export async function refreshAllRarebits(reason = "manual_all") {
  const results = [];
  for (const paneId of [
    ...new Set(
      listAgents()
        .map((agent) => agent.pane_id)
        .filter(Boolean),
    ),
  ]) {
    try {
      results.push({
        ok: true,
        ...compactRarebitView(await refreshRarebitPane(paneId, reason)),
      });
    } catch (error) {
      results.push({ paneId, ok: false, error: error.message });
    }
  }
  appendReceipt("rarebit_fleet_refreshed", {
    reason,
    refreshed: results.filter((result) => result.ok).length,
    unavailable: results.filter((result) => !result.ok).length,
  });
  return results;
}
export function clearRarebitPane(paneId, reason = "manual_clear") {
  if (!paneId)
    throw new Error("No affected Herdr pane is available in plugin context");
  const args = ["pane", "report-metadata", paneId, "--source", SOURCE];
  for (const token of RAREBIT_TOKEN_NAMES) args.push("--clear-token", token);
  runHerdr(args);
  appendReceipt("rarebit_cleared", { paneId, reason });
}
export function rarebitNotificationSound(status) {
  return status?.status === "needs_attention" && !status.sourcePending
    ? "request"
    : "none";
}

export async function notifyRarebit(paneId) {
  const view = await refreshRarebitPane(paneId, "notification");
  const status = view.summary;
  if (!shouldPublishRarebitMetadata(view)) return null;
  const body = cleanInline(
    status.sourcePending
      ? `${status.label}: native source unavailable; current applicability unverified.`
      : `${status.label}: ${status.reason} (${view.selection.occurrences.length} Rarebits)`,
    235,
  );
  const sound = rarebitNotificationSound(status);
  const response = runHerdr([
    "notification",
    "show",
    `Rarebit ${status.label}`,
    "--body",
    body,
    "--position",
    "top-right",
    "--sound",
    sound,
  ]);
  appendReceipt("rarebit_notification_requested", {
    paneId,
    sessionId: view.session.id,
    rarebitStatus: status.status,
    statusReason: status.reason,
    syncState: status.syncState,
    applicability: status.applicability,
    sound,
  });
  return response;
}
