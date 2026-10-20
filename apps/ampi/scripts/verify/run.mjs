#!/usr/bin/env node
// Lane 1 of .pi/skills/verify-ampi: every deterministic journey against one disposable demo hub, in one browser.
//
//   node apps/ampi/scripts/verify/run.mjs                 # all journeys, 60 s budget, proof under output/verify-ampi/
//   node apps/ampi/scripts/verify/run.mjs --only T1,T3b   # a subset
//   node apps/ampi/scripts/verify/run.mjs --concurrency 6 # at most 6 journeys at once (default: all; also AMPI_VERIFY_CONCURRENCY)
//   node apps/ampi/scripts/verify/run.mjs --shots         # a screenshot after every step (slower)
//   node apps/ampi/scripts/verify/run.mjs --checkout <sha> # verify a commit in a disposable worktree; this checkout
//                                                          # stays untouched and supplies the harness and the proof
//
// Exit 0 only when every journey passes, every known gap still reproduces, the proof survives cleanup, and the
// whole run (launch to cleanup) took at most 60 s.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { launch, doctor, settled, buildsStarted, cleanup, keyOf, redact, checkout, app, tieToProcess } from './hub.mjs';
import { prepareCheckout } from './checkout.mjs';
import { journeys } from './journeys.mjs';
import { acquireRunLock, PERF_HOME } from '../perf/lock.mjs';
import { commitRecord } from './receipt.mjs';

// Above this 1-minute load average, an over-budget run is reported as "over budget under load". It still fails.
const LOAD_LIMIT = 20;
let started = Date.now();
const args = process.argv.slice(2);
if (args.includes('--checkout')) {
  // The parent owns the disposable worktree; a child run verifies it through AMPI_VERIFY_TARGET, then the parent removes it.
  const at = args.indexOf('--checkout');
  const sha = args[at + 1];
  if (!sha || sha.startsWith('--')) { console.error('Usage: run.mjs --checkout <sha> [--only ids] [--concurrency n] [--shots]'); process.exit(2); }
  const secs = () => `${((Date.now() - started) / 1000).toFixed(1)} s`;
  let tree, child, code = 1;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child?.kill(signal));
  try {
    tree = prepareCheckout(checkout, sha);
    console.log(`prepared ${secs()}`);
    // The child records this full hash as the requested commit and fails unless its hub doctor reads the same.
    const requested = execFileSync('git', ['rev-parse', `${sha}^{commit}`], { cwd: checkout, encoding: 'utf8' }).trim();
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args.filter((_, i) => i !== at && i !== at + 1)], { stdio: 'inherit', env: { ...process.env, AMPI_VERIFY_TARGET: tree.dir, AMPI_VERIFY_REQUESTED: requested } });
    code = await new Promise(done => child.on('exit', (c, signal) => done(c ?? (signal ? 1 : 0))));
  } catch (error) {
    console.error(`--checkout ${sha} failed: ${redact(String(error?.message ?? error).split('\n')[0])}`);
  } finally {
    tree?.remove();
  }
  const left = tree && execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: checkout, encoding: 'utf8' }).includes(tree.dir);
  console.log(`checkout ${sha} ${left ? 'worktree NOT removed' : 'worktree removed'} · total ${secs()}`);
  process.exit(left ? 1 : code);
}
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : undefined;
const shots = args.includes('--shots');
// An opt-in journey (`optIn`, for example one that spends real model calls) runs only when --only names it.
const selected = only ? journeys.filter(j => only.includes(j.id)) : journeys.filter(j => !j.optIn);
// 60 s, or the longest budget a selected journey declares.
const BUDGET_MS = Math.max(60_000, ...selected.map(j => j.budgetMs ?? 0));
const concurrencyArg = args.includes('--concurrency') ? args[args.indexOf('--concurrency') + 1] : process.env.AMPI_VERIFY_CONCURRENCY;
const concurrency = concurrencyArg === undefined ? selected.length : Number(concurrencyArg);
if (!Number.isInteger(concurrency) || concurrency < 1) { console.error(`--concurrency must be a positive integer, not ${concurrencyArg}`); process.exit(2); }
if (!selected.length) { console.error(`No journey matches ${only}`); process.exit(2); }

const lines = file => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)} s`;
const first = error => redact(String(error?.message ?? error).split('\n')[0]);
/** SIGKILL this process's direct children except the hub (cleanup owns it); returns how many were signalled. */
const killChildren = keep => {
  let pids = [];
  try { pids = execFileSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number).filter(pid => pid !== keep); } catch {}
  for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch {}
  return pids.length;
};
const safeName = s => s.replace(/[^a-z0-9.-]+/gi, '-');

// Same switch as scripts/ux: UX_CHROME_CHANNEL=chrome uses the installed Chrome when Playwright's build is absent.
const channel = process.env.UX_CHROME_CHANNEL;
if (!channel && !existsSync(chromium.executablePath())) {
  console.error(`Playwright Chromium is not installed (${chromium.executablePath()}). Run npx playwright install chromium, or set UX_CHROME_CHANNEL=chrome.`);
  process.exit(2);
}
// Lane 1 never takes the perf lock (lane 3): deploy checks and Worker verification must not wait behind benchmarks.
// It takes its own journey lock instead: one journey run at a time on this machine. Two runs at once starved each
// other's browser into false click timeouts. The queue wait is reported apart and is not part of the budget.
// The receipt records the load average, so an over-budget run under load is visible as such.
const JOURNEY_LOCK = join(PERF_HOME, 'journey.lock');
const queued = Date.now();
await acquireRunLock(`journeys ${process.env.AMPI_VERIFY_TARGET ?? checkout}`, {
  lock: JOURNEY_LOCK, wait: true, timeoutMs: 15 * 60_000,
  onWait: owner => console.log(`journey lock held by ${owner.label} (pid ${owner.pid}); queued`),
});
const queueMs = Date.now() - queued;
console.log(`journey lock: waited ${(queueMs / 1000).toFixed(1)} s`);
const loadStart = loadavg();
started = Date.now();
// Chrome starts while the hub waits for its demo Host; the two are independent.
const browserReady = chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
browserReady.catch(() => {});
const state = await launch();
const phases = { launched: Date.now() - started };
const mark = name => { phases[name] = Date.now() - started; };
// A hang must not strand the hub: the watchdog cleans up and fails the run.
const watchdog = setTimeout(async () => { console.error(`Watchdog: run exceeded ${2 * BUDGET_MS / 1000} s`); await cleanup(state).catch(() => {}); process.exit(1); }, 2 * BUDGET_MS);
const audit = { externalRequests: [], pageErrors: [] };
const results = [];
let browser, health;
// No await since launch(): a signal before this line cannot arrive. A signalled run still leaves a failing receipt.
tieToProcess(state, signal => {
  mkdirSync(state.proof, { recursive: true });
  writeFileSync(join(state.proof, 'receipt.json'), JSON.stringify({ schema: 'ampi-verify-run/1', runId: state.runId, revision: state.revision, port: state.port, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, phases, doctor: health, journeys: results, ok: false, failures: [`interrupted by ${signal}`] }, null, 2) + '\n');
  console.error(`interrupted by ${signal}; receipt: ${join(state.proof, 'receipt.json')}`);
});
try {
  health = await doctor(state);
  if (!health.ok) throw new Error('Doctor failed: ' + JSON.stringify(health.checks.filter(c => !c.ok)));
  console.log(`doctor ok · port ${state.port} · ${state.revision.slice(0, 12)} · ${elapsed()}`);
  mark('doctor');
  // Hub-start derives and automatic Builds (D16) call the model; side-effect deltas count only after they finish.
  console.log(`hub settled · ${await settled(state)} · ${elapsed()}`);
  mark('settled');
  browser = await browserReady;
  mark('browser');
  let gate = Promise.resolve();
  const exclusive = fn => { const run = gate.then(fn); gate = run.catch(() => {}); return run; };
  const sides = () => ({ herdr: lines(join(state.demo, 'calls.jsonl')), ask: lines(join(state.demo, 'ask-calls.jsonl')) });
  // At most `concurrency` journeys run at once, in their listed order; each takes the next when it ends.
  const queue = [...selected];
  const runJourney = async journey => {
    const dir = join(state.proof, journey.id);
    mkdirSync(dir, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'en-GB', timezoneId: 'UTC', reducedMotion: 'reduce' });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== state.origin && url.protocol !== 'data:') { audit.externalRequests.push(url.origin); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', e => audit.pageErrors.push({ journey: journey.id, message: e.message }));
    const record = { id: journey.id, feature: journey.feature, title: journey.title, status: 'passed', steps: [] }, journeyStarted = Date.now();
    results.push(record);
    // True while this journey's alone step holds the side-effect gate; a fixture inside it must not queue behind itself.
    let entered = false, n = 0, holding = false;
    const capture = async (name, always) => {
      const base = join(dir, `${String(++n).padStart(2, '0')}-${safeName(name)}`);
      writeFileSync(base + '.aria.yml', await page.locator('body').ariaSnapshot().catch(e => `# snapshot failed: ${e.message}\n`));
      if (always || shots) await page.screenshot({ path: base + '.png' }).catch(() => {});
      return base.slice(state.proof.length + 1);
    };
    const j = {
      page, state,
      async goto(route) {
        // The key only enters the browser once; the hub swaps it for a cookie and redirects to a key-free URL.
        // The first entry is a cold bundle load; under host load it gets its own budget, and `.app` proves readiness.
        const cold = !entered;
        if (cold) { await page.goto(`${state.origin}/?k=${keyOf(state)}`, { waitUntil: 'commit', timeout: 30_000 }); entered = true; }
        await page.evaluate(r => { location.hash = r; }, route);
        await page.locator('.app').waitFor({ timeout: cold ? 30_000 : undefined });
      },
      settle: () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))),
      /**
       * Runs a fixture mutation that can start background model work (derives, automatic Builds D16) under the
       * side-effect gate. `add` returns once the hub has picked the change up; the gate opens when the jobs settle,
       * so no alone step counts their model calls.
       */
      async fixture(add) {
        const run = async () => { const r = await add(); await settled(state); return r; };
        return holding ? run() : exclusive(run);
      },
      // `startsBuild`: the step's own action starts a Build, so a Build during it is attributable.
      async step(name, action, fn, { expectSide, alone = Boolean(expectSide), startsBuild = false } = {}) {
        const t = Date.now();
        // `at` is the step start in ms since run start, so the receipt shows which steps of other journeys overlapped.
        const entry = { name, action, status: 'passed', at: t - started };
        record.steps.push(entry);
        try {
          // Hub call logs are global; a step that asserts a side-effect delta runs alone so the delta is its own.
          // A step that asserts only a total passes alone: false.
          await (alone ? exclusive : (f => f()))(async () => {
            // A Build another journey started would add its model calls to this step's delta.
            if (alone) await settled(state, { builds: true });
            const before = sides(), built = alone && !startsBuild ? await buildsStarted(state) : 0;
            holding = alone;
            try { entry.state = await fn(); } finally { holding = false; }
            const after = sides();
            entry.sideEffects = { herdrCalls: after.herdr - before.herdr, herdrTotal: after.herdr, askCalls: after.ask - before.ask, askTotal: after.ask };
            // Its model calls would land in this step's delta, and no assertion could say whose they are.
            if (alone && !startsBuild && await buildsStarted(state) > built) throw new Error('a Build started during this step (unattributable)');
            expectSide?.(entry.sideEffects);
          });
        } catch (error) {
          entry.status = 'failed'; entry.error = first(error);
          // A step may attach the page state it measured, so a red run shows why it failed.
          if (error?.detail) entry.detail = error.detail;
          entry.evidence = await capture(name, true);
          throw error;
        } finally { entry.ms = Date.now() - t; }
        entry.evidence = await capture(name, false);
      },
      async gap(incident, name, action, fn) {
        const entry = { name, action, incident, status: 'gap-reproduced' };
        record.steps.push(entry);
        try { entry.state = await fn(); entry.status = 'gap-closed'; }
        catch (error) { entry.observed = first(error); }
        entry.evidence = await capture(name, false);
        if (entry.status === 'gap-closed') throw new Error(`Known gap ${incident} (${name}) now passes. Update the feature map and incident table.`);
      },
    };
    try { await journey.run(j); await capture('final', true); }
    catch (error) { record.status = 'failed'; record.error = first(error); }
    finally { record.ms = Date.now() - journeyStarted; await context.close().catch(() => {}); }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) await runJourney(queue.shift());
  }));
} catch (error) {
  results.push({ id: 'run', status: 'failed', error: first(error) });
} finally {
  mark('journeys');
  // Proof is on disk by now. A graceful Chrome close took its full 3 s timeout on every run; kill our own children only.
  if (!browser) browser = await browserReady.catch(() => undefined);
  phases.browserKilled = killChildren(state.pid);
  mark('browserClosed');
}
const stopped = await cleanup(state);
mark('cleaned');
clearTimeout(watchdog);
const durationMs = Date.now() - started;
const load = { start: loadStart.map(n => +n.toFixed(1)), end: loadavg().map(n => +n.toFixed(1)), cores: cpus().length };
const underLoad = Math.max(load.start[0], load.end[0]) > LOAD_LIMIT;
// Without --checkout the tree under test is the requested commit.
const commit = commitRecord({ requested: process.env.AMPI_VERIFY_REQUESTED ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: app, encoding: 'utf8' }).trim(), actual: state.revision });
const failures = [
  ...(commit.failure ? [`commit: ${commit.failure}`] : []),
  ...results.filter(r => r.status !== 'passed').map(r => `${r.id}: ${r.error}`),
  ...(audit.externalRequests.length ? [`external requests: ${[...new Set(audit.externalRequests)].join(', ')}`] : []),
  ...(audit.pageErrors.length ? [`page errors: ${audit.pageErrors.length}`] : []),
  ...(durationMs > BUDGET_MS ? [`${underLoad ? 'over budget under load' : 'over budget'}: ${(durationMs / 1000).toFixed(1)} s; budget ${BUDGET_MS / 1000} s; load ${load.start[0]} → ${load.end[0]} on ${load.cores} cores`] : []),
];
const receipt = { schema: 'ampi-verify-run/1', runId: state.runId, requested: commit.requested, actual: commit.actual, revision: state.revision, port: state.port, startedAt: new Date(started).toISOString(), queueMs, concurrency, durationMs, budgetMs: BUDGET_MS, load, phases, overBudgetUnderLoad: durationMs > BUDGET_MS && underLoad, doctor: health, journeys: results, audit, cleanup: stopped, ok: failures.length === 0, failures };
mkdirSync(state.proof, { recursive: true });
writeFileSync(join(state.proof, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
if (!existsSync(join(state.proof, 'receipt.json'))) failures.push('proof did not survive cleanup');
for (const r of results) {
  console.log(`${r.status === 'passed' ? 'PASS' : 'FAIL'} ${r.id.padEnd(4)} ${r.title ?? ''}${r.error ? ` — ${r.error}` : ''}`);
  for (const s of r.steps ?? []) console.log(`     ${s.status.padEnd(14)} ${s.name}${s.incident ? ` (${s.incident})` : ''}${s.ms !== undefined ? ` ${s.ms} ms` : ''}${s.error ? ` — ${s.error}` : ''}`);
}
console.log(`proof: ${state.proof}`);
console.log(`phases (ms from start): ${Object.entries(phases).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
console.log(`total ${(durationMs / 1000).toFixed(1)} s (queued ${(queueMs / 1000).toFixed(1)} s first; concurrency ${concurrency}; budget ${BUDGET_MS / 1000} s, load ${load.start[0]} → ${load.end[0]}) · ${failures.length ? `FAILED: ${failures.join('; ')}` : 'ok'}`);
process.exit(failures.length ? 1 : 0);
