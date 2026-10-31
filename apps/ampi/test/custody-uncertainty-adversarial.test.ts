import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync } from "node:fs";
import { ENGINES, open, eventually } from "./resize-edges-fixture.ts";
import { engineSkip } from "./engines.ts";
import type { WebSocketRoute } from "playwright";
// @ts-ignore: browser protocol fixture.
import { routeFixture } from "../scripts/ux/fixtures.mjs";

// An unanswered request proves neither refusal nor delivery. Custody must retain that distinction in every view.
for (const [engine, type, path] of ENGINES) for (const placement of ["empty", "newer", "away", "edit"] as const) {
  test(`uncertain custody ${engine}: ${placement} draft keeps the unknown-outcome warning`, { skip: engineSkip(engine) }, async (t) => {
    const page = await open(t, engine, type, path(), { route: "#/h/devbox/t/pi%3Asess-worker-gui" });
    const ids = new Set<number>();
    let reject: (() => void) | undefined;
    await routeFixture(page, {}, { requests: [] }, { through: (ws: WebSocketRoute) => ({
      connectToServer: () => ws.connectToServer(),
      onMessage: (fn: (m: string | Buffer) => void) => ws.onMessage(raw => {
        const frame = JSON.parse(String(raw));
        if (frame.op === "thread.submit") ids.add(frame.id);
        fn(raw);
      }),
      send: (raw: string) => {
        const frame = JSON.parse(raw);
        if (frame.t === "snap" && frame.value?.threads) for (const thread of Object.values(frame.value.threads) as any[]) thread.control = true;
        if (frame.t === "res" && ids.has(frame.id)) {
          reject = () => ws.send(JSON.stringify({ t: "res", id: frame.id, ok: false, error: { code: "host_disconnected", message: "devbox#pi" } }));
          return;
        }
        ws.send(JSON.stringify(frame));
      },
    }) });
    await page.reload();
    const input = page.getByRole("textbox", { name: "Message the agent" });
    await input.fill("Original message");
    await input.press("Enter");
    await eventually(async () => Boolean(reject), "submission response held");
    if (placement === "newer") await input.fill("Newer draft");
    if (placement === "away") {
      await page.getByRole("link", { name: "Overview", exact: true }).click();
      await input.waitFor({ state: "detached" });
    }
    reject!();
    // The next socket response settles before the navigation back; use the rendered destination as the boundary.
    if (placement === "away") {
      await page.getByText("Overview", { exact: true }).first().waitFor();
      await page.goBack();
      await input.waitFor();
    }
    await eventually(async () => (await input.inputValue()).includes(placement === "newer" ? "Newer draft" : "Original message") || (await page.locator(".returned").count()) > 0, "submission returned to its session");
    if (placement === "edit") await input.fill("Edited draft");
    const text = (await page.locator('.composer [role="alert"]').allTextContents()).join("\n");
    const evidence = process.env.AMPI_ADV_EVIDENCE;
    if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: `${evidence}/uncertain-${engine}-${placement}.png` }); }
    assert.ok(/may already|unknown|uncertain|check the Pi pane/i.test(text), `unknown delivery needs a warning, got: ${JSON.stringify(text)}`);
    assert.ok(!/Not sent:/i.test(text), `unknown delivery cannot be labelled Not sent: ${text}`);
  });
}
