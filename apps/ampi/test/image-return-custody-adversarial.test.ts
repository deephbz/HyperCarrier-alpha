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

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
for (const [engine, type, path] of ENGINES) {
 test(`R1 ${engine}: a rejected send cannot erase the next draft or its images`, { skip: engineSkip(engine) }, async t => {
  const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-worker-gui" });
  let submitId: number | undefined;
  let rejectSubmission: (() => void) | undefined;
  await routeFixture(page, {}, { requests: [] }, { through: (ws: WebSocketRoute) => ({
   connectToServer: () => ws.connectToServer(),
   onMessage: (fn: any) => ws.onMessage(raw => {
    const frame = JSON.parse(String(raw));
    if (frame.op === "thread.submit") submitId = frame.id;
    fn(raw);
   }),
   send: (raw: string) => {
    const frame = JSON.parse(raw);
    if (frame.t === "snap" && frame.value?.threads) for (const thread of Object.values(frame.value.threads) as any[]) { thread.control = true; thread.images = IMAGE_LIMITS; }
    if (frame.t === "res" && frame.id === submitId) {
     rejectSubmission = () => ws.send(JSON.stringify({ t: "res", id: frame.id, ok: false, error: { code: "bad_request", message: "Synthetic first submission rejected" } }));
     return;
    }
    ws.send(JSON.stringify(frame));
   },
  }) });
  await page.reload();
  await page.getByTitle("Attach images (or paste or drop them)").waitFor();
  const input = page.getByRole("textbox", { name: "Message the agent" });
  const files = page.locator('.composer input[type="file"]');
  await files.setInputFiles({ name: "first.png", mimeType: "image/png", buffer: png });
  await page.locator('.attachment[title="first.png"]').waitFor();
  await input.fill("First message"); await input.press("Enter");
  await page.waitForFunction(() => !document.querySelector(".attachment"));
  await files.setInputFiles({ name: "next.png", mimeType: "image/png", buffer: png });
  await page.locator('.attachment[title="next.png"]').waitFor();
  await input.fill("Next draft must survive");
  assert.ok(rejectSubmission, "the first request is held at the browser fixture boundary");
  rejectSubmission();
  await page.getByRole("alert").filter({ hasText: "Synthetic first submission rejected" }).waitFor();
  const after = { text: await input.inputValue(), images: await page.locator(".attachment").evaluateAll(els => els.map(el => el.getAttribute("title"))) };
  if (process.env.AMPI_ADV_EVIDENCE) await page.screenshot({ path: join(process.env.AMPI_ADV_EVIDENCE, `image-return-custody-${engine}.png`) });
  assert.ok(after.text.includes("Next draft must survive") && after.images.includes("next.png"), `rejecting an earlier submission erased later input: ${JSON.stringify(after)}`);
 });
 test(`R1 ${engine}: navigation preserves the text and images of one draft together`, { skip: engineSkip(engine) }, async t => {
  const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-worker-gui" });
  await routeFixture(page, {}, { requests: [] }, { through: (ws: WebSocketRoute) => ({
   connectToServer: () => ws.connectToServer(),
   onMessage: (fn: any) => ws.onMessage(fn),
   send: (raw: string) => {
    const frame = JSON.parse(raw);
    if (frame.t === "snap" && frame.value?.threads) for (const thread of Object.values(frame.value.threads) as any[]) { thread.control = true; thread.images = IMAGE_LIMITS; }
    ws.send(JSON.stringify(frame));
   },
  }) });
  await page.reload();
  await page.getByTitle("Attach images (or paste or drop them)").waitFor();
  const input = page.getByRole("textbox", { name: "Message the agent" });
  await page.locator('.composer input[type="file"]').setInputFiles({ name: "draft.png", mimeType: "image/png", buffer: png });
  await page.locator('.attachment[title="draft.png"]').waitFor();
  await input.fill("Draft and image belong together");
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await input.waitFor({ state: "detached" });
  await page.goBack();
  await input.waitFor();
  const after = { text: await input.inputValue(), images: await page.locator(".attachment").count(), alerts: await page.locator(".composer [role=alert]").allTextContents() };
  if (process.env.AMPI_ADV_EVIDENCE) await page.screenshot({ path: join(process.env.AMPI_ADV_EVIDENCE, `image-navigation-${engine}.png`) });
  assert.equal(after.images, 1, `navigation split the draft: ${JSON.stringify(after)}`);
 });
}
