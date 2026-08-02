#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSchema } from "./lib/closed-json-schema.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECORD = "config/rarebit-compatibility.json";
const SCHEMA = "config/schemas/rarebit-compatibility.schema.json";
const CHILD = "packages/hc-rarebit";
const EXPECTED = {
  source: { repository: "https://github.com/deephbz/rarebit.git", commit: "336565fb132404c02f5adbbe1be4d86c2206e035", tree: "ed87414cb9b5b1f8e77dab0d66dfa279d5f740a8", tagObject: "2cf294c20a54ff36eb8ae2864216ea6983bc4dc8", tag: "v0.1.0-alpha.4", tagTarget: "336565fb132404c02f5adbbe1be4d86c2206e035" },
  package: { name: "@hypercarrier/rarebit", version: "0.1.0-alpha.4", bin: "rarebit", node: ">=22", piPeer: { "@earendil-works/pi-ai": "*" } },
  publication: { sri: "sha512-x4CzTUQX9xwdsJzLJqIlghkfypOjwEHj0ScJXWhrdE/HyB9ISTG/vobaaWFX51tWSekSH3bczVOVSksNxH7Ixw==", sha1: "d0453675d32f2dae05c675122a119547b2d1bea6", sha256: "19449d2d1d3179ae13299d62951b685b4c3ae1dccf1fb996c624e9964d95d12e", tarball: "https://registry.npmjs.org/@hypercarrier/rarebit/-/rarebit-0.1.0-alpha.4.tgz", size: 92096, unpackedSize: 401693, fileCount: 50, githubRelease: { id: 363793012, url: "https://github.com/deephbz/rarebit/releases/tag/v0.1.0-alpha.4", prerelease: true, latest: false }, signature: { key: "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U", value: "MEUCIQCWX+aVCWOPantTtYewNNmc3Sw6soihJp5O6GjlzrSMtwIgIZ7eXfxUMiinVUzyE5ks2t6mP80E0DqahGLx7NOnPoI=" }, next: "0.1.0-alpha.4", latest: "0.1.0-alpha.1", bootstrapExceptionEvidence: "https://github.com/deephbz/rarebit/releases/tag/v0.1.0-alpha.2" },
  verification: { ci: { run: 30749327677, url: "https://github.com/deephbz/rarebit/actions/runs/30749327677", head: "336565fb132404c02f5adbbe1be4d86c2206e035" }, dryRun: { run: 30749421136, url: "https://github.com/deephbz/rarebit/actions/runs/30749421136", nonce: "b50a45f4-96ca-4d5a-8f51-5a95ea6d0ae8", head: "336565fb132404c02f5adbbe1be4d86c2206e035" }, publish: { run: 30749454692, url: "https://github.com/deephbz/rarebit/actions/runs/30749454692", nonce: "36d95631-a45b-4769-9e15-18129ce54e52", ref: "v0.1.0-alpha.4", head: "336565fb132404c02f5adbbe1be4d86c2206e035", attestation: "https://github.com/deephbz/rarebit/actions/runs/30749454692", attestationEndpoint: "https://registry.npmjs.org/-/npm/v1/attestations/@hypercarrier%2frarebit@0.1.0-alpha.4", slsaPredicateType: "https://slsa.dev/provenance/v1", workflow: ".github/workflows/publish.yml", workflowRef: "refs/tags/v0.1.0-alpha.4", resolvedCommit: "336565fb132404c02f5adbbe1be4d86c2206e035", invocation: "https://github.com/deephbz/rarebit/actions/runs/30749454692/attempts/1" } }
};
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const equal = (code, actual, expected) => { if (actual !== expected) fail(code, `${code}: expected ${expected}, got ${actual ?? "missing"}`); };
const checkObject = (actual, expected, prefix) => { for (const [key, value] of Object.entries(expected)) typeof value === "object" ? checkObject(actual?.[key], value, `${prefix}.${key}`) : equal("invalid-record", actual?.[key], value); };

export function validateRarebitCompatibilityRecord(record) {
  if (!record || typeof record !== "object" || record.schemaVersion !== 1 || record.component !== "rarebit") fail("invalid-record", "unsupported Rarebit compatibility record");
  checkObject(record.source, EXPECTED.source, "source");
  if (record.lineage?.sanitizedRootCommit !== "3620e9b0ddcdc4cb88771f8e16d5e88a3679480b" || record.lineage?.sanitizedRootTree !== "db7d388ec449af11c2054cf460931118f70c055b" || record.lineage?.sourceReceipt?.sha256 !== "6051fc6db27ee05641b5e06a5a2dc606c67b440138e6c9c154ac647c48965ede" || record.lineage?.releaseReceipt?.sha256 !== "5c4b877773a7f4f8d97b22c7eb0ad0b291ba9768e374b8a35bda911766a6d729") fail("invalid-record", "Rarebit source lineage receipt is invalid");
  checkObject(record.package, EXPECTED.package, "package");
  checkObject(record.publication, EXPECTED.publication, "publication");
  checkObject(record.verification, EXPECTED.verification, "verification");
  if (record.gitlink?.path !== CHILD || record.gitlink.mode !== "160000" || record.gitlink.commit !== EXPECTED.source.commit) fail("invalid-record", "gitlink does not bind the source commit");
  return record;
}

export function verifyRarebitComposition({ root = ROOT } = {}) {
  const recordFile = path.join(root, RECORD), schemaFile = path.join(root, SCHEMA);
  if (!existsSync(recordFile)) fail("missing-record", RECORD);
  if (!existsSync(schemaFile)) fail("missing-schema", SCHEMA);
  const record = JSON.parse(readFileSync(recordFile, "utf8"));
  validateSchema(record, JSON.parse(readFileSync(schemaFile, "utf8")));
  validateRarebitCompatibilityRecord(record);
  const exceptionPath = path.join(root, record.bootstrapException.path); const exceptionSchemaPath = path.join(root, "config/schemas/rarebit-alpha.1-bootstrap-exception.schema.json");
  if (!existsSync(exceptionPath) || !existsSync(exceptionSchemaPath)) fail("missing-exception", "missing bootstrap exception evidence");
  const exceptionText = readFileSync(exceptionPath); equal("exception-digest", createHash("sha256").update(exceptionText).digest("hex"), record.bootstrapException.sha256);
  const exception = JSON.parse(exceptionText); validateSchema(exception, JSON.parse(readFileSync(exceptionSchemaPath, "utf8"))); equal("exception-id", exception.id, record.bootstrapException.id);
  if (!existsSync(path.join(root, ".gitmodules"))) fail("gitmodules", "Rarebit HTTPS submodule declaration is missing");
  const modules = readFileSync(path.join(root, ".gitmodules"), "utf8"); if (!modules.includes(`[submodule \"${CHILD}\"]`) || !modules.includes(`path = ${CHILD}`) || !modules.includes("url = https://github.com/deephbz/rarebit.git")) fail("gitmodules", "Rarebit HTTPS submodule declaration is missing or wrong");
  const child = path.join(root, CHILD);
  if (!existsSync(child)) fail("missing-submodule", CHILD);
  if (!existsSync(path.join(child, ".git"))) fail("uninitialized-submodule", CHILD);
  const index = git(root, ["ls-files", "--stage", "--", CHILD]).split(/\s+/);
  equal("gitlink-mode", index[0], record.gitlink.mode); equal("gitlink-commit", index[1], record.gitlink.commit);
  equal("origin", git(child, ["remote", "get-url", "origin"]), record.source.repository);
  equal("revision", git(child, ["rev-parse", "HEAD"]), record.source.commit);
  equal("tree", git(child, ["rev-parse", "HEAD^{tree}"]), record.source.tree);
  if (git(child, ["status", "--porcelain", "--untracked-files=normal"])) fail("dirty-submodule", CHILD);
  const pkg = JSON.parse(readFileSync(path.join(child, "package.json"), "utf8"));
  equal("package-name", pkg.name, record.package.name); equal("package-version", pkg.version, record.package.version);
  equal("package-bin", pkg.bin?.rarebit, `./bin/${record.package.bin}.mjs`); equal("package-node", pkg.engines?.node, record.package.node);
  equal("peer-pi", pkg.peerDependencies?.["@earendil-works/pi-ai"], record.package.piPeer["@earendil-works/pi-ai"]);
  const childLock = JSON.parse(readFileSync(path.join(child, "package-lock.json"), "utf8"));
  equal("child-lock-name", childLock.name, record.package.name); equal("child-lock-version", childLock.version, record.package.version);
  const rootLock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  if (JSON.stringify(rootLock).includes("@hypercarrier/hc-rarebit")) fail("root-lock-alias", "legacy package alias");
  equal("root-lock-package", rootLock.packages?.["apps/timeline"]?.dependencies?.[record.package.name], record.package.version);
  equal("root-lock-link", rootLock.packages?.["node_modules/@hypercarrier/rarebit"]?.resolved, CHILD);
  const timeline = JSON.parse(readFileSync(path.join(root, "apps/timeline/package.json"), "utf8"));
  equal("timeline-dependency", timeline.dependencies?.[record.package.name], record.package.version);
  return { component: record.component, revision: record.source.commit, status: "verified" };
}

function isMainModule() { try { return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } }
if (isMainModule()) { try { console.log(JSON.stringify(verifyRarebitComposition())); } catch (error) { console.error(`Rarebit composition verification failed [${error.code ?? "error"}]: ${error.message}`); process.exitCode = 1; } }
