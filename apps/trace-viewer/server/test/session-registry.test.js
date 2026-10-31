import "../../test/home.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionRegistry } from "../session-registry.js";

const header = {
  type: "session",
  id: "registry-session",
  timestamp: "2026-01-01T00:00:00Z",
  cwd: "/synthetic/project",
};

test("Session registry refreshes exact changed paths and reconciles ambiguous events", () => {
  const root = mkdtempSync(join(tmpdir(), "trace-registry-"));
  const project = join(root, "project");
  mkdirSync(project);
  const first = join(project, "first.jsonl");
  const second = join(project, "second.jsonl");
  writeFileSync(first, `${JSON.stringify({ ...header, id: "registry-first" })}\n`);
  writeFileSync(second, `${JSON.stringify({ ...header, id: "registry-second" })}\n`);
  const registry = new SessionRegistry({ sessionsRoot: root }).refresh();
  writeFileSync(first, `${JSON.stringify({ ...header, id: "registry-replaced" })}\n`);
  registry.refreshPaths([first]);
  assert.equal(registry.byId.has("registry-first"), false);
  assert.equal(registry.byId.get("registry-replaced"), first);
  unlinkSync(first);
  registry.refreshPaths([project]);
  assert.equal(registry.byId.has("registry-replaced"), false);
});

test("Session registry refuses duplicate Session headers until one source is removed", () => {
  const root = mkdtempSync(join(tmpdir(), "trace-registry-duplicate-"));
  const firstProject = join(root, "first-project");
  const secondProject = join(root, "second-project");
  mkdirSync(firstProject);
  mkdirSync(secondProject);
  const first = join(firstProject, "first.jsonl");
  const second = join(secondProject, "second.jsonl");
  const id = "registry-duplicate";
  writeFileSync(first, `${JSON.stringify({ ...header, id })}\n`);
  writeFileSync(second, `${JSON.stringify({ ...header, id })}\n`);

  const registry = new SessionRegistry({ sessionsRoot: root }).refresh();
  assert.equal(registry.get(id), undefined);
  assert.deepEqual(registry.resolve(id), { kind: "ambiguous" });

  unlinkSync(second);
  registry.refreshPaths([second]);
  assert.deepEqual(registry.resolve(id), { kind: "resolved", source: first });
});
