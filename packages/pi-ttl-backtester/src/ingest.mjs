// Fast windowed ingest of pi session JSONL into compact usage rows.
//
// Speed comes from two file filters and a per-file index:
// 1. file mtime < since       -> no entry can fall inside the window
// 2. filename start > until   -> session started after the window
// 3. parsed rows are cached per file keyed by size + mtime
//
// Each assistant request records its lineage predecessor: the nearest earlier
// assistant request on its parentId path, on the same model, with no compaction
// or branch summary in between. The predecessor's prompt is the prefix the request
// can reuse. Predecessor data is kept even when it lies before the window.

import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";

export const DEFAULT_SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");
export const DEFAULT_STATE_DIR = join(homedir(), ".pi", "agent", "ttl-backtester");
const INDEX_VERSION = 2;
const BREAKS = new Set(["compaction", "branch_summary"]);

// File-local row: [tMs, kind(0=message,1=usage entry), "provider/model", input, cacheRead, cacheWrite, cacheWrite1h, output, loggedCost, predRowIdx]
async function parseFile(path) {
  const rows = [];
  const nodes = new Map(); // id -> { parent, type, row }
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const node = { parent: o.parentId ?? null, type: o.type, row: -1 };
    if (o.id) nodes.set(o.id, node);
    let u, t, kind, key;
    if (o.type === "message" && o.message?.role === "assistant" && o.message.usage) {
      const m = o.message;
      u = m.usage;
      // message.timestamp is request start; the entry timestamp is response end.
      t = typeof m.timestamp === "number" ? m.timestamp : Date.parse(o.timestamp);
      kind = 0;
      key = `${m.provider}/${m.model}`;
    } else if (o.type === "usage" && o.usage) {
      u = o.usage;
      t = Date.parse(o.timestamp);
      kind = 1;
      key = `${o.provider}/${o.model}`;
    } else continue;
    const tokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0);
    if (!tokens || !Number.isFinite(t)) continue;
    if (kind === 0) node.row = rows.length;
    rows.push([t, kind, key, u.input ?? 0, u.cacheRead ?? 0, u.cacheWrite ?? 0, u.cacheWrite1h ?? 0, u.output ?? 0, u.cost?.total ?? 0, -1]);
    if (kind === 0) {
      for (let p = nodes.get(node.parent); p; p = nodes.get(p.parent)) {
        if (BREAKS.has(p.type)) break;
        if (p.row >= 0) {
          if (rows[p.row][2] === key) rows[node.row][9] = p.row;
          break;
        }
      }
    }
  }
  return rows;
}

async function listSessionFiles(root) {
  const out = [];
  for (const d of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory()) continue;
    const dir = join(root, d.name);
    for (const f of await readdir(dir).catch(() => [])) if (f.endsWith(".jsonl")) out.push(join(dir, f));
  }
  return out;
}

// "2026-09-30T04-42-38-615Z_<id>.jsonl" -> ms
function fileStartMs(path) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(basename(path));
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : NaN;
}

async function loadIndex(path) {
  try {
    const idx = JSON.parse(await readFile(path, "utf8"));
    if (idx.version === INDEX_VERSION) return idx;
  } catch {}
  return { version: INDEX_VERSION, files: {} };
}

/**
 * Ingest usage rows within [sinceMs, untilMs).
 * Returns rows in the compact sim format (see sim.mjs COL) plus usage-entry rows, model keys, and stats.
 */
export async function ingest({ sinceMs, untilMs = Date.now(), sessionsDir = DEFAULT_SESSIONS_DIR, stateDir = DEFAULT_STATE_DIR, useIndex = true } = {}) {
  const started = performance.now();
  const indexPath = join(stateDir, "index.json");
  const index = useIndex ? await loadIndex(indexPath) : { version: INDEX_VERSION, files: {} };
  const files = await listSessionFiles(sessionsDir);
  const stats = { files: files.length, scanned: 0, parsed: 0, cached: 0, skipped: 0 };
  const models = [];
  const modelIdx = new Map();
  const rows = [];
  const warm = [];
  let sessions = 0;
  let dirty = false;

  const candidates = [];
  await Promise.all(
    files.map(async (path) => {
      const start = fileStartMs(path);
      if (start >= untilMs) return void stats.skipped++;
      const st = await stat(path).catch(() => null);
      if (!st || st.mtimeMs < sinceMs) return void stats.skipped++;
      candidates.push({ path, st });
    }),
  );

  // Bounded concurrency keeps file descriptors in check.
  const queue = [...candidates];
  const results = new Map();
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      for (let c; (c = queue.shift()); ) {
        const hit = index.files[c.path];
        stats.scanned++;
        if (hit && hit.size === c.st.size && hit.mtimeMs === c.st.mtimeMs) {
          stats.cached++;
          results.set(c.path, hit.rows);
        } else {
          const fileRows = await parseFile(c.path);
          stats.parsed++;
          index.files[c.path] = { size: c.st.size, mtimeMs: c.st.mtimeMs, rows: fileRows };
          dirty = true;
          results.set(c.path, fileRows);
        }
      }
    }),
  );

  for (const fileRows of results.values()) {
    const session = sessions++;
    for (const r of fileRows) {
      if (r[0] < sinceMs || r[0] >= untilMs) continue;
      let m = modelIdx.get(r[2]);
      if (m === undefined) modelIdx.set(r[2], (m = models.push(r[2]) - 1));
      const p = r[9] >= 0 ? fileRows[r[9]] : null;
      // predT, predPrompt (input + cacheRead + cacheWrite), predCached (cacheRead + cacheWrite)
      const pred = p ? [p[0], p[3] + p[4] + p[5], p[4] + p[5]] : [-1, 0, 0];
      const row = [r[0], session, m, r[3], r[4], r[5], r[6], r[7], r[8], ...pred];
      (r[1] === 1 ? warm : rows).push(row);
    }
  }
  rows.sort((a, b) => a[0] - b[0]);
  warm.sort((a, b) => a[0] - b[0]);

  if (useIndex && dirty) {
    await mkdir(stateDir, { recursive: true });
    await writeFile(indexPath, JSON.stringify(index));
  }
  stats.ms = Math.round(performance.now() - started);
  return { sinceMs, untilMs, rows, warm, models, sessions, stats };
}
