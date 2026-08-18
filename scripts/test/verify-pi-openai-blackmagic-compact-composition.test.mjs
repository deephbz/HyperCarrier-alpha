import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { validateCompatibilityRecord, verifyComposition } from "../verify-pi-openai-blackmagic-compact-composition.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const recordPath = path.join(root, "config/pi-openai-blackmagic-compact-compatibility.json");
const record = () => JSON.parse(readFileSync(recordPath, "utf8"));

test("verifies the rc.8 branch-provenance composition without a Git tag or release", () => {
  const result = verifyComposition({ root });
  assert.deepEqual(result, { component: "pi-openai-blackmagic-compact", revision: "a8af309fcb9219185c12ce1e49393e0da8c72853", status: "verified" });
});

for (const [name, mutate] of [
  ["rc.8 source", (value) => { value.source.commit = "0".repeat(40); }],
  ["absent Git tag", (value) => { value.source.gitTag.state = "present"; }],
  ["rc.8 package", (value) => { value.package.version = "0.1.0-rc.7"; }],
  ["npm integrity", (value) => { value.publication.npmIntegrity = "sha512-wrong"; }],
  ["tarball SHA-256", (value) => { value.publication.tarballSha256 = "0".repeat(64); }],
  ["absent GitHub Release", (value) => { value.publication.githubRelease.state = "present"; }],
  ["main-branch SLSA provenance", (value) => { value.publication.provenance.workflowRef = "refs/tags/v0.1.0-rc.8"; }],
  ["minimum peer floor", (value) => { value.pi.peerRanges["@earendil-works/pi-ai"] = "0.83.0"; }],
  ["publication receipt", (value) => { value.childVerification.receipts = value.childVerification.receipts.filter(({ name: receipt }) => receipt !== "trusted-publisher-publication"); }],
]) {
  test(`rejects ${name} drift`, () => {
    const value = record(); mutate(value);
    assert.throws(() => validateCompatibilityRecord(value), (error) => error.code === "invalid-record");
  });
}
