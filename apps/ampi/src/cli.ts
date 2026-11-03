// `ampi [hub] | open | doctor | version`
import { instant, nameProcess, span, spanAsync } from "./trace.ts";
import { localTime, startLoopWatch } from "./loop-watch.ts";
import { fchmodSync, fstatSync } from "node:fs";
import { format } from "node:util";
import { spawn } from "node:child_process";
import { hubConfigPath, Hub, hubProof, loadHubConfig } from "./hub/hub.ts";
import { HubHome, newHubToken, readHubToken, RootOwned } from "./hub/home.ts";
import { ampiHome } from "./shared/home.ts";
import { doctor, hubPort, versionLine, webBuild } from "./doctor.ts";

const USAGE = `usage: ampi [command]

  hub [--port N] [--open] [--rotate-key] [--persistent-cookie]
                            run the hub (the default); a terminal gets the window's link.
                            --rotate-key replaces the access key first: old links and cookies stop working
                            --persistent-cookie keeps the login for a year (hub.json: "persistentCookie": true);
                            otherwise it ends with the browser session
  open [--open]             print the link to the running hub, with its access key
  doctor                    check this machine and its hub, and say how to fix problems
  arc status [--host ID] [--json] | stop (--host ID | --all)
                            Stopping Arc drains Builds for every client. A linked hub restarts it within seconds.
                            exit 0: success; 1: bad/unknown Host state; 2: usage
                            --json: smoke checks each Host state; unreachable can be report-only
  version                   print the version and build`;

const [command = "hub", ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
	const index = rest.indexOf(`--${name}`);
	return index >= 0 ? rest[index + 1] : undefined;
}

switch (command) {
 case "arc": {
  const { parseArcArgs, maintainHost } = await import("./arc/service/client.ts");
  const { serviceError, serviceText } = await import("./arc/service/status.ts");
  let parsed = false;
  try {
   const args = parseArcArgs(rest); parsed = true;
   const config = loadHubConfig(args.config ?? hubConfigPath());
   const hosts = config.hosts.filter((host): host is import("./pi/host.ts").PiHostConfig => (host.kind === "pi-local" || host.kind === "pi-ssh") && (!args.host || host.id === args.host));
   if (!hosts.length) {
    parsed = false;
    throw new Error(`No Pi Host matches ${args.host ?? "the configuration"}. Hosts: ${config.hosts.filter(h => h.kind === "pi-local" || h.kind === "pi-ssh").map(h => h.id).join(", ") || "(none)"}.`);
   }
   if (args.op === "stop" && !args.json) console.error("Stopping Arc drains Builds for every client. A linked hub restarts it within seconds.");
   const results = await Promise.all(hosts.map(async host => {
    try {
     const result = await maintainHost(host, { op: args.op });
     if (["error", "unreachable", "cannot-start", "fault", "busy", "invalid-settings", "no-sign-in"].includes(result.state)) process.exitCode = 1;
     return { ...result, host: host.id };
    } catch (error) { process.exitCode = 1; return serviceError(host.id, error); }
   }));
   if (args.json) console.log(JSON.stringify(results));
   else for (const result of results) console.log(serviceText(result));
  } catch (error) { console.error((error as Error).message); process.exitCode = parsed ? 1 : 2; }
  break;
 }
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
		const web = webBuild();
		if (!web.ok) console.warn(`The window this hub serves is stale: ${web.detail}`);
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
		// The link to a running hub, with the access key; --open (or its alias --launch) opens it in the default browser.
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
