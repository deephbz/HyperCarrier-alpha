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
const PACKAGE = "@hypercarrier/pi-openai-blackmagic-compact";
const PEERS = { "@earendil-works/pi-coding-agent": "0.83.0", "@earendil-works/pi-ai": "0.83.0", "@earendil-works/pi-tui": "0.83.0" };
const SOURCE = Object.freeze({ commit: "a6247ac3a3f6ae4b80905f7cded9d2847815f15d", tree: "f63918a0035d31c787c5c3a70c7c66a5f354ff1a" });
const RELEASE = Object.freeze({ npmIntegrity: "sha512-pXn/IsTGBRJfc/q9JSUa6HHpzg8v0Kg5J23n0smLoKct3mjjvWiFFr4z7O23IlCiOpI7Y4mGp/y/uM4eFHwgqg==", npmShasum: "e7900a2d2a8fa2af53ce2185d3a756eeccb46ec9", tarball: "https://registry.npmjs.org/@hypercarrier/pi-openai-blackmagic-compact/-/pi-openai-blackmagic-compact-0.1.0-rc.5.tgz", tarballSha256: "87583b792d57737c933f83ae34c36240d11ea296a31ffc29729827a550705569", tag: "v0.1.0-rc.5", releaseUrl: "https://github.com/deephbz/pi-openai-blackmagic-compact/releases/tag/v0.1.0-rc.5", ciUrls: ["https://github.com/deephbz/pi-openai-blackmagic-compact/actions/runs/30749413496", "https://github.com/deephbz/pi-openai-blackmagic-compact/actions/runs/30749499634"], publishUrl: "https://github.com/deephbz/pi-openai-blackmagic-compact/actions/runs/30749884378" });
const WORKSPACE_EXCLUSION = "!packages/pi-openai-blackmagic-compact";
const REQUIRED_RECEIPTS = ["unit-suite", "package-allowlist", "pack-dry-run", "child-ci", "publish-dry-run", "authenticated-codex-canary"];

function git(root, args) { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function object(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-record", `${label} must be an object`); }

export function validateCompatibilityRecord(record, source = SOURCE) {
  object(record, "compatibility record");
  for (const key of ["schemaVersion", "component", "source", "package", "pi", "childVerification", "publication", "gitlink", "parentVerification"]) if (!(key in record)) fail("invalid-record", `compatibility record missing ${key}`);
  if (record.schemaVersion !== 1 || record.component !== "pi-openai-blackmagic-compact") fail("invalid-record", "unsupported Pi OpenAI Blackmagic Compact compatibility record");
  if (record.source?.repository !== REPOSITORY || record.source.commit !== source.commit || record.source.tree !== source.tree || record.source.tagObject !== "10881b9100dbe6900682065f4a13d8f84091971e" || record.source.tag !== "v0.1.0-rc.5" || record.source.tagTarget !== source.commit || record.source.sanitizedRootCommit !== "7eaba365fc4b0984f68941f2b6b2f6e9358e1d35" || record.source.sanitizedRootTree !== "29f3bae40c3b4af1b1f7ac98e2b98799d1425248") fail("invalid-record", "source tuple is invalid");
  if (record.package?.name !== PACKAGE || record.package.version !== "0.1.0-rc.5") fail("invalid-record", "package identity is invalid");
  if (record.lineage?.sourceReceipt?.sha256 !== "860cd6b0c3b29f4d81ea17ab68409f342dc8be488c429a895e6a9d6738b1b71d" || record.lineage?.legacyRc4?.tagObject !== "b4ef75f9349f5aa6216df0914d2159697ac876eb" || record.lineage?.legacyRc4?.npmArtifact !== false) fail("invalid-record", "source lineage receipt is invalid");
  if (record.publication?.releaseId !== 363795762 || record.publication?.distTag !== "next" || record.publication?.latest !== "0.1.0-rc.1" || record.publication?.fileCount !== 9 || record.publication?.unpackedSize !== 40801 || record.publication?.publishUrl !== "https://github.com/deephbz/pi-openai-blackmagic-compact/actions/runs/30749884378") fail("invalid-record", "publication routing tuple is invalid");
  const peerRanges = record.pi?.peerRanges;
  if (!peerRanges || Object.keys(peerRanges).sort().join("\n") !== Object.keys(PEERS).sort().join("\n") || Object.entries(PEERS).some(([name, range]) => peerRanges[name] !== range)) fail("invalid-record", "Pi peer epoch is invalid");
  if (!record.publication || Object.entries(RELEASE).some(([key, value]) => JSON.stringify(record.publication[key]) !== JSON.stringify(value))) fail("invalid-record", "publication tuple is invalid");
  if (record.gitlink?.path !== SUBMODULE_PATH || record.gitlink.mode !== "160000" || record.gitlink.commit !== record.source.commit) fail("invalid-record", "gitlink does not match source commit");
  if (record.parentVerification?.state !== "verified" || record.parentVerification?.requiredCheckout !== "recursive" || record.parentVerification?.workspaceDisposition !== "excluded: root Pi 0.80.10 conflicts with child Pi 0.83.0 peers") fail("invalid-record", "parent checkout or workspace disposition is invalid");
  if (record.parentVerification.verifier !== "scripts/verify-pi-openai-blackmagic-compact-composition.mjs") fail("invalid-record", "parent verifier is invalid");
  const receipts = record.childVerification?.receipts;
  if (!Array.isArray(receipts) || !REQUIRED_RECEIPTS.every((name) => receipts.some((receipt) => receipt?.name === name && typeof receipt.command === "string" && receipt.command && typeof receipt.result === "string" && receipt.result))) fail("invalid-record", "child verification receipts are incomplete");
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
  const index = git(root, ["ls-files", "--stage", "--", SUBMODULE_PATH]).split(/\s+/); check("gitlink-mode", index[0], "160000"); check("gitlink-commit", index[1], record.source.commit);
  check("origin", git(child, ["remote", "get-url", "origin"]), REPOSITORY); check("revision", git(child, ["rev-parse", "HEAD"]), record.source.commit); check("tree", git(child, ["rev-parse", "HEAD^{tree}"]), record.source.tree);
  if (git(child, ["status", "--porcelain", "--untracked-files=normal"])) fail("dirty-submodule", `dirty submodule: ${SUBMODULE_PATH}`);
  const manifest = JSON.parse(readFileSync(path.join(child, "package.json"), "utf8")); check("package-name", manifest.name, PACKAGE); check("package-version", manifest.version, record.package.version);
  for (const [name, range] of Object.entries(PEERS)) check(`peer-${name}`, manifest.peerDependencies?.[name], range);
  const childLockFile = path.join(child, "package-lock.json");
  if (!existsSync(childLockFile)) fail("missing-child-lock", "child package-lock.json is required");
  const childLock = JSON.parse(readFileSync(childLockFile, "utf8")), childLockRoot = childLock.packages?.[""];
  check("child-lock-name", childLockRoot?.name, PACKAGE); check("child-lock-version", childLockRoot?.version, record.package.version);
  for (const [name, range] of Object.entries(PEERS)) check(`child-lock-peer-${name}`, childLockRoot?.peerDependencies?.[name], range);
  const rootPackage = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")); if (!rootPackage.workspaces?.includes(WORKSPACE_EXCLUSION)) fail("workspace-disposition", "root must exclude Pi 0.83 child from its Pi 0.80.10 workspace");
  const rootLock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8")); if (!rootLock.packages?.[""]?.workspaces?.includes(WORKSPACE_EXCLUSION)) fail("workspace-lock-disposition", "root lock must preserve the Pi epoch workspace exclusion");
  const result = { component: record.component, revision: record.source.commit, status: "verified" };
  return debug ? { record, result } : result;
}

function isMainModule() { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } }
if (isMainModule()) { try { console.log(JSON.stringify(verifyComposition({ debug: process.argv.includes("--debug") }), null, process.argv.includes("--debug") ? 2 : 0)); } catch (error) { console.error(`Pi OpenAI Blackmagic Compact composition verification failed [${error.code ?? "error"}]: ${error.message}`); process.exitCode = 1; } }
