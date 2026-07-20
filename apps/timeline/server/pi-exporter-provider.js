import { createHash } from "node:crypto";
import { constants, accessSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BUNDLED_PI_EXPORTER_MANIFEST = fileURLToPath(
  new URL("../../../vendor/pi-exporter/provider.json", import.meta.url),
);

function nonempty(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be nonempty`);
  return value.trim();
}

export function resolveExecutablePath(value, label = "native exporter executable") {
  const declared = nonempty(value, label);
  if (!isAbsolute(declared)) throw new Error(`${label} must be an absolute path`);
  const executable = realpathSync(declared);
  if (!statSync(executable).isFile()) throw new Error(`${label} must resolve to a file`);
  accessSync(executable, constants.X_OK);
  return executable;
}

function digest(path, algorithm, encoding) {
  return createHash(algorithm).update(readFileSync(path)).digest(encoding);
}

function readManifest(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1) throw new Error("Unsupported Pi exporter provider manifest");
  for (const [value, label] of [
    [manifest.providerRevision, "provider revision"],
    [manifest.capability, "provider capability"],
    [manifest.package?.name, "provider package name"],
    [manifest.package?.version, "provider package version"],
    [manifest.package?.artifact, "provider artifact"],
    [manifest.package?.executable, "provider executable"],
    [manifest.package?.sha256, "provider artifact sha256"],
    [manifest.package?.integrity, "provider artifact integrity"],
    [manifest.package?.installedPayload?.path, "provider installed payload"],
    [manifest.package?.installedPayload?.sha256, "provider installed payload sha256"],
    [manifest.source?.baseRevision, "provider base revision"],
    [manifest.source?.patchRevision, "provider patch revision"],
    [manifest.source?.patchFile, "provider patch file"],
    [manifest.source?.patchSha256, "provider patch sha256"],
  ])
    nonempty(value, label);
  return manifest;
}

export function resolveBundledPiExporter({
  manifestPath = BUNDLED_PI_EXPORTER_MANIFEST,
  resolvePackage = (name) => fileURLToPath(import.meta.resolve(name)),
} = {}) {
  const canonicalManifest = realpathSync(manifestPath);
  const manifest = readManifest(canonicalManifest);
  const providerRoot = dirname(canonicalManifest);
  const patch = resolve(providerRoot, manifest.source.patchFile);
  if (dirname(patch) !== providerRoot)
    throw new Error("Pi exporter provider patch must stay inside its provider directory");
  if (digest(patch, "sha256", "hex") !== manifest.source.patchSha256)
    throw new Error("Pi exporter provider patch SHA-256 does not match its manifest");
  const artifact = resolve(providerRoot, manifest.package.artifact);
  if (dirname(artifact) !== providerRoot)
    throw new Error("Pi exporter provider artifact must stay inside its provider directory");
  if (statSync(artifact).size !== manifest.package.size)
    throw new Error("Pi exporter provider artifact size does not match its manifest");
  if (digest(artifact, "sha256", "hex") !== manifest.package.sha256)
    throw new Error("Pi exporter provider artifact SHA-256 does not match its manifest");
  if (`sha512-${digest(artifact, "sha512", "base64")}` !== manifest.package.integrity)
    throw new Error("Pi exporter provider artifact integrity does not match its manifest");

  const packageEntry = realpathSync(resolvePackage(manifest.package.name));
  const packageRoot = resolve(dirname(packageEntry), "..");
  const packageMetadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (
    packageMetadata.name !== manifest.package.name ||
    packageMetadata.version !== manifest.package.version
  )
    throw new Error("Installed Pi exporter package does not match its provider manifest");
  const installedPayload = resolve(packageRoot, manifest.package.installedPayload.path);
  const payloadRelative = relative(packageRoot, installedPayload);
  if (payloadRelative.startsWith("..") || isAbsolute(payloadRelative))
    throw new Error("Installed Pi exporter payload must stay inside its package directory");
  if (digest(installedPayload, "sha256", "hex") !== manifest.package.installedPayload.sha256)
    throw new Error("Installed Pi exporter payload SHA-256 does not match its provider manifest");
  const executable = resolveExecutablePath(join(packageRoot, manifest.package.executable));

  return {
    executable,
    revision: manifest.providerRevision,
    capability: manifest.capability,
    provider: {
      kind: "bundled-package",
      package: `${manifest.package.name}@${manifest.package.version}`,
      baseRevision: manifest.source.baseRevision,
      patchRevision: manifest.source.patchRevision,
      artifactSha256: manifest.package.sha256,
    },
  };
}
