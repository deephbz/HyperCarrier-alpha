#!/usr/bin/env node
// Lane-1 UI invariants: run the rows a–f class checks (invariants/rules.mjs) over the capture recipes' screen states.
//
//   node scripts/verify/invariants.mjs            fast lane: top-task states at 1280 plus each seed at its width
//   node scripts/verify/invariants.mjs --all      exhaustive lane: every recipe at 1024, 1280 and 1600, light and dark
//   --only S03.a,seed-e   pick states            --rows abc   pick rows            --web <dist>   serve another web build
//
// States come from scripts/ux/recipes.mjs and reach the page through fixtureSocket and setup.mjs, as in capture.mjs.
// The demo hub serves only HTTP. `--web` swaps the served index and assets, so a seed's pre-fix build can be checked
// with this checkout's runner. Feature doc: .pi/skills/verify-ampi/features/ui-invariants.md.
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { recipes, thread } from '../ux/recipes.mjs';
import { fixtureSocket } from '../ux/fixtures.mjs';
import { setup } from '../ux/setup.mjs';
import { launch, doctor, cleanup, keyOf, redact, tieToProcess } from './hub.mjs';
import { threadsSnapshot } from './live-rows.mjs';
import { AMPI, CLASSIC_SCROLLBARS, SCROLLBAR_LAUNCH, checkPage, observeLayoutShifts, rowBoxes } from './invariants/rules.mjs';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const all = args.includes('--all');
const only = opt('--only')?.split(',');
const rows = opt('--rows') ?? 'abcdef';
const web = opt('--web') && resolve(opt('--web'));
if (web && !existsSync(join(web, 'index.html'))) throw new Error(`--web ${web}: no index.html`);

const byId = Object.fromEntries(recipes.map(r => [r.id, r]));
/** Seeds: each reproduces one owner report on its pre-fix commit (features/ui-invariants.md). */
const seeds = [
  // Rows a–d: the sidebar with every Team expanded. Builds before the fix show workers without a toggle. Team titles
  // take the owner's `team/lens …` shape for row c; the demo titles share no prefix.
  { ...byId['S03.b'], id: 'seed-sidebar', setup: undefined, width: 1280, title: 'Sidebar · Teams expanded, team/lens titles', extra: 'expand-teams', titles: 'team-lens' },
  // Row e: the composer's model hover card over a long transcript scrolled to its end, in a short window.
  { ...byId['S03.a'], id: 'seed-e', route: thread('big'), width: 1024, height: 640, title: 'Session · model hover card, long transcript, 1024×640', extra: 'hover-model' },
  // Row f: Timeline lane labels at the narrow width.
  { ...byId['S01.a'], id: 'seed-f', width: 1024, title: 'Timeline · 1024, 10 more Sessions in 24 h', sessions: 10 },
];
const FAST = ['S02.a', 'S01.a', 'S03.a', 'S04.a', 'S06.a', 'S06.d'];

/** Known findings. Each entry needs a reason; an unused entry is reported so the list stays current. */
const ALLOW = [
];

const states = all
  ? recipes.flatMap(r => [1024, 1280, 1600].flatMap(width => ['light', 'dark'].map(theme => ({ ...r, id: `${r.id}@${width}${theme === 'dark' ? 'd' : ''}`, width, theme }))))
  : [...FAST.map(id => ({ ...byId[id], width: 1280 })), ...seeds];
const selected = only ? states.filter(s => only.some(o => s.id === o || s.id.startsWith(o + '@'))) : states;
if (!selected.length) throw new Error('No matching state');

/**
 * Frame rewrites before the page reads them:
 * - seed data the demo lacks: Session titles in `threads` snapshots (`titles: 'team-lens'`);
 * - `--web` only: older builds read tool `args.command` unguarded, and this hub sends `args: null` for elided
 *   arguments. Rows a–f do not read tool arguments, so `null` becomes `{}`.
 */
function relabel(ws, s) {
  if (s.titles !== 'team-lens' && !web) return ws;
  const rewrite = raw => {
    const f = JSON.parse(String(raw), web ? (k, v) => k === 'args' && v === null ? {} : v : undefined);
    if (s.titles === 'team-lens' && f.t === 'snap' && f.value?.threads) for (const t of Object.values(f.value.threads)) if (t.team) t.title = t.team.role === 'worker' ? `team/lens ${t.team.worker ?? 'worker'}` : 'team/lens lead';
    return JSON.stringify(f);
  };
  return new Proxy(ws, { get: (target, key) => key === 'send' ? raw => target.send(rewrite(raw)) : typeof target[key] === 'function' ? target[key].bind(target) : target[key] });
}

/**
 * Seed f: `count` more Sessions spread over the last 24 h, each with four turns. Written only inside the disposable
 * demo dir; the hub picks them up while it runs. Returns the last Session's title.
 */
function addDaySessions(state, count) {
  const dir = join(state.demo, 'agent/sessions/--work-verify-day--');
  mkdirSync(dir, { recursive: true });
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } };
  let title;
  for (let i = 0; i < count; i++) {
    const id = `sess-verify-day-${i}`, start = Date.now() - (i * 2 + 1.5) * 3600_000, at = m => new Date(start + m * 60_000).toISOString();
    title = `Synthetic day Session ${i}`;
    const rows = [{ type: 'session', version: 3, id, timestamp: at(0), cwd: `/work/verify-day-${i % 4}` }];
    for (let k = 0; k < 4; k++) rows.push(
      { type: 'message', id: `${id}-u${k}`, parentId: k ? `${id}-a${k - 1}` : null, timestamp: at(k * 15), message: { role: 'user', content: [{ type: 'text', text: k ? `Turn ${k}` : title }], timestamp: start + k * 15 * 60_000 } },
      { type: 'message', id: `${id}-a${k}`, parentId: `${id}-u${k}`, timestamp: at(k * 15 + 2), message: { role: 'assistant', model: 'claude-sonnet-5-5', provider: 'anthropic', stopReason: 'stop', usage, timestamp: start + (k * 15 + 2) * 60_000, content: [{ type: 'text', text: `Reply ${k}` }] } });
    writeFileSync(join(dir, `verify-day-${i}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  }
  return title;
}

async function extra(p, s) {
  if (s.extra === 'expand-teams') {
    // Each click re-renders the list, so take the first collapsed toggle again each time.
    const collapsed = p.locator('[data-collapse-toggle][aria-expanded="false"]');
    for (let i = 0; i < 20 && await collapsed.count(); i++) await collapsed.first().click();
    await p.locator('.row.child, [data-row-level="2"]').first().waitFor();
  }
  if (s.extra === 'hover-model') {
    // Scroll every transcript scroller to its end; the sidebar keeps its place.
    await p.evaluate(() => { for (const e of document.querySelectorAll('.main *')) if (e.scrollHeight > e.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(e).overflowY)) e.scrollTop = e.scrollHeight; });
    await p.locator('.model-hud-trigger').first().hover();
    await p.locator('.session-metadata').waitFor();
  }
}

// Starts at process start, so the receipt time includes module loading.
const started = Date.now() - Math.round(process.uptime() * 1000);
const load = [loadavg()[0]];
const phases = {};
let webHits = 0;
const timed = (name, promise) => { const t = Date.now(); return promise.finally(() => { phases[name] = Date.now() - t; }); };
// Chrome starts while the hub waits for its demo Host; the two are independent.
const channel = process.env.UX_CHROME_CHANNEL;
// launchServer exposes Chrome's process, so cleanup can kill it when a graceful close stalls.
let server;
const browserReady = timed('browserMs', chromium.launchServer({ headless: true, timeout: 60_000, ...SCROLLBAR_LAUNCH, ...(channel ? { channel } : {}),
  // A route-fulfilled document has no local address, so Chrome's Local Network Access check blocks its loopback /ws.
  ...(web ? { args: ['--disable-features=LocalNetworkAccessChecks'] } : {}) })
  .then(s => { server = s; return chromium.connect(s.wsEndpoint(), { timeout: 60_000 }); }));
browserReady.catch(() => {});
const state = await timed('hubMs', launch());
tieToProcess(state);
const results = [], audit = { requests: [], forwardedMutations: 0, externalRequests: [], pageErrors: [] };
let browser;
try {
  mkdirSync(join(state.proof, 'invariants'), { recursive: true });
  const health = await timed('doctorMs', doctor(state));
  if (!health.ok) throw new Error('doctor: ' + JSON.stringify(health.checks.filter(c => !c.ok)));
  browser = await browserReady;
  const statesStarted = Date.now();
  for (const s of selected) {
    const t0 = Date.now();
    const context = await browser.newContext({ viewport: { width: s.width ?? 1280, height: s.height ?? 900 }, colorScheme: s.theme ?? 'light', locale: 'en-GB', timezoneId: 'UTC', reducedMotion: 'reduce' });
    // The hub's key cookie, set directly: the `/?k=` entry redirects, and Chromium does not route the redirected
    // request, so `--web` would lose the index swap.
    await context.addCookies([{ name: `ampi_k_${state.port}`, value: keyOf(state), url: state.origin, httpOnly: true, sameSite: 'Strict' }]);
    await context.addInitScript(observeLayoutShifts);
    await context.addInitScript(css => addEventListener('DOMContentLoaded', () => { const st = document.createElement('style'); st.textContent = css; document.head.append(st); }), CLASSIC_SCROLLBARS);
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== state.origin) { audit.externalRequests.push(url.origin); return route.abort(); }
      if (web && url.pathname === '/') { webHits++; return route.fulfill({ path: join(web, 'index.html') }); }
      if (web && existsSync(join(web, url.pathname)) && extname(url.pathname)) { webHits++; return route.fulfill({ path: join(web, url.pathname) }); }
      return route.continue();
    });
    const p = await context.newPage();
    p.setDefaultTimeout(8000);
    await p.routeWebSocket('**/ws', ws => fixtureSocket(relabel(ws, s), s, audit));
    p.on('pageerror', e => audit.pageErrors.push({ state: s.id, message: e.message }));
    let findings = [], error, stimulus;
    try {
      const daySession = s.sessions ? addDaySessions(state, s.sessions) : undefined;
      const hits = webHits;
      await p.goto(`${state.origin}/${s.route}`, { timeout: 30_000, waitUntil: 'commit' });
      await p.locator('.app').waitFor({ timeout: 30_000 });
      if (web && webHits - hits < 2) throw new Error(`--web build not served (${webHits - hits} files)`);
      if (!['loading', 'error'].includes(s.variant)) await p.waitForFunction(() => document.querySelectorAll('.side-scroll [data-thread]').length > 0 || /No Sessions yet\.|No timestamped/.test(document.body.textContent));
      if (s.route.includes('/t/') && !['loading', 'error'].includes(s.variant)) await p.locator('.composer').waitFor();
      if (s.family === 'Timeline' && !['loading', 'error', 'empty'].includes(s.variant)) await p.locator('.cos-band-label').first().waitFor();
      if (s.family === 'Arc' && !['loading-view', 'missing'].includes(s.variant)) await p.locator('.cos-toolbar button').waitFor();
      if (daySession) for (const until = Date.now() + 20_000; ;) {
        const day = (await threadsSnapshot({ port: state.port, host: 'devbox', auth: { bearer: keyOf(state) } })).filter(t => t.id.startsWith('pi:sess-verify-day-')).length;
        if (day === s.sessions) { await p.reload({ waitUntil: 'commit' }); await p.locator('.cos-band-label').first().waitFor({ timeout: 30_000 }); stimulus = { addedSessions: day, laneLabels: await p.locator('.cos-band-label').count() }; break; }
        if (Date.now() > until) throw new Error(`the hub lists ${day} of ${s.sessions} added Sessions`);
        await new Promise(r => setTimeout(r, 250));
      }
      await setup(p, s);
      const before = s.extra === 'expand-teams' ? await p.evaluate(rowBoxes, { rowSelector: AMPI.keyedRowSelector, key: AMPI.rowKey }) : undefined;
      await extra(p, s);
      if (s.extra === 'hover-model') stimulus = await p.locator('.session-metadata').first().evaluate(e => { const b = e.getBoundingClientRect(); return { card: [b.left, b.top, b.right, b.bottom].map(Math.round), viewport: [innerWidth, innerHeight] }; });
      await p.evaluate(() => document.fonts.ready);
      // Row a counts shifts from here on: the settled state should not move without input.
      const since = await p.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(performance.now())))));
      await p.waitForTimeout(300);
      findings = await checkPage(p, { since, rows });
      // Row a, part 3: expanding a Team must not move or resize the rows that stay.
      if (before && rows.includes('a')) {
        const after = await p.evaluate(rowBoxes, { rowSelector: AMPI.keyedRowSelector, key: AMPI.rowKey });
        for (const [k, b] of Object.entries(before)) if (after[k] && (after[k].left !== b.left || after[k].width !== b.width)) findings.push({ row: 'a', rule: 'expand-stable', at: `[data-thread=${JSON.stringify(k)}]`, detail: `expanding Teams moves the row: ${JSON.stringify(b)} → ${JSON.stringify(after[k])}` });
      }
    } catch (e) { error = redact(e.message.split('\n')[0]); }
    for (const f of findings) {
      const a = ALLOW.find(x => x.row === f.row && x.rule === f.rule && (!x.state || s.id.startsWith(x.state)) && (!x.at || x.at.test(f.at + ' ' + f.detail)));
      if (a) { f.allowed = a.reason; a.used = true; }
    }
    const open = findings.filter(f => !f.allowed);
    if (open.length || error) await p.screenshot({ path: join(state.proof, 'invariants', `${s.id}.png`.replace(/[^\w.@-]/g, '_')), animations: 'disabled' }).catch(() => {});
    results.push({ state: s.id, title: s.title, width: s.width ?? 1280, theme: s.theme ?? 'light', ms: Date.now() - t0, error, stimulus, findings });
    console.log(`${error ? 'ERROR' : open.length ? 'RED  ' : 'GREEN'} ${s.id} (${s.title}, ${s.width ?? 1280}${s.theme === 'dark' ? ' dark' : ''}) ${Date.now() - t0} ms${error ? ': ' + error : ''}`);
    for (const f of findings) console.log(`      ${f.allowed ? 'allowed ' : ''}${f.row}/${f.rule} ${f.at}: ${f.detail.slice(0, 220)}`);
    await context.close();
    load.push(loadavg()[0]);
  }
  phases.statesMs = Date.now() - statesStarted;
} finally {
  if (!browser) browser = await browserReady.catch(() => undefined);
  // A graceful Chrome close took its full 3 s timeout on every run; the contexts are closed, so kill Chrome at once.
  if (server) await timed('closeMs', Promise.resolve().then(() => {
    const chrome = server.process();
    if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill('SIGKILL');
  }));
  const receipt = {
    schema: 'ampi-ui-invariants/1', lane: all ? 'all' : 'fast', rows, web: web ?? 'checkout web/dist', webHits, webShim: web ? 'tool args null → {}' : undefined, revision: state.revision,
    seconds: Math.round((Date.now() - started) / 100) / 10, phases, load: { min: Math.min(...load), max: Math.max(...load) },
    states: results.length, red: results.filter(r => r.error || r.findings.some(f => !f.allowed)).map(r => r.state),
    unusedAllow: ALLOW.filter(a => !a.used).map(a => `${a.row}/${a.rule}${a.state ? ' ' + a.state : ''}`),
    pageErrors: audit.pageErrors.map(e => ({ ...e, message: redact(e.message) })), externalRequests: [...new Set(audit.externalRequests)], results,
  };
  writeFileSync(join(state.proof, 'invariants.json'), JSON.stringify(receipt, null, 2) + '\n');
  await timed('cleanupMs', cleanup(state));
  receipt.seconds = Math.round((Date.now() - started) / 100) / 10;
  writeFileSync(join(state.proof, 'invariants.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(`${receipt.red.length ? 'RED' : 'GREEN'}: ${receipt.states} states in ${receipt.seconds} s (${Object.entries(phases).map(([k, v]) => `${k.replace('Ms', '')} ${(v / 1000).toFixed(1)}`).join(', ')}) at load ${receipt.load.min.toFixed(0)}–${receipt.load.max.toFixed(0)}; red ${receipt.red.join(', ') || 'none'}${receipt.unusedAllow.length ? '; unused allowlist ' + receipt.unusedAllow.join(', ') : ''}`);
  console.log(`receipt: ${join(state.proof, 'invariants.json')}`);
  // The Playwright connection keeps the event loop alive for ~85 s after Chrome is gone; the run is complete here.
  process.exit(receipt.red.length ? 1 : 0);
}
