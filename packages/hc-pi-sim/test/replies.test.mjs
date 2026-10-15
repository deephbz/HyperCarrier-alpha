import assert from 'node:assert/strict';
import test from 'node:test';
import { SimWorld, ScriptedProvider, Scheduler, Entropy } from '../src/index.mjs';

test('request-dependent replies preserve raw requests and use shared latency entropy', async () => {
  const observed = [], delays = [];
  const world = await SimWorld.create({ seed: 29, replies: (request, { entropy, now }) => {
    const text = JSON.stringify(request.body);
    observed.push({ sequence: request.sequence, now, text });
    request.body.messages.length = 0; // The script cannot alter the raw evidence.
    const delayMs = 20 + entropy.choose(80, 'fixture.reply'); delays.push(delayMs);
    return { text: text.includes('second question') ? 'second answer' : 'first answer', delayMs };
  } });
  try {
    await world.prompt('first question'); await world.prompt('second question');
    assert.match(JSON.stringify(world.session.messages), /first answer/);
    assert.match(JSON.stringify(world.session.messages), /second answer/);
    assert.equal(world.scheduler.now - world.scheduler.start, delays.reduce((a, b) => a + b));
    assert.deepEqual(observed.map(x => x.sequence), [0, 1]);
    assert.equal(observed[1].now - observed[0].now, delays[0]);
    assert.ok(world.requests.every(request => request.body.messages.length > 0));
    assert.equal(world.history.filter(event => event.kind === 'entropy' && event.data.label === 'fixture.reply').length, 2);
    world.assertHealthy();
  } finally { await world.close(); }
});

test('finite reply functions keep exhausted and unused script checks', async () => {
  const world = await SimWorld.create({ replies: [request => ({ text: `request ${request.sequence}` }), { text: 'unused' }] });
  try {
    await world.prompt('one');
    assert.throws(() => world.assertHealthy(), /1 scripted replies unused/);
    await world.prompt('two'); world.assertHealthy();
    await world.prompt('three');
    assert.throws(() => world.assertHealthy(), /unscripted provider request 2/);
  } finally { await world.close(); }
});

for (const variant of ['missing', 'throw']) test(`dynamic script ${variant} fails closed even when its transport error is caught`, async () => {
  const scheduler = new Scheduler(new Entropy(7));
  const provider = new ScriptedProvider({ family: 'anthropic', scheduler, record: () => {}, replies: () => {
    if (variant === 'throw') throw new Error('fixture script failed');
  } });
  await assert.rejects(scheduler.run(() => provider.respond('https://pi-sim.invalid/v1/messages', {
    model: 'synthetic', max_tokens: 1, messages: [{ role: 'user', content: 'question' }],
  })), variant === 'throw' ? /fixture script failed/ : /unscripted provider request/);
  assert.equal(provider.requests[0].outcome, 'transport-error');
  assert.throws(() => provider.assertConsumed(), /reply script failed/);
});
