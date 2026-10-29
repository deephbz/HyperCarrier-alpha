import "./home.mjs";
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SimWorld, Entropy, Scheduler } from '../src/index.mjs';

test('durable world persists real native entries and reopens them', async () => {
  const world = await SimWorld.create({ sessionStorage: 'durable', replies: [{ text: 'stored answer' }] });
  const root = world.root;
  try {
    await world.prompt('stored question');
    const file = world.sessionManager.getSessionFile();
    assert.equal(file.startsWith(world.sessionDir + '/'), true);
    const records = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records[0].type, 'session');
    assert.deepEqual(records.slice(1), world.sessionManager.getEntries());
    const reopened = world.sdk.SessionManager.open(file);
    assert.deepEqual(reopened.getEntries(), world.sessionManager.getEntries());
    world.assertHealthy();
  } finally { await world.close(); }
  assert.equal(fs.existsSync(root), false);
});

test('stable roots refuse collisions without deleting foreign data; failed initialization releases ownership', async () => {
  const parent = fs.mkdtempSync(join(tmpdir(), 'pi-sim-root-test-'));
  const root = join(parent, 'seed-17');
  try {
    fs.mkdirSync(root); fs.writeFileSync(join(root, 'foreign'), 'keep');
    await assert.rejects(SimWorld.create({ root }), /existing roots are refused/);
    assert.equal(fs.readFileSync(join(root, 'foreign'), 'utf8'), 'keep');
    fs.rmSync(root, { recursive: true });
    await assert.rejects(SimWorld.create({ root, piRoot: join(parent, 'missing') }), /HC_PI_SIM_PI_ROOT/);
    assert.equal(fs.existsSync(root), false);
    const world = await SimWorld.create({ root });
    assert.equal(world.root, root);
    await world.close();
    assert.equal(fs.existsSync(root), false);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('root-aware setup writes real fixtures and loads path and factory extensions under the world boundary', async () => {
  let context, started = 0;
  const world = await SimWorld.create({ sessionStorage: 'durable', replies: [{ text: 'setup answer' }],
    extensionFactories: [pi => pi.on('session_start', () => { started++; })],
    setup: async value => {
      context = value;
      const config = join(value.root, 'fixture.json');
      await fsp.writeFile(config, JSON.stringify({ root: value.root }));
      const extension = join(value.root, 'extension.mjs');
      await fsp.writeFile(extension, `export default pi => pi.on('session_start', (_event, ctx) => ctx.ui.notify('path fixture loaded', 'info'));`);
      await new Promise(resolve => setTimeout(resolve, 12));
      return { extensionPaths: [extension], extensionFactories: [pi => pi.on('session_start', () => {
        assert.deepEqual(JSON.parse(fs.readFileSync(config)), { root: value.root }); started++;
      })] };
    },
  });
  try {
    assert.equal(started, 2);
    assert.equal(context.sessionManager, world.sessionManager);
    assert.equal(context.modelRuntime, world.modelRuntime);
    assert.equal(context.entropy, world.entropy);
    assert.equal(world.scheduler.now - world.scheduler.start, 12);
    assert.ok(world.history.some(event => event.kind === 'ui.notify' && event.data.text === 'path fixture loaded'));
    await world.prompt('setup question'); world.assertHealthy();
  } finally { await world.close(); }
});

test('setup failure restores globals and removes only its owned root', async () => {
  const home = process.env.HOME, now = Date.now;
  let root;
  await assert.rejects(SimWorld.create({ setup: async context => {
    root = context.root;
    await fsp.writeFile(join(root, 'partial'), 'partial');
    throw new Error('setup fixture failed');
  } }), /setup fixture failed/);
  assert.equal(fs.existsSync(root), false);
  assert.equal(process.env.HOME, home);
  assert.equal(Date.now, now);
  const world = await SimWorld.create(); await world.close();
});

test('seeded temporary directories replay, avoid collisions and restore mkdtemp', async () => {
  const parent = fs.mkdtempSync(join(tmpdir(), 'pi-sim-temp-test-'));
  const original = fsp.mkdtemp;
  const names = [];
  try {
    for (let run = 0; run < 2; run++) {
      const root = join(parent, 'seed-23'); fs.mkdirSync(root);
      const scheduler = new Scheduler(new Entropy(23));
      const restore = scheduler.install();
      try {
        const first = await fsp.mkdtemp(join(root, 'one-'));
        const second = await fsp.mkdtemp(join(root, 'one-'), { encoding: 'buffer' });
        assert.ok(Buffer.isBuffer(second)); assert.notEqual(first, second.toString());
        assert.ok(fs.statSync(first).isDirectory());
        assert.equal(fs.statSync(first).mode & 0o777, 0o700);
        names.push([first, second.toString()]);
        await assert.rejects(fsp.mkdtemp(Buffer.from(root)), /string prefix/);
      } finally { restore(); }
      assert.equal(fsp.mkdtemp, original);
      fs.rmSync(root, { recursive: true });
    }
    assert.deepEqual(names[0], names[1]);
    // Repeat the same entropy while the first candidate exists. It must retry.
    fs.mkdirSync(join(parent, 'seed-23')); fs.mkdirSync(names[0][0]);
    const scheduler = new Scheduler(new Entropy(23)), restore = scheduler.install();
    try { assert.equal(await fsp.mkdtemp(join(parent, 'seed-23', 'one-')), names[0][1]); }
    finally { restore(); }
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('deterministic temp naming keeps world path guards', async () => {
  const world = await SimWorld.create();
  try {
    const path = await fsp.mkdtemp(join(world.root, 'owned-'));
    assert.ok(fs.existsSync(path));
    world.assertHealthy();
    await assert.rejects(fsp.mkdtemp(join(world.root, '..', 'escape-')), /outside isolated root/);
    assert.throws(() => world.assertHealthy(), /outside isolated root/);
  } finally { await world.close(); }
});

test('durable fresh-process replay preserves native IDs, paths, timestamps and file hashes', () => {
  const parent = fs.mkdtempSync(join(tmpdir(), 'pi-sim-durable-test-'));
  try {
    const script = fileURLToPath(new URL('./fixtures/durable-child.mjs', import.meta.url));
    const runs = [0, 1].map(() => spawnSync(process.execPath, [script, join(parent, 'seed-17')], { encoding: 'utf8', timeout: 15000 }));
    for (const run of runs) assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(runs[0].stdout), JSON.parse(runs[1].stdout));
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});
