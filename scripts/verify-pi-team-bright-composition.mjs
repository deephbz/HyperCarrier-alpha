#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSchema } from "./lib/closed-json-schema.mjs";
export { validateSchema, validateSchemaDefinition } from "./lib/closed-json-schema.mjs";

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

export function validateCompatibilityRecord(record) {
  object(record, "compatibility record");
  for (const key of REQUIRED) if (!(key in record)) fail("invalid-record", `compatibility record missing ${key}`);
  if (record.schemaVersion !== 1 || record.component !== "pi-team-bright") fail("invalid-record", "unsupported Pi Team Bright compatibility record");
  for (const [label, value] of [["source", record.source], ["package", record.package], ["publication", record.publication], ["gitlink", record.gitlink], ["parentVerification", record.parentVerification]]) object(value, label);
  if (record.source.repository !== "https://github.com/deephbz/pi-team-bright.git" || !/^[0-9a-f]{40}$/.test(record.source.commit) || !/^[0-9a-f]{40}$/.test(record.source.tree)) fail("invalid-record", "source repository, commit, or tree is invalid");
  if (record.package.name !== "@hypercarrier/pi-team-bright" || typeof record.package.version !== "string") fail("invalid-record", "package identity is invalid");
  const publication = record.publication;
  if (
    publication.state !== "published" ||
    publication.npmIntegrity !== "sha512-Rbc1DUomZ9N11hyNv7womtlGN7sBEWQ86UQstCnl3b/KvV/xDbyMX5eZkc9QM21XPGNqKCjR4/gZ6fKziqkI2w==" ||
    publication.npmShasum !== "402bba56d307399a685495ca87d253b10e86ed2f" ||
    publication.tarball !== "https://registry.npmjs.org/@hypercarrier/pi-team-bright/-/pi-team-bright-0.17.0-rc.8.tgz" ||
    publication.tarballSha256 !== "bf082d064a07fc2e7a890176c132c962bd153e793a368f9e410230387745f4d6" ||
    publication.tag !== "v0.17.0-rc.8" ||
    publication.releaseUrl !== "https://github.com/deephbz/pi-team-bright/releases/tag/v0.17.0-rc.8" ||
    publication.publishUrl !== "https://github.com/deephbz/pi-team-bright/actions/runs/30994064679" ||
    publication.distTag !== "next" ||
    publication.tarEntries !== 84
  ) fail("invalid-record", "published npm tuple is invalid");
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
