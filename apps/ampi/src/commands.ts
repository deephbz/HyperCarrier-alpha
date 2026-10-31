// The hub-side commands of `ampi`. cli.ts loads this module only for them, so `ampi node` never loads the hub.
import { instant, nameProcess, span, spanAsync } from "./trace.ts";
import { localTime, startLoopWatch } from "./loop-watch.ts";
import { fchmodSync, fstatSync } from "node:fs";
import { format } from "node:util";
import { spawn } from "node:child_process";
import { hubConfigPath, Hub, hubProof, loadHubConfig } from "./hub/hub.ts";
import { ampiHome, HubHome, newHubToken, readHubToken, RootOwned } from "./hub/home.ts";
import { doctor, hubPort, versionLine } from "./doctor.ts";

/** `ampi hub | open | doctor | version`. */
export async function hubCommand(command: string, rest: string[]): Promise<void> {
	const flag = (name: string): string | undefined => {
		const index = rest.indexOf(`--${name}`);
		return index >= 0 ? rest[index + 1] : undefined;
	};
	switch (command) {
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
			// The root locks come first: a hub that shares the home or the hub.json directory with a running hub stops before
			// it reads or writes any of its state.
			const configPath = flag("config") ?? hubConfigPath();
			const home = span("home-lock", "startup", () => HubHome.acquire(ampiHome(), configPath));
			if (!(home instanceof HubHome)) {
				const owner = [home.pid ? `pid ${home.pid}` : "starting", ...(home.port ? [`port ${home.port}`] : [])].join(", ");
				console.error(
					home.use ? new RootOwned(home, home.use).message : `An AmPi hub already runs for ${home.dir} (${owner}). Open it with: ampi open`,
				);
				process.exit(1);
			}
			const config = span("config-load", "startup", () => loadHubConfig(configPath));
			// A new key is saved only once the hub holds every root, so a refused hub changes nothing.
			const rotate = rest.includes("--rotate-key");
			const token = rotate ? newHubToken() : home.token();
			let hub: Hub;
			try {
				hub = span("hub-construct", "startup", () => new Hub(config, { configPath, home, token, ...(rest.includes("--persistent-cookie") ? { persistentCookie: true } : {}) }));
			} catch (error) {
				if (!(error instanceof RootOwned)) throw error;
				console.error(error.message);
				process.exit(1);
			}
			if (rotate) home.saveToken(token);
			const wanted = hubPort(flag("port"));
			const port = await spanAsync("listen", "startup", () => hub.listen(wanted)).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "EADDRINUSE") {
					console.error(`Port ${wanted} is in use by another program. ampi doctor shows what answers there.`);
					process.exit(1);
				}
				throw error;
			});
			home.recordPort(port);
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
				home.release();
				instant("stopped");
				process.exit(0);
			};
			process.on("SIGTERM", stop);
			process.on("SIGINT", stop);
			break;
		}
		case "open": {
			// The link to a running hub, with the access key; --launch opens it in the default browser.
			const port = hubPort(flag("port"));
			const token = readHubToken() ?? "";
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
	}
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
