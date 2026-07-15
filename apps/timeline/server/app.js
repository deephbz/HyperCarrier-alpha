import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { collectAlphaSnapshot, createAlphaSourceWatcher } from "./alpha.js";
import { collectSnapshot, SessionCache } from "./collector.js";
import {
  readSessionKeyMessageSummary,
  sanitizeKeyMessageSummaryDetail,
} from "./key-msg-summary-detail.js";
import { createSourceWatcher } from "./watcher.js";

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

const ALPHA_SOURCE_KINDS = new Set([
  "alpha-source",
  "beads",
  "evergreen",
  "project-events",
  "project-manifest",
  "project-registry",
  "summary",
  "timeline-runtime",
]);
const ALPHA_REASONS = new Set(["request", "filesystem", "alpha-filesystem", "reconciliation"]);

export function sanitizeAlphaEvent(event = {}) {
  const paths = Array.isArray(event.paths)
    ? event.paths
        .filter((path) => typeof path === "string")
        .map((path) => path.slice(0, 500))
        .slice(0, 20)
    : [];
  const sourceKinds = Array.isArray(event.sourceKinds)
    ? [
        ...new Set(
          event.sourceKinds.filter(
            (kind) => typeof kind === "string" && ALPHA_SOURCE_KINDS.has(kind),
          ),
        ),
      ].slice(0, 20)
    : [];
  const reason =
    event.reason === undefined
      ? "request"
      : typeof event.reason === "string" && ALPHA_REASONS.has(event.reason)
        ? event.reason
        : "alpha-filesystem";
  return { reason, paths, sourceKinds };
}

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff2", "font/woff2"],
]);

function safeStaticPath(staticDir, rawUrlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawUrlPath);
  } catch {
    return { error: "invalid_path" };
  }
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.split("/").includes(".."))
    return { error: "invalid_path" };
  const root = resolve(staticDir);
  const candidate = resolve(root, `.${decoded}`);
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`)) return { error: "invalid_path" };
  return { root, candidate };
}

function staticResponse(req, res, staticDir, rawPath, normalizedPath) {
  const safe = safeStaticPath(staticDir, rawPath);
  if (safe.error) return json(res, 400, { error: safe.error });
  let file = normalizedPath.endsWith("/") ? join(safe.candidate, "index.html") : safe.candidate;
  if (!existsSync(file) || !statSync(file).isFile()) {
    const acceptsHtml = String(req.headers.accept ?? "").includes("text/html");
    if (!acceptsHtml || extname(normalizedPath)) return json(res, 404, { error: "not_found" });
    file = join(safe.root, "index.html");
  }
  if (!existsSync(file) || !statSync(file).isFile())
    return json(res, 404, { error: "web_build_not_found" });
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
  createReadStream(actualFile).pipe(res);
}

export function createTimelineServer({
  collect = collectSnapshot,
  reconciliationMs = 30_000,
  staticDir = resolve("dist/web"),
  watchSources = createSourceWatcher,
  collectAlpha = collectAlphaSnapshot,
  watchAlphaSources = createAlphaSourceWatcher,
  readKeyMessageSummary = readSessionKeyMessageSummary,
} = {}) {
  const cache = new SessionCache();
  let snapshot;
  let alphaSnapshot;
  let lastRefresh;
  const clients = new Set();
  const alphaClients = new Set();
  const refresh = ({ reason = "request", paths = [], notify = true } = {}) => {
    snapshot = collect({ cache });
    lastRefresh = { at: snapshot.generatedAt, reason, paths: paths.slice(0, 20) };
    snapshot.trace ??= {};
    snapshot.trace.refresh = lastRefresh;
    if (notify) {
      const payload = `event: invalidate\ndata: ${JSON.stringify({ generatedAt: snapshot.generatedAt })}\n\n`;
      for (const client of clients) client.write(payload);
    }
    return snapshot;
  };
  const refreshAlpha = (event = {}) => {
    const safeEvent = sanitizeAlphaEvent(event);
    if (!snapshot) refresh({ reason: "request", notify: false });
    alphaSnapshot = collectAlpha({
      baseSnapshot: snapshot,
      reason: safeEvent.reason,
      paths: safeEvent.paths,
    });
    alphaSnapshot.trace ??= {};
    alphaSnapshot.trace.refresh = {
      at: alphaSnapshot.generatedAt,
      reason: safeEvent.reason,
      paths: safeEvent.paths,
      sources: safeEvent.sourceKinds,
    };
    const payload = `event: invalidate\ndata: ${JSON.stringify({
      generatedAt: alphaSnapshot.generatedAt,
      sources: safeEvent.sourceKinds,
      paths: safeEvent.paths,
    })}\n\n`;
    for (const client of alphaClients) client.write(payload);
    return alphaSnapshot;
  };
  const server = createServer((req, res) => {
    const rawPath = String(req.url ?? "/").split("?", 1)[0];
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/health")
      return json(res, 200, { ok: true, generatedAt: snapshot?.generatedAt, refresh: lastRefresh });
    if (req.method === "GET" && url.pathname === "/api/snapshot")
      return json(res, 200, snapshot ?? refresh());
    if (req.method === "GET" && url.pathname === "/api/trace")
      return json(res, 200, (snapshot ?? refresh()).trace);
    const keyMessageDetail = url.pathname.match(/^\/api\/sessions\/([^/]+)\/key-message-summary$/);
    if (req.method === "GET" && keyMessageDetail) {
      let sessionId;
      try {
        sessionId = decodeURIComponent(keyMessageDetail[1]);
      } catch {
        return json(res, 400, { error: "invalid_session_id" });
      }
      const session = (snapshot ?? refresh()).sessions.find((item) => item.id === sessionId);
      if (!session) return json(res, 404, { error: "session_not_found" });
      return json(res, 200, sanitizeKeyMessageSummaryDetail(readKeyMessageSummary(session)));
    }
    if (req.method === "GET" && url.pathname === "/api/alpha/snapshot")
      return json(res, 200, alphaSnapshot ?? refreshAlpha());
    if (req.method === "GET" && url.pathname === "/api/alpha/trace")
      return json(res, 200, (alphaSnapshot ?? refreshAlpha()).trace);
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("event: ready\ndata: {}\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/alpha/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("event: ready\ndata: {}\n\n");
      alphaClients.add(res);
      req.on("close", () => alphaClients.delete(res));
      return;
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/"))
      return json(res, 404, { error: "not_found" });
    if (req.method === "GET" || req.method === "HEAD")
      return staticResponse(req, res, staticDir, rawPath, url.pathname);
    return json(res, 404, { error: "not_found" });
  });
  const sourceWatcher = watchSources((event) => {
    try {
      refresh(event);
      refreshAlpha(event);
    } catch {}
  });
  const alphaSourceWatcher = watchAlphaSources((event) => {
    try {
      refreshAlpha(event);
    } catch {}
  });
  const timer = setInterval(() => {
    try {
      refresh({ reason: "reconciliation" });
      refreshAlpha({ reason: "reconciliation", sourceKinds: ["timeline-runtime"] });
    } catch {}
  }, reconciliationMs);
  timer.unref();
  server.on("close", () => {
    clearInterval(timer);
    sourceWatcher?.close?.();
    alphaSourceWatcher?.close?.();
  });
  return server;
}
