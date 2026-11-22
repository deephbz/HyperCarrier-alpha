import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ENGINES, open } from "./resize-edges-fixture.ts";
import { engineSkip } from "./engines.ts";
import type { Page, WebSocketRoute } from "playwright";
// @ts-ignore: pi-hc-control is plain ESM.
import { IMAGE_LIMITS } from "@hypercarrier/pi-hc-control/control";
// @ts-ignore: browser fixture adapter is plain ESM.
import { routeFixture } from "../scripts/ux/fixtures.mjs";

declare global {
  interface Window {
    __quotePendingFrames?: FrameRequestCallback[];
    __quoteOriginalRaf?: (callback: FrameRequestCallback) => number;
  }
}

async function enableQuote(page: Page) {
  await routeFixture(page, {}, { requests: [] }, { through: (ws: WebSocketRoute) => ({
    connectToServer: () => ws.connectToServer(),
    onMessage: (fn: (message: string | Buffer) => void) => ws.onMessage(fn),
    send: (raw: string) => {
      const frame = JSON.parse(raw);
      if (frame.t === "snap" && frame.value?.threads) for (const thread of Object.values(frame.value.threads) as { control?: boolean; images?: unknown }[]) {
        thread.control = true;
        thread.images = IMAGE_LIMITS;
      }
      ws.send(JSON.stringify(frame));
    },
  }) });
  await page.reload();
  await page.locator('.composer input[type="file"]').waitFor({ state: "attached" });
}

for (const [engine, type, path] of ENGINES) {
  test(`boot and Session switch focus the Composer unless the owner moves focus ${engine}`, { skip: engineSkip(engine) }, async (t) => {
    const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-long-title" });
    const composer = page.getByRole("textbox", { name: "Message the agent", exact: true });
    await page.waitForFunction(() => document.activeElement?.matches('[data-region="composer"] textarea'));
    await page.evaluate(() => { location.hash = "#/h/devbox/t/pi%3Asess-asks"; });
    await page.waitForFunction(() => location.hash.includes("sess-asks"));
    await page.waitForFunction(() => document.activeElement?.matches('[data-region="composer"] textarea'));
    assert.equal(await composer.count(), 1);
  });

  test(`App quote RAF does not replace newer transcript focus ${engine}`, { skip: engineSkip(engine) }, async (t) => {
    const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-lead" });
    await enableQuote(page);
    await page.locator('[data-region="transcript"] [data-entry] .md p').first().waitFor();
    await page.evaluate(() => {
      const root = document.querySelector('[data-region="transcript"]')!;
      const body = [...root.querySelectorAll<HTMLElement>('[data-entry] .md p')].filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < innerHeight;
      }).at(-1)!;
      const range = document.createRange();
      range.selectNodeContents(body);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.getByRole("button", { name: "Quote q", exact: true }).click();
    await page.evaluate(() => {
      const state = window;
      state.__quotePendingFrames = [];
      state.__quoteOriginalRaf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => { state.__quotePendingFrames!.push(callback); return state.__quotePendingFrames!.length; };
    });
    try {
      await page.getByRole("textbox", { name: "Quote note (optional)" }).press("Enter");
      await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('[data-region="composer"] textarea')?.value.startsWith("> "));
      await page.locator('[data-region="transcript"]').focus();
      await page.evaluate(() => {
        const state = window;
        window.requestAnimationFrame = state.__quoteOriginalRaf!;
        for (const callback of state.__quotePendingFrames!) callback(performance.now());
      });
      assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-region]')?.getAttribute('data-region')), "transcript");
    } finally {
      await page.evaluate(() => {
        const state = window as Window & { __quoteOriginalRaf?: typeof requestAnimationFrame };
        if (state.__quoteOriginalRaf) window.requestAnimationFrame = state.__quoteOriginalRaf;
      });
    }
  });

  test(`prompt stepping preserves transcript focus ${engine} (five samples)`, { skip: engineSkip(engine) }, async (t) => {
    const failures: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-asks?e=asks-u40" });
      const transcript = page.locator('[data-region="transcript"]');
      await transcript.focus();
      await page.keyboard.press("]");
      await page.waitForFunction(() => location.hash.includes("e=asks-u41") && document.querySelector('[data-region="transcript"] [data-entry="asks-u41"]'));
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await page.keyboard.press("]");
      await page.waitForFunction(() => location.hash.includes("e=asks-u42") && document.querySelector('[data-region="transcript"] [data-entry="asks-u42"]'));
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const state = await page.evaluate(() => ({ inside: !!document.activeElement?.closest('[data-region="transcript"]'), tag: document.activeElement?.tagName, label: (document.activeElement as HTMLElement)?.getAttribute("aria-label"), hash: location.hash }));
      if (!state.inside) failures.push(`${attempt + 1}: focus left transcript for ${state.tag} ${state.label ?? ""} at ${state.hash}`);
    }
    assert.deepEqual(failures, [], failures.join("\n"));
  });
}
