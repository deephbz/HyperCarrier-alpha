#!/usr/bin/env node
// Verify the packed artifact without HC siblings. No registry publication.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, writeFile, rm, cp, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'pi-sim-consumer-'));
const env = { ...process.env };
delete env.HC_PI_SIM_PI_ROOT;
delete env.HC_PI_SIM_PATH;
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
  return result.stdout;
}
const npmCli = process.env.HC_PI_SIM_NPM_CLI;
const npm = (args, cwd) => npmCli ? run(process.execPath, [npmCli, ...args], cwd) : run('npm', args, cwd);
try {
  let revision = 'unknown (packed)', sourceDirty = null;
  try {
    const packageRoot = await realpath(source);
    const top = await realpath(run('git', ['rev-parse', '--show-toplevel'], source).trim());
    if (top === packageRoot || packageRoot === resolve(top, 'packages', 'hc-pi-sim')) {
      run('git', ['-C', top, 'ls-files', '--error-unmatch', '--', relative(top, join(packageRoot, 'package.json')), relative(top, join(packageRoot, 'src/index.mjs'))], source);
      revision = run('git', ['rev-parse', 'HEAD'], source).trim();
      sourceDirty = Boolean(run('git', ['status', '--porcelain', '--', '.'], source).trim());
    }
  } catch {}
  const npmVersion = npm(['--version'], source).trim();
  const [pack] = JSON.parse(npm(['pack', '--json', '--pack-destination', temp], source));
  for (const file of pack.files) assert.match(file.path, /^(src\/|README\.md$|LICENSE$|package\.json$)/);
  for (const pi of process.argv.slice(2).length ? process.argv.slice(2) : ['1.1.0', '1.2.0']) {
    const cwd = join(temp, `pi-${pi}`);
    await mkdir(cwd);
    // Pi's sibling ranges float across SDK releases. Exercise the selected stack.
    const overrides = pi === '1.1.0' ? Object.fromEntries(['pi-agent-core', 'pi-ai', 'pi-codemode', 'pi-mcp', 'pi-tui'].map(name => [`@earendil-works/${name}`, pi])) : {};
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ private: true, type: 'module', overrides, dependencies: {
      '@hypercarrier/pi-sim': `file:${join(temp, pack.filename)}`, '@earendil-works/pi-coding-agent': pi,
    } }));
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], cwd);
    console.log(JSON.stringify({ node: process.version, npm: npmVersion, pi, overrides, installedPi: JSON.parse(npm(['ls', '--json', '@earendil-works/pi-codemode', '@earendil-works/pi-ai'], cwd)) }));
    await writeFile(join(cwd, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import { SimWorld, SIM_API_VERSION } from '@hypercarrier/pi-sim';
const world = await SimWorld.create({ seed: 37, replies: [{ text: 'consumer answer' }] });
try {
  await world.prompt('consumer question');
  world.assertHealthy();
  assert.equal(world.piVersion, ${JSON.stringify(pi)});
  assert.equal(world.requests.length, 1);
  assert.match(JSON.stringify(world.session.messages), /consumer answer/);
  console.log(JSON.stringify({ node: process.version, pi: world.piVersion, simulator: SIM_API_VERSION, sourceRevision: ${JSON.stringify(revision)}, sourceDirty: ${sourceDirty} }));
} finally { await world.close(); }
await assert.rejects(SimWorld.create({ piRoot: '/synthetic/missing-pi' }), /@earendil-works\\/pi-coding-agent.*HC_PI_SIM_PI_ROOT/);
`);
    console.log(run(process.execPath, ['smoke.mjs'], cwd).trim());
    // Copy only the shipped core tests into this independent installation.
    await cp(join(source, 'test'), join(cwd, 'test'), { recursive: true });
    await symlink(join(cwd, 'node_modules/@hypercarrier/pi-sim/src'), join(cwd, 'src'), 'dir');
    console.log(run(process.execPath, ['--test', '--test-concurrency=1', ...(await readdir(join(cwd, 'test'))).filter(name => name.endsWith('.test.mjs')).map(name => `test/${name}`)], cwd));
  }
} finally { await rm(temp, { recursive: true, force: true }); }
