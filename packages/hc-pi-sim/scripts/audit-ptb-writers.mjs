// Read-only PTB probe. Do not use this script to launch a Team or a process.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SimWorld, magpieProfile, normalizeTrace } from '../src/index.mjs';

const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const profile = args.includes('--profile') ? value('--profile') : 'magpie';
if (!['anthropic', 'magpie'].includes(profile)) throw new Error('profile must be anthropic or magpie');
// Use the real Pi SDK's TypeScript loader dependency before the host guard starts.
const require = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
const { createJiti } = require('jiti');
const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
const ptb = await jiti.import(fileURLToPath(new URL('../../pi-team-bright/extensions/index.ts', import.meta.url)), { default: true });
const writers = [];
let phase = 'startup';
const world = await SimWorld.create({ seed: 43,
  ...(profile === 'magpie' ? magpieProfile({ model: { reasoning: true } }) : { model: { reasoning: true } }),
  extensionFactories: [pi => {
    // No Team exists. Exercise the real unbound Worker adapter without launches.
    process.env.PI_AGENT_NAME = 'synthetic-worker';
    ptb(new Proxy(pi, { get(target, key) {
      if (key === 'setActiveTools' || key === 'registerTool') return (...values) => {
        writers.push({ phase, writer: key, tools: key === 'registerTool' ? [values[0].name] : values[0] });
        return target[key](...values);
      };
      const member = target[key];
      return typeof member === 'function' ? member.bind(target) : member;
    } }));
  }], replies: [{ text: 'First synthetic answer.' }, { text: 'Second synthetic answer.' }] });
let receipt;
try {
  phase = 'first-turn';
  await world.prompt('First synthetic request.');
  phase = 'thinking-change';
  world.session.setThinkingLevel('low');
  await world.prompt('Second synthetic request.');
  const report = world.report();
  receipt = normalizeTrace({ version: 1, source: 'pi-team-bright@9c7dd67037b8b238e547309ac912784ee3aedf05',
    profile, piVersion: report.trace.piVersion, seed: 43,
    scenario: ['unbound Worker startup', 'prompt', 'thinking off -> low', 'prompt'],
    writers, requests: report.trace.requests, findings: report.cache.violations,
    hostViolations: world.hostViolations,
    qualification: 'Request-level evidence only. PTB process probes are rejected by the host guard. No bound Team or process lifecycle is simulated.' }, world.root);
} finally { await world.close(); }
if (args.includes('--output')) writeFileSync(value('--output'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ profile, piVersion: receipt.piVersion,
  prefixFindings: receipt.findings.filter(item => item.property === 'stable-cache-prefix'),
  hostViolations: receipt.hostViolations, writers }));
