// The git submodules that the AmPi hub, the demo, and the web build load. Two sources decide the set, so a new
// dependency cannot fall outside the check without notice:
//   1. the workspace package graph from apps/ampi/package.json: its dependencies, optionalDependencies and
//      devDependencies, then each reached workspace's dependencies, optionalDependencies and peerDependencies;
//   2. relative imports in the source of every reached workspace outside a submodule
//      (for example apps/ampi/src/pi/search.ts imports ../../../trace-analytics).
// A submodule that is not checked out still counts: its package name comes from the pinned commit in the module store.
// Consumers: scripts/verify/hub.mjs (launch and doctor), scripts/verify/checkout.mjs and scripts/test-preflight.cjs.
//
// Git run in a directory that is not its own repository acts on the enclosing checkout: `git -C <uninitialized
// submodule> checkout <pin>` moves the parent worktree's HEAD. Every Git command on a submodule path goes through
// submoduleGit, and the printed fix for a missing or drifted submodule is the guarded command:
//
//   node apps/ampi/scripts/submodules.mjs pin [--root <checkout>] <path>...
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const git = (cwd, args, env) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...(env ? { env: { ...process.env, ...env } } : {}) }).trim();

/** True only when <root>/<path> is the top level of its own repository. The ceiling stops discovery at its parent. */
export function ownRepo(root, path) {
  const dir = resolve(root, path);
  if (!existsSync(dir)) return false;
  try { return realpathSync(git(dir, ['rev-parse', '--show-toplevel'], { GIT_CEILING_DIRECTORIES: dirname(dir) })) === realpathSync(dir); } catch { return false; }
}

/** Git in a submodule. Refuses when the directory is not its own repository, so the parent checkout never changes. */
export function submoduleGit(root, path, args) {
  if (!ownRepo(root, path)) throw new Error(`${path} is not a checked-out repository; refusing git ${args[0]}, which would act on ${root}. Fix: node apps/ampi/scripts/submodules.mjs pin --root ${root} ${path}`);
  const dir = resolve(root, path);
  return git(dir, args, { GIT_CEILING_DIRECTORIES: dirname(dir) });
}

/**
 * Put a submodule at HEAD's gitlink SHA from the shared module store. A directory that is not yet a repository (absent,
 * empty, or holding only ignored files such as node_modules) gets a shared clone's .git moved into it first.
 */
export function pinSubmodule(root, path) {
  const dir = resolve(root, path);
  const pin = git(root, ['ls-tree', 'HEAD', path]).split(/\s+/)[2];
  if (!pin) throw new Error(`HEAD has no gitlink at ${path}`);
  const store = join(resolve(root, git(root, ['rev-parse', '--git-common-dir'])), 'modules', path);
  if (!ownRepo(root, path)) {
    if (existsSync(join(dir, '.git'))) throw new Error(`${path}/.git exists but is not a working repository; inspect it before you pin`);
    if (!existsSync(store)) throw new Error(`No module store at ${store}; initialize ${path} once in the main checkout`);
    mkdirSync(dir, { recursive: true });
    const scratch = mkdtempSync(join(dirname(dir), '.ampi-pin-'));
    try {
      git(root, ['clone', '--quiet', '--shared', '--no-checkout', store, join(scratch, 'clone')]);
      renameSync(join(scratch, 'clone', '.git'), join(dir, '.git'));
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  try { submoduleGit(root, path, ['cat-file', '-e', `${pin}^{commit}`]); } catch { submoduleGit(root, path, ['fetch', '--quiet', store, pin]); }
  submoduleGit(root, path, ['checkout', '--quiet', '--detach', pin]);
  return pin;
}
const inside = (child, parent) => child === parent || child.startsWith(parent + sep);
const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/;
const SKIP = new Set(['node_modules', 'dist', 'build', 'test', '.git']);
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|new URL\(\s*)["'`](\.\.?\/[^"'`$]*)/g;

/** Every submodule path in the checkout's .gitmodules. */
export function submodulePaths(root) {
  if (!existsSync(join(root, '.gitmodules'))) return [];
  let out = '';
  try { out = git(root, ['config', '-f', '.gitmodules', '--get-regexp', 'path']); } catch { return []; }
  return out.split('\n').filter(Boolean).map(line => line.split(' ')[1]);
}

/** The package.json of a directory, or of a not-checked-out submodule at its pinned commit. */
function manifest(root, dir, submodule) {
  const file = join(root, dir, 'package.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  if (!submodule) return undefined;
  try {
    const pin = git(root, ['ls-tree', 'HEAD', submodule]).split(/\s+/)[2];
    const store = join(resolve(root, git(root, ['rev-parse', '--git-common-dir'])), 'modules', submodule);
    const sub = relative(submodule, dir);
    return JSON.parse(execFileSync('git', ['--git-dir', store, 'show', `${pin}:${sub ? sub + '/' : ''}package.json`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch { return undefined; }
}

function workspaceDirs(root) {
  const patterns = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).workspaces ?? [];
  const excluded = new Set(patterns.filter(p => p.startsWith('!')).map(p => p.slice(1)));
  const dirs = [];
  for (const pattern of patterns.filter(p => !p.startsWith('!'))) {
    if (!pattern.endsWith('/*')) { dirs.push(pattern); continue; }
    const parent = pattern.slice(0, -2);
    if (existsSync(join(root, parent))) for (const e of readdirSync(join(root, parent), { withFileTypes: true })) if (e.isDirectory()) dirs.push(`${parent}/${e.name}`);
  }
  return dirs.filter(d => !excluded.has(d));
}

function* sourceFiles(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* sourceFiles(p);
    else if (SOURCE.test(e.name)) yield p;
  }
}

/**
 * The submodules AmPi loads, with the reason each one is in scope, and the submodules it does not load.
 * `unknown` lists workspaces whose package name could not be read; they are kept in scope (fail closed).
 */
export function ampiSubmodules(root) {
  const all = submodulePaths(root);
  const owner = dir => all.find(s => inside(join(root, dir), join(root, s)));
  const byName = new Map(), unknown = [];
  for (const dir of workspaceDirs(root)) {
    const pkg = manifest(root, dir, owner(dir));
    if (pkg?.name) byName.set(pkg.name, { dir, pkg });
    else if (owner(dir) && !existsSync(join(root, dir, 'package.json'))) unknown.push(dir);
  }
  const reasons = new Map();
  const add = (submodule, why) => { if (!reasons.has(submodule)) reasons.set(submodule, why); };
  for (const dir of unknown) add(owner(dir), `workspace ${dir} has no readable package.json`);
  const seen = new Set(['apps/ampi']), queue = [{ dir: 'apps/ampi', pkg: manifest(root, 'apps/ampi'), root: true }];
  while (queue.length) {
    const { dir, pkg, root: top } = queue.shift();
    const deps = { ...pkg?.dependencies, ...pkg?.optionalDependencies, ...(top ? pkg?.devDependencies : pkg?.peerDependencies) };
    for (const name of Object.keys(deps)) {
      const next = byName.get(name);
      if (!next || seen.has(next.dir)) continue;
      seen.add(next.dir);
      if (owner(next.dir)) add(owner(next.dir), `${dir} depends on ${name}`);
      queue.push(next);
    }
    if (owner(dir)) continue;
    for (const file of sourceFiles(join(root, dir))) {
      for (const [, spec] of readFileSync(file, 'utf8').matchAll(IMPORT)) {
        const target = relative(root, resolve(dirname(file), spec));
        const sub = all.find(s => inside(target, s));
        if (sub) add(sub, `${relative(root, file)} imports ${spec}`);
      }
    }
  }
  const scope = all.filter(s => reasons.has(s));
  return { scope, reasons: Object.fromEntries(scope.map(s => [s, reasons.get(s)])), other: all.filter(s => !reasons.has(s)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--root');
  const root = at >= 0 ? resolve(args.splice(at, 2)[1]) : git(process.cwd(), ['rev-parse', '--show-toplevel']);
  const [command, ...paths] = args;
  if (command === 'pin' && paths.length) {
    for (const path of paths) console.log(`${path} at ${pinSubmodule(root, path).slice(0, 12)}`);
  } else if (command === 'scope') {
    console.log(JSON.stringify(ampiSubmodules(root), null, 2));
  } else {
    console.error('Usage: submodules.mjs pin [--root <checkout>] <path>... | scope [--root <checkout>]');
    process.exit(2);
  }
}
