import "./bound.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { connectOrStart, runDaemon } from "../src/node/daemon.ts";
import { autostartOffPath, installService, launchdPlist, readSupervised, RESTART_EXIT, serviceSpec, systemdUnit, uninstallService } from "../src/node/supervisor.ts";
import { TestClient, tempHome } from "./helpers.ts";

const BIN = fileURLToPath(new URL("../bin/ampi.mjs", import.meta.url));

test("supervisor: the launchd and systemd units restart only a failed exit and keep the node's environment", () => {
	const home = tempHome();
	const spec = serviceSpec(home, { PATH: "/usr/bin:/bin", HOME: "/nonexistent/test-home", SECRET: "kept out" });
	assert.match(spec.label, /^dev\.hypercarrier\.ampi-node-[0-9a-f]{8}$/, "a non-default home gets its own label");
	assert.deepEqual(spec.program.slice(1), [BIN, "node"]);
	assert.deepEqual(Object.keys(spec.env).sort(), ["AMPI_HOME", "HOME", "PATH"]);

	const plist = launchdPlist(spec);
	assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key><false\/>/);
	assert.match(plist, /<key>ThrottleInterval<\/key><integer>10<\/integer>/);
	assert.match(plist, new RegExp(`<key>AMPI_HOME</key><string>${home}</string>`));
	assert.doesNotMatch(plist, /SECRET/);

	const unit = systemdUnit(spec);
	for (const line of ["Restart=on-failure", "RestartSec=5", "StartLimitIntervalSec=300", "StartLimitBurst=5", `Environment=AMPI_HOME=${home}`])
		assert.ok(unit.split("\n").includes(line), line);

	const unitDir = join(home, "units");
	for (const platform of ["launchd", "systemd"] as const) {
		const marker = installService(home, { platform, unitDir, load: false, env: { PATH: "/bin" } });
		assert.deepEqual(readSupervised(home), marker);
		assert.equal(existsSync(marker.unitPath), true);
		assert.deepEqual(marker.start.slice(0, 2), platform === "launchd" ? ["launchctl", "kickstart"] : ["systemctl", "--user"]);
		assert.equal(uninstallService(home, { load: false }), true);
		assert.equal(existsSync(marker.unitPath) || existsSync(join(home, "supervised")), false);
	}
});

test("supervisor: a supervised home starts the node through its supervisor and never spawns its own", async () => {
	const home = tempHome();
	mkdirSync(home, { recursive: true });
	const ran = join(home, "start-ran");
	writeFileSync(
		join(home, "supervised"),
		JSON.stringify({ platform: "launchd", label: "test.label", unitPath: join(home, "unit"), start: [process.execPath, "-e", "require('fs').writeFileSync(process.argv[1], 'x')", ran] }),
	);
	await assert.rejects(connectOrStart(home, 400), /AmPi node did not start: .* and launchctl print gui\/\d+\/test\.label/);
	assert.equal(readFileSync(ran, "utf8"), "x", "the supervisor's start command ran");
	assert.equal(existsSync(join(home, "node.pid")), false, "no unsupervised node started");
});

test("supervisor: `ampi node` exits 75 on node.restart, so a supervisor restarts it, and 0 on SIGTERM", async () => {
	const home = tempHome();
	const env = { ...process.env, AMPI_HOME: home, PI_CODING_AGENT_DIR: join(home, "agent") };
	const start = async () => {
		const child = spawn(process.execPath, [BIN, "node"], { env, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (data) => (stderr += data));
		const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
		const deadline = Date.now() + 20_000;
		for (;;) {
			try {
				return { child, exited, client: await TestClient.connect(join(home, "node.sock")) };
			} catch {
				if (Date.now() > deadline) throw new Error(`node did not listen: ${stderr}`);
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
	};
	const first = await start();
	assert.deepEqual(await first.client.req("node.restart"), { restarting: true });
	assert.equal(await first.exited, RESTART_EXIT);
	first.client.close();

	const second = await start();
	second.child.kill("SIGTERM");
	assert.equal(await second.exited, 0);
	second.client.close();
	assert.equal(existsSync(join(home, "node.pid")), false, "both stops released the lock");
});

test("supervisor: uninstall --no-autostart holds the home, so no late client respawns a node; install releases it", async () => {
	const home = tempHome();
	const unitDir = join(home, "units");
	const marker = installService(home, { platform: "systemd", unitDir, load: false });
	assert.equal(uninstallService(home, { platform: "systemd", unitDir, load: false, autostartOff: true }), true);
	assert.equal(existsSync(marker.unitPath) || existsSync(join(home, "supervised")), false);
	assert.equal(existsSync(autostartOffPath(home)), true);
	await assert.rejects(connectOrStart(home, 400), /autostart is off/);
	assert.equal(existsSync(join(home, "node.log")) || existsSync(join(home, "node.pid")), false, "no node was spawned");
	installService(home, { platform: "systemd", unitDir, load: false });
	assert.equal(existsSync(autostartOffPath(home)), false, "install-service releases the hold");
	uninstallService(home, { platform: "systemd", unitDir, load: false });
});

test("supervisor: uninstall removes this home's unit file even without a marker", () => {
	const home = tempHome();
	const unitDir = join(home, "units");
	// An older build wrote the unit before the marker, so a failed load left a unit with no marker.
	mkdirSync(unitDir, { recursive: true });
	const orphan = join(unitDir, `${serviceSpec(home).label}.service`);
	writeFileSync(orphan, "[Service]\n");
	assert.equal(uninstallService(home, { platform: "systemd", unitDir, load: false }), true);
	assert.equal(existsSync(orphan), false);
	assert.equal(uninstallService(home, { platform: "systemd", unitDir, load: false }), false, "nothing left to remove");
});

test("supervisor: `ampi node inventory` reads stores and the owner without starting a node", { timeout: 30_000 }, async () => {
	const home = tempHome();
	const env = { ...process.env, AMPI_HOME: home };
	const inventory = (...args: string[]) => spawnSync(process.execPath, [BIN, "node", "inventory", ...args], { env, encoding: "utf8" });
	const daemon = await runDaemon({ home, simTokensPerSecond: 2000 });
	let before = "";
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		const { threadId } = await client.req("thread.create", { requestId: "inv-1", cwd: home, model: { provider: "ampi-sim", modelId: "sim-1" }, place: { workspace: "new", label: "inv" }, prompt: "/sim long 2" });
		await client.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId].preview);
		client.close();
		const running = inventory();
		assert.equal(running.status, 0, running.stderr);
		assert.match(running.stdout, new RegExp(`owner pid ${process.pid} · socket answers · autostart on`));
		assert.match(running.stdout, /store \S+ · pi-durable \S+ · schema \d+ · threads 1 · entries [1-9]\d* · last \d+ \(conversation \d+, commit \d+/);
		assert.equal(inventory("--expect-stopped").status, 1, "a running owner fails --expect-stopped");
		before = running.stdout.split("\n").filter((line) => line.startsWith("store ")).join("\n");
	} finally {
		await daemon.stop();
	}
	const stopped = inventory("--expect-stopped");
	assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
	assert.match(stopped.stdout, /owner none · socket silent/);
	assert.equal(stopped.stdout.split("\n").filter((line) => line.startsWith("store ")).join("\n"), before, "the stores read back unchanged");
	assert.equal(existsSync(join(home, "node.pid")), false, "inventory started no node and left no owner");
});
