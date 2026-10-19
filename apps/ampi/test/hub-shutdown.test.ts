import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection } from "node:net";
import { test } from "node:test";
import WebSocket from "ws";
import { Hub } from "../src/hub/hub.ts";

test("hub quit: a browser preconnect and a stalled WebSocket cannot hold shutdown or relaunch", async () => {
 const token = "c".repeat(64);
 const hub = new Hub({ hosts: [] }, { token });
 const port = await hub.listen(0);
 // Browsers can open a speculative TCP connection without sending HTTP headers.
 const preconnect = createConnection({ host: "127.0.0.1", port });
 await once(preconnect, "connect");
 const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}`, authorization: `Bearer ${token}` } });
 await once(ws, "open"); ws.pause();
 let deadline: ReturnType<typeof setTimeout> | undefined;
 const closing = hub.close();
 try {
  const settled = await Promise.race([closing.then(() => true), new Promise<boolean>(resolve => { deadline = setTimeout(() => resolve(false), 500); })]);
  assert.equal(settled, true, "quit must close accepted sockets without waiting for headers or peer close acknowledgements");
  const replacement = new Hub({ hosts: [] }, { token });
  assert.equal(await replacement.listen(port), port);
  await replacement.close();
 } finally {
  clearTimeout(deadline); preconnect.destroy(); ws.terminate(); await closing;
 }
});
