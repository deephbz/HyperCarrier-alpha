import {
  closeSync,
  createReadStream,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RAREBIT_SELECTOR_VERSION,
  resolveActiveBranch,
  selectRarebits,
} from "@hypercarrier/rarebit";
import { createSourceWatcher } from "./watcher.js";
import { SessionRegistry } from "./session-registry.js";
import { resolveCoreHost, resolveServicePort } from "./service-config.js";

const READ_CHUNK_BYTES = 1024 * 1024;
const SOURCE_HEADER_BYTES = 64 * 1024;
export const MAX_TRACE_SOURCE_BYTES = 16 * 1024 * 1024;
const TRACE_SCHEMA_VERSION = "pi-trace/1";
const TRACE_STATIC_DIR = fileURLToPath(new URL("../dist/trace-viewer/", import.meta.url));
const MIME = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".woff2", "font/woff2"],
]);

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function sourceVersion(sourceStat) {
  return `${sourceStat.dev}:${sourceStat.ino}:${sourceStat.size}:${sourceStat.mtimeMs}`;
}

function pinnedSessionId(fd) {
  const buffer = Buffer.allocUnsafe(SOURCE_HEADER_BYTES);
  const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
  const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
  const end = newline >= 0 ? newline : bytesRead < buffer.length ? bytesRead : -1;
  if (end < 0) return null;
  try {
    const header = JSON.parse(buffer.subarray(0, end).toString("utf8"));
    return header?.type === "session" && typeof header.id === "string" ? header.id : null;
  } catch {
    return null;
  }
}

/** Open and verify the exact source inode before a raw download begins. */
export function openPinnedSource(source, expectedVersion, expectedSessionId) {
  const fd = openSync(source, "r");
  try {
    const sourceStat = fstatSync(fd);
    if (
      sourceVersion(sourceStat) !== expectedVersion ||
      (expectedSessionId !== undefined && pinnedSessionId(fd) !== expectedSessionId)
    ) {
      closeSync(fd);
      return null;
    }
    return { fd, size: sourceStat.size };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function unavailable(reason, message, details = {}) {
  return { availability: "unavailable", reason, message, ...details };
}

function isPrefix(previous, next, same = (left, right) => left === right) {
  return previous.length <= next.length && previous.every((item, index) => same(item, next[index]));
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (typeof block === "string") return [block];
      if (!block || typeof block !== "object") return [];
      if (typeof block.text === "string") return [block.text];
      if (typeof block.thinking === "string") return [block.thinking];
      if (block.type === "toolCall") {
        const name = typeof block.name === "string" ? block.name : "tool call";
        const argumentsText =
          typeof block.arguments === "string"
            ? block.arguments
            : JSON.stringify(block.arguments ?? {});
        return [`${name} ${argumentsText}`.trim()];
      }
      return [];
    })
    .join("\n");
}

function timestampOf(entry) {
  const timestamp = entry?.message?.timestamp ?? entry?.timestamp;
  return typeof timestamp === "string" || typeof timestamp === "number" ? timestamp : null;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function entryPresentation(entry) {
  const message = plainObject(entry?.message);
  const role = message.role;
  if (entry?.type === "message") {
    if (role === "user") return { kind: "input", lane: "input", label: "User message" };
    if (role === "assistant")
      return { kind: "assistant", lane: "model", label: "Assistant message" };
    if (role === "toolResult") return { kind: "tool_result", lane: "tools", label: "Tool result" };
    return { kind: "message", lane: "input", label: "Message" };
  }
  if (entry?.type === "compaction")
    return { kind: "compaction", lane: "model", label: "Compaction" };
  if (entry?.type === "model_change")
    return { kind: "model_change", lane: "model", label: "Model change" };
  if (entry?.type === "thinking_level_change")
    return { kind: "thinking_level_change", lane: "model", label: "Thinking level change" };
  if (entry?.type === "session_info")
    return { kind: "session_info", lane: "input", label: "Session information" };
  if (entry?.type === "label") return { kind: "label", lane: "input", label: "Session label" };
  if (entry?.type === "branch_summary")
    return { kind: "branch_summary", lane: "model", label: "Branch summary" };
  if (entry?.type === "custom_message")
    return { kind: "custom_message", lane: "input", label: "Custom message" };
  if (entry?.type === "custom") return { kind: "custom", lane: "input", label: "Custom entry" };
  return {
    kind: "unknown",
    lane: "input",
    label: typeof entry?.type === "string" ? `Unknown: ${entry.type}` : "Unknown entry",
  };
}

function entryDetails(entry) {
  const message = plainObject(entry?.message);
  const toolCalls = Array.isArray(message.content)
    ? message.content.flatMap((block) =>
        block?.type === "toolCall" && typeof block.id === "string"
          ? [
              {
                id: block.id,
                name: typeof block.name === "string" ? block.name : "tool call",
                arguments: block.arguments ?? null,
              },
            ]
          : [],
      )
    : [];
  const usage = plainObject(message.usage);
  return {
    ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
    ...(typeof message.provider === "string" ? { provider: message.provider } : {}),
    ...(typeof message.model === "string" ? { model: message.model } : {}),
    ...(typeof entry?.provider === "string" ? { provider: entry.provider } : {}),
    ...(typeof entry?.modelId === "string" ? { model: entry.modelId } : {}),
    ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
    ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
    ...(message.isError === true ? { isError: true } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(Object.keys(usage).length ? { usage } : {}),
  };
}

function traceRecords(branch, selectedSourceEntryIds) {
  let turn = 0;
  let step = 0;
  const records = branch.map((entry, index) => {
    const presentation = entryPresentation(entry);
    const message = plainObject(entry?.message);
    if (entry?.type === "message" && message.role === "user") {
      turn += 1;
      step = 0;
    }
    if (entry?.type === "message" && message.role === "assistant") step += 1;
    const sourceEntryId = typeof entry?.id === "string" ? entry.id : null;
    return {
      recordId: sourceEntryId ? `entry:${sourceEntryId}` : `position:${index}`,
      sourceEntryId,
      order: index,
      kind: presentation.kind,
      lane: presentation.lane,
      label: presentation.label,
      turn: turn || null,
      step: step || null,
      timestamp: timestampOf(entry),
      text: textContent(message.content),
      rarebit: sourceEntryId !== null && selectedSourceEntryIds.has(sourceEntryId),
      details: entryDetails(entry),
      unavailable: {
        duration: "Pi Session JSONL does not record request duration.",
        toolSchema: "Pi Session JSONL does not record the call-time tool schema.",
        requestStart: "Pi Session JSONL does not record provider request start events.",
        streamingChunks: "Pi Session JSONL does not record provider streaming chunks.",
        systemPrompt: "Pi Session JSONL does not record the complete system prompt.",
      },
      raw: entry,
    };
  });
  const toolCallSources = new Map();
  for (const record of records)
    for (const call of record.details.toolCalls ?? []) {
      const existing = toolCallSources.get(call.id);
      toolCallSources.set(
        call.id,
        existing
          ? { count: existing.count + 1, recordId: null }
          : { count: 1, recordId: record.recordId },
      );
    }
  return records.map((record) => {
    const toolCallId = record.details.toolCallId;
    const candidate = typeof toolCallId === "string" ? toolCallSources.get(toolCallId) : null;
    return typeof toolCallId === "string"
      ? {
          ...record,
          toolCallRecordId: candidate?.count === 1 ? candidate.recordId : null,
        }
      : record;
  });
}

/**
 * Adapts one resolved Pi active branch to the trace-viewer contract. Pi JSONL
 * remains the evidence authority; this object is an exact-session projection.
 */
export function projectPiTrace(projection) {
  if (projection?.availability !== "available") return projection;
  const selected = selectRarebits(projection.activeBranch);
  const selectedSourceEntryIds = new Set(
    selected.occurrences
      .map((occurrence) => occurrence.sourceEntryId)
      .filter((id) => typeof id === "string"),
  );
  return {
    availability: "available",
    schemaVersion: TRACE_SCHEMA_VERSION,
    sessionId: projection.sessionId,
    sourceVersion: projection.version,
    selectorVersion: RAREBIT_SELECTOR_VERSION,
    activeLeafId: projection.activeLeafId,
    activeBranchIds: projection.activeBranchIds,
    records: traceRecords(projection.activeBranch, selectedSourceEntryIds),
    selection: {
      selectorVersion: RAREBIT_SELECTOR_VERSION,
      manifestHash: selected.manifestHash,
      rarebitSourceEntryIds: [...selectedSourceEntryIds],
    },
  };
}

/**
 * Incrementally reads one exact Session source. It retains full raw records only
 * in this exact-session service; no fleet route receives this projection.
 */
export function createIncrementalTraceReader(path) {
  const state = {
    identity: null,
    sourceStat: null,
    offset: 0,
    pending: Buffer.alloc(0),
    contentHasher: createHash("sha256"),
    contentDigest: null,
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
    state.contentHasher = createHash("sha256");
    state.contentDigest = null;
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
    state.entries.push(record);
    if (!state.linear) state.byId.set(record.id, record);
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
      const chunk = buffer.subarray(0, bytesRead);
      state.contentHasher.update(chunk);
      acceptBytes(chunk);
      position += bytesRead;
    }
    return position - start;
  };

  const digestRange = (fd, end) => {
    const hasher = createHash("sha256");
    let position = 0;
    while (position < end) {
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, end - position));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hasher.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return { bytesRead: position, digest: hasher.digest("hex") };
  };

  const project = (version) => {
    if (state.parseFailure) return { ...state.parseFailure, version };
    if (!state.header)
      return unavailable(
        "session_header_pending",
        "The exact Session header is not complete yet.",
        {
          version,
        },
      );
    let activeBranch;
    try {
      activeBranch = resolveActiveBranch(
        { entries: state.entries, byId: state.byId, linear: state.linear },
        "exact Pi Session",
      );
    } catch (error) {
      return unavailable("active_branch_unavailable", error.message, { version });
    }
    return {
      availability: "available",
      sessionId: state.header.id,
      version,
      activeLeafId: state.linear ? null : (activeBranch.at(-1)?.id ?? null),
      activeBranchIds: activeBranch.map((entry) => entry.id).filter((id) => typeof id === "string"),
      activeBranch,
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
          io: { mode: "unavailable", startOffset: state.offset, contentBytesRead: 0 },
        };
      }
      const identity = `${nextStat.dev}:${nextStat.ino}`;
      if (nextStat.size > MAX_TRACE_SOURCE_BYTES) {
        const projection = unavailable(
          "trace_source_too_large",
          "The exact Session is too large for the Trace Viewer projection. Download raw JSONL.",
          {
            version: sourceVersion(nextStat),
            sourceBytes: nextStat.size,
            maxProjectionBytes: MAX_TRACE_SOURCE_BYTES,
          },
        );
        state.currentProjection = projection;
        return {
          kind: "unavailable",
          version: projection.version,
          projection,
          io: {
            mode: "unavailable",
            startOffset: state.offset,
            contentBytesRead: 0,
            integrityBytesRead: 0,
          },
        };
      }
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
        const integrity =
          nextStat.size > state.offset && state.offset > 0 && state.contentDigest !== null
            ? digestRange(fd, state.offset)
            : { bytesRead: 0, digest: null };
        const prefixChanged = integrity.digest !== null && integrity.digest !== state.contentDigest;
        if (replaced || truncated || sameSizeChanged || prefixChanged) {
          reset();
          mode = "reset";
          startOffset = 0;
        }
        const contentBytesRead = readRange(fd, state.offset, nextStat.size);
        state.offset += contentBytesRead;
        state.contentDigest = state.contentHasher.copy().digest("hex");
        state.identity = identity;
        state.sourceStat = nextStat;
        const projection = project(sourceVersion(nextStat));
        let kind = projection.availability === "available" ? mode : "unavailable";
        if (
          kind === "append" &&
          state.currentProjection?.availability === "available" &&
          !isPrefix(state.currentProjection.activeBranchIds, projection.activeBranchIds)
        )
          kind = "reset";
        if (state.currentProjection?.availability !== "available" && kind === "append")
          kind = "reset";
        state.currentProjection = projection;
        return {
          kind,
          version: projection.version,
          projection,
          io: { mode, startOffset, contentBytesRead, integrityBytesRead: integrity.bytesRead },
        };
      } finally {
        closeSync(fd);
      }
    },
    current() {
      return state.currentProjection;
    },
  };
}

function safeStaticPath(staticDir, rawPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { error: "invalid_path" };
  }
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.split("/").includes(".."))
    return { error: "invalid_path" };
  const root = resolve(staticDir);
  const candidate = resolve(root, `.${decoded}`);
  const fromRoot = relative(root, candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) return { error: "invalid_path" };
  return { root, candidate };
}

function staticTraceResponse(req, res, staticDir, rawPath) {
  const safe = safeStaticPath(staticDir, rawPath);
  if (safe.error) return json(res, 400, { error: safe.error });
  const index = join(safe.root, "index.html");
  if (!existsSync(index) || !statSync(index).isFile())
    return json(res, 503, {
      error: "trace_viewer_build_not_found",
      message:
        "Build the Trace Viewer with npm run build:trace-viewer before starting its service.",
    });
  const file = rawPath === "/" ? index : safe.candidate;
  if (!existsSync(file) || !statSync(file).isFile())
    return json(res, 404, { error: "static_asset_not_found" });
  const actualRoot = realpathSync(safe.root);
  const actualFile = realpathSync(file);
  if (actualFile !== actualRoot && !actualFile.startsWith(`${actualRoot}${sep}`))
    return json(res, 403, { error: "path_outside_web_root" });
  res.writeHead(200, {
    "content-type": MIME.get(extname(actualFile).toLowerCase()) ?? "application/octet-stream",
    "content-length": statSync(actualFile).size,
    "cache-control": actualFile.split(sep).includes("assets")
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") return res.end();
  return createReadStream(actualFile).pipe(res);
}

function routeSessionId(encoded) {
  try {
    return { id: decodeURIComponent(encoded) };
  } catch {
    return { error: "invalid_session_id" };
  }
}

function exactSourceError(resolution) {
  if (resolution.kind === "ambiguous")
    return {
      status: 409,
      body: unavailable(
        "ambiguous_session_source",
        "More than one local source declares this Session ID. Select a source only through a future explicit contract.",
      ),
    };
  return { status: 404, body: { error: "session_not_found" } };
}

function sourceChanged(registry, id, source, version) {
  try {
    return registry.get(id) !== source || sourceVersion(statSync(source)) !== version;
  } catch {
    return true;
  }
}

export function createLiveDetailServer({
  sessionsRoot,
  staticDir = TRACE_STATIC_DIR,
  watchSources = createSourceWatcher,
} = {}) {
  const registry = new SessionRegistry({ sessionsRoot }).refresh();
  const clients = new Map();
  const readers = new Map();

  const readerFor = (id, source) => {
    const existing = readers.get(id);
    if (existing?.path === source) return existing;
    const reader = createIncrementalTraceReader(source);
    readers.set(id, reader);
    return reader;
  };

  const exactTrace = (id, reader) => {
    const resolution = registry.resolve(id);
    const source = resolution.kind === "resolved" ? resolution.source : null;
    if (!source) return exactSourceError(resolution);
    if (source !== reader.path)
      return {
        status: 409,
        body: unavailable(
          "exact_session_identity_changed",
          "This exact Session source changed while its trace projection was prepared. Retry the request.",
        ),
      };
    const update = reader.refresh();
    if (update.projection.availability !== "available")
      return {
        status: update.projection.reason === "trace_source_too_large" ? 413 : 422,
        body: update.projection,
      };
    if (update.projection.sessionId !== id || sourceChanged(registry, id, source, update.version))
      return {
        status: 409,
        body: unavailable(
          "source_changed_during_projection",
          "The exact Session changed while its trace projection was prepared. Retry the request.",
        ),
      };
    return {
      status: 200,
      body: projectPiTrace(update.projection),
      source,
      version: update.version,
    };
  };

  const watcher = watchSources(
    ({ paths }) => {
      registry.refreshPaths(paths);
      const changed = new Set(paths);
      for (const [id, reader] of readers)
        if (registry.lastRefresh.mode === "full" || changed.has(reader.path)) {
          const resolution = registry.resolve(id);
          if (resolution.kind !== "resolved" || resolution.source !== reader.path) {
            readers.delete(id);
            const payload = JSON.stringify({
              reason:
                resolution.kind === "ambiguous"
                  ? "ambiguous_session_source"
                  : "exact_session_identity_changed",
              version: null,
            });
            for (const client of clients.get(id) ?? []) {
              client.write(`event: invalidate\ndata: ${payload}\n\n`);
              client.end();
            }
            clients.delete(id);
            continue;
          }
          const update = reader.refresh();
          const payload = JSON.stringify({
            reason: update.kind,
            version: update.version,
          });
          for (const client of clients.get(id) ?? [])
            client.write(`event: invalidate\ndata: ${payload}\n\n`);
        }
    },
    { roots: [sessionsRoot ?? join(homedir(), ".pi", "agent", "sessions")] },
  );

  const exactRoute = (encoded, res) => {
    const route = routeSessionId(encoded);
    if (route.error) {
      json(res, 400, { error: route.error });
      return null;
    }
    const resolution = registry.resolve(route.id);
    if (resolution.kind === "resolved") return { id: route.id, source: resolution.source };
    const error = exactSourceError(resolution);
    json(res, error.status, error.body);
    return null;
  };

  const serveTrace = (encoded, res) => {
    const route = exactRoute(encoded, res);
    if (!route) return;
    const trace = exactTrace(route.id, readerFor(route.id, route.source));
    return json(res, trace.status, trace.body);
  };

  const serveRaw = (encoded, res) => {
    const route = exactRoute(encoded, res);
    if (!route) return;
    let version;
    let pinned;
    try {
      version = registry.version(route.id);
      pinned = version ? openPinnedSource(route.source, version, route.id) : null;
    } catch {
      return json(res, 404, { error: "session_not_found" });
    }
    if (!pinned || sourceChanged(registry, route.id, route.source, version)) {
      if (pinned) closeSync(pinned.fd);
      return json(res, 409, {
        error: "source_changed_during_raw_download",
        message: "The exact Session changed before raw download began. Retry the request.",
      });
    }
    res.writeHead(200, {
      "content-type": "application/x-ndjson",
      "content-disposition": `attachment; filename="${route.id}.jsonl"`,
      "content-length": pinned.size,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-hypercarrier-source-version": version,
    });
    return createReadStream(route.source, {
      fd: pinned.fd,
      autoClose: true,
      start: 0,
      ...(pinned.size > 0 ? { end: pinned.size - 1 } : {}),
    }).pipe(res);
  };

  const serveEvents = (encoded, req, res) => {
    const route = exactRoute(encoded, res);
    if (!route) return;
    readerFor(route.id, route.source);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write("event: ready\ndata: {}\n\n");
    const set = clients.get(route.id) ?? new Set();
    set.add(res);
    clients.set(route.id, set);
    req.on("close", () => {
      set.delete(res);
      if (set.size === 0) clients.delete(route.id);
    });
  };

  const serveSession = (encoded, req, res) => {
    if (!exactRoute(encoded, res)) return;
    return staticTraceResponse(req, res, staticDir, "/");
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const traceMatch = url.pathname.match(/^\/api\/trace\/([^/]+)$/);
    const rawMatch = url.pathname.match(/^\/raw\/([^/]+)$/);
    const eventsMatch = url.pathname.match(/^\/api\/events\/([^/]+)$/);
    const sessionMatch = url.pathname.match(/^\/session\/([^/]+)$/);

    if (req.method === "GET" && traceMatch) return serveTrace(traceMatch[1], res);
    if (req.method === "GET" && rawMatch) return serveRaw(rawMatch[1], res);
    if (req.method === "GET" && eventsMatch) return serveEvents(eventsMatch[1], req, res);
    if (req.method === "GET" && url.pathname === "/api/health")
      return json(res, 200, {
        ok: true,
        sessions: registry.byId.size,
        traceSchemaVersion: TRACE_SCHEMA_VERSION,
        traceViewer: { staticDir, built: existsSync(join(staticDir, "index.html")) },
      });
    if (req.method === "GET" && sessionMatch) return serveSession(sessionMatch[1], req, res);
    if (req.method === "GET" || req.method === "HEAD")
      return staticTraceResponse(req, res, staticDir, url.pathname);
    return json(res, 404, { error: "not_found" });
  });
  server.on("close", () => watcher.close());
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = resolveServicePort("live");
  const host = resolveCoreHost();
  createLiveDetailServer().listen(port, host, () =>
    console.log(`Pi trace viewer at http://${host}:${port}`),
  );
}
