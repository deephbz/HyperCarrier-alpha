#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { validateSchema } from "./lib/closed-json-schema.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECORD_PATH = "config/colorstack-compatibility.json";
const RECORD_SCHEMA_PATH = "config/schemas/colorstack-compatibility.schema.json";
const SELECTION_PATH = "config/colorstack-selection.json";
const SELECTION_SCHEMA_PATH = "config/schemas/colorstack-selection.schema.json";
const SUBMODULE_PATH = "config/colorstack";
const HEX = /^[0-9a-f]{40}$/;
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function git(root, args) { try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch (error) { fail("git", error.stderr?.trim() || error.message); } }
function readJson(file, code) { try { return JSON.parse(readFileSync(file, "utf8")); } catch (error) { fail(code, `invalid JSON at ${file}: ${error.message}`); } }
function normalizedOrigin(value) { const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/; const https = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/; const match = value.match(https) ?? value.match(ssh); return match ? `https://github.com/${match[1]}/${match[2]}.git` : value; }
function object(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-record", `${label} must be an object`); }
export function validateCompatibilityRecord(record) {
  object(record, "compatibility record");
  if (record.schemaVersion !== 1 || record.component !== "colorstack") fail("invalid-record", "unsupported Colorstack compatibility record");
  if (record.source?.repository !== "https://github.com/deephbz/colorstack.git" || !HEX.test(record.source.commit) || !HEX.test(record.source.tree)) fail("invalid-record", "source repository, commit, or tree is invalid");
  if (record.gitlink?.path !== SUBMODULE_PATH || record.gitlink.mode !== "160000" || record.gitlink.commit !== record.source.commit) fail("invalid-record", "gitlink does not match source commit");
  if (record.pythonProject?.name !== "colorstack" || record.pythonProject.version !== "0.1.0" || record.pythonProject.requiresPython !== ">=3.11") fail("invalid-record", "Python project identity or range is invalid");
  if (record.generator?.path !== "gen.py" || record.generator.manifest !== ".colorstack-manifest.json" || record.generator.manifestSchemaVersion !== 1) fail("invalid-record", "generator contract is invalid");
  if (JSON.stringify(record.coreOutputs) !== JSON.stringify(["ghostty-theme", "herdr"])) fail("invalid-record", "core output contract is invalid");
  if (record.parentVerification?.requiredCheckout !== "recursive") fail("invalid-record", "parent verification must require recursive checkout");
  return record;
}
export function validateSelection(selection) {
  const expected = ["ghostty-theme", "tmux-include", "bat-theme", "shell-env", "starship-select", "starship-palette", "herdr", "pi-theme", "jupyter-css", "jupyter-cfg", "jupyter-theme"];
  if (selection.schemaVersion !== 1 || selection.scheme !== "modus" || selection.inkContrast !== 10 || JSON.stringify(selection.outputs) !== JSON.stringify(expected)) fail("invalid-selection", "selection must be the closed modus terminal target set");
  return selection;
}
function pyprojectProject(text) { const afterProject = text.split(/^\[project\]\s*$/m)[1] ?? ""; const section = afterProject.split(/^\[/m)[0]; return { name: section.match(/^name\s*=\s*"([^"]+)"/m)?.[1], version: section.match(/^version\s*=\s*"([^"]+)"/m)?.[1], requiresPython: section.match(/^requires-python\s*=\s*"([^"]+)"/m)?.[1] }; }
function runGenerator(child, selection, outputRoot, dry) { const args = [path.join(child, "gen.py"), selection.scheme, "--ink", String(selection.inkContrast), "--output-root", outputRoot]; for (const key of selection.outputs) args.push("--key", key); if (dry) args.push("--dry-run"); try { return execFileSync("python3", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (error) { fail("generator", `generator ${dry ? "dry-run" : "output"} failed: ${error.stderr?.trim() || error.message}`); } }
export function verifyComposition({ root = ROOT, debug = false } = {}) {
  const trace = { root, record: RECORD_PATH, selection: SELECTION_PATH, submodule: SUBMODULE_PATH, checks: [] };
  const check = (name, actual, expected) => { trace.checks.push({ name, actual, expected }); if (actual !== expected) fail(name, `${name}: expected ${expected}, got ${actual ?? "missing"}`); };
  const recordFile = path.join(root, RECORD_PATH), schemaFile = path.join(root, RECORD_SCHEMA_PATH), selectionFile = path.join(root, SELECTION_PATH), selectionSchemaFile = path.join(root, SELECTION_SCHEMA_PATH);
  for (const [file, code] of [[recordFile, "missing-record"], [schemaFile, "missing-schema"], [selectionFile, "missing-selection"], [selectionSchemaFile, "missing-selection-schema"]]) if (!existsSync(file)) fail(code, `missing required record: ${path.relative(root, file)}`);
  const record = readJson(recordFile, "invalid-record"), selection = readJson(selectionFile, "invalid-selection");
  validateSchema(record, readJson(schemaFile, "invalid-schema")); validateSchema(selection, readJson(selectionSchemaFile, "invalid-selection-schema")); validateCompatibilityRecord(record); validateSelection(selection);
  const child = path.join(root, SUBMODULE_PATH);
  if (!existsSync(child)) fail("missing-submodule", `missing submodule directory: ${SUBMODULE_PATH}; run git submodule update --init --recursive`);
  if (!existsSync(path.join(child, ".git"))) fail("uninitialized-submodule", `uninitialized submodule: ${SUBMODULE_PATH}; run git submodule update --init --recursive`);
  const index = git(root, ["ls-files", "--stage", "--", SUBMODULE_PATH]).split(/\s+/); check("gitlink-mode", index[0], record.gitlink.mode); check("gitlink-commit", index[1], record.gitlink.commit);
  check("origin", normalizedOrigin(git(child, ["remote", "get-url", "origin"])), record.source.repository); check("revision", git(child, ["rev-parse", "HEAD"]), record.source.commit); check("tree", git(child, ["rev-parse", "HEAD^{tree}"]), record.source.tree);
  if (git(child, ["status", "--porcelain", "--untracked-files=normal"])) fail("dirty-submodule", `dirty submodule: ${SUBMODULE_PATH}`);
  const project = pyprojectProject(readFileSync(path.join(child, "pyproject.toml"), "utf8")); check("python-name", project.name, record.pythonProject.name); check("python-version", project.version, record.pythonProject.version); check("requires-python", project.requiresPython, record.pythonProject.requiresPython);
  if (!existsSync(path.join(child, record.generator.path))) fail("generator", `missing generator: ${record.generator.path}`);
  const outputRoot = mkdtempSync(path.join(realpathSync(os.tmpdir()), "colorstack-verifier-")); trace.outputRoot = outputRoot;
  try {
    const dry = runGenerator(child, selection, outputRoot, true); if (!dry.includes("would write") || existsSync(path.join(outputRoot, record.generator.manifest))) fail("generator", "generator dry-run did not declare a clean output contract");
    runGenerator(child, selection, outputRoot, false);
    const manifestFile = path.join(outputRoot, record.generator.manifest); if (!existsSync(manifestFile)) fail("manifest", `generator did not write ${record.generator.manifest}`);
    const manifest = readJson(manifestFile, "manifest"); check("manifest-schema", manifest.schema_version, record.generator.manifestSchemaVersion); check("manifest-generator", manifest.generator, record.component); check("manifest-scheme", manifest.scheme, selection.scheme); check("manifest-ink", manifest.ink_contrast, selection.inkContrast);
    const keys = Object.keys(manifest.outputs ?? {}).sort(), expectedKeys = [...selection.outputs].sort(); if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) fail("output", `manifest outputs drift: expected ${expectedKeys.join(", ")}, got ${keys.join(", ")}`);
    for (const key of record.coreOutputs) if (!(key in manifest.outputs)) fail("output", `manifest omits core output ${key}`);
    for (const key of selection.outputs) { const output = manifest.outputs[key]; if (!output || output.path !== `outputs/${key}` || !/^[0-9a-f]{64}$/.test(output.sha256) || !["GENERATED", "REGION"].includes(output.ownership)) fail("manifest", `invalid manifest output ${key}`); const bytes = readFileSync(path.join(outputRoot, output.path)); check(`digest-${key}`, createHash("sha256").update(bytes).digest("hex"), output.sha256); }
  } finally { rmSync(outputRoot, { recursive: true, force: true }); }
  return debug ? { record, selection, trace } : { component: record.component, revision: record.source.commit, status: "verified" };
}
function isMainModule() { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } }
if (isMainModule()) { const debug = process.argv.includes("--debug"); try { console.log(JSON.stringify(verifyComposition({ debug }), null, debug ? 2 : 0)); } catch (error) { console.error(`Colorstack composition verification failed [${error.code ?? "error"}]: ${error.message}`); process.exitCode = 1; } }
