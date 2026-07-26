import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { collectSnapshot, SessionCache, SessionCatalog } from "./collector.js";
import {
  projectRarebitSummaryStatus,
  readSessionRarebitSummary,
  sanitizeRarebitSummaryDetail,
} from "./rarebit-detail.js";
import { resolveTrafficBaseUrl } from "./service-config.js";
import { createSourceWatcher } from "./watcher.js";

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

const SNAPSHOT_WINDOWS = new Set(["15m", "1h", "6h", "24h", "all"]);

function snapshotQuery(url) {
  const window = url.searchParams.get("window") ?? "24h";
  if (!SNAPSHOT_WINDOWS.has(window)) return { error: "invalid_snapshot_window" };
  const cursor = url.searchParams.get("before");
  if (cursor !== null && (cursor.length > 500 || !/^[A-Za-z0-9_-]+$/.test(cursor)))
    return { error: "invalid_snapshot_cursor" };
  const parseBound = (name) => {
    const raw = url.searchParams.get(name);
    if (raw === null) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  const from = parseBound("from");
  const to = parseBound("to");
  if (from === null || to === null || (from !== undefined && to !== undefined && from > to))
    return { error: "invalid_snapshot_bounds" };
  return { window, cursor: cursor ?? undefined, from, to };
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

async function trafficHealth(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
    const body = await response.json();
    return { available: response.ok && body?.ok === true, status: response.status, body };
  } catch {
    return { available: false, status: null, body: null };
  }
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

async function serveSnapshot(res, url, snapshotFor) {
  const query = snapshotQuery(url);
  if (query.error) return json(res, 400, { error: query.error });
  try {
    return json(res, 200, await snapshotFor(query));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("invalid_snapshot_"))
      return json(res, 400, { error: error.message });
    throw error;
  }
}

export async function attachRarebitSummaryStatus(snapshot, readRarebitSummary) {
  const sessions = await Promise.all(
    (snapshot.sessions ?? []).map(async (session) => {
      let detail;
      try {
        detail = await readRarebitSummary(session);
      } catch {
        detail = { availability: "unavailable", reason: "sidecar_unreadable" };
      }
      return { ...session, rarebitSummaryStatus: projectRarebitSummaryStatus(detail) };
    }),
  );
  return { ...snapshot, sessions };
}

export function createTimelineServer({
  collect = collectSnapshot,
  reconciliationMs = 30_000,
  staticDir = resolve("dist/web"),
  watchSources = createSourceWatcher,
  readRarebitSummary = readSessionRarebitSummary,
  collectionOptions = {},
  watchRoots,
  trafficBaseUrl = resolveTrafficBaseUrl(),
} = {}) {
  const rarebitReadOptions = {
    ...(collectionOptions.sessionsRoot ? { sessionRoot: collectionOptions.sessionsRoot } : {}),
    ...(collectionOptions.rarebitRoot ? { rarebitRoot: collectionOptions.rarebitRoot } : {}),
  };
  const cache = new SessionCache();
  const catalogCache = new SessionCatalog();
  const snapshots = new Map();
  let snapshot;
  let lastRefresh;
  const clients = new Set();
  const refresh = async ({
    reason = "request",
    paths = [],
    notify = true,
    query = { window: "24h" },
  } = {}) => {
    const key = `${query.window}:${query.cursor ?? ""}:${query.from ?? ""}:${query.to ?? ""}`;
    const refreshed = await attachRarebitSummaryStatus(
      await collect({
        ...collectionOptions,
        cache,
        catalogCache,
        window: query.window,
        cursor: query.cursor,
        from: query.from,
        to: query.to,
      }),
      (session) => readRarebitSummary(session, rarebitReadOptions),
    );
    snapshots.set(key, refreshed);
    if (!query.cursor && query.window === "24h") snapshot = refreshed;
    snapshot ??= refreshed;
    lastRefresh = { at: refreshed.generatedAt, reason, paths: paths.slice(0, 20) };
    refreshed.trace ??= {};
    refreshed.trace.refresh = lastRefresh;
    if (notify) {
      const payload = `event: invalidate\ndata: ${JSON.stringify({ generatedAt: refreshed.generatedAt })}\n\n`;
      for (const client of clients) client.write(payload);
    }
    return refreshed;
  };
  const snapshotFor = async (query) => {
    const key = `${query.window}:${query.cursor ?? ""}:${query.from ?? ""}:${query.to ?? ""}`;
    return snapshots.get(key) ?? (await refresh({ query, notify: false }));
  };
  const server = createServer(async (req, res) => {
    const rawPath = String(req.url ?? "/").split("?", 1)[0];
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/alpha" || url.pathname.startsWith("/alpha/"))
      return json(res, 404, { error: "not_found" });
    if (req.method === "GET" && url.pathname === "/api/health")
      return json(res, 200, {
        ok: true,
        generatedAt: snapshot?.generatedAt,
        refresh: lastRefresh,
        traffic: { baseUrl: trafficBaseUrl, health: `${trafficBaseUrl}/health` },
      });
    if (req.method === "GET" && url.pathname === "/api/traffic/config")
      return json(res, 200, { baseUrl: trafficBaseUrl, path: "/traffic" });
    if (req.method === "GET" && url.pathname === "/api/traffic/health")
      return json(res, 200, await trafficHealth(trafficBaseUrl));
    if (req.method === "GET" && url.pathname === "/api/snapshot")
      return await serveSnapshot(res, url, snapshotFor);
    if (req.method === "GET" && url.pathname === "/api/trace")
      return json(res, 200, (snapshot ?? (await refresh())).trace);
    const rarebitDetail = url.pathname.match(/^\/api\/sessions\/([^/]+)\/rarebit-summary$/);
    if (req.method === "GET" && rarebitDetail) {
      let sessionId;
      try {
        sessionId = decodeURIComponent(rarebitDetail[1]);
      } catch {
        return json(res, 400, { error: "invalid_session_id" });
      }
      const known = [...snapshots.values()].flatMap((item) => item.sessions);
      const session =
        known.find((item) => item.id === sessionId) ??
        (snapshot ?? (await refresh())).sessions.find((item) => item.id === sessionId);
      if (!session) return json(res, 404, { error: "session_not_found" });
      return json(res, 200, sanitizeRarebitSummaryDetail(await readRarebitSummary(session)));
    }
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
    if (url.pathname === "/api" || url.pathname.startsWith("/api/"))
      return json(res, 404, { error: "not_found" });
    if (req.method === "GET" || req.method === "HEAD")
      return staticResponse(req, res, staticDir, rawPath, url.pathname);
    return json(res, 404, { error: "not_found" });
  });
  const sourceWatcher = watchSources(
    (event) => {
      snapshots.clear();
      refresh(event).catch(() => undefined);
    },
    watchRoots ? { roots: watchRoots } : undefined,
  );
  const timer = setInterval(() => {
    snapshots.clear();
    refresh({ reason: "reconciliation" }).catch(() => undefined);
  }, reconciliationMs);
  timer.unref();
  server.on("close", () => {
    clearInterval(timer);
    sourceWatcher?.close?.();
  });
  return server;
}
