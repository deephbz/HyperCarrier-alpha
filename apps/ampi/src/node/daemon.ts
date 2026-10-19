// The node daemon: one per host and AMPI_HOME. It listens only on a 0600 unix socket (no TCP; P1 and secret safety);
// remote hubs reach it through `ssh host ampi bridge`, which relays stdio to the socket and starts the daemon when
// it is not running. A pid lock keeps a second daemon from opening the same storages (one process owns a storage).

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFrame, lineReader } from "../shared/framing.ts";
import type { ClientFrame } from "../shared/protocol.ts";
import type { NodeOptions, NodeRuntime } from "./runtime.ts";
import type { Connection } from "./server.ts";

export function ampiHome(): string {
	return process.env.AMPI_HOME ?? join(homedir(), ".ampi");
}

export function socketPath(home = ampiHome()): string {
	return process.env.AMPI_SOCKET ?? join(home, "node.sock");
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Takes the daemon lock or reports the live owner's pid. */
function lock(home: string): { release(): void } | { owner: number } {
	const path = join(home, "node.pid");
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(path, "wx", 0o600);
			writeFileSync(fd, `${process.pid}\n`);
			closeSync(fd);
			return {
				release() {
					try {
						if (readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path);
					} catch {}
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const owner = Number(readFileSync(path, "utf8").trim());
			if (owner > 0 && alive(owner)) return { owner };
			// An empty lock is one another starter has just created and not yet written: it is live, not stale.
			if (!(owner > 0) && Date.now() - statSync(path).mtimeMs < 5_000) return { owner: 0 };
			unlinkSync(path);
		}
	}
	throw new Error(`Could not take ${path}`);
}

export type RunningDaemon = { runtime: NodeRuntime; server: Server; socket: string; stop(): Promise<void> };

export async function runDaemon(options: NodeOptions = {}): Promise<RunningDaemon> {
	const [{ NodeRuntime }, { Connection }] = await Promise.all([import("./runtime.ts"), import("./server.ts")]);
	const home = options.home ?? ampiHome();
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const held = lock(home);
	if ("owner" in held) throw new Error(`An AmPi node already runs for ${home} (pid ${held.owner})`);
	// Two starters that both found a stale lock can race: one may unlink the other's fresh lock. Check that the lock
	// still names this process after the race window, so at most one node ever opens the stores.
	await new Promise((resolve) => setTimeout(resolve, 100));
	let holder = "";
	try {
		holder = readFileSync(join(home, "node.pid"), "utf8").trim();
	} catch {}
	if (holder !== String(process.pid)) throw new Error(`Lost the node lock for ${home} to pid ${holder || "unknown"}`);
	const runtime = new NodeRuntime({ ...options, home });
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
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socket, () => resolve());
	});
	process.umask(previousUmask);
	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		server.close();
		for (const { socket: client } of connections) client.destroy();
		runtime.terminals.closeAll();
		await runtime.close();
		try {
			unlinkSync(socket);
		} catch {}
		held.release();
	};
	return { runtime, server, socket, stop };
}

const BIN = fileURLToPath(new URL("../../bin/ampi.mjs", import.meta.url));

export function connectSocket(path: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const client = createConnection(path);
		client.once("connect", () => resolve(client));
		client.once("error", reject);
	});
}

/** Connects to the local daemon, starting it detached when it does not answer. */
export async function connectOrStart(home = ampiHome(), timeoutMs = 15_000): Promise<Socket> {
	const path = socketPath(home);
	try {
		return await connectSocket(path);
	} catch {}
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const log = openSync(join(home, "node.log"), "a", 0o600);
	const child = spawn(process.execPath, [BIN, "node"], {
		detached: true,
		stdio: ["ignore", log, log],
		env: { ...process.env, AMPI_HOME: home },
	});
	child.unref();
	closeSync(log);
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			return await connectSocket(path);
		} catch (error) {
			if (Date.now() > deadline) throw new Error(`AmPi node did not start: ${(error as Error).message}; see ${join(home, "node.log")}`);
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
