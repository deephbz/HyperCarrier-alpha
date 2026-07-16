import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  stat,
  unlink,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_RAREBIT_ROOT = join(homedir(), ".pi", "agent", "rarebit");
export const DEFAULT_RAREBIT_SESSION_ROOT = join(
  homedir(),
  ".pi",
  "agent",
  "sessions",
);
export const DEFAULT_RAREBIT_LEASE_MS = 10 * 60_000;

function mirroredPath(
  sessionFile,
  root,
  outputRoot,
  { allowExternalSession = false } = {},
) {
  if (typeof sessionFile !== "string" || !sessionFile.trim())
    throw new Error("A persisted Pi Session file is required");
  const source = resolve(sessionFile);
  const relativePath = relative(resolve(root), source);
  const outsideRoot =
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.includes(`${sep}..${sep}`);
  if (outsideRoot && !allowExternalSession)
    throw new Error("Pi Session file is outside the configured Session root");
  if (outsideRoot) {
    const opaqueSourceId = createHash("sha256").update(source).digest("hex");
    return join(resolve(outputRoot), "external", `${opaqueSourceId}.jsonl`);
  }
  return join(resolve(outputRoot), relativePath);
}

export function rarebitMaterializationPath(
  sessionFile,
  {
    sessionRoot = DEFAULT_RAREBIT_SESSION_ROOT,
    rarebitRoot = DEFAULT_RAREBIT_ROOT,
    allowExternalSession = false,
  } = {},
) {
  return mirroredPath(
    sessionFile,
    sessionRoot,
    join(rarebitRoot, "materializations"),
    { allowExternalSession },
  );
}

async function readTerminalJob(path, jobId) {
  try {
    const records = (await readFile(path, "utf8"))
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    return (
      records.findLast(
        (record) => record?.jobId === jobId && record?.status !== "failure",
      ) ?? null
    );
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function createPrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

/**
 * Cross-process reservation shared by the Pi extension and CLI. Completed
 * records dedupe durably; an active claim is only a short-lived lease.
 */
export async function reserveRarebitJob({
  jobId,
  sessionFile,
  rarebitRoot = DEFAULT_RAREBIT_ROOT,
  sessionRoot = DEFAULT_RAREBIT_SESSION_ROOT,
  leaseMs = DEFAULT_RAREBIT_LEASE_MS,
  allowExternalSession = false,
  now = Date.now(),
} = {}) {
  if (typeof jobId !== "string" || !/^[a-f0-9]{64}$/.test(jobId))
    throw new TypeError("Rarebit jobId must be a SHA-256 hex string");
  const materializationPath = rarebitMaterializationPath(sessionFile, {
    rarebitRoot,
    sessionRoot,
    allowExternalSession,
  });
  const terminalRecord = await readTerminalJob(materializationPath, jobId);
  if (terminalRecord)
    return {
      acquired: false,
      duplicate: true,
      jobId,
      materializationPath,
      record: terminalRecord,
    };

  const jobsDir = join(resolve(rarebitRoot), "jobs");
  await createPrivateDirectory(jobsDir);
  const claimPath = join(jobsDir, `${jobId}.json`);
  const acquire = async (mayReclaim) => {
    try {
      const handle = await open(claimPath, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ jobId, claimedAt: new Date(now).toISOString(), leaseMs })}\n`,
      );
      await handle.close();
      await chmod(claimPath, 0o600);
      return { acquired: true, jobId, claimPath, materializationPath };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (!mayReclaim)
        return { acquired: false, inFlight: true, jobId, materializationPath };
      const age = now - (await stat(claimPath)).mtimeMs;
      if (age <= leaseMs)
        return { acquired: false, inFlight: true, jobId, materializationPath };
      await unlink(claimPath).catch((unlinkError) => {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      });
      return acquire(false);
    }
  };
  return acquire(true);
}

export async function settleRarebitJob(reservation, record) {
  if (!reservation?.acquired)
    throw new Error("An acquired Rarebit reservation is required");
  const path = reservation.materializationPath;
  await createPrivateDirectory(dirname(path));
  try {
    const info = await lstat(path).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (info?.isSymbolicLink())
      throw new Error("Rarebit materialization path must not be a symlink");
    const handle = await open(path, "a", 0o600);
    await handle.writeFile(
      `${JSON.stringify({ ...record, jobId: reservation.jobId })}\n`,
    );
    await handle.close();
    await chmod(path, 0o600);
  } finally {
    await unlink(reservation.claimPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  return { ...record, jobId: reservation.jobId, path };
}

export async function releaseRarebitJob(reservation) {
  if (!reservation?.claimPath) return;
  await unlink(reservation.claimPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}
