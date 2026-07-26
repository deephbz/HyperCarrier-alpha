import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import net from "node:net";

export const PLUGIN_ID = "agent-view-presets";
export const SOURCE = `plugin:${PLUGIN_ID}`;
export const MODE_ALL_AGENTS = "all-agents";
export const MODE_NO_TEAMMATES = "no-teammates";

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

export function teamsDirectory() {
  return join(homedir(), ".pi", "teams");
}

export function ensureDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function modePath(stateDirectory) {
  return join(stateDirectory, "view-mode.json");
}

export function readMode(stateDirectory = pluginStateDirectory()) {
  try {
    const value = JSON.parse(readFileSync(modePath(stateDirectory), "utf8"));
    return value?.schemaVersion === 1 && value?.mode === MODE_NO_TEAMMATES
      ? MODE_NO_TEAMMATES
      : MODE_ALL_AGENTS;
  } catch {
    return MODE_ALL_AGENTS;
  }
}

export function writeMode(mode, stateDirectory = pluginStateDirectory()) {
  if (![MODE_ALL_AGENTS, MODE_NO_TEAMMATES].includes(mode)) {
    throw new Error(`Unsupported Agent view mode: ${mode}`);
  }
  ensureDirectory(stateDirectory);
  const destination = modePath(stateDirectory);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, mode })}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, destination);
}

export function appendReceipt(
  kind,
  detail = {},
  stateDirectory = pluginStateDirectory(),
) {
  ensureDirectory(stateDirectory);
  const record = {
    schemaVersion: 1,
    kind,
    observedAt: new Date().toISOString(),
    pluginId: PLUGIN_ID,
    ...detail,
  };
  appendFileSync(
    join(stateDirectory, "receipts.jsonl"),
    `${JSON.stringify(record)}\n`,
    { mode: 0o600 },
  );
  return record;
}

export function socketRequest(method, params) {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!socketPath) throw new Error("HERDR_SOCKET_PATH is unavailable");
  const id = `${PLUGIN_ID}:${process.pid}:${randomUUID()}`;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out waiting for ${method}`));
    }, 4000);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        if (value.id !== id) continue;
        clearTimeout(timeout);
        socket.end();
        if (value.error) {
          reject(new Error(value.error.message || value.error.code || method));
        } else {
          resolve(value.result);
        }
        return;
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
