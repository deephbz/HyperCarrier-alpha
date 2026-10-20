#!/usr/bin/env node
// Launch, doctor, and stop one disposable synthetic AmPi hub (.pi/skills/verify-ampi/SKILL.md).
//
//   node apps/ampi/scripts/verify/hub.mjs start            # prints the run directory; hub keeps running
//   node apps/ampi/scripts/verify/hub.mjs doctor <run-dir> # read-only health check; exit 0 = worth driving
//   node apps/ampi/scripts/verify/hub.mjs stop <run-dir>   # kills only this run's process group, keeps proof
//
// A run directory holds the disposable HOME, AMPI_HOME, demo data, and hub log. Proof lives elsewhere
// (proofDir) and survives stop. The access key stays in <run>/hub.key (mode 600); logs carry no key.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { constants, homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webDistCurrent } from '../web-inputs.mjs';
import { ampiSubmodules, ownRepo, submoduleGit } from '../submodules.mjs';
import { threadsSnapshot } from './live-rows.mjs';

// `checkout` holds this harness and the proof. `target` is the checkout under test: the same one, or the disposable
// worktree that `run.mjs --checkout <sha>` creates and names in AMPI_VERIFY_TARGET.
export const checkout = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8' }).trim();
export const target = resolve(process.env.AMPI_VERIFY_TARGET ?? checkout);
export const app = join(target, 'apps/ampi');
// Owner and team hubs use 7879 and the ports just above it. A verification run never binds or drives them.
export const FORBIDDEN_PORTS = [7879, 7895];
const forbidden = port => port >= FORBIDDEN_PORTS[0] && port <= FORBIDDEN_PORTS[1];
const inside = (child, parent) => { const r = relative(parent, child); return r && !r.startsWith('..') && !r.startsWith(sep); };
export const redact = text => text.replace(/\?k=[^\s"')]+/g, '?k=<redacted>');
const sleep = ms => new Promise(done => setTimeout(done, ms));

function guardRunDir(run) {
  const real = resolve(run);
  const home = homedir();
  for (const name of existsSync(home) ? readdirSync(home) : []) {
    if (name.startsWith('.ampi') && (real === join(home, name) || inside(real, join(home, name)))) throw new Error(`Refusing run directory inside ~/${name}`);
  }
  if (real === home || inside(home, real)) throw new Error('Refusing a run directory that contains the real HOME');
  return real;
}

export function proofDirFor(runId) {
  return resolve(process.env.AMPI_VERIFY_PROOF ?? join(checkout, 'output/verify-ampi', runId));
}

/**
 * Every submodule AmPi loads (scripts/submodules.mjs) sits at HEAD's gitlink SHA with clean tracked files. A fresh
 * worktree often lacks one; the hub then misses its node-start deadline. Drift in other submodules is a warning only.
 */
export function submodulesPinned(root = target) {
  const { scope, other } = ampiSubmodules(root);
  // The guarded pin command from this harness: it also serves a --checkout target that predates submodules.mjs.
  const pinFix = path => `node ${join(checkout, 'apps/ampi/scripts/submodules.mjs')} pin --root ${root} ${path}`;
  const drift = path => {
    const pin = execFileSync('git', ['ls-tree', 'HEAD', path], { cwd: root, encoding: 'utf8' }).split(/\s+/)[2];
    let head = '';
    if (ownRepo(root, path)) try { head = submoduleGit(root, path, ['rev-parse', 'HEAD']); } catch {}
    if (head !== pin) return { path, pin, head: head || 'not checked out', fix: pinFix(path) };
    // A worktree submodule can sit at the pin with its tracked files deleted; imports then fail inside the Host.
    const changed = submoduleGit(root, path, ['status', '--porcelain', '--untracked-files=no']).split('\n').filter(Boolean).length;
    if (changed) return { path, pin, head: `${changed} tracked files changed`, fix: `inspect git -C ${join(root, path)} status; if only deletions, git -C ${join(root, path)} restore --staged --worktree .` };
  };
  const describe = w => `${w.path} at ${w.head.length === 40 ? w.head.slice(0, 12) : w.head}, pinned ${w.pin.slice(0, 12)}`;
  const wrong = scope.map(drift).filter(Boolean);
  const warnings = other.map(drift).filter(Boolean).map(w => `${describe(w)} (AmPi does not load it; ignored)`);
  // The fix mutates the checkout. When another owner holds it, verify a disposable copy instead: run.mjs --checkout HEAD.
  const detail = wrong.length
    ? wrong.map(w => `${describe(w)}. Fix: ${w.fix}`).join('\n') + `\nOr leave this checkout untouched: node apps/ampi/scripts/verify/run.mjs --checkout ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()}`
    : `${scope.length} AmPi submodules (${scope.join(', ')}) at their gitlink SHAs with clean tracked files`;
  return { ok: !wrong.length, detail, warnings };
}

/** Start pi-demo.ts in its own process group with disposable HOME and AMPI_HOME on an OS-assigned port. */
export async function launch({ runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`, attempts = 3 } = {}) {
  for (const ready of [submodulesPinned(), webDistCurrent(target)]) {
    if (!ready.ok) throw new Error(ready.detail);
    for (const warning of ready.warnings ?? []) console.warn(`warning: ${warning}`);
  }
  const run = guardRunDir(mkdtempSync(join(tmpdir(), 'ampi-verify-')));
  const proof = proofDirFor(runId);
  mkdirSync(proof, { recursive: true });
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const home = join(run, 'home'), demo = join(run, 'demo'), log = join(run, `hub-${attempt}.log`);
    mkdirSync(join(home, '.ampi'), { recursive: true });
    const env = { ...process.env, PATH: refusingPath(join(run, 'bin'), process.env.PATH), HOME: home, AMPI_HOME: join(home, '.ampi'), AMPI_HUB_CONFIG: join(home, '.ampi/hub.json'), PI_CODING_AGENT_DIR: join(demo, 'agent'), DEMO_DIR: demo, PORT: '0' };
    const out = openSync(log, 'a');
    const child = spawn(process.execPath, ['scripts/pi-demo.ts'], { cwd: app, detached: true, env, stdio: ['ignore', out, out] });
    child.unref();
    const started = Date.now();
    let match;
    while (!match && Date.now() - started < 60_000) {
      await sleep(250);
      match = readFileSync(log, 'utf8').match(/demo hub: http:\/\/127\.0\.0\.1:(\d+)\/\?k=([0-9a-f]+)/);
      if (!match && child.exitCode !== null) break;
    }
    if (!match) { killGroup(child.pid); throw new Error(`Demo hub not ready in 60 s; see ${log}`); }
    const port = Number(match[1]);
    if (forbidden(port)) { killGroup(child.pid); continue; }
    writeFileSync(join(run, 'hub.key'), match[2], { mode: 0o600 });
    const state = { schema: 'ampi-verify-hub/1', runId, run, proof, pid: child.pid, port, origin: `http://127.0.0.1:${port}`, home, demo, log, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: app, encoding: 'utf8' }).trim(), startedAt: new Date().toISOString() };
    writeFileSync(join(run, 'hub.json'), JSON.stringify(state, null, 2) + '\n');
    // The hub prints its URL before the demo Host connects and lists the fixture Herdr; launch owns that wait, the
    // doctor stays one-shot.
    const hostWait = Date.now();
    while (Date.now() - hostWait < 20_000 && !(await hostConnected(state))) await sleep(100);
    while (Date.now() - hostWait < 30_000 && !(await fixtureLeadLive(state))) await sleep(250);
    return state;
  }
  throw new Error(`OS assigned a forbidden port ${attempts} times`);
}

async function hostConnected(state) {
  try {
    const health = await (await fetch(`${state.origin}/api/health`, { headers: { authorization: `Bearer ${keyOf(state)}` }, signal: AbortSignal.timeout(2000) })).json();
    return (health.hosts ?? []).some(h => h.id === 'devbox' && h.status === 'connected');
  } catch { return false; }
}

// The fixture lead is live in its fake Herdr pane (w1:p1, scripts/pi-demo.ts) only when the Host agent reads the
// fake Herdr. Any other Herdr leaves it without that pane, so a wrong Herdr fails the doctor once instead of
// failing every journey.
async function fixtureLeadLive(state) {
  try {
    const lead = (await threadsSnapshot({ port: state.port, host: 'devbox', auth: { bearer: keyOf(state) }, timeoutMs: 3000 })).find(t => t.id === 'pi:sess-lead');
    return Boolean(lead?.live && lead.location?.pane === 'w1:p1');
  } catch { return false; }
}

export function readState(run) {
  return JSON.parse(readFileSync(join(guardRunDir(run), 'hub.json'), 'utf8'));
}
export const keyOf = state => readFileSync(join(state.run, 'hub.key'), 'utf8').trim();
/** The browser entry URL. Pass it to page.goto only; never print or log it. */
export const entryURL = (state, route = '') => `${state.origin}/?k=${keyOf(state)}${route}`;

/** One read-only check: our process group, our port, our key, our disposable paths, a current web build. */
export async function doctor(state) {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  let alive = false;
  try { process.kill(state.pid, 0); alive = true; } catch {}
  check('process alive', alive, `pid ${state.pid}`);
  let pgid = '';
  try { pgid = execFileSync('ps', ['-o', 'pgid=', '-p', String(state.pid)], { encoding: 'utf8' }).trim(); } catch {}
  check('own process group', pgid === String(state.pid), `pgid ${pgid || 'none'}`);
  check('port allowed', !forbidden(state.port), `port ${state.port}; forbidden ${FORBIDDEN_PORTS.join('–')}`);
  let listener = '';
  try { listener = execFileSync('lsof', ['-nP', '-a', '-p', String(state.pid), `-iTCP:${state.port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim(); } catch {}
  check('port owned by hub', listener === String(state.pid), `listener ${listener || 'none'}`);
  check('disposable paths', inside(state.home, state.run) && inside(state.demo, state.run) && !state.home.startsWith(join(homedir(), '.ampi')), `${state.run}`);
  const pinned = submodulesPinned();
  check('submodules pinned', pinned.ok, [pinned.detail, ...pinned.warnings.map(w => `warning: ${w}`)].join('\n'));
  const build = webDistCurrent(target);
  check('web build current', build.ok, build.detail);
  check('revision', true, state.revision);
  try {
    const key = keyOf(state);
    const health = await (await fetch(`${state.origin}/api/health`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) })).json();
    const proof = createHash('sha256').update(`ampi-hub:${key}`).digest('hex').slice(0, 32);
    check('hub holds our key', health.proof === proof, 'health proof matches hub.key');
    const hosts = (health.hosts ?? []).map(h => `${h.id}:${h.status}`);
    check('demo Host connected', hosts.includes('devbox:connected'), hosts.join(', ') || 'no hosts');
    check('fixture Herdr read', await fixtureLeadLive(state), 'pi:sess-lead live in fake Herdr pane w1:p1; otherwise the Host agent may read another Herdr');
    const index = await fetch(`${state.origin}/`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) });
    check('web app served', index.ok && (await index.text()).includes('<div id="root"'), `GET / ${index.status}`);
  } catch (error) { check('hub answers', false, error.message); }
  return { ok: checks.every(c => c.ok), checks };
}

/** The keyed /api/health body: Host states and the `derive` and `builds` job counters. */
export async function health(state) {
  return (await fetch(`${state.origin}/api/health`, { headers: { authorization: `Bearer ${keyOf(state)}` }, signal: AbortSignal.timeout(2000) })).json();
}

/** Builds the hub has started (running plus finished). A hub from before the Build counter reports none. */
export const buildsStarted = async state => { const b = (await health(state)).builds ?? { pending: 0, done: 0 }; return b.pending + b.done; };

/**
 * Waits until the hub's background jobs (/api/health `derive` and `builds`) are drained and their counts hold for
 * `stableMs`. Hub-start Builds call the model, so a step that counts model calls must start after them.
 * `builds` = true waits for running Builds only. A hub from before the Build counter reports no `builds` and
 * waits on derive alone.
 */
export async function settled(state, { stableMs = 1500, timeout = 60_000, builds = false } = {}) {
  const until = Date.now() + timeout;
  let last = '', since = Date.now(), seen = 'no answer';
  for (;;) {
    try {
      const h = await health(state);
      const b = h.builds ?? { pending: 0, done: 0 }, d = h.derive ?? { pending: 0, done: 0 };
      seen = `derive pending ${d.pending} done ${d.done}; builds pending ${b.pending} done ${b.done}`;
      if (builds) { if (!b.pending) return seen; }
      else {
        const now = `${d.pending}/${d.done}/${b.pending}/${b.done}`;
        if (now !== last) { last = now; since = Date.now(); }
        if (!d.pending && !b.pending && Date.now() - since >= stableMs) return seen;
      }
    } catch (error) { seen = `health failed: ${error.message}`; }
    if (Date.now() > until) throw new Error(`Hub background jobs did not settle within ${timeout / 1000} s (${seen}).`);
    await new Promise(r => setTimeout(r, 100));
  }
}

/**
 * Ties the hub to this process: a signal or an exit before cleanup() kills its group, so it never outlives the run
 * (ppid 1). `hub.mjs start` does not call this; its hub keeps running by design. SIGKILL still orphans the hub.
 */
export function tieToProcess(state, onSignal = () => {}) {
  process.once('exit', () => killGroup(state.pid));
  // A closed terminal pane sends SIGHUP. onSignal runs first, synchronously, so the run can record its failure.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => {
    try { onSignal(signal); } catch (error) { console.error(`on ${signal}: ${error.message}`); }
    process.exit(128 + constants.signals[signal]);
  });
}

/**
 * The hub must never reach the owner's Herdr: a `herdr` in `dir` that refuses every call comes first on `path`.
 * Every other tool on `path` stays reachable.
 */
export function refusingPath(dir, path = '') {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'herdr'), '#!/bin/sh\necho "verify hub: herdr on PATH is refused; the demo sets HERDR_BIN" >&2\nexit 1\n', { mode: 0o755 });
  return path ? `${dir}${delimiter}${path}` : dir;
}

function killGroup(pid) {
  try { process.kill(-pid, 'SIGTERM'); } catch { return false; }
  return true;
}

/** Copy side-effect logs into proof (key redacted), kill our group, then delete the run directory. */
export async function cleanup(state) {
  const sides = join(state.proof, 'hub');
  mkdirSync(sides, { recursive: true });
  for (const name of readdirSync(state.run).filter(n => n.startsWith('hub-') && n.endsWith('.log'))) writeFileSync(join(sides, name), redact(readFileSync(join(state.run, name), 'utf8')));
  for (const name of ['calls.jsonl', 'ask-calls.jsonl']) if (existsSync(join(state.demo, name))) copyFileSync(join(state.demo, name), join(sides, name));
  const killed = killGroup(state.pid);
  for (let i = 0; i < 40; i++) { try { process.kill(state.pid, 0); await sleep(100); } catch { break; } }
  try { process.kill(-state.pid, 'SIGKILL'); } catch {}
  rmSync(guardRunDir(state.run), { recursive: true, force: true });
  return { killed, proofKept: existsSync(state.proof), proof: state.proof };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, run] = process.argv.slice(2);
  if (command === 'start') {
    const state = await launch();
    const health = await doctor(state);
    console.log(JSON.stringify({ run: state.run, proof: state.proof, port: state.port, doctor: health.ok }, null, 2));
    if (!health.ok) { console.error(JSON.stringify(health.checks.filter(c => !c.ok))); await cleanup(state); process.exit(1); }
  } else if (command === 'doctor' && run) {
    const health = await doctor(readState(run));
    console.log(JSON.stringify(health, null, 2));
    process.exit(health.ok ? 0 : 1);
  } else if (command === 'stop' && run) {
    console.log(JSON.stringify(await cleanup(readState(run))));
  } else if (command === 'url' && run) {
    // For a human or a browser tool that cannot import this module. Prints to stdout only; never redirect it to a log.
    process.stdout.write(entryURL(readState(run), process.argv[4] ?? '') + '\n');
  } else {
    console.error('Usage: hub.mjs start | doctor <run-dir> | stop <run-dir> | url <run-dir> [#/route]');
    process.exit(2);
  }
}
