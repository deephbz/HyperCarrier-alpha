import "../test/home.mjs";
import assert from 'node:assert/strict';
import test from 'node:test';
import { composition, profiles } from './scenarios.mjs';

for (const profile of profiles) test(`composed lifecycle: ${profile.name}`, async t => {
  const result = await composition(profile);
  assert.equal(result.trace.requests.length, 4);
  assert.equal(result.trace.entries.filter(entry => entry.type === 'compaction').length, 1);
  assert.ok(result.frames.some(frame => frame.some(line => line.includes('Rarebits ·'))), 'real Rarebit view rendered');
  assert.ok(result.frames.some(frame => frame.some(line => line.includes('compaction'))), 'view retains compaction boundary');
  for (const epoch of result.epochs) {
    assert.equal(epoch.providerPassed, true, JSON.stringify(epoch.violations));
    assert.equal(epoch.structuralPassed, true, JSON.stringify(epoch.violations));
  }
  const documentedFailures = result.epochs.flatMap(e => e.violations).filter(v => v.evidence === 'documented').length;
  const advisoryFailures = result.epochs.flatMap(e => e.violations).filter(v => v.evidence === 'advisory').length;
  const authority = result.epochs[0].assessments[0].prefixPolicy.evidence;
  t.diagnostic(`SIM_REPORT ${JSON.stringify({ lane: 'composition', pi: result.trace.piVersion, family: profile.name,
    authority, documentedFailures, advisoryFailures,
    advisoryNotes: result.epochs.flatMap(e => e.advisory).filter(a => a.property !== 'stable-cache-prefix').length,
    rawEpochBreaks: result.cache.violations.filter(v => v.property === 'stable-cache-prefix').length, ...result.metrics })}`);
});

test('composition mutant gate catches tool and system prefix writers', async () => {
  const profile = profiles.find(p => p.name === 'magpie');
  for (const mutant of ['tool-inventory', 'system-prefix']) {
    const result = await composition(profile, { mutant });
    assert.ok(result.epochs[0].violations.some(v => v.property === 'stable-cache-prefix' && v.sequence === 1), mutant);
    assert.equal(result.epochs[0].policyPassed, false);
  }
});

test('composition replay retains deterministic provider and Session evidence', async () => {
  const profile = profiles.find(p => p.name === 'magpie');
  const a = await composition(profile, { seed: 91 });
  const b = await composition(profile, { seed: 91 });
  assert.deepEqual(a.trace, b.trace);
});
