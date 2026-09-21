import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { declaredWorkspacePaths, resolveNativePackage, validateConsumerResolution, validatePackageFacts, verifyComposition } from "../verify-composition.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const verifier = path.join(root, "scripts/verify-composition.mjs");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
function json(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function compositionFixture({ shadow = false, nestedLink = false, nestedDifferent = false } = {}) {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "hc-composition-"));
  const child = mkdtempSync(path.join(os.tmpdir(), "hc-child-"));
  const workspaces = ["apps/{timeline,traffic-analysis}", "packages/*"];
  try {
    git(child, ["init", "--quiet"]); git(child, ["config", "user.name", "fixture"]); git(child, ["config", "user.email", "fixture@example.invalid"]);
    json(path.join(child, "package.json"), { name: "@example/package", version: "9.8.7", main: "index.js" });
    json(path.join(child, "package-lock.json"), { name: "@example/package", version: "9.8.7", lockfileVersion: 3, packages: { "": { name: "@example/package", version: "9.8.7" } } });
    writeFileSync(path.join(child, "index.js"), "export const fixture = true;\n");
    if (nestedDifferent) { mkdirSync(path.join(child, "node_modules/@example/package"), { recursive: true }); json(path.join(child, "node_modules/@example/package/package.json"), { name: "@example/package", version: "8.0.0" }); }
    git(child, ["add", "."]); git(child, ["commit", "--quiet", "-m", "fixture"]);
    git(fixture, ["init", "--quiet"]); git(fixture, ["config", "user.name", "fixture"]); git(fixture, ["config", "user.email", "fixture@example.invalid"]);
    mkdirSync(path.join(fixture, "apps/timeline"), { recursive: true }); mkdirSync(path.join(fixture, "apps/traffic-analysis"), { recursive: true }); mkdirSync(path.join(fixture, "node_modules/@example"), { recursive: true });
    json(path.join(fixture, "package.json"), { name: "fixture", private: true, workspaces });
    json(path.join(fixture, "package-lock.json"), { name: "fixture", lockfileVersion: 3, packages: { "": { name: "fixture", workspaces }, "apps/timeline": { name: "timeline", version: "1.0.0", dependencies: { "@example/package": "^9.8.0" } }, "apps/traffic-analysis": { name: "traffic-analysis", version: "1.0.0", optionalDependencies: { "@example/package": "^9.8.0" } }, "node_modules/@example/package": { resolved: "packages/example", link: true } } });
    json(path.join(fixture, "apps/timeline/package.json"), { name: "timeline", version: "1.0.0", dependencies: { "@example/package": "^9.8.0" } });
    json(path.join(fixture, "apps/traffic-analysis/package.json"), { name: "traffic-analysis", version: "1.0.0", optionalDependencies: { "@example/package": "^9.8.0" } });
    symlinkSync(path.relative(path.join(fixture, "node_modules/@example"), path.join(fixture, "packages/example")), path.join(fixture, "node_modules/@example/package"));
    if (shadow) {
      mkdirSync(path.join(fixture, "apps/node_modules/@example/package"), { recursive: true });
      json(path.join(fixture, "apps/node_modules/@example/package/package.json"), { name: "@example/package", version: "0.0.1" });
    }
    git(fixture, ["add", "."]); git(fixture, ["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", `file://${child}`, "packages/example"]);
    if (nestedLink || nestedDifferent) { const target = nestedDifferent ? path.join(fixture, "packages/example/node_modules/@example/package") : path.join(fixture, "packages/example"); mkdirSync(path.join(fixture, "apps/timeline/node_modules/@example"), { recursive: true }); symlinkSync(path.relative(path.join(fixture, "apps/timeline/node_modules/@example"), target), path.join(fixture, "apps/timeline/node_modules/@example/package")); }
    git(fixture, ["add", "."]); git(fixture, ["commit", "--quiet", "-m", "fixture"]);
    return { fixture, child };
  } catch (error) { rmSync(fixture, { recursive: true, force: true }); rmSync(child, { recursive: true, force: true }); throw error; }
}
function removeFixture({ fixture, child }) { rmSync(fixture, { recursive: true, force: true }); rmSync(child, { recursive: true, force: true }); }

test("verifies native package submodule, workspace, and lock facts", () => {
  const result = verifyComposition({ root });
  assert.equal(result.status, "verified");
  assert.deepEqual(result.submodules.map(({ path: value }) => value), [
    "packages/pi-team-bright",
    "packages/pi-openai-blackmagic-compact",
    "packages/hc-rarebit",
  ]);
  assert.equal(result.submodules.find(({ path: value }) => value === "packages/pi-team-bright").workspace, "included");
  assert.equal(result.submodules.find(({ path: value }) => value === "packages/hc-rarebit").workspace, "included");
  assert.equal(result.submodules.find(({ path: value }) => value === "packages/pi-openai-blackmagic-compact").workspace, "excluded");
});

test("accepts a new package version without verifier or schema edits", () => {
  const facts = {
    childPath: "packages/example",
    gitlink: { mode: "160000", commit: "abc123" },
    source: { commit: "abc123", tree: "tree123" },
    manifest: { name: "@example/package", version: "9.8.7" },
    childLock: { name: "@example/package", version: "9.8.7" },
    rootPackage: { workspaces: ["apps/*", "packages/*", "!packages/example"] },
    rootLock: { packages: { "": { workspaces: ["apps/*", "packages/*", "!packages/example"] } } },
  };
  assert.deepEqual(validatePackageFacts(facts), { path: "packages/example", package: { name: "@example/package", version: "9.8.7" }, workspace: "excluded" });
});

test("accepts a valid semver range when the lock preserves the manifest specification", () => {
  assert.equal(validateConsumerResolution({ consumerPath: "apps/example", dependencySpec: "^9.8.0", consumerLock: { dependencies: { "@example/package": "^9.8.0" } }, packageName: "@example/package" }), true);
});

test("compares the matching native dependency category", () => {
  assert.equal(validateConsumerResolution({ consumerPath: "apps/example", dependencyCategory: "optionalDependencies", dependencySpec: "^9.8.0", consumerLock: { optionalDependencies: { "@example/package": "^9.8.0" } }, packageName: "@example/package" }), true);
  assert.throws(() => validateConsumerResolution({ consumerPath: "apps/example", dependencyCategory: "optionalDependencies", dependencySpec: "^9.8.0", consumerLock: { dependencies: { "@example/package": "^9.8.0" } }, packageName: "@example/package" }), (error) => error.code === "consumer-lock");
});

test("rejects a source and gitlink mismatch", () => {
  assert.throws(() => validatePackageFacts({
    childPath: "packages/example",
    gitlink: { mode: "160000", commit: "old" },
    source: { commit: "new", tree: "tree" },
    manifest: { name: "@example/package", version: "1.2.3" },
    childLock: { name: "@example/package", version: "1.2.3" },
    rootPackage: { workspaces: ["packages/*"] },
    rootLock: { packages: { "": { workspaces: ["packages/*"] } } },
  }), (error) => error.code === "gitlink-commit");
});

test("uses native brace workspace matches and honors exclusions", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "hc-workspaces-"));
  try {
    mkdirSync(path.join(fixture, "apps/timeline"), { recursive: true }); mkdirSync(path.join(fixture, "apps/traffic-analysis"), { recursive: true }); mkdirSync(path.join(fixture, "packages/kept"), { recursive: true }); mkdirSync(path.join(fixture, "packages/skip"), { recursive: true });
    assert.deepEqual(declaredWorkspacePaths(fixture, ["apps/{timeline,traffic-analysis}", "packages/*", "!packages/skip"]), ["apps/timeline", "apps/traffic-analysis", "packages/kept"]);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("accepts a native range and nested symlink resolving to the child", () => {
  const setup = compositionFixture({ nestedLink: true });
  try { assert.equal(resolveNativePackage(setup.fixture, "apps/timeline", "@example/package"), realpathSync(path.join(setup.fixture, "packages/example"))); assert.equal(verifyComposition({ root: setup.fixture }).status, "verified"); }
  finally { removeFixture(setup); }
});

test("rejects a different package root nested inside the selected child", () => {
  const setup = compositionFixture({ nestedDifferent: true });
  try { assert.throws(() => verifyComposition({ root: setup.fixture }), (error) => error.code === "consumer-shadow"); }
  finally { removeFixture(setup); }
});

test("rejects an ancestor-installed registry copy", () => {
  const setup = compositionFixture({ shadow: true });
  try { assert.throws(() => verifyComposition({ root: setup.fixture }), (error) => error.code === "consumer-shadow"); }
  finally { removeFixture(setup); }
});

test("CLI verifies and rejects fixtures through a symlinked entry path", () => {
  const good = compositionFixture(); const bad = compositionFixture({ shadow: true }); const tempScript = path.join(mkdtempSync(path.join(os.tmpdir(), "hc-verifier-link-")), "verify.mjs");
  try {
    symlinkSync(verifier, tempScript);
    const passing = spawnSync(process.execPath, [tempScript, "--root", good.fixture], { encoding: "utf8" }); assert.equal(passing.status, 0, passing.stderr); assert.equal(JSON.parse(passing.stdout).status, "verified");
    const failing = spawnSync(process.execPath, [tempScript, "--root", bad.fixture], { encoding: "utf8" }); assert.notEqual(failing.status, 0); assert.match(failing.stderr, /consumer-shadow/);
  } finally { removeFixture(good); removeFixture(bad); rmSync(path.dirname(tempScript), { recursive: true, force: true }); }
});
