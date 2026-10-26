// A disposable, detached checkout of one commit for `run.mjs --checkout <sha>` (.pi/skills/verify-ampi/SKILL.md).
// It never touches another worktree: it adds a detached worktree under $TMPDIR, clones only the submodules AmPi loads
// (scripts/submodules.mjs) from the shared module store, links node_modules from the invoking checkout, and builds the web app.
// remove() deletes the directory and prunes the worktree entry; `git worktree remove` refuses a tree with submodules.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ampiSubmodules, pinSubmodule } from '../submodules.mjs';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const NOT_PACKAGES = new Set(['node_modules', '.git', '.worktrees', 'output', 'dist']);

/** Directories (relative to root, up to three levels) that hold a node_modules directory. */
function nodeModuleDirs(root, rel = '', depth = 0, out = []) {
  const dir = join(root, rel);
  if (existsSync(join(dir, 'node_modules'))) out.push(rel);
  if (depth < 3) for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.') && !NOT_PACKAGES.has(e.name)) nodeModuleDirs(root, join(rel, e.name), depth + 1, out);
  return out;
}

/** Mirror one node_modules level: relative links (workspace packages) stay relative, so they resolve inside the copy. */
function link(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const source = join(from, name), dest = join(to, name);
    const stat = lstatSync(source);
    if (stat.isSymbolicLink() && !isAbsolute(readlinkSync(source))) symlinkSync(readlinkSync(source), dest);
    else if (name.startsWith('@') && stat.isDirectory()) link(source, dest);
    else symlinkSync(source, dest);
  }
}

export function prepareCheckout(from, sha, log = console.log) {
  const revision = git(from, ['rev-parse', '--verify', `${sha}^{commit}`]);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ampi-verify-checkout-')));
  const remove = () => {
    rmSync(dir, { recursive: true, force: true });
    try { git(from, ['worktree', 'prune']); } catch {}
  };
  try {
    git(from, ['worktree', 'add', '--detach', dir, revision]);
    const { scope } = ampiSubmodules(dir);
    for (const path of scope) pinSubmodule(dir, path);
    const linked = nodeModuleDirs(from).filter(rel => existsSync(join(dir, rel)));
    for (const rel of linked) link(join(from, rel, 'node_modules'), join(dir, rel, 'node_modules'));
    log(`checkout ${revision.slice(0, 12)} at ${dir}: submodules ${scope.join(', ') || 'none'}; node_modules from ${from} (${linked.length} dirs)`);
    execFileSync('npm', ['run', '--silent', 'build:web'], { cwd: join(dir, 'apps/ampi'), stdio: ['ignore', 'ignore', 'inherit'] });
    return { dir, revision, remove };
  } catch (error) { remove(); throw error; }
}
