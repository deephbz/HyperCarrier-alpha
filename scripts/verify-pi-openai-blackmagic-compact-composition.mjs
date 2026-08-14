#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSchema } from "./lib/closed-json-schema.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECORD_PATH = "config/pi-openai-blackmagic-compact-compatibility.json";
const SCHEMA_PATH = "config/schemas/pi-openai-blackmagic-compact-compatibility.schema.json";
const SUBMODULE_PATH = "packages/pi-openai-blackmagic-compact";
const REPOSITORY = "https://github.com/deephbz/pi-openai-blackmagic-compact.git";
const PACKAGE = Object.freeze({ name: "@hypercarrier/pi-openai-blackmagic-compact", version: "0.1.0-rc.7" });
const SOURCE = Object.freeze({ repository: REPOSITORY, commit: "6f3ee6a3f5c2743e4cdca8d9d18a0456c48c17e9", tree: "506648583c4dbe205fe9a2641bcb1cc2b643bf52", gitTag: { state: "absent", applicability: "not_applicable" } });
const PEERS = Object.freeze({ "@earendil-works/pi-coding-agent": "0.83.0", "@earendil-works/pi-ai": "0.83.0", "@earendil-works/pi-tui": "0.83.0" });
const PUBLICATION = Object.freeze({ state: "published", npmIntegrity: "sha512-j3yTKo08m/Opts+updZluq0BwgvWOzPEpu5XxHm7ih/o7Uoma28shK4MUPHv+X6d+F1lmdPgEaJ/Lim69Lucng==", npmShasum: "493487b8aea719f2c14794aabc2ce8fa235b775d", tarball: "https://registry.npmjs.org/@hypercarrier/pi-openai-blackmagic-compact/-/pi-openai-blackmagic-compact-0.1.0-rc.7.tgz", tarballSha256: "3e458c1636ed45ead14cfe21d207a77f563610a15eda864c309128a6ca7c4b08", distTag: "next", latest: "0.1.0-rc.5", fileCount: 9, unpackedSize: 43182, publishUrl: "https://github.com/deephbz/pi-openai-blackmagic-compact/actions/runs/31809511756", attestationEndpoint: "https://registry.npmjs.org/-/npm/v1/attestations/@hypercarrier%2fpi-openai-blackmagic-compact@0.1.0-rc.7", githubRelease: { state: "absent", applicability: "not_applicable" }, provenance: { predicate: "https://slsa.dev/provenance/v1", workflow: ".github/workflows/publish.yml", workflowRef: "refs/heads/main", invocation: "https://github.com/deephbz/pi-openai-blackmagic-compact/actions/runs/31809511756/attempts/1" } });
const WORKSPACE_EXCLUSION = "!packages/pi-openai-blackmagic-compact";
const REQUIRED_RECEIPTS = ["unit-suite", "package-allowlist", "trusted-publisher-publication", "registry-byte-verification", "slsa-provenance"];

function git(root, args) { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function object(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-record", `${label} must be an object`); }
function sameKeys(value, expected) { return Object.keys(value ?? {}).sort().join("\n") === Object.keys(expected).sort().join("\n"); }

export function validateCompatibilityRecord(record, source = SOURCE) {
  object(record, "compatibility record");
  for (const key of ["schemaVersion", "component", "source", "package", "pi", "childVerification", "publication", "gitlink", "parentVerification"]) if (!(key in record)) fail("invalid-record", `compatibility record missing ${key}`);
  if (record.schemaVersion !== 1 || record.component !== "pi-openai-blackmagic-compact") fail("invalid-record", "unsupported Pi OpenAI Blackmagic Compact compatibility record");
  if (JSON.stringify(record.source) !== JSON.stringify(source)) fail("invalid-record", "source tuple is invalid");
  if (JSON.stringify(record.package) !== JSON.stringify(PACKAGE)) fail("invalid-record", "package identity is invalid");
  if (!sameKeys(record.pi?.peerRanges, PEERS) || Object.entries(PEERS).some(([name, range]) => record.pi.peerRanges[name] !== range)) fail("invalid-record", "Pi peer epoch is invalid");
  if (JSON.stringify(record.publication) !== JSON.stringify(PUBLICATION)) fail("invalid-record", "publication tuple is invalid");
  if (record.gitlink?.path !== SUBMODULE_PATH || record.gitlink.mode !== "160000" || record.gitlink.commit !== source.commit) fail("invalid-record", "gitlink does not match source commit");
  if (record.parentVerification?.state !== "verified" || record.parentVerification?.verifier !== "scripts/verify-pi-openai-blackmagic-compact-composition.mjs" || record.parentVerification?.requiredCheckout !== "recursive" || record.parentVerification?.workspaceDisposition !== "excluded: root Pi 0.80.10 conflicts with child Pi 0.83.0 peers") fail("invalid-record", "parent checkout or workspace disposition is invalid");
  const receipts = record.childVerification?.receipts;
  if (record.childVerification?.ciWorkflow !== ".github/workflows/publish.yml" || !Array.isArray(receipts) || !REQUIRED_RECEIPTS.every((name) => receipts.some((receipt) => receipt?.name === name && typeof receipt.command === "string" && receipt.command && typeof receipt.result === "string" && receipt.result))) fail("invalid-record", "child verification receipts are incomplete");
  return record;
}

export function verifyComposition({ root = ROOT, debug = false, expectedSource = SOURCE } = {}) {
  const recordFile = path.join(root, RECORD_PATH), schemaFile = path.join(root, SCHEMA_PATH);
  if (!existsSync(recordFile)) fail("missing-record", `missing compatibility record: ${RECORD_PATH}`);
  if (!existsSync(schemaFile)) fail("missing-schema", `missing compatibility schema: ${SCHEMA_PATH}`);
  const record = JSON.parse(readFileSync(recordFile, "utf8"));
  validateSchema(record, JSON.parse(readFileSync(schemaFile, "utf8"))); validateCompatibilityRecord(record, expectedSource);
  const child = path.join(root, SUBMODULE_PATH);
  if (!existsSync(child)) fail("missing-submodule", `missing submodule directory: ${SUBMODULE_PATH}; run git submodule update --init --recursive`);
  if (!existsSync(path.join(child, ".git"))) fail("uninitialized-submodule", `uninitialized submodule: ${SUBMODULE_PATH}; run git submodule update --init --recursive`);
  const check = (name, actual, expected) => { if (actual !== expected) fail(name, `${name}: expected ${expected}, got ${actual ?? "missing"}`); };
  const index = git(root, ["ls-files", "--stage", "--", SUBMODULE_PATH]).split(/\s+/); check("gitlink-mode", index[0], "160000"); check("gitlink-commit", index[1], expectedSource.commit);
  check("origin", git(child, ["remote", "get-url", "origin"]), REPOSITORY); check("revision", git(child, ["rev-parse", "HEAD"]), expectedSource.commit); check("tree", git(child, ["rev-parse", "HEAD^{tree}"]), expectedSource.tree);
  if (git(child, ["status", "--porcelain", "--untracked-files=normal"])) fail("dirty-submodule", `dirty submodule: ${SUBMODULE_PATH}`);
  const manifest = JSON.parse(readFileSync(path.join(child, "package.json"), "utf8")); check("package-name", manifest.name, PACKAGE.name); check("package-version", manifest.version, PACKAGE.version);
  for (const [name, range] of Object.entries(PEERS)) check(`peer-${name}`, manifest.peerDependencies?.[name], range);
  const childLockFile = path.join(child, "package-lock.json"); if (!existsSync(childLockFile)) fail("missing-child-lock", "child package-lock.json is required");
  const childLock = JSON.parse(readFileSync(childLockFile, "utf8")), childLockRoot = childLock.packages?.[""];
  check("child-lock-name", childLockRoot?.name, PACKAGE.name); check("child-lock-version", childLockRoot?.version, PACKAGE.version);
  for (const [name, range] of Object.entries(PEERS)) check(`child-lock-peer-${name}`, childLockRoot?.peerDependencies?.[name], range);
  const rootPackage = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")); if (!rootPackage.workspaces?.includes(WORKSPACE_EXCLUSION)) fail("workspace-disposition", "root must exclude Pi 0.83 child from its Pi 0.80.10 workspace");
  const rootLock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8")); if (!rootLock.packages?.[""]?.workspaces?.includes(WORKSPACE_EXCLUSION)) fail("workspace-lock-disposition", "root lock must preserve the Pi epoch workspace exclusion");
  const result = { component: record.component, revision: expectedSource.commit, status: "verified" };
  return debug ? { record, result } : result;
}

function isMainModule() { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } }
if (isMainModule()) { try { console.log(JSON.stringify(verifyComposition({ debug: process.argv.includes("--debug") }), null, process.argv.includes("--debug") ? 2 : 0)); } catch (error) { console.error(`Pi OpenAI Blackmagic Compact composition verification failed [${error.code ?? "error"}]: ${error.message}`); process.exitCode = 1; } }
