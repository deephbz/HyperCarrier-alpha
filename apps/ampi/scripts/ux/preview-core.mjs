// Pure parts of the generated preview (preview.mjs): arguments, side resolution, scene selection, shots, crop boxes.
// Scenes are the recipes in recipes.mjs; this module adds no inventory of its own.
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const THEMES = ['light', 'dark'];
// The page's prefers-reduced-motion. Captures default to reduce: stills then show no mid-motion frame.
const MOTIONS = ['reduce', 'no-preference'];
const list = value => value.split(',').map(s => s.trim()).filter(Boolean);

export const USAGE = 'Usage: npm run preview -- --base <ref|worktree> --head <ref|worktree> [--only S03.x,S12.a] [--themes light,dark] [--variants a,b] [--motion reduce|no-preference] [--out <dir>]';

/** `--base` and `--head` are required. No `--only` runs every recipe. `--motion no-preference` shows normal-motion styles. */
export function parseArgs(argv) {
  const out = { base: undefined, head: undefined, only: undefined, themes: THEMES, variants: [], motion: 'reduce', out: undefined };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], value = argv[i + 1];
    const need = () => { if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value. ${USAGE}`); i++; return value; };
    if (flag === '--base') out.base = need();
    else if (flag === '--head') out.head = need();
    else if (flag === '--only') out.only = list(need());
    else if (flag === '--themes') out.themes = list(need());
    else if (flag === '--variants') out.variants = list(need());
    else if (flag === '--motion') out.motion = need();
    else if (flag === '--out') out.out = need();
    else throw new Error(`Unknown argument ${flag}. ${USAGE}`);
  }
  if (!out.base) throw new Error(`--base is required. ${USAGE}`);
  if (!out.head) throw new Error(`--head is required. ${USAGE}`);
  const bad = out.themes.filter(t => !THEMES.includes(t));
  if (bad.length || !out.themes.length) throw new Error(`Unknown theme ${bad.join(', ')}; themes are ${THEMES.join(', ')}`);
  if (!MOTIONS.includes(out.motion)) throw new Error(`Unknown motion ${out.motion}; motions are ${MOTIONS.join(', ')}`);
  return out;
}

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * One side as a commit. A ref resolves in `repo`. An existing directory is a worktree: its HEAD when clean, else a
 * `git stash create` commit of its tracked edits. That command writes only objects; the tree, the index, the stash
 * list and HEAD stay as they were. Untracked files and submodule working changes are not in that commit; they are
 * returned so the gallery can name them.
 */
export function resolveSide(repo, spec) {
  if (existsSync(spec) && statSync(spec).isDirectory()) {
    const dir = resolve(spec);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const stash = git(dir, ['stash', 'create']);
    const untracked = git(dir, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
    const submodules = git(dir, ['submodule', 'status']).split('\n').filter(l => l.startsWith('+')).map(l => l.slice(1).split(' ')[1]);
    const dirty = git(dir, ['diff', '--name-only', '--ignore-submodules=none']).split('\n').filter(Boolean);
    for (const path of dirty) if (git(dir, ['ls-files', '-s', '--', path]).startsWith('160000') && !submodules.includes(path)) submodules.push(path);
    return { spec, kind: 'worktree', sha: stash || head, base: head, untracked, submodules, note: stash ? `${dir} = stash of ${head} + tracked edits` : `${dir} = HEAD ${head} (clean)` };
  }
  let sha;
  try { sha = git(repo, ['rev-parse', '--verify', `${spec}^{commit}`]); } catch { throw new Error(`${spec} is neither a commit nor a worktree directory`); }
  return { spec, kind: 'ref', sha, base: sha, untracked: [], submodules: [], note: `${spec} = ${sha}` };
}

/** The recipes named by `only`, in recipe order; every recipe when `only` is absent. */
export function selectScenes(recipes, only) {
  if (!only) return [...recipes];
  const missing = only.filter(id => !recipes.some(r => r.id === id));
  if (missing.length) throw new Error(`No recipe ${missing.join(', ')} in scripts/ux/recipes.mjs`);
  return recipes.filter(r => only.includes(r.id));
}

/** One shot per theme, or the scene's pinned theme. A variant names the head-side shot. */
export function shotsOf(scene, themes, variant) {
  return (scene.theme ? [scene.theme] : themes).map(theme => ({ scene, theme, variant, key: [scene.id, theme, variant].filter(Boolean).join('.') }));
}

/** The union of the measured target boxes plus padding, clamped to the viewport; the whole viewport without a box. */
export function cropBox(boxes, viewport, pad = 24) {
  if (!boxes.length) return { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const x = Math.max(0, Math.floor(Math.min(...boxes.map(b => b.x)) - pad));
  const y = Math.max(0, Math.floor(Math.min(...boxes.map(b => b.y)) - pad));
  const right = Math.min(viewport.width, Math.ceil(Math.max(...boxes.map(b => b.x + b.width)) + pad));
  const bottom = Math.min(viewport.height, Math.ceil(Math.max(...boxes.map(b => b.y + b.height)) + pad));
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * The run's verdict. A scene whose setup failed proves nothing, so any failed side fails the run. When both sides are
 * the same commit and the head plays no variant (an A/A run), any changed shot is scene drift and fails the run too.
 */
export function verdict({ base, head, variants, shots }) {
  const failed = shots.flatMap(s => [['base', s.sides.before], ['head', s.sides.after]].filter(([, side]) => side.error).map(([name]) => `${name} ${s.key}`));
  const aa = base.sha === head.sha && !variants.length;
  const drift = aa ? shots.filter(s => s.diff.changed).map(s => s.key) : [];
  return { ok: !failed.length && !drift.length, aa, failed, drift };
}
