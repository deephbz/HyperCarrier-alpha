import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ENGINES, open } from "./resize-edges-fixture.ts";
import { KEYMAP } from "../web/src/keymap.ts";
import { engineSkip } from "./engines.ts";

for (const [engine, type, path] of ENGINES) {
  test(`Rarebit keyboard jump ${engine}: prompt steps choose the target and focus its panel message`, { skip: engineSkip(engine) }, async (t) => {
    const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-asks?e=asks-u40" });
    const transcript = page.locator(".transcript-frame > .scroll");
    await transcript.focus();
    await page.keyboard.press("]");
    await page.keyboard.press("]");
    const prompt = page.locator('.prompt-head .q');
    await prompt.waitFor({ state: "attached" });
    const expected = await prompt.getAttribute("href");
    assert.ok(expected);
    await page.keyboard.press("r");
    await page.locator('.panel[data-panel-name="rarebit"]').waitFor();
    const target = page.locator(".panel [data-rarebit].rb-target");
    await target.waitFor();
    const entry = new URL(expected!, page.url()).hash.match(/[?&]e=([^&]+)/)?.[1];
    assert.equal(await target.getAttribute("data-rarebit"), decodeURIComponent(entry ?? ""));
    await page.waitForFunction(() => document.activeElement?.matches(".panel [data-rarebit].rb-target"));
  });
}

test("Rarebit late reveal does not steal newer Composer focus", async (t) => {
  const [engine, type, path] = ENGINES[0]!;
  const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-asks?e=asks-u40" });
  const queued: (() => void)[] = [];
  let intercepted!: () => void;
  const sawRarebit = new Promise<void>((resolve) => { intercepted = resolve; });
  await page.routeWebSocket("**/ws", (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => server.send(raw));
    server.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.t === "snap" && Array.isArray(frame.value?.items)) {
        queued.push(() => ws.send(raw));
        intercepted();
      } else ws.send(raw);
    });
  });
  await page.reload();
  await page.locator(".transcript-frame > .scroll").waitFor();
  await page.locator(".transcript-frame > .scroll").focus();
  await page.keyboard.press("r");
  await sawRarebit;
  const composer = page.locator('[data-region="composer"] textarea');
  await composer.focus();
  await composer.fill("keep focus");
  for (const release of queued) release();
  await page.locator('.panel [data-rarebit].rb-target').waitFor();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('[data-region="composer"] textarea')?.value === "keep focus");
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLTextAreaElement | null)?.getAttribute("data-region") ?? document.activeElement?.closest("[data-region]")?.getAttribute("data-region")), "composer");
});

test("Rarebit prompt jump appears in help and the command palette", () => {
  const binding = KEYMAP.find((entry) => entry.id === "rarebit.jump")!;
  assert.equal(binding.code, "KeyR");
  assert.equal(binding.region, "transcript");
  assert.equal(binding.label, "Show this prompt in Rarebit");
  assert.equal(binding.palette, true);
});
