import "./home.mjs";
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import { SimWorld, delayHostIO } from '../src/index.mjs';

const wallNow = Date.now.bind(Date);

for (const method of ['lstat', 'realpath']) for (const entry of ['run', 'advance']) {
  test(`${entry} drains delayed real ${method} before virtual timers`, async () => {
    let file;
    const world = await SimWorld.create({ hostIOLatency: delayHostIO({
      operations: [method], delayMs: 30, path: path => path === file,
    }) });
    let operation;
    const order = [];
    try {
      file = join(world.root, 'delayed'); fs.writeFileSync(file, 'fixture');
      const started = wallNow();
      operation = fsp[method](file).then(value => {
        if (method === 'lstat') assert.ok(value.isFile());
        else assert.equal(value, fs.realpathSync(file));
        order.push(method);
      });
      assert.equal(world.scheduler.pendingIO.size, 1);
      const timer = new Promise(resolve => setTimeout(() => { order.push('timer'); resolve(); }, 1));
      if (entry === 'run') await world.run(() => timer); else await world.advance(1);
      assert.deepEqual(order, [method, 'timer']);
      assert.ok(wallNow() - started >= 25, 'real wall latency was not injected');
      assert.equal(world.scheduler.now - world.scheduler.start, 1, 'host latency cannot become virtual time');
      assert.equal(world.scheduler.pendingIO.size, 0);
      assert.equal(world.history.filter(event => event.kind === 'host.io.delay').length, 1);
      await assert.rejects(fsp[method](join(world.root, 'missing')), /ENOENT/);
      assert.equal(world.scheduler.pendingIO.size, 0);
      world.assertHealthy();
    } finally { await operation; await world.close(); }
  });
}

for (const method of ['read', 'write', 'writeFile', 'sync', 'close', 'stat']) {
  test(`FileHandle.${method} completion precedes timers and restores its method`, async () => {
    let file, handle, operation, wrapped;
    const world = await SimWorld.create({ hostIOLatency: delayHostIO({
      operations: [`FileHandle.${method}`], delayMs: 30, path: path => path === file,
    }) });
    const order = [];
    try {
      file = join(world.root, 'data'); fs.writeFileSync(file, 'fixture');
      handle = await fsp.open(file, 'r+'); wrapped = handle[method];
      const args = method === 'read' ? [Buffer.alloc(7), 0, 7, 0] : method === 'write' ? [Buffer.from('changed'), 0, 7, 0] : method === 'writeFile' ? ['changed'] : [];
      const started = wallNow();
      operation = handle[method](...args).then(value => {
        if (method === 'read') assert.equal(value.buffer.toString(), 'fixture');
        if (method === 'stat') assert.equal(value.size, 7);
        order.push(method);
      });
      assert.ok(world.scheduler.pendingIO.size >= 1);
      setTimeout(() => order.push('timer'), 1);
      await world.advance(1);
      assert.deepEqual(order, [method, 'timer']);
      assert.ok(wallNow() - started >= 25);
      assert.equal(world.scheduler.pendingIO.size, 0);
      assert.equal(world.history.filter(event => event.kind === 'host.io.delay' && event.data.operation === `FileHandle.${method}`).length, 1);
      if (method === 'write' || method === 'writeFile') assert.equal(fs.readFileSync(file, 'utf8'), 'changed');
      if (method !== 'close') await handle.close();
      world.assertHealthy();
    } finally { await operation; if (handle?.fd >= 0) await handle.close(); await world.close(); }
    assert.notEqual(handle[method], wrapped);
    assert.equal(world.scheduler.pendingIO.size, 0);
  });
}

test('FileHandle rejections settle and owned close still revokes descriptor writes', async () => {
  const world = await SimWorld.create({ hostIOLatency: delayHostIO({ operations: ['FileHandle.stat'], delayMs: 30 }) });
  try {
    const handle = await fsp.open(join(world.root, 'handle'), 'w+'), fd = handle.fd;
    await world.run(() => handle.writeFile('owned'));
    fs.writeFileSync(fd, 'owned descriptor');
    await world.run(() => handle.close());
    const started = wallNow();
    await assert.rejects(world.run(() => handle.stat()), /closed/);
    assert.ok(wallNow() - started >= 25, 'rejections also retain injected latency');
    assert.equal(world.scheduler.pendingIO.size, 0);
    world.assertHealthy();
    assert.throws(() => fs.writeFileSync(fd, 'closed'), /outside isolated root/);
  } finally { await world.close(); }
});

for (const entry of ['run', 'advance']) test(`stalled FileHandle work obeys the same wall-time bound: ${entry}`, async () => {
  const world = await SimWorld.create({ hostIOLatency: delayHostIO({ operations: ['FileHandle.stat'], delayMs: 80 }) });
  let operation, handle;
  try {
    handle = await fsp.open(join(world.root, 'bound'), 'w+'); operation = handle.stat();
    if (entry === 'run') await assert.rejects(world.run(() => operation, { wallTimeoutMs: 20 }), /wall-time safety bound/);
    else await assert.rejects(world.scheduler.advance(1, { wallTimeoutMs: 20 }), /wall-time safety bound/);
    assert.equal(world.scheduler.now, world.scheduler.start);
  } finally { await operation; await handle?.close(); await world.close(); }
});

test('host latency selects operation and original path without leaking into later worlds', async () => {
  let selected;
  const world = await SimWorld.create({ hostIOLatency: delayHostIO({
    operations: ['lstat', 'FileHandle.stat'], delayMs: 30, path: path => path === selected,
  }) });
  try {
    selected = join(world.root, 'selected'); fs.writeFileSync(selected, 'fixture');
    await fsp.realpath(selected); await fsp.lstat(world.root);
    const other = await fsp.open(join(world.root, 'other'), 'w+');
    await other.stat(); await other.close();
    assert.equal(world.history.filter(event => event.kind === 'host.io.delay').length, 0);
    const handle = await fsp.open(selected, 'r');
    await world.run(() => handle.stat()); await handle.close();
    const event = world.history.find(event => event.kind === 'host.io.delay');
    assert.deepEqual(event.data, { operation: 'FileHandle.stat', path: selected, delayMs: 30 });
    world.assertHealthy();
  } finally { await world.close(); }
  const next = await SimWorld.create();
  try {
    await next.run(() => fsp.lstat(next.root));
    assert.equal(next.history.filter(event => event.kind === 'host.io.delay').length, 0);
    next.assertHealthy();
  } finally { await next.close(); }
});

test('invalid host latency policies fail before starting filesystem effects', async () => {
  for (const operations of [[], ['glob'], ['unknown'], ['FileHandle.readFile']]) {
    assert.throws(() => delayHostIO({ operations, delayMs: 1 }), /tracked/);
  }
  for (const delayMs of [-1, NaN, Infinity, 2147483648]) {
    assert.throws(() => delayHostIO({ operations: ['lstat'], delayMs }), /delayMs/);
  }
  const world = await SimWorld.create({ hostIOLatency: ({ operation }) => operation === 'writeFile' ? NaN : 0 });
  try {
    const file = join(world.root, 'must-not-exist');
    assert.throws(() => fsp.writeFile(file, 'no'), /hostIOLatency/);
    assert.equal(fs.existsSync(file), false);
    assert.equal(world.scheduler.pendingIO.size, 0);
  } finally { await world.close(); }
});
