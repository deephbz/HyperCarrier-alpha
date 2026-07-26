#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECORD_PATH = "config/pi-team-bright-compatibility.json";
const SCHEMA_PATH = "config/schemas/pi-team-bright-compatibility.schema.json";
const SUBMODULE_PATH = "packages/pi-team-bright";
const REQUIRED = ["schemaVersion", "component", "source", "package", "publication", "pi", "beads", "childVerification", "gitlink", "parentVerification"];

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function object(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-record", `${label} must be an object`); }

const DRAFT_07 = "http://json-schema.org/draft-07/schema#";
const SCHEMA_KEYWORDS = new Set(["$schema", "$id", "title", "type", "required", "properties", "additionalProperties", "const", "enum", "pattern", "minItems", "items"]);
const SCHEMA_TYPES = new Set(["object", "string", "null", "array", "boolean", "number", "integer"]);
function schemaObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function invalidSchema(location, message) { fail("invalid-schema", `${location}: ${message}`); }
export function validateSchemaDefinition(schema, location = "$", root = true) {
  if (!schemaObject(schema)) invalidSchema(location, "schema must be an object");
  for (const key of Object.keys(schema)) if (!SCHEMA_KEYWORDS.has(key)) invalidSchema(location, `unsupported schema keyword ${key}`);
  if (root && schema.$schema !== DRAFT_07) invalidSchema(location, `$schema must equal ${DRAFT_07}`);
  if (schema.$schema !== undefined && schema.$schema !== DRAFT_07) invalidSchema(location, `$schema must equal ${DRAFT_07}`);
  for (const key of ["$id", "title"]) if (schema[key] !== undefined && typeof schema[key] !== "string") invalidSchema(location, `${key} must be a string`);
  if (schema.type !== undefined && (!SCHEMA_TYPES.has(schema.type))) invalidSchema(location, "type must be a supported type string");
  if (schema.properties !== undefined) {
    if (!schemaObject(schema.properties)) invalidSchema(location, "properties must be an object of schemas");
    for (const [key, child] of Object.entries(schema.properties)) validateSchemaDefinition(child, `${location}.properties.${key}`, false);
  }
  if (schema.additionalProperties !== undefined) {
    if (typeof schema.additionalProperties !== "boolean" && !schemaObject(schema.additionalProperties)) invalidSchema(location, "additionalProperties must be boolean or schema object");
    if (schemaObject(schema.additionalProperties)) validateSchemaDefinition(schema.additionalProperties, `${location}.additionalProperties`, false);
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string") || new Set(schema.required).size !== schema.required.length)) invalidSchema(location, "required must be a unique string array");
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) invalidSchema(location, "enum must be a nonempty array");
  if (schema.pattern !== undefined) { if (typeof schema.pattern !== "string") invalidSchema(location, "pattern must be a string"); try { new RegExp(schema.pattern); } catch { invalidSchema(location, "pattern must compile"); } }
  if (schema.minItems !== undefined && (!Number.isInteger(schema.minItems) || schema.minItems < 0)) invalidSchema(location, "minItems must be a nonnegative integer");
  if (schema.items !== undefined) { if (!schemaObject(schema.items)) invalidSchema(location, "items must be a schema object"); validateSchemaDefinition(schema.items, `${location}.items`, false); }
  return schema;
}
function schemaType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
  return typeof value === type;
}
export function validateSchema(value, schema, location = "$") {
  validateSchemaDefinition(schema, location, location === "$");
  if (schema.type !== undefined && !schemaType(value, schema.type)) fail("schema-validation", `${location}: expected ${schema.type}`);
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) fail("schema-validation", `${location}: expected constant ${JSON.stringify(schema.const)}`);
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value)))) fail("schema-validation", `${location}: value is not in enum`);
  if (schema.pattern !== undefined && (typeof value !== "string" || !(new RegExp(schema.pattern).test(value)))) fail("schema-validation", `${location}: does not match ${schema.pattern}`);
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || !schemaType(value, "object")) fail("schema-validation", `${location}: required requires object`);
    for (const key of schema.required) if (!(key in value)) fail("schema-validation", `${location}: missing required ${key}`);
  }
  if (schemaType(value, "object")) {
    const properties = schema.properties ?? {};
    for (const [key, item] of Object.entries(value)) {
      if (key in properties) validateSchema(item, properties[key], `${location}.${key}`);
      else if (schema.additionalProperties === false) fail("schema-validation", `${location}: additional property ${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") validateSchema(item, schema.additionalProperties, `${location}.${key}`);
    }
  }
  if (schemaType(value, "array")) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail("schema-validation", `${location}: expected at least ${schema.minItems} items`);
    if (schema.items !== undefined) for (let index = 0; index < value.length; index += 1) validateSchema(value[index], schema.items, `${location}[${index}]`);
  }
  return value;
}
export function validateCompatibilityRecord(record) {
  object(record, "compatibility record");
  for (const key of REQUIRED) if (!(key in record)) fail("invalid-record", `compatibility record missing ${key}`);
  if (record.schemaVersion !== 1 || record.component !== "pi-team-bright") fail("invalid-record", "unsupported Pi Team Bright compatibility record");
  for (const [label, value] of [["source", record.source], ["package", record.package], ["publication", record.publication], ["gitlink", record.gitlink], ["parentVerification", record.parentVerification]]) object(value, label);
  if (record.source.repository !== "https://github.com/deephbz/pi-team-bright.git" || !/^[0-9a-f]{40}$/.test(record.source.commit) || !/^[0-9a-f]{40}$/.test(record.source.tree)) fail("invalid-record", "source repository, commit, or tree is invalid");
  if (record.package.name !== "@hypercarrier/pi-team-bright" || typeof record.package.version !== "string") fail("invalid-record", "package identity is invalid");
  if (record.publication.state !== "unpublished" || record.publication.npmIntegrity !== null) fail("invalid-record", "unpublished package must have null npm integrity");
  if (record.gitlink.path !== SUBMODULE_PATH || record.gitlink.mode !== "160000" || record.gitlink.commit !== record.source.commit) fail("invalid-record", "gitlink does not match source commit");
  if (record.parentVerification.requiredCheckout !== "recursive") fail("invalid-record", "parent verification must require recursive checkout");
  const launcher = record.beads?.launcher, archive = record.beads?.archive;
  if (!launcher || launcher.package !== "@beads/bd" || launcher.version !== "1.1.0" || launcher.bin !== "bin/bd.js" || launcher.source !== "src/utils/beads.ts") fail("invalid-record", "Beads launcher record is invalid");
  if (!archive || archive.materializer !== "scripts/materialize-beads-linux-amd64.cjs" || archive.url !== "https://github.com/gastownhall/beads/releases/download/v1.1.0/beads_1.1.0_linux_amd64.tar.gz" || !/^[0-9a-f]{64}$/.test(archive.sha256)) fail("invalid-record", "Beads archive record is invalid");
  if (!Array.isArray(record.childVerification.receipts) || record.childVerification.receipts.length === 0) fail("invalid-record", "child verification receipts are required");
  return record;
}
export function verifyComposition({ root = ROOT, debug = false } = {}) {
  const trace = { root, record: RECORD_PATH, submodule: SUBMODULE_PATH, checks: [] };
  const check = (name, actual, expected) => { trace.checks.push({ name, actual, expected }); if (actual !== expected) fail(name, `${name}: expected ${expected}, got ${actual ?? "missing"}`); };
  const recordFile = path.join(root, RECORD_PATH);
  const schemaFile = path.join(root, SCHEMA_PATH);
  if (!existsSync(recordFile)) fail("missing-record", `missing compatibility record: ${RECORD_PATH}`);
  if (!existsSync(schemaFile)) fail("missing-schema", `missing compatibility schema: ${SCHEMA_PATH}`);
  const record = JSON.parse(readFileSync(recordFile, "utf8"));
  const schema = JSON.parse(readFileSync(schemaFile, "utf8"));
  validateSchema(record, schema);
  validateCompatibilityRecord(record);
  const submodule = path.join(root, SUBMODULE_PATH);
  if (!existsSync(submodule)) fail("missing-submodule", `missing submodule directory: ${SUBMODULE_PATH}; run git submodule update --init --recursive`);
  if (!existsSync(path.join(submodule, ".git"))) fail("uninitialized-submodule", `uninitialized submodule: ${SUBMODULE_PATH}; run git submodule update --init --recursive`);
  const index = git(root, ["ls-files", "--stage", "--", SUBMODULE_PATH]).split(/\s+/);
  check("gitlink-mode", index[0], record.gitlink.mode);
  check("gitlink-commit", index[1], record.gitlink.commit);
  check("origin", git(submodule, ["remote", "get-url", "origin"]), record.source.repository);
  check("revision", git(submodule, ["rev-parse", "HEAD"]), record.source.commit);
  check("tree", git(submodule, ["rev-parse", "HEAD^{tree}"]), record.source.tree);
  const dirty = git(submodule, ["status", "--porcelain", "--untracked-files=normal"]);
  if (dirty) fail("dirty-submodule", `dirty submodule: ${SUBMODULE_PATH}`);
  const manifest = JSON.parse(readFileSync(path.join(submodule, "package.json"), "utf8"));
  check("package-name", manifest.name, record.package.name);
  check("package-version", manifest.version, record.package.version);
  const peers = manifest.peerDependencies ?? {};
  for (const [name, range] of Object.entries(record.pi.peerRanges)) check(`peer-${name}`, peers[name], range);
  check("beads-dependency", manifest.dependencies?.[record.beads.launcher.package], record.beads.launcher.version);
  const launcherSource = path.join(submodule, record.beads.launcher.source);
  const archiveSource = path.join(submodule, record.beads.archive.materializer);
  if (!existsSync(launcherSource)) fail("beads-launcher", `missing Beads launcher source: ${record.beads.launcher.source}`);
  if (!existsSync(archiveSource)) fail("beads-archive", `missing Beads archive materializer: ${record.beads.archive.materializer}`);
  const archiveText = readFileSync(archiveSource, "utf8");
  const archiveTemplate = "https://github.com/gastownhall/beads/releases/download/v${VERSION}/beads_${VERSION}_linux_amd64.tar.gz";
  if ((!archiveText.includes(record.beads.archive.url) && !archiveText.includes(archiveTemplate)) || !archiveText.includes(record.beads.archive.sha256)) fail("beads-archive", "Beads archive URL or SHA-256 does not match the child materializer");
  return debug ? { record, trace } : { component: record.component, revision: record.source.commit, status: "verified" };
}

function isMainModule() {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isMainModule()) {
  const debug = process.argv.includes("--debug");
  try { console.log(JSON.stringify(verifyComposition({ debug }), null, debug ? 2 : 0)); }
  catch (error) { console.error(`Pi Team Bright composition verification failed [${error.code ?? "error"}]: ${error.message}`); process.exitCode = 1; }
}
