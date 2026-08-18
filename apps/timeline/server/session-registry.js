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
    this.sourcesById = new Map();
    this.byId = new Map();
    this.ambiguousIds = new Map();
    this.lastRefresh = { mode: "full", paths: [] };
  }
  rebuildIndexes() {
    this.byId = new Map();
    this.ambiguousIds = new Map();
    for (const [id, sources] of this.sourcesById) {
      if (sources.size === 1) this.byId.set(id, sources.values().next().value);
      else if (sources.size > 1) this.ambiguousIds.set(id, new Set(sources));
    }
  }
  removeSource(path) {
    for (const [id, sources] of this.sourcesById) {
      sources.delete(path);
      if (sources.size === 0) this.sourcesById.delete(id);
    }
  }
  addSource(id, path) {
    const sources = this.sourcesById.get(id) ?? new Set();
    sources.add(path);
    this.sourcesById.set(id, sources);
  }
  refresh() {
    const paths = findSessionFiles(this.sessionsRoot);
    this.sourcesById = new Map();
    for (const path of paths) {
      try {
        const header = readSessionHeader(path);
        if (header?.type === "session" && typeof header.id === "string" && SAFE_ID.test(header.id))
          this.addSource(header.id, path);
      } catch {}
    }
    this.rebuildIndexes();
    this.lastRefresh = { mode: "full", paths };
    return this;
  }
  refreshPaths(paths) {
    const changed = exactChangedPaths(this.sessionsRoot, paths);
    if (!changed) return this.refresh();

    const updates = [];
    for (const path of changed) {
      const id = changedSessionId(path);
      if (id === undefined) return this.refresh();
      updates.push({ path, id });
    }
    for (const { path } of updates) this.removeSource(path);
    for (const { path, id } of updates) if (id) this.addSource(id, path);
    this.rebuildIndexes();
    this.lastRefresh = { mode: "targeted", paths: changed };
    return this;
  }
  resolve(id) {
    if (!SAFE_ID.test(id)) return { kind: "missing" };
    if (!this.byId.has(id) && !this.ambiguousIds.has(id)) this.refresh();
    const source = this.byId.get(id);
    if (source) return { kind: "resolved", source };
    if (this.ambiguousIds.has(id)) return { kind: "ambiguous" };
    return { kind: "missing" };
  }
  get(id) {
    const resolution = this.resolve(id);
    return resolution.kind === "resolved" ? resolution.source : undefined;
  }
  version(id) {
    const path = this.get(id);
    if (!path) return undefined;
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  }
}
