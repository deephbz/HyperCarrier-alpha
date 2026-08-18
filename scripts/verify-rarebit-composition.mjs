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
  source: { repository: "https://github.com/deephbz/rarebit.git", commit: "62608c5140d49118449003b0213e56a481d11caf", tree: "c2474e33c7529e4e6246175b6d0ee54c8221fb7b", tagObject: "1f13f4f2d0c658492e418e53c8361d2baf3dfcb0", tag: "v0.1.0-alpha.5", tagTarget: "62608c5140d49118449003b0213e56a481d11caf" },
  package: { name: "@hypercarrier/rarebit", version: "0.1.0-alpha.5", bin: "rarebit", node: ">=22", piPeer: { "@earendil-works/pi-ai": ">=0.83.0" } },
  publication: { sri: "sha512-h+NBXHEL22i1jKb4j1c4NLC6FcyamXSzUbkbJDCxhM3qtu24tKNbKfHK5ggV0pTs6E+w324H/vCNFBn4m7Ymfg==", sha1: "4eea88372a9f30c99491bdc4d89eddcaf01a7ef3", sha256: "68340be270582e2834b03da228c6066b1e9c971c40be46b9612defef76caf0fe", tarball: "https://registry.npmjs.org/@hypercarrier/rarebit/-/rarebit-0.1.0-alpha.5.tgz", size: 93242, unpackedSize: 405878, fileCount: 51, githubRelease: { id: 371245947, url: "https://github.com/deephbz/rarebit/releases/tag/v0.1.0-alpha.5", prerelease: true, latest: false }, signature: { key: "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U", value: "MEUCID/EkuqbT3hzQvu1m0/23o7qN8ALu9c1d7fabppOvY1NAiEApRe2PecZqbbDjqvFPWY+HGdllrTrqtps3mZI9bVXbSQ=" }, next: "0.1.0-alpha.5", latest: "0.1.0-alpha.4", bootstrapExceptionEvidence: "https://github.com/deephbz/rarebit/releases/tag/v0.1.0-alpha.2" },
  verification: { ci: { run: 31929298263, url: "https://github.com/deephbz/rarebit/actions/runs/31929298263", head: "62608c5140d49118449003b0213e56a481d11caf" }, dryRun: { run: 31929511826, url: "https://github.com/deephbz/rarebit/actions/runs/31929511826", nonce: "212baec3-faba-451c-a713-cddd1ecc6f7a", head: "62608c5140d49118449003b0213e56a481d11caf" }, publish: { run: 31930126874, url: "https://github.com/deephbz/rarebit/actions/runs/31930126874", nonce: "7d4dd74c-d6b8-45bc-b04c-b58e33af374c", ref: "v0.1.0-alpha.5", head: "62608c5140d49118449003b0213e56a481d11caf", attestation: "https://github.com/deephbz/rarebit/actions/runs/31930126874", attestationEndpoint: "https://registry.npmjs.org/-/npm/v1/attestations/@hypercarrier%2frarebit@0.1.0-alpha.5", slsaPredicateType: "https://slsa.dev/provenance/v1", workflow: ".github/workflows/publish.yml", workflowRef: "refs/tags/v0.1.0-alpha.5", resolvedCommit: "62608c5140d49118449003b0213e56a481d11caf", invocation: "https://github.com/deephbz/rarebit/actions/runs/31930126874/attempts/1" } }
};
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const equal = (code, actual, expected) => { if (actual !== expected) fail(code, `${code}: expected ${expected}, got ${actual ?? "missing"}`); };
const checkObject = (actual, expected, prefix) => { for (const [key, value] of Object.entries(expected)) typeof value === "object" ? checkObject(actual?.[key], value, `${prefix}.${key}`) : equal("invalid-record", actual?.[key], value); };

export function validateRarebitCompatibilityRecord(record) {
  if (!record || typeof record !== "object" || record.schemaVersion !== 1 || record.component !== "rarebit") fail("invalid-record", "unsupported Rarebit compatibility record");
  checkObject(record.source, EXPECTED.source, "source");
  if (record.lineage?.sanitizedRootCommit !== "3620e9b0ddcdc4cb88771f8e16d5e88a3679480b" || record.lineage?.sanitizedRootTree !== "db7d388ec449af11c2054cf460931118f70c055b" || record.lineage?.sourceReceipt?.blob !== "bae1ebcb283f0c29abb7f7c42ba69c3d65d8292e" || record.lineage?.sourceReceipt?.sha256 !== "684a8c47fd4f325d215d9976c5526e41c980b40d2a4029f4715e7cfea018de4f" || record.lineage?.releaseReceipt?.asset !== "release/v0.1.0-alpha.5-release-receipt.md" || record.lineage?.releaseReceipt?.sha256 !== "610bd3b76fb80700b025ada98a4c64d82cb953470d3623324bc993f0149abc5a") fail("invalid-record", "Rarebit source lineage receipt is invalid");
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
  equal("rarebit-dev-pi-version", rootLock.packages?.["packages/hc-rarebit/node_modules/@earendil-works/pi-coding-agent"]?.version, "0.84.2");
  const timeline = JSON.parse(readFileSync(path.join(root, "apps/timeline/package.json"), "utf8"));
  equal("timeline-dependency", timeline.dependencies?.[record.package.name], record.package.version);
  return { component: record.component, revision: record.source.commit, status: "verified" };
}

function isMainModule() { try { return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } }
if (isMainModule()) { try { console.log(JSON.stringify(verifyRarebitComposition())); } catch (error) { console.error(`Rarebit composition verification failed [${error.code ?? "error"}]: ${error.message}`); process.exitCode = 1; } }
