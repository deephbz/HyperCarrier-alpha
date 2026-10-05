// Loopback HTTP server for the web view. Serves one HTML page, the pure sim modules, and the payload.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("../web/index.html", import.meta.url));
const MODULES = { "/sim.mjs": "./sim.mjs", "/policies.mjs": "./policies.mjs" };

export async function serve(payload, { port = 0 } = {}) {
  const body = JSON.stringify(payload);
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    try {
      if (path === "/") return send(res, "text/html; charset=utf-8", await readFile(WEB));
      if (MODULES[path]) return send(res, "text/javascript", await readFile(fileURLToPath(new URL(MODULES[path], import.meta.url))));
      if (path === "/data.json") return send(res, "application/json", body);
      res.writeHead(404).end();
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  await new Promise((ok) => server.listen(port, "127.0.0.1", ok));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

function send(res, type, data) {
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(data);
}

export function openUrl(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  execFile(cmd, args, () => {});
}
