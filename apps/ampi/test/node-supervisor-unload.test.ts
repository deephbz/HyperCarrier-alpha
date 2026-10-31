import "./bound.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runDaemon } from "../src/node/daemon.ts";
import { autostartOffPath, installService, readSupervised, UninstallError, uninstallService } from "../src/node/supervisor.ts";
import { tempHome } from "./helpers.ts";

const BIN = fileURLToPath(new URL("../bin/ampi.mjs", import.meta.url));

type Fakes = { FAKE_UNLOAD?: string; FAKE_PRINT?: string; FAKE_LOADSTATE?: string };

/** A home with fake `launchctl` and `systemctl` first on PATH. FAKE_UNLOAD is the unload exit, FAKE_PRINT the
 * `launchctl print` exit (113: not loaded), FAKE_LOADSTATE the systemd LoadState. Each call appends to FAKE_LOG. */
function fakeHome() {
	const home = tempHome();
	const bin = join(home, "fake-bin");
	const log = join(home, "fake.log");
	mkdirSync(bin, { recursive: true });
	const script = `#!/bin/sh
echo "$(basename "$0") $*" >> "$FAKE_LOG"
case "$(basename "$0") $1 $2" in
	"launchctl bootout "*) exit "\${FAKE_UNLOAD:-0}" ;;
	"launchctl print "*) exit "\${FAKE_PRINT:-113}" ;;
	"systemctl --user disable") exit "\${FAKE_UNLOAD:-0}" ;;
	"systemctl --user show") echo "\${FAKE_LOADSTATE:-not-found}" ;;
esac
exit 0
`;
	for (const name of ["launchctl", "systemctl"]) {
		writeFileSync(join(bin, name), script);
		chmodSync(join(bin, name), 0o755);
	}
	const env = (fakes: Fakes) => ({ PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, ...fakes });
	return {
		home,
		log,
		unitDir: join(home, "units"),
		/** `ampi node uninstall-service --no-autostart` in a child process. */
		cli: (fakes: Fakes) =>
			spawnSync(process.execPath, [BIN, "node", "uninstall-service", "--no-autostart"], { env: { ...process.env, AMPI_HOME: home, ...env(fakes) }, encoding: "utf8" }),
		/** uninstallService in this process, with the fakes in its environment. */
		direct<T>(fakes: Fakes, call: () => T): T {
			const saved = { ...process.env };
			Object.assign(process.env, env(fakes));
			try {
				return call();
			} finally {
				for (const key of ["PATH", "FAKE_LOG", "FAKE_UNLOAD", "FAKE_PRINT", "FAKE_LOADSTATE"]) {
					if (saved[key] === undefined) delete process.env[key];
					else process.env[key] = saved[key];
				}
			}
		},
	};
}

const STILL_LOADED = /The node service did not unload: .* failed: exit \d+\. The unit .* and the marker stay\. Stop the service with `(launchctl bootout|systemctl --user disable --now) .*`, then run `ampi node uninstall-service` again\./;

test("supervisor unload: a failed unload or a live owner keeps the unit and the marker", { timeout: 15_000 }, async () => {
	const fake = fakeHome();
	const { home, unitDir } = fake;
	const daemon = await runDaemon({ home, simTokensPerSecond: 2000 });
	try {
		let marker = installService(home, { platform: "launchd", unitDir, load: false });
		const failed = fake.cli({ FAKE_UNLOAD: "17", FAKE_PRINT: "0" });
		assert.equal(failed.status, 1, failed.stdout + failed.stderr);
		assert.doesNotMatch(failed.stdout, /Removed/);
		assert.match(failed.stderr, STILL_LOADED);
		assert.match(failed.stderr, /Autostart stays off/);
		assert.equal(existsSync(marker.unitPath), true, "launchd: the unit stays");
		assert.deepEqual(readSupervised(home), marker, "launchd: the marker stays");
		assert.equal(existsSync(autostartOffPath(home)), true, "autostart stays off");

		marker = installService(home, { platform: "systemd", unitDir, load: false });
		assert.throws(() => fake.direct({ FAKE_UNLOAD: "1", FAKE_LOADSTATE: "loaded" }, () => uninstallService(home)), (error: Error) => error instanceof UninstallError && STILL_LOADED.test(error.message));
		assert.equal(existsSync(marker.unitPath) && readSupervised(home)?.platform === "systemd", true, "systemd: the unit and the marker stay");

		// The unload succeeded, but this process's node still owns the home.
		marker = installService(home, { platform: "launchd", unitDir, load: false });
		assert.throws(() => fake.direct({ FAKE_UNLOAD: "0" }, () => uninstallService(home, { stopTimeoutMs: 300 })), (error: Error) =>
			error instanceof UninstallError && error.message.includes(`a node still owns ${home} (pid ${process.pid})`) && error.message.includes(`kill ${process.pid}`));
		assert.equal(existsSync(marker.unitPath) && readSupervised(home) !== undefined, true, "a live owner keeps the unit and the marker");
	} finally {
		await daemon.stop();
	}
});

test("supervisor unload: a clean unload or a service not loaded removes the unit and the marker", () => {
	const fake = fakeHome();
	const { home, unitDir } = fake;
	let marker = installService(home, { platform: "launchd", unitDir, load: false });
	const done = fake.cli({});
	assert.equal(done.status, 0, done.stdout + done.stderr);
	assert.match(done.stdout, /Removed the node service\./);
	assert.equal(existsSync(marker.unitPath) || existsSync(join(home, "supervised")), false);
	assert.match(readFileSync(fake.log, "utf8"), /^launchctl bootout gui\/\d+\/dev\.hypercarrier\.ampi-node-[0-9a-f]{8}\n$/, "a clean unload asks nothing more");

	for (const [platform, fakes] of [["launchd", { FAKE_UNLOAD: "3", FAKE_PRINT: "113" }], ["systemd", { FAKE_UNLOAD: "1", FAKE_LOADSTATE: "not-found" }], ["systemd", {}]] as const) {
		marker = installService(home, { platform, unitDir, load: false });
		assert.equal(fake.direct(fakes, () => uninstallService(home)), true, `${platform} ${JSON.stringify(fakes)}`);
		assert.equal(existsSync(marker.unitPath) || existsSync(join(home, "supervised")), false, `${platform} ${JSON.stringify(fakes)}`);
	}
	assert.match(readFileSync(fake.log, "utf8"), /launchctl bootout gui\/\d+\/\S+\nlaunchctl print gui\/\d+\/\S+\nsystemctl --user disable --now \S+\nsystemctl --user show -p LoadState --value \S+\nsystemctl --user disable --now/);
});

test("supervisor: a launchd reinstall waits for bootout to finish before bootstrap", () => {
	// launchd keeps the old service loaded for a while after bootout returns; a bootstrap then fails with error 5.
	const home = tempHome();
	const bin = join(home, "fake-bin");
	const log = join(home, "fake.log");
	const gone = join(home, "unloaded-at");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "launchctl"), `#!/bin/sh
echo "launchctl $*" >> "${log}"
now=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000')
case "$1" in
	bootout) echo $((now + 1000)) > "${gone}"; exit 0 ;;
	print) [ -f "${gone}" ] && [ "$now" -lt "$(cat "${gone}")" ] && exit 0; exit 113 ;;
	bootstrap) [ -f "${gone}" ] && [ "$now" -lt "$(cat "${gone}")" ] && { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }; exit 0 ;;
esac
exit 0
`);
	chmodSync(join(bin, "launchctl"), 0o755);
	const saved = process.env.PATH;
	process.env.PATH = `${bin}:${saved}`;
	try {
		installService(home, { platform: "launchd", unitDir: join(home, "units"), env: { PATH: "/bin" } });
	} finally {
		process.env.PATH = saved;
	}
	const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => line.split(" ")[1]);
	assert.equal(calls[0], "bootout");
	assert.equal(calls.at(-1), "bootstrap");
	assert.ok(calls.includes("print"), "install polled launchd before bootstrap");
});
