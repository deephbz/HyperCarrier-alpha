import "./bound.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { NODE_RANGE, nodeIsPatched } from "../bin/node-floor.mjs";

test("the Node floor accepts only patched releases on supported lines", () => {
	for (const v of ["22.23.4", "v22.24.0", "24.22.1", "24.30.0", "26.12.1", "27.0.0"]) assert.equal(nodeIsPatched(v), true, v);
	for (const v of ["22.23.3", "22.19.0", "23.11.0", "24.22.0", "25.6.0", "26.12.0", "20.19.0", "x"]) assert.equal(nodeIsPatched(v), false, v);
	assert.equal(nodeIsPatched(process.versions.node), true, "the test runtime itself is patched");
});

test("package.json engines.node states the same range", () => {
	const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
	assert.equal(pkg.engines.node, NODE_RANGE);
});
