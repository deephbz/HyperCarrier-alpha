#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "test-lanes.json"), "utf8"));
if (manifest.version !== 1 || !Array.isArray(manifest.fast) || !Array.isArray(manifest.exhaustiveOnly)) throw new Error("invalid test-lanes.json");
const actual = fs.readdirSync(path.join(root, "test")).filter((file) => file.endsWith(".test.ts")).sort();
const assigned = [...manifest.fast, ...manifest.exhaustiveOnly];
const duplicates = assigned.filter((file, index) => assigned.indexOf(file) !== index);
const missing = actual.filter((file) => !assigned.includes(file));
const unknown = assigned.filter((file) => !actual.includes(file));
// `costs` hints balance the CI shards (scripts/run-tests.cjs --shard); a hint for a file outside the lanes is stale.
const costs = manifest.costs ?? {};
const staleCosts = Object.keys(costs).filter((file) => !assigned.includes(file) || !(Number(costs[file]) > 0));
// test/bound.ts bounds a bare `node --test <file>` run only when the file imports it.
const unbounded = actual.filter((file) => !/^import (["'])\.\/bound\.ts\1;$/m.test(fs.readFileSync(path.join(root, "test", file), "utf8")));
if (duplicates.length || missing.length || unknown.length || unbounded.length || staleCosts.length) {
	console.error(`Test lane closure failed: ${JSON.stringify({ duplicates, missing, unknown, unbounded, staleCosts })}`);
	process.exit(1);
}
console.log(`Test lanes closed: ${manifest.fast.length} fast, ${manifest.exhaustiveOnly.length} exhaustive-only.`);
