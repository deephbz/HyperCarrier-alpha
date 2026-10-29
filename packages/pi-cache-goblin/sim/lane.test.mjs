import "../test/home.mjs";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fc, explore } from '@hypercarrier/pi-sim';
import wrongTtlTrace from './traces/wrong-tail-ttl.json' with { type: 'json' };
import droppedPinTrace from './traces/drop-held-pin.json' with { type: 'json' };
import { scenario, families, safeCompat, property, tailTtl, heldPrefix, cacheShape, checkCacheHistory, assertEntriesPreserved } from './scenarios.mjs';

const command = (world, text) => world.prompt(`/${text}`);

test('G1: global prefix shares across Projects; project suffix stays distinct', async () => {
  const records = [];
  for (const project of ['a', 'b']) records.push(await scenario(`g1-${project}`, { fixture: { project }, replies: [{ text: 'ok' }] }, async (world, placements) => {
    await world.prompt('same synthetic question');
    const body = world.requests[0].body;
    const marker = placements[0].markers.find(mark => mark.layer === 'global');
    assert.ok(marker, 'real Pi prompt builder must expose a global boundary');
    const text = body.system.slice(0, marker.system + 1).map(block => block.text).join('');
    assert.ok(text.includes('GLOBAL_SYNTHETIC'));
    assert.ok(!text.includes('PROJECT_'));
    assert.equal(body.system[marker.system].cache_control.ttl, '1h');
  }));
  const a = cacheShape('anthropic', records[0].trace.requests[0].body);
  const b = cacheShape('anthropic', records[1].trace.requests[0].body);
  const end = a.markers[0].end;
  assert.deepEqual(a.blocks.slice(0, end), b.blocks.slice(0, end));
  assert.notDeepEqual(a.blocks, b.blocks);
  const paired = checkCacheHistory([records[0].trace.requests[0], { ...records[1].trace.requests[0], sequence: 1 }]);
  assert.ok(paired.assessments[1].hitBlocks >= end);
});

test('G1: unknown addendum limits global sharing', async () => {
  await scenario('g1-addendum', { fixture: { append: true }, replies: [{ text: 'ok' }] }, async (world, placements) => {
    await world.prompt('synthetic');
    const mark = placements[0].markers.find(mark => mark.layer === 'global');
    const text = world.requests[0].body.system.slice(0, mark.system + 1).map(block => block.text).join('');
    assert.ok(!text.includes('APPENDED_PROJECT_'));
    assert.ok(!text.includes('GLOBAL_SYNTHETIC'));
  });
});

test('opaque custom system prompt stays exact and receives one system marker', async () => {
  await scenario('opaque-system', { fixture: { opaque: true }, systemPrompt: 'OPAQUE_SYNTHETIC', replies: [{ text: 'ok' }] }, async world => {
    await world.prompt('A');
    const body = world.requests[0].body;
    assert.equal(body.system.map(block => block.text).join(''), 'OPAQUE_SYNTHETIC');
    assert.equal(cacheShape('anthropic', body).markers.filter(mark => mark.path.startsWith('system')).length, 1);
  });
});

for (const initial of ['5m', '1h']) for (const selected of ['5m', '1h']) test(`G2: ${initial} -> /cache ${selected}`, async () => {
  await scenario(`g2-${initial}-${selected}`, {}, async world => {
    await command(world, `cache ${initial}`); await world.prompt('A');
    await command(world, `cache ${selected}`); await world.advance(1000); await world.prompt('B');
    tailTtl(world.requests[0], initial); tailTtl(world.requests[1], selected);
    for (const request of world.requests) {
      const shape = cacheShape('anthropic', request.body);
      assert.equal(shape.issues.length, 0); assert.ok(shape.markers.length <= 4);
      assert.ok(shape.markers.filter(mark => mark.path.startsWith('system')).every(mark => mark.ttlMs === 3600000));
    }
    assert.equal(checkCacheHistory(world.requests).passed, true);
  });
});

test('G3: held A stays reachable beyond the 20-block lookback, then unpins', async () => {
  await scenario('g3-held-A', { replies: Array.from({ length: 14 }, () => ({ text: 'ok' })) }, async world => {
    await command(world, 'sim-pin'); await world.prompt('A');
    for (let i = 0; i < 12; i++) await world.prompt(`suffix ${i}`);
    heldPrefix(world.requests, 12);
    await command(world, 'sim-unpin'); await world.prompt('released');
    assert.equal(cacheShape('anthropic', world.requests.at(-1).body).markers.length, 3);
  });
});

for (const family of families.filter(family => family !== 'anthropic')) test(`provider scope: ${family} request is unchanged`, async () => {
  const reports = [];
  for (const withGoblin of [false, true]) reports.push(await scenario(`scope-${family}-${withGoblin}`, { family, withGoblin }, async (world, placements) => {
    if (withGoblin) await command(world, 'cache 1h');
    await world.prompt('A'); await world.advance(1000); await world.prompt('B');
    assert.equal(placements.length, 0);
    const verdict = checkCacheHistory(world.requests);
    assert.equal(verdict.passed, true); assert.equal(verdict.advisory.length, 0);
  }));
  assert.deepEqual(reports[0].trace.requests.map(request => request.body), reports[1].trace.requests.map(request => request.body));
});

for (const compat of [safeCompat, { ...safeCompat, supportsMidConvoToolChanges: false }]) test(`tool transition: native=${compat.supportsMidConvoToolChanges}`, async () => {
  await scenario(`tool-transition-${compat.supportsMidConvoToolChanges}`, { compat }, async world => {
    await world.prompt('A'); await command(world, 'sim-tools'); await world.prompt('B');
    const verdict = checkCacheHistory(world.requests);
    assert.equal(verdict.passed, compat.supportsMidConvoToolChanges);
    if (!verdict.passed) assert.ok(verdict.violations.some(v => v.property === 'stable-cache-prefix'));
  });
});

test('branch navigation discards stale pin without editing earlier entries', async () => {
  await scenario('branch', { replies: [{ text: 'ok' }, { text: 'ok' }, { text: 'branch' }] }, async (world, placements) => {
    await world.prompt('before A'); await command(world, 'sim-pin'); await world.prompt('A');
    const before = structuredClone(world.sessionManager.getEntries());
    const target = before.find(entry => entry.type === 'message' && entry.message.role === 'assistant');
    await world.run(() => world.session.navigateTree(target.id)); await world.prompt('different branch');
    assertEntriesPreserved(before, world.sessionManager.getEntries());
    assert.ok(!placements.at(-1).markers.some(mark => mark.layer === 'pin'));
    const result = checkCacheHistory(world.requests);
    assert.equal(result.passed, true);
    assert.ok(result.assessments[2].hitBlocks >= cacheShape('anthropic', world.requests[0].body).markers.at(-1).end,
      'revisited branch must reuse its own live earlier prefix');
  });
});

test('expiry distinguishes 5m tail from 1h system and full expiry', async () => {
  await scenario('expiry', { replies: Array.from({ length: 3 }, () => ({ text: 'ok' })) }, async world => {
    await world.prompt('A'); await world.advance(300001); await world.prompt('B');
    const second = checkCacheHistory(world.requests).assessments[1];
    const systemEnd = cacheShape('anthropic', world.requests[0].body).markers.filter(mark => mark.path.startsWith('system')).at(-1).end;
    assert.equal(second.hitBlocks, systemEnd, 'expired tail must leave only the live one-hour system prefix');
    await world.advance(3600001); await world.prompt('C');
    assert.equal(checkCacheHistory(world.requests).assessments[2].expired, true);
  });
});

test('mutant gate: wrong tail TTL fails G2 with one request', async () => {
  await assert.rejects(scenario('mutant-wrong-tail-ttl', wrongTtlTrace, async world => {
    for (const action of wrongTtlTrace.actions) await world.prompt(action.text);
    tailTtl(world.requests[0], '5m');
  }), error => error.property === wrongTtlTrace.property && error.simReport.trace.requests.length === 1);
});

test('mutant gate: missing held marker fails G3 with two requests', async () => {
  await assert.rejects(scenario('mutant-drop-held-pin', droppedPinTrace, async world => {
    for (const action of droppedPinTrace.actions) await world.prompt(action.text);
    heldPrefix(world.requests, 1);
  }), error => error.property === droppedPinTrace.property && error.simReport.trace.requests.length === 2);
});

test('seeded generated TTL, elapsed time, and pin scenarios', async () => {
  await explore(fc.record({ ttl: fc.constantFrom('5m', '1h'), elapsed: fc.integer({ min: 0, max: 3600001 }), pin: fc.boolean() }), async input => {
    await scenario(`generated-${input.ttl}-${input.elapsed}-${input.pin}`, { seed: 291 }, async world => {
      await command(world, `cache ${input.ttl}`); if (input.pin) await command(world, 'sim-pin');
      await world.prompt('A'); await world.advance(input.elapsed); await world.prompt('B');
      tailTtl(world.requests[1], input.ttl);
      property('marker-legality', () => assert.equal(checkCacheHistory(world.requests).passed, true));
      if (input.pin && input.elapsed < (input.ttl === '1h' ? 3600000 : 300000)) heldPrefix(world.requests, 1);
    });
  }, { seed: 291, numRuns: Number(process.env.HC_PI_SIM_RUNS ?? 8) });
});

for (const seed of [71, 9183]) test(`seed ${seed} replays request and session history`, async () => {
  const run = async world => { await command(world, 'sim-pin'); await world.prompt('A'); await world.advance(1700); await world.prompt('B'); };
  const first = await scenario(`replay-${seed}-a`, { seed }, run);
  const second = await scenario(`replay-${seed}-b`, { seed }, run);
  assert.deepEqual(first.trace, second.trace);
});
