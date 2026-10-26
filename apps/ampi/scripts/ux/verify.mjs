#!/usr/bin/env node
// Verify the generated review artifact without opening an AmPi connection.
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { recipes } from './recipes.mjs';
import { fixtureSocket } from './fixtures.mjs';
// Exercise the safety adapter without a network connection.
const forwarded = [], replies = [];
let receive;
fixtureSocket({
  connectToServer: () => ({ send: f => forwarded.push(JSON.parse(f)), onMessage: () => {} }),
  onMessage: fn => { receive = fn; }, send: f => replies.push(JSON.parse(f)),
}, {}, { requests: [] });
receive(JSON.stringify({ t: 'sub', sid: 'test', topic: { kind: 'threads' } }));
receive(JSON.stringify({ t: 'unsub', sid: 'test' }));
for (const t of ['req', 'hub']) for (const op of ['thread.submit', 'thread.create', 'thread.resume', 'thread.close', 'host.add', 'accounts.login', 'unexpected.operation']) {
  receive(JSON.stringify({ t, id: t + op, host: 'devbox', op, args: {} }));
}
assert.deepEqual(forwarded.map(f => f.t), ['sub', 'unsub']);
assert.equal(replies.length, 14);
assert.throws(() => receive(JSON.stringify({ t: 'unknown' })), /Unexpected client frame/);
const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/ux');
const map = JSON.parse(await readFile(join(out, 'map.json'), 'utf8'));
assert.equal(map.syntheticOnly, true);
assert.equal(map.partialRun, false);
assert.equal(map.audit.forwardedMutations, 0);
assert.deepEqual(map.audit.externalRequests, []);
assert.deepEqual(map.audit.pageErrors, []);
assert.deepEqual(map.nodes.map(n => n.id), recipes.map(r => r.id));
if (process.env.UX_COMPARE) {
  const repeat = JSON.parse(await readFile(join(out, process.env.UX_COMPARE), 'utf8'));
  let retained = 0;
  for (const n of repeat.nodes) {
    const old = map.nodes.find(x => x.id === n.id);
    assert(old, n.id);
    for (const e of n.elements) { assert.equal(e.id, old.elementIds[e.key], e.key); retained++; }
    for (const [key, id] of Object.entries(old.elementIds)) assert.equal(n.elementIds[key], id);
  }
  console.log(JSON.stringify({ repeatedStates: repeat.nodes.length, retainedControls: retained, retiredRegistriesPreserved: true }));
}
const ids = new Set(map.nodes.map(n => n.id));
assert.equal(ids.size, recipes.length);
let controls = 0;
for (const n of map.nodes) {
  await access(join(out, n.screenshot));
  const png = await readFile(join(out, n.screenshot));
  assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), n.viewport.width);
  assert.equal(png.readUInt32BE(20), n.viewport.height);
  assert.equal(new Set(Object.values(n.elementIds)).size, Object.values(n.elementIds).length, n.id + ' registry collision');
  assert.equal(new Set(n.elements.map(e => e.id)).size, n.elements.length);
  for (const e of n.elements) {
    assert.equal(n.elementIds[e.key], e.id);
    const b = e.bounds;
    assert(b.x >= 0 && b.y >= 0 && b.width > 0 && b.height > 0);
    assert(b.x + b.width <= n.viewport.width + .2 && b.y + b.height <= n.viewport.height + .2);
    const edges = map.edges.filter(t => t.from === n.id && t.element === e.id);
    assert.equal(edges.length, 1, n.id + '/' + e.id);
    assert(ids.has(edges[0].to));
    if (!e.enabled || e.covered || e.readOnly) assert.equal(edges[0].to, n.id);
    controls++;
  }
}
assert.equal(map.edges.length, controls);
const has = (id, name) => map.nodes.find(n => n.id === id).elements.some(e => e.name === name);
assert(has('S04.a', 'Previous user message'));
assert(has('S04.a', 'Next user message'));
assert(!has('S04.a', 'Refresh'));
assert(has('S04.a', 'Transcript mode: full transcript'));
assert(has('S04.l', 'Transcript mode: conversation only'));
assert(!has('S04.s', 'Dismiss recap'));
assert(has('S04.t', 'Dismiss recap'));
assert(map.nodes.find(n => n.id === 'S04.l').elements.some(e => e.selector.includes('details') && e.tag === 'summary' && /tool call/.test(e.name)));
const checked = map.edges.filter(e => e.evidence.startsWith('browser-checked'));
assert(checked.length >= 9);
// Actual browser assertions against the file:// review surface.
const browser = await chromium.launch({ headless: true, ...(process.env.UX_CHROME_CHANNEL ? { channel: process.env.UX_CHROME_CHANNEL } : {}) });
try {
  const p = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = []; p.on('pageerror', error => errors.push(error.message));
  await p.goto(pathToFileURL(join(out, 'map.html')).href);
  await p.locator('img').evaluateAll(images => Promise.all(images.map(i => i.decode())));
  assert.equal(await p.locator('article.cell').count(), map.nodes.length);
  assert.equal(await p.locator('#arrows .primary').count(), checked.length);
  const hidden = await p.locator('#arrows .secondary').first().evaluate(e => getComputedStyle(e).display);
  assert.equal(hidden, 'none');
  await p.getByRole('button', { name: /^S04.c / }).click();
  await p.getByRole('dialog').waitFor();
  assert.equal(await p.locator('#detail tbody tr').count(), map.nodes.find(n => n.id === 'S04.c').elements.length);
  await p.getByRole('button', { name: 'Close', exact: true }).click();
  await p.locator('#arrows-mode').selectOption('all');
  assert.notEqual(await p.locator('#arrows .secondary').first().evaluate(e => getComputedStyle(e).display), 'none');
  await p.locator('#arrows-mode').selectOption('none');
  assert.equal(await p.locator('#arrows').evaluate(e => getComputedStyle(e).display), 'none');
  await p.getByLabel('Find screen or control').fill('S04.c');
  assert.equal(await p.locator('[data-id="S04.c"]').evaluate(e => e.style.opacity), '1');
  assert.equal(await p.locator('[data-id="S01.a"]').evaluate(e => e.style.opacity), '0.2');
  await p.getByLabel('Grid zoom').fill('60');
  assert.equal(await p.locator('#space').evaluate(e => e.style.zoom), '0.6');
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
console.log(JSON.stringify({ states: ids.size, controls, edges: map.edges.length, checkedTransitions: checked.length, browserChecks: 'passed' }));
