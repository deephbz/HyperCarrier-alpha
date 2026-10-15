import assert from 'node:assert/strict';
import test from 'node:test';
import { assertEntriesPreserved } from '@hypercarrier/pi-sim';
import { createWorld, command, until, notices, entriesOf, longText, plans, reportWorld, userTexts, families } from './scenarios.mjs';

for (const boundary of ['abort', 'tree', 'session']) test(`AC5/AC6/AC8: held input recovers across ${boundary}`, async t => {
  const world = await createWorld({ auto: { method: 'summary', preservation: 'none' },
    settings: { compaction: { enabled: false, keepRecentTokens: 32 } },
    replies: [{ text: longText }, { toolCalls: [{ name: 'compaction_plan', arguments: plans }], delayMs: 500 }] });
  try {
    await world.prompt('Original target');
    const target = entriesOf(world, 'message').find(entry => entry.message.role === 'user').id;
    await command(world, 'run');
    world.scheduler.schedule(() => { void world.session.prompt('Held recovery text', { source: 'interactive', streamingBehavior: 'steer' }); }, 10, 'held-before-abort');
    let changed = false, fault;
    world.scheduler.schedule(() => {
      void (async () => {
        await world.session.abort();
        if (boundary === 'tree') await world.session.navigateTree(target, { summarize: false });
        if (boundary === 'session') {
          // Simulated host replacement uses native SessionManager identity/history.
          // The real extension startup hook receives the replacement context.
          world.sessionManager.newSession();
          world.session.agent.reset();
          await world.session.extensionRunner.emit({ type: 'session_start', reason: 'switch' });
        }
        changed = true;
      })().catch(error => { fault = error; changed = true; });
    }, 50, boundary);
    await until(world, () => changed && !world.session.isStreaming, `${boundary} boundary`);
    if (fault) throw fault;
    assert.equal(entriesOf(world, 'compaction').length, 0);
    assert.ok(notices(world).some(text => /surfaced for resubmission/i.test(text)), JSON.stringify(notices(world)));
    assert.ok(!userTexts(world).includes('Held recovery text'));
    const report = await reportWorld(world);
    assert.equal(report.trace.requests.length, 2);
    assert.ok(report.trace.history.some(event => event.kind === 'session.event' && event.data.type === 'agent_end' && event.data.messages.some(message => message.stopReason === 'aborted')));
    t.diagnostic(JSON.stringify({ boundary, pi: report.trace.piVersion, seed: report.trace.seed, ...report.metrics }));
  } finally { await world.close(); }
});

test('AC7/AC8: native tree navigation retains finalized entries and reads old extension records', async () => {
  const world = await createWorld({ replies: [{ text: 'Old branch answer' }, { text: 'Second branch answer' }] });
  try {
    world.sessionManager.appendCustomEntry('auto-compact.budget', { tokens: 70000 });
    world.sessionManager.appendCustomEntry('auto-compact.old-format', { v: 0, text: 'Synthetic legacy state' });
    await world.prompt('Old user goal');
    const target = entriesOf(world, 'message').find(entry => entry.message.role === 'user').id;
    const before = structuredClone(world.sessionManager.getEntries());
    await world.prompt('New user goal');
    await world.run(() => world.session.navigateTree(target, { summarize: false }));
    assertEntriesPreserved(before, world.sessionManager.getEntries());
    assert.equal(world.sessionManager.getBranch().at(-1).id, world.sessionManager.getEntry(target).parentId);
    assert.ok(!world.sessionManager.getBranch().some(entry => entry.message?.role === 'user' && JSON.stringify(entry.message.content).includes('New user goal')));
    await command(world, 'status');
    assert.ok(notices(world).some(text => /70k \(branch override\)/.test(text)));
    await reportWorld(world);
  } finally { await world.close(); }
});

test('AC2: both declared tools reject idle calls without compaction', async () => {
  const world = await createWorld({ replies: [{ toolCalls: [
    { name: 'auto_compact_ready', arguments: {} },
    { name: 'compaction_plan', arguments: plans },
  ] }, { text: 'Idle calls ignored' }] });
  try {
    await world.prompt('Try stale compaction calls');
    assert.equal(entriesOf(world, 'compaction').length, 0);
    const results = world.history.filter(event => event.kind === 'session.event' && event.data.type === 'tool_execution_end');
    assert.equal(results.length, 2);
    for (const result of results) assert.equal(result.data.result.details.status, 'ignored');
    world.assertHealthy();
  } finally { await world.close(); }
});

test('AC4: unsupported background provider selection rejects without a fork or compaction', async () => {
  for (const family of families.filter(family => !['anthropic', 'openai-responses'].includes(family))) {
    const world = await createWorld({ family, auto: { method: 'summary', execution: 'background', preservation: 'none' }, replies: [] });
    try {
      await command(world, 'run');
      assert.equal(world.requests.length, 0, family);
      assert.equal(entriesOf(world, 'compaction').length, 0, family);
      assert.ok(notices(world).some(text => /background does not support/.test(text)), family);
      world.assertHealthy();
    } finally { await world.close(); }
  }
});
