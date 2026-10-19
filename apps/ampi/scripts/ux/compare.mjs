#!/usr/bin/env node
// Compare two synthetic capture inventories. Emit a receipt; do not alter either map.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) throw new Error('Usage: node compare.mjs before.json after.json');
const [before, after] = await Promise.all([beforePath, afterPath].map(async p => JSON.parse(await readFile(p, 'utf8'))));
assert(before.syntheticOnly && after.syntheticOnly);
const removed = [], added = [];
let preserved = 0;
for (const n of after.nodes) {
  const old = before.nodes.find(x => x.id === n.id);
  const oldElements = new Map((old?.elements ?? []).map(e => [e.key, e]));
  const currentKeys = new Set(n.elements.map(e => e.key));
  for (const e of n.elements) {
    const previous = oldElements.get(e.key);
    if (previous) { assert.equal(e.id, previous.id, n.id + '/' + e.key); preserved++; }
    else added.push({ state: n.id, control: e.id, name: e.name });
  }
  for (const e of old?.elements ?? []) if (!currentKeys.has(e.key)) removed.push({ state: n.id, control: e.id, name: e.name });
  for (const [key, id] of Object.entries(old?.elementIds ?? {})) assert.equal(n.elementIds[key], id, 'Retired registry: ' + n.id);
}
for (const n of before.nodes) if (!after.nodes.some(x => x.id === n.id)) for (const e of n.elements) removed.push({ state: n.id, control: e.id, name: e.name });
console.log(JSON.stringify({ schema: 'ampi-wireflow-delta/1', syntheticOnly: true, beforeSourceRevision: before.sourceRevision, afterSourceRevision: after.sourceRevision, beforeCapturedAt: before.capturedAt, afterCapturedAt: after.capturedAt, limits: 'Visible-control delta includes layout, scroll, demo-clock, and fixture changes. Removed means absent from the captured viewport, not necessarily deleted from source.', preserved, added, removed }, null, 2));
