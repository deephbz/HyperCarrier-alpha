import "../test/home.mjs";
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCacheSafe, explore, fc, magpieProfile } from '@hypercarrier/pi-sim';
import { families, nativeCompat, magpieCompat, toolTransitions, foreground, nativeCompaction, threshold, background, hasPrefixBreak } from './scenarios.mjs';
import { mutants } from './mutants.mjs';

const compactions = report => report.trace.entries.filter(entry => entry.type === 'compaction');
const handoffs = report => report.trace.entries.filter(entry => entry.type === 'custom_message' && entry.customType === 'auto-compact.handoff');
const diagnostic = (t, name, report) => t.diagnostic(JSON.stringify({ scenario: name, pi: report.trace.piVersion, seed: report.trace.seed, family: report.trace.family, authority: report.cache.assessments[0]?.evidence, providerFailures: report.cache.violations.filter(v => v.authority === 'provider').length, policyFailures: report.cache.violations.filter(v => v.authority === 'policy').length, advisoryFailures: report.cache.advisory.length, ...report.metrics }));

test('AC2: real ready activation/deactivation and planner selection keep a fixed prefix', async t => {
  for (const route of [...families.map(family => ({ family })), magpieProfile()]) for (const writer of ['ready', 'planner']) {
    const report = await toolTransitions({ ...route, writer });
    const family = route.gateway ? 'magpie' : route.family;
    assert.equal(report.trace.requests.length, 3);
    const tools = body => body.tools ?? body.toolConfig;
    for (const request of report.trace.requests.slice(1))
      assert.deepEqual(tools(request.body), tools(report.trace.requests[0].body), `${family}/${writer} tool inventory`);
    assert.equal(hasPrefixBreak(report), false, `${family}/${writer}: ${JSON.stringify(report.cache.violations)}`);
    diagnostic(t, writer, report);
  }
});

test('AC2 mutant gate: late ready and planner declarations fail the named prefix property', async t => {
  for (const mutant of mutants) {
    const report = await toolTransitions({ ...magpieProfile(), writer: mutant.writer, mutant: mutant.install });
    assert.ok(hasPrefixBreak(report), mutant.name);
    assert.ok(report.cache.violations.some(v => v.property === 'stable-cache-prefix' && v.sequence === 1));
    assert.equal(report.cache.policyPassed, false);
    assert.throws(() => assertCacheSafe(report.trace.requests), /cache properties failed/);
    diagnostic(t, mutant.name, report);
  }
});

test('AC3/AC5/AC7: foreground summary and keepset install plans and retain held user records', async t => {
  for (const method of ['summary', 'keepset']) for (const held of [false, true]) {
    const report = await foreground({ method, held });
    assert.equal(compactions(report).length, 1);
    assert.match(compactions(report)[0].summary, /Synthetic working state/);
    assert.match(compactions(report)[0].summary, /Original human goal/);
    assert.equal(report.trace.entries.filter(entry => entry.type === 'custom_message' && entry.customType === 'auto-compact.pickup').length, 1);
    if (held) assert.deepEqual(report.users.slice(-2), ['Held first', 'Held second']);
    diagnostic(t, `${method}/held=${held}`, report);
  }
});

test('AC3/AC6: native summary failure installs nothing; explicit retry installs once', async t => {
  for (const fail of [false, true]) {
    const report = await nativeCompaction({ fail });
    assert.equal(compactions(report).length, 1);
    assert.match(compactions(report)[0].summary, /Native state summary/);
    if (fail) assert.ok(report.trace.history.some(event => event.kind === 'ui.notify' && event.data.text.includes('Compaction failed')));
    diagnostic(t, `native/retry=${fail}`, report);
  }
});

test('AC1: exhaustive boundary table uses threshold and Session budget', async t => {
  for (const budget of [10000, 20000]) for (const percent of [89, 90, 91]) {
    const report = await threshold({ budget, input: budget * percent / 100 - 1, delayMs: 30000 });
    assert.equal(handoffs(report).length, percent >= 90 ? 1 : 0);
    assert.equal(report.trace.requests.length, percent >= 90 ? 2 : 1);
    diagnostic(t, `threshold/${budget}/${percent}`, report);
  }
});

test('AC4: background fork success and rejection preserve native history', async t => {
  for (const family of ['anthropic', 'openai-responses']) for (const fail of [false, true]) {
    const report = await background({ family, fail });
    assert.equal(compactions(report).length, fail ? 0 : 1);
    if (!fail) {
      assert.match(compactions(report)[0].summary, /Synthetic working state/);
      // The fork appends instructions after the captured foreground payload.
      const base = report.trace.requests[1].body;
      const fork = report.trace.requests[2].body;
      const field = family === 'anthropic' ? 'messages' : 'input';
      for (const [index, message] of base[field].entries()) {
        assert.equal(fork[field][index].role, message.role);
        assert.deepEqual(fork[field][index].content.slice(0, message.content.length), message.content);
      }
      assert.deepEqual(fork.tools, base.tools);
      assert.deepEqual(fork.system ?? fork.instructions, base.system ?? base.instructions);
    }
    diagnostic(t, `background/fail=${fail}`, report);
  }
});

test('AC9: two seeds exactly replay normalized passing histories', async () => {
  for (const seed of [17, 91]) {
    const options = { ...magpieProfile(), writer: 'planner', seed };
    assert.deepEqual((await toolTransitions(options)).trace, (await toolTransitions(options)).trace);
  }
});

test('AC1/AC9: seeded scenarios check thresholds and shrink failing inputs', async t => {
  const result = await explore(fc.record({ seed: fc.integer({ min: 1, max: 10000 }), budget: fc.integer({ min: 10000, max: 30000 }), percent: fc.integer({ min: 80, max: 99 }), delayMs: fc.integer({ min: 0, max: 60000 }) }), async ({ seed, budget, percent, delayMs }) => {
    const report = await threshold({ seed, budget, input: Math.floor(budget * percent / 100), delayMs });
    assert.equal(handoffs(report).length, percent >= 90 ? 1 : 0);
    if (percent < 90) assertCacheSafe(report.trace.requests);
  }, { seed: 3030, numRuns: Number(process.env.HC_PI_SIM_RUNS ?? 6) });
  t.diagnostic(JSON.stringify(result));
});
