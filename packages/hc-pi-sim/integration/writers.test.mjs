// Audit the remaining HC request writer at its real provider boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SimWorld, magpieProfile } from '../src/index.mjs';
import { createCacheGoblinExtension } from '../../pi-cache-goblin/src/extension.mjs';
import { toolTransitions } from '../../hc-auto-compact/sim/scenarios.mjs';
import registerBlackmagic from '../../pi-openai-blackmagic-compact/src/extension.mjs';

const profiles = { anthropic: {}, magpie: magpieProfile() };
const prompt = 'Synthetic global policy.\n\n<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="/synthetic/global/AGENTS.md">\nKeep synthetic evidence.\n</project_instructions>\n\n<project_instructions path="/synthetic/project/AGENTS.md">\nVerify this project.\n</project_instructions>\n</project_context>';

for (const [profile, options] of Object.entries(profiles)) {
  test(`Read-only Blackmagic / ${profile}: unsupported route leaves system and tools unchanged`, async () => {
    const w = await SimWorld.create({ ...options, seed: 42, extensionFactories: [registerBlackmagic],
      replies: [{ text: 'first' }, { text: 'second' }] });
    try {
      await w.prompt('First synthetic request.');
      await w.prompt('Second synthetic request.');
      const report = w.report();
      const bodies = report.trace.requests.map(request => request.body);
      assert.equal(bodies.length, 2);
      assert.deepEqual(bodies[0].tools, bodies[1].tools);
      if (profile === 'anthropic') assert.deepEqual(bodies[0].system, bodies[1].system);
      else assert.deepEqual(bodies[0].messages[0], bodies[1].messages[0]);
      assert.deepEqual(report.cache.violations.filter(item => item.property === 'stable-cache-prefix'), []);
      w.assertHealthy();
    } finally { await w.close(); }
  });

  test(`HC writers / ${profile}: Auto Compact selection, readiness and cancellation keep tool declarations`, async () => {
    for (const writer of ['ready', 'planner']) {
      const report = await toolTransitions({ ...options, writer });
      assert.equal(report.trace.requests.length, 3);
      const inventories = report.trace.requests.map(request => request.body.tools);
      assert.deepEqual(inventories[1], inventories[0]);
      assert.deepEqual(inventories[2], inventories[0]);
      assert.deepEqual(report.cache.violations.filter(item => item.property === 'stable-cache-prefix'), []);
    }
  });

  test(`HC writers / ${profile}: Cache Goblin system splitting and TTL selection preserve content`, async () => {
    const w = await SimWorld.create({ ...options, seed: 41, systemPrompt: prompt,
      extensionFactories: [createCacheGoblinExtension({ globalPaths: ['/synthetic/global/AGENTS.md'] })],
      replies: [{ text: 'first' }, { text: 'second' }, { text: 'third' }] });
    try {
      await w.prompt('First synthetic request.');
      await w.prompt('Second synthetic request.');
      await w.run(() => w.session.prompt('/cache 1h'));
      await w.prompt('Third synthetic request.');
      const report = w.report();
      assert.equal(report.trace.requests.length, 3);
      const bodies = report.trace.requests.map(request => request.body);
      if (profile === 'anthropic') {
        const text = body => body.system.map(block => block.text).join('');
        assert.equal(text(bodies[0]), text(bodies[1]));
        assert.equal(text(bodies[1]), text(bodies[2]));
        assert.equal(bodies[0].system.length, 2);
        assert.ok(bodies[0].system.every(block => block.cache_control.ttl === '1h'));
        assert.ok(report.trace.history.some(event => event.kind === 'ui.notify' && event.data.text.includes('rewrites the session prefix')));
      } else {
        assert.equal(bodies[0].messages[0].content, bodies[1].messages[0].content);
        assert.equal(bodies[1].messages[0].content, bodies[2].messages[0].content);
        assert.ok(report.trace.history.some(event => event.kind === 'ui.status' && event.data.value?.includes('unsupported payload')));
      }
      // Cache TTL writes have an explicit cost warning. They do not change text.
      assert.deepEqual(report.cache.violations.filter(item => item.property === 'stable-cache-prefix'), []);
      w.assertHealthy();
    } finally { await w.close(); }
  });
}
