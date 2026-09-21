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
  source: { repository: "https://github.com/deephbz/rarebit.git", commit: "7f70563c11c0b28463ef08e290baba59d781a677", tree: "0a0d9c1da6126b5cc3716fe9bc46a9759e5e64ed", tagObject: "177c15e000d601e18770593b8269896a79de9e67", tag: "v0.1.0-alpha.6", tagTarget: "7f70563c11c0b28463ef08e290baba59d781a677" },
  package: { name: "@hypercarrier/rarebit", version: "0.1.0-alpha.6", bin: "rarebit", additionalBins: ["piq"], node: ">=22", piPeer: { "@earendil-works/pi-ai": ">=0.83.0" }, piPeerOptional: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"] },
  publication: { sri: "sha512-qCbbJAOgx0i5M28n4eeOCMkpPCrMwtU4kR/9Uf3w1TQTonA1S+YG8pYwM7PzsYTkuDp55J+xQtSZ52WtWhfxZg==", sha1: "72003a4e2f3a5bc0f3674bd9d3d905a6f42aee1b", sha256: "96ac86dc4f35e03406e8a42abb266b88592417ea23d6f522d1bd6c4e473baaeb", tarball: "https://registry.npmjs.org/@hypercarrier/rarebit/-/rarebit-0.1.0-alpha.6.tgz", size: 117185, unpackedSize: 503615, fileCount: 60, githubRelease: { id: 392815542, url: "https://github.com/deephbz/rarebit/releases/tag/v0.1.0-alpha.6", prerelease: true, latest: false }, signature: { key: "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U", value: "MEUCIGVcpcGSPpPljaFuhZ4QSGvetB6KpgNtvwAk2wgFIqHRAiEA3wfIxTaFm/Uz2RWbFwiQBq5TzAWsaLzTerEMceTyx6g=" }, next: "0.1.0-alpha.6", latest: "0.1.0-alpha.4", bootstrapExceptionEvidence: "https://github.com/deephbz/rarebit/releases/tag/v0.1.0-alpha.2" },
  verification: { ci: { run: 35579125370, url: "https://github.com/deephbz/rarebit/actions/runs/35579125370", head: "7de6326a5c1d1f9a4c01cbcc28e16bcef7cc2566" }, dryRun: { run: 35579443036, url: "https://github.com/deephbz/rarebit/actions/runs/35579443036", nonce: "0a1ef824-6f68-4fdd-80d7-862651df5ed7", head: "7de6326a5c1d1f9a4c01cbcc28e16bcef7cc2566" }, publish: { run: 35579627947, url: "https://github.com/deephbz/rarebit/actions/runs/35579627947", nonce: "475f6ef8-e963-483a-8f72-8eb5f3c8dbc7", ref: "v0.1.0-alpha.6", head: "7de6326a5c1d1f9a4c01cbcc28e16bcef7cc2566", attestation: "https://github.com/deephbz/rarebit/actions/runs/35579627947", attestationEndpoint: "https://registry.npmjs.org/-/npm/v1/attestations/@hypercarrier%2frarebit@0.1.0-alpha.6", slsaPredicateType: "https://slsa.dev/provenance/v1", workflow: ".github/workflows/publish.yml", workflowRef: "refs/tags/v0.1.0-alpha.6", resolvedCommit: "7de6326a5c1d1f9a4c01cbcc28e16bcef7cc2566", invocation: "https://github.com/deephbz/rarebit/actions/runs/35579627947/attempts/1" } },
  metadataRepair: { originalCommit: "7de6326a5c1d1f9a4c01cbcc28e16bcef7cc2566", repairedCommit: "7f70563c11c0b28463ef08e290baba59d781a677", originalTagObject: "6aa4dd7b000a7e5a7e7e65ece76b36306c5d4aed", repairedTagObject: "177c15e000d601e18770593b8269896a79de9e67", commonTree: "0a0d9c1da6126b5cc3716fe9bc46a9759e5e64ed", reason: "privacy-history-repair", receiptUrl: "https://github.com/deephbz/rarebit/releases/download/v0.1.0-alpha.6/rarebit-alpha6-final-receipt.json", receiptSha256: "ae6abc116be3a9cf8f362ad14d88572141c4e97adccfb0b097ddfb73104cddaf" }
};
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const equal = (code, actual, expected) => { if (actual !== expected) fail(code, `${code}: expected ${expected}, got ${actual ?? "missing"}`); };
const checkObject = (actual, expected, prefix) => { for (const [key, value] of Object.entries(expected)) typeof value === "object" ? checkObject(actual?.[key], value, `${prefix}.${key}`) : equal("invalid-record", actual?.[key], value); };
function validateOptionalPackageContract(recordPackage, childPackage, childRoot) { const additionalBins = recordPackage.additionalBins; if (additionalBins !== undefined && (additionalBins.length !== 1 || additionalBins[0] !== "piq")) fail("additional-bin", "additionalBins must declare only piq"); const optionalPeers = recordPackage.piPeerOptional; if (optionalPeers !== undefined && (optionalPeers.length !== 2 || new Set(optionalPeers).size !== 2 || !optionalPeers.includes("@earendil-works/pi-ai") || !optionalPeers.includes("@earendil-works/pi-coding-agent"))) fail("optional-peer", "piPeerOptional must declare both approved Pi peers"); for (const name of additionalBins ?? []) { const target = childPackage.bin?.[name]; if (typeof target !== "string" || !target.startsWith("./") || !existsSync(path.resolve(childRoot, target))) fail("additional-bin", `declared bin path is missing: ${name}`); } for (const name of optionalPeers ?? []) if (typeof childPackage.peerDependencies?.[name] !== "string" || childPackage.peerDependenciesMeta?.[name]?.optional !== true) fail("optional-peer", `optional Pi peer metadata is missing: ${name}`); }

export function validateRarebitCompatibilityRecord(record) {
  if (!record || typeof record !== "object" || record.schemaVersion !== 1 || record.component !== "rarebit") fail("invalid-record", "unsupported Rarebit compatibility record");
  checkObject(record.source, EXPECTED.source, "source");
  if (record.lineage?.sanitizedRootCommit !== "3620e9b0ddcdc4cb88771f8e16d5e88a3679480b" || record.lineage?.sanitizedRootTree !== "db7d388ec449af11c2054cf460931118f70c055b" || record.lineage?.sourceReceipt?.blob !== "bae1ebcb283f0c29abb7f7c42ba69c3d65d8292e" || record.lineage?.sourceReceipt?.sha256 !== "684a8c47fd4f325d215d9976c5526e41c980b40d2a4029f4715e7cfea018de4f" || record.lineage?.releaseReceipt?.asset !== "release/v0.1.0-alpha.5-release-receipt.md" || record.lineage?.releaseReceipt?.sha256 !== "610bd3b76fb80700b025ada98a4c64d82cb953470d3623324bc993f0149abc5a") fail("invalid-record", "Rarebit source lineage receipt is invalid");
  checkObject(record.package, EXPECTED.package, "package");
  checkObject(record.publication, EXPECTED.publication, "publication");
  checkObject(record.verification, EXPECTED.verification, "verification");
  checkObject(record.metadataRepair, EXPECTED.metadataRepair, "metadataRepair");
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
  equal("peer-pi", pkg.peerDependencies?.["@earendil-works/pi-ai"], record.package.piPeer["@earendil-works/pi-ai"]); validateOptionalPackageContract(record.package, pkg, child);
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
