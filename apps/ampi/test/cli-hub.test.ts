import "./bound.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { tempHome } from "./helpers.ts";

const BIN = join(import.meta.dirname, "..", "bin", "ampi.mjs");

/** Runs `ampi hub` with its output sent to a 0644 file, as a launcher does, until it reports that it runs. */
async function hubToFile(home: string, args: string[] = []): Promise<{ log: string; output: string }> {
	const log = join(home, "hub.log");
	writeFileSync(log, "", { mode: 0o644 });
	const fd = openSync(log, "a");
	// A Pi-backend hub on a scratch home: no node daemon, and the real herdr is not on PATH.
	const env: NodeJS.ProcessEnv = { HOME: home, AMPI_HOME: home, PI_CODING_AGENT_DIR: join(home, "pi"), AMPI_BACKEND: "pi", AMPI_SELF: "test", PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
	const child = spawn(process.execPath, [BIN, "hub", "--port", "0", "--config", join(home, "hub.json"), ...args], { env, stdio: ["ignore", fd, fd] });
	closeSync(fd);
	try {
		const deadline = Date.now() + 20_000;
		while (!readFileSync(log, "utf8").includes("AmPi is running")) {
			if (child.exitCode !== null) throw new Error(`hub exited ${child.exitCode}: ${readFileSync(log, "utf8")}`);
			if (Date.now() > deadline) throw new Error(`hub did not start: ${readFileSync(log, "utf8")}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		return { log, output: readFileSync(log, "utf8") };
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = new Promise((resolve) => child.once("exit", resolve));
			child.kill("SIGTERM");
			await exited;
		}
	}
}

test("cli hub: redirected output hides the access key and its file becomes owner-only; --rotate-key replaces the key", async () => {
	const home = tempHome();
	const first = await hubToFile(home);
	const key = readFileSync(join(home, "hub.token"), "utf8").trim();
	assert.match(key, /^[0-9a-f]{64}$/);
	assert.doesNotMatch(first.output, /[0-9a-f]{64}/, "no key in a log");
	assert.match(first.output, /\?k=… \(ampi open prints the full link\)/);
	assert.equal(statSync(first.log).mode & 0o777, 0o600);
	assert.equal(statSync(join(home, "hub.token")).mode & 0o777, 0o600);

	const again = await hubToFile(home);
	assert.equal(readFileSync(join(home, "hub.token"), "utf8").trim(), key, "a plain restart keeps the key");
	assert.doesNotMatch(again.output, /[0-9a-f]{64}/);

	const rotated = await hubToFile(home, ["--rotate-key"]);
	const next = readFileSync(join(home, "hub.token"), "utf8").trim();
	assert.match(next, /^[0-9a-f]{64}$/);
	assert.notEqual(next, key, "--rotate-key writes a new key");
	assert.equal(statSync(join(home, "hub.token")).mode & 0o777, 0o600);
	assert.doesNotMatch(rotated.output, /[0-9a-f]{64}/);
});
