import "./bound.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { test } from "node:test";
import { bounded, deferred, fixture } from "./composer-fixture.ts";
import { engineSkip } from "./engines.ts";

// A retry guarantee applies only to the original submission identity. Editing or merging a returned draft
// allocates a new identity, so its retained outcome must no longer promise deduplication against the old send.
for (const engine of ["chromium", "webkit"] as const) for (const placement of ["edit", "merge"] as const) {
 test(`custody rekey ${engine}: ${placement} drops the original retry guarantee`, { skip: engineSkip(engine) }, async t => {
  const held = deferred<() => void>();
  let first: number | undefined;
  const f = await fixture(t, 100_000, false, false, client => {
   const server = client.connectToServer();
   client.onMessage(raw => { const frame = JSON.parse(String(raw)); if (frame.op === "thread.submit") first ??= frame.id; server.send(raw); });
   server.onMessage(raw => {
    const frame = JSON.parse(String(raw));
    if (frame.t === "res" && frame.id === first) {
     held.resolve(() => client.send(JSON.stringify({ t: "res", id: frame.id, ok: false, error: { code: "host_disconnected", message: "devbox" } })));
     return;
    }
    client.send(raw);
   });
  }, {}, engine);
  await f.enter("Original message");
  const release = await bounded(held.promise);
  if (placement === "merge") await f.input.fill("Newer draft");
  release();
  if (placement === "merge") {
   const returned = f.page.locator(".composer-feedback.returned").filter({ hasText: "Original message" });
   await returned.waitFor();
   await returned.getByRole("button", { name: "Restore", exact: true }).click();
   await f.page.waitForFunction(() => document.querySelector("textarea")?.value === "Original message\n\nNewer draft");
  } else {
   await f.page.getByRole("alert").filter({ hasText: "did not answer" }).waitFor();
   await f.input.fill("Edited original message");
  }
  const notice = (await f.page.locator('.composer [role="alert"]').allTextContents()).join("\n");
  if (process.env.AMPI_ADV_EVIDENCE) { mkdirSync(process.env.AMPI_ADV_EVIDENCE, { recursive: true }); await f.page.screenshot({ path: `${process.env.AMPI_ADV_EVIDENCE}/rekey-${engine}-${placement}.png` }); }
  await f.input.press("Enter");
  const next = await f.submit(1), original = await f.submit(0);
  assert.notEqual(next.args.requestId, original.args.requestId, "the changed payload is a new submission");
  assert.doesNotMatch(notice, /Send again delivers it once/i, "a new identity cannot retain the original retry guarantee");
  assert.match(notice, /may already|already have arrived/i, "the prior admission remains uncertain");
 });
}
