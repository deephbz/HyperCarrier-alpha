import "./bound.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ENGINES, open } from "./resize-edges-fixture.ts";
import { engineSkip } from "./engines.ts";
const proof = process.env.ADV_PROOF ?? "output/adversarial-find-readiness";
mkdirSync(proof, { recursive: true });

// After a hub restart the Host answers Find before it indexes the Session. Project that cold start once, so the race is
// deterministic: the first reply is the Host's Indexing, and a replay of the thread topic's last snapshot is the frame
// that announces the index. A separate socket proves that the same query succeeds; it never changes the open Find.
for (const [engine, type, path] of ENGINES) test(`adversarial Find readiness ${engine}: a transient cold-index reply recovers without an edit`, { skip: engineSkip(engine) }, async t => {
  const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-big" });
  const requests: any[] = [];
  let projected = false, announce: (() => void) | undefined;
  await page.routeWebSocket("**/ws", ws => {
    const server = ws.connectToServer();
    ws.onMessage(raw => { const f = JSON.parse(String(raw)); if (f.op === "thread.find" && f.id !== 900001) requests.push(f); server.send(raw); });
    server.onMessage(raw => {
      const f = JSON.parse(String(raw));
      if (f.t === "snap" && f.value?.conversationId === "pi:sess-big" && f.value.sourceVersion) announce = () => ws.send(raw);
      if (!projected && f.t === "res" && requests.some(r => r.id === f.id)) {
        projected = true;
        ws.send(JSON.stringify({ t: "res", id: f.id, ok: true, value: { indexing: true } }));
      } else ws.send(raw);
    });
  });
  await page.reload();
  await page.getByRole("button", { name: "Find in this Session", exact: true }).click();
  await page.getByRole("textbox", { name: "Find in Session", exact: true }).fill("selector");
  const status = page.locator(".find-bar [role=status]");
  await status.filter({ hasText: "Indexing…" }).waitFor();
  // No timer asks again: the request waits for the Host's announcement.
  await page.waitForTimeout(1000);
  const waiting = { ui: await status.innerText(), requests: requests.length };
  const ready = await page.evaluate(() => new Promise<any>((resolve, reject) => {
    const socket = new WebSocket(`${location.origin.replace("http", "ws")}/ws`);
    const timer = setTimeout(() => { socket.close(); reject(new Error("readiness probe did not resolve")); }, 5000);
    socket.onopen = () => socket.send(JSON.stringify({ t: "req", id: 900001, host: "devbox", op: "thread.find", args: { threadId: "pi:sess-big", query: "selector" } }));
    socket.onmessage = e => { const f = JSON.parse(e.data); if (f.t !== "res") return; clearTimeout(timer); socket.close(); resolve(f); };
  }));
  assert.equal(ready.ok, true, "the real hub now accepts the unchanged query");
  assert.ok(ready.value.total > 0, "the real query has matches");
  assert.ok(announce, "the thread topic sent a snapshot with a sourceVersion");
  announce!();
  const recovered = await page.waitForFunction(() => /\d/.test(document.querySelector(".find-bar [role=status]")?.textContent ?? ""), undefined, { timeout: 3000 }).then(() => true, () => false);
  const evidence = { projected, waiting, ready: { ok: ready.ok, total: ready.value.total }, recovered, ui: await status.innerText(), reason: await status.getAttribute("title"), requests: requests.map(r => ({ op: r.op, args: r.args })) };
  writeFileSync(join(proof, `${engine}-find-readiness.json`), JSON.stringify(evidence, null, 2));
  await page.screenshot({ path: join(proof, `${engine}-find-readiness.png`) });
  assert.deepEqual(waiting, { ui: "Indexing…", requests: 1 }, JSON.stringify(evidence));
  assert.equal(recovered, true, JSON.stringify(evidence));
  assert.equal(requests.length, 2, "the announcement asks again once");
  assert.deepEqual(requests[1].args, requests[0].args, "the same request, without an edit");
});
