import './bound.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-ignore: shared verification helpers are plain ESM.
import { agentPidsFromPS } from '../scripts/verify/live-rows.mjs';

test('agent probe finds PATH and absolute Node bootstraps, excluding unrelated children and other hubs', () => {
 const ps = [
  "  20 7 node -e eval(Buffer.from('bootstrap','base64').toString())",
  "  10 7 /opt/runtime/bin/node -e eval(Buffer.from('bootstrap','base64').toString())",
  "  30 8 /opt/runtime/bin/node -e eval(Buffer.from('bootstrap','base64').toString())",
  '  40 7 node worker.js',
  '  50 7 /opt/runtime/bin/node -e console.log(1)',
  "  60 7 sh -c exec node -e eval(Buffer.from('bootstrap','base64').toString())",
  "  70 7 /opt/runtime/bin/not-node -e eval(Buffer.from('bootstrap','base64').toString())",
 ].join('\n');
 assert.deepEqual(agentPidsFromPS(ps, 7), [10, 20]);
 assert.deepEqual(agentPidsFromPS('', 7), []);
});
