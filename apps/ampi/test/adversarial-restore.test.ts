import "./bound.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
// @ts-ignore plain ESM public control interface.
import { IMAGE_LIMITS } from "@hypercarrier/pi-hc-control/control";
import type { WebSocketRoute } from "playwright";
// @ts-ignore plain ESM synthetic protocol projection.
import { routeFixture } from "../scripts/ux/fixtures.mjs";
import { ENGINES, open, eventually } from "./resize-edges-fixture.ts";
import { engineSkip } from "./engines.ts";
const proof = process.env.ADV_PROOF ?? "output/adversarial-restore";
mkdirSync(proof, { recursive: true });
// The rejections are proven refusals (bad_request); an unlisted code is an uncertain outcome (composer-outcomes.ts).
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
for (const [engine, type, path] of ENGINES) for (const heldEnter of [false, true]) test(`adversarial keyboard Restore ${engine}${heldEnter ? " held Enter" : ""}: full newer draft, repeated Restore and independent Discard`, { skip: engineSkip(engine) }, async t => {
  const page = await open(t, engine, type, path(), { display: { overall: 1.3 }, route: "#/h/devbox/t/pi%3Asess-worker-gui" });
  const requests: any[] = [], reject = new Map<string, () => void>();
  await routeFixture(page, {}, { requests: [] }, { through: (ws: WebSocketRoute) => ({
    connectToServer: () => ws.connectToServer(),
    onMessage: (fn: any) => ws.onMessage(raw => { const f = JSON.parse(String(raw)); if (f.op === "thread.submit") requests.push(f); fn(raw); }),
    send: (raw: string) => {
      const f = JSON.parse(raw);
      if (f.t === "snap" && f.value?.threads) for (const thread of Object.values(f.value.threads) as any[]) { thread.control = true; thread.images = IMAGE_LIMITS; }
      const request = f.t === "res" && requests.find(r => r.id === f.id);
      if (request) { reject.set(request.args.content, () => ws.send(JSON.stringify({ t: "res", id: f.id, ok: false, error: { code: "bad_request", message: `Synthetic rejection of ${request.args.content}` } }))); return; }
      ws.send(JSON.stringify(f));
    },
  }) });
  await page.reload();
  await page.getByTitle("Attach images (or paste or drop them)").waitFor();
  if (await page.getByTitle("Close panel", { exact: true }).isVisible()) await page.getByTitle("Close panel", { exact: true }).click();
  await page.setViewportSize({ width: 390, height: 720 });
  const hide = page.getByRole("button", { name: "Hide sidebar", exact: true });
  if (await hide.isVisible()) await hide.click();
  const input = page.getByRole("textbox", { name: "Message the agent" });
  const files = page.locator('.composer input[type=file]');
  await files.setInputFiles({ name: "returned.png", mimeType: "image/png", buffer: png });
  await page.locator('.attachment[title="returned.png"]').waitFor();
  await input.fill("Original 👩🏽‍💻 王秀英"); await input.press("Enter");
  await input.fill("Independent returned message"); await input.press("Enter");
  await files.setInputFiles(Array.from({ length: 8 }, (_, i) => ({ name: `new-${i}.png`, mimeType: "image/png", buffer: png })));
  await page.waitForFunction(() => document.querySelectorAll('.attachment').length === 8);
  await input.fill("Newer draft must survive");
  await eventually(async () => reject.size === 2, "both synthetic submissions reached the response boundary");
  reject.get("Independent returned message")!();
  reject.get("Original 👩🏽‍💻 王秀英")!();
  const held = page.locator(".returned[role=alert]");
  await held.nth(1).waitFor();
  const original = held.filter({ hasText: "Synthetic rejection of Original" });
  if (heldEnter) {
    await page.evaluate(() => {
      (window as any).__restoreKeys = [];
      document.addEventListener("keydown", e => (window as any).__restoreKeys.push({ key: e.key, repeat: e.repeat, target: (e.target as HTMLElement).tagName }));
    });
    await original.getByRole("button", { name: "Restore", exact: true }).focus();
    await page.keyboard.down("Enter");
    await page.keyboard.down("Enter");
    await page.keyboard.up("Enter");
    await page.waitForTimeout(250);
    const evidence = { keys: await page.evaluate(() => (window as any).__restoreKeys), draft: await input.inputValue(), submissions: requests.map(r => ({ content: r.args.content, images: r.args.images?.length })) };
    writeFileSync(join(proof, `${engine}-restore-held-enter.json`), JSON.stringify(evidence, null, 2));
    await page.screenshot({ path: join(proof, `${engine}-restore-held-enter.png`) });
    assert.equal(requests.length, 2, `one held Enter on Restore must not send the restored draft: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.draft, "Original 👩🏽‍💻 王秀英\n\nNewer draft must survive", "the Composer consumes the repeat: the restored draft gains no new line");
    return;
  }
  for (let i = 0; i < 3; i++) {
    const restore = original.getByRole("button", { name: "Restore", exact: true });
    await restore.focus(); await restore.press("Enter");
  }
  assert.equal(await input.inputValue(), "Original 👩🏽‍💻 王秀英\n\nNewer draft must survive", "repeated Restore merges text only once");
  assert.equal(await page.locator('.attachment').count(), 8, "full newer draft keeps all its images");
  assert.match(await original.innerText(), /1 image/, "the unadmitted returned image stays in custody");
  assert.equal(await input.evaluate(el => el === document.activeElement), true, "Restore returns keyboard focus to the draft");
  await page.screenshot({ path: join(proof, `${engine}-returned-full-draft.png`) });
  const discard = held.filter({ hasText: "Synthetic rejection of Independent" }).getByRole("button", { name: "Discard", exact: true });
  await discard.focus(); await discard.press("Enter");
  assert.equal(await held.count(), 1, "Discard removes only its own returned submission");
  await page.locator('.attachment[title="new-0.png"]').getByTitle("Remove", { exact: true }).click();
  const finalRestore = original.getByRole("button", { name: "Restore", exact: true });
  await finalRestore.focus(); await finalRestore.press("Enter");
  assert.equal(await held.count(), 0, "the held image moves into the space the owner freed");
  const names = await page.locator('.attachment').evaluateAll(els => els.map(el => el.getAttribute('title')));
  assert.deepEqual(names, [...Array.from({ length: 7 }, (_, i) => `new-${i + 1}.png`), "returned.png"]);
  assert.equal(await input.inputValue(), "Original 👩🏽‍💻 王秀英\n\nNewer draft must survive");
  assert.equal(requests.length, 2, "Restore and Discard never send a submission");
  await page.screenshot({ path: join(proof, `${engine}-restore-full-draft.png`) });
  writeFileSync(join(proof, `${engine}-restore.json`), JSON.stringify({ names, draft: await input.inputValue(), submissions: requests.map(r => ({ content: r.args.content, images: r.args.images?.length })) }, null, 2));
});
