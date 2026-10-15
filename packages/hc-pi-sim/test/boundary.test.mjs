import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import timers from 'node:timers';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SimWorld, Entropy, Scheduler, ScriptedProvider, validateRequest, assertEntriesPreserved, checkCacheHistory } from '../src/index.mjs';

test('raw fresh-process replay matches, including UUIDs and entropy', () => {
  const script = fileURLToPath(new URL('./fixtures/replay-child.mjs', import.meta.url));
  for (const mode of ['good', 'bad']) {
    const runs = [0, 1].map(() => spawnSync(process.execPath, [script, mode, '17'], { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 }));
    for (const run of runs) assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(runs[0].stdout), JSON.parse(runs[1].stdout));
  }
});

test('virtual timers, UI, session shutdown and host globals restore', async t => {
  const oldHome = process.env.HOME, oldFetch = globalThis.fetch, oldNow = Date.now, notices = [];
  let stopped = false;
  const world = await SimWorld.create({ replies: [{ text: 'done' }], extensionFactories: [pi => {
    let timer;
    pi.on('session_start', (_event, ctx) => { timer = setInterval(() => { notices.push(Date.now()); ctx.ui.notify('tick', 'info'); }, 60000); });
    pi.on('session_shutdown', () => { clearInterval(timer); stopped = true; });
  }] });
  try {
    await world.prompt('hello'); await world.advance(300000);
    assert.equal(notices.length, 5);
    assert.deepEqual(notices, [60000, 120000, 180000, 240000, 300000].map(ms => world.scheduler.start + ms));
    assert.equal(world.history.filter(e => e.kind === 'ui.notify').length, 5);
    t.diagnostic(`virtual timer benchmark ${JSON.stringify(world.report().metrics)}`);
    world.assertHealthy();
  } finally { await world.close(); }
  assert.equal(stopped, true); assert.equal(process.env.HOME, oldHome); assert.equal(globalThis.fetch, oldFetch); assert.equal(Date.now, oldNow);
});

test('inherited terminal bindings cannot activate external adapters in an isolated world', async () => {
  const names = ['HERDR_ENV', 'HERDR_SOCKET_PATH', 'HERDR_PANE_ID'];
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { HERDR_ENV: '1', HERDR_SOCKET_PATH: '/synthetic/herdr.sock', HERDR_PANE_ID: 'synthetic-pane' });
  let activated = false;
  try {
    const world = await SimWorld.create({ extensionFactories: [pi => {
      pi.on('session_start', () => { activated = process.env.HERDR_ENV === '1' && Boolean(process.env.HERDR_SOCKET_PATH); });
    }] });
    try { assert.equal(activated, false); world.assertHealthy(); } finally { await world.close(); }
    assert.equal(process.env.HERDR_PANE_ID, 'synthetic-pane');
  } finally {
    for (const name of names) if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name];
  }
});

test('real TypeScript extension loader keeps its transpiler cache inside the world', async () => {
  const before = process.env.TMPDIR;
  const world = await SimWorld.create({ extensionPaths: [fileURLToPath(new URL('./fixtures/typed-extension.ts', import.meta.url))] });
  try {
    world.assertHealthy();
    assert.ok(world.history.some(e => e.kind === 'ui.notify' && e.data.text === 'Typed fixture loaded'));
    assert.ok(fs.readdirSync(join(world.root, 'tmp', 'jiti')).some(name => name.includes('typed-extension')));
  } finally { await world.close(); }
  assert.equal(process.env.TMPDIR, before);
});

test('formerly unlisted filesystem calls stay pending until real completion', async () => {
  const original = fsp.statfs, hostTimeout = timers.setTimeout;
  // Keep the real call and delay only its completion at the host boundary.
  fsp.statfs = async (...args) => {
    const result = await original(...args);
    await new Promise(resolve => hostTimeout(resolve, 30));
    return result;
  };
  const scheduler = new Scheduler(new Entropy(17)), order = [];
  const restore = scheduler.install();
  let operation;
  try {
    operation = fsp.statfs(fileURLToPath(new URL('.', import.meta.url))).then(result => {
      assert.ok(result.bsize > 0); order.push('statfs');
    });
    assert.equal(scheduler.pendingIO.size, 1, 'statfs must participate before it settles');
    await scheduler.run(() => new Promise(resolve => setTimeout(() => { order.push('timer'); resolve(); }, 1)));
    assert.deepEqual(order, ['statfs', 'timer']);
    assert.equal(scheduler.pendingIO.size, 0);
  } finally {
    await operation;
    restore(); fsp.statfs = original; syncBuiltinESMExports();
  }
});

for (const source of ['before-timer', 'timer-started', 'last-timer']) test(`advance drains delayed real filesystem work: ${source}`, async () => {
  const original = fsp.statfs, hostTimeout = timers.setTimeout;
  fsp.statfs = async (...args) => {
    const result = await original(...args);
    await new Promise(resolve => hostTimeout(resolve, 30));
    return result;
  };
  let world, operation;
  const order = [];
  try {
    world = await SimWorld.create();
    const startIO = () => {
      order.push('start');
      operation = fsp.statfs(world.root).then(result => {
        assert.ok(result.bsize > 0); order.push('io');
      });
    };
    if (source === 'before-timer') startIO();
    else setTimeout(startIO, 1);
    if (source !== 'last-timer') setTimeout(() => order.push('timer'), 2);
    await world.advance(3);
    assert.deepEqual([...order], source === 'last-timer' ? ['start', 'io'] : ['start', 'io', 'timer']);
    assert.equal(world.scheduler.pendingIO.size, 0, 'advance cannot return with unsettled IO');
    assert.equal(world.scheduler.now, world.scheduler.start + 3);
    world.assertHealthy();
  } finally {
    await operation;
    if (world) await world.close();
    fsp.statfs = original; syncBuiltinESMExports();
  }
});

test('advance applies the same wall-time safety bound while draining filesystem work', async () => {
  const scheduler = new Scheduler(new Entropy(20));
  const stalled = new Promise(() => {});
  scheduler.pendingIO.add(stalled);
  try {
    await assert.rejects(scheduler.advance(1, { wallTimeoutMs: 20 }), /world stalled: wall-time safety bound exceeded/);
    assert.equal(scheduler.now, scheduler.start, 'unsettled work cannot advance virtual time');
  } finally { scheduler.pendingIO.delete(stalled); }
});

test('filesystem promise coverage includes new functions and restores the host API', async () => {
  const originals = Object.entries(fsp).filter(([, fn]) => typeof fn === 'function');
  const scheduler = new Scheduler(new Entropy(18));
  const restore = scheduler.install();
  try {
    for (const [name, original] of originals) assert.notEqual(fsp[name], original, `${name} escaped tracking`);
    await assert.rejects(fsp.readlink('/synthetic/missing-fs-link'), /ENOENT/);
    assert.equal(scheduler.pendingIO.size, 0, 'rejected operations settle');
  } finally { restore(); }
  for (const [name, original] of originals) assert.equal(fsp[name], original, `${name} was not restored`);
});

test('unmodeled filesystem iterator lifetimes fail before creating host effects', async () => {
  const scheduler = new Scheduler(new Entropy(19));
  const restore = scheduler.install();
  try {
    for (const name of ['watch', 'glob']) {
      if (typeof fsp[name] !== 'function') continue;
      assert.throws(() => fsp[name]('.'), new RegExp(`unmodeled filesystem iterator: ${name}`));
    }
    assert.equal(scheduler.pendingIO.size, 0);
  } finally { restore(); }
});

test('host filesystem latency cannot advance virtual timers ahead of pending reads', async () => {
  const world = await SimWorld.create();
  try {
    const file = join(world.root, 'large.bin');
    fs.writeFileSync(file, Buffer.alloc(8 * 1024 * 1024));
    const order = [];
    await world.run(async () => {
      const reading = fsp.readFile(file).then(() => order.push('read'));
      const timer = new Promise(resolve => setTimeout(() => { order.push('timer'); resolve(); }, 1));
      await Promise.all([reading, timer]);
    });
    assert.deepEqual(order, ['read', 'timer']);
    world.assertHealthy();
  } finally { await world.close(); }
});

test('isolated writes work; swallowed escapes still fail the world', async () => {
  const world = await SimWorld.create();
  try {
    fs.writeFileSync(join(world.cwd, 'allowed.txt'), 'synthetic');
    assert.equal(fs.readFileSync(join(world.cwd, 'allowed.txt'), 'utf8'), 'synthetic');
    assert.throws(() => fs.writeFileSync(join(world.root, '..', 'escape.txt'), 'bad'), /outside isolated root/);
    assert.throws(() => fs.symlinkSync('/tmp', join(world.root, 'link')), /symlink/);
    assert.throws(() => spawnSync('true'), /child_process/);
    assert.throws(() => world.assertHealthy(), /unmodeled host effect/);
  } finally { await world.close(); }
});

test('real persisted fork admits owned descriptors and rejects unknown or closed descriptors', async () => {
  const world = await SimWorld.create({ replies: [{ text: 'Persisted answer' }] });
  try {
    await world.prompt('Persisted goal');
    const manager = world.sdk.SessionManager.create(world.cwd, join(world.root, 'sessions'));
    for (const message of world.session.messages.filter(m => ['user', 'assistant'].includes(m.role))) manager.appendMessage(message);
    const originalFile = manager.getSessionFile();
    const original = fs.readFileSync(originalFile, 'utf8');
    const fork = manager.createBranchedSession(manager.getLeafId());
    assert.notEqual(fork, originalFile);
    assert.match(fs.readFileSync(fork, 'utf8'), /Persisted answer/);
    assert.equal(fs.readFileSync(originalFile, 'utf8'), original);
    const descriptor = fs.openSync(join(world.root, 'owned.txt'), 'w');
    fs.writeFileSync(descriptor, 'allowed'); fs.closeSync(descriptor);
    const asyncDescriptor = await new Promise((resolve, reject) => fs.open(join(world.root, 'async-owned.txt'), 'w', (error, fd) => error ? reject(error) : resolve(fd)));
    fs.writeFileSync(asyncDescriptor, 'async allowed'); fs.closeSync(asyncDescriptor);
    const outside = fs.openSync(fileURLToPath(import.meta.url), 'r');
    world.assertHealthy();
    try { assert.throws(() => fs.writeFileSync(outside, 'outside'), /outside isolated root/); } finally { fs.closeSync(outside); }
    assert.throws(() => fs.writeFileSync(descriptor, 'closed'), /outside isolated root/);
    assert.throws(() => fs.writeFileSync(123456, 'unknown'), /outside isolated root/);
  } finally { await world.close(); }
});

test('abort and delayed response are scheduler-owned boundary choices', async () => {
  const world = await SimWorld.create({ replies: [{ text: 'too late', delayMs: 1000 }] });
  try {
    await world.run(async () => {
      const prompt = world.session.prompt('abort this');
      world.scheduler.schedule(() => { void world.session.abort(); }, 10, 'human.abort');
      await prompt;
    });
    assert.equal(world.session.messages.at(-1).stopReason, 'aborted');
    assert.equal(world.scheduler.now - world.scheduler.start, 10);
    assert.equal(world.requests[0].outcome, 'aborted');
    assert.equal(world.requests[0].completedAt, undefined);
    const next = { ...world.requests[0], at: world.scheduler.now + 1, outcome: 'completed', status: 200, completedAt: world.scheduler.now + 1 };
    assert.equal(checkCacheHistory([world.requests[0], next]).assessments[1].hitBlocks, 0);
    assert.equal(world.history.filter(event => event.kind === 'response').at(-1).data.outcome, 'aborted');
    world.assertHealthy();
  } finally { await world.close(); }
});

test('real entries survive tool-set changes; monitor catches corruption', async () => {
  const world = await SimWorld.create({ replies: [{ text: 'first' }, { text: 'second' }] });
  try {
    await world.prompt('one'); const before = structuredClone(world.sessionManager.getEntries());
    await world.prompt('two'); const after = structuredClone(world.sessionManager.getEntries());
    assertEntriesPreserved(before, after);
    after.find(entry => entry.id === before[0].id).type = 'corrupt';
    assert.throws(() => assertEntriesPreserved(before, after), /session-entry-preserved/);
  } finally { await world.close(); }
});

test('recorder exposes validator rejection without fabricating a completed response', async () => {
  const scheduler = new Scheduler(new Entropy(3));
  const provider = new ScriptedProvider({ family: 'anthropic', scheduler, record: () => {}, replies: [] });
  await assert.rejects(provider.respond('https://pi-sim.invalid/v1/messages', { messages: [] }), /request contract failed/);
  assert.equal(provider.requests[0].outcome, 'rejected');
  assert.equal(provider.requests[0].completedAt, undefined);
});

test('request contract rejects orphan tool results and missing required envelopes', () => {
  assert.ok(validateRequest('anthropic', { model: 'synthetic', max_tokens: 1, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'bad' }] }] }).some(issue => issue.property === 'tool-result-join'));
  for (const family of ['anthropic', 'openai-responses', 'openai-completions', 'google', 'vertex', 'bedrock']) assert.ok(validateRequest(family, {}).length > 0);
});

test('raw Bedrock Anthropic endpoint emits binary chunk envelopes; Pi has no raw InvokeModel adapter', async () => {
  const scheduler = new Scheduler(new Entropy(3));
  const provider = new ScriptedProvider({ family: 'bedrock-anthropic', scheduler, record: () => {}, replies: [{ text: 'hello' }] });
  const response = await scheduler.run(() => provider.respond('https://pi-sim.invalid/model/synthetic/invoke-with-response-stream', { anthropic_version: 'bedrock-2023-05-31', max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] }));
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.headers.get('content-type'), 'application/vnd.amazon.eventstream');
  const frameLength = bytes.readUInt32BE(0), headerLength = bytes.readUInt32BE(4);
  const envelope = JSON.parse(bytes.subarray(12 + headerLength, frameLength - 4));
  const event = JSON.parse(Buffer.from(envelope.bytes, 'base64'));
  assert.equal(event.type, 'message_start');
  provider.assertConsumed();
  await assert.rejects(SimWorld.create({ family: 'bedrock-anthropic' }), /unsupported family/);
});
