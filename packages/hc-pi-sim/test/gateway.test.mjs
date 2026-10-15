import assert from 'node:assert/strict';
import test from 'node:test';
import { replay, SimWorld, magpieProfile, checkCacheHistory, assertCacheSafe, cacheShape, MAGPIE_SOURCE } from '../src/index.mjs';
import { toolChangeExtension } from './fixtures/tool-change.mjs';

const flags = { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true };
const scenario = (options = {}) => ({ ...magpieProfile(options), seed: 37,
  replies: [{ text: 'first answer' }, { text: 'second answer' }],
  actions: [{ type: 'prompt', text: 'first' }, { type: 'prompt', text: '/activate' }, { type: 'prompt', text: 'second' }],
});
const extensions = { extensionFactories: [toolChangeExtension] };

test('real models.json magpie defaults break prefix; native flags preserve only client structure', async t => {
  const bad = await replay(scenario(), extensions);
  assert.equal(bad.trace.requests.length, 2);
  assert.equal(bad.cache.passed, false);
  assert.equal(bad.cache.verdict, 'fail');
  assert.ok(bad.cache.violations.some(v => v.property === 'stable-cache-prefix' && v.authority === 'policy' && v.evidence === 'documented'));
  assert.equal(bad.trace.requests[0].body.model, 'claude/sim-model');
  assert.match(bad.trace.requests[0].url, /\/v1\/chat\/completions$/);
  assert.equal(bad.trace.requests[0].gateway, 'anthropic');
  const good = await replay(scenario({ compat: flags }), extensions);
  assert.equal(good.cache.structuralPassed, true);
  assert.equal(good.cache.passed, null);
  assert.equal(good.cache.policyPassed, null);
  assert.equal(good.cache.verdict, 'advisory');
  assert.deepEqual(good.trace.requests[0].body.tools, good.trace.requests[1].body.tools);
  assert.ok(good.trace.requests[1].body.messages.some(m => m.role === 'system' && m.tools?.[0]?.function?.name === 'optional'));
  assert.ok(good.cache.advisory.some(a => a.property === 'gateway-native-transition' && a.source === MAGPIE_SOURCE));
  assert.throws(() => assertCacheSafe(good.trace.requests), /cache properties/);
  t.diagnostic(`Pi ${bad.trace.piVersion}; magpie defaults fail; native flags advisory; ${JSON.stringify(good.metrics)}`);
});

test('gateway opt-in is recorded but cannot enable client cache marks on Chat', async () => {
  const result = await replay(scenario({ headers: { 'X-Magpie-Cache-Marks': 'client' } }), extensions);
  assert.equal(result.trace.requests[0].headers['x-magpie-cache-marks'], 'client');
  assert.deepEqual(result.cache.assessments[0].gateway.cacheMarks, { requestedOptIn: true, effect: 'ignored-on-chat', clientMarksHonored: false });
  assert.equal(result.cache.passed, false);
  const body = { tools: [{ type: 'function', function: { name: 'anchor' }, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'system', content: 'instructions' }, { role: 'user', content: 'request' }], cache_control: { ttl: '1h' } };
  const shape = cacheShape('openai-completions', body, { gateway: 'anthropic' });
  assert.equal(shape.markers.length, 0);
  assert.deepEqual(shape.blocks.map(JSON.parse), [{ tool: { function: { name: 'anchor' }, type: 'function' } }, { system: 'instructions' }, { content: 'request', role: 'user' }]);
});

test('real model loader retains provider defaults without injecting native flags', async () => {
  const world = await SimWorld.create(magpieProfile());
  try {
    const model = world.modelRuntime.getModel('magpie', 'claude/sim-model');
    assert.equal(model.compat.sendSessionAffinityHeaders, true);
    assert.equal(model.compat.supportsMidConvoToolAdditions, undefined);
    assert.equal(model.compat.supportsMidConvoSystemMessages, undefined);
    world.assertHealthy();
  } finally { await world.close(); }
});

test('gateway histories replay exactly and generic OpenAI remains advisory', async () => {
  for (const options of [{}, { compat: flags }]) {
    const a = await replay(scenario(options), extensions);
    const b = await replay(scenario(options), extensions);
    assert.deepEqual(a.trace, b.trace);
    assert.deepEqual(a.cache, b.cache);
  }
  const result = await replay(scenario(), extensions);
  const generic = checkCacheHistory(result.trace.requests.map(({ gateway, ...request }) => request));
  assert.equal(generic.passed, true);
  assert.ok(generic.advisory.some(v => v.property === 'stable-cache-prefix'));
});
