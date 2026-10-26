// Migration guard for a whole-home archive or move. Never delete or relocate lock files.
// Run only after supervisors and owners are stopped; a probe cannot prevent a later restart.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [mode, homeArg, ...caches] = process.argv.slice(2);
assert(['overlap', 'stopped'].includes(mode) && homeArg,
 'usage: migration-lock-check.mjs overlap|stopped HOME [HUB_CACHE_ROOT...]');
const home = realpathSync(homeArg);
const within = (root, path) => { const r = relative(root, path); return !r || (r !== '..' && !r.startsWith('../') && !isAbsolute(r)); };
const roots = caches.map(path => realpathSync(path));
console.log(JSON.stringify({ cacheInsideHome: roots.map(path => within(home, path)) }));
if (mode === 'stopped') {
 const locks = new Set();
 function walk(path) {
  const stat = lstatSync(path);
  assert(!stat.isSymbolicLink(), 'STOP: symlink needs a reviewed ownership plan');
  if (stat.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
  else if (['owner.lock', 'node-owner.sqlite'].includes(basename(path))) locks.add(path);
 }
 walk(home);
 for (const root of roots) if (!within(home, root)) walk(root);
 // A missing node lock cannot prove that the intended home was selected.
 assert(existsSync(join(home, 'node-owner.sqlite')), 'STOP: node owner lock is missing');
 for (const path of locks) {
  let db;
  try {
   db = new DatabaseSync(path, { timeout: 0 });
   db.exec('BEGIN EXCLUSIVE; ROLLBACK;');
  } catch {
   throw Error('STOP: an owner lock is held or unreadable; do not archive or move');
  } finally { db?.close(); }
 }
 console.log(`PASS stopped: ${locks.size} owner locks released`);
}
