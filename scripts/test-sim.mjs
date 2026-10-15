#!/usr/bin/env node
// Run each installed simulator lane. Child suites own their oracles; this runner never
// guesses missing oracle counts from a green test exit. Detailed logs remain inspectable.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultPiRoot } from '../packages/hc-pi-sim/src/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const piRoot = resolve(process.env.HC_PI_SIM_PI_ROOT ?? defaultPiRoot());
const pi = JSON.parse(readFileSync(join(piRoot, 'pi-coding-agent/package.json'))).version;
const output = resolve(root, process.env.HC_PI_SIM_REPORT_DIR ?? '.scratch/test-sim');
mkdirSync(output, { recursive: true });
// Rarebit uses seed-named roots. A per-run parent prevents collision with other suites.
const temp = mkdtempSync(join(tmpdir(), 'hc-sim-lanes-'));
const env = { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp, HC_PI_SIM_PI_ROOT: piRoot, PI_SIM_ROOT: dirname(piRoot), FORCE_COLOR: '0' };
const catalog = {
  'hc-pi-sim': ['6+magpie', 'mixed'], 'hc-auto-compact': ['6+magpie', 'mixed'],
  'hc-rarebit': ['anthropic', 'prefix'], 'pi-openai-blackmagic-compact': ['responses', 'advisory'],
  'pi-cache-goblin': ['multiple', 'mixed'], 'hc-hud': ['host', 'none'], 'systemp-prompt-audit': ['multiple', 'mixed'],
};
const lanes = [];
for (const name of readdirSync(join(root, 'packages')).sort()) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(root, 'packages', name, 'package.json'))); } catch { continue; }
  if (name === 'hc-pi-sim' || manifest.scripts?.['test:sim']) lanes.push({ name, args: ['--prefix', `packages/${name}`, 'run', 'test:sim'] });
}
lanes.push({ name: 'composition', args: ['--prefix', 'packages/hc-pi-sim', 'run', 'test:sim:composition'] });
const rows = [], receipts = [];
for (const lane of lanes) {
  const started = Date.now();
  const run = spawnSync('npm', lane.args, { cwd: root, env, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
  const log = `${run.stdout ?? ''}${run.stderr ?? ''}${run.error ? `\n${run.error.message}` : ''}`;
  writeFileSync(join(output, `${lane.name}.log`), log);
  const reports = [...log.matchAll(/SIM_REPORT (\{[^\n]+\})/g)].map(match => JSON.parse(match[1]));
  const measurements = [...log.matchAll(/\{[^\n]*"speedRatio":[^\n]*\}/g)].flatMap(match => { try { return [JSON.parse(match[0])]; } catch { return []; } });
  const speed = measurements.length ? Math.max(...measurements.map(m => m.speedRatio)).toFixed(1) + 'x' : 'n/r';
  if (reports.length) for (const report of reports) rows.push({ lane: lane.name, pi: report.pi, family: report.family,
    authority: report.authority, doc: report.documentedFailures, adv: report.advisoryFailures,
    notes: report.advisoryNotes, speed: report.speedRatio.toFixed(1) + 'x', status: run.status === 0 ? (report.authority === 'advisory' || report.advisoryNotes ? 'advisory' : 'pass') : 'FAIL' });
  else rows.push({ lane: lane.name.replace('pi-openai-blackmagic-compact', 'blackmagic'), pi,
    family: catalog[lane.name]?.[0] ?? 'unreported', authority: catalog[lane.name]?.[1] ?? 'unreported',
    doc: 'n/r', adv: 'n/r', notes: 'n/r', speed, status: run.status === 0 ? 'suite-ok' : 'FAIL' });
  receipts.push({ lane: lane.name, exitCode: run.status, signal: run.signal, wallMs: Date.now() - started, reports });
}
const columns = ['lane', 'pi', 'family', 'authority', 'doc', 'adv', 'notes', 'speed', 'status'];
const widths = columns.map(key => Math.max(key.length, ...rows.map(row => String(row[key]).length)));
console.log(columns.map((key, i) => key.padEnd(widths[i])).join(' | '));
for (const row of rows) console.log(columns.map((key, i) => String(row[key]).padEnd(widths[i])).join(' | '));
console.log('doc/adv = raw oracle failures within tested epochs; notes = advisory limits. n/r = lane emits no aggregate.');
console.log('suite-ok includes expected mutant failures; it is not a cache verdict. Speed is a measured scenario maximum.');
console.log(`Logs and machine report: ${output}`);
writeFileSync(join(output, 'report.json'), JSON.stringify({ pi, rows, receipts }, null, 2) + '\n');
rmSync(temp, { recursive: true, force: true });
if (receipts.some(receipt => receipt.exitCode !== 0)) process.exitCode = 1;
