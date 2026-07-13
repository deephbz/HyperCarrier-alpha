import { createServer, request } from "node:http";
import { fileURLToPath } from "node:url";
import { namedUpstreamsFromEnv } from "./service-config.js";

export const NAMED_UPSTREAMS = namedUpstreamsFromEnv();

export function createNamedProxy({ upstreams = NAMED_UPSTREAMS } = {}) {
  return createServer((incoming, outgoing) => {
    const hostname = String(incoming.headers.host ?? "")
      .split(":", 1)[0]
      .toLowerCase();
    const port = upstreams.get(hostname);
    if (!port) {
      outgoing.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      return outgoing.end(JSON.stringify({ error: "unknown_local_service" }));
    }

    const upstream = request(
      {
        hostname: "127.0.0.1",
        port,
        method: incoming.method,
        path: incoming.url,
        headers: { ...incoming.headers, host: `127.0.0.1:${port}` },
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => {
      if (!outgoing.headersSent)
        outgoing.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      outgoing.end(JSON.stringify({ error: "local_service_unavailable" }));
    });
    incoming.pipe(upstream);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PI_NAMED_PROXY_PORT ?? 1355);
  createNamedProxy().listen(port, "127.0.0.1", () => {
    console.log(`Pi named proxy listening at http://127.0.0.1:${port}`);
  });
}
