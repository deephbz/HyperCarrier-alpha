import { writeFileSync } from 'node:fs';
import { magpieProfile } from '@hypercarrier/pi-sim';
import { toolTransitions } from './scenarios.mjs';
import { mutants } from './mutants.mjs';

const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const writer = args.includes('--writer') ? value('--writer') : 'ready';
if (!['ready', 'planner'].includes(writer)) throw new Error('writer must be ready or planner');
const mutant = args.includes('--mutant') ? mutants.find(item => item.writer === writer) : undefined;
const report = await toolTransitions({ ...magpieProfile(), writer, mutant: mutant?.install });
const findings = report.cache.violations.filter(item => item.property === 'stable-cache-prefix');
const receipt = { version: 1, scenario: { seed: 37, profile: 'magpie', writer, mutant: mutant?.name },
  piVersion: report.trace.piVersion, requests: report.trace.requests.slice(0, 2), findings: findings.filter(item => item.sequence < 2), metrics: report.metrics };
if (args.includes('--output')) writeFileSync(value('--output'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ property: 'stable-cache-prefix', passed: findings.length === 0, scenario: receipt.scenario,
  piVersion: receipt.piVersion, findings, metrics: receipt.metrics }));
// Never hide a gateway-shaped break behind the generic implicit-cache advisory verdict.
if (findings.length) process.exitCode = 1;
