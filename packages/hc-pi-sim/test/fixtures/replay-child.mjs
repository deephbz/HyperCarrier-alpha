import { SimWorld } from '../../src/index.mjs';
import { toolChangeExtension, safeCompat, mutants } from './tool-change.mjs';
const compat = process.argv[2] === 'bad' ? mutants[0].compat : safeCompat;
const seed = Number(process.argv[3] ?? 17);
const world = await SimWorld.create({ seed, compat, extensionFactories: [toolChangeExtension], replies: [{ text: 'one' }, { text: 'two' }] });
try {
  await world.prompt('first'); await world.prompt('/activate'); await world.advance(1000); await world.prompt('second');
  world.assertHealthy();
  // Only the temporary root differs. UUIDs, entropy and all timestamps remain raw.
  process.stdout.write(JSON.stringify(world.report().trace).split(world.root).join('/sim'));
} finally { await world.close(); }
