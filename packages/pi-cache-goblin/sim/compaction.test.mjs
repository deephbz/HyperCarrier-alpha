import "../test/home.mjs";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import autoCompact from '../../hc-auto-compact/src/extension.mjs';
import { scenario, cacheShape, checkCacheHistory, assertEntriesPreserved } from './scenarios.mjs';

test('G3: real Auto Compact background fork and post-A keep A; summary installs', async () => {
  await scenario('g3-auto-compact', { factories: [autoCompact], settings: { compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 } }, replies: [
    { text: 'point A', delayMs: 1 },
    { text: JSON.stringify({ summary: 'Synthetic retained goal.', keep: [] }), delayMs: 10000 },
    { text: 'post A', delayMs: 1 },
    { text: 'pickup complete' },
  ] }, async (world, placements) => {
    for (const command of ['method summary', 'preservation none', 'bg', 'run']) await world.prompt(`/auto-compact ${command}`);
    await world.prompt('A');
    await world.prompt('post-A human input');
    const before = structuredClone(world.sessionManager.getEntries());
    await world.advance(10001);
    await world.run(async () => {
      for (let attempts = 0; !world.sessionManager.getEntries().some(entry => entry.type === 'compaction'); attempts++) {
        assert.ok(attempts < 100, 'summary installation did not complete within the bounded scheduler window');
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      await world.session.waitForIdle();
    });
    assertEntriesPreserved(before, world.sessionManager.getEntries());
    const requests = world.requests;
    const anchor = requests.find(request => request.body.messages.some(message => message.content?.some?.(block => block.text === 'A')));
    assert.ok(anchor, 'captured A request exists');
    const shapeA = cacheShape('anthropic', anchor.body), end = shapeA.markers.at(-1).end;
    const fork = requests.find(request => request.body.messages.some(message => message.content?.some?.(block => block.text?.includes('Cover only the captured prefix'))));
    const post = requests.find(request => request.body.messages.some(message => message.content?.some?.(block => block.text === 'post-A human input')));
    assert.ok(fork, 'Auto Compact issued a real fork request'); assert.ok(post, 'post-A human input reached a real request');
    for (const request of [fork, post]) {
      const shape = cacheShape('anthropic', request.body);
      assert.deepEqual(shape.blocks.slice(0, end), shapeA.blocks.slice(0, end));
      assert.ok(shape.markers.some(marker => marker.end === end), 'A breakpoint retained');
    }
    assert.ok(placements.some(placement => placement.pins.some(pin => pin.name === 'auto-compact-A' && pin.status === 'placed')));
    assert.ok(world.sessionManager.getEntries().some(entry => entry.type === 'compaction' && entry.summary.includes('Synthetic retained goal.')), 'real Pi installed the summary');
    const forkIndex = requests.indexOf(fork), postIndex = requests.indexOf(post);
    const verdict = checkCacheHistory(requests);
    assert.ok(verdict.assessments[forkIndex].hitBlocks >= end);
    assert.ok(verdict.assessments[postIndex].hitBlocks >= end);
  });
});
