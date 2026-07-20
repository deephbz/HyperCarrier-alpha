import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { findSessionFiles } from "./collector.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;
const HEADER_BYTES = 64 * 1024;

function readSessionHeader(path) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(HEADER_BYTES);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    const end = newline >= 0 ? newline : bytesRead < buffer.length ? bytesRead : -1;
    if (end < 0) return null;
    return JSON.parse(buffer.subarray(0, end).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

function exactChangedPaths(root, paths) {
  const changed = [...new Set(Array.isArray(paths) ? paths : [])].map((path) =>
    typeof path === "string" ? resolve(path) : path,
  );
  const exact =
    changed.length > 0 &&
    changed.every((path) => {
      if (typeof path !== "string" || !path.endsWith(".jsonl")) return false;
      const fromRoot = relative(root, path);
      return fromRoot !== "" && !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
    });
  return exact ? changed : null;
}

function changedSessionId(path) {
  try {
    if (!statSync(path).isFile()) return undefined;
    const header = readSessionHeader(path);
    return header?.type === "session" && typeof header.id === "string" && SAFE_ID.test(header.id)
      ? header.id
      : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.name === "SyntaxError") return null;
    return undefined;
  }
}

export class SessionRegistry {
  constructor({ sessionsRoot } = {}) {
    this.sessionsRoot = resolve(sessionsRoot ?? join(homedir(), ".pi", "agent", "sessions"));
    this.byId = new Map();
    this.lastRefresh = { mode: "full", paths: [] };
  }
  refresh() {
    const next = new Map();
    const paths = findSessionFiles(this.sessionsRoot);
    for (const path of paths) {
      try {
        const header = readSessionHeader(path);
        if (header.type === "session" && typeof header.id === "string") next.set(header.id, path);
      } catch {}
    }
    this.byId = next;
    this.lastRefresh = { mode: "full", paths };
    return this;
  }
  refreshPaths(paths) {
    const changed = exactChangedPaths(this.sessionsRoot, paths);
    if (!changed) return this.refresh();

    const updates = [];
    const changedSet = new Set(changed);
    const nextIds = new Set();
    for (const path of changed) {
      const id = changedSessionId(path);
      if (id === undefined) return this.refresh();
      if (id) {
        if (nextIds.has(id)) return this.refresh();
        const existingPath = this.byId.get(id);
        if (existingPath && existingPath !== path && !changedSet.has(existingPath))
          return this.refresh();
        nextIds.add(id);
      }
      updates.push({ path, id });
    }

    for (const { path } of updates)
      for (const [id, currentPath] of this.byId) if (currentPath === path) this.byId.delete(id);
    for (const { path, id } of updates) if (id) this.byId.set(id, path);
    this.lastRefresh = { mode: "targeted", paths: changed };
    return this;
  }
  get(id) {
    if (!SAFE_ID.test(id)) return undefined;
    return this.byId.get(id) ?? this.refresh().byId.get(id);
  }
  version(id) {
    const path = this.get(id);
    if (!path) return undefined;
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  }
}
