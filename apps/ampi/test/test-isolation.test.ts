import "./bound.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");

test("test isolation: an unbootstrapped node or Pi reader refuses before reading host configuration", { timeout: 8000 }, () => {
	const home = mkdtempSync(join(tmpdir(), "ampi-unbootstrapped-"));
	const file = join(home, "missing.test.mjs");
	writeFileSync(file, `import assert from "node:assert/strict";
import { test } from "node:test";
import { NodeRuntime } from ${JSON.stringify(join(root, "src/node/runtime.ts"))};
import { readPiResources } from ${JSON.stringify(join(root, "src/node/pi-config.ts"))};
import { openModels } from ${JSON.stringify(join(root, "src/node/models.ts"))};
test("refuses missing isolation", () => {
 for (const read of [() => new NodeRuntime(), () => readPiResources(process.env.HOME), () => openModels()])
  assert.throws(read, /AmPi test isolation is missing/);
});\n`);
	try {
		const run = spawnSync(process.execPath, ["--test", file], { encoding: "utf8", timeout: 7000,
			env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent") } });
		assert.equal(run.status, 0, run.stdout + run.stderr);
	} finally { rmSync(home, { recursive: true, force: true }); }
});

for (const mode of ["direct", "runner"]) test(`test isolation: ${mode} Team test ignores a foreign HOME and never requests its real-provider role`, { timeout: 40_000 }, async () => {
	const home = mkdtempSync(join(tmpdir(), "ampi-foreign-home-"));
	const agent = join(home, ".pi", "agent"), receipt = join(home, "provider-request");
	mkdirSync(agent, { recursive: true });
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ pi_team_bright: {
		default_model_role: "default-worker",
		model_roles: { "default-worker": { model: "openai/gpt-4o", thinking: "off", use: "Synthetic incident fixture" } },
	} }));
	// Even if the tripwire fails, this synthetic credential can address only a closed loopback port.
	writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { openai: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "synthetic-test-key" } } }));
	const tripwire = join(home, "tripwire.mjs");
	writeFileSync(tripwire, `import { writeFileSync } from "node:fs";\nglobalThis.fetch = () => { writeFileSync(${JSON.stringify(receipt)}, "provider request attempted"); process.exit(79); };\n`);
	const args = mode === "direct" ? ["--test", "test/team.test.ts"] : ["scripts/run-tests.cjs", "test/team.test.ts"];
	const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: {
		PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agent,
		NODE_OPTIONS: `--import=${tripwire}`, AMPI_PREFLIGHT_DONE: "1", AMPI_TEST_CONCURRENCY: "1", AMPI_TEST_FILE_TIMEOUT_MS: "30000",
	} });
	let output = "";
	child.stdout.on("data", (chunk) => { output += chunk; });
	child.stderr.on("data", (chunk) => { output += chunk; });
	// The bounds detect a hang, not speed: team.test.ts takes about 8 s on a hosted Linux runner.
	const deadline = setTimeout(() => child.kill("SIGKILL"), 35_000);
	try {
		const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
		assert.equal(existsSync(receipt), false, "a Team Worker reached the provider transport from inherited Pi settings");
		assert.equal(code, 0, output);
		assert.match(output, /pass [1-9]\d*/);
		assert.match(readFileSync(join(agent, "settings.json"), "utf8"), /default-worker/, "the foreign home stays untouched");
	} finally { clearTimeout(deadline); child.kill("SIGKILL"); rmSync(home, { recursive: true, force: true }); }
});
