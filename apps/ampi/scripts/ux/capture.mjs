#!/usr/bin/env node
// Purpose: regenerate the exploration wireflow from a disposable synthetic Pi hub.
// No endpoint argument is accepted. All browser mutations terminate in fixtureSocket.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { recipes, thread } from './recipes.mjs';
import { fixtureSocket } from './fixtures.mjs';
import { renderGrid } from './render.mjs';
import { setup } from './setup.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = join(app, 'docs/ux');
const root = resolve(app, '../..');
const selected = process.env.UX_ONLY ? recipes.filter(r => process.env.UX_ONLY.split(',').includes(r.id)) : recipes;
if (!selected.length) throw new Error('No matching recipe');
const temp = await mkdtemp(join(tmpdir(), 'ampi-ux-'));
const audit = { requests: [], forwardedMutations: 0, externalRequests: [], pageErrors: [] };
const child = spawn(process.execPath, ['scripts/pi-demo.ts'], { cwd: app, detached: true, env: { ...process.env, HOME: temp, AMPI_HOME: join(temp, 'home'), AMPI_HUB_CONFIG: join(temp, 'home/hub.json'), PI_CODING_AGENT_DIR: join(temp, 'agent'), DEMO_DIR: join(temp, 'demo'), PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser, browserServer;
async function launchBrowser() {
  browserServer = await chromium.launchServer({ headless: true, timeout: 60_000, ...(process.env.UX_CHROME_CHANNEL ? { channel: process.env.UX_CHROME_CHANNEL } : {}) });
  return chromium.connect(browserServer.wsEndpoint(), { timeout: 60_000 });
}
async function closeBrowser() {
  // Own the disposable process. Graceful close stalled in long capture runs.
  const owned = browserServer?.process();
  if (owned && owned.exitCode === null && owned.signalCode === null) {
    const exited = new Promise(done => owned.once('exit', done));
    try { process.kill(-owned.pid, 'SIGKILL'); } catch { owned.kill('SIGKILL'); }
    await exited;
  }
  browserServer = undefined; browser = undefined;
}
let logs = '';
const hubURL = await new Promise((done, fail) => {
  const timeout = setTimeout(() => fail(new Error('Synthetic hub did not start within 30 seconds')), 30_000);
  child.on('exit', code => { clearTimeout(timeout); fail(new Error(`Demo exited ${code}: ${logs}`)); });
  child.stderr.on('data', data => { logs += data; });
  child.stdout.on('data', data => {
    logs += data;
    const match = logs.match(/demo hub: (http:\/\/127\.0\.0\.1:(\d+)\/\?k=d+)/);
    if (match) { clearTimeout(timeout); if (match[2] === '7879') fail(new Error('Forbidden port')); else done(match[1]); }
  });
}).catch(async error => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} await rm(temp, { recursive: true, force: true }); throw error; });

const deadline = async (promise, label, ms = 90_000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms); })]); }
  finally { clearTimeout(timer); }
};
async function elements(p) {
  return p.evaluate(() => {
    const selector = 'button,a[href],input:not([type=hidden]),textarea,select,summary,[role=button],[role=option],[role=separator],[tabindex],.tool-head,.change-row,.task-card,.rb-item,g[data-task],[data-images] img,.cos-band svg,.subthread-link,.thread-row,.worker-row,[data-task],.side-head,.row[data-thread]';
    const result = [], used = new Map();
    for (const el of document.querySelectorAll(selector)) {
      if (el.closest('[inert]') || el.closest('details:not([open])') && el.closest('details:not([open])').querySelector('summary') !== el && !el.closest('summary')) continue;
      let box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (!box.width || !box.height || style.visibility === 'hidden' || style.display === 'none') continue;
      let clip = { x: Math.max(0, box.x), y: Math.max(0, box.y), right: Math.min(innerWidth, box.right), bottom: Math.min(innerHeight, box.bottom) };
      for (let a = el.parentElement; a; a = a.parentElement) {
        const s = getComputedStyle(a), b = a.getBoundingClientRect();
        if (/(hidden|auto|scroll|clip)/.test(s.overflowX)) { clip.x = Math.max(clip.x, b.x); clip.right = Math.min(clip.right, b.right); }
        if (/(hidden|auto|scroll|clip)/.test(s.overflowY)) { clip.y = Math.max(clip.y, b.y); clip.bottom = Math.min(clip.bottom, b.bottom); }
      }
      if (clip.right <= clip.x + 1 || clip.bottom <= clip.y + 1) continue;
      const href = el.getAttribute('href');
      const name = (el.getAttribute('aria-label') || el.getAttribute('title') || (el.matches('input,textarea') ? el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('type') : el.textContent) || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 200);
      const fixture = el.closest('[data-entry],[data-thread],[data-rarebit],[data-task],[data-git-file]') ?? el.querySelector('[data-entry]');
      const context = fixture ? [...fixture.attributes].filter(a => a.name.startsWith('data-')).map(a => a.name + '=' + a.value).join(';') : el.closest('[role=dialog],.panel,.topbar,.sidebar,.composer,.cos-toolbar')?.className ?? '';
      // Demo timestamps move with the clock. Entry context identifies the same control.
      const stableHref = href?.replace(/([?&](?:at|from|to)=)\d+/g, '$1<time>') ?? '';
      const stableName = el.matches('.rb-tools summary') ? name.replace(/ ·.*$/, '') : name.replace(/\b[0-9a-f]{32}\.jsonl\b/gi, '<session>.jsonl');
      const base = [el.tagName, el.getAttribute('role') || '', stableName, stableHref, String(context)].join('|');
      const ordinal = used.get(base) || 0; used.set(base, ordinal + 1);
      const key = base + (ordinal ? `|duplicate:${ordinal}` : '');
      const path = []; for (let n = el; n && n !== document.body; n = n.parentElement) { const siblings = [...n.parentElement.children].filter(x => x.tagName === n.tagName); path.unshift(n.tagName.toLowerCase() + (siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(n) + 1})` : '')); }
      result.push({ key, name, tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), selector: 'body > ' + path.join(' > '), href, enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true', readOnly: Boolean(el.readOnly), hoverOnly: Number(style.opacity) === 0, covered: (() => { const hit = document.elementFromPoint((clip.x + clip.right) / 2, (clip.y + clip.bottom) / 2); return Boolean(hit && hit !== el && !el.contains(hit) && !hit.contains(el)); })(), bounds: { x: +clip.x.toFixed(1), y: +clip.y.toFixed(1), width: +(clip.right - clip.x).toFixed(1), height: +(clip.bottom - clip.y).toFixed(1) } });
    }
    return result;
  });
}

try {
  await mkdir(join(out, 'screens'), { recursive: true });
  browser = await launchBrowser();
  let previous; try { previous = JSON.parse(await readFile(join(out, 'map.json'), 'utf8')); } catch {}
  const nodes = [];
  for (const [index, r] of selected.entries()) {
    // Keep the capture process bounded across a large inventory.
    if (index && index % 20 === 0) {
      await deadline(closeBrowser(), 'capture batch cleanup');
      browser = await deadline(launchBrowser(), 'capture batch browser');
    }
    console.log(`Capturing ${r.id}`);
    const context = await deadline(browser.newContext({ viewport: { width: r.width ?? 1280, height: 900 }, colorScheme: r.theme ?? 'light', locale: 'en-GB', timezoneId: 'UTC', reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] }), `${r.id} context`);
    const p = await deadline(context.newPage(), `${r.id} page`);
    p.setDefaultTimeout(8000);
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== new URL(hubURL).origin) { audit.externalRequests.push(url.origin); return route.abort(); }
      return route.continue();
    });
    await p.routeWebSocket('**/ws', ws => fixtureSocket(ws, r, audit));
    p.on('pageerror', e => audit.pageErrors.push({ state: r.id, message: e.message }));
    await p.goto(hubURL + r.route);
    await p.locator('.app').waitFor();
    if (!['loading', 'error'].includes(r.variant)) await p.waitForFunction(() => document.querySelectorAll('.side-scroll [data-thread]').length > 0 || document.body.textContent.includes('No Sessions yet.') || document.body.textContent.includes('No timestamped Sessions yet.') || document.body.textContent.includes('No long Sessions yet.'));
    if (r.route.includes('/t/') && !['loading', 'error'].includes(r.variant)) await p.locator('.composer').waitFor();
    if (!r.variant?.includes('loading') && r.family === 'Rarebit') await p.waitForFunction(() => document.querySelector('.rb-message,.rb-state,.rb-error'));
    if (r.family === 'Team' && !['loading-view', 'error-view'].includes(r.variant)) await p.waitForFunction(() => document.querySelector('.ptb section,.ptb-notice,.ptb-hint'));
    if (r.family === 'Arc' && !['loading-view', 'missing'].includes(r.variant)) await p.locator('.cos-toolbar button').waitFor();
    if (r.family === 'Timeline' && !['loading', 'error', 'empty'].includes(r.variant)) await p.locator('.cos-band-label').first().waitFor();
    await setup(p, r);
    await deadline(p.evaluate(() => document.fonts.ready), `${r.id} fonts`);
    await deadline(p.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))), `${r.id} layout`);
    const es = await elements(p);
    const oldNode = previous?.nodes.find(n => n.id === r.id);
    const ids = new Map(Object.entries(oldNode?.elementIds ?? Object.fromEntries((oldNode?.elements ?? []).map(e => [e.key, e.id]))));
    let counter = Math.max(0, ...[...ids.values()].map(id => Number(id.slice(1))));
    for (const e of es) { e.id = ids.get(e.key) ?? `C${String(++counter).padStart(3, '0')}`; ids.set(e.key, e.id); }
    const text = await p.locator('body').innerText();
    if (/MacBook|\/Users\//.test(text)) throw new Error(`Private host identity/path in ${r.id}`);
    await p.screenshot({ path: join(out, 'screens', r.id + '.png'), animations: 'disabled', timeout: 30_000 });
    nodes.push({ ...r, screenshot: `screens/${r.id}.png`, viewport: { width: r.width ?? 1280, height: 900 }, theme: r.theme ?? 'light', evidence: r.variant || r.node ? 'synthetic browser projection' : 'synthetic demo hub', elementIds: Object.fromEntries(ids), elements: es, assertions: { appRendered: true, setupCompleted: true }, text: text.slice(-1800) });
    console.log(`${r.id} ${r.title}: ${es.length} controls`);
    await deadline(context.close(), `${r.id} context close`);
  }
  if (audit.pageErrors.length) throw new Error('UI page errors: ' + JSON.stringify(audit.pageErrors));
  const edges = makeEdges(nodes);
  const sourceRevision = execFileSync('git', ['log', '-1', '--format=%H', '--', 'apps/ampi/web/src', 'apps/ampi/scripts/pi-demo.ts', 'apps/ampi/scripts/demo'], { cwd: root, encoding: 'utf8' }).trim();
  const map = { schema: 'ampi-wireflow/1', status: 'exploration; owner review pending', capturedAt: new Date().toISOString(), sourceRevision, browser: browser.version(), syntheticOnly: true, partialRun: Boolean(process.env.UX_ONLY), limits: ['Nodes are explicit state recipes, not every possible combination.', 'Only viewport-visible controls have measured bounds; scroll/hover states are separate recipes.', 'Inferred edges are not navigation proof. Browser-checked setup transitions are marked separately.', 'Frozen node UI uses browser-only projections. It does not establish node backend support.'], audit: { ...audit, requestCount: audit.requests.length }, nodes, edges };
  await writeFile(join(out, process.env.UX_ONLY ? 'map.partial.json' : 'map.json'), JSON.stringify(map, null, 2) + '\n');
  if (!process.env.UX_ONLY) {
    // Use a fresh browser after the many capture contexts.
    await deadline(closeBrowser(), 'capture browser cleanup');
    browser = await launchBrowser();
    await deadline(renderGrid(map, out, browser), 'grid rendering', 90_000);
  }
  console.log(JSON.stringify({ nodes: nodes.length, elements: nodes.reduce((n, s) => n + s.elements.length, 0), edges: edges.length, grid: 'apps/ampi/docs/ux/map.html' }));
} finally {
  await deadline(closeBrowser(), 'browser cleanup').catch(error => console.error(error.message));
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  await deadline(new Promise(done => child.exitCode !== null || child.signalCode !== null ? done() : child.once('exit', done)), 'demo cleanup').catch(error => console.error(error.message));
  await rm(temp, { recursive: true, force: true });
}

// These targets run one explicit click through setup() and capture its resulting UI.
// Multi-step and keyboard recipes remain recipes; no single-control proof is inferred.
function checkedTransitions() { return [
  { from: 'S03.a', to: 'S03.i', matches: /^More actions$/ },
  { from: 'S04.a', to: 'S04.b', matches: /^Hide continuations$/ },
  { from: 'S04.a', to: 'S04.c', matches: /^Models$/ },
  { from: 'S04.a', to: 'S04.d', matches: /^Diagnosis/ },
  { from: 'S04.a', to: 'S04.k', matches: /^Recap$/ },
  { from: 'S04.a', to: 'S04.l', matches: /^Transcript mode: full transcript$/ },
  { from: 'S04.a', to: 'S04.q', matches: /^Previous user message$/ },
  { from: 'S04.k', to: 'S04.s', matches: /^Recap$/ },
  { from: 'S04.s', to: 'S04.t', matches: /^Recap$/ },
  { from: 'S04.l', to: 'S04.u', matches: /^(?:\d+ tool calls?|thinking) ·/ },
  { from: 'S05.a', to: 'S05.c', matches: /^Graph$/ },
  { from: 'S06.d', to: 'S06.e', matches: /^Build arc$/ },
  { from: 'S07.a', to: 'S07.b', matches: /^New workspace$/ },
  { from: 'S01.a', to: 'S01.h', matches: /^Zoom in$/ },
  { from: 'S01.a', to: 'S08.a', matches: /^Add host$|^\+ Add host/ },
  { from: 'S09.a', to: 'S09.d', matches: /^Synthetic API key$/ },
  { from: 'S09.a', to: 'S09.e', matches: /^Synthetic subscription$/ },
]; }
function makeEdges(nodes) {
  const byId = new Set(nodes.map(n => n.id));
  const canonical = new Map();
  for (const n of nodes) if (!n.setup && !n.variant && !n.node) { const key = n.route.split('?')[0]; if (!canonical.has(key)) canonical.set(key, n.id); }
  const edges = [];
  for (const n of nodes) for (const e of n.elements) {
    let target = n.id, kind = 'local-action', evidence = 'inferred; outcome not exercised';
    const name = e.name;
    if (e.href?.startsWith('#/')) {
      const panel = new URLSearchParams(e.href.split('?')[1]).get('p');
      target = panel === 'rarebit' ? 'S04.a' : panel === 'team' ? 'S05.a' : canonical.get(e.href.split('?')[0]) ?? (e.href.includes('/t/') ? 'S03.a' : e.href.includes('/arcs/') ? 'S06.d' : n.id);
      kind = 'navigation'; evidence = 'declared href; representative destination';
    } else {
      const rules = [[/^More actions$/, 'S03.i'], [/^Models$/, 'S04.c'], [/^Diagnosis/, 'S04.d'], [/^Graph$/, 'S05.c'], [/^List$/, 'S05.a'], [/^New workspace$/, 'S07.b'], [/^\+ New agent|^New agent beside|^New thread|^\+ New thread/, 'S07.a'], [/^Close pane…|^Stop Pi and free/, 'S07.d'], [/^Add host$|^\+ Add host/, 'S08.a'], [/^Hide continuations$/, 'S04.b'], [/^Transcript mode: full transcript$/, 'S04.l'], [/^Recap$/, 'S04.k'], [/^Ask$/, 'S04.i'], [/^End$/, 'S04.a'], [/^Build arc$/, 'S06.e']];
      const matched = rules.find(([test]) => test.test(name)); if (matched) target = matched[1];
      if (/^Cancel$|^Close$|^Done$/.test(name)) target = n.family === 'Settings' ? 'S02.d' : n.family.includes('dialogs') ? 'S03.a' : n.id;
    }
    if (!byId.has(target)) target = n.id;
    const checked = checkedTransitions().find(t => t.from === n.id && t.matches.test(name) && n.elements.find(candidate => t.matches.test(candidate.name)) === e && byId.has(t.to));
    if (checked) { target = checked.to; evidence = 'browser-checked setup; target captured after click'; kind = 'state-change'; }
    if (e.covered) { kind = 'covered'; target = n.id; evidence = 'observed occluded centre; inspect after overlay closes'; }
    if (!e.enabled) { kind = 'disabled'; target = n.id; evidence = 'observed disabled control; no transition'; }
    if (e.readOnly) { kind = 'read-only'; target = n.id; evidence = 'observed read-only field'; }
    edges.push({ id: `${n.id}/${e.id}`, from: n.id, element: e.id, to: target, kind, evidence });
  }
  return edges;
}
