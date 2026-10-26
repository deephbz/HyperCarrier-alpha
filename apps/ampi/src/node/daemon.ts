// The node daemon: one per host and AMPI_HOME. It listens only on a 0600 unix socket (no TCP; P1 and secret safety);
// remote hubs reach it through `ssh host ampi bridge`, which relays stdio to the socket and starts the daemon when
// it is not running. The owner lock excludes other daemons and offline restore from the same storages.

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFrame, lineReader } from "../shared/framing.ts";
import type { ClientFrame } from "../shared/protocol.ts";
import type { NodeOptions, NodeRuntime } from "./runtime.ts";
import type { Connection } from "./server.ts";
import { autostartOffPath, readSupervised, startSupervised, supervisedHint } from "./supervisor.ts";

export function ampiHome(): string {
	return process.env.AMPI_HOME ?? join(homedir(), ".ampi");
}

export function socketPath(home = ampiHome()): string {
	return process.env.AMPI_SOCKET ?? join(home, "node.sock");
}

import { lock, NodeOwnerError } from "./owner-lock.ts";
export { lock, NodeOwnerError } from "./owner-lock.ts";

export type RunningDaemon = { runtime: NodeRuntime; server: Server; socket: string; stop(): Promise<void> };

export async function runDaemon(options: NodeOptions = {}): Promise<RunningDaemon> {
	const [{ NodeRuntime }, { Connection }] = await Promise.all([import("./runtime.ts"), import("./server.ts")]);
	const home = options.home ?? ampiHome();
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const held = lock(home);
	if ("owner" in held) throw new NodeOwnerError(home, held.owner);
	let ownedRuntime: NodeRuntime | undefined;
	try {
		const runtime = ownedRuntime = new NodeRuntime({ ...options, home });
		await runtime.start();
		const socket = process.env.AMPI_SOCKET ?? join(home, "node.sock");
		if (existsSync(socket)) unlinkSync(socket);
		const connections = new Set<{ socket: Socket; connection: Connection }>();
		const server = createServer((client) => {
			const connection = new Connection(runtime, (frame) => {
				if (client.destroyed) return;
				// A reader that stops reading (a stalled SSH link) is dropped instead of buffering without bound; the hub
				// reconnects and resubscribes from snapshots.
				if (client.writableLength > 32 * 1024 * 1024) return void client.destroy();
				client.write(encodeFrame(frame));
			});
			const item = { socket: client, connection };
			connections.add(item);
			client.on(
				"data",
				lineReader(
					(line) => {
						try {
							connection.receive(JSON.parse(line) as ClientFrame);
						} catch {}
					},
					() => client.destroy(),
				),
			);
			const done = () => {
				connections.delete(item);
				connection.close();
			};
			client.on("close", done);
			client.on("error", done);
		});
		const previousUmask = process.umask(0o177);
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socket, () => resolve());
			});
		} finally {
			process.umask(previousUmask);
		}
		let stopped = false;
		const stop = async () => {
			if (stopped) return;
			stopped = true;
			server.close();
			for (const { socket: client } of connections) client.destroy();
			await runtime.close();
			try {
				unlinkSync(socket);
			} catch {}
			held.release();
		};
		return { runtime, server, socket, stop };
	} catch (error) {
		try { await ownedRuntime?.close(); }
		finally { held.release(); }
		throw error;
	}
}

const BIN = fileURLToPath(new URL("../../bin/ampi.mjs", import.meta.url));

export function connectSocket(path: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const client = createConnection(path);
		client.once("connect", () => resolve(client));
		client.once("error", reject);
	});
}

/**
 * Connects to the local daemon, starting it when it does not answer: through its supervisor when the home is
 * supervised (supervisor.ts), otherwise as a detached process.
 */
export async function connectOrStart(home = ampiHome(), timeoutMs = 15_000): Promise<Socket> {
	const path = socketPath(home);
	try {
		return await connectSocket(path);
	} catch {}
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const supervised = readSupervised(home);
	if (!supervised && existsSync(autostartOffPath(home)))
		throw new Error(`AmPi node autostart is off for ${home} (${autostartOffPath(home)}). Start it with \`ampi node install-service\` or \`ampi node\`, or remove that file.`);
	let startError = "";
	if (supervised) {
		// A second, unsupervised node would race the supervisor for the lock: only ask the supervisor.
		try {
			startSupervised(supervised);
		} catch (error) {
			startError = `; ${(error as Error).message}`;
		}
	} else {
		const log = openSync(join(home, "node.log"), "a", 0o600);
		const child = spawn(process.execPath, [BIN, "node"], {
			detached: true,
			stdio: ["ignore", log, log],
			env: { ...process.env, AMPI_HOME: home },
		});
		child.unref();
		closeSync(log);
	}
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			return await connectSocket(path);
		} catch (error) {
			if (Date.now() > deadline)
				throw new Error(
					`AmPi node did not start: ${(error as Error).message}${startError}; see ${join(home, "node.log")}${supervised ? ` and ${supervisedHint(supervised)}` : ""}`,
				);
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
	}
}

/** `ampi bridge`: relays stdin/stdout to the local daemon socket; the SSH transport of remote hosts. */
export async function runBridge(): Promise<void> {
	const socket = await connectOrStart();
	process.stdin.pipe(socket);
	socket.pipe(process.stdout);
	await new Promise<void>((resolve) => {
		socket.on("close", () => resolve());
		process.stdin.on("end", () => {
			socket.end();
		});
	});
}
