// An OS supervisor for the node: a launchd agent on the Mac, a systemd user unit on Linux. The supervisor restarts the
// node after a failed exit: a crash, or exit 75 from `node.restart`. A clean stop (`ampi stop`, exit 0) stays stopped
// until the next connection starts the node again through the supervisor. `$AMPI_HOME/supervised` marks a supervised
// home: `connectOrStart` then asks the supervisor to start the node and never spawns a second, unsupervised one.
// `$AMPI_HOME/autostart-off` holds a home after `uninstall-service --no-autostart`: `connectOrStart` then starts no node
// at all, so a late bridge or CLI client cannot respawn one. `ampi node` and `install-service` still start it.
// launchd has no restart limit: it restarts a failing node every ThrottleInterval seconds without end. systemd stops
// after StartLimitBurst failures in StartLimitIntervalSec.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lock } from "./owner-lock.ts";

/** The exit code of a node that stopped cleanly to be restarted (`node.restart`); EX_TEMPFAIL. */
export const RESTART_EXIT = 75;

export type ServicePlatform = "launchd" | "systemd";
/** `$AMPI_HOME/supervised`. `start` is the command that starts the node through its supervisor. */
export type Supervised = { platform: ServicePlatform; label: string; unitPath: string; start: string[] };
export type ServiceSpec = { home: string; label: string; program: string[]; env: Record<string, string> };

const BIN = fileURLToPath(new URL("../../bin/ampi.mjs", import.meta.url));
const DEFAULT_HOME = join(homedir(), ".ampi");

/** `dev.hypercarrier.ampi-node`, with a hash suffix for any other AMPI_HOME, so two homes get two services. */
export function serviceLabel(home: string): string {
	const base = "dev.hypercarrier.ampi-node";
	return home === DEFAULT_HOME ? base : `${base}-${createHash("sha256").update(home).digest("hex").slice(0, 8)}`;
}

export function serviceSpec(home: string, env: NodeJS.ProcessEnv = process.env): ServiceSpec {
	const kept: Record<string, string> = { AMPI_HOME: home };
	// launchd and systemd start with a minimal environment: keep what the node and its agents' tools need.
	for (const name of ["HOME", "PATH", "PI_CODING_AGENT_DIR", "LANG"]) if (env[name]) kept[name] = env[name]!;
	return { home, label: serviceLabel(home), program: [process.execPath, BIN, "node"], env: kept };
}

export function launchdPlist(spec: ServiceSpec): string {
	const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const log = xml(join(spec.home, "node.log"));
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${xml(spec.label)}</string>
	<key>ProgramArguments</key>
	<array>
${spec.program.map((arg) => `		<string>${xml(arg)}</string>`).join("\n")}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
${Object.entries(spec.env).map(([key, value]) => `		<key>${xml(key)}</key><string>${xml(value)}</string>`).join("\n")}
	</dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key><false/>
	</dict>
	<key>ThrottleInterval</key><integer>10</integer>
	<key>Umask</key><integer>63</integer>
	<key>StandardOutPath</key><string>${log}</string>
	<key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

export function systemdUnit(spec: ServiceSpec): string {
	const quote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$%])/g, "\\$1")}"`);
	const log = join(spec.home, "node.log");
	return `[Unit]
Description=AmPi node (${spec.home})
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
ExecStart=${spec.program.map(quote).join(" ")}
${Object.entries(spec.env).map(([key, value]) => `Environment=${quote(`${key}=${value}`)}`).join("\n")}
Restart=on-failure
RestartSec=5
UMask=0077
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
}

export function readSupervised(home: string): Supervised | undefined {
	try {
		const value = JSON.parse(readFileSync(join(home, "supervised"), "utf8")) as Supervised;
		return Array.isArray(value.start) && value.start.length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

export type InstallOptions = {
	platform?: ServicePlatform;
	/** Where the unit file goes; default ~/Library/LaunchAgents or ~/.config/systemd/user. */
	unitDir?: string;
	/** Load the unit into launchd or systemd (default true); tests write files only. */
	load?: boolean;
	/** How long a launchd reinstall waits for the old service and its node to go (default 15 s). */
	unloadTimeoutMs?: number;
	env?: NodeJS.ProcessEnv;
};

function platformOf(options: InstallOptions): ServicePlatform {
	if (options.platform) return options.platform;
	if (process.platform === "darwin") return "launchd";
	if (process.platform === "linux") return "systemd";
	throw new Error(`No supervisor for ${process.platform}; run \`ampi node\` under your own supervisor`);
}

/** `$AMPI_HOME/autostart-off`: while it exists, `connectOrStart` starts no node for this home. */
export function autostartOffPath(home: string): string {
	return join(home, "autostart-off");
}

/** The unit this home would have: its label, unit path and start command. */
function serviceMarker(home: string, options: InstallOptions, label = serviceLabel(home)): Supervised {
	const platform = platformOf(options);
	const uid = process.getuid?.() ?? 0;
	const unitDir = options.unitDir ?? (platform === "launchd" ? join(homedir(), "Library", "LaunchAgents") : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user"));
	return {
		platform,
		label,
		unitPath: join(unitDir, platform === "launchd" ? `${label}.plist` : `${label}.service`),
		start: platform === "launchd" ? ["launchctl", "kickstart", `gui/${uid}/${label}`] : ["systemctl", "--user", "start", `${label}.service`],
	};
}

/**
 * Writes the unit and the marker, then loads the unit. The supervisor starts the node at once (RunAtLoad, --now).
 * The marker comes before the load, so a failed load leaves a home that `uninstallService` can clean up.
 */
export function installService(home: string, options: InstallOptions = {}): Supervised {
	const spec = serviceSpec(home, options.env);
	const marker = serviceMarker(home, options, spec.label);
	const { platform, unitPath } = marker;
	const uid = process.getuid?.() ?? 0;
	mkdirSync(join(unitPath, ".."), { recursive: true });
	mkdirSync(home, { recursive: true, mode: 0o700 });
	writeFileSync(unitPath, platform === "launchd" ? launchdPlist(spec) : systemdUnit(spec), { mode: 0o644 });
	writeFileSync(join(home, "supervised"), `${JSON.stringify(marker)}\n`, { mode: 0o600 });
	rmSync(autostartOffPath(home), { force: true });
	if (options.load !== false) {
		if (platform === "launchd") {
			// bootout returns before launchd has removed the service; a bootstrap until then fails with error 5.
			const target = `gui/${uid}/${spec.label}`;
			run(["launchctl", "bootout", target], true);
			const deadline = Date.now() + (options.unloadTimeoutMs ?? 15_000);
			while (loaded(marker, target)) {
				if (Date.now() >= deadline) throw new Error(`launchd still has ${target} loaded after bootout. Check it with \`${supervisedHint(marker)}\`, then run \`ampi node install-service\` again.`);
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
			}
			const owner = ownerAfter(home, options.unloadTimeoutMs ?? 15_000);
			if (owner !== undefined) throw new Error(`The old node still owns ${home} (pid ${owner || "unknown"}). Stop it with \`AMPI_HOME=${home} ampi stop\`, then run \`ampi node install-service\` again.`);
			run(["launchctl", "bootstrap", `gui/${uid}`, unitPath]);
		} else {
			run(["systemctl", "--user", "daemon-reload"]);
			run(["systemctl", "--user", "enable", "--now", `${spec.label}.service`]);
		}
	}
	return marker;
}

/** An uninstall that could not prove the node stopped. The unit and the marker stay; the message names the next step. */
export class UninstallError extends Error {
	readonly code = "service_still_loaded";
}

/**
 * Unloads the unit (which stops the node) and removes the unit and the marker. A unit file at this home's own path
 * without a marker (an install from an older build that failed to load) is removed the same way. `autostartOff`
 * then holds the home (autostartOffPath). False when the home had neither a marker nor its unit file.
 * The unit and the marker go only when the unload succeeded or the supervisor reports the service not loaded, and no
 * node owns the home within `stopTimeoutMs`. Otherwise this throws UninstallError and removes nothing.
 */
export function uninstallService(home: string, options: Omit<InstallOptions, "env"> & { autostartOff?: boolean; stopTimeoutMs?: number } = {}): boolean {
	if (options.autostartOff) {
		mkdirSync(home, { recursive: true, mode: 0o700 });
		writeFileSync(autostartOffPath(home), `${JSON.stringify({ at: new Date().toISOString() })}\n`, { mode: 0o600 });
	}
	let marker = readSupervised(home);
	if (!marker) {
		let derived: Supervised | undefined;
		try { derived = serviceMarker(home, options); } catch {}
		if (!derived || !existsSync(derived.unitPath)) return false;
		marker = derived;
	}
	if (options.load !== false) {
		const target = `gui/${process.getuid?.() ?? 0}/${marker.label}`;
		const unload = marker.platform === "launchd" ? ["launchctl", "bootout", target] : ["systemctl", "--user", "disable", "--now", `${marker.label}.service`];
		const failure = run(unload, true);
		// A failed unload is fine only for a service the supervisor no longer has loaded.
		if (failure && loaded(marker, target))
			throw new UninstallError(
				`The node service did not unload: ${failure}. The unit ${marker.unitPath} and the marker stay. ` +
					`Stop the service with \`${unload.join(" ")}\`, check it with \`${supervisedHint(marker)}\`, then run \`ampi node uninstall-service\` again.`,
			);
		const owner = ownerAfter(home, options.stopTimeoutMs ?? 10_000);
		if (owner !== undefined)
			throw new UninstallError(
				`The service unloaded, but a node still owns ${home} (pid ${owner || "unknown"}). The unit ${marker.unitPath} and the marker stay. ` +
					`Stop the node with \`AMPI_HOME=${home} ampi stop\`${owner ? ` or \`kill ${owner}\`` : ""}, then run \`ampi node uninstall-service\` again.`,
			);
	}
	rmSync(marker.unitPath, { force: true });
	rmSync(join(home, "supervised"), { force: true });
	return true;
}

/** Runs the marker's start command. Throws with the command's output when it fails. */
export function startSupervised(marker: Supervised): void {
	run(marker.start);
}

/** What to run when a supervised node does not answer. */
export function supervisedHint(marker: Supervised): string {
	return marker.platform === "launchd"
		? `launchctl print gui/${process.getuid?.() ?? 0}/${marker.label}`
		: `systemctl --user status ${marker.label}.service; journalctl --user -u ${marker.label}.service`;
}

/** True unless the supervisor reports the service not loaded: launchd cannot print it, or systemd does not find it. */
function loaded(marker: Supervised, target: string): boolean {
	if (marker.platform === "launchd") return spawnSync("launchctl", ["print", target], { stdio: "ignore", timeout: 10_000 }).status === 0;
	const state = spawnSync("systemctl", ["--user", "show", "-p", "LoadState", "--value", `${marker.label}.service`], { encoding: "utf8", timeout: 10_000 });
	return state.status !== 0 || state.stdout.trim() !== "not-found";
}

/** The PID that still owns the home after `timeoutMs` (0 when node.pid is unreadable), or undefined once none does. */
function ownerAfter(home: string, timeoutMs: number): number | undefined {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const held = lock(home);
		if (!("owner" in held)) {
			held.release();
			return undefined;
		}
		if (Date.now() >= deadline) return held.owner;
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
	}
}

/** Runs `argv`. A failure throws, or with `allowFailure` returns its description; success returns undefined. */
function run(argv: string[], allowFailure = false): string | undefined {
	const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: 10_000 });
	if (!result.error && result.status === 0) return undefined;
	const failure = `${argv.join(" ")} failed: ${result.error?.message ?? (result.stderr || result.stdout || `exit ${result.status}`).trim()}`;
	if (allowFailure) return failure;
	throw new Error(failure);
}
