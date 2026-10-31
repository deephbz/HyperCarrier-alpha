import "./bound.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HostLink } from "../src/hub/hosts.ts";

test("B3: a connected socket without a node hello exposes a failure within 35 seconds", { timeout: 40_000 }, async t => {
 const home = mkdtempSync(join(tmpdir(), "ah-"));
 const sockets: Socket[] = [];
 // A synthetic transport accepts connections and bytes, but the node protocol never becomes ready.
 const server = createServer(socket => { sockets.push(socket); socket.on("data", () => {}); });
 await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(join(home, "node.sock"), resolve); });
 const link = new HostLink({ id: "silent", label: "Synthetic silent host", kind: "local", home });
 t.after(async () => { link.stop(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }); });
 link.start();
 const states: typeof link.state[] = [];
 link.on("state", state => states.push({ ...state }));
 const deadline = Date.now() + 35_000;
 while (Date.now() < deadline && !states.some(state => state.error)) await new Promise(resolve => setTimeout(resolve, 50));
 assert.ok(states.some(state => state.error), `no connection diagnosis after 35 seconds: ${JSON.stringify(link.state)}`);
});
