#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { findPackageJSON } from "node:module";
import { existsSync, globSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_ROOT = "packages";
const GITLINK_MODE = "160000";

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function git(root, args) {
  const env = { ...process.env };
  if (env.GIT_INDEX_FILE && path.resolve(root) !== path.resolve(env.GIT_INDEX_ROOT ?? ROOT)) delete env.GIT_INDEX_FILE;
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env }).trim();
}
function readJson(file) { try { return JSON.parse(readFileSync(file, "utf8")); } catch (error) { fail("invalid-json", `${file}: ${error.message}`); } }
function nonEmpty(value, label) { if (typeof value !== "string" || value.length === 0) fail("invalid-fact", `${label} must be a non-empty string`); }
function parseGitmodules(root) {
  const lines = git(root, ["config", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.(path|url)$"]).split("\n").filter(Boolean);
  const entries = new Map();
  for (const line of lines) {
    const match = line.match(/^submodule\.(.+)\.(path|url)\s+(.+)$/); if (!match) fail("gitmodules", "invalid .gitmodules key");
    const [, name, field, value] = match; const entry = entries.get(name) ?? { name }; if (entry[field]) fail("gitmodules", `duplicate ${field} for ${name}`); entry[field] = value; entries.set(name, entry);
  }
  const paths = new Set();
  return [...entries.values()].map((entry) => { if (!entry.path || !entry.url) fail("gitmodules", `submodule ${entry.name} has incomplete declaration`); if (paths.has(entry.path) || path.posix.normalize(entry.path) !== entry.path || path.posix.isAbsolute(entry.path) || entry.path.includes("..")) fail("gitmodules", `invalid or duplicate submodule path: ${entry.path}`); paths.add(entry.path); return entry; });
}
export function declaredWorkspacePaths(root, workspaces) {
  const paths = new Set();
  for (const entry of workspaces.filter((value) => !value.startsWith("!"))) {
    for (const match of globSync(entry, { cwd: root, withFileTypes: true })) {
      if (match.isDirectory()) paths.add(path.relative(root, path.join(match.parentPath, match.name)).split(path.sep).join(path.posix.sep));
    }
  }
  for (const entry of workspaces.filter((value) => value.startsWith("!"))) {
    for (const match of globSync(entry.slice(1), { cwd: root, withFileTypes: true })) {
      if (match.isDirectory()) paths.delete(path.relative(root, path.join(match.parentPath, match.name)).split(path.sep).join(path.posix.sep));
    }
  }
  return [...paths];
}
export function resolveNativePackage(root, consumerPath, packageName) {
  const parent = path.join(root, consumerPath, "package.json");
  try { return realpathSync(path.dirname(findPackageJSON(packageName, parent))); } catch (error) { fail("consumer-resolution", `${consumerPath} cannot resolve ${packageName}: ${error.message}`); }
}
function packageConsumers(root, rootPackage, rootLock, packageName, packagePath) {
  const consumers = [];
  for (const consumerPath of declaredWorkspacePaths(root, rootPackage.workspaces)) {
    if (consumerPath === packagePath) continue;
    const manifestFile = path.join(root, consumerPath, "package.json"); if (!existsSync(manifestFile)) continue; const manifest = readJson(manifestFile); const consumerLock = rootLock.packages?.[consumerPath];
    for (const dependencyCategory of ["dependencies", "optionalDependencies"]) {
      const dependencySpec = manifest[dependencyCategory]?.[packageName]; if (!dependencySpec) continue;
      consumers.push({ consumerPath, dependencyCategory, dependencySpec, consumerLock, resolvedPath: resolveNativePackage(root, consumerPath, packageName), root, childPath: packagePath });
    }
  }
  return consumers;
}
function workspaceIncludes(workspaces, childPath) {
  const included = workspaces.some((entry) => entry === `${PACKAGE_ROOT}/*` || entry === childPath);
  const excluded = workspaces.some((entry) => entry === `!${childPath}`);
  return included && !excluded;
}

export function validateConsumerResolution({ consumerPath, dependencyCategory = "dependencies", dependencySpec, consumerLock, resolvedPath, root, childPath, packageName }) {
  if (typeof dependencySpec !== "string" || dependencySpec.length === 0) fail("consumer-version", `${consumerPath} has no dependency specification for ${packageName}`);
  if (consumerLock?.[dependencyCategory]?.[packageName] !== dependencySpec) fail("consumer-lock", `${consumerPath} lock entry does not match its ${dependencyCategory} specification for ${packageName}`);
  if (resolvedPath && root && childPath) { const childRoot = realpathSync(path.join(root, childPath)); const resolved = realpathSync(resolvedPath); if (resolved !== childRoot) fail("consumer-shadow", `${consumerPath} resolves ${packageName} to a different package root`); }
  return true;
}

export function validatePackageFacts({ childPath, gitlink, source, manifest, childLock, rootPackage, rootLock, consumers = [] }) {
  nonEmpty(childPath, "child path"); nonEmpty(gitlink.mode, "gitlink mode"); if (gitlink.mode !== GITLINK_MODE) fail("gitlink-mode", `${childPath} is not a gitlink`); nonEmpty(gitlink.commit, "gitlink commit"); nonEmpty(source.commit, "source commit"); nonEmpty(source.tree, "source tree"); if (gitlink.commit !== source.commit) fail("gitlink-commit", `${childPath} gitlink does not match its checked-out source`);
  nonEmpty(manifest.name, `${childPath} package name`); nonEmpty(manifest.version, `${childPath} package version`); if (childLock.name !== manifest.name || childLock.version !== manifest.version) fail("child-lock", `${childPath} package-lock identity does not match package.json`);
  const workspaces = rootPackage.workspaces; if (!Array.isArray(workspaces) || !workspaces.includes(`${PACKAGE_ROOT}/*`)) fail("workspace-root", "root package.json must include packages/*");
  const lockWorkspaces = rootLock.packages?.[""]?.workspaces; if (JSON.stringify(lockWorkspaces) !== JSON.stringify(workspaces)) fail("workspace-lock", "root package-lock workspace patterns drift from package.json");
  const included = workspaceIncludes(workspaces, childPath); const link = rootLock.packages?.[`node_modules/${manifest.name}`];
  if (included) {
    if (!link || link.link !== true || link.resolved !== childPath) fail("workspace-link", `${childPath} is included but its root lock link is missing`);
    for (const consumer of consumers) validateConsumerResolution({ ...consumer, packageName: manifest.name });
    const installed = path.join(rootPackage.rootPath ?? "", "node_modules", manifest.name);
    if (rootPackage.rootPath && existsSync(path.join(rootPackage.rootPath, "node_modules")) && (!existsSync(installed) || realpathSync(installed) !== realpathSync(path.join(rootPackage.rootPath, childPath)))) fail("installed-link", `${childPath} is not the installed workspace target`);
  } else if (link) fail("workspace-link", `${childPath} is excluded but its root lock link remains`);
  return { path: childPath, package: { name: manifest.name, version: manifest.version }, workspace: included ? "included" : "excluded" };
}

export function verifyComposition({ root = ROOT, debug = false } = {}) {
  const rootPackage = { ...readJson(path.join(root, "package.json")), rootPath: root }; const rootLock = readJson(path.join(root, "package-lock.json"));
  if (git(root, ["ls-files", "--error-unmatch", ".gitmodules"]) !== ".gitmodules") fail("gitmodules", ".gitmodules must be committed");
  const modules = parseGitmodules(root); const results = [];
  for (const module of modules.filter(({ path: modulePath }) => modulePath.startsWith(`${PACKAGE_ROOT}/`))) {
    const child = path.join(root, module.path); if (!existsSync(child)) fail("missing-submodule", `${module.path}: run git submodule update --init --recursive`); if (!existsSync(path.join(child, ".git"))) fail("uninitialized-submodule", `${module.path}: run git submodule update --init --recursive`);
    const index = git(root, ["ls-files", "--stage", "--", module.path]).split(/\s+/); const gitlink = { mode: index[0], commit: index[1] }; const source = { commit: git(child, ["rev-parse", "HEAD"]), tree: git(child, ["rev-parse", "HEAD^{tree}"]) };
    if (git(child, ["remote", "get-url", "origin"]) !== module.url) fail("origin", `${module.path} origin does not match .gitmodules`); if (git(child, ["status", "--porcelain", "--untracked-files=normal"])) fail("dirty-submodule", `${module.path} is dirty`);
    const manifestFile = path.join(child, "package.json"); if (!existsSync(manifestFile)) fail("missing-package", `${module.path} package.json is missing`); const manifest = readJson(manifestFile); const childLockFile = path.join(child, "package-lock.json"); if (!existsSync(childLockFile)) fail("missing-child-lock", `${module.path} package-lock.json is missing`); const childLock = readJson(childLockFile);
    results.push(validatePackageFacts({ childPath: module.path, gitlink, source, manifest, childLock, rootPackage, rootLock, consumers: packageConsumers(root, rootPackage, rootLock, manifest.name, module.path) }));
  }
  const nativeGitlinks = git(root, ["ls-files", "--stage", "--", `${PACKAGE_ROOT}/*`]).split("\n").filter(Boolean).map((line) => { const [mode, commit, , modulePath] = line.split(/\s+/); return { mode, commit, path: modulePath }; }).filter(({ mode }) => mode === GITLINK_MODE);
  const declaredPackagePaths = modules.filter(({ path: modulePath }) => modulePath.startsWith(`${PACKAGE_ROOT}/`)).map(({ path: modulePath }) => modulePath);
  for (const link of nativeGitlinks) { if (link.mode !== GITLINK_MODE) fail("gitlink-mode", `${link.path} is not a submodule gitlink`); if (!declaredPackagePaths.includes(link.path)) fail("gitmodules", `${link.path} gitlink is missing from .gitmodules`); }
  for (const modulePath of declaredPackagePaths) if (!nativeGitlinks.some(({ path: linkPath }) => linkPath === modulePath)) fail("gitlink", `${modulePath} is declared in .gitmodules but not indexed as a gitlink`);
  if (results.length === 0) fail("no-package-submodules", "no package submodules found");
  const result = { status: "verified", submodules: results };
  return debug ? { root, modules, result } : result;
}

function isMainModule() {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
function cliRoot() {
  const index = process.argv.indexOf("--root");
  return index === -1 ? ROOT : path.resolve(process.argv[index + 1] ?? fail("cli", "--root requires a directory"));
}
if (isMainModule()) {
  try { const debug = process.argv.includes("--debug"); console.log(JSON.stringify(verifyComposition({ root: cliRoot(), debug }), null, debug ? 2 : 0)); } catch (error) { console.error(`Native composition verification failed [${error.code ?? "error"}]: ${error.message}`); process.exitCode = 1; }
}
