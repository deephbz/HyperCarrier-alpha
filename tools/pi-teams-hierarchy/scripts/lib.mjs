import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export const PLUGIN_ID = "pi-teams-hierarchy";
export const SOURCE = `plugin:${PLUGIN_ID}`;

function herdrBinary() {
  return process.env.HERDR_BIN_PATH || "herdr";
}

export function runHerdr(args) {
  const stdout = execFileSync(herdrBinary(), args, {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : null;
}

export function listAgents() {
  return runHerdr(["agent", "list"])?.result?.agents ?? [];
}

export function invocationContext() {
  try {
    return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  } catch {
    return {};
  }
}

export function eventContext() {
  try {
    return JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON || "{}");
  } catch {
    return {};
  }
}

export function affectedPaneId(event = eventContext()) {
  const context = invocationContext();
  return (
    event?.data?.pane_id ||
    context.focused_pane_id ||
    process.env.HERDR_PANE_ID ||
    process.env.HERDR_ACTIVE_PANE_ID ||
    null
  );
}

export function cleanToken(value, maxLength = 80) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...text].slice(0, maxLength).join("");
}

export function reportSequence(
  nowMs = Date.now(),
  monotonicNs = process.hrtime.bigint(),
) {
  // Wall-clock milliseconds keep sequences increasing across machine restarts.
  // The monotonic suffix orders reporters started in the same wall-clock tick.
  const suffix = monotonicNs % 1_000_000n;
  return (BigInt(nowMs) * 1_000_000n + suffix).toString();
}

export function pluginStateDirectory() {
  return (
    process.env.HERDR_PLUGIN_STATE_DIR ||
    join(
      process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
      "herdr",
      "plugins",
      PLUGIN_ID,
    )
  );
}

export function appendReceipt(kind, detail = {}) {
  const directory = pluginStateDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const record = {
    schemaVersion: 1,
    kind,
    observedAt: new Date().toISOString(),
    pluginId: PLUGIN_ID,
    ...detail,
  };
  appendFileSync(join(directory, "receipts.jsonl"), `${JSON.stringify(record)}\n`, {
    mode: 0o600,
  });
  return record;
}
