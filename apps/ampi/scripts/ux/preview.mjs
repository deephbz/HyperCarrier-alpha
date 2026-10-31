#!/usr/bin/env node
// Generated AmPi previews: the same scenes played on two builds, shown before | after | diff in one gallery.
// AmPi previews are generated, never drawn (.pi/skills/verify-ampi/SKILL.md, "Preview a UI change").
//
//   npm run preview -- --base origin/main --head ampi/ui-density --only S03.x,S12.a
//   npm run preview -- --base origin/main --head ../.worktrees/ampi-ui        # a worktree: its tracked edits, untouched
//   npm run preview -- --base origin/main --head topic --variants a,b         # head once per ?variant=<v>
//   npm run preview -- --base origin/main --head topic --motion no-preference # normal motion; reduce by default
//
// Parent: resolve both sides to commits -> journey lock -> one disposable worktree per side (verify/checkout.mjs) ->
// one child per side in parallel (its own synthetic demo hub, the same DEMO_NOW seed, a frozen page clock) ->
// full-viewport pixel diffs -> output/ampi-preview/<run>/index.html. The scenes are recipes.mjs; the steps setup.mjs.
// The harness comes from this checkout; the app and the demo seed come from each side's commit.
import '../stdio-sync.cjs';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { recipes } from './recipes.mjs';
import { cropBox, parseArgs, resolveSide, selectScenes, shotsOf, verdict } from './preview-core.mjs';

const self = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const launchBrowser = (options) => chromium.launch(launchOptions(options));
// Pages read Date.now() at this offset after the demo seed: relative times are the same on both sides and every run.
const CLOCK_OFFSET_MS = 10 * 60_000;

if (args[0] === '--side') await side(JSON.parse(args[1]));
else await parent();

async function parent() {
  let opts;
  try { opts = parseArgs(args); } catch (error) { console.error(error.message); process.exit(2); }
  const { checkout } = await import('../verify/hub.mjs');
  const { prepareCheckout } = await import('../verify/checkout.mjs');
  const { acquireRunLock, PERF_HOME } = await import('../perf/lock.mjs');
  const started = Date.now();
  const secs = () => `${((Date.now() - started) / 1000).toFixed(1)} s`;
  const scenes = selectScenes(recipes, opts.only);
  const coverage = { ran: scenes.map(s => s.id), notRun: recipes.filter(r => !scenes.includes(r)).map(r => r.id) };
  const base = resolveSide(checkout, opts.base), head = resolveSide(checkout, opts.head);
  const warnings = [];
  for (const [name, s] of [['base', base], ['head', head]]) {
    const untracked = s.untracked.filter(f => f.startsWith('apps/ampi/'));
    if (untracked.length) warnings.push(`${name}: untracked files are not in the preview: ${untracked.join(', ')}`);
    if (s.submodules.length) warnings.push(`${name}: submodule working changes are not in the preview: ${s.submodules.join(', ')}`);
  }
  const runId = `preview-${new Date().toISOString().replace(/[:.]/g, '-')}-${base.sha.slice(0, 8)}-${head.sha.slice(0, 8)}`;
  const out = resolve(opts.out ?? join(checkout, 'output/ampi-preview', runId));
  mkdirSync(out, { recursive: true });
  // One demo seed for both sides, on a whole minute: the same Sessions with the same times.
  const demoNow = Math.floor(Date.now() / 60_000) * 60_000;
  const release = await acquireRunLock(`preview ${runId}`, { lock: join(PERF_HOME, 'journey.lock'), wait: true, timeoutMs: 15 * 60_000, onWait: o => console.log(`journey lock held by ${o.label} (pid ${o.pid}); queued`) });
  const trees = [];
  try {
    for (const s of [base, head]) { trees.push(prepareCheckout(checkout, s.sha)); console.log(`built ${s.sha.slice(0, 12)} · ${secs()}`); }
    const lockHash = dir => existsSync(join(dir, 'package-lock.json')) ? createHash('sha256').update(readFileSync(join(dir, 'package-lock.json'))).digest('hex').slice(0, 16) : 'none';
    const invoker = lockHash(checkout);
    const lockfiles = { invoker, base: lockHash(trees[0].dir), head: lockHash(trees[1].dir) };
    for (const name of ['base', 'head']) if (lockfiles[name] !== invoker) warnings.push(`${name}: package-lock.json differs from this checkout's (${lockfiles[name]} vs ${invoker}); node_modules are linked from this checkout, so the ${name} side may run other package versions`);
    const job = (label, tree, variants) => new Promise((done, fail) => {
      const spec = { label, out: join(out, label), scenes: scenes.map(s => s.id), themes: opts.themes, variants, motion: opts.motion, demoNow };
      const child = spawn(process.execPath, [self, '--side', JSON.stringify(spec)], { stdio: 'inherit', env: { ...process.env, AMPI_VERIFY_TARGET: tree.dir, AMPI_VERIFY_PROOF: join(out, label, 'proof') } });
      child.on('exit', code => code === 0 ? done(JSON.parse(readFileSync(join(out, label, 'side.json'), 'utf8'))) : fail(new Error(`${label} side exited ${code}`)));
    });
    const [before, after] = await Promise.all([job('base', trees[0], []), job('head', trees[1], opts.variants)]);
    console.log(`captured · ${secs()}`);
    for (const [name, s, side] of [['base', base, before], ['head', head, after]]) if (side.revision !== s.sha) warnings.push(`${name}: the hub read revision ${side.revision}, not the requested ${s.sha}`);
    const { diffPngs } = await import('./pixels.mjs');
    const { renderGallery } = await import('./gallery.mjs');
    const browser = await launchBrowser();
    const shots = [];
    try {
      const page = await browser.newPage();
      mkdirSync(join(out, 'diff'), { recursive: true });
      for (const scene of scenes) for (const variant of opts.variants.length ? opts.variants : [undefined]) for (const shot of shotsOf(scene, opts.themes, variant)) {
        const a = before.shots[shotsOf(scene, [shot.theme])[0].key], b = after.shots[shot.key];
        const boxes = [a.box, b.box].filter(Boolean);
        const d = await diffPngs(page, readFileSync(join(out, 'base', a.image)), readFileSync(join(out, 'head', b.image)), boxes);
        const image = `diff/${shot.key}.png`;
        writeFileSync(join(out, image), d.png);
        shots.push({ ...shot, viewport: b.viewport, crop: cropBox(boxes, b.viewport), sides: { before: { image: `base/${a.image}`, box: a.box, error: a.error }, after: { image: `head/${b.image}`, box: b.box, error: b.error } }, diff: { image, changed: d.changed, outside: d.outside, total: d.total } });
        for (const [name, s] of [['base', a], ['head', b]]) if (s.error) warnings.push(`${name} ${shot.key}: ${s.error}`);
      }
    } finally { await browser.close(); }
    const result = verdict({ base, head, variants: opts.variants, shots });
    const run = { schema: 'ampi-preview/1', runId, createdAt: new Date().toISOString(), base: { ...base, revision: before.revision }, head: { ...head, revision: after.revision }, demoNow, clock: demoNow + CLOCK_OFFSET_MS, motion: opts.motion, lockfiles, coverage, verdict: result, warnings, shots, durationMs: Date.now() - started };
    writeFileSync(join(out, 'preview.json'), JSON.stringify(run, null, 2) + '\n');
    writeFileSync(join(out, 'index.html'), renderGallery(run));
    const changed = shots.filter(s => s.diff.changed).length;
    for (const w of warnings) console.log(`warning: ${w}`);
    console.log(`${shots.length} shots, ${changed} changed · ${secs()}`);
    console.log(`gallery: ${pathToFileURL(join(out, 'index.html')).href}`);
    console.log(`open in a Herdr browser tab: /Applications/Herdr.app/Contents/MacOS/Herdr browser open ${join(out, 'index.html')}`);
    if (result.failed.length) console.error(`FAIL: ${result.failed.length} scene setups failed: ${result.failed.join(', ')}`);
    if (result.drift.length) console.error(`FAIL: A/A run changed ${result.drift.length} shots: ${result.drift.join(', ')}`);
    if (!result.ok) process.exitCode = 1;
  } finally {
    for (const t of trees) t.remove();
    release();
  }
}

/**
 * Shows the overlay scrollbar of `selector` for the shot. macOS draws it only while the element scrolls, so the wheel
 * scrolls down and back up to the same position: the bar shows and the reader keeps its place.
 */
async function showScrollbar(p, selector) {
  const scroller = await p.locator(selector).first().elementHandle();
  const box = await scroller.boundingBox();
  const top = await scroller.evaluate(el => el.scrollTop);
  // The right margin of the scroller holds no row, so the pointer starts no hover.
  await p.mouse.move(box.x + box.width - 24, box.y + box.height / 2);
  await p.mouse.wheel(0, 40);
  await p.waitForFunction(([el, top]) => el.scrollTop !== top, [scroller, top]);
  await p.mouse.wheel(0, -40);
  await p.waitForFunction(([el, top]) => el.scrollTop === top, [scroller, top]);
  await p.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
}

/** One side: a synthetic demo hub on AMPI_VERIFY_TARGET, every shot screenshotted at the full viewport. */
async function side({ label, out, scenes: ids, themes, variants, motion, demoNow }) {
  process.env.DEMO_NOW = String(demoNow);
  const { launch, doctor, settled, cleanup, keyOf } = await import('../verify/hub.mjs');
  const { routeFixture } = await import('./fixtures.mjs');
  const { setup } = await import('./setup.mjs');
  mkdirSync(out, { recursive: true });
  const state = await launch({ runId: label });
  const result = { label, revision: state.revision, shots: {} };
  const browser = await launchBrowser();
  // Playwright's headless Chromium hides scrollbars; a `scrollbar` scene uses a browser that shows them.
  let shown;
  try {
    const health = await doctor(state);
    if (!health.ok) throw new Error(`${label} doctor: ` + JSON.stringify(health.checks.filter(c => !c.ok)));
    await settled(state);
    for (const scene of selectScenes(recipes, ids)) for (const variant of variants.length ? variants : [undefined]) for (const shot of shotsOf(scene, themes, variant)) {
      const viewport = { width: scene.width ?? 1280, height: 900 };
      const host = scene.scrollbar ? (shown ??= await launchBrowser({ ignoreDefaultArgs: ['--hide-scrollbars'] })) : browser;
      const context = await host.newContext({ viewport, colorScheme: shot.theme, locale: 'en-GB', timezoneId: 'UTC', reducedMotion: motion });
      const audit = { requests: [], externalRequests: [], pageErrors: [] };
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== state.origin && url.protocol !== 'data:') { audit.externalRequests.push(url.origin); return route.abort(); }
        return route.continue();
      });
      const p = await context.newPage();
      p.setDefaultTimeout(10_000);
      await routeFixture(p, scene, audit, { clock: demoNow + CLOCK_OFFSET_MS });
      p.on('pageerror', e => audit.pageErrors.push(e.message));
      const entry = { viewport, image: `${shot.key}.png` };
      try {
        await p.goto(`${state.origin}/?k=${keyOf(state)}${variant ? `&variant=${encodeURIComponent(variant)}` : ''}${scene.route}`);
        await p.locator('.app').waitFor({ timeout: 30_000 });
        if (!['loading', 'error'].includes(scene.variant)) await p.waitForFunction(() => document.querySelectorAll('.side-scroll [data-thread]').length > 0 || /No (timestamped |long )?Sessions yet\./.test(document.body.textContent));
        if (scene.route.includes('/t/') && !['loading', 'error'].includes(scene.variant)) await p.locator('.composer').waitFor();
        await setup(p, scene, { demo: state.demo });
      } catch (error) { entry.error = String(error.message).split('\n')[0]; }
      await p.evaluate(() => document.fonts.ready).catch(() => {});
      await p.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))).catch(() => {});
      if (scene.scrollbar && !entry.error) await showScrollbar(p, scene.scrollbar).catch(error => { entry.error = String(error.message).split('\n')[0]; });
      if (scene.target) {
        const t = p.locator(scene.target).first();
        if (await t.count() && await t.isVisible()) entry.box = await t.boundingBox();
      }
      await p.screenshot({ path: join(out, entry.image), animations: 'disabled', caret: 'hide' });
      if (audit.externalRequests.length || audit.pageErrors.length) entry.audit = { externalRequests: audit.externalRequests, pageErrors: audit.pageErrors };
      result.shots[shot.key] = entry;
      console.log(`${label} ${shot.key}${entry.error ? ` · ${entry.error}` : ''}`);
      await context.close();
    }
  } finally {
    await browser.close().catch(() => {});
    await shown?.close().catch(() => {});
    await cleanup(state);
  }
  writeFileSync(join(out, 'side.json'), JSON.stringify(result, null, 2) + '\n');
}
