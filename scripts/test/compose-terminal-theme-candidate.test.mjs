import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { composeCandidate, injectRarebitTokens, resolveTemplates } from "../compose-terminal-theme-candidate.mjs";
import { validateSchema } from "../lib/closed-json-schema.mjs";
import { RAREBIT_SUMMARY_PRESENTATION } from "../../packages/hc-rarebit/src/rarebit-visual-language.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
function sandbox() { const dir = mkdtempSync(path.join(realpathSync(os.tmpdir()), "composer-candidate-test-")); return { dir, out: path.join(dir, "candidate"), close: () => rmSync(dir, { recursive: true, force: true }) }; }
function fake(dir, name, { fail = false } = {}) { const file = path.join(dir, name); writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${name}-1.0; exit 0; fi\n${fail ? "echo rejected >&2; exit 9" : `echo ${name}-ok`}\n`); chmodSync(file, 0o755); return file; }
function compose(box, options = {}) { return composeCandidate({ root, outputRoot: box.out, herdr: fake(box.dir, "herdr"), ghostty: fake(box.dir, "ghostty"), ...options }); }

test("composes a verified candidate with exact token injections, receipt digests, and Ghostty include last", () => {
  const box = sandbox(); try {
    const result = compose(box); assert.deepEqual(result, { status: "composed", outputRoot: box.out, receipt: "composition-receipt.json" });
    const receipt = JSON.parse(readFileSync(path.join(box.out, "composition-receipt.json"))), templates = resolveTemplates(root); validateSchema(receipt, JSON.parse(readFileSync(path.join(root, "config/schemas/terminal-theme-composition-receipt.schema.json")))); assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.templates.herdr.path, path.relative(root, templates.herdr)); assert.equal(receipt.templates.ghostty.path, path.relative(root, templates.ghostty)); assert.equal(receipt.validators.herdr.binary.result, "herdr-1.0"); assert.equal(receipt.validators.ghostty.binary.result, "ghostty-1.0"); assert.equal(receipt.validators.herdr.executable, path.join(box.dir, "herdr")); assert.deepEqual(receipt.validators.ghostty.arguments, ["+validate-config", "--config-file=config/ghostty/config"]); assert.equal(Object.keys(receipt.outputDigests).length, 11); assert.equal(receipt.candidateDigests.herdr, sha256(path.join(box.out, receipt.candidatePaths.herdr))); assert.equal(receipt.candidateDigests.ghostty, sha256(path.join(box.out, receipt.candidatePaths.ghostty))); assert.equal(receipt.candidateDigests.ghosttyTheme, sha256(path.join(box.out, receipt.candidatePaths.ghosttyTheme)));
    const herdr = readFileSync(path.join(box.out, "config/herdr/config.toml"), "utf8"); assert.match(herdr, /\$rarebit_attention", fg = "#[0-9a-f]{6}", bold = true/); assert.match(herdr, /\$rarebit_state_muted", fg = "#[0-9a-f]{6}", dim = true/); assert.doesNotMatch(herdr, /\$rarebit_state"[^}]*fg/); assert.match(herdr, /HC Colorstack generated Herdr REGION: BEGIN/);
    const ghostty = readFileSync(path.join(box.out, "config/ghostty/config"), "utf8"); assert.equal(ghostty.trimEnd().split("\n").at(-1), "config-file = themes/colorstack"); assert.equal(readFileSync(path.join(box.out, "colorstack/outputs/ghostty-theme"), "utf8"), readFileSync(path.join(box.out, "config/ghostty/themes/colorstack"), "utf8"));
  } finally { box.close(); }
});

test("resolves exactly one private or projected template layout and keeps explicit overrides fail-closed", () => {
  const fixture = mkdtempSync(path.join(realpathSync(os.tmpdir()), "composer-template-layout-")); try {
    mkdirSync(path.join(fixture, "config"), { recursive: true }); writeFileSync(path.join(fixture, "config/herdr.example.toml"), "projected herdr\n"); writeFileSync(path.join(fixture, "config/ghostty.example.config"), "projected ghostty\n"); assert.deepEqual(Object.fromEntries(Object.entries(resolveTemplates(fixture)).map(([key, file]) => [key, path.relative(fixture, file)])), { herdr: "config/herdr.example.toml", ghostty: "config/ghostty.example.config" });
    assert.throws(() => resolveTemplates(fixture, { herdrTemplatePath: "config/missing.toml" }), /explicit herdr behavior template/); mkdirSync(path.join(fixture, "release/public/overlay/config"), { recursive: true }); writeFileSync(path.join(fixture, "release/public/overlay/config/herdr.example.toml"), "private herdr\n"); assert.throws(() => resolveTemplates(fixture), /herdr behavior template defaults are ambiguous/); rmSync(path.join(fixture, "config/herdr.example.toml")); rmSync(path.join(fixture, "config/ghostty.example.config")); assert.throws(() => resolveTemplates(fixture), /ghostty behavior template defaults are missing/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("binding covers exactly executable Summary tones and injection does not alter marks or labels", () => {
  const binding = JSON.parse(readFileSync(path.join(root, "config/colorstack-rarebit-herdr-binding.json"))); assert.deepEqual(Object.keys(binding.summaryTones).sort(), [...new Set(Object.values(RAREBIT_SUMMARY_PRESENTATION).map(({ tone }) => tone))].sort());
  const before = JSON.parse(JSON.stringify(RAREBIT_SUMMARY_PRESENTATION)); injectRarebitTokens('{ token = "$rarebit_attention", bold = true } { token = "$rarebit_state" }', { "$rarebit_attention": "#abcdef" }); assert.deepEqual(RAREBIT_SUMMARY_PRESENTATION, before);
});

test("canonicalizes a platform temporary alias and permits a symlink ancestor below a real direct parent", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "composer-temp-alias-")); try {
    const requested = path.join(temp, "candidate"), result = composeCandidate({ root, outputRoot: requested, herdr: fake(temp, "herdr"), ghostty: fake(temp, "ghostty"), sourceStatus: () => "" }); assert.equal(result.outputRoot, path.join(realpathSync(temp), "candidate")); assert.ok(existsSync(result.outputRoot));
    const target = path.join(temp, "target"); mkdirSync(path.join(target, "direct"), { recursive: true }); const alias = path.join(temp, "alias"); symlinkSync(target, alias); const aliasResult = composeCandidate({ root, outputRoot: path.join(alias, "direct", "candidate"), herdr: fake(temp, "herdr-two"), ghostty: fake(temp, "ghostty-two"), sourceStatus: () => "" }); assert.equal(aliasResult.outputRoot, path.join(realpathSync(target), "direct", "candidate"));
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("refuses existing, direct-symlink, and canonical-source output routes without a candidate", () => {
  const box = sandbox(); try {
    writeFileSync(box.out, "existing"); assert.throws(() => compose(box), /output root must not exist/); rmSync(box.out);
    symlinkSync(realpathSync(os.tmpdir()), box.out); assert.throws(() => compose(box), /output root must not exist/); rmSync(box.out);
    const realParent = path.join(box.dir, "real-parent"), linkedParent = path.join(box.dir, "linked-parent"); mkdirSync(realParent); symlinkSync(realParent, linkedParent); assert.throws(() => composeCandidate({ root, outputRoot: path.join(linkedParent, "candidate"), sourceStatus: () => "" }), /parent must be an existing non-symlink directory/); assert.equal(existsSync(path.join(realParent, "candidate")), false);
    const sourceAlias = path.join(box.dir, "source-alias"); symlinkSync(root, sourceAlias); assert.throws(() => composeCandidate({ root, outputRoot: path.join(sourceAlias, "scripts", "candidate"), sourceStatus: () => "" }), /inside the HyperCarrier source/);
  } finally { box.close(); }
});

test("dirty source, validator, generator, receipt-write, and publish failures leave neither output nor staging", () => {
  const cases = [
    (box) => compose(box, { sourceStatus: () => " M config/binding" }),
    (box) => compose(box, { bindingPath: "config/missing-binding.json" }),
    (box) => compose(box, { herdrTemplatePath: "release/public/overlay/config/missing.toml" }),
    (box) => compose(box, { herdr: fake(box.dir, "bad-herdr", { fail: true }) }),
    (box) => compose(box, { python: "/usr/bin/false" }),
    (box) => compose(box, { writeReceipt: () => { throw new Error("receipt failure"); } }),
    (box) => compose(box, { publish: () => { throw new Error("rename failure"); } }),
  ];
  for (const run of cases) { const box = sandbox(); try { assert.throws(() => run(box)); assert.equal(existsSync(box.out), false); assert.equal(readdirSync(box.dir).some((entry) => entry.startsWith(".candidate.colorstack-")), false); } finally { box.close(); } }
});

test("generated output hygiene is ignored and no generated bundle is tracked", () => {
  assert.doesNotThrow(() => execFileSync("git", ["check-ignore", "-q", ".colorstack-output/candidate"], { cwd: root }));
  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }); assert.doesNotMatch(tracked, /^\.colorstack-output\//m);
});

test("root package exposes the validation-preserving compose command", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"))); assert.equal(pkg.scripts["compose:terminal-theme"], "node scripts/compose-terminal-theme-candidate.mjs");
});

test("CLI default is compact JSON through a platform temp alias and debug carries trace", () => {
  const script = path.join(root, "scripts/compose-terminal-theme-candidate.mjs"), box = (() => { const dir = mkdtempSync(path.join(os.tmpdir(), "composer-cli-alias-")); return { dir, out: path.join(dir, "candidate"), close: () => rmSync(dir, { recursive: true, force: true }) }; })(); try {
    const herdr = fake(box.dir, "herdr"), ghostty = fake(box.dir, "ghostty"); const plain = execFileSync(process.execPath, [script, "--output-root", box.out, "--herdr-bin", herdr, "--ghostty-bin", ghostty], { cwd: root, encoding: "utf8" }); assert.deepEqual(JSON.parse(plain), { status: "composed", outputRoot: path.join(realpathSync(box.dir), "candidate"), receipt: "composition-receipt.json" }); assert.doesNotMatch(plain, /\n  /);
    const debugBox = sandbox(); try { const result = JSON.parse(execFileSync(process.execPath, [script, "--output-root", debugBox.out, "--herdr-bin", fake(debugBox.dir, "herdr"), "--ghostty-bin", fake(debugBox.dir, "ghostty"), "--debug"], { cwd: root, encoding: "utf8" })); assert.ok(result.trace.generated.outputs.herdr); assert.ok(result.trace.tokenColors.$rarebit_error); } finally { debugBox.close(); }
  } finally { box.close(); }
});
