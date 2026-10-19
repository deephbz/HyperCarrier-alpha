// Host links: the hub's connection to each AmPi node, local (unix socket) or remote (`ssh <target> ampi bridge`).
// A link reconnects with backoff and reports its own state; it never falls back to another host (writes are exact).

import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { encodeFrame, lineReader } from "../shared/framing.ts";
import { type ClientFrame, type NodeFrame, type NodeInfo, PROTOCOL } from "../shared/protocol.ts";
import { connectOrStart } from "../node/daemon.ts";
import { buildId } from "../shared/build.ts";

export type HostConfig = {
	id: string;
	label: string;
	kind: "local" | "ssh" | "pi-local" | "pi-ssh";
	/** ssh destination, for example `me@devbox` or a Host alias from ~/.ssh/config. */
	target?: string;
	/** Remote command that runs the bridge. Default: `ampi bridge`. */
	command?: string;
	/** Extra ssh arguments, for example ["-p", "2222"]. */
	sshArgs?: string[];
	/** AMPI_HOME of a local node (tests run several). */
	home?: string;
};

export type HostState = {
	id: string;
	label: string;
	kind: HostConfig["kind"];
	target?: string;
	status: "connecting" | "connected" | "disconnected";
	node?: NodeInfo;
	error?: string;
	connectedAt?: number;
	lastSeen?: number;
	attempts: number;
	latencyMs?: number;
	/** The node runs a different AmPi build than this hub (it predates an update); restart it to pick up the new one. */
	buildMismatch?: boolean;
};

type Pipe = { write(text: string): void; close(): void };

export class HostLink extends EventEmitter {
	readonly config: HostConfig;
	state: HostState;
	#pipe?: Pipe;
	#child?: ChildProcess;
	#timer?: ReturnType<typeof setTimeout>;
	#ping?: ReturnType<typeof setInterval>;
	#pingSent = 0;
	#stopped = false;
	#generation = 0;

	constructor(config: HostConfig) {
		super();
		this.config = config;
		this.state = {
			id: config.id,
			label: config.label,
			kind: config.kind,
			...(config.target ? { target: config.target } : {}),
			status: "connecting",
			attempts: 0,
		};
	}

	#set(change: Partial<HostState>): void {
		this.state = { ...this.state, ...change };
		for (const key of Object.keys(change) as (keyof HostState)[]) if (change[key] === undefined) delete this.state[key];
		this.emit("state", this.state);
	}

	start(): void {
		this.#stopped = false;
		void this.#connect();
	}

	send(frame: ClientFrame): boolean {
		if (!this.#pipe || this.state.status !== "connected") return false;
		this.#pipe.write(encodeFrame(frame));
		return true;
	}

	async #connect(): Promise<void> {
		if (this.#stopped) return;
		const generation = ++this.#generation;
		this.#set({ status: "connecting", attempts: this.state.attempts + 1 });
		let helloSeen = false;
		const onFrame = (frame: NodeFrame) => {
			if (generation !== this.#generation) return;
			this.#set({ lastSeen: Date.now() });
			if (frame.t === "hello") {
				helloSeen = true;
				if (frame.protocol !== PROTOCOL) {
					// A node from another protocol generation would misread every frame; refuse it instead of half-working.
					this.#set({
						status: "disconnected",
						node: frame.node,
						error: `The node on this host speaks ${frame.protocol}; this hub speaks ${PROTOCOL}. Update AmPi on the host and stop its node (pid ${frame.node.pid}); the next connection starts the new build.`,
					});
					return;
				}
				this.#set({
					status: "connected",
					node: frame.node,
					connectedAt: Date.now(),
					error: undefined,
					attempts: 0,
					buildMismatch: frame.node.build !== buildId() ? true : undefined,
				});
				this.emit("connected");
				return;
			}
			if (frame.t === "pong") {
				this.#set({ latencyMs: Date.now() - this.#pingSent });
				return;
			}
			this.emit("frame", frame);
		};
		const onLine = lineReader(
			(line) => {
				try {
					onFrame(JSON.parse(line) as NodeFrame);
				} catch {}
			},
			() => this.#pipe?.close(),
		);
		const onClose = (reason: string) => {
			if (generation !== this.#generation) return;
			this.#pipe = undefined;
			clearInterval(this.#ping);
			const wasConnected = this.state.status === "connected";
			this.#set({ status: "disconnected", error: reason });
			if (wasConnected) this.emit("disconnected");
			if (!this.#stopped) {
				const delay = Math.min(30_000, 500 * 2 ** Math.min(this.state.attempts, 6));
				this.#timer = setTimeout(() => void this.#connect(), delay);
			}
		};
		try {
			if (this.config.kind === "local") {
				const socket: Socket = await connectOrStart(this.config.home);
				socket.on("data", onLine);
				socket.on("close", () => onClose(helloSeen ? "node connection closed" : "node closed before hello"));
				socket.on("error", () => {});
				this.#pipe = { write: (text) => socket.write(text), close: () => socket.destroy() };
			} else {
				const command = this.config.command ?? "ampi bridge";
				const args = [
					"-T",
					"-o",
					"BatchMode=yes",
					"-o",
					"ConnectTimeout=10",
					"-o",
					"ServerAliveInterval=15",
					"-o",
					"ServerAliveCountMax=3",
					...(this.config.sshArgs ?? []),
					"--",
					this.config.target ?? "",
					command,
				];
				const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
				this.#child = child;
				let stderr = "";
				child.stdout.on("data", onLine);
				child.stderr.on("data", (chunk: Buffer) => {
					stderr = (stderr + chunk.toString()).slice(-2000);
				});
				child.on("close", (code) =>
					onClose(helloSeen ? `ssh closed (${code})` : `ssh failed (${code}): ${stderr.trim().split("\n").pop() ?? ""}`),
				);
				child.on("error", (error) => onClose(error.message));
				// A write racing the link's end (EPIPE) must not become an uncaught exception that takes the hub down;
				// the close handler reports the link.
				child.stdin.on("error", () => {});
				this.#pipe = {
					write: (text) => {
						if (child.stdin.writable) child.stdin.write(text);
					},
					close: () => child.kill(),
				};
			}
			this.#ping = setInterval(() => {
				this.#pingSent = Date.now();
				this.#pipe?.write(encodeFrame({ t: "ping" }));
			}, 10_000);
		} catch (error) {
			onClose((error as Error).message);
		}
	}

	/** Drop the current connection and reconnect now (operator "reconnect"). */
	reconnect(): void {
		clearTimeout(this.#timer);
		this.#pipe?.close();
		this.#set({ attempts: 0 });
		if (this.state.status !== "connected") void this.#connect();
	}

	stop(): void {
		this.#stopped = true;
		clearTimeout(this.#timer);
		clearInterval(this.#ping);
		this.#pipe?.close();
		this.#child?.kill();
	}
}
