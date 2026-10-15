import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SimWorld, magpieProfile, explore, fc, assertEntriesPreserved, normalizeTrace } from '@hypercarrier/pi-sim';
import { registerSystemPromptExportCommand } from '../system-prompt-export.mjs';
import { writeSystemPromptReviewProjection } from '../system-prompt-review.mjs';

const extensionPath = new URL('../index.ts', import.meta.url).pathname;
const schema = { type: 'object', properties: {}, additionalProperties: false };

function transitions(pi) {
  let phase = 'initial';
  for (const name of ['alpha', 'beta']) pi.registerTool({
    name, label: name, description: `Synthetic ${name} operation.`, parameters: schema,
    execute: async () => ({ content: [{ type: 'text', text: 'Synthetic result.' }], details: {} }),
  });
  pi.on('session_start', () => pi.setActiveTools(['alpha']));
  pi.registerCommand('audit-select', { description: 'Synthetic state transition', handler: async (args) => {
    phase = args;
    pi.setActiveTools(args === 'beta' ? ['beta', 'alpha'] : ['alpha']);
  } });
  pi.on('before_agent_start', (event) => ({ systemPrompt: `${event.systemPrompt}\n\nSynthetic phase ${phase}.` }));
  pi.on('before_provider_request', (event) => {
    // A payload-only rewrite is explicitly outside the export contract.
    const payload = structuredClone(event.payload);
    if (Array.isArray(payload.input)) payload.input.push({ role: 'user', content: [{ type: 'input_text', text: 'Synthetic wire-only marker.' }] });
    return payload;
  });
}

function mutantExtension(kind) {
  return (pi) => {
    const proxy = new Proxy(pi, { get(target, name) {
      if (name === 'getActiveTools' && kind === 'stale-tools') return () => ['alpha'];
      if (name === 'registerCommand' && kind === 'stale-prompt') return (name, command) => target.registerCommand(name, {
        ...command, handler: (args, ctx) => command.handler(args, { ...ctx, getSystemPrompt: () => 'Synthetic stale prompt.' }),
      });
      return target[name];
    } });
    registerSystemPromptExportCommand(proxy);
  };
}

function monitor(snapshot, expected) {
  const failures = [];
  if (snapshot.systemPrompt !== expected.prompt || snapshot.systemPrompt.includes('Synthetic wire-only marker.')) failures.push('A1');
  if (JSON.stringify(snapshot.activeTools.map(({ name, description, parameters }) => ({ name, description, parameters }))) !== JSON.stringify(expected.tools)) failures.push('A2');
  return failures;
}

async function run({ seed = 43, family = 'anthropic', selections = ['alpha', 'beta'], mutant } = {}) {
  const replies = selections.map(() => ({ text: 'Synthetic answer.', delayMs: 13 }));
  const world = await SimWorld.create({
    ...(family === 'magpie' ? magpieProfile() : { family }), seed, replies,
    extensionPaths: mutant ? [] : [extensionPath],
    extensionFactories: [transitions, ...(mutant ? [mutantExtension(mutant)] : [])],
  });
  const captures = [];
  const failures = [];
  try {
    for (const [index, selected] of selections.entries()) {
      await world.prompt(`/audit-select ${selected}`);
      await world.advance(60000);
      await world.prompt(`Synthetic turn ${index}.`);
      const expected = { prompt: world.session.systemPrompt, tools: [] };
      const activeNames = world.session.getActiveToolNames();
      const declarations = world.session.getAllTools();
      expected.tools = activeNames.map((name) => {
        const declaration = declarations.find((tool) => tool.name === name);
        return { name, description: declaration.description, parameters: declaration.parameters };
      });
      assert.ok(JSON.stringify(world.requests.at(-1).body).includes(`Synthetic phase ${selected}.`), 'fixture must change the real outgoing prompt');
      assert.deepEqual(activeNames, selected === 'beta' ? ['beta', 'alpha'] : ['alpha']);
      const entries = structuredClone(world.sessionManager.getEntries());
      const requestCount = world.requests.length;
      const relativePath = `.pi/prompt-snapshots/turn-${index}.json`;
      await world.prompt(`/export-system-prompt ${relativePath}`);
      const raw = await readFile(join(world.cwd, relativePath), 'utf8');
      const snapshot = JSON.parse(raw);
      failures.push(...monitor(snapshot, expected));
      assert.equal(world.requests.length, requestCount, 'A3: export must not call a provider');
      assert.deepEqual(world.sessionManager.getEntries(), entries, 'A3: export must not append Session history');
      assertEntriesPreserved(entries, world.sessionManager.getEntries());
      assert.deepEqual(world.session.getActiveToolNames(), activeNames, 'A3: export must not activate a tool');
      for (const earlier of captures) assert.equal(await readFile(earlier.path, 'utf8'), earlier.raw, 'A3: earlier export bytes changed');
      const projection = await world.run(() => writeSystemPromptReviewProjection({ cwd: world.cwd, snapshotPath: relativePath }));
      const duplicate = await world.run(() => writeSystemPromptReviewProjection({ cwd: world.cwd, snapshotPath: relativePath }, { reviewPath: `.pi/prompt-snapshots/repeated-${index}.md` }));
      assert.equal(projection.markdownSha256, duplicate.markdownSha256, 'A4: nondeterministic Markdown');
      assert.equal(projection.htmlSha256, duplicate.htmlSha256, 'A4: nondeterministic HTML');
      captures.push({ path: join(world.cwd, relativePath), raw });
    }
    world.assertHealthy();
    const report = world.report();
    const replayEvidence = normalizeTrace({ requests: world.requests, entries: world.sessionManager.getEntries(),
      choices: world.history.filter((entry) => ['entropy', 'schedule'].includes(entry.kind)),
      snapshots: captures.map(({ raw }) => {
        const { integrity, ...snapshot } = JSON.parse(raw);
        // Hashes commit to the raw temporary-root bytes. The real renderer has
        // validated each hash; semantic replay compares normalized content.
        return snapshot;
      }),
    }, world.root);
    return { failures: [...new Set(failures)], captures: captures.length, report, replayEvidence };
  } finally { await world.close(); }
}

test('A1-A4 live prompt/tool transition table across provider paths', async (t) => {
  for (const family of ['anthropic', 'openai-responses', 'magpie']) {
    for (const selections of [['alpha'], ['alpha', 'beta'], ['beta', 'alpha']]) {
      const result = await run({ family, selections });
      assert.deepEqual(result.failures, [], JSON.stringify({ family, selections, trace: result.report.trace }));
      assert.equal(result.captures, selections.length);
      t.diagnostic(JSON.stringify({ family, piVersion: result.report.trace.piVersion, seed: 43, selections, ...result.report.metrics }));
    }
  }
});

test('A1 active-run capture includes the current prompt override', async () => {
  let world;
  let expected;
  const captureDuringRequest = (pi) => pi.on('before_provider_request', async () => {
    expected = world.session.systemPrompt;
    const entries = structuredClone(world.sessionManager.getEntries());
    await world.session.prompt('/export-system-prompt .pi/prompt-snapshots/active.json');
    assert.deepEqual(world.sessionManager.getEntries(), entries, 'A3: active capture changed history');
  });
  world = await SimWorld.create({ seed: 43, family: 'openai-responses', replies: [{ text: 'Synthetic answer.' }],
    extensionPaths: [extensionPath], extensionFactories: [transitions, captureDuringRequest] });
  try {
    await world.prompt('/audit-select beta');
    await world.prompt('Synthetic active capture.');
    const snapshot = JSON.parse(await readFile(join(world.cwd, '.pi/prompt-snapshots/active.json'), 'utf8'));
    assert.ok(expected.includes('Synthetic phase beta.'));
    assert.equal(snapshot.systemPrompt, expected, 'A1: capture missed the active override');
    assert.equal(world.requests.length, 1, 'A3: capture added provider work');
    world.assertHealthy();
  } finally { await world.close(); }
});

test('two minimal stale-capture mutants fail their named properties', async (t) => {
  for (const [mutant, property] of [['stale-prompt', 'A1'], ['stale-tools', 'A2']]) {
    const witness = { seed: 43, selections: ['beta'] };
    assert.deepEqual((await run(witness)).failures, []);
    const result = await run({ ...witness, mutant });
    assert.deepEqual(result.failures, [property], JSON.stringify(result.report.trace));
    t.diagnostic(JSON.stringify({ mutant, property, ...witness, actions: ['/audit-select beta', 'Synthetic turn 0.', '/export-system-prompt .pi/prompt-snapshots/turn-0.json'] }));
  }
});

test('seeded semantic captures, requests, Session entries and choices replay', async () => {
  for (const mutant of [undefined, 'stale-prompt', 'stale-tools']) {
    const scenario = { seed: 43, selections: ['alpha', 'beta'], mutant };
    const first = await run(scenario);
    const second = await run(scenario);
    assert.deepEqual(first.replayEvidence, second.replayEvidence);
    assert.deepEqual(first.failures, second.failures);
  }
});

test('seeded generated transition histories with shrinking', async (t) => {
  const receipt = await explore(fc.record({
    seed: fc.integer({ min: 1, max: 100000 }),
    selections: fc.array(fc.constantFrom('alpha', 'beta'), { minLength: 1, maxLength: 5 }),
  }), async (scenario) => {
    const result = await run(scenario);
    assert.deepEqual(result.failures, [], JSON.stringify({ scenario, trace: result.report.trace }));
  }, { seed: 20261015, numRuns: Number(process.env.HC_PI_SIM_RUNS ?? 8) });
  t.diagnostic(JSON.stringify(receipt));
});
