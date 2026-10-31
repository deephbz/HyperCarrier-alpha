import './bound.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-ignore: shared verification helpers are plain ESM.
import { agentPidsFromPS, linkWatch } from '../scripts/verify/live-rows.mjs';

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

// The live outage: after a pin bump without prepare, both durable links stayed in the hello phase while the Pi link
// connected, and the smoke still passed. Row l judges each link against the old hub's list.
const STALE = "This hub cannot check the node's build: Run npm run prepare.";
const up = (link: string) => ({ id: link.split('#')[0], link, status: 'connected' });
const down = (link: string, error: string, errorClass?: string) => ({ id: link.split('#')[0], link, status: 'disconnected', error, ...(errorClass ? { errorClass } : {}) });
const hello = (link: string, error?: string, errorClass?: string) => ({ id: link.split('#')[0], link, status: 'connecting', phase: 'hello', ...(error ? { error, errorClass } : {}) });

test('link row: a link connected before the restart that never reconnects fails, named with its state and error', () => {
 const watch = linkWatch([up('h1#pi'), up('h1#durable'), up('h2#durable')]);
 watch.sample([up('h1#pi'), hello('h1#durable'), hello('h2#durable', 'ssh failed (255).', 'reachability')]);
 watch.sample([up('h1#pi'), hello('h1#durable'), hello('h2#durable', 'ssh failed (255).', 'reachability')]);
 assert.equal(watch.count, 3);
 assert.deepEqual(watch.failed, [
  'h1#durable connecting/hello (connected before the restart)',
  'h2#durable connecting/hello: ssh failed (255). (connected before the restart)',
 ]);
 watch.sample([{ ...up('h1#pi'), status: 'disconnected', error: 'later drop', errorClass: 'reachability' }, up('h1#durable'), up('h2#durable')]);
 assert.deepEqual(watch.failed, [], 'a link that reached connected once counts; the window asks for reach');
});

test('link row: a build failure fails whatever the link was before, also when it was stale before the restart', () => {
 const watch = linkWatch([up('h1#pi'), down('h1#durable', STALE, 'build')]);
 watch.sample([up('h1#pi'), down('h1#durable', STALE, 'build')]);
 assert.deepEqual(watch.failed, [`h1#durable disconnected: ${STALE} (build failure)`]);
 const late = linkWatch([up('h1#durable')]);
 late.sample([up('h1#durable')]);
 late.sample([down('h1#durable', STALE, 'build')]);
 assert.deepEqual(late.failed, [`h1#durable disconnected: ${STALE} (build failure)`], 'a link that ends in a build failure fails though it connected');
 const blind = linkWatch(null);
 blind.sample([hello('h1#durable', STALE, 'build')]);
 assert.deepEqual(blind.failed, [`h1#durable connecting/hello: ${STALE} (build failure)`], 'without a list from the old hub, build failures still fail');
});

test('link row: a Host offline before and after the restart passes with a note; a new link must connect', () => {
 const watch = linkWatch([up('h1#pi'), down('h2#pi', 'ssh failed (255).', 'reachability'), hello('h2#durable', 'ssh failed (255).', 'reachability')]);
 watch.sample([up('h1#pi'), down('h2#pi', 'ssh failed (255).', 'reachability'), down('h2#durable', 'ssh failed (255).'), hello('box#durable', 'ssh failed (255).', 'reachability')]);
 assert.deepEqual(watch.failed, ['box#durable connecting/hello: ssh failed (255). (new link)']);
 assert.deepEqual(watch.notes, [
  'h2#pi disconnected: ssh failed (255). (not connected before the restart either)',
  'h2#durable disconnected: ssh failed (255). (not connected before the restart either)',
 ]);
 const blind = linkWatch(null);
 blind.sample([down('h2#durable', 'ssh failed (255).', 'reachability')]);
 assert.deepEqual([blind.failed, blind.notes], [[], ['h2#durable disconnected: ssh failed (255). (no list from the old hub)']]);
});

test('link row: a link connected before that the new hub does not list fails', () => {
 const watch = linkWatch([up('h1#pi'), up('h1#durable')]);
 watch.sample([up('h1#pi')]);
 assert.deepEqual(watch.failed, ['h1#durable not listed after the restart (connected before)']);
});

test('link row: a reachability failure that clears in the window passes, as a cache lock the old hub still holds', () => {
 const watch = linkWatch([up('h1#pi')]);
 watch.sample([down('h1#pi', 'Host cache unavailable: Another AmPi hub (pid 7) writes /x, which this hub needs for Pi Host h1.', 'reachability')]);
 watch.sample([up('h1#pi')]);
 assert.deepEqual([watch.failed, watch.notes], [[], []]);
});
