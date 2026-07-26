import { chmod, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import {
  projectRarebitArtifactState,
  validateRarebitArtifactReceipt,
  validateRarebitTitleReceipt,
} from "./rarebit-artifact-state.mjs";
import { readRarebitSession } from "./rarebit-session.mjs";

export const DEFAULT_RAREBIT_ROOT = join(homedir(), ".pi", "agent", "rarebit");
export const DEFAULT_RAREBIT_SESSION_ROOT = join(
  homedir(),
  ".pi",
  "agent",
  "sessions",
);
export const DEFAULT_RAREBIT_LEASE_MS = 10 * 60_000;
export const RAREBIT_SIDECAR_PROTOCOL_VERSION = 1;

const MAX_TAIL_BYTES = 64 * 1024;
const MAX_RECEIPT_BYTES = 48 * 1024;
const MAX_HEAD_BYTES = 8 * 1024;
const MAX_HISTORY_BYTES = 1024 * 1024;
const MAX_HISTORY_RECORDS = 1_000;
const COMMIT_LOCK_RETRY_MS = 5;
const COMMIT_LOCK_ATTEMPTS = 2_000;

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

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
  if (outsideRoot)
    return join(
      resolve(outputRoot),
      "external",
      `${sha256Bytes(source)}.jsonl`,
    );
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
    join(rarebitRoot, "materializations-v4"),
    { allowExternalSession },
  );
}

async function createPrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function privateRegularFileInfo(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error("Rarebit materialization path must be a regular file");
  return info;
}

function validHead(head) {
  return (
    head?.type === "rarebit_head" &&
    head.protocolVersion === RAREBIT_SIDECAR_PROTOCOL_VERSION &&
    typeof head.sessionId === "string" &&
    head.sessionId.length > 0 &&
    Number.isSafeInteger(head.receiptOffset) &&
    head.receiptOffset >= 0 &&
    Number.isSafeInteger(head.receiptLength) &&
    head.receiptLength > 0 &&
    head.receiptLength <= MAX_RECEIPT_BYTES &&
    /^[a-f0-9]{64}$/.test(head.receiptHash)
  );
}

async function readTail(path) {
  const info = await privateRegularFileInfo(path);
  const length = Math.min(info.size, MAX_TAIL_BYTES);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      length,
      info.size - length,
    );
    return {
      size: info.size,
      offset: info.size - bytesRead,
      buffer: buffer.subarray(0, bytesRead),
    };
  } finally {
    await handle.close();
  }
}

function completeTailLines(tail) {
  let buffer = tail.buffer;
  let offset = tail.offset;
  if (offset > 0) {
    const firstNewline = buffer.indexOf(10);
    if (firstNewline < 0)
      return { lines: [], tornTail: true, discardedPrefix: true };
    buffer = buffer.subarray(firstNewline + 1);
    offset += firstNewline + 1;
  }
  const tornTail = buffer.length > 0 && buffer.at(-1) !== 10;
  const completeLength = tornTail ? buffer.lastIndexOf(10) + 1 : buffer.length;
  const complete = buffer.subarray(0, completeLength);
  const lines = [];
  let cursor = 0;
  while (cursor < complete.length) {
    const newline = complete.indexOf(10, cursor);
    if (newline < 0) break;
    const bytes = complete.subarray(cursor, newline);
    if (bytes.length > 0) {
      const line = bytes.toString("utf8");
      let record = null;
      try {
        record = JSON.parse(line);
      } catch {
        // Retain the raw complete line so an invalid final head fails closed.
      }
      lines.push({ offset: offset + cursor, line, record });
    }
    cursor = newline + 1;
  }
  return { lines, tornTail, discardedPrefix: tail.offset > 0 };
}

async function readRecordReference(
  path,
  reference,
  { requireSummary = false } = {},
) {
  if (
    !Number.isSafeInteger(reference?.receiptOffset) ||
    reference.receiptOffset < 0 ||
    !Number.isSafeInteger(reference?.receiptLength) ||
    reference.receiptLength < 1 ||
    reference.receiptLength > MAX_RECEIPT_BYTES ||
    !/^[a-f0-9]{64}$/.test(reference?.receiptHash ?? "")
  )
    return { error: "sidecar_head_invalid" };
  const info = await privateRegularFileInfo(path);
  if (reference.receiptOffset + reference.receiptLength > info.size)
    return { error: "sidecar_head_invalid" };
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(reference.receiptLength);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.length,
      reference.receiptOffset,
    );
    if (bytesRead !== reference.receiptLength)
      return { error: "sidecar_head_invalid" };
    const bytes = buffer.subarray(0, bytesRead);
    if (sha256Bytes(bytes) !== reference.receiptHash || bytes.at(-1) !== 10)
      return { error: "sidecar_head_invalid" };
    let record;
    try {
      record = JSON.parse(bytes.subarray(0, -1).toString("utf8"));
    } catch {
      return { error: "sidecar_head_invalid" };
    }
    if (
      requireSummary &&
      (record?.type !== "rarebit_summary" ||
        record?.sessionId !== reference.sessionId ||
        !validateRarebitArtifactReceipt(record).valid)
    )
      return { error: "sidecar_head_invalid" };
    if (
      !requireSummary &&
      !(
        (record?.type === "rarebit_summary" &&
          validateRarebitArtifactReceipt(record).valid) ||
        (record?.type === "rarebit_title" &&
          validateRarebitTitleReceipt(record).valid)
      )
    )
      return { error: "sidecar_head_invalid" };
    return { record };
  } finally {
    await handle.close();
  }
}

async function nativeObservation(sessionFile, options) {
  try {
    const session = await readRarebitSession(sessionFile, {
      sessionRoot: options.sessionRoot,
    });
    return {
      availability: "available",
      sessionId: session.session.id,
      selection: {
        ...session.selection,
        selectorVersion: session.selection.manifest.selectorVersion,
      },
    };
  } catch (error) {
    return {
      availability: error?.code === "ENOENT" ? "missing" : "unreadable",
    };
  }
}

/** Bounded normal reader: one tail window plus one referenced receipt range. */
export async function readRarebitCurrent({
  sessionFile,
  native = null,
  expectation,
  deadlineExpired,
  ...options
} = {}) {
  const path = rarebitMaterializationPath(sessionFile, options);
  const resolvedNative =
    native ?? (await nativeObservation(sessionFile, options));
  const withState = (result) => ({
    ...result,
    artifactState: projectRarebitArtifactState({
      native: resolvedNative,
      materialization: {
        availability: result.availability,
        records: result.records,
      },
      expectation,
      deadlineExpired,
    }),
  });
  try {
    const tail = await readTail(path);
    const parsed = completeTailLines(tail);
    const heads = parsed.lines.filter(({ record }) => validHead(record));
    const last = heads.at(-1) ?? null;
    const lastValidHeadOffset = last?.offset ?? -1;
    const invalidHeadAfterCurrent = parsed.lines.some(
      ({ offset, line, record }) =>
        offset > lastValidHeadOffset &&
        (record?.type === "rarebit_head" ||
          (!record && line.includes('"rarebit_head"'))) &&
        !validHead(record),
    );
    if (invalidHeadAfterCurrent)
      return withState({
        availability: "unreadable",
        path,
        receipt: null,
        records: [],
        head: last?.record ?? null,
        diagnostics: { tornTail: false, reason: "sidecar_head_invalid" },
      });

    if (!last)
      return withState({
        availability: "missing",
        path,
        receipt: null,
        records: [],
        head: null,
        diagnostics: {
          tornTail: parsed.tornTail,
          reason: parsed.lines.length
            ? "sidecar_head_missing"
            : "sidecar_empty",
        },
      });

    const checked = await readRecordReference(path, last.record, {
      requireSummary: true,
    });
    if (checked.error)
      return withState({
        availability: "unreadable",
        path,
        receipt: null,
        records: [],
        head: last.record,
        diagnostics: {
          tornTail: parsed.tornTail,
          reason: checked.error,
        },
      });

    const recordsAfterHead = parsed.lines.filter(
      ({ offset }) => offset > last.offset,
    ).length;
    return withState({
      availability: "available",
      path,
      receipt: checked.record,
      records: [checked.record],
      head: last.record,
      diagnostics: {
        tornTail: parsed.tornTail,
        tailOffset: tail.offset,
        ...(recordsAfterHead > 0 ? { reason: "sidecar_uncommitted_tail" } : {}),
      },
    });
  } catch (error) {
    if (error?.code === "ENOENT")
      return withState({
        availability: "missing",
        path,
        receipt: null,
        records: [],
        head: null,
        diagnostics: { tornTail: false, reason: "sidecar_missing" },
      });
    return withState({
      availability: "unreadable",
      path,
      receipt: null,
      records: [],
      head: null,
      diagnostics: { tornTail: false, reason: "sidecar_unreadable" },
    });
  }
}

/** Explicit bounded audit path, resumable at the returned absolute offset. */
export async function readRarebitHistory({
  sessionFile,
  fromOffset = 0,
  limit = 100,
  ...options
} = {}) {
  if (
    !Number.isSafeInteger(fromOffset) ||
    fromOffset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_HISTORY_RECORDS
  )
    throw new TypeError("History offset and limit are outside protocol bounds");
  const path = rarebitMaterializationPath(sessionFile, options);
  let handle;
  try {
    const info = await privateRegularFileInfo(path);
    if (fromOffset >= info.size)
      return {
        availability: "available",
        path,
        records: [],
        nextOffset: null,
      };
    handle = await open(path, "r");
    const byteCount = Math.min(MAX_HISTORY_BYTES, info.size - fromOffset);
    const buffer = Buffer.alloc(byteCount);
    const { bytesRead } = await handle.read(buffer, 0, byteCount, fromOffset);
    const bytes = buffer.subarray(0, bytesRead);
    let cursor = 0;
    if (fromOffset > 0) {
      const previous = Buffer.alloc(1);
      await handle.read(previous, 0, 1, fromOffset - 1);
      if (previous[0] !== 10) {
        const newline = bytes.indexOf(10);
        if (newline < 0)
          return {
            availability: "available",
            path,
            records: [],
            nextOffset:
              fromOffset + bytes.length < info.size
                ? fromOffset + bytes.length
                : null,
          };
        cursor = newline + 1;
      }
    }

    const records = [];
    while (cursor < bytes.length && records.length < limit) {
      const newline = bytes.indexOf(10, cursor);
      if (newline < 0) break;
      const lineOffset = fromOffset + cursor;
      const line = bytes.subarray(cursor, newline).toString("utf8");
      cursor = newline + 1;
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        if (
          (record.type === "rarebit_summary" &&
            validateRarebitArtifactReceipt(record).valid) ||
          (record.type === "rarebit_title" &&
            validateRarebitTitleReceipt(record).valid)
        )
          records.push({ offset: lineOffset, record });
      } catch {
        // History is evidence-oriented but returns only complete JSON records.
      }
    }
    const absoluteCursor = fromOffset + cursor;
    let nextOffset = null;
    if (absoluteCursor < info.size) {
      if (cursor === 0 && bytes.length > 0)
        nextOffset = fromOffset + bytes.length;
      else nextOffset = absoluteCursor;
    }
    return { availability: "available", path, records, nextOffset };
  } catch (error) {
    if (error?.code === "ENOENT")
      return { availability: "missing", path, records: [], nextOffset: null };
    return {
      availability: "unreadable",
      path,
      records: [],
      nextOffset: null,
    };
  } finally {
    await handle?.close();
  }
}

async function readJobClaim(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonFile(path, value, flags = "w") {
  const handle = await open(path, flags, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ownsReservation(reservation) {
  const claim = await readJobClaim(reservation.claimPath);
  return (
    claim?.state === "active" && claim.leaseToken === reservation.leaseToken
  );
}

async function acquireCommitLock(path) {
  const lockPath = `${path}.commit-lock`;
  const token = randomBytes(24).toString("hex");
  for (let attempt = 0; attempt < COMMIT_LOCK_ATTEMPTS; attempt += 1) {
    try {
      await writeJsonFile(
        lockPath,
        { token, claimedAt: new Date().toISOString() },
        "wx",
      );
      return { lockPath, token };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await new Promise((resolveWait) =>
        setTimeout(resolveWait, COMMIT_LOCK_RETRY_MS),
      );
    }
  }
  throw new Error(
    "Rarebit Session commit lock is held; explicit repair is required if its owner crashed",
  );
}

async function releaseCommitLock(lock) {
  if (!lock) return;
  const current = await readJobClaim(lock.lockPath);
  if (current?.token === lock.token)
    await unlink(lock.lockPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
}

function activeClaim(jobId, leaseToken, claimedAt, leaseMs) {
  return {
    jobId,
    state: "active",
    leaseToken,
    claimedAt: new Date(claimedAt).toISOString(),
    leaseMs,
  };
}

function claimExpired(claim, now) {
  const claimedAt = Date.parse(claim?.claimedAt);
  return (
    claim?.state === "active" &&
    Number.isFinite(claimedAt) &&
    Number.isFinite(claim.leaseMs) &&
    now - claimedAt > claim.leaseMs
  );
}

async function settledDuplicate(claim, materializationPath) {
  if (claim?.state !== "settled" || !claim.receiptRef) return null;
  const checked = await readRecordReference(
    materializationPath,
    claim.receiptRef,
  );
  if (checked.error)
    throw new Error("Rarebit settled job receipt pointer is invalid");
  return checked.record;
}

export async function reserveRarebitJob({
  jobId,
  sessionFile,
  native = null,
  rarebitRoot = DEFAULT_RAREBIT_ROOT,
  sessionRoot = DEFAULT_RAREBIT_SESSION_ROOT,
  leaseMs = DEFAULT_RAREBIT_LEASE_MS,
  allowExternalSession = false,
  now = Date.now(),
  hooks = null,
} = {}) {
  if (typeof jobId !== "string" || !/^[a-f0-9]{64}$/.test(jobId))
    throw new TypeError("Rarebit jobId must be a SHA-256 hex string");
  if (!Number.isFinite(leaseMs) || leaseMs < 1)
    throw new TypeError("Rarebit leaseMs must be a positive finite number");
  const materializationPath = rarebitMaterializationPath(sessionFile, {
    rarebitRoot,
    sessionRoot,
    allowExternalSession,
  });
  const jobsDir = join(resolve(rarebitRoot), "jobs-v4");
  await createPrivateDirectory(jobsDir);
  await createPrivateDirectory(dirname(materializationPath));
  const claimPath = join(jobsDir, `${jobId}.json`);
  const leaseToken = randomBytes(24).toString("hex");
  const reservation = {
    acquired: true,
    jobId,
    claimPath,
    leaseToken,
    materializationPath,
    sessionFile,
    native,
    rarebitRoot,
    sessionRoot,
    allowExternalSession,
    hooks,
  };
  try {
    await writeJsonFile(
      claimPath,
      activeClaim(jobId, leaseToken, now, leaseMs),
      "wx",
    );
    return reservation;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  let claim = await readJobClaim(claimPath);
  const duplicate = await settledDuplicate(claim, materializationPath);
  if (duplicate)
    return {
      acquired: false,
      duplicate: true,
      jobId,
      materializationPath,
      record: { ...duplicate, path: materializationPath },
      sessionFile,
      rarebitRoot,
      sessionRoot,
      allowExternalSession,
    };
  if (!claimExpired(claim, now))
    return {
      acquired: false,
      inFlight: true,
      jobId,
      materializationPath,
      sessionFile,
      rarebitRoot,
      sessionRoot,
      allowExternalSession,
    };

  const lock = await acquireCommitLock(materializationPath);
  try {
    claim = await readJobClaim(claimPath);
    const settled = await settledDuplicate(claim, materializationPath);
    if (settled)
      return {
        acquired: false,
        duplicate: true,
        jobId,
        materializationPath,
        record: { ...settled, path: materializationPath },
        sessionFile,
        rarebitRoot,
        sessionRoot,
        allowExternalSession,
      };
    if (!claimExpired(claim, now))
      return {
        acquired: false,
        inFlight: true,
        jobId,
        materializationPath,
        sessionFile,
        rarebitRoot,
        sessionRoot,
        allowExternalSession,
      };
    await writeJsonFile(
      claimPath,
      activeClaim(jobId, leaseToken, now, leaseMs),
    );
    return reservation;
  } finally {
    await releaseCommitLock(lock);
  }
}

export async function settleRarebitJob(reservation, record) {
  if (!reservation?.acquired)
    throw new Error("An acquired Rarebit reservation is required");
  const path = reservation.materializationPath;
  await createPrivateDirectory(dirname(path));
  const settled = { ...record, jobId: reservation.jobId };
  if (settled.type !== "rarebit_summary" && settled.type !== "rarebit_title")
    throw new TypeError("Rarebit derivation receipt type is unsupported");
  if (
    settled.type === "rarebit_summary" &&
    !validateRarebitArtifactReceipt(settled).valid
  )
    throw new TypeError(
      `Rarebit Summary receipt does not match protocol v4 (${settled.status}; keys: ${Object.keys(settled).sort().join(",")})`,
    );
  if (
    settled.type === "rarebit_title" &&
    !validateRarebitTitleReceipt(settled).valid
  )
    throw new TypeError(
      `Rarebit Title receipt does not match protocol v4 (${settled.status}; keys: ${Object.keys(settled).sort().join(",")})`,
    );
  const receiptLine = Buffer.from(`${JSON.stringify(settled)}\n`);
  if (receiptLine.length > MAX_RECEIPT_BYTES)
    throw new RangeError("Rarebit receipt exceeds protocol byte limit");

  let lock;
  try {
    lock = await acquireCommitLock(path);
    if (!(await ownsReservation(reservation)))
      throw new Error("Rarebit reservation lease was fenced by a newer worker");
    await reservation.hooks?.afterLeaseValidated?.();

    const existing = await lstat(path).catch((error) =>
      error?.code === "ENOENT" ? null : Promise.reject(error),
    );
    if (existing && (existing.isSymbolicLink() || !existing.isFile()))
      throw new Error("Rarebit materialization path must be a regular file");

    const native = await nativeObservation(reservation.sessionFile, {
      sessionRoot: reservation.sessionRoot,
    });
    const current = await readRarebitCurrent({
      sessionFile: reservation.sessionFile,
      native,
      rarebitRoot: reservation.rarebitRoot,
      sessionRoot: reservation.sessionRoot,
      allowExternalSession: reservation.allowExternalSession,
    });
    const candidateState = projectRarebitArtifactState({
      native,
      materialization: {
        availability: "available",
        records: [current.receipt, settled].filter(Boolean),
      },
    });
    const semanticCurrent =
      native.availability === "available" &&
      settled.type === "rarebit_summary" &&
      candidateState.receiptRef?.jobId === settled.jobId;

    let head = current.head;
    const handle = await open(path, "a+", 0o600);
    let receiptOffset;
    try {
      ({ size: receiptOffset } = await handle.stat());
      await handle.write(receiptLine);
      if (semanticCurrent) {
        head = {
          type: "rarebit_head",
          protocolVersion: RAREBIT_SIDECAR_PROTOCOL_VERSION,
          sessionId: settled.sessionId,
          receiptOffset,
          receiptLength: receiptLine.length,
          receiptHash: sha256Bytes(receiptLine),
        };
      }
      if (head) {
        const headLine = Buffer.from(`${JSON.stringify(head)}\n`);
        if (headLine.length > MAX_HEAD_BYTES)
          throw new RangeError("Rarebit head exceeds protocol byte limit");
        await handle.write(headLine);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(path, 0o600);

    if (!(await ownsReservation(reservation)))
      throw new Error("Rarebit reservation lease was fenced by a newer worker");
    await writeJsonFile(reservation.claimPath, {
      jobId: reservation.jobId,
      state: "settled",
      leaseToken: reservation.leaseToken,
      receiptRef: {
        receiptOffset,
        receiptLength: receiptLine.length,
        receiptHash: sha256Bytes(receiptLine),
      },
    });
  } catch (error) {
    if (lock && (await ownsReservation(reservation)))
      await unlink(reservation.claimPath).catch((unlinkError) => {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      });
    throw error;
  } finally {
    await releaseCommitLock(lock);
  }
  return { ...settled, path };
}

export async function releaseRarebitJob(reservation) {
  if (!reservation?.claimPath || !reservation.materializationPath) return;
  const lock = await acquireCommitLock(reservation.materializationPath);
  try {
    if (await ownsReservation(reservation))
      await unlink(reservation.claimPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
  } finally {
    await releaseCommitLock(lock);
  }
}
