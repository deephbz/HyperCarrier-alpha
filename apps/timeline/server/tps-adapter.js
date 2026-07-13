import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createSourceWatcher } from "./watcher.js";
import { SessionRegistry } from "./session-registry.js";
import { resolveCoreHost, resolveServicePort } from "./service-config.js";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function sessionFromRequest(req, url) {
  const direct = url.searchParams.get("session");
  if (direct) return direct;
  try {
    return new URL(String(req.headers.referer ?? "")).searchParams.get("session") ?? "";
  } catch {
    return "";
  }
}

export function createTpsAdapterServer({
  sessionsRoot,
  staticDir = process.env.PI_TPS_WEB_DIST,
  watchSources = createSourceWatcher,
} = {}) {
  const registry = new SessionRegistry({ sessionsRoot }).refresh();
  const clients = new Map();
  const watcher = watchSources(
    () => {
      const before = new Map([...registry.byId].map(([id]) => [id, registry.version(id)]));
      registry.refresh();
      for (const [id] of registry.byId)
        if (before.get(id) !== registry.version(id))
          for (const client of clients.get(id) ?? [])
            client.write(`data: ${JSON.stringify({ version: registry.version(id) })}\n\n`);
    },
    { roots: [sessionsRoot ?? join(homedir(), ".pi", "agent", "sessions")] },
  );
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost"),
      id = sessionFromRequest(req, url);
    if (req.method === "GET" && url.pathname === "/api/telemetry") {
      const path = registry.get(id);
      if (!path) {
        res.writeHead(404);
        return res.end("Unknown session");
      }
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      return createReadStream(path).pipe(res);
    }
    if (req.method === "GET" && url.pathname === "/api/version") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ version: registry.version(id) ?? null }));
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      if (!registry.get(id)) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      const set = clients.get(id) ?? new Set();
      set.add(res);
      clients.set(id, set);
      req.on("close", () => set.delete(res));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          ok: true,
          sessions: registry.byId.size,
          renderer: Boolean(staticDir && existsSync(join(staticDir, "index.html"))),
        }),
      );
    }
    if (!staticDir) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("Set PI_TPS_WEB_DIST to the pinned pi-tps-web dist artifact");
    }
    const root = resolve(staticDir);
    let requested = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    let path = resolve(root, requested);
    const rel = relative(root, path);
    if (rel === ".." || rel.startsWith(`..${sep}`)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    if (!existsSync(path) || !statSync(path).isFile()) path = join(root, "index.html");
    const actualRoot = existsSync(root) ? realpathSync(root) : root;
    const actualPath = existsSync(path) ? realpathSync(path) : path;
    if (
      !existsSync(path) ||
      (actualPath !== actualRoot && !actualPath.startsWith(`${actualRoot}${sep}`))
    ) {
      res.writeHead(404);
      return res.end("Build pi-tps-web first");
    }
    res.writeHead(200, {
      "content-type": MIME[extname(path)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    return createReadStream(path).pipe(res);
  });
  server.on("close", () => watcher.close());
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = resolveServicePort("tps"),
    host = resolveCoreHost();
  createTpsAdapterServer().listen(port, host, () =>
    console.log(`Pi TPS adapter at http://${host}:${port}`),
  );
}
