// `ampi [hub] | open | doctor | status | stop | version | node | bridge`
import { instant, nameProcess, span, spanAsync } from "./trace.ts";
import { localTime, startLoopWatch } from "./loop-watch.ts";
import { connectSocket, runBridge, runDaemon, socketPath } from "./node/daemon.ts";
import { existsSync, fchmodSync, fstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import { spawn } from "node:child_process";
import { hubConfigPath, Hub, hubProof, hubToken, loadHubConfig, newHubToken, saveHubToken } from "./hub/hub.ts";
import { ampiHome, doctor, hubPort, versionLine } from "./doctor.ts";

const USAGE = `usage: ampi [command]

  hub [--port N] [--open] [--rotate-key] [--persistent-cookie]
                            run the hub (the default); a terminal gets the window's link.
                            --rotate-key replaces the access key first: old links and cookies stop working
                            --persistent-cookie keeps the login for a year (hub.json: "persistentCookie": true);
                            otherwise it ends with the browser session
  open [--open]             print the link to the running hub, with its access key
  doctor                    check this machine and every host, and say how to fix problems
  status                    show this machine's node
  stop                      stop this machine's node (running work resumes on the next start)
  version                   print the version and build
  node | bridge             internal: the node daemon, and the SSH bridge to it`;

const [command = "hub", ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
	const index = rest.indexOf(`--${name}`);
	return index >= 0 ? rest[index + 1] : undefined;
}

switch (command) {
	case "node": {
		const { hydrate } = await import("./plugins.ts");
		process.env.AMPI_NODE_PROCESS = "1";
		const tps = Number(process.env.AMPI_SIM_TPS);
		const daemon = await runDaemon({ plugins: await hydrate(), ...(tps > 0 ? { simTokensPerSecond: tps } : {}) });
		console.error(`[ampi node] ${daemon.runtime.info.nodeId} listening on ${daemon.socket} (pid ${process.pid})`);
		const stop = async () => {
			await daemon.stop();
			process.exit(0);
		};
		process.on("SIGTERM", stop);
		process.on("SIGINT", stop);
		break;
	}
	case "bridge":
		await runBridge();
		break;
	case "hub": {
		nameProcess("hub");
		instant("modules-loaded");
		// hub.log is this output: each line carries its local time with offset, and long event-loop blocks are named (loop-watch.ts).
		if (!process.stdout.isTTY) for (const name of ["log", "info", "warn", "error"] as const) {
			const write = console[name].bind(console);
			console[name] = (...args: unknown[]) => write(`${localTime()} ${format(...args)}`);
		}
		startLoopWatch();
		keepOutputPrivate();
		const configPath = flag("config") ?? hubConfigPath();
		const rotated = rest.includes("--rotate-key") ? newHubToken() : undefined;
		const config = span("config-load", "startup", () => loadHubConfig(configPath));
		const hub = span("hub-construct", "startup", () => new Hub(config, { configPath, token: rotated ?? hubToken(ampiHome()), ...(rest.includes("--persistent-cookie") ? { persistentCookie: true } : {}) }));
		const wanted = hubPort(flag("port"));
		const port = await spanAsync("listen", "startup", () => hub.listen(wanted)).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "EADDRINUSE") {
				console.error(`Port ${wanted} is in use. If AmPi already runs there, use: ampi open. Otherwise pick another port: ampi hub --port 7879`);
				process.exit(1);
			}
			throw error;
		});
		// Saved only once this hub owns the port: a refused start must not strand a running hub's key.
		if (rotated) saveHubToken(ampiHome(), rotated);
		// Remembered so `ampi open` and `ampi doctor` find this hub without being told the port again.
		writeFileSync(join(ampiHome(), "hub.port"), `${port}\n`, { mode: 0o600 });
		const url = `http://127.0.0.1:${port}/?k=${hub.token}`;
		// Only a terminal sees the key. Redirected output becomes a log that outlives the hub and the key's secrecy.
		console.log(
			process.stdout.isTTY
				? `AmPi is running. Open this link (it carries this machine's access key):\n\n  ${url}\n\nAgents keep working after you close the window or stop the hub. Stop with Ctrl-C.`
				: `AmPi is running: http://127.0.0.1:${port}/?k=… (ampi open prints the full link). Agents keep working after the hub stops.`,
		);
		if (rest.includes("--open") || rest.includes("--launch")) launch(url);
		const stop = async () => {
			instant("stop-requested");
			await spanAsync("hub-close", "startup", () => hub.close());
			instant("stopped");
			process.exit(0);
		};
		process.on("SIGTERM", stop);
		process.on("SIGINT", stop);
		break;
	}
	case "status": {
		// Reports the running node only; never starts one.
		try {
			const socket = await connectSocket(socketPath());
			socket.once("data", (data) => {
				console.log(String(data).split("\n")[0]);
				socket.destroy();
			});
		} catch {
			console.log(`no node at ${socketPath()}`);
			process.exitCode = 1;
		}
		break;
	}
	case "open": {
		// The link to a running hub, with the access key; --launch opens it in the default browser.
		const port = hubPort(flag("port"));
		const token = existsSync(join(ampiHome(), "hub.token")) ? hubToken() : "";
		let proof = "";
		try {
			proof = ((await (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })).json()) as { proof?: string }).proof ?? "";
		} catch {}
		if (!token || proof !== hubProof(token)) {
			console.error(
				proof
					? `Port ${port} answers, but it is not this user's AmPi hub. If yours runs on another port: ampi open --port N`
					: `No AmPi hub on port ${port}. Start one with: ampi hub`,
			);
			process.exit(1);
		}
		const url = `http://127.0.0.1:${port}/?k=${token}`;
		console.log(url);
		if (rest.includes("--launch") || rest.includes("--open")) launch(url);
		break;
	}
	case "doctor":
		process.exitCode = await doctor();
		break;
	case "version":
		console.log(versionLine());
		break;
	case "stop": {
		// Stops this machine's node. Running work resumes when it starts again (the hub or an SSH connection starts it).
		const pidFile = join(ampiHome(), "node.pid");
		const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0;
		if (!(pid > 0)) {
			console.log("No node is running.");
			break;
		}
		try {
			process.kill(pid, "SIGTERM");
			console.log(`Stopped the node (pid ${pid}). Running work resumes when it starts again.`);
		} catch {
			console.log("No node is running.");
		}
		break;
	}
	case "help":
	case "--help":
	case "-h":
		console.log(USAGE);
		break;
	default:
		console.error(USAGE);
		process.exit(2);
}

/** A launcher that sends the hub's output to a file makes that file the hub's log: keep it owner-only. */
function keepOutputPrivate(): void {
	for (const fd of [1, 2]) {
		try {
			const stat = fstatSync(fd);
			if (stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o077) !== 0) fchmodSync(fd, 0o600);
		} catch {}
	}
}

function launch(url: string): void {
	const opener = process.platform === "darwin" ? "open" : "xdg-open";
	spawn(opener, [url], { stdio: "ignore", detached: true })
		.on("error", () => console.error(`Could not run ${opener}; open the link yourself.`))
		.unref();
}
