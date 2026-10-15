import assert from 'node:assert/strict';
import test from 'node:test';
import { replay, SimWorld, checkCacheHistory, explore, fc } from '../src/index.mjs';
import { toolChangeExtension, safeCompat, mutants } from './fixtures/tool-change.mjs';

const actions = [{ type: 'prompt', text: 'first' }, { type: 'prompt', text: '/activate' }, { type: 'advance', ms: 1000 }, { type: 'prompt', text: 'second' }];
const scenario = compat => ({ seed: 37, family: 'anthropic', compat, replies: [{ text: 'first answer' }, { text: 'second answer' }], actions });
const options = { extensionFactories: [toolChangeExtension] };

test('real AgentSession: native tool change preserves prefix; both compat mutants break it', async t => {
  const good = await replay(scenario(safeCompat), options);
  assert.equal(good.trace.requests.length, 2);
  assert.equal(good.cache.passed, true);
  assert.ok(good.cache.assessments[1].hitBlocks > 0);
  assert.deepEqual(good.trace.requests[1].body.tools, good.trace.requests[0].body.tools);
  assert.match(JSON.stringify(good.trace.requests[1].body.messages), /tool_addition/);
  t.diagnostic(`Pi ${good.trace.piVersion}; control ${JSON.stringify(good.metrics)}`);
  for (const mutant of mutants) {
    const bad = await replay(scenario(mutant.compat), options);
    assert.equal(bad.cache.passed, false, mutant.name);
    assert.ok(bad.cache.violations.some(v => v.property === 'stable-cache-prefix'));
    // Minimal witness: two requests with one real activation between them.
    assert.equal(bad.trace.requests.length, 2);
    t.diagnostic(`${mutant.name}: stable-cache-prefix at request 1; seed=${bad.trace.seed}; ${JSON.stringify(bad.metrics)}`);
  }
});

test('same seed exactly replays normalized history, entries, requests and choices', async () => {
  for (const compat of [safeCompat, ...mutants.map(m => m.compat)]) {
    const a = await replay(scenario(compat), options);
    const b = await replay(scenario(compat), options);
    assert.deepEqual(a.trace, b.trace);
  }
});

test('exhaustive capability table: both flags are necessary', async () => {
  for (const supportsMidConvoSystemMessages of [false, true]) for (const supportsMidConvoToolChanges of [false, true]) {
    const report = await replay(scenario({ supportsMidConvoSystemMessages, supportsMidConvoToolChanges }), options);
    assert.equal(report.cache.passed, supportsMidConvoSystemMessages && supportsMidConvoToolChanges);
  }
});

test('all provider families traverse real SDK request and response parsers', async () => {
  for (const family of ['anthropic', 'openai-responses', 'openai-completions', 'google', 'vertex', 'bedrock']) {
    const world = await SimWorld.create({ family, replies: [{ toolCalls: [{ name: 'anchor', arguments: {} }] }, { text: 'finished' }], ...options });
    try {
      await world.prompt('Use the anchor operation.');
      assert.equal(world.requests.length, 2, family);
      assert.equal(world.session.getLastAssistantText(), 'finished', family);
      const calls = world.history.filter(e => e.kind === 'session.event' && e.data.type === 'tool_execution_end');
      assert.equal(calls.length, 1, family);
      assert.equal(calls[0].data.isError, false, family);
      world.assertHealthy();
    } finally { await world.close(); }
  }
});

test('seeded fast-check scenarios shrink with one scheduler', async t => {
  const receipt = await explore(fc.record({ seed: fc.integer({ min: 1, max: 10000 }), delay: fc.integer({ min: 1, max: 2500 }) }), async ({ seed, delay }) => {
    const result = await replay({ ...scenario(safeCompat), seed, replies: [{ text: 'first', delayMs: delay }, { text: 'second', delayMs: delay }] }, options);
    assert.equal(result.cache.passed, true);
    assert.equal(result.metrics.virtualMs, 1000 + delay * 2);
  }, { seed: 1031, numRuns: Number(process.env.HC_PI_SIM_RUNS ?? 8) });
  t.diagnostic(JSON.stringify(receipt));
});

test('scripted HTTP failure uses real provider error handling; endpoint fails closed', async () => {
  const world = await SimWorld.create({ replies: [{ status: 400, error: 'synthetic invalid request' }] });
  try {
    await world.prompt('fail');
    assert.equal(world.requests.length, 1);
    assert.equal(world.session.messages.at(-1).stopReason, 'error');
    assert.match(world.session.messages.at(-1).errorMessage, /synthetic invalid request/);
    world.assertHealthy();
    await assert.rejects(globalThis.fetch('https://external.invalid/'), /network escape/);
    assert.throws(() => world.assertHealthy(), /network escape/);
  } finally { await world.close(); }
});

test('TTL expiry explains prefix change; activation without expiry does not', async () => {
  const result = await replay({ ...scenario({}), actions: actions.map(action => action.type === 'advance' ? { ...action, ms: 300001 } : action) }, options);
  assert.equal(result.cache.passed, true);
  assert.equal(result.cache.assessments[1].expired, true);
  assert.equal(result.cache.assessments[1].hitBlocks, 0);
  assert.equal(checkCacheHistory(result.trace.requests.map(request => ({ ...request, at: 0, completedAt: 0 }))).passed, false);
});
