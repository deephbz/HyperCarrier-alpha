import "../test/home.mjs";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scenario, cacheShape, checkCacheHistory } from './scenarios.mjs';

test('old system-admission mutant fails stable-cache-prefix on two requests', async () => {
  await scenario('mutant-old-system-rule', { mutant: 'old-system-rule' }, async (world, placements) => {
    await world.prompt('A'); await world.prompt('/sim-tools'); await world.prompt('B');
    assert.equal(placements.length, 1);
    const result = checkCacheHistory(world.requests);
    assert.equal(result.passed, false);
    assert.ok(result.violations.some(item => item.property === 'stable-cache-prefix'));
    assert.equal(world.requests.length, 2);
  });
});

for (const action of ['sim-tools', 'sim-instructions']) test(`native system delta regression: ${action}`, async () => {
  await scenario(`system-delta-${action}`, {}, async (world, placements) => {
    await world.prompt('A'); await world.prompt(`/${action}`); await world.prompt('B');
    const delta = world.requests[1].body.messages.filter(message => message.role === 'system').flatMap(message => message.content);
    assert.ok(delta.length, 'real Pi emitted a system delta');
    assert.ok(delta.some(block => block.type === (action === 'sim-tools' ? 'tool_addition' : 'text')));
    assert.equal(placements.length, 2);
    assert.equal(checkCacheHistory(world.requests).passed, true);
    assert.ok(cacheShape('anthropic', world.requests[1].body).markers.length <= 4);
  });
});

test('native system delta regression: tool removal', async () => {
  await scenario('system-delta-removal', { replies: [{ text: 'A' }, { text: 'B' }, { text: 'C' }] }, async (world, placements) => {
    await world.prompt('A'); await world.prompt('/sim-tools'); await world.prompt('B'); await world.prompt('/sim-remove'); await world.prompt('C');
    const deltas = world.requests[2].body.messages.filter(message => message.role === 'system').flatMap(message => message.content);
    assert.ok(deltas.some(block => block.type === 'tool_removal'));
    assert.equal(placements.length, 3);
    assert.equal(checkCacheHistory(world.requests).passed, true);
    assert.equal(cacheShape('anthropic', world.requests[2].body).issues.length, 0);
  });
});
