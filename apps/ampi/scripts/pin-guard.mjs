// Refuse a commit at the integration interface (the merge gate and deploy:live) when it is not safe to deploy:
//   entry  The commit carries the current deploy entry: apps/ampi/scripts/deploy-live.sh names ENTRY_MARKER. An older
//          checkout runs its own stale deploy copy, which cannot be patched, so it must merge dev/ampi-int first.
//   reach  Every submodule gitlink is on that submodule's origin. A fresh clone fetches a gitlink from origin, so a pin
//          that exists only in a local module store breaks every other checkout.
//   change A gitlink that differs from the base must fast-forward from the base pin. Otherwise a commit in
//          base..target must declare it with the line `pin: <path> <old>..<new> because <reason>` (hashes may be
//          abbreviated). 4d8b23d moved apps/trace-analytics from fd49c01 back to an unrelated pin by accident.
//
//   node apps/ampi/scripts/pin-guard.mjs [--root <checkout>] [--base <commit>] <target>
//
// The base defaults to the merge base of <target> and dev/ampi-int; deploy-live.sh passes the live commit.
// reach asks a cached origin branch first (`git branch -r --contains`) and fetches the module store's origin only on a
// miss (in parallel, AMPI_PIN_FETCH_TIMEOUT_MS, default 4000). A failed fetch prints a WARNING and refuses the pin.
// Every git call is asynchronous, and independent calls run together: the guard sits on the deploy return path.
// Exit 0: deployable. Exit 1: refused; each line names the check, path and hashes. Exit 2: usage.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** deploy-live.sh names this variable since it began to run the dev/ampi-int tip's deploy logic. */
export const ENTRY_MARKER = 'AMPI_DEPLOY_LOGIC';
const ENTRY = 'apps/ampi/scripts/deploy-live.sh';
const INT = 'refs/heads/dev/ampi-int';

const gitSync = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }).trim();
/** Resolves to git's trimmed stdout, or undefined when git fails. */
const tryGit = (args, cwd) => new Promise(done => {
  execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 }, (error, stdout) => done(error ? undefined : stdout.trim()));
});
const short = hash => hash.slice(0, 12);

/** Fetch origin into a module store. Resolves to undefined on success, else the reason. Never waits past timeoutMs. */
function fetchOrigin(store, timeoutMs) {
  return new Promise(done => {
    const child = spawn('git', ['--git-dir', store, 'fetch', '--quiet', '--no-tags', 'origin'], {
      stdio: ['ignore', 'ignore', 'pipe'], detached: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let err = '', finished = false;
    const finish = reason => { if (!finished) { finished = true; clearTimeout(timer); done(reason); } };
    // The process group also ends helpers such as ssh, which would otherwise keep the fetch alive.
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} finish(`timed out after ${timeoutMs} ms`); }, timeoutMs);
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => finish(e.message));
    child.on('exit', code => finish(code === 0 ? undefined : (err.trim().split('\n').pop() || `git fetch exit ${code}`)));
  });
}

/** Map path -> pin for every gitlink in an `ls-tree -r` listing. */
function pins(tree) {
  const out = new Map();
  for (const line of (tree ?? '').split('\n')) {
    if (!line.startsWith('160000 commit ')) continue;
    const [meta, path] = line.split('\t');
    out.set(path, meta.split(' ')[2]);
  }
  return out;
}

/** The shared module store of each submodule path, named as in the target's .gitmodules (`config --get-regexp` output). */
function stores(root, commonDir, config) {
  const common = resolve(root, commonDir);
  const names = new Map();
  for (const line of (config ?? '').split('\n').filter(Boolean)) {
    const [key, path] = line.split(' ');
    names.set(path, key.slice('submodule.'.length, -'.path'.length));
  }
  return path => join(common, 'modules', names.get(path) ?? path);
}

/** True when a `pin: <path> <old>..<new> because <reason>` line in base..target matches the change. */
function declared(log, path, from, to) {
  for (const [, p, a, b] of log.matchAll(/^pin: (\S+) ([0-9a-f]{7,40})\.\.([0-9a-f]{7,40}) because \S/gm)) {
    if (p === path && from.startsWith(a) && to.startsWith(b)) return true;
  }
  return false;
}

/** { ok, lines }: one line per warning or refusal, then a summary. */
export async function checkPins(root, target, { base, timeoutMs = Number(process.env.AMPI_PIN_FETCH_TIMEOUT_MS ?? 4000) } = {}) {
  const lines = [];
  // One round of independent reads; each names the target (and a given base), so none waits for their resolution.
  // Without --base, the base tree and log wait for the merge base below.
  const [commit, entry, from, commonDir, config, tree, givenBaseTree, givenLog] = await Promise.all([
    tryGit(['rev-parse', '--verify', `${target}^{commit}`], root),
    tryGit(['show', `${target}:${ENTRY}`], root),
    base ? tryGit(['rev-parse', '--verify', `${base}^{commit}`], root) : tryGit(['merge-base', target, INT], root),
    tryGit(['rev-parse', '--git-common-dir'], root),
    tryGit(['config', '--blob', `${target}:.gitmodules`, '--get-regexp', '^submodule\\..*\\.path$'], root),
    tryGit(['ls-tree', '-r', target], root),
    base && tryGit(['ls-tree', '-r', base], root),
    base && tryGit(['log', '--format=%B', `${base}..${target}`], root),
  ]);
  if (!commit) return { ok: false, lines: [`REFUSED: ${target} is not a commit in ${root}`] };
  if (!(entry ?? '').includes(ENTRY_MARKER)) {
    lines.push(`REFUSED (entry): ${short(commit)} has a stale deploy entry (${ENTRY} lacks ${ENTRY_MARKER}). Merge dev/ampi-int first`);
  }
  if (base && !from) return { ok: false, lines: [...lines, `REFUSED: base ${base} is not a commit in ${root}`] };
  if (tree === undefined || commonDir === undefined) return { ok: false, lines: [...lines, `REFUSED: cannot read the tree of ${short(commit)} in ${root}`] };
  const store = stores(root, commonDir, config);
  const now = pins(tree);
  const [baseTree, log] = base ? [givenBaseTree, givenLog]
    : from ? await Promise.all([tryGit(['ls-tree', '-r', from], root), tryGit(['log', '--format=%B', `${from}..${commit}`], root)]) : [];
  const before = pins(baseTree);

  const results = await Promise.all([...now].map(async ([path, pin]) => {
    const dir = store(path);
    if (!existsSync(dir)) return [`REFUSED (reach): ${path} gitlink ${pin} cannot be checked: no module store at ${dir}; initialize ${path} once in the main checkout`];
    const originUrl = async () => (await tryGit(['--git-dir', dir, 'remote', 'get-url', 'origin'])) ?? '(none)';
    const onOrigin = async () => !!(await tryGit(['--git-dir', dir, 'branch', '-r', '--contains', pin, '--list', 'origin/*']));
    const old = before.get(path);
    // reach and change are independent; the change check needs git only for a moved pin.
    const [cached, forward] = await Promise.all([
      onOrigin(),
      old && old !== pin ? tryGit(['--git-dir', dir, 'merge-base', '--is-ancestor', old, pin]).then(r => r !== undefined) : true,
    ]);
    const out = [];
    if (!cached) {
      const [fetchError, url] = await Promise.all([fetchOrigin(dir, timeoutMs), originUrl()]);
      if (fetchError) out.push(`WARNING: could not fetch ${path} origin ${url} (${fetchError})`);
      if (!(await onOrigin())) out.push(`REFUSED (reach): ${path} gitlink ${pin} is not on its origin ${url} (${fetchError ? 'no cached origin branch contains it, and the fetch failed' : 'no origin branch contains it'}). Push it to origin or pin a published commit`);
    }
    if (!forward && !declared(log ?? '', path, old, pin)) {
      out.push(`REFUSED (change): ${path} gitlink moves ${short(old)}..${short(pin)}, which is not a fast-forward from base ${short(from)}. If intended, add the commit message line: pin: ${path} ${short(old)}..${short(pin)} because <reason>`);
    }
    return out;
  }));
  lines.push(...results.flat());
  const ok = !lines.some(l => l.startsWith('REFUSED'));
  if (ok) lines.push(`pin-guard: ok, ${now.size} gitlinks on origin, ${from ? `pin changes since ${short(from)} fast-forward or declared` : 'no base for the change check'}`);
  return { ok, lines };
}

// import.meta.url is a real path; deploy-live.sh runs a copy under a symlinked temp directory (/var -> /private/var).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const rootArg = option('--root'), base = option('--base');
  const root = rootArg ? resolve(rootArg) : gitSync(['rev-parse', '--show-toplevel'], process.cwd());
  if (args.length !== 1) { console.error('Usage: pin-guard.mjs [--root <checkout>] [--base <commit>] <target>'); process.exit(2); }
  const started = Date.now();
  const { ok, lines } = await checkPins(root, args[0], { base });
  for (const line of lines) (line.startsWith('pin-guard: ok') ? console.log : console.error)(line);
  console.log(`pin-guard: ${((Date.now() - started) / 1000).toFixed(1)} s`);
  process.exit(ok ? 0 : 1);
}
