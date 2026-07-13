import { readFileSync, statSync } from "node:fs";
import { findSessionFiles } from "./collector.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;

export class SessionRegistry {
  constructor({ sessionsRoot } = {}) {
    this.sessionsRoot = sessionsRoot;
    this.byId = new Map();
  }
  refresh() {
    const next = new Map();
    for (const path of findSessionFiles(this.sessionsRoot)) {
      try {
        const first = readFileSync(path, "utf8").split("\n", 1)[0];
        const header = JSON.parse(first);
        if (header.type === "session" && typeof header.id === "string") next.set(header.id, path);
      } catch {}
    }
    this.byId = next;
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
