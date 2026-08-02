import { execFile } from "node:child_process";
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  RAREBIT_SELECTOR_VERSION,
  rarebitMetadata,
  rarebitText,
  resolveActiveBranch,
  selectRarebits,
} from "@hypercarrier/rarebit";
import { createSourceWatcher } from "./watcher.js";
import { resolveBundledPiExporter, resolveExecutablePath } from "./pi-exporter-provider.js";
import { renderRarebitMarkdown } from "./rarebit-markdown.js";
import { SessionRegistry } from "./session-registry.js";
import { resolveCoreHost, resolveServicePort } from "./service-config.js";

const run = promisify(execFile);
const READ_CHUNK_BYTES = 1024 * 1024;
const CHECKPOINT_BYTES = 512;
export const DEFAULT_NATIVE_EXPORT_MAX_DEPTH = 2_048;
const NATIVE_EXPORT_STABILITY_ATTEMPTS = 2;
const EXPORTER_CAPABILITIES = new Set(["legacy-recursive", "stack-safe"]);

const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
const scriptJson = (value) => JSON.stringify(value).replaceAll("<", "\\u003c");

function sourceVersion(sourceStat) {
  return `${sourceStat.dev}:${sourceStat.ino}:${sourceStat.size}:${sourceStat.mtimeMs}`;
}

function nonempty(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be nonempty`);
  return value.trim();
}

export function resolveNativeExporter({
  env = process.env,
  exportCommand,
  exporterRevision,
  exporterCapability,
  exporterVersion,
  nativeExporterStackSafe,
} = {}) {
  const configured = exportCommand !== undefined || env.PI_LIVE_DETAIL_EXPORTER !== undefined;
  if (!configured) {
    const bundled = resolveBundledPiExporter();
    if (!EXPORTER_CAPABILITIES.has(bundled.capability))
      throw new Error(`Unsupported native exporter capability: ${bundled.capability}`);
    return {
      ...bundled,
      identity: `${bundled.executable}@${bundled.revision}#${bundled.capability}`,
    };
  }
  const executable = resolveExecutablePath(exportCommand ?? env.PI_LIVE_DETAIL_EXPORTER);
  const revision = nonempty(
    exporterRevision ?? exporterVersion ?? env.PI_LIVE_DETAIL_EXPORTER_REVISION ?? undefined,
    "native exporter revision",
  );
  const capability = nonempty(
    exporterCapability ??
      env.PI_LIVE_DETAIL_EXPORTER_CAPABILITY ??
      (nativeExporterStackSafe ? "stack-safe" : undefined),
    "native exporter capability",
  );
  if (!EXPORTER_CAPABILITIES.has(capability))
    throw new Error(`Unsupported native exporter capability: ${capability}`);
  return {
    executable,
    revision,
    capability,
    identity: `${executable}@${revision}#${capability}`,
    provider: { kind: "development-override" },
  };
}

function sameOccurrence(left, right) {
  return left?.occurrenceId === right?.occurrenceId;
}

function isPrefix(previous, next, same = (left, right) => left === right) {
  return (
    previous.length <= next.length && previous.every((value, index) => same(value, next[index]))
  );
}

function compactSessionEntry(entry) {
  const common = {
    type: entry?.type,
    id: entry?.id,
    parentId: entry?.parentId,
    timestamp: entry?.timestamp,
  };
  const metadata = rarebitMetadata(entry);
  if (!metadata) return common;
  return {
    ...common,
    message: {
      id: entry.message.id,
      role: entry.message.role,
      stopReason: entry.message.stopReason,
      timestamp: entry.message.timestamp,
      content: rarebitText(entry),
    },
  };
}

function unavailable(reason, message, details = {}) {
  return {
    availability: "unavailable",
    reason,
    message,
    ...details,
  };
}

/**
 * Inspect the complete parent graph iteratively. This is exporter compatibility
 * metadata, not a semantic limit on valid Pi Sessions or Rarebit selection.
 */
export function analyzeSessionParentGraph(entries, { linear = false } = {}) {
  const records = Array.isArray(entries) ? entries : [];
  if (linear)
    return { status: "available", entryCount: records.length, maxDepth: records.length ? 1 : 0 };
  const byId = new Map();
  for (const entry of records) {
    if (typeof entry?.id !== "string" || !entry.id)
      return {
        status: "unavailable",
        reason: "entry_without_id",
        entryCount: records.length,
        maxDepth: null,
      };
    if (byId.has(entry.id))
      return {
        status: "unavailable",
        reason: "duplicate_entry_id",
        entryCount: records.length,
        maxDepth: null,
      };
    byId.set(entry.id, entry);
  }
  const depths = new Map();
  let maxDepth = 0;
  for (const entry of records) {
    if (depths.has(entry.id)) continue;
    const trail = [];
    const positions = new Map();
    let current = entry;
    let baseDepth = 0;
    while (current) {
      if (depths.has(current.id)) {
        baseDepth = depths.get(current.id);
        break;
      }
      if (positions.has(current.id))
        return {
          status: "unavailable",
          reason: "parent_cycle",
          entryCount: records.length,
          maxDepth: null,
        };
      positions.set(current.id, trail.length);
      trail.push(current);
      if (current.parentId === null || current.parentId === undefined) break;
      current = byId.get(current.parentId);
      if (!current)
        return {
          status: "unavailable",
          reason: "missing_parent",
          entryCount: records.length,
          maxDepth: null,
        };
    }
    for (let index = trail.length - 1; index >= 0; index -= 1) {
      baseDepth += 1;
      depths.set(trail[index].id, baseDepth);
      maxDepth = Math.max(maxDepth, baseDepth);
    }
  }
  return { status: "available", entryCount: records.length, maxDepth };
}

export function nativeExportPreflight(
  snapshot,
  { maxDepth = DEFAULT_NATIVE_EXPORT_MAX_DEPTH, stackSafe = false } = {},
) {
  if (!stackSafe && (!Number.isInteger(maxDepth) || maxDepth < 1))
    throw new RangeError("maxDepth must be a positive integer");
  const graph = snapshot?.preflight ?? snapshot;
  if (!graph || graph.status !== "available")
    return {
      status: "degraded",
      reason: "legacy_exporter_parent_graph_unavailable",
      entryCount: graph?.entryCount ?? null,
      maxDepth: graph?.maxDepth ?? null,
      limit: maxDepth,
      graphReason: graph?.reason ?? "projection_unavailable",
    };
  if (stackSafe)
    return {
      status: "supported",
      reason: null,
      entryCount: graph.entryCount,
      maxDepth: graph.maxDepth,
      limit: null,
    };
  if (graph.maxDepth > maxDepth)
    return {
      status: "degraded",
      reason: "legacy_exporter_depth_compatibility",
      entryCount: graph.entryCount,
      maxDepth: graph.maxDepth,
      limit: maxDepth,
    };
  return {
    status: "supported",
    reason: null,
    entryCount: graph.entryCount,
    maxDepth: graph.maxDepth,
    limit: maxDepth,
  };
}

/** Kept as a compatibility seam; selection delegates to the shared core. */
export function isDefaultLiveEntry(entry) {
  return rarebitMetadata(entry) !== null;
}

/**
 * Incrementally reads one exact JSONL source. Previous raw records are reduced
 * to lineage plus Rarebit prose; full raw evidence remains only in the Session.
 */
export function createIncrementalRarebitReader(path) {
  const state = {
    identity: null,
    sourceStat: null,
    offset: 0,
    pending: Buffer.alloc(0),
    checkpoint: Buffer.alloc(0),
    header: null,
    entries: [],
    byId: new Map(),
    linear: false,
    parseFailure: null,
    currentProjection: null,
  };

  const reset = () => {
    state.offset = 0;
    state.pending = Buffer.alloc(0);
    state.checkpoint = Buffer.alloc(0);
    state.header = null;
    state.entries = [];
    state.byId = new Map();
    state.linear = false;
    state.parseFailure = null;
  };

  const acceptRecord = (record) => {
    if (!state.header) {
      if (record?.type !== "session" || typeof record.id !== "string" || !record.id) {
        state.parseFailure = unavailable(
          "invalid_session_header",
          "The exact Session does not begin with a valid Pi Session header.",
        );
        return;
      }
      state.header = record;
      state.linear = (record.version ?? 1) < 2;
      return;
    }
    if (!state.linear) {
      if (typeof record?.id !== "string" || !record.id) {
        state.parseFailure = unavailable(
          "entry_without_id",
          "The exact Session contains an entry without an ID.",
        );
        return;
      }
      if (state.byId.has(record.id)) {
        state.parseFailure = unavailable(
          "duplicate_entry_id",
          "The exact Session contains a duplicate entry ID.",
        );
        return;
      }
    }
    const compact = compactSessionEntry(record);
    state.entries.push(compact);
    if (!state.linear) state.byId.set(compact.id, compact);
  };

  const acceptLine = (bytes) => {
    if (
      state.parseFailure ||
      bytes.every((byte) => byte === 0x0d || byte === 0x20 || byte === 0x09)
    )
      return;
    try {
      acceptRecord(JSON.parse(bytes.toString("utf8")));
    } catch {
      state.parseFailure = unavailable(
        "malformed_jsonl",
        "The exact Session contains a completed malformed JSONL record.",
      );
    }
  };

  const acceptBytes = (chunk) => {
    const bytes = state.pending.length ? Buffer.concat([state.pending, chunk]) : chunk;
    let start = 0;
    for (let index = bytes.indexOf(0x0a, start); index >= 0; index = bytes.indexOf(0x0a, start)) {
      acceptLine(bytes.subarray(start, index));
      start = index + 1;
    }
    state.pending = Buffer.from(bytes.subarray(start));
  };

  const readRange = (fd, start, end) => {
    let position = start;
    while (position < end) {
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, end - position));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      acceptBytes(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return position - start;
  };

  const checkpointMatches = (fd) => {
    if (state.checkpoint.length === 0) return true;
    const start = state.offset - state.checkpoint.length;
    const actual = Buffer.allocUnsafe(state.checkpoint.length);
    const bytesRead = readSync(fd, actual, 0, actual.length, start);
    return bytesRead === actual.length && actual.equals(state.checkpoint);
  };

  const updateCheckpoint = (fd) => {
    const length = Math.min(CHECKPOINT_BYTES, state.offset);
    if (length === 0) {
      state.checkpoint = Buffer.alloc(0);
      return;
    }
    const checkpoint = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, checkpoint, 0, length, state.offset - length);
    state.checkpoint = Buffer.from(checkpoint.subarray(0, bytesRead));
  };

  const project = (version, preflight) => {
    if (state.parseFailure) return { ...state.parseFailure, version, preflight };
    if (!state.header)
      return unavailable(
        "session_header_pending",
        "The exact Session header is not complete yet.",
        {
          version,
          preflight,
        },
      );
    let branch;
    try {
      branch = resolveActiveBranch(
        { entries: state.entries, byId: state.byId, linear: state.linear },
        "exact Pi Session",
      );
    } catch (error) {
      return unavailable("active_branch_unavailable", error.message, { version, preflight });
    }
    const selection = selectRarebits(branch);
    return {
      availability: "available",
      schemaVersion: 1,
      selectorVersion: RAREBIT_SELECTOR_VERSION,
      version,
      sessionId: state.header.id,
      activeLeafId: state.linear ? null : (branch.at(-1)?.id ?? null),
      activeBranchIds: branch.map((entry) => entry.id).filter((id) => typeof id === "string"),
      entryCount: state.entries.length,
      otherEntryCount: Math.max(0, state.entries.length - selection.occurrences.length),
      manifestHash: selection.manifestHash,
      occurrences: selection.occurrences,
      preflight,
    };
  };

  return {
    path,
    refresh() {
      let nextStat;
      try {
        nextStat = statSync(path);
      } catch {
        const projection = unavailable(
          "source_unavailable",
          "The exact Session source is unavailable.",
        );
        state.currentProjection = projection;
        return {
          kind: "unavailable",
          version: null,
          projection,
          preflight: null,
          io: { mode: "unavailable", startOffset: state.offset, contentBytesRead: 0 },
        };
      }
      const identity = `${nextStat.dev}:${nextStat.ino}`;
      let mode = state.sourceStat ? "append" : "snapshot";
      const fd = openSync(path, "r");
      let startOffset = state.offset;
      try {
        const replaced = state.identity !== null && state.identity !== identity;
        const truncated = nextStat.size < state.offset;
        const sameSizeChanged =
          state.sourceStat &&
          nextStat.size === state.offset &&
          (nextStat.mtimeMs !== state.sourceStat.mtimeMs ||
            nextStat.ctimeMs !== state.sourceStat.ctimeMs);
        const checkpointChanged =
          nextStat.size > state.offset && state.offset > 0 && !checkpointMatches(fd);
        if (replaced || truncated || sameSizeChanged || checkpointChanged) {
          reset();
          mode = "reset";
          startOffset = 0;
        }
        const contentBytesRead = readRange(fd, state.offset, nextStat.size);
        state.offset += contentBytesRead;
        updateCheckpoint(fd);
        state.identity = identity;
        state.sourceStat = nextStat;
        const preflight = analyzeSessionParentGraph(state.entries, { linear: state.linear });
        const projection = project(sourceVersion(nextStat), preflight);
        let kind = projection.availability === "available" ? mode : "unavailable";
        if (
          kind === "append" &&
          state.currentProjection?.availability === "available" &&
          (!isPrefix(state.currentProjection.activeBranchIds, projection.activeBranchIds) ||
            !isPrefix(state.currentProjection.occurrences, projection.occurrences, sameOccurrence))
        )
          kind = "reset";
        const occurrences =
          kind === "append" && state.currentProjection?.availability === "available"
            ? projection.occurrences.slice(state.currentProjection.occurrences.length)
            : [];
        if (state.currentProjection?.availability !== "available" && kind === "append")
          kind = "reset";
        state.currentProjection = projection;
        return {
          kind,
          version: projection.version,
          projection,
          occurrences,
          preflight,
          io: { mode, startOffset, contentBytesRead },
        };
      } finally {
        closeSync(fd);
      }
    },
    current() {
      return state.currentProjection;
    },
    validatePinnedSource({ leafId, targetId } = {}) {
      if (leafId === null && targetId === null) return { status: "latest" };
      if (typeof targetId !== "string" || !targetId)
        return { status: "unavailable", reason: "pinned_target_required" };
      if (state.currentProjection?.availability !== "available")
        return { status: "unavailable", reason: "pinned_session_unavailable" };
      if (state.linear) {
        if (leafId !== null) return { status: "unavailable", reason: "linear_session_has_no_leaf" };
        const found = state.entries.some(
          (entry) => entry.id === targetId || entry.message?.id === targetId,
        );
        return found
          ? { status: "valid", leafId: null, targetId }
          : { status: "unavailable", reason: "pinned_target_not_found" };
      }
      if (typeof leafId !== "string" || !leafId)
        return { status: "unavailable", reason: "pinned_leaf_required" };
      const leaf = state.byId.get(leafId);
      if (!leaf) return { status: "unavailable", reason: "pinned_leaf_not_found" };
      try {
        const branch = resolveActiveBranch(
          { entries: [leaf], byId: state.byId, linear: false },
          "pinned Pi Session branch",
        );
        return branch.some((entry) => entry.id === targetId)
          ? { status: "valid", leafId, targetId }
          : { status: "unavailable", reason: "target_not_on_leaf_ancestry" };
      } catch {
        return { status: "unavailable", reason: "pinned_leaf_unavailable" };
      }
    },
  };
}

function clientProjection(update) {
  const base = { kind: update.kind, version: update.version };
  if (update.kind === "unavailable")
    return {
      ...base,
      unavailable: {
        reason: update.projection.reason,
        message: update.projection.message,
      },
    };
  if (update.kind === "append")
    return {
      ...base,
      occurrences: update.occurrences.map(renderedOccurrence),
      entryCount: update.projection.entryCount,
      otherEntryCount: update.projection.otherEntryCount,
      rarebitCount: update.projection.occurrences.length,
      activeLeafId: update.projection.activeLeafId,
    };
  return { ...base, projection: renderedProjection(update.projection) };
}

function renderedOccurrence(occurrence) {
  return { ...occurrence, renderedHtml: renderRarebitMarkdown(occurrence.text) };
}

function renderedProjection(projection) {
  return projection?.availability === "available"
    ? { ...projection, occurrences: projection.occurrences.map(renderedOccurrence) }
    : projection;
}

function nativeDegradedHtml(id, result) {
  const depth = result.maxDepth === null ? "unknown" : result.maxDepth.toLocaleString("en-US");
  const count = result.entryCount === null ? "unknown" : result.entryCount.toLocaleString("en-US");
  return `<!doctype html><meta charset="utf-8"><title>Native Pi export unavailable</title>
<style>body{max-width:720px;margin:64px auto;padding:0 24px;background:#18181e;color:#eee;font:16px/1.5 system-ui}a{color:#8bc4ff}code{color:#f0c674}</style>
<h1>Full native trace wasn't loaded</h1>
<p>This exact Session remains valid and its Rarebit view is available, but the installed legacy Pi HTML exporter isn't safe for this parent graph.</p>
<p><code>${esc(result.reason)}</code> · ${esc(count)} entries · maximum parent depth ${esc(depth)} · compatibility limit ${esc(result.limit)}</p>
<p><a href="/raw/${encodeURIComponent(id)}">Download the exact raw Session JSONL</a></p>`;
}

function nativeUnavailableHtml(id, projection) {
  return `<!doctype html><meta charset="utf-8"><title>Native Pi export unavailable</title>
<style>body{max-width:720px;margin:64px auto;padding:0 24px;background:#18181e;color:#eee;font:16px/1.5 system-ui}a{color:#8bc4ff}code{color:#f0c674}</style>
<h1>Full native trace wasn't loaded</h1>
<p>The Rarebit projection is unavailable because Live Detail couldn't resolve a complete active-branch projection from this exact Session, so it did not invoke the native exporter.</p>
<p><code>${esc(projection.reason)}</code> · ${esc(projection.message)}</p>
<p><a href="/raw/${encodeURIComponent(id)}">Download the exact raw Session JSONL</a></p>`;
}

function pinnedSourceUnavailableHtml(id, reason) {
  return `<!doctype html><meta charset="utf-8"><title>Pinned source unavailable</title>
<style>body{max-width:720px;margin:64px auto;padding:0 24px;background:#18181e;color:#eee;font:16px/1.5 system-ui}a{color:#8bc4ff}code{color:#f0c674}</style>
<h1>Pinned source wasn't loaded</h1>
<p>The requested source entry isn't on the specified Session leaf ancestry. Live Detail did not fall back to a different branch.</p>
<p><code>${esc(reason)}</code></p>
<p><a href="/session/${encodeURIComponent(id)}">Return to current Rarebits</a></p>`;
}

function livePage(id, sourceProjection) {
  const initial = renderedProjection(sourceProjection);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Live Pi session ${esc(id)}</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}html,body{max-width:100%;overflow-x:hidden}body{margin:0;background:#18181e;color:#e7e7eb;font:14px/1.5 system-ui}.toolbar{position:sticky;top:0;z-index:2;display:flex;gap:6px;align-items:center;max-width:100%;min-width:0;padding:8px 12px;background:#111d;border-bottom:1px solid #3a3a42;backdrop-filter:blur(8px)}.control-group{display:flex;gap:6px;align-items:center;min-width:0}.tool-wrap{position:relative;display:inline-flex}.collapse-wrap{flex:0 0 auto}.tool-control{min-height:36px;border:1px solid #555;border-radius:6px;background:#292931;color:#eee;padding:6px 9px;text-decoration:none;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:7px;font:inherit;white-space:nowrap}.tool-control.active{background:#e7e7eb;color:#18181e}.tool-control:focus-visible,.jump-native:focus-visible{outline:2px solid #8bc4ff;outline-offset:2px}.tool-icon{display:inline-flex;width:16px;justify-content:center;font-size:15px}.tooltip{display:none;position:absolute;left:50%;top:calc(100% + 8px);translate:-50% 0;width:max-content;max-width:220px;padding:5px 7px;border:1px solid #555;border-radius:5px;background:#050507;color:#f5f5f7;box-shadow:0 4px 16px #0008;font-size:12px;line-height:1.25;pointer-events:none}.tool-wrap:hover>.tooltip,.tool-wrap:focus-within>.tooltip{display:block}.toolbar.collapsed .tool-label{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}.toolbar.collapsed .tool-control{width:36px;padding-inline:6px}.toolbar.collapsed .summary{display:none}.summary{min-width:0;margin-left:auto;overflow:hidden;color:#bbb;text-overflow:ellipsis;white-space:nowrap}.status{padding:10px 18px;color:#bbb;border-bottom:1px solid #303038}main{width:100%;max-width:980px;min-width:0;margin:0 auto;padding:18px}.occurrence{scroll-margin-top:72px;padding:16px 0;border-bottom:1px solid #333}.meta{display:flex;gap:8px;align-items:center;color:#aaa;font-size:12px}.role{color:#eee;font-weight:650}.source{color:#8bc4ff}.jump-native{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;margin-left:auto;border:1px solid #4b5563;border-radius:5px;background:#24242b;color:#b9d9ff;text-decoration:none;cursor:pointer;font:14px system-ui}.prose{overflow-wrap:anywhere;margin:10px 0 0}.prose pre{white-space:pre-wrap;overflow:auto;padding:10px;background:#111;border-radius:6px}iframe{width:100%;height:calc(100vh - 53px);border:0;background:#18181e}.failure{max-width:760px;margin:40px auto;padding:18px;border:1px solid #824;border-radius:8px;background:#2b171d;color:#ffdfe6}[hidden]{display:none!important}@media(max-width:560px){.toolbar{padding-inline:6px}.control-group{flex:1 1 auto;overflow-x:auto;overscroll-behavior-inline:contain;scrollbar-width:thin}.summary{display:none}.tooltip{display:none}}
@media(max-width:560px){.tool-wrap:hover>.tooltip,.tool-wrap:focus-within>.tooltip{display:none}}
</style></head><body>
<header id="toolbar" class="toolbar" aria-label="Session detail controls">
<div class="control-group" role="group" aria-label="Session detail views">
<span class="tool-wrap"><button id="rarebit-button" class="tool-control active" aria-pressed="true" aria-describedby="tooltip-rarebits"><span class="tool-icon" aria-hidden="true">◆</span><span class="tool-label">Rarebits</span></button><span id="tooltip-rarebits" class="tooltip" role="tooltip">Show selected Rarebits</span></span>
<span class="tool-wrap"><button id="native-button" class="tool-control" aria-pressed="false" aria-describedby="tooltip-native"><span class="tool-icon" aria-hidden="true">▤</span><span class="tool-label">Full native</span></button><span id="tooltip-native" class="tooltip" role="tooltip">Load the full native trace</span></span>
<span class="tool-wrap"><a id="raw-link" class="tool-control" href="/raw/${encodeURIComponent(id)}" aria-describedby="tooltip-raw"><span class="tool-icon" aria-hidden="true">⇩</span><span class="tool-label">Raw JSONL</span></a><span id="tooltip-raw" class="tooltip" role="tooltip">Download exact Session JSONL</span></span>
</div>
<span class="tool-wrap collapse-wrap"><button id="collapse-button" class="tool-control" aria-expanded="true" aria-describedby="tooltip-collapse"><span id="collapse-icon" class="tool-icon" aria-hidden="true">‹</span><span id="collapse-label" class="tool-label">Collapse</span></button><span id="tooltip-collapse" class="tooltip" role="tooltip">Collapse toolbar</span></span>
<span id="summary" class="summary"></span></header>
<div id="status" class="status">Live · exact active branch · ${esc(RAREBIT_SELECTOR_VERSION)}</div>
<main id="rarebit-messages"></main><iframe id="native-view" title="Full native Pi trace" hidden></iframe>
<script>
const sessionId=${scriptJson(id)},initial=${scriptJson(initial)};
const toolbar=document.querySelector('#toolbar'),rarebitButton=document.querySelector('#rarebit-button'),nativeButton=document.querySelector('#native-button'),collapseButton=document.querySelector('#collapse-button'),collapseIcon=document.querySelector('#collapse-icon'),collapseLabel=document.querySelector('#collapse-label'),collapseTooltip=document.querySelector('#tooltip-collapse'),messages=document.querySelector('#rarebit-messages'),nativeView=document.querySelector('#native-view'),summary=document.querySelector('#summary'),status=document.querySelector('#status');
let nativeLoaded=false,nativePinned=false,nativeEntry=null,nativeLeaf=null,currentLeafId=initial.activeLeafId||null,currentVersion=initial.version||null;
function sourceHref(entryId,leafId){const url=new URL('/session/'+encodeURIComponent(sessionId),location.href);url.searchParams.set('view','native');if(leafId)url.searchParams.set('leaf',leafId);url.searchParams.set('entry',entryId);return url.pathname+url.search}
function occurrenceNode(item,leafId=currentLeafId){const article=document.createElement('article');article.className='occurrence';if(item.sourceEntryId)article.id='entry-'+item.sourceEntryId;const meta=document.createElement('div');meta.className='meta';const role=document.createElement('span');role.className='role';role.textContent=item.role==='user'?'User message':item.outcome==='continuation'?'Agent continuation':'Agent stop';meta.append(role);if(item.timestamp){const time=document.createElement('time');time.textContent=item.timestamp;meta.append(time)}if(item.sourceEntryId){const source=document.createElement('span');source.className='source';source.textContent='source '+item.sourceEntryId;const jump=document.createElement('a');jump.className='jump-native';jump.dataset.entryId=item.sourceEntryId;jump.href=sourceHref(item.sourceEntryId,leafId);jump.setAttribute('aria-label','Open source '+item.sourceEntryId+' in full native trace');jump.textContent='↗';meta.append(source,jump)}const prose=document.createElement('div');prose.className='prose';if(typeof item.renderedHtml==='string')prose.innerHTML=item.renderedHtml;else prose.textContent=item.text;article.append(meta,prose);return article}
function setCounts(rarebitCount,otherEntryCount){summary.textContent=rarebitCount+' Rarebits · '+otherEntryCount+' other entries not loaded'}
function showUnavailable(problem){messages.replaceChildren();const box=document.createElement('div');box.className='failure';box.textContent='Rarebit projection unavailable: '+(problem?.message||problem?.reason||'unknown source failure');messages.append(box);summary.textContent='Rarebits unavailable';status.textContent='Live · explicit source failure'}
function renderProjection(projection){if(projection?.availability!=='available'){showUnavailable(projection);return}currentLeafId=projection.activeLeafId||null;messages.replaceChildren(...projection.occurrences.map(item=>occurrenceNode(item,currentLeafId)));setCounts(projection.occurrences.length,projection.otherEntryCount);status.textContent='Live · exact active branch · '+projection.selectorVersion}
function nativeUrl(version){const url=new URL('/render/'+encodeURIComponent(sessionId),location.href);if(nativePinned){if(nativeLeaf)url.searchParams.set('leafId',nativeLeaf);url.searchParams.set('targetId',nativeEntry)}if(version)url.searchParams.set('v',version);return url.pathname+url.search}
function showRarebits(){rarebitButton.classList.add('active');rarebitButton.setAttribute('aria-pressed','true');nativeButton.classList.remove('active');nativeButton.setAttribute('aria-pressed','false');messages.hidden=false;status.hidden=false;nativeView.hidden=true}
function showNative(entryId,leafId){nativeLoaded=true;nativePinned=typeof entryId==='string';nativeEntry=nativePinned?entryId:null;nativeLeaf=nativePinned&&typeof leafId==='string'?leafId:null;rarebitButton.classList.remove('active');rarebitButton.setAttribute('aria-pressed','false');nativeButton.classList.add('active');nativeButton.setAttribute('aria-pressed','true');messages.hidden=true;status.hidden=true;nativeView.hidden=false;nativeView.src=nativeUrl(currentVersion)}
function setToolbarExpanded(expanded){toolbar.classList.toggle('collapsed',!expanded);collapseButton.setAttribute('aria-expanded',String(expanded));collapseIcon.textContent=expanded?'‹':'›';collapseLabel.textContent=expanded?'Collapse':'Expand';collapseTooltip.textContent=expanded?'Collapse toolbar':'Expand toolbar'}
rarebitButton.addEventListener('click',showRarebits);nativeButton.addEventListener('click',()=>showNative());collapseButton.addEventListener('click',()=>setToolbarExpanded(toolbar.classList.contains('collapsed')));renderProjection(initial);const requestedView=new URL(location.href).searchParams;if(requestedView.get('view')==='native'&&requestedView.get('entry'))showNative(requestedView.get('entry'),requestedView.get('leaf'));
new EventSource('/api/events/'+encodeURIComponent(sessionId)).onmessage=event=>{const update=JSON.parse(event.data);currentVersion=update.version||currentVersion;if(nativeLoaded){if(!nativePinned)nativeView.src=nativeUrl(currentVersion||String(Date.now()));return}if(update.kind==='unavailable'){showUnavailable(update.unavailable);return}if(update.kind==='append'){currentLeafId=update.activeLeafId||null;messages.append(...update.occurrences.map(item=>occurrenceNode(item,currentLeafId)));setCounts(update.rarebitCount,update.otherEntryCount);return}renderProjection(update.projection)};
</script></body></html>`;
}

export function createLiveDetailServer({
  sessionsRoot,
  cacheRoot = join(homedir(), ".cache", "pi-session-live"),
  env = process.env,
  exportCommand,
  exporterRevision,
  exporterCapability,
  exporterVersion,
  maxNativeExportDepth = DEFAULT_NATIVE_EXPORT_MAX_DEPTH,
  nativeExporterStackSafe,
  exporter,
  watchSources = createSourceWatcher,
} = {}) {
  const exporterIdentity = resolveNativeExporter({
    env,
    exportCommand,
    exporterRevision,
    exporterCapability,
    exporterVersion,
    nativeExporterStackSafe,
  });
  const invokeExporter =
    exporter ??
    (async (source, output) => {
      await run(exporterIdentity.executable, ["--export", source, output], { timeout: 60_000 });
    });
  const registry = new SessionRegistry({ sessionsRoot }).refresh();
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  const clients = new Map();
  const readers = new Map();
  const renderedVersions = new Map();
  const exporting = new Map();
  const exportTails = new Map();
  let exportSequence = 0;
  const rendered = (id) => join(cacheRoot, `${id}.html`);

  const readerFor = (id) => {
    const source = registry.get(id);
    if (!source) return null;
    const existing = readers.get(id);
    if (existing?.path === source) return existing;
    const reader = createIncrementalRarebitReader(source);
    readers.set(id, reader);
    return reader;
  };

  async function renderNative(id, snapshot) {
    const source = registry.get(id);
    if (!source) return false;
    const version = `${snapshot.version}:${exporterIdentity.identity}`;
    if (renderedVersions.get(id) === version && existsSync(rendered(id))) return true;
    const exportKey = `${id}:${version}`;
    if (exporting.has(exportKey)) return exporting.get(exportKey);
    const previous = exportTails.get(id);
    const job = (async () => {
      if (previous)
        try {
          await previous;
        } catch {
          // A newer generation still gets its own attempt after an older export fails.
        }
      if (renderedVersions.get(id) === version && existsSync(rendered(id))) return true;
      try {
        if (registry.get(id) !== source || sourceVersion(statSync(source)) !== snapshot.version)
          return false;
      } catch {
        return false;
      }
      const tmp = join(cacheRoot, `.${id}.${process.pid}.${++exportSequence}.tmp.html`);
      try {
        await invokeExporter(source, tmp);
        const output = statSync(tmp);
        if (!output.isFile() || output.size === 0)
          throw new Error("Native exporter produced no HTML document");
        let sourceUnchanged = false;
        try {
          sourceUnchanged =
            registry.get(id) === source && sourceVersion(statSync(source)) === snapshot.version;
        } catch {
          sourceUnchanged = false;
        }
        if (!sourceUnchanged) {
          rmSync(tmp, { force: true });
          return false;
        }
        chmodSync(tmp, 0o600);
        renameSync(tmp, rendered(id));
        renderedVersions.set(id, version);
        return true;
      } catch (error) {
        rmSync(tmp, { force: true, recursive: true });
        throw error;
      }
    })();
    exporting.set(exportKey, job);
    exportTails.set(id, job);
    const clear = () => {
      exporting.delete(exportKey);
      if (exportTails.get(id) === job) exportTails.delete(id);
    };
    job.then(clear, clear);
    return job;
  }

  async function serveNative(id, reader, url, res) {
    let update = reader.refresh();
    let stable = false;
    for (let attempt = 0; attempt < NATIVE_EXPORT_STABILITY_ATTEMPTS; attempt += 1) {
      const pinnedSource = reader.validatePinnedSource({
        leafId: url.searchParams.get("leafId"),
        targetId: url.searchParams.get("targetId"),
      });
      if (pinnedSource.status === "unavailable") {
        res.writeHead(422, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-hypercarrier-degraded-reason": pinnedSource.reason,
        });
        return res.end(pinnedSourceUnavailableHtml(id, pinnedSource.reason));
      }
      if (update.projection.availability !== "available") {
        res.writeHead(422, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-hypercarrier-degraded-reason": update.projection.reason,
        });
        return res.end(nativeUnavailableHtml(id, update.projection));
      }
      const check = nativeExportPreflight(update.projection, {
        maxDepth: maxNativeExportDepth,
        stackSafe: exporterIdentity.capability === "stack-safe",
      });
      if (check.status !== "supported") {
        res.writeHead(422, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-hypercarrier-degraded-reason": check.reason,
        });
        return res.end(nativeDegradedHtml(id, check));
      }
      try {
        stable = await renderNative(id, update.projection);
      } catch {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        return res.end("Native Pi export failed; the Rarebit view remains available.");
      }
      if (stable) break;
      update = reader.refresh();
    }
    if (!stable) {
      res.writeHead(503, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": "1",
      });
      return res.end(
        "Native Pi export could not stabilize while the Session was changing; retry shortly. The Rarebit view remains available.",
      );
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    return createReadStream(rendered(id)).pipe(res);
  }

  const watcher = watchSources(
    ({ paths }) => {
      registry.refreshPaths(paths);
      const changed = new Set(paths);
      for (const [id, reader] of readers)
        if (registry.lastRefresh.mode === "full" || changed.has(reader.path)) {
          if (registry.byId.get(id) !== reader.path) {
            readers.delete(id);
            const payload = `data: ${JSON.stringify({
              kind: "unavailable",
              version: null,
              unavailable: {
                reason: "exact_session_identity_changed",
                message: "The watched path no longer contains this exact Session identity.",
              },
            })}\n\n`;
            for (const client of clients.get(id) ?? []) {
              client.write(payload);
              client.end();
            }
            clients.delete(id);
            continue;
          }
          const update = reader.refresh();
          const payload = `data: ${JSON.stringify(clientProjection(update))}\n\n`;
          for (const client of clients.get(id) ?? []) client.write(payload);
        }
    },
    { roots: [sessionsRoot ?? join(homedir(), ".pi", "agent", "sessions")] },
  );

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const sessionMatch = url.pathname.match(/^\/session\/([^/]+)$/);
    const renderMatch = url.pathname.match(/^\/render\/([^/]+)$/);
    const rawMatch = url.pathname.match(/^\/raw\/([^/]+)$/);
    const eventsMatch = url.pathname.match(/^\/api\/events\/([^/]+)$/);
    if (req.method === "GET" && sessionMatch) {
      const id = decodeURIComponent(sessionMatch[1]);
      const reader = readerFor(id);
      if (!reader) {
        res.writeHead(404);
        return res.end("Unknown session");
      }
      const update = reader.refresh();
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      return res.end(livePage(id, update.projection));
    }
    if (req.method === "GET" && renderMatch) {
      const id = decodeURIComponent(renderMatch[1]);
      const reader = readerFor(id);
      if (!reader) {
        res.writeHead(404);
        return res.end("Unknown session");
      }
      return serveNative(id, reader, url, res);
    }
    if (req.method === "GET" && rawMatch) {
      const id = decodeURIComponent(rawMatch[1]);
      const source = registry.get(id);
      if (!source) {
        res.writeHead(404);
        return res.end("Unknown session");
      }
      res.writeHead(200, {
        "content-type": "application/x-ndjson",
        "content-disposition": `attachment; filename="${id}.jsonl"`,
        "cache-control": "no-store",
      });
      return createReadStream(source).pipe(res);
    }
    if (req.method === "GET" && eventsMatch) {
      const id = decodeURIComponent(eventsMatch[1]);
      if (!readerFor(id)) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write("event: ready\ndata: {}\n\n");
      const set = clients.get(id) ?? new Set();
      set.add(res);
      clients.set(id, set);
      req.on("close", () => set.delete(res));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({ ok: true, sessions: registry.byId.size, exporter: exporterIdentity }),
      );
    }
    res.writeHead(404);
    res.end("Not found");
  });
  server.on("close", () => watcher.close());
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = resolveServicePort("live"),
    host = resolveCoreHost();
  createLiveDetailServer().listen(port, host, () =>
    console.log(`Pi live detail at http://${host}:${port}`),
  );
}
