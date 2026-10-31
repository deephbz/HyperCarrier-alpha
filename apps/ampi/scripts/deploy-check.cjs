#!/usr/bin/env node
require("./stdio-sync.cjs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const steps = [
	["typecheck (tsgo)", ["run", "typecheck"]],
	["build:web", ["run", "build:web"]],
	["fast tests", ["run", "test"]],
];
function run(label, command, args, env = process.env) {
	const start = process.hrtime.bigint();
	const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
	const seconds = Number(process.hrtime.bigint() - start) / 1e9;
	console.log(`[deploy:check] ${label}: ${seconds.toFixed(2)}s`);
	return result.status ?? 1;
}

if (run("preflight", process.execPath, [path.join(__dirname, "test-preflight.cjs")], process.env) !== 0) process.exit(1);
for (const [label, args] of steps) {
	const env = { ...process.env, ...(label === "fast tests" ? { AMPI_PREFLIGHT_DONE: "1" } : {}) };
	if (run(label, "npm", args, env) !== 0) process.exit(1);
}
