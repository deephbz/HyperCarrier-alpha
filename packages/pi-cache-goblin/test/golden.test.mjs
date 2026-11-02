import "./home.mjs";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { headOf, MAX_MARKERS, placeMarkers, prefixHash } from "../src/plan.mjs";

// Captured from the original planner's plan/regression cases plus three held pins.
// Pins serialized JSON values and property order, not object identity, aliasing,
// getters, non-enumerable properties, or thrown errors.
// Regenerate only for an intended planner behavior change; never for a refactor.
// Review the fixture diff with that change and include a live
// verify-pi-cache-goblin receipt. From the repository root, run:
// GOLDEN_UPDATE=1 node --test packages/pi-cache-goblin/test/golden.test.mjs
const fixture = new URL("./fixtures/plan-golden.json", import.meta.url);
const cases = JSON.parse(readFileSync(fixture, "utf8"));
function capture(entry) {
  const plan = { ...entry.plan };
  if (entry.boundaries) plan.globalBoundary = text => entry.boundaries[text];
  const result = placeMarkers(entry.input, plan);
  const head = headOf(entry.input);
  return {
    payload: JSON.stringify(result.payload),
    head: JSON.stringify(head),
    markers: JSON.stringify(result.markers),
    pins: JSON.stringify(result.pins),
    hashes: result.payload.messages.flatMap((message, messageIndex) =>
      message.content.map((_block, blockIndex) => prefixHash(result.payload.messages, { messageIndex, blockIndex }, head))),
  };
}
if (process.env.GOLDEN_UPDATE === "1") {
  for (const entry of cases) Object.assign(entry, capture(entry));
  writeFileSync(fixture, `${JSON.stringify(cases, null, 2)}\n`);
}
for (const [index, entry] of cases.entries()) {
  test(`planner golden ${index}: ${entry.name}`, () => {
    const before = JSON.stringify(entry.input);
    const actual = capture(entry);
    assert.ok(JSON.parse(actual.markers).length <= MAX_MARKERS, `${entry.name}: markers exceed MAX_MARKERS`);
    for (const field of ["payload", "head", "markers", "pins", "hashes"]) {
      assert.deepEqual(actual[field], entry[field], `${entry.name}: ${field} differs`);
    }
    assert.equal(JSON.stringify(entry.input), before, `${entry.name}: input mutated`);
  });
}
