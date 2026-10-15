import assert from 'node:assert/strict';
import test from 'node:test';
import { checkCacheHistory, magpieProfile } from '@hypercarrier/pi-sim';
import { createWorld, entriesOf } from './scenarios.mjs';

const acTools = ['compaction_plan', 'auto_compact_ready'];
const legacyLoadouts = [[], ['compaction_plan'], acTools];
const routes = [
  { family: 'anthropic' },
  magpieProfile(),
];

test('AC2/AC7: tree navigation restores fixed Auto Compact inventory across profiles and legacy loadouts', async t => {
  for (const route of routes) for (const legacyTools of legacyLoadouts) {
    const profile = route.gateway ? 'magpie' : route.family;
    await t.test(`${profile}, legacy=${legacyTools.length}`, async () => {
    const world = await createWorld({ ...route, replies: [
      { text: 'Legacy branch answer' }, { text: 'Current branch answer' },
      { text: 'After navigation' }, { text: 'After stale call' },
    ] });
    try {
      await world.run(() => world.session.setActiveToolsByName(['anchor', ...legacyTools]));
      await world.prompt('Create legacy branch');
      const oldEntries = structuredClone(world.sessionManager.getEntries());
      const target = entriesOf(world, 'message').find(entry => entry.message.role === 'user').id;

      await world.run(() => world.session.setActiveToolsByName(['anchor', ...acTools]));
      await world.prompt('Create current branch');
      const beforeNavigation = structuredClone(world.sessionManager.getEntries());
      await world.run(() => world.session.navigateTree(target, { summarize: false }));
      assert.deepEqual(
        world.session.getActiveToolNames().filter(name => name !== '__pi_deferred_placeholder__').sort(),
        ['anchor', ...acTools].sort(),
      );
      assert.deepEqual(world.sessionManager.getEntries().filter(entry => oldEntries.some(old => old.id === entry.id)), oldEntries);

      const requestCount = world.requests.length;
      await world.prompt('After navigation');
      const toolsFor = request => request.body.tools;
      const names = request => toolsFor(request)
        .map(tool => tool.function?.name ?? tool.name)
        .filter(name => name !== '__pi_deferred_placeholder__')
        .sort();
      assert.deepEqual(names(world.requests.at(-1)), ['anchor', ...acTools].sort());
      const afterNavigationInventory = toolsFor(world.requests.at(-1));
      assert.deepEqual(names(world.requests.at(-1)), ['anchor', ...acTools].sort());

      await world.prompt('Check stale tools');
      assert.deepEqual(toolsFor(world.requests.at(-1)), afterNavigationInventory);
      if (profile === 'magpie') {
        assert.equal(
          checkCacheHistory(world.requests.slice(-2)).violations.some(item => item.property === 'stable-cache-prefix'),
          false,
        );
      }
      assert.equal(world.requests.length, requestCount + 2);
      await world.run(() => world.session.extensionRunner.emit({ type: 'turn_end' }));
      assert.equal(world.sessionManager.getEntries().filter(entry => entry.type === 'compaction').length, 0);
      assert.ok(beforeNavigation.length < world.sessionManager.getEntries().length);
      world.assertHealthy();
    } finally { await world.close(); }
    });
  }
});
