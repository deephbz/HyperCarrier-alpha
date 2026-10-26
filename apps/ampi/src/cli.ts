// `ampi [hub] | open | doctor | status | stop | version | node | bridge`
// This module and its static imports are node code: `ampi node` loads them, and the node build hashes them
// (shared/build.ts). The hub-side commands live in commands.ts, which `ampi node` never loads.
import { ampiHome, connectSocket, lock, runBridge, runDaemon, socketPath } from "./node/daemon.ts";
import { RESTART_EXIT } from "./node/supervisor.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
  node backup [STORE]       copy every thread store, or one, under ~/.ampi/backups (safe while the node runs)
  node restore STORE FILE   replace a thread store with a backup; stop the node first
  node install-service      run the node under launchd (Mac) or systemd (Linux); it restarts after a failure
  node uninstall-service [--no-autostart]
                            remove that service; the node then starts on demand again.
                            --no-autostart: no connection starts it until install-service or \`ampi node\`
  node inventory [--expect-stopped]
                            the node owner and each thread store, read only; never starts a node.
                            Exit 1 when a store does not read, or with --expect-stopped when a node owns the home
  node | bridge             internal: the node daemon, and the SSH bridge to it`;

const [command = "hub", ...rest] = process.argv.slice(2);

switch (command) {
	case "node": {
		if (rest[0] && !rest[0].startsWith("-")) {
			await nodeCommand(rest[0], rest.slice(1));
			break;
		}
		const { hydrate } = await import("./plugins.ts");
		process.env.AMPI_NODE_PROCESS = "1";
		const tps = Number(process.env.AMPI_SIM_TPS);
		const daemon = await runDaemon({ plugins: await hydrate(), ...(tps > 0 ? { simTokensPerSecond: tps } : {}) });
		console.error(`[ampi node] ${daemon.runtime.info.nodeId} listening on ${daemon.socket} (pid ${process.pid})`);
		const stop = async (code: number) => {
			await daemon.stop();
			process.exit(code);
		};
		process.on("SIGTERM", () => stop(0));
		process.on("SIGINT", () => stop(0));
		// `node.restart`: a clean stop with RESTART_EXIT, which a supervisor restarts and a clean exit 0 would not.
		process.on("SIGUSR2", () => stop(RESTART_EXIT));
		break;
	}
	case "bridge":
		await runBridge();
		break;
	case "hub":
	case "open":
	case "doctor":
	case "version":
		await (await import("./commands.ts")).hubCommand(command, rest);
		break;
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

/** `ampi node <sub>`: store backups and the OS service. These never start a node. */
async function nodeCommand(sub: string, args: string[]): Promise<void> {
	const home = ampiHome();
	const store = await import("./node/store-file.ts");
	const supervisor = await import("./node/supervisor.ts");
	switch (sub) {
		case "backup": {
			// SQLite's backup API copies a consistent state even while the node writes, so no lock is needed.
			const { existsSync: exists, readdirSync } = await import("node:fs");
			const threads = join(home, "threads");
			const ids = args[0] ? [args[0]] : exists(threads) ? readdirSync(threads).filter((name) => exists(join(threads, name, "harness.sqlite"))).sort() : [];
			for (const id of ids) console.log(await store.backupStore(home, id, "manual"));
			if (ids.length === 0) console.log("No thread stores to back up.");
			return;
		}
		case "restore": {
			const [storeId, file] = args;
			if (!storeId || !file) {
				console.error("usage: ampi node restore STORE FILE");
				process.exit(2);
			}
			const held = lock(home);
			if ("owner" in held) {
				console.error(`The node runs (pid ${held.owner}). Stop it first: ampi stop`);
				process.exit(1);
			}
			try {
				const result = await store.restoreStore(home, storeId, file);
				console.log(`Restored ${storeId} from ${result.restored}.${result.previous ? ` The replaced store is in ${result.previous}.` : ""}`);
			} finally {
				held.release();
			}
			return;
		}
		case "install-service": {
			const marker = supervisor.installService(home);
			console.log(`Installed ${marker.unitPath}. ${marker.platform === "launchd" ? "launchd restarts a failed node every 10 s without a limit." : "systemd restarts a failed node at most 5 times in 5 minutes."}`);
			return;
		}
		case "uninstall-service": {
			const autostartOff = args.includes("--no-autostart");
			let removed: boolean;
			try {
				removed = supervisor.uninstallService(home, { autostartOff });
			} catch (error) {
				if (!(error instanceof supervisor.UninstallError)) throw error;
				console.error(error.message);
				if (autostartOff) console.error(`Autostart stays off: ${supervisor.autostartOffPath(home)}`);
				process.exit(1);
			}
			console.log(removed ? "Removed the node service." : "No node service is installed for this home.");
			if (autostartOff) console.log(`Autostart is off: ${supervisor.autostartOffPath(home)}`);
			return;
		}
		case "inventory": {
			// One line for the owner, one per store.
			const { existsSync: exists, readdirSync } = await import("node:fs");
			const held = lock(home);
			const owner = "owner" in held ? held.owner || "unknown" : undefined;
			if (!("owner" in held)) held.release();
			let answers = false;
			try {
				(await connectSocket(socketPath(home))).destroy();
				answers = true;
			} catch {}
			console.log(`home ${home} · owner ${owner === undefined ? "none" : `pid ${owner}`} · socket ${answers ? "answers" : "silent"} · autostart ${exists(supervisor.autostartOffPath(home)) ? "off" : "on"}`);
			let failed = args.includes("--expect-stopped") && (owner !== undefined || answers);
			const threads = join(home, "threads");
			const ids = exists(threads) ? readdirSync(threads).filter((name) => exists(join(threads, name, "harness.sqlite"))).sort() : [];
			for (const id of ids) {
				try {
					const s = store.inventoryStore(home, id);
					const last = s.last ? `last ${s.last.id} (conversation ${s.last.conversation}, commit ${s.last.commitSeq}${s.last.type ? `, ${s.last.type}` : ""})` : "no entries";
					console.log(`store ${s.storeId} · pi-durable ${s.piDurable ?? "unknown"} · schema ${s.schemaVersion} · threads ${s.threads} · entries ${s.entries} · ${last}`);
				} catch (error) {
					failed = true;
					console.log(`store ${id} · unreadable: ${(error as Error).message}`);
				}
			}
			console.log(`stores ${ids.length}`);
			if (failed) process.exitCode = 1;
			return;
		}
		default:
			console.error(USAGE);
			process.exit(2);
	}
}
