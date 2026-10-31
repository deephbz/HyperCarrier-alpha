import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hub, hubProof } from "../src/hub/hub.ts";
import { trackRoleWait } from "../src/pi/derive-queue.ts";

test("health: role waits are authenticated diagnostics and never counted as Builds", async () => {
 const token = "d".repeat(64);
 const hub = new Hub({ hosts: [] }, { token });
 const port = await hub.listen(0);
 const url = `http://127.0.0.1:${port}/api/health`;
 const health = async () => (await fetch(url, { headers: { authorization: `Bearer ${token}` } })).json() as Promise<any>;
 let release!: () => void;
 let waiting: Promise<void> | undefined;
 try {
  const before = await health();
  waiting = trackRoleWait(() => new Promise<void>(resolve => { release = resolve; }));
  const during = await health();
  assert.equal(during.roleWaits.pending, before.roleWaits.pending + 1);
  assert.equal(during.roleWaits.drainedAt, null);
  assert.deepEqual(during.builds, before.builds);
  assert.deepEqual(await (await fetch(url)).json(), { ok: true, proof: hubProof(token) });
  assert.deepEqual(await (await fetch(url, { headers: { authorization: "Bearer invalid" } })).json(), { ok: true, proof: hubProof(token) });
  release(); await waiting;
  const after = await health();
  assert.equal(after.roleWaits.pending, before.roleWaits.pending);
  assert.equal(after.roleWaits.done, before.roleWaits.done + 1);
  assert.equal(typeof after.roleWaits.drainedAt, "number");
  assert.deepEqual(after.builds, before.builds);
 } finally { release?.(); await waiting; await hub.close(); }
});
