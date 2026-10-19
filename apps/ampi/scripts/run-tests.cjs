#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const lane = process.argv[2] ?? "fast";
const concurrency = Number(process.env.AMPI_TEST_CONCURRENCY ?? 4);
if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
	console.error(`Invalid AMPI_TEST_CONCURRENCY: ${process.env.AMPI_TEST_CONCURRENCY}`);
	process.exit(2);
}
if (!new Set(["fast", "full", "exhaustiveOnly"]).has(lane)) {
	console.error(`Unknown AmPi test lane: ${lane}`);
	process.exit(2);
}
if (process.env.AMPI_PREFLIGHT_DONE !== "1") {
	const preflight = spawnSync(process.execPath, [path.join(__dirname, "test-preflight.cjs")], { cwd: path.resolve(root, "../.."), stdio: "inherit" });
	if (preflight.status !== 0) process.exit(preflight.status ?? 1);
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, "test-lanes.json"), "utf8"));
const files = lane === "full" ? [...manifest.fast, ...manifest.exhaustiveOnly] : manifest[lane];
if (files.length === 0) process.exit(0);
const args = ["--test", `--test-concurrency=${concurrency}`, "--test-reporter=spec", ...files.map((file) => path.join(root, "test", file))];
const isolatedHome = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "ampi-test-runner-"));
const env = { ...process.env, PI_CODING_AGENT_DIR: path.join(isolatedHome, ".pi", "agent"), GIT_CONFIG_GLOBAL: "/dev/null" };
fs.mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true });
const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit" });
fs.rmSync(isolatedHome, { recursive: true, force: true });
process.exit(result.status ?? 1);
