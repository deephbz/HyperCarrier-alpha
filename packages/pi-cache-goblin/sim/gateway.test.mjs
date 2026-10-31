import "../test/home.mjs";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { magpieProfile, assertCacheSafe } from '@hypercarrier/pi-sim';
import { scenario, checkCacheHistory } from './scenarios.mjs';

// Chat is the client leg; Magpie translates it to Messages upstream.
// Native transition flags preserve client structure but do not prove translation.
for (const native of [false, true]) test(`magpie profile: native client transitions=${native}`, async () => {
  await scenario(`magpie-tools-${native}`, magpieProfile({
    compat: native ? { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true } : {},
  }), async (world, placements) => {
    await world.prompt('A'); await world.prompt('/sim-tools'); await world.prompt('B');
    assert.equal(placements.length, 0, 'Goblin owns only recognizable Messages wire payloads');
    const result = checkCacheHistory(world.requests);
    if (native) {
      assert.equal(result.passed, null);
      assert.equal(result.verdict, 'advisory');
      assert.equal(result.structuralPassed, true);
      assert.ok(result.advisory.length > 0, 'unsupported gateway transitions must stay visible');
      assert.throws(() => assertCacheSafe(world.requests), 'advisory must not become a passing gate');
    } else {
      assert.equal(result.passed, false);
      assert.ok(result.violations.some(item => item.property === 'stable-cache-prefix' && item.evidence === 'documented'),
        'default tool checkpoint must fail the documented prefix premise');
    }
  });
});

test('magpie Chat opt-in does not make Goblin placement supported', async () => {
  await scenario('magpie-chat-opt-in', { ...magpieProfile({ headers: { 'X-Magpie-Cache-Marks': 'client' } }), replies: [{ text: 'ok' }] }, async (world, placements) => {
    await world.prompt('/cache 1h'); await world.prompt('A');
    assert.equal(placements.length, 0);
    assert.ok(world.history.some(event => event.kind === 'ui.status' && event.data.value?.includes('unsupported payload')));
    assert.ok(checkCacheHistory(world.requests).assessments[0].gateway.limitations.length > 0);
  });
});
