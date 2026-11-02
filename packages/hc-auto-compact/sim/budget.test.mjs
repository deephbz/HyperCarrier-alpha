import "../test/home.mjs";
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { Type } from 'typebox';
import { SimWorld } from '@hypercarrier/pi-sim';
import registerAutoCompact from '../src/extension.mjs';

test('AC10: the budget slot shows each response usage and the current budget while the turn runs', async () => {
  // A tool runs after its assistant message ends and before turn_end. It records the slot it sees then.
  const seen = [];
  const probe = { toolCalls: [{ name: 'probe', arguments: {} }] };
  const world = await SimWorld.create({ seed: 37, extensionFactories: [pi => {
    let slot;
    pi.events.on('hc.hud.slot', next => { if (next.key === 'context.budget') slot = next; });
    pi.registerTool({ name: 'probe', label: 'Probe', description: 'Synthetic budget probe',
      parameters: Type.Object({}), async execute() { seen.push(slot?.value ?? null); return { content: [{ type: 'text', text: 'probed' }] }; } });
    registerAutoCompact(pi);
  }], replies: [
    { ...probe, usage: { input: 50_000, output: 8 } }, { text: 'First done', usage: { input: 50_100 } },
    { ...probe, usage: { input: 70_000, output: 8 } }, { text: 'Second done', usage: { input: 70_100 } },
    { ...probe, usage: { input: 90_000, output: 8 } }, { text: 'Third done', usage: { input: 90_100 } },
  ] });
  const settings = auto => writeFileSync(join(world.agentDir, 'settings.json'), JSON.stringify({ auto_compact: { method: 'native', ...auto } }));
  try {
    settings({ budget_tokens: 100_000 });
    await world.run(() => world.session.extensionRunner.emit({ type: 'session_start' }));
    await world.prompt('First goal');
    // An edit outside this Session, then the next prompt.
    settings({ budget_tokens: 150_000 });
    await world.prompt('Second goal');
    await world.prompt('/auto-compact budget 180k');
    await world.prompt('Third goal');
    assert.deepEqual(seen.map(value => [value?.used, value?.limit]), [[50_008, 100_000], [70_008, 150_000], [90_008, 180_000]]);
  } finally { await world.close(); }
});
