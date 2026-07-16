import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  RAREBIT_SELECTOR_VERSION,
  measureRarebits,
  selectRarebits,
} from "./rarebit-core.mjs";

export const DEFAULT_PI_SESSION_ROOT = join(
  homedir(),
  ".pi",
  "agent",
  "sessions",
);
export const RAREBIT_QUERY_SCHEMA_VERSION = 1;

function queryError(message) {
  const error = new Error(message);
  error.name = "RarebitQueryError";
  return error;
}

async function isRegularFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function* jsonlFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* jsonlFiles(path);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
  }
}

async function readHeader(path) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(16384);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer
      .subarray(0, bytesRead)
      .toString("utf8")
      .split("\n", 1)[0]
      ?.trim();
    if (!firstLine) return null;
    try {
      const header = JSON.parse(firstLine);
      return header?.type === "session" ? header : null;
    } catch {
      return null;
    }
  } finally {
    await handle.close();
  }
}

function looksLikePath(reference) {
  return (
    reference.includes(sep) ||
    reference.startsWith(".") ||
    reference.endsWith(".jsonl")
  );
}

/** Resolve either an existing JSONL path or one exact Pi Session ID. */
export async function resolveRarebitSessionFile(
  reference,
  { sessionRoot = DEFAULT_PI_SESSION_ROOT } = {},
) {
  if (typeof reference !== "string" || !reference.trim())
    throw queryError("--session requires an exact Pi Session path or ID");
  const input = reference.trim();
  const path = resolve(input);
  if (await isRegularFile(path)) return path;
  if (looksLikePath(input))
    throw queryError(`Pi Session file not found: ${input}`);
  const matches = [];
  for await (const candidate of jsonlFiles(resolve(sessionRoot))) {
    const header = await readHeader(candidate);
    if (header?.id === input) matches.push(candidate);
  }
  if (matches.length === 0)
    throw queryError(`No persisted Pi Session has exact ID ${input}`);
  if (matches.length > 1)
    throw queryError(
      `Pi Session ID ${input} is ambiguous across ${matches.length} files; pass an exact path`,
    );
  return resolve(matches[0]);
}

export function parseNativeSession(content, source = "Pi Session") {
  const records = [];
  for (const [index, line] of String(content).split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw queryError(
        `${source} contains malformed JSON at line ${index + 1}`,
      );
    }
  }
  const header = records[0];
  if (header?.type !== "session" || typeof header.id !== "string" || !header.id)
    throw queryError(`${source} does not begin with a valid Pi Session header`);
  const entries = records.slice(1);
  const byId = new Map();
  if ((header.version ?? 1) < 2) return { header, entries, byId, linear: true };
  for (const entry of entries) {
    if (typeof entry?.id !== "string" || !entry.id)
      throw queryError(`${source} contains a Session entry without an ID`);
    if (byId.has(entry.id))
      throw queryError(
        `${source} contains duplicate Session entry ID ${entry.id}`,
      );
    byId.set(entry.id, entry);
  }
  return { header, entries, byId, linear: false };
}

/** Match Pi's persisted active branch: the final entry is the active leaf. */
export function resolveActiveBranch(
  { entries, byId, linear },
  source = "Pi Session",
) {
  if (linear) return entries.slice();
  const leaf = entries.at(-1);
  if (!leaf) return [];
  const reversed = [];
  const visited = new Set();
  let current = leaf;
  while (current) {
    if (visited.has(current.id))
      throw queryError(
        `${source} contains a cycle at Session entry ${current.id}`,
      );
    visited.add(current.id);
    reversed.push(current);
    if (current.parentId === null || current.parentId === undefined) break;
    current = byId.get(current.parentId);
    if (!current)
      throw queryError(
        `${source} is missing parent Session entry ${reversed.at(-1).parentId}`,
      );
  }
  return reversed.reverse();
}

function sessionProjection(parsed, branch) {
  const selection = selectRarebits(branch);
  const measurement = measureRarebits(branch, selection);
  return {
    schemaVersion: RAREBIT_QUERY_SCHEMA_VERSION,
    selectorVersion: RAREBIT_SELECTOR_VERSION,
    session: {
      id: parsed.header.id,
      activeLeafId: parsed.linear ? null : (branch.at(-1)?.id ?? null),
      // The original persisted header timestamp is provenance for a title
      // date choice; source paths and cwd intentionally remain private.
      startedAt:
        typeof parsed.header.timestamp === "string"
          ? parsed.header.timestamp
          : null,
    },
    selection,
    measurement,
  };
}

export async function readRarebitSession(reference, options = {}) {
  const sessionFile = await resolveRarebitSessionFile(reference, options);
  const parsed = parseNativeSession(
    await readFile(sessionFile, "utf8"),
    sessionFile,
  );
  const branch = resolveActiveBranch(parsed, sessionFile);
  return { sessionFile, parsed, branch, ...sessionProjection(parsed, branch) };
}

/** Metadata-only projection, safe for a dashboard or programmatic inspection. */
export async function queryRarebits(reference, options = {}) {
  const result = await readRarebitSession(reference, options);
  return {
    schemaVersion: result.schemaVersion,
    selectorVersion: result.selectorVersion,
    session: result.session,
    rarebitCount: result.selection.occurrences.length,
    measurement: result.measurement,
    rarebits: result.selection.occurrences.map(
      ({ text, ...occurrence }) => occurrence,
    ),
  };
}

/** Raw selected prose remains inspectable on demand but is never a sidecar authority. */
export async function extractRarebits(reference, options = {}) {
  const result = await readRarebitSession(reference, options);
  return {
    schemaVersion: result.schemaVersion,
    selectorVersion: result.selectorVersion,
    session: result.session,
    rarebitCount: result.selection.occurrences.length,
    measurement: result.measurement,
    rarebits: result.selection.occurrences.map(
      ({ sourceEntryId, timestamp, role, outcome, producer, text }) => ({
        sourceEntryId,
        timestamp,
        role,
        outcome,
        producer,
        text,
      }),
    ),
  };
}
