import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export const PLUGIN_ID = "rarebit-status";
export const SOURCE = `plugin:${PLUGIN_ID}`;

function herdrBinary() {
  return process.env.HERDR_BIN_PATH || "herdr";
}
export function runHerdr(args, { parse = true } = {}) {
  const stdout = execFileSync(herdrBinary(), args, {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!parse) return stdout;
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : null;
}
export function invocationContext() {
  try {
    return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  } catch {
    return {};
  }
}
export function currentPaneId() {
  const context = invocationContext();
  return (
    context.focused_pane_id ||
    process.env.HERDR_PANE_ID ||
    process.env.HERDR_ACTIVE_PANE_ID ||
    null
  );
}
export function paneInfo(paneId) {
  return runHerdr(["pane", "get", paneId])?.result?.pane ?? null;
}
export function listAgents() {
  return runHerdr(["agent", "list"])?.result?.agents ?? [];
}
function stateDirectory() {
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
function ensureStateDirectory() {
  const directory = stateDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}
export function appendReceipt(kind, detail = {}) {
  const record = {
    schemaVersion: 1,
    kind,
    observedAt: new Date().toISOString(),
    pluginId: PLUGIN_ID,
    ...detail,
  };
  appendFileSync(
    join(ensureStateDirectory(), "receipts.jsonl"),
    `${JSON.stringify(record)}\n`,
    { mode: 0o600 },
  );
  return record;
}
