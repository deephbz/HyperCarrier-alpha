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
const SOURCE = Object.freeze({ repository: "https://github.com/deephbz/pi-team-bright.git", commit: "82c31a91d0f1c2f6cb69ae86dc8df5272868cb58", tree: "44253927810f21c06deeecfaa9af5e7817510dbd" });
const PACKAGE = Object.freeze({ name: "@hypercarrier/pi-team-bright", version: "0.17.0" });
const PEERS = Object.freeze({ "@earendil-works/pi-ai": ">=0.83.0", "@earendil-works/pi-coding-agent": ">=0.83.0", "@earendil-works/pi-tui": ">=0.83.0", typebox: "^1.1.38" });
const PUBLICATION = Object.freeze({ state: "published", npmIntegrity: "sha512-DsgObCO73Cixd3J7fKmJzBa6DrM/CPVpaiifSeoZQTyG0zzVfBxSPiFNEZhD3OBm9sl4B7MCUAlPu/sAROCROQ==", npmShasum: "e3e3c0af21adee8ec7b337e18be0f10980b2422c", tarball: "https://registry.npmjs.org/@hypercarrier/pi-team-bright/-/pi-team-bright-0.17.0.tgz", tarballSha256: "c8e05a4f0cddcb652c54abf006e98d23bd44a3418a0b9314576190add1f42b4e", tag: "v0.17.0", releaseUrl: "https://github.com/deephbz/pi-team-bright/releases/tag/v0.17.0", publishUrl: "https://github.com/deephbz/pi-team-bright/actions/runs/31813616378", distTag: "latest", tarEntries: 197 });
const REQUIRED_RECEIPTS = ["stable-release-dry-run", "stable-oidc-publication", "registry-byte-verification", "graph-native-team-e2e"];

function git(root, args) { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function object(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-record", `${label} must be an object`); }
function sameKeys(value, expected) { return Object.keys(value ?? {}).sort().join("\n") === Object.keys(expected).sort().join("\n"); }

export function validateCompatibilityRecord(record) {
  object(record, "compatibility record");
  for (const key of ["schemaVersion", "component", "source", "package", "publication", "pi", "beads", "childVerification", "gitlink", "parentVerification"]) if (!(key in record)) fail("invalid-record", `compatibility record missing ${key}`);
  if (record.schemaVersion !== 1 || record.component !== "pi-team-bright") fail("invalid-record", "unsupported Pi Team Bright compatibility record");
  if (JSON.stringify(record.source) !== JSON.stringify(SOURCE)) fail("invalid-record", "source tuple is invalid");
  if (JSON.stringify(record.package) !== JSON.stringify(PACKAGE)) fail("invalid-record", "package identity is invalid");
  if (JSON.stringify(record.publication) !== JSON.stringify(PUBLICATION)) fail("invalid-record", "published npm tuple is invalid");
  if (!sameKeys(record.pi?.peerRanges, PEERS) || Object.entries(PEERS).some(([name, range]) => record.pi.peerRanges[name] !== range)) fail("invalid-record", "Pi peer epoch is invalid");
  if (record.gitlink?.path !== SUBMODULE_PATH || record.gitlink.mode !== "160000" || record.gitlink.commit !== SOURCE.commit) fail("invalid-record", "gitlink does not match source commit");
  if (record.parentVerification?.state !== "verified" || record.parentVerification?.verifier !== "scripts/verify-pi-team-bright-composition.mjs" || record.parentVerification?.requiredCheckout !== "recursive") fail("invalid-record", "parent verification is invalid");
  const launcher = record.beads?.launcher, archive = record.beads?.archive;
  if (!launcher || launcher.package !== "@beads/bd" || launcher.version !== "1.1.0" || launcher.bin !== "bin/bd.js" || launcher.source !== "src/utils/beads.ts") fail("invalid-record", "Beads launcher record is invalid");
  if (!archive || archive.materializer !== "scripts/materialize-beads-linux-amd64.cjs" || archive.url !== "https://github.com/gastownhall/beads/releases/download/v1.1.0/beads_1.1.0_linux_amd64.tar.gz" || archive.sha256 !== "b0f3dd607c3fb989ee08d0a6854fba80d0402971eb108f9af6170bc14d491a34") fail("invalid-record", "Beads archive record is invalid");
  const receipts = record.childVerification?.receipts;
  if (record.childVerification?.ciWorkflow !== ".github/workflows/publish.yml" || !Array.isArray(receipts) || !REQUIRED_RECEIPTS.every((name) => receipts.some((receipt) => receipt?.name === name && typeof receipt.command === "string" && receipt.command && typeof receipt.result === "string" && receipt.result))) fail("invalid-record", "child verification receipts are incomplete");
  return record;
}

export function verifyComposition({ root = ROOT, debug = false } = {}) {
  const trace = { root, record: RECORD_PATH, submodule: SUBMODULE_PATH, checks: [] };
  const check = (name, actual, expected) => { trace.checks.push({ name, actual, expected }); if (actual !== expected) fail(name, `${name}: expected ${expected}, got ${actual ?? "missing"}`); };
  const recordFile = path.join(root, RECORD_PATH), schemaFile = path.join(root, SCHEMA_PATH);
  if (!existsSync(recordFile)) fail("missing-record", `missing compatibility record: ${RECORD_PATH}`);
  if (!existsSync(schemaFile)) fail("missing-schema", `missing compatibility schema: ${SCHEMA_PATH}`);
  const record = JSON.parse(readFileSync(recordFile, "utf8"));
  validateSchema(record, JSON.parse(readFileSync(schemaFile, "utf8"))); validateCompatibilityRecord(record);
  const child = path.join(root, SUBMODULE_PATH);
  if (!existsSync(child)) fail("missing-submodule", `missing submodule directory: ${SUBMODULE_PATH}; run git submodule update --init --recursive`);
  if (!existsSync(path.join(child, ".git"))) fail("uninitialized-submodule", `uninitialized submodule: ${SUBMODULE_PATH}; run git submodule update --init --recursive`);
  const index = git(root, ["ls-files", "--stage", "--", SUBMODULE_PATH]).split(/\s+/);
  check("gitlink-mode", index[0], "160000"); check("gitlink-commit", index[1], SOURCE.commit);
  check("origin", git(child, ["remote", "get-url", "origin"]), SOURCE.repository); check("revision", git(child, ["rev-parse", "HEAD"]), SOURCE.commit); check("tree", git(child, ["rev-parse", "HEAD^{tree}"]), SOURCE.tree);
  if (git(child, ["status", "--porcelain", "--untracked-files=normal"])) fail("dirty-submodule", `dirty submodule: ${SUBMODULE_PATH}`);
  const manifest = JSON.parse(readFileSync(path.join(child, "package.json"), "utf8"));
  check("package-name", manifest.name, PACKAGE.name); check("package-version", manifest.version, PACKAGE.version);
  for (const [name, range] of Object.entries(PEERS)) check(`peer-${name}`, manifest.peerDependencies?.[name], range);
  check("beads-dependency", manifest.dependencies?.[record.beads.launcher.package], record.beads.launcher.version);
  for (const source of [record.beads.launcher.source, record.beads.archive.materializer]) if (!existsSync(path.join(child, source))) fail("beads-source", `missing child source: ${source}`);
  const archiveText = readFileSync(path.join(child, record.beads.archive.materializer), "utf8");
  if (!archiveText.includes(record.beads.archive.sha256)) fail("beads-archive", "Beads archive SHA-256 does not match the child materializer");
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  check("timeline-package-version", lock.packages?.["apps/timeline"]?.dependencies?.[PACKAGE.name], PACKAGE.version);
  check("root-pi-version", lock.packages?.["node_modules/@earendil-works/pi-coding-agent"]?.version, "0.80.10");
  check("child-pi-version", lock.packages?.["packages/pi-team-bright/node_modules/@earendil-works/pi-coding-agent"]?.version, "0.83.0");
  return debug ? { record, trace } : { component: record.component, revision: SOURCE.commit, status: "verified" };
}

function isMainModule() { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } }
if (isMainModule()) { const debug = process.argv.includes("--debug"); try { console.log(JSON.stringify(verifyComposition({ debug }), null, debug ? 2 : 0)); } catch (error) { console.error(`Pi Team Bright composition verification failed [${error.code ?? "error"}]: ${error.message}`); process.exitCode = 1; } }
