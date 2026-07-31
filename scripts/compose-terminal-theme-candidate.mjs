#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSchema } from "./lib/closed-json-schema.mjs";
import { verifyComposition } from "./verify-colorstack-composition.mjs";
import { RAREBIT_SUMMARY_PRESENTATION } from "../packages/hc-rarebit/src/rarebit-visual-language.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BINDING = "config/colorstack-rarebit-herdr-binding.json";
const BINDING_SCHEMA = "config/schemas/colorstack-rarebit-herdr-binding.schema.json";
const RECEIPT_SCHEMA = "config/schemas/terminal-theme-composition-receipt.schema.json";
const TEMPLATE_DEFAULTS = Object.freeze({
  herdr: Object.freeze(["release/public/overlay/config/herdr.example.toml", "config/herdr.example.toml"]),
  ghostty: Object.freeze(["release/public/overlay/config/ghostty.example.config", "config/ghostty.example.config"]),
});
const HEX = /^#[0-9a-fA-F]{6}$/;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function json(file, code) { try { return JSON.parse(readFileSync(file, "utf8")); } catch (error) { fail(code, `invalid JSON at ${file}: ${error.message}`); } }
function git(root, args) { try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch (error) { fail("git", error.stderr?.trim() || error.message); } }
function normal(file) { return existsSync(file) && !lstatSync(file).isSymbolicLink(); }
function lstat(file) { try { return lstatSync(file); } catch { return undefined; } }
function template(root, target, explicit) {
  if (explicit !== undefined) { const file = path.resolve(root, explicit); if (!normal(file)) fail("template", `explicit ${target} behavior template is missing or a symlink`); return file; }
  const matches = TEMPLATE_DEFAULTS[target].map((relative) => path.join(root, relative)).filter(normal);
  if (matches.length !== 1) fail("template", `${target} behavior template defaults are ${matches.length === 0 ? "missing" : "ambiguous"}`);
  return matches[0];
}
export function resolveTemplates(root, { herdrTemplatePath, ghosttyTemplatePath } = {}) { return { herdr: template(root, "herdr", herdrTemplatePath), ghostty: template(root, "ghostty", ghosttyTemplatePath) }; }
function freshOutput(root, output) {
  if (!output) fail("output-root", "--output-root is required");
  const requested = path.resolve(root, output), requestedStat = lstat(requested);
  if (requestedStat) fail("output-root", "output root must not exist or be a symlink");
  const directParent = path.dirname(requested), parentStat = lstat(directParent);
  if (!parentStat || !parentStat.isDirectory() || parentStat.isSymbolicLink()) fail("output-root", "output root parent must be an existing non-symlink directory");
  const candidate = path.join(realpathSync(directParent), path.basename(requested));
  if (lstat(candidate)) fail("output-root", "canonical output root must not exist or be a symlink");
  const source = realpathSync(root);
  if (candidate === source || candidate.startsWith(`${source}${path.sep}`)) fail("output-root", "output root may not be inside the HyperCarrier source checkout");
  return candidate;
}
function binding(root, bindingPath = BINDING) {
  const file = path.resolve(root, bindingPath), schema = path.join(root, BINDING_SCHEMA);
  if (!normal(file) || !normal(schema)) fail("binding", "missing closed Colorstack Rarebit binding or schema");
  const value = json(file, "binding"), shape = json(schema, "binding-schema");
  try { validateSchema(value, shape); } catch (error) { fail("binding", error.message); }
  const tones = Object.values(RAREBIT_SUMMARY_PRESENTATION).map(({ tone }) => tone);
  if (JSON.stringify([...new Set(tones)].sort()) !== JSON.stringify(Object.keys(value.summaryTones).sort())) fail("binding", "binding must cover exactly the executable Rarebit Summary tones");
  return { value, file };
}
function run(executable, args, code, { env = {}, cwd } = {}) { try { return execFileSync(executable, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env }, cwd }); } catch (error) { fail(code, error.stderr?.trim() || error.message); } }
function generatedManifest(sourceRoot, candidateRoot, record, selection, python) {
  const colorstack = path.join(sourceRoot, "config/colorstack"), output = path.join(candidateRoot, "colorstack");
  run(python, [path.join(colorstack, record.generator.path), selection.scheme, "--ink", String(selection.inkContrast), "--output-root", output, ...selection.outputs.flatMap((key) => ["--key", key])], "generator");
  const manifestPath = path.join(output, record.generator.manifest); if (!normal(manifestPath)) fail("manifest", "generator did not write its manifest");
  const manifest = json(manifestPath, "manifest");
  if (manifest.schema_version !== record.generator.manifestSchemaVersion || manifest.generator !== record.component || manifest.scheme !== selection.scheme || manifest.ink_contrast !== selection.inkContrast) fail("manifest", "generated manifest identity drift");
  if (JSON.stringify(Object.keys(manifest.outputs ?? {}).sort()) !== JSON.stringify([...selection.outputs].sort())) fail("manifest", "generated manifest output set drift");
  for (const key of selection.outputs) { const item = manifest.outputs[key], file = path.join(output, item?.path ?? ""); if (!item || !/^[0-9a-f]{64}$/.test(item.sha256) || !normal(file) || sha256(readFileSync(file)) !== item.sha256) fail("digest", `generated output digest mismatch: ${key}`); }
  return { manifest, output };
}
function herdrRoles(text) {
  const start = text.indexOf("[theme.custom]\n"); if (start < 0) fail("herdr", "generated Herdr payload has no [theme.custom]");
  const after = text.slice(start + "[theme.custom]\n".length), section = after.slice(0, after.search(/^\[/m) < 0 ? after.length : after.search(/^\[/m));
  const roles = {}; for (const line of section.split("\n")) { const match = line.match(/^([a-z0-9_]+)\s*=\s*"(#[0-9a-fA-F]{6})"\s*$/); if (match) { if (roles[match[1]]) fail("herdr", `duplicate generated Herdr role: ${match[1]}`); roles[match[1]] = match[2]; } }
  return roles;
}
export function injectRarebitTokens(template, tokenColors) {
  let count = 0;
  const rendered = template.replace(/\{ token = "(\$rarebit_[a-z_]+)"([^}]*) \}/g, (whole, token, rest) => {
    if (token === "$rarebit_state") return whole;
    if (!(token in tokenColors)) return whole;
    if (/\bfg\s*=/.test(rest)) fail("template", `template already colors ${token}`);
    count += 1; return `{ token = "${token}", fg = "${tokenColors[token]}"${rest} }`;
  });
  if (count !== Object.keys(tokenColors).length || /\$rarebit_state"[^}]*\bfg\s*=/.test(rendered)) fail("template", "Rarebit token template drift");
  return rendered;
}
function receipt(root, candidate, verified, bound, generated, templates, validators) {
  const candidatePaths = { herdr: "config/herdr/config.toml", ghostty: "config/ghostty/config", ghosttyTheme: "config/ghostty/themes/colorstack", colorstack: "colorstack" };
  const outputDigests = Object.fromEntries(Object.entries(generated.manifest.outputs).map(([key, item]) => [key, item.sha256]));
  const candidateDigests = Object.fromEntries(Object.entries(candidatePaths).filter(([key]) => key !== "colorstack").map(([key, relative]) => [key, sha256(readFileSync(path.join(candidate, relative)))]));
  return { schemaVersion: 1, component: "hc-terminal-theme-composition", source: { hypercarrier: { commit: git(root, ["rev-parse", "HEAD"]), tree: git(root, ["rev-parse", "HEAD^{tree}"]) }, colorstack: verified.record.source }, selectionSha256: sha256(readFileSync(path.join(root, "config/colorstack-selection.json"))), bindingSha256: sha256(readFileSync(bound.file)), templates: Object.fromEntries(Object.entries(templates).map(([key, file]) => [key, { path: path.relative(root, file), sha256: sha256(readFileSync(file)) }])), childManifestSha256: sha256(readFileSync(path.join(generated.output, ".colorstack-manifest.json"))), outputDigests, candidatePaths, candidateDigests, validators };
}
function validateReceipt(root, value) { const file = path.join(root, RECEIPT_SCHEMA); if (!normal(file)) fail("receipt-schema", "missing composition receipt schema"); try { validateSchema(value, json(file, "receipt-schema")); } catch (error) { fail("receipt-schema", error.message); } return value; }
export function composeCandidate({ root = ROOT, outputRoot, debug = false, python = "python3", herdr = "herdr", ghostty = "ghostty", bindingPath = BINDING, herdrTemplatePath, ghosttyTemplatePath, sourceStatus = () => git(root, ["status", "--porcelain", "--untracked-files=normal"]), writeReceipt = writeFileSync, publish = renameSync } = {}) {
  if (sourceStatus()) fail("dirty-source", "HyperCarrier source worktree is dirty; commit source before composing a candidate");
  const destination = freshOutput(root, outputRoot); const parent = path.dirname(destination); if (!normal(parent)) fail("output-root", `output parent does not exist: ${parent}`);
  const staging = mkdtempSync(path.join(parent, `.${path.basename(destination)}.colorstack-`));
  try {
    const verified = verifyComposition({ root, debug: true }); const bound = binding(root, bindingPath); const generated = generatedManifest(root, staging, verified.record, verified.selection, python);
    const { herdr: herdrTemplate, ghostty: ghosttyTemplate } = resolveTemplates(root, { herdrTemplatePath, ghosttyTemplatePath });
    const roles = herdrRoles(readFileSync(path.join(generated.output, "outputs/herdr"), "utf8")); const colors = {};
    for (const [token, tone] of Object.entries(bound.value.tokens)) { const role = bound.value.summaryTones[tone]; if (!HEX.test(roles[role] ?? "")) fail("herdr", `generated Herdr role is missing or not strict hex: ${role}`); colors[token] = roles[role]; }
    const herdrConfig = `${injectRarebitTokens(readFileSync(herdrTemplate, "utf8"), colors)}\n# HC Colorstack generated Herdr REGION: BEGIN\n${readFileSync(path.join(generated.output, "outputs/herdr"), "utf8")}# HC Colorstack generated Herdr REGION: END\n`;
    const herdrPath = path.join(staging, "config/herdr/config.toml"), ghosttyPath = path.join(staging, "config/ghostty/config"), themePath = path.join(staging, "config/ghostty/themes/colorstack"); mkdirSync(path.dirname(herdrPath), { recursive: true }); mkdirSync(path.dirname(themePath), { recursive: true }); writeFileSync(herdrPath, herdrConfig); copyFileSync(ghosttyTemplate, ghosttyPath); copyFileSync(path.join(generated.output, "outputs/ghostty-theme"), themePath); writeFileSync(ghosttyPath, `${readFileSync(ghosttyPath, "utf8")}\nconfig-file = themes/colorstack\n`);
    const validators = { herdr: { executable: herdr, arguments: ["config", "check"], environment: { HERDR_CONFIG_PATH: "config/herdr/config.toml" }, result: run(herdr, ["config", "check"], "herdr-validation", { env: { HERDR_CONFIG_PATH: "config/herdr/config.toml" }, cwd: staging }).trim(), exitCode: 0, binary: { executable: herdr, arguments: ["--version"], result: run(herdr, ["--version"], "herdr-identity", { cwd: staging }).trim() }, status: "passed" }, ghostty: { executable: ghostty, arguments: ["+validate-config", "--config-file=config/ghostty/config"], result: run(ghostty, ["+validate-config", "--config-file=config/ghostty/config"], "ghostty-validation", { cwd: staging }).trim(), exitCode: 0, binary: { executable: ghostty, arguments: ["--version"], result: run(ghostty, ["--version"], "ghostty-identity", { cwd: staging }).trim() }, status: "passed" } };
    const data = validateReceipt(root, receipt(root, staging, verified, bound, generated, { herdr: herdrTemplate, ghostty: ghosttyTemplate }, validators)); writeReceipt(path.join(staging, "composition-receipt.json"), `${JSON.stringify(data, null, 2)}\n`); publish(staging, destination);
    return debug ? { status: "composed", outputRoot: destination, receipt: data, trace: { verification: verified.trace, generated: generated.manifest, tokenColors: colors } } : { status: "composed", outputRoot: destination, receipt: "composition-receipt.json" };
  } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
}
function main() { const args = process.argv.slice(2); const value = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; }; const debug = args.includes("--debug"); try { console.log(JSON.stringify(composeCandidate({ outputRoot: value("--output-root"), debug, python: value("--python-bin") ?? "python3", herdr: value("--herdr-bin") ?? "herdr", ghostty: value("--ghostty-bin") ?? "ghostty" }), null, debug ? 2 : 0)); } catch (error) { console.error(`Terminal theme composition failed [${error.code ?? "error"}]: ${error.message}; no candidate was produced and color-free live config remains unchanged`); process.exitCode = 1; } }
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
