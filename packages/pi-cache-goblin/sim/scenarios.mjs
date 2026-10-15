// Own synthetic inputs and independent monitors; never substitute extension algorithms.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SimWorld, cacheShape, checkCacheHistory, assertEntriesPreserved } from '@hypercarrier/pi-sim';
import { createCacheGoblinExtension } from '../src/extension.mjs';
import { markerMutant, oldSystemRuleMutant } from './mutants.mjs';

export const families = ['anthropic', 'openai-responses', 'openai-completions', 'google', 'vertex', 'bedrock'];
export const safeCompat = { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true };
const globalPath = '/synthetic/global/AGENTS.md';
export function fixture({ project = 'a', placements = [], append = false, opaque = false } = {}) {
  return pi => {
    let appended = append;
    pi.on('before_agent_start', event => {
      if (opaque) { event.systemPromptOptions.forceSystemPrompt = 'OPAQUE_SYNTHETIC'; return; }
      Object.assign(event.systemPromptOptions, { forceSystemPrompt: undefined, cwd: `/synthetic/project-${project}`,
        contextFiles: [{ path: globalPath, content: 'GLOBAL_SYNTHETIC: preserve this shared policy.' },
          { path: `/synthetic/project-${project}/AGENTS.md`, content: `PROJECT_${project}: scoped policy.` }],
        ...(appended ? { appendSystemPrompt: `APPENDED_PROJECT_${project}` } : {}) });
    });
    pi.events.on('cache-goblin:placed', data => placements.push(structuredClone(data)));
    pi.registerCommand('sim-pin', { description: 'Capture synthetic point A', handler: async () => pi.events.emit('cache-goblin:pin', { name: 'A' }) });
    pi.registerCommand('sim-unpin', { description: 'Release synthetic point A', handler: async () => pi.events.emit('cache-goblin:unpin', { name: 'A' }) });
    for (const name of ['alpha', 'beta']) pi.registerTool({ name, label: name, description: `Synthetic ${name}`, parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [{ type: 'text', text: name }] }) });
    pi.on('session_start', () => pi.setActiveTools(['alpha']));
    pi.registerCommand('sim-tools', { description: 'Activate a synthetic tool', handler: async () => pi.setActiveTools(['alpha', 'beta']) });
    pi.registerCommand('sim-remove', { description: 'Remove a synthetic tool', handler: async () => pi.setActiveTools(['alpha']) });
    pi.registerCommand('sim-instructions', { description: 'Append synthetic instructions', handler: async () => { appended = true; } });
  };
}
export const goblin = () => createCacheGoblinExtension({ globalPaths: [globalPath] });
export function normalized(value, root) {
  const ids = new Map();
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item !== 'string') return item;
    return item.replaceAll(root, '/sim-home').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, id => {
      if (!ids.has(id)) ids.set(id, `uuid-${ids.size}`); return ids.get(id);
    });
  }));
}
export async function scenario(name, options, run) {
  const placements = [];
  const world = await SimWorld.create({ seed: 37, family: 'anthropic', ...(options.providerEntry ? {} : { compat: safeCompat }),
    replies: [{ text: 'ready' }, { text: 'done' }],
    ...options, extensionFactories: [fixture({ placements, ...options.fixture }), ...(options.withGoblin === false ? [] : [options.mutant === 'old-system-rule'
        ? oldSystemRuleMutant({ globalPaths: [globalPath] }) : goblin()]),
      ...(options.mutant && options.mutant !== 'old-system-rule' ? [markerMutant(options.mutant)] : []), ...(options.factories ?? [])] });
  let report;
  try {
    await run(world, placements);
    world.assertHealthy();
    report = normalized(world.report(), world.root);
  } catch (error) {
    report = normalized(world.report(), world.root); report.failure = { property: error.property ?? name, message: error.message };
    error.simReport = report;
    throw error;
  } finally {
    await world.close();
    if (process.env.HC_PI_SIM_EVIDENCE && report) {
      await mkdir(process.env.HC_PI_SIM_EVIDENCE, { recursive: true });
      await writeFile(join(process.env.HC_PI_SIM_EVIDENCE, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
    }
    if (report) console.log(JSON.stringify({ scenario: name, piVersion: report.trace.piVersion, ...report.metrics }));
  }
  return report;
}
export function property(name, test) {
  try { test(); } catch (error) { error.property = name; throw error; }
}
export function tailTtl(request, ttl) {
  property('G2-runtime-ttl', () => assert.equal(cacheShape('anthropic', request.body).markers.at(-1).ttlMs, ttl === '1h' ? 3600000 : 300000));
}
export function heldPrefix(requests, index = 2) {
  const first = cacheShape('anthropic', requests[0].body);
  const later = cacheShape('anthropic', requests[index].body);
  const end = first.markers.at(-1).end;
  property('G3-held-A', () => {
    assert.deepEqual(later.blocks.slice(0, end), first.blocks.slice(0, end));
    assert.ok(later.markers.some(marker => marker.end === end), 'later request must retain the exact A breakpoint');
    assert.ok(checkCacheHistory(requests.slice(0, index + 1)).assessments[index].hitBlocks >= end, 'A prefix must be structurally reachable');
  });
}
export { assertEntriesPreserved, cacheShape, checkCacheHistory };
