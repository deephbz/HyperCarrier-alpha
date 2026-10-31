import "./bound.ts";
// @ts-ignore: shared control limits.
import { IMAGE_LIMITS } from "@hypercarrier/pi-hc-control/control";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { ENGINES, open } from "./resize-edges-fixture.ts";
import { engineSkip } from "./engines.ts";
import type { WebSocketRoute } from "playwright";
// @ts-ignore: browser fixture adapter is plain ESM.
import { routeFixture } from "../scripts/ux/fixtures.mjs";

for (const [engine, type, path] of ENGINES) {
 test(`R1 ${engine}: dropping nine images discloses the rejected ninth image`, { skip: engineSkip(engine) }, async t => {
  const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-worker-gui" });
  // A synthetic image-capable Pi control. The shared fixture adapter blocks all mutations.
  await routeFixture(page, {}, { requests: [] }, { through: (ws: WebSocketRoute) => ({
   connectToServer: () => ws.connectToServer(),
   onMessage: (fn: any) => ws.onMessage(fn),
   send: (raw: string) => {
    const frame = JSON.parse(raw);
    if (frame.t === "snap" && frame.value?.threads) for (const thread of Object.values(frame.value.threads) as any[]) {
     thread.control = true; thread.images = IMAGE_LIMITS;
    }
    ws.send(JSON.stringify(frame));
   },
  }) });
  await page.reload();
  await page.getByTitle("Attach images (or paste or drop them)").waitFor();
  await page.locator(".composer-wrap").evaluate(el => {
   const transfer = new DataTransfer();
   const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="), c => c.charCodeAt(0));
   for (let n = 1; n <= 9; n++) transfer.items.add(new File([png], `image-${n}.png`, { type: "image/png" }));
   el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await page.waitForFunction(() => document.querySelectorAll(".attachment").length === 8);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  if (process.env.AMPI_ADV_EVIDENCE) await page.screenshot({ path: join(process.env.AMPI_ADV_EVIDENCE, `image-overflow-${engine}.png`) });
  const alert = await page.locator(".composer [role=alert]").allTextContents();
  assert.match(alert.join(" "), /8|eight|too many|limit/i, `nine files dropped, eight retained, feedback=${JSON.stringify(alert)}`);
 });
}
