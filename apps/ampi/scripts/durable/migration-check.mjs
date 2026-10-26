// Compare public thread bindings and each Team's /ptb status across the rc.7 -> perf authority migration.
// A host may carry any number of Teams; Team ids on public thread rows key both the counts and the comparison.
// Use the existing owner socket; never open SQLite, start a node, or submit a model input.
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [directory, mode, countsFile] = process.argv.slice(2);
assert(directory && ['before', 'after'].includes(mode) && (mode !== 'before' || countsFile),
 'usage: migration-check.mjs BACKUP_DIRECTORY before APPROVED_COUNTS_JSON | BACKUP_DIRECTORY after');
const approved = mode === 'before' ? JSON.parse(readFileSync(countsFile, 'utf8')) : null;
if (approved) for (const key of ['threadCount', 'teamCount', 'workerCount']) {
 assert(Number.isSafeInteger(approved[key]) && approved[key] >= 0, `invalid approved ${key}`);
}
mkdirSync(directory, { recursive: true, mode: 0o700 });
assert(process.env.AMPI_HOME, 'AMPI_HOME must name the reviewed home explicitly');
if (mode === 'before') assert(!existsSync(join(directory, 'expected-status')), 'baseline already exists; do not overwrite it');
const home = process.env.AMPI_HOME;
const socket = createConnection(join(home, 'node.sock'));
const pending = new Map();
let serial = 1, buffer = '';
const timeout = setTimeout(() => { console.error('STOP: node read timed out'); socket.destroy(); process.exit(1); }, 15000);
socket.on('error', error => { console.error(`STOP: socket ${error.code}`); clearTimeout(timeout); socket.destroy(); process.exit(1); });
socket.on('data', data => {
 buffer += data;
 for (;;) {
  const at = buffer.indexOf('\n'); if (at < 0) break;
  const frame = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
  if (frame.t === 'snap' || frame.t === 'res' || frame.t === 'end') {
   const id = frame.sid ?? frame.id; pending.get(id)?.(frame); pending.delete(id);
  }
 }
});
const send = frame => new Promise(resolve => {
 const id = serial++; pending.set(id, resolve);
 socket.write(JSON.stringify({ ...frame, ...(frame.t === 'sub' ? { sid: id } : { id }) }) + '\n');
});
const save = (name, value) => writeFileSync(join(directory, name), value, { mode: 0o600 });
try {
 const frame = await send({ t: 'sub', topic: { kind: 'threads' } });
 assert(frame.t === 'snap', 'threads subscription failed');
 const rows = Object.values(frame.value.threads);
 assert(rows.length > 0, 'node has no threads');
 // One key set for counting and comparing: the Team ids on public thread rows, sorted.
 const teamIds = [...new Set(rows.filter(row => row.team).map(row => row.team.teamId))].sort();
 const teams = teamIds.map((teamId, index) => {
  const label = `Team ${index + 1} of ${teamIds.length}`;
  assert(/^[A-Za-z0-9_.-]+$/.test(teamId), `${label} has an id that cannot name a file`);
  const leads = rows.filter(row => row.team?.teamId === teamId && row.team.role === 'lead');
  assert(leads.length === 1, `${label} has ${leads.length} lead threads; it needs a separately reviewed comparison plan`);
  const workers = rows.filter(row => row.team?.teamId === teamId && row.team.role === 'worker').sort((a, b) => b.createdAt - a.createdAt);
  return { teamId, label, lead: leads[0].id, workers };
 });
 // Without a Team, /ptb status runs on one open unbound thread to prove the command answers.
 const unbound = rows.find(row => !row.closed && !row.team);
 assert(teams.length > 0 || unbound, 'no open thread for the unbound /ptb check');
 const selection = mode === 'before' ? { teams: teamIds, unbound: teams.length ? undefined : unbound.id } : JSON.parse(readFileSync(join(directory, 'selection.json'), 'utf8'));
 assert.deepEqual(teamIds, selection.teams, 'the set of Teams changed');
 const checks = teams.length ? teams.map(team => ({ key: team.teamId, label: team.label, threadId: team.lead })) : [{ key: 'unbound', label: 'the unbound thread', threadId: selection.unbound }];
 const statuses = new Map();
 for (const check of checks) {
  const result = await send({ t: 'req', op: 'thread.command', args: { threadId: check.threadId, name: 'ptb', args: 'status' } });
  assert(result.ok, `owner /ptb status failed for ${check.label}`);
  statuses.set(check.key, [result.value.notice, result.value.body].filter(Boolean).join('\n') + '\n');
 }
 const facts = { threadCount: rows.length, teamCount: teams.length,
  workerCount: teams.reduce((n, team) => n + team.workers.length, 0),
  workersByTeam: Object.fromEntries(teams.map(team => [team.teamId, team.workers.length])),
  nonIdle: rows.filter(row => row.activity !== 'idle').length,
  queued: rows.reduce((n, row) => n + row.queued, 0) };
 if (approved) for (const key of ['threadCount', 'teamCount', 'workerCount']) {
  assert.equal(facts[key], approved[key], `${key} differs from the owner-approved baseline`);
 }
 assert.equal(facts.nonIdle, 0, 'non-idle work: wait or obtain explicit owner resume approval');
 assert.equal(facts.queued, 0, 'queued inputs: wait or obtain explicit owner resume approval');
 const bindings = rows.map(({ id, kind, team }) => ({ id, kind, ...(team ? { team } : {}) })).sort((a, b) => a.id.localeCompare(b.id));
 if (mode === 'after') {
  assert.deepEqual(bindings, JSON.parse(readFileSync(join(directory, 'expected-bindings.json'), 'utf8')), 'thread or Worker binding changed');
 } else save('expected-bindings.json', JSON.stringify(bindings, null, 2) + '\n');
 save(`${mode}-threads.json`, JSON.stringify(rows, null, 2) + '\n');
 save(`${mode}-facts.json`, JSON.stringify(facts, null, 2) + '\n');
 // One private status file per Team id (or `unbound`), so a reviewer reads each Team's text as the owner sees it.
 const statusDirectory = join(directory, mode === 'before' ? 'expected-status' : 'actual-status');
 mkdirSync(statusDirectory, { recursive: true, mode: 0o700 });
 for (const [key, text] of statuses) writeFileSync(join(statusDirectory, `${key}.txt`), text, { mode: 0o600 });
 if (mode === 'before') {
  save('selection.json', JSON.stringify(selection) + '\n');
  save('newest-worker.txt', teams.length ? teams.map(team => `${team.teamId} ${team.workers[0]?.id ?? 'none'}\n`).join('') : 'No Team Worker on this node.\n');
 } else {
  const expectedDirectory = join(directory, 'expected-status');
  assert.deepEqual(readdirSync(expectedDirectory).sort(), checks.map(check => `${check.key}.txt`).sort(), 'the set of status files changed');
  for (const check of checks) {
   assert.equal(statuses.get(check.key), readFileSync(join(expectedDirectory, `${check.key}.txt`), 'utf8'), `${check.label}: status changed; inspect private expected/actual files`);
  }
  const expected = JSON.parse(readFileSync(join(directory, 'before-facts.json'), 'utf8'));
  for (const key of ['threadCount', 'teamCount', 'workerCount']) assert.equal(facts[key], expected[key], `${key} changed`);
  for (const team of teams) assert.equal(facts.workersByTeam[team.teamId], expected.workersByTeam[team.teamId], `${team.label}: workerCount changed`);
 }
 console.log(`PASS ${mode}: threads=${facts.threadCount} Teams=${facts.teamCount} Workers=${facts.workerCount} nonIdle=0 queued=0`);
} catch (error) {
 // Status text and thread identities remain only in the private files.
 console.error(`STOP: ${error.message.split('\n')[0]}`); process.exitCode = 1;
} finally { clearTimeout(timeout); socket.destroy(); }
