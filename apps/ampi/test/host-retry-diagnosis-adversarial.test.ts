import "./bound.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { ENGINES, open } from "./resize-edges-fixture.ts";
import { engineSkip } from "./engines.ts";
import type { WebSocketRoute } from "playwright";
// @ts-ignore: browser fixture adapter is plain ESM.
import { routeFixture } from "../scripts/ux/fixtures.mjs";

for (const [engine, type, path] of ENGINES) {
 test(`B3 ${engine}: reconnecting does not hide the last Host failure before recovery`, { skip: engineSkip(engine) }, async t => {
  const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-worker-gui" });
  const reason = "Synthetic node closed before hello";
  let retry: (() => void) | undefined;
  await routeFixture(page, {}, { requests: [] }, { through: (ws: WebSocketRoute) => ({
   connectToServer: () => ws.connectToServer(),
   onMessage: (fn: any) => ws.onMessage(fn),
   send: (raw: string) => {
    const frame = JSON.parse(raw);
    if (frame.t === "hosts") {
     for (const host of frame.hosts) { host.status = "disconnected"; host.error = reason; }
     retry = () => {
      for (const host of frame.hosts) { host.status = "connecting"; host.attempts = 2; }
      ws.send(JSON.stringify(frame));
     };
    }
    ws.send(JSON.stringify(frame));
   },
  }) });
  await page.reload();
  const diagnosis = page.locator(".sidebar-slot").getByText(reason, { exact: true });
  await diagnosis.waitFor();
  assert.ok(retry);
  retry();
  await page.locator(".sidebar-slot").getByText(/^connecting ·/).waitFor();
  if (process.env.AMPI_ADV_EVIDENCE) await page.screenshot({ path: join(process.env.AMPI_ADV_EVIDENCE, `host-retry-${engine}.png`) });
  assert.equal(await diagnosis.isVisible(), true, "retry has not recovered the Host; the known failure must remain visible");
 });
}
