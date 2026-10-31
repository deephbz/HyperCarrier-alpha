import "./bound.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Page } from "playwright";
import { ENGINES, open, sidesSettled } from "./resize-edges-fixture.ts";
import { engineSkip } from "./engines.ts";

// Owner incidents B1/B2: an overlay must neither scroll its ancestors nor grow the document. Every Popover member
// (Popover.tsx) and the palette dialog is checked: it opens inside the viewport near its anchor, changes no region box
// and no scroll offset, and renders outside every display region, so a region's zoom or scroller cannot reach it.
const proof = process.env.ADV_PROOF ?? "output/adversarial-overlays";
mkdirSync(proof, { recursive: true });
const frames = (p: Page) => p.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const geometry = (p: Page) => p.evaluate(() => ({
  document: [document.documentElement.scrollWidth, document.documentElement.scrollHeight, window.scrollX, window.scrollY],
  regions: [...document.querySelectorAll<HTMLElement>("[data-region], .topbar")].map(el => {
    const r = el.getBoundingClientRect();
    return [el.dataset.region ?? "topbar", r.x, r.y, r.width, r.height, el.scrollTop, el.scrollLeft];
  }),
  scrolled: [...document.querySelectorAll<HTMLElement>("*")].filter(el => !el.closest(".popover, .modal-back") && (el.scrollTop || el.scrollLeft))
    .map(el => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} ${el.scrollLeft},${el.scrollTop}`),
}));
/** Fixed boxes inside a display region: an overlay there takes the region's zoom and scrolls with it. */
const inRegion = (p: Page) => p.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-region] *")]
  .filter(el => getComputedStyle(el).position === "fixed").map(el => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`));
/** The gap between two boxes, 0 when they touch or overlap. */
const apart = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width), a.y - (b.y + b.height), b.y - (a.y + a.height));
/** True when two boxes share more than a hairline. */
const covers = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1;
const bounds = (p: Page, selector: string) => p.locator(selector).evaluate(el => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height, viewport: [innerWidth, innerHeight], inside: r.x >= -1 && r.y >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 };
});
for (const [engine, type, path] of ENGINES) for (const zoom of [0.8, 1, 1.3]) for (const width of [1000, 390]) for (const theme of ["light", "dark"] as const) {
  const label = `${engine}-${zoom}-${width}-${theme}`;
  test(`adversarial overlays ${label}`, { skip: engineSkip(engine) }, async t => {
    const page = await open(t, engine, type, path(), { display: { overall: zoom }, route: "#/h/devbox/t/pi%3Asess-big" });
    t.after(async () => { await page.screenshot({ path: join(proof, `${label}-final.png`) }).catch(() => {}); });
    page.setDefaultTimeout(4000);
    const closePanel = page.getByTitle("Close panel", { exact: true });
    if (await closePanel.isVisible()) await closePanel.click();
    await page.setViewportSize({ width, height: width === 390 ? 720 : 650 });
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate(theme => { localStorage.setItem("ampi.theme", theme); document.documentElement.dataset.theme = theme; }, theme);
    await sidesSettled(page);
    const hide = page.getByRole("button", { name: "Hide sidebar", exact: true });
    if (width === 390 && await hide.isVisible()) await hide.click();
    await page.locator("[data-user-mark]").first().waitFor({ state: "attached" });
    await frames(page);
    const failures: string[] = [], observations: Record<string, unknown> = {};
    const check = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
    const before = await geometry(page);
    await page.locator(".prompt-rail").hover();
    await page.locator(".prompt-outline").waitFor();
    await frames(page);
    const after = await geometry(page), outline = await bounds(page, ".prompt-outline"), rail = await bounds(page, ".prompt-rail");
    observations.rail = { before, after, outline, rail };
    check(JSON.stringify(before) === JSON.stringify(after), "B1: rail hover changes layout or ancestor scroll");
    check(outline.inside, "B1: outline leaves viewport");
    check(!covers(outline, rail), "B1: outline covers the rail");
    await page.screenshot({ path: join(proof, `${label}-rail.png`) });
    await page.mouse.move(1, 1);
    await page.locator(".prompt-outline").waitFor({ state: "detached" });

    // The other members, each from its own anchor. The anchor box is in viewport px; a member at most 16 px away is near it.
    // The quote pill needs a Session with a control socket, which the demo hub has none of; quote-selection and
    // display-units place it at each zoom, and popover-owner keeps it a Popover.
    const box = async (selector: string) => (await page.locator(selector).first().boundingBox())!;
    // Playwright scrolls an action's target into view first; the loop reveals each anchor before it records the layout.
    const composer = '[data-region="composer"] textarea';
    const members: { name: string; anchor: string; popover: string; open: () => Promise<unknown>; close: () => Promise<unknown> }[] = [
      { name: "more menu", anchor: 'summary[aria-label="More actions"]', popover: ".t-more-menu", open: () => page.locator('summary[aria-label="More actions"]').click(), close: () => page.keyboard.press("Escape") },
      { name: "title card", anchor: ".session-title-line", popover: ".session-metadata", open: () => page.hover(".session-title-line"), close: () => page.mouse.move(1, 1) },
      { name: "model card", anchor: ".model-hud-trigger", popover: ".session-metadata", open: () => page.hover(".model-hud-trigger"), close: () => page.mouse.move(1, 1) },
      { name: "slash menu", anchor: '[data-region="composer"]', popover: ".slash-menu", open: () => page.locator(composer).fill("/"), close: () => page.locator(composer).fill("") },
      { name: "palette", anchor: '[data-region="main"], .main-slot', popover: ".modal", open: () => page.keyboard.press("ControlOrMeta+k"), close: () => page.keyboard.press("Escape") },
    ];
    for (const member of members) {
      await page.locator(member.anchor).first().scrollIntoViewIfNeeded();
      await frames(page);
      const was = await geometry(page);
      await member.open();
      await page.locator(member.popover).first().waitFor();
      await frames(page);
      const anchor = await box(member.anchor);
      const now = await geometry(page), got = await bounds(page, member.popover), stray = await inRegion(page);
      observations[member.name] = { anchor, before: was, after: now, box: got, stray };
      check(JSON.stringify(was) === JSON.stringify(now), `${member.name}: changes layout or ancestor scroll`);
      check(got.inside, `${member.name}: leaves viewport`);
      check(member.name === "palette" || apart(got, anchor) <= 16, `${member.name}: far from its anchor`);
      check(member.name === "palette" || !covers(got, anchor), `${member.name}: covers its anchor`);
      // A card's stylesheet width is 520 CSS px; Popover alone narrows it, to the viewport less its two 12 px edges.
      if (member.popover === ".session-metadata") check(got.width >= Math.min(520 * zoom, width - 24) - 1, `${member.name}: ${got.width} px wide in a ${width} px viewport`);
      check(stray.length === 0, `${member.name}: fixed boxes inside a display region: ${stray.join(", ")}`);
      await member.close();
      await page.locator(member.popover).waitFor({ state: "detached" });
    }

    const show = page.getByRole("button", { name: "Show sidebar", exact: true });
    if (await show.isVisible()) await show.click();
    const rows = page.locator(".side .row[data-thread]");
    await rows.first().waitFor();
    // A real row close to the bottom exercises the owner's off-screen menu incident.
    const row = rows.last();
    await row.scrollIntoViewIfNeeded();
    const rb = (await row.boundingBox())!;
    const point = { x: rb.x + Math.min(rb.width / 2, 100), y: rb.y + rb.height / 2 };
    const menuBefore = await geometry(page);
    await page.mouse.click(point.x, point.y, { button: "right" });
    await page.screenshot({ path: join(proof, `${label}-menu-attempt.png`) });
    writeFileSync(join(proof, `${label}-attempt.json`), JSON.stringify({ point, rb, menuBefore }, null, 2));
    await page.locator(".row-menu").waitFor();
    await frames(page);
    const menuAfter = await geometry(page), menu = await bounds(page, ".row-menu");
    observations.menu = { point, before: menuBefore, after: menuAfter, menu };
    check(JSON.stringify(menuBefore) === JSON.stringify(menuAfter), "B2: row menu changes layout or ancestor scroll");
    check(menu.inside, "B2: row menu leaves viewport");
    check(Math.abs(menu.y - point.y) <= menu.height + 12, "B2: row menu far from pointer");
    check((await inRegion(page)).length === 0, "B2: fixed boxes inside a display region");
    await page.screenshot({ path: join(proof, `${label}-menu.png`) });
    await page.keyboard.press("Escape");
    observations.failures = failures;
    writeFileSync(join(proof, `${label}.json`), JSON.stringify(observations, null, 2));
    assert.deepEqual(failures, [], JSON.stringify(observations));
  });
}
