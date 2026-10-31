import "./bound.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { tempHome } from "./helpers.ts";

const BIN = join(import.meta.dirname, "..", "bin", "ampi.mjs");

// A hub on a scratch home: the real herdr is not on PATH. This machine's durable node starts in the scratch home.
const hubEnv = (home: string): NodeJS.ProcessEnv => ({ HOME: home, AMPI_HOME: home, PI_CODING_AGENT_DIR: join(home, "pi"), AMPI_SELF: "test", PATH: `${dirname(process.execPath)}:/usr/bin:/bin` });

/**
 * The node outlives the hub by design, and every hub on a home shares that home's one node. Stops it when the test
 * ends, and fails the test when it does not exit. A later hook for the same home finds no node and returns.
 */
function stopNodeAfter(t: TestContext, home: string): void {
	t.after(async () => {
		const file = join(home, "node.pid");
		if (!existsSync(file)) return;
		const pid = Number(readFileSync(file, "utf8").trim());
		const alive = () => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		if (!alive()) return;
		process.kill(pid, "SIGTERM");
		const deadline = Date.now() + 10_000;
		while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
		if (!alive()) return;
		process.kill(pid, "SIGKILL");
		throw new Error(`the node (pid ${pid}) on ${home} did not exit within 10 s of SIGTERM`);
	});
}

/**
 * Runs `ampi hub` with its output sent to a 0644 file, as a launcher does, until it reports that it runs; then runs
 * `during` against the running hub and stops it. The node that the hub starts stops when the test `t` ends.
 */
async function hubToFile(t: TestContext, home: string, args: string[] = [], during?: (pid: number) => void, config = join(home, "hub.json")): Promise<{ log: string; output: string }> {
	stopNodeAfter(t, home);
	const log = join(home, "hub.log");
	writeFileSync(log, "", { mode: 0o644 });
	const fd = openSync(log, "a");
	const child = spawn(process.execPath, [BIN, "hub", "--port", "0", "--config", config, ...args], { env: hubEnv(home), stdio: ["ignore", fd, fd] });
	closeSync(fd);
	try {
		const deadline = Date.now() + 20_000;
		while (!readFileSync(log, "utf8").includes("AmPi is running")) {
			if (child.exitCode !== null) throw new Error(`hub exited ${child.exitCode}: ${readFileSync(log, "utf8")}`);
			if (Date.now() > deadline) throw new Error(`hub did not start: ${readFileSync(log, "utf8")}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		// This machine's durable node starts with the hub. Wait until it listens, so the next hub reuses it.
		while (!(existsSync(join(home, "node.log")) && readFileSync(join(home, "node.log"), "utf8").includes("listening on"))) {
			if (Date.now() > deadline) throw new Error(`the node did not start: ${readFileSync(join(home, "node.log"), "utf8")}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		during?.(child.pid!);
		return { log, output: readFileSync(log, "utf8") };
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = new Promise((resolve) => child.once("exit", resolve));
			child.kill("SIGTERM");
			await exited;
		}
	}
}

test("cli hub: redirected output hides the access key and its file becomes owner-only; --rotate-key replaces the key", async (t) => {
	const home = tempHome();
	const first = await hubToFile(t, home);
	const key = readFileSync(join(home, "hub.token"), "utf8").trim();
	assert.match(key, /^[0-9a-f]{64}$/);
	assert.doesNotMatch(first.output, /[0-9a-f]{64}/, "no key in a log");
	assert.match(first.output, /\?k=… \(ampi open prints the full link\)/);
	assert.equal(statSync(first.log).mode & 0o777, 0o600);
	assert.equal(statSync(join(home, "hub.token")).mode & 0o777, 0o600);

	const again = await hubToFile(t, home);
	assert.equal(readFileSync(join(home, "hub.token"), "utf8").trim(), key, "a plain restart keeps the key");
	assert.doesNotMatch(again.output, /[0-9a-f]{64}/);

	const rotated = await hubToFile(t, home, ["--rotate-key"]);
	const next = readFileSync(join(home, "hub.token"), "utf8").trim();
	assert.match(next, /^[0-9a-f]{64}$/);
	assert.notEqual(next, key, "--rotate-key writes a new key");
	assert.equal(statSync(join(home, "hub.token")).mode & 0o777, 0o600);
	assert.doesNotMatch(rotated.output, /[0-9a-f]{64}/);
});

test("cli hub: a second hub on a home that a hub owns stops first and names the owner; doctor shows the owner", async (t) => {
	const home = tempHome();
	await hubToFile(t, home, [], (pid) => {
		const files = ["hub.token", "hub.port"].map((name) => readFileSync(join(home, name), "utf8"));
		const port = Number(files[1]);
		const second = spawnSync(process.execPath, [BIN, "hub", "--port", "0", "--rotate-key", "--config", join(home, "hub.json")], { env: hubEnv(home), encoding: "utf8", timeout: 20_000 });
		assert.equal(second.status, 1, second.stderr);
		assert.match(second.stderr, new RegExp(`An AmPi hub already runs for .*\\(pid ${pid}, port ${port}\\)\\. Open it with: ampi open`));
		assert.deepEqual(["hub.token", "hub.port"].map((name) => readFileSync(join(home, name), "utf8")), files, "the refused hub wrote no state, not even --rotate-key");
		const doctor = spawnSync(process.execPath, [BIN, "doctor"], { env: hubEnv(home), encoding: "utf8", timeout: 30_000 });
		assert.match(doctor.stdout, new RegExp(`✓ Hub pid ${pid} owns .* \\(port ${port}\\)`), doctor.stdout);
		assert.match(doctor.stdout, /✓ Hub running/, doctor.stdout);
	});
});

test("cli hub: a hub on another home that shares the running hub's hub.json directory stops first and names the owner", async (t) => {
	const shared = join(tempHome(), "config");
	const config = join(shared, "hub.json");
	await hubToFile(t, tempHome(), [], (pid) => {
		const other = tempHome();
		const second = spawnSync(process.execPath, [BIN, "hub", "--port", "0", "--rotate-key", "--config", config], { env: hubEnv(other), encoding: "utf8", timeout: 20_000 });
		assert.equal(second.status, 1, second.stderr);
		assert.match(second.stderr, new RegExp(`Another AmPi hub \\(pid ${pid}\\) writes .*config, which this hub needs for its hub.json`));
		assert.throws(() => readFileSync(join(other, "hub.token")), /ENOENT/, "the refused hub wrote no key");
	}, config);
});
