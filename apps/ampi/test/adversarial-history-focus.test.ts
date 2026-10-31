import "./bound.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ENGINES, open, sidesSettled } from "./resize-edges-fixture.ts";
import { engineSkip } from "./engines.ts";
const proof = process.env.ADV_PROOF ?? "output/adversarial-history-focus";
mkdirSync(proof, { recursive: true });
const frames = async (page: any, n = 4) => page.evaluate((n: number) => new Promise<void>(resolve => { const tick = () => --n > 0 ? requestAnimationFrame(tick) : resolve(); requestAnimationFrame(tick); }), n);
for (const [engine, type, path] of ENGINES) for (const zoom of [0.8, 1, 1.3]) for (const width of [1000, 390]) test(`adversarial history/focus ${engine} ${zoom} ${width}: Back after reload keeps the rail reading anchor`, { skip: engineSkip(engine) }, async t => {
  const page = await open(t, engine, type, path(), { display: { overall: zoom }, route: "#/h/devbox/t/pi%3Asess-big" });
  if (await page.getByTitle("Close panel", { exact: true }).isVisible()) await page.getByTitle("Close panel", { exact: true }).click();
  await page.setViewportSize({ width, height: 720 });
  await sidesSettled(page);
  const hide = page.getByRole("button", { name: "Hide sidebar", exact: true });
  if (await hide.isVisible()) await hide.click();
  const transcript = page.locator('[data-region="transcript"]');
  const composer = page.getByRole("textbox", { name: "Message the agent", exact: true });
  const region = () => page.evaluate(() => document.activeElement?.closest<HTMLElement>("[data-region]")?.dataset.region ?? document.activeElement?.tagName);
  const focusChecks: any[] = [];
  for (const target of ["composer", "transcript"]) {
    await (target === "composer" ? composer : transcript).focus();
    await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
    await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
    await page.waitForFunction(wanted => document.activeElement?.closest<HTMLElement>("[data-region]")?.dataset.region === wanted, target, { timeout: 3000 });
    focusChecks.push({ target, actual: await region() });
  }
  await page.locator("[data-user-mark]").first().waitFor({ state: "attached" });
  await transcript.evaluate(el => { el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 1500); });
  await frames(page);
  await page.waitForFunction(() => Boolean(history.state?.place?.id));
  const before = await transcript.evaluate(el => {
    const r = el.getBoundingClientRect(), line = r.top + r.height / 2;
    const entry = [...el.querySelectorAll<HTMLElement>("[data-entry]")].find(e => !e.closest("summary") && e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().bottom > line)!;
    return { id: entry.dataset.entry!, fragment: entry.dataset.fragment, offset: entry.getBoundingClientRect().top - r.top, scrollTop: el.scrollTop };
  });
  await transcript.click({ position: { x: 20, y: 120 } });
  await frames(page);
  const beforeLeave = { region: await region(), state: await page.evaluate(() => history.state) };
  assert.equal(beforeLeave.region, "transcript", "the owner leaves from the transcript");
  const session = page.url();
  await page.keyboard.press("ControlOrMeta+Digit0");
  await page.waitForURL(/#\/v\/overview/);
  await page.reload();
  await page.locator("[data-page-root]").waitFor();
  await page.evaluate(() => {
    (window as any).__historyFocus = [];
    document.addEventListener("focusin", e => {
      const el = e.target as HTMLElement;
      (window as any).__historyFocus.push({ region: el.closest<HTMLElement>("[data-region]")?.dataset.region, tag: el.tagName, label: el.getAttribute("aria-label") });
    });
  });
  const checks: any[] = [];
  for (const carrier of ["browser", "app"]) {
    if (carrier === "browser") await page.evaluate(() => history.back());
    else {
      await page.evaluate(() => { (window as any).webkit = { messageHandlers: { ampi: { postMessage() {} } } }; });
      await page.keyboard.press("ControlOrMeta+BracketLeft");
    }
    await page.waitForURL(session);
    await transcript.waitFor();
    await page.locator("[data-user-mark]").first().waitFor({ state: "attached" });
    await frames(page, 12);
    await page.waitForFunction(() => document.activeElement?.closest<HTMLElement>("[data-region]")?.dataset.region === "transcript", undefined, { timeout: 3000 }).catch(() => {});
    const after = await transcript.evaluate((el, anchor) => {
      const nodes = [...el.querySelectorAll<HTMLElement>("[data-entry]")].filter(e => e.dataset.entry === anchor.id && e.dataset.fragment === anchor.fragment && !e.closest("summary"));
      const offsets = nodes.map(e => e.getBoundingClientRect().top - el.getBoundingClientRect().top);
      return { offsets, scrollTop: el.scrollTop, region: document.activeElement?.closest<HTMLElement>("[data-region]")?.dataset.region, rail: document.querySelectorAll("[data-user-mark]").length };
    }, before);
    checks.push({ carrier, after });
    writeFileSync(join(proof, `${engine}-${zoom}-${width}-history-focus.json`), JSON.stringify({ before, beforeLeave, checks, focusChecks, focusEvents: await page.evaluate(() => (window as any).__historyFocus), stateAfter: await page.evaluate(() => history.state) }, null, 2));
    await page.screenshot({ path: join(proof, `${engine}-${zoom}-${width}-${carrier}-back.png`) });
    assert.ok(after.offsets.some(offset => Math.abs(offset - before.offset) <= 2), `${carrier} changed entry ${before.id} at ${before.offset}: ${JSON.stringify(after)}`);
    assert.equal(after.region, "transcript", "a late Composer mount must not steal the history focus");
    if (carrier === "browser") {
      await page.evaluate(() => history.forward());
      await page.waitForURL(/#\/v\/overview/);
    }
  }
});
