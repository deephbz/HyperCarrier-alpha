import fc from 'fast-check';
import { SimWorld } from './world.mjs';
export { fc };

// Alpha-rename Pi's opaque UUID identities, retaining every join and all semantic values.
// Pi UUIDv7 has a process-global monotonic counter. Same-process worlds cannot reset it.
// The raw trace remains available separately. Fresh-process replays also test raw identity stability.
export function normalizeTrace(trace, root) {
  const ids = new Map();
  const normalizeString = value => {
    let result = root ? value.split(root).join('/sim') : value;
    result = result.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, id => {
      if (!ids.has(id)) ids.set(id, `uuid-${ids.size + 1}`);
      return ids.get(id);
    });
    return result;
  };
  const walk = value => typeof value === 'string' ? normalizeString(value) : Array.isArray(value) ? value.map(walk)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walk(child)])) : value;
  return walk(trace);
}

export async function replay(scenario, options = {}) {
  const { actions = [], ...config } = scenario;
  const world = await SimWorld.create({ ...config, ...options });
  try {
    for (const action of actions) {
      if (action.type === 'prompt') await world.prompt(action.text, action.options);
      else if (action.type === 'advance') await world.advance(action.ms);
      else throw new Error(`unknown replay action: ${action.type}`);
    }
    world.assertHealthy();
    const report = world.report();
    return { ...report, trace: normalizeTrace(report.trace, world.root) };
  } catch (error) {
    error.replay = scenario;
    error.trace = normalizeTrace(world.report().trace, world.root);
    throw error;
  } finally { await world.close(); }
}

export async function explore(arbitrary, run, { seed = 1, numRuns = 20, path, ...options } = {}) {
  // fast-check reports the minimized counterexample and seed/path; no second scheduler.
  const result = await fc.check(fc.asyncProperty(arbitrary, run), { seed, numRuns, path, ...options });
  if (result.failed) {
    const error = new Error(`simulation counterexample seed=${result.seed} path=${result.counterexamplePath}: ${JSON.stringify(result.counterexample)}`);
    error.result = result; throw error;
  }
  return { seed: result.seed, numRuns: result.numRuns, numShrinks: result.numShrinks };
}
