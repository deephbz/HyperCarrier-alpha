// One local control address for the real Host store, independent of TMPDIR.
import { createConnection } from "node:net";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { ControlCommand } from "./runtime.ts";

export function serviceAddress(store: string): string {
 let path = resolve(store); try { path = realpathSync(path); } catch {}
 const key = createHash("sha256").update(path).digest("hex").slice(0, 24);
 return join("/tmp", `ampi-arc-${process.getuid?.() ?? 0}-${key}.sock`);
}
export function controlRequest(store: string, command: ControlCommand, timeoutMs = 5000): Promise<any> {
 return new Promise((resolve, reject) => {
  const socket = createConnection(serviceAddress(store)); let buffer = "";
  const timer = setTimeout(() => { socket.destroy(); reject(new Error("Arc service control request timed out")); }, timeoutMs);
  const finish = () => clearTimeout(timer);
  socket.on("error", e => { finish(); reject(e); });
  socket.on("connect", () => socket.write(JSON.stringify(command) + "\n"));
  socket.on("data", chunk => {
   buffer += chunk;
   const at = buffer.indexOf("\n"); if (at < 0) return;
   finish(); socket.destroy();
   try { const result = JSON.parse(buffer.slice(0, at)); result.error ? reject(new Error(result.error)) : resolve(result); } catch (e) { reject(e); }
  });
  socket.on("end", () => { finish(); if (!buffer.includes("\n")) reject(new Error("Arc service closed without a reply")); });
 });
}
