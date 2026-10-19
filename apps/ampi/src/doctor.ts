// `ampi doctor`: checks this machine and every configured host the way AmPi will use them, and says how to fix each
// problem. It never changes anything. Exit code 1 when something blocks use.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hubConfigPath, hubProof, hubToken, loadHubConfig } from "./hub/hub.ts";
import type { HostConfig } from "./hub/hosts.ts";
import { connectSocket, socketPath } from "./node/daemon.ts";
import { buildId } from "./shared/build.ts";

const run = promisify(execFile);
const WEB_INDEX = fileURLToPath(new URL("../web/dist/index.html", import.meta.url));

type Level = "ok" | "warn" | "fail";
const MARK: Record<Level, string> = { ok: "✓", warn: "!", fail: "✗" };
let failures = 0;

function report(level: Level, what: string, fix?: string): void {
	if (level === "fail") failures++;
	console.log(`${MARK[level]} ${what}`);
	if (fix && level !== "ok") console.log(`    → ${fix}`);
}

export function ampiHome(): string {
	return process.env.AMPI_HOME ?? join(homedir(), ".ampi");
}

/** The running node's hello, or undefined when none answers. Never starts a node. */
async function nodeHello(): Promise<{ build?: string; pid?: number; hostname?: string } | undefined> {
	try {
		const socket = await connectSocket(socketPath());
		return await new Promise((resolve) => {
			const timer = setTimeout(() => (socket.destroy(), resolve(undefined)), 3000);
			socket.once("data", (data) => {
				clearTimeout(timer);
				socket.destroy();
				try {
					resolve((JSON.parse(String(data).split("\n")[0]!) as { node: { build?: string; pid?: number; hostname?: string } }).node);
				} catch {
					resolve(undefined);
				}
			});
		});
	} catch {
		return undefined;
	}
}

/** The hub's port: --port, else AMPI_HUB_PORT, else the port the last `ampi hub` used, else 7878. */
export function hubPort(flagValue?: string): number {
	if (flagValue) return Number(flagValue);
	if (process.env.AMPI_HUB_PORT) return Number(process.env.AMPI_HUB_PORT);
	try {
		const recorded = Number(readFileSync(join(ampiHome(), "hub.port"), "utf8").trim());
		if (recorded > 0) return recorded;
	} catch {}
	return 7878;
}

export function versionLine(): string {
	const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string };
	return `ampi ${pkg.version} build ${buildId()} node ${process.versions.node}`;
}

export async function doctor(): Promise<number> {
	const { listModels, openModels } = await import("./node/models.ts");
	console.log(`${versionLine()}\n`);
	console.log("This machine");
	const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
	if (major > 22 || (major === 22 && minor >= 19)) report("ok", `Node ${process.versions.node}`);
	else report("fail", `Node ${process.versions.node} is too old`, "Install Node 22.19 or newer (it runs AmPi's TypeScript directly).");

	if (existsSync(WEB_INDEX)) report("ok", "Window built");
	else report("fail", "The window (web UI) is not built", "npm run build:web -w @hypercarrier/ampi (from the repository root), or run apps/ampi/scripts/setup.sh");

	try {
		await import("node-pty");
		report("ok", "Terminals available (node-pty)");
	} catch {
		report("warn", "Terminals unavailable: node-pty did not load", "Install build tools (python3, make, a C++ compiler), then npm install again. Everything else works without it.");
	}

	const node = await nodeHello();
	if (!node) report("ok", "No node running yet; the hub or the first SSH connection starts it");
	else if (node.build && node.build !== buildId())
		report("warn", `The running node (pid ${node.pid}) is an older build (${node.build})`, "ampi stop; it restarts on the next connection, and running work resumes.");
	else report("ok", `Node running (pid ${node.pid})`);

	const models = (await listModels(openModels())).filter((m) => m.provider !== "ampi-sim");
	if (models.length) report("ok", `Models signed in: ${[...new Set(models.map((m) => m.provider))].join(", ")} (${models.length} models)`);
	else
		report(
			"warn",
			"No model is signed in on this machine; threads would use the offline simulator",
			"In the AmPi window choose Set up models (on each host). A key exported in your shell reaches only a node started from that shell: ampi stop, then start the hub again from it.",
		);

	const onPath = await run("sh", ["-c", "command -v ampi"]).then(
		(r) => r.stdout.trim(),
		() => "",
	);
	const entry = fileURLToPath(new URL("../bin/ampi.mjs", import.meta.url));
	let launcher = "";
	try {
		launcher = readFileSync(onPath, "utf8");
	} catch {}
	if (onPath && !launcher.includes(entry))
		report("warn", `ampi on PATH (${onPath}) runs another copy of AmPi`, `Put this checkout's launcher first: apps/ampi/scripts/setup.sh --bin-dir <a directory early on PATH>, or remove ${onPath}.`);
	else if (onPath) report("ok", `ampi on PATH (${onPath})`);
	else report("warn", "ampi is not on PATH", "Run apps/ampi/scripts/setup.sh, or add its bin directory to PATH. Remote hosts need ampi on the PATH of non-interactive SSH commands.");

	console.log("\nHub");
	const port = hubPort();
	const token = existsSync(join(ampiHome(), "hub.token")) ? hubToken() : undefined;
	try {
		const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })).json()) as { proof?: string };
		if (token && health.proof === hubProof(token)) report("ok", `Hub running: http://127.0.0.1:${port}/?k=… (ampi open prints the full link)`);
		else report("fail", `Something else answers on port ${port}`, "Stop it, or start AmPi on another port: ampi hub --port 7879 (open and doctor then find it there).");
	} catch {
		report("ok", `Hub not running; start it with: ampi hub`);
	}

	const config = loadHubConfig(hubConfigPath());
	const remotes = config.hosts.filter((h): h is HostConfig => h.kind === "ssh");
	if (remotes.length) console.log("\nRemote hosts");
	await Promise.all(
		remotes.map(async (host) => {
			const words = (host.command ?? "ampi bridge").split(/\s+/);
			words[words.length - 1] = "version";
			try {
				const { stdout } = await run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", ...(host.sshArgs ?? []), "--", host.target!, ...words], { timeout: 15_000 });
				const remoteBuild = /build (\S+)/.exec(stdout)?.[1];
				if (remoteBuild && remoteBuild !== buildId())
					report("warn", `${host.label}: ${stdout.trim()} differs from this build`, `Update AmPi on ${host.target} (git pull && apps/ampi/scripts/setup.sh), then restart its node from the window.`);
				else report("ok", `${host.label}: ${stdout.trim()}`);
			} catch (error) {
				const text = `${(error as { stderr?: string }).stderr ?? ""}${(error as Error).message}`;
				if (/command not found|No such file/.test(text))
					report("fail", `${host.label}: ampi is not on the PATH of SSH commands on ${host.target}`, `Install AmPi there with apps/ampi/scripts/setup.sh --bin-dir /usr/local/bin (or a directory on its non-interactive PATH).`);
				else if (/Permission denied|publickey|Host key verification/.test(text))
					report("fail", `${host.label}: SSH needs a key and a known host key`, `Run ssh ${host.target} once in a terminal, and use key-based login (ssh-copy-id ${host.target}).`);
				else report("fail", `${host.label}: cannot reach ${host.target}`, text.trim().split("\n").pop());
			}
		}),
	);

	console.log(failures ? `\n${failures} problem${failures === 1 ? "" : "s"} to fix.` : "\nReady.");
	return failures ? 1 : 0;
}
