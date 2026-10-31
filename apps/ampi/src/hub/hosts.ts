// Host links: the hub's connection to each AmPi node, local (unix socket) or remote (`ssh <target> ampi bridge`).
// A link reconnects with backoff and reports its own state; it never falls back to another host (writes are exact).

import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { join } from "node:path";
import { encodeFrame, lineReader } from "../shared/framing.ts";
import { type ClientFrame, type NodeFrame, type NodeInfo, PROTOCOL } from "../shared/protocol.ts";
import { ampiHome, connectOrStart, socketPath } from "../node/daemon.ts";
import { sameBuild } from "../shared/build.ts";

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
	/** Durable kinds: replaces Pi for views' model calls on the hub (src/pi/ask.ts), as `PiHostConfig.askCommand`. */
	askCommand?: string[];
};

/** What a negotiating link waits for: its transport (node socket, ssh, agent process), then the hello. */
export type LinkPhase = "transport" | "hello";

/**
 * A link's status. Every status but connected carries since when it holds, a hint that says what the link does or
 * what to do next, and the last failure, which stays through retries until a hello proves recovery. Connecting also
 * names its phase, and disconnected names its failure. So no view can show a bare "connecting" without its reason.
 */
export type LinkStatus =
	| { status: "connected"; connectedAt: number; since?: never; phase?: never; hint?: never; error?: never; retryAt?: never }
	| { status: "connecting"; phase: LinkPhase; since: number; hint: string; error?: string; connectedAt?: never; retryAt?: never }
	| {
			status: "disconnected";
			since: number;
			error: string;
			hint: string;
			/** When the next attempt starts; absent when the link stopped. */
			retryAt?: number;
			connectedAt?: never;
			phase?: never;
	  };

export type HostBase = {
	id: string;
	label: string;
	kind: HostConfig["kind"];
	target?: string;
	node?: NodeInfo;
	lastSeen?: number;
	attempts: number;
	latencyMs?: number;
	/** The node runs a different AmPi build than this hub (it predates an update); restart it to pick up the new one. */
	buildMismatch?: boolean;
	/** A Pi Host's working-set init failed: the Host serves no copies until the hub restarts; `error` says why. */
	cacheFailed?: true;
	/**
	 * A Pi Host's last index write failed for this reason. It is cache health, not link status: the link stays as it
	 * is, and the next successful write clears it. Until then a restarted hub cannot resume from the saved offsets.
	 */
	indexError?: string;
	/**
	 * A Pi Host's stale reads since start: its read connection answered with an older head than the derive Worker
	 * committed. Cache health, like indexError. `reopened` counts repairs by a fresh connection; `behind` counts reads
	 * still older after that repair, so the hub adopted the Worker's result; `refused` counts publish reads that a
	 * version check refused, each retried by a later publish. A healthy hub has none.
	 */
	staleReads?: { reopened: number; behind: number; refused: number };
	/**
	 * A Pi Host's cache fault: Session copies whose reads stay behind the derive Worker after a reopen. Each such
	 * copy carries a readError; its next commit reopens and checks again, and a clean check clears it.
	 */
	cacheFault?: string;
	/** The hub's route to this Host's source, `<id>#pi` or `<id>#durable`. Set by the hub; the web names a link by it. */
	link?: string;
};

export type HostState = HostBase & LinkStatus;

const STATUS_KEYS = ["status", "connectedAt", "since", "phase", "hint", "error", "retryAt"] as const;

/** `state` with its status replaced by `next`: no field of the old status outlives it. */
export function withStatus(state: HostState, next: LinkStatus): HostState {
	const base: Record<string, unknown> = { ...state };
	for (const key of STATUS_KEYS) delete base[key];
	return { ...(base as HostBase), ...next };
}

/** A negotiating status that keeps the last failure, so a retry never hides why the link is not connected. */
export function negotiating(state: HostState, phase: LinkPhase, hint: string, now = Date.now()): LinkStatus {
	return { status: "connecting", phase, since: now, hint, ...(state.error ? { error: state.error } : {}) };
}

/** The route key of one source on one Host. One Host ID can carry a Pi source and a durable source. */
export function linkKey(config: { id: string; kind: HostConfig["kind"] }): string {
	return `${config.id}#${config.kind === "pi-local" || config.kind === "pi-ssh" ? "pi" : "durable"}`;
}

type Pipe = { write(text: string): void; close(): void };

const UPDATE_HINT = "Update AmPi on the host and stop its node; the next connection starts the new build.";

export class HostLink extends EventEmitter {
	/**
	 * A negotiation (transport, then hello) that takes longer fails. A peer that accepts and stays silent sends no event
	 * that would end it, so only a deadline can.
	 */
	static NEGOTIATE_MS = 30_000;
	/** A connected node answers the hub's ping every PING_MS; a link with no frame for SILENT_MS is dead. */
	static SILENT_MS = 30_000;
	static SILENT_TICK_MS = 5_000;
	static PING_MS = 10_000;
	/** Opens a local node's socket, starting the node when nothing answers. Tests replace it to script a slow start. */
	static connectNode: (home?: string) => Promise<Socket> = connectOrStart;

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
			attempts: 0,
			status: "connecting",
			phase: "transport",
			since: Date.now(),
			hint: "The hub has not started this link yet.",
		};
	}

	/** Changes base fields and, with `status`, the status; one state event either way. */
	#set(change: Partial<HostBase>, status?: LinkStatus): void {
		const next: Record<string, unknown> = { ...(status ? withStatus(this.state, status) : this.state), ...change };
		for (const key of Object.keys(change)) if (change[key as keyof HostBase] === undefined) delete next[key];
		this.state = next as HostState;
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

	/** Where the node behind this link runs, for hints. */
	#where(): { local: boolean; ssh: string; log: string; socket: string } {
		const home = this.config.home ?? ampiHome();
		return {
			local: this.config.kind === "local",
			ssh: `ssh ${this.config.target ?? ""} ${this.config.command ?? "ampi bridge"}`,
			log: join(home, "node.log"),
			socket: socketPath(home),
		};
	}

	async #connect(): Promise<void> {
		if (this.#stopped) return;
		const generation = ++this.#generation;
		const where = this.#where();
		const seconds = Math.round(HostLink.NEGOTIATE_MS / 1000);
		this.#set(
			{ attempts: this.state.attempts + 1 },
			negotiating(
				this.state,
				"transport",
				where.local ? `Opening the node socket ${where.socket}; the hub starts the node when nothing answers.` : `Running \`${where.ssh}\`.`,
			),
		);
		let helloSeen = false;
		let bytes = 0;
		let ignored = "";
		let heard = Date.now();
		// The first failure this attempt diagnosed; the close it causes reports it instead of a generic reason.
		let failure: { error: string; hint: string } | undefined;
		const awaitHello = () => {
			if (this.state.status === "connecting" && this.state.phase === "transport")
				this.#set({}, negotiating(this.state, "hello", where.local ? "The node socket is open; waiting for the node's hello." : "ssh is open; waiting for the node's hello from the bridge."));
		};
		const fail = (error: string, hint: string) => {
			if (generation !== this.#generation || failure || attempt.ended) return;
			failure = { error, hint };
			if (this.#pipe) this.#pipe.close();
			else attempt.end(error, hint);
		};
		const deadline = setTimeout(() => {
			if (helloSeen) return;
			if (this.state.status === "connecting" && this.state.phase === "transport")
				fail(
					where.local ? `No node socket after ${seconds} s.` : `ssh sent nothing in ${seconds} s.`,
					where.local ? `Run ampi doctor; the node log is ${where.log}.` : `Run \`${where.ssh}\` in a terminal; it must print the node's hello.`,
				);
			else if (bytes === 0)
				fail(
					where.local ? `The node socket accepted the connection but sent no hello in ${seconds} s.` : `The bridge connected but the node sent no hello in ${seconds} s.`,
					where.local
						? `The node may be stuck, or another program answers at ${where.socket}. Run ampi doctor; stopping the node lets the next attempt start a fresh one.`
						: `The node on ${this.config.target ?? "the host"} may be stuck. Run \`ssh ${this.config.target ?? ""} ampi doctor\`.`,
				);
			else
				fail(
					`The node sent ${bytes} bytes but no valid hello in ${seconds} s${ignored ? `; it sent: ${ignored}` : ""}.`,
					where.local ? UPDATE_HINT : `The host may run an older AmPi, or its shell startup prints text. ${UPDATE_HINT}`,
				);
		}, HostLink.NEGOTIATE_MS);
		// After the hello, the ping keeps frames coming; silence means a stalled node or link, which may never close.
		// A hub that was itself suspended (the Mac slept) restarts the clock instead of blaming the node.
		let ticked = Date.now();
		const watchdog = setInterval(() => {
			if (generation !== this.#generation) return retire();
			const now = Date.now();
			if (now - ticked > 3 * HostLink.SILENT_TICK_MS) heard = now;
			ticked = now;
			if (!helloSeen || now - heard <= HostLink.SILENT_MS) return;
			fail(
				`No frame from the node for ${Math.round((now - heard) / 1000)} s, though the hub pings every ${Math.round(HostLink.PING_MS / 1000)} s.`,
				"The node or its connection stalled. The hub reconnects; if this repeats, run ampi doctor on the host.",
			);
		}, HostLink.SILENT_TICK_MS);
		watchdog.unref();
		const onFrame = (frame: NodeFrame) => {
			this.#set({ lastSeen: Date.now() });
			if (frame.t === "hello") {
				if (frame.protocol !== PROTOCOL) {
					// A node from another protocol generation would misread every frame; refuse it instead of half-working.
					if (frame.node) this.#set({ node: frame.node });
					fail(
						`The node on this host speaks ${String(frame.protocol)}; this hub speaks ${PROTOCOL}.`,
						`Update AmPi on the host and stop its node${frame.node?.pid ? ` (pid ${frame.node.pid})` : ""}; the next connection starts the new build.`,
					);
					return;
				}
				if (typeof frame.node !== "object" || frame.node === null) {
					fail("The node sent a hello this hub cannot read: it names no node.", UPDATE_HINT);
					return;
				}
				helloSeen = true;
				clearTimeout(deadline);
				this.#set({ node: frame.node, attempts: 0, buildMismatch: sameBuild(frame.node.build) ? undefined : true }, { status: "connected", connectedAt: Date.now() });
				this.emit("connected");
				return;
			}
			if (!helloSeen) {
				ignored = `a ${String(frame.t)} frame before the hello`;
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
				if (generation !== this.#generation) return;
				let frame: NodeFrame;
				try {
					frame = JSON.parse(line) as NodeFrame;
				} catch {
					if (!helloSeen) ignored = JSON.stringify(line.length > 80 ? `${line.slice(0, 80)}…` : line);
					return;
				}
				try {
					onFrame(frame);
				} catch (error) {
					if (!helloSeen) fail(`The node's hello broke this hub: ${(error as Error).message}.`, UPDATE_HINT);
				}
			},
			() => fail("The node sent a line longer than the frame limit.", UPDATE_HINT),
		);
		const onData = (chunk: Buffer) => {
			if (generation !== this.#generation) return;
			bytes += chunk.length;
			heard = Date.now();
			awaitHello();
			onLine(chunk);
		};
		// Each attempt owns its timers and ends them itself; a later attempt never inherits them.
		let ping: ReturnType<typeof setInterval> | undefined;
		const retire = () => {
			clearTimeout(deadline);
			clearInterval(watchdog);
			clearInterval(ping);
		};
		// One attempt ends once. Every end path (a close, an ssh spawn error, a failed node start, a diagnosed failure)
		// calls end(), and only the first call acts; so one attempt schedules at most one retry.
		const attempt = {
			ended: false,
			end: (reason: string, hint: string) => {
				if (attempt.ended) return;
				attempt.ended = true;
				retire();
				if (generation !== this.#generation) return;
				this.#pipe = undefined;
				const wasConnected = this.state.status === "connected";
				const delay = Math.min(30_000, 500 * 2 ** Math.min(this.state.attempts, 6));
				const now = Date.now();
				this.#set({}, { status: "disconnected", since: now, error: failure?.error ?? reason, hint: failure?.hint ?? hint, ...(this.#stopped ? {} : { retryAt: now + delay }) });
				if (wasConnected) this.emit("disconnected");
				if (!this.#stopped) this.#timer = setTimeout(() => void this.#connect(), delay);
			},
		};
		try {
			if (where.local) {
				const socket: Socket = await HostLink.connectNode(this.config.home);
				// The deadline, a stop, or a reconnect ended this attempt while the node started.
				if (generation !== this.#generation || attempt.ended || this.#stopped) {
					socket.destroy();
					return;
				}
				socket.on("data", onData);
				socket.on("close", () =>
					attempt.end(
						helloSeen ? "The node connection closed." : "The node closed the connection before its hello.",
						helloSeen ? "The hub reconnects." : `The node log says why: ${where.log}. Run ampi doctor.`,
					),
				);
				socket.on("error", () => {});
				this.#pipe = { write: (text) => socket.write(text), close: () => socket.destroy() };
				awaitHello();
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
				child.stdout.on("data", onData);
				child.stderr.on("data", (chunk: Buffer) => {
					stderr = (stderr + chunk.toString()).slice(-2000);
				});
				child.on("close", (code) => {
					const last = stderr.trim().split("\n").pop() ?? "";
					if (helloSeen) attempt.end(`ssh closed (${code}).`, "The hub reconnects.");
					else attempt.end(`ssh failed (${code})${last ? `: ${last}` : ""}.`, `Run \`${where.ssh}\` in a terminal to see the whole error.`);
				});
				child.on("error", (error) => attempt.end(error.message, "Check that ssh is installed and on the hub's PATH."));
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
			const pipe = this.#pipe;
			ping = setInterval(() => {
				this.#pingSent = Date.now();
				pipe?.write(encodeFrame({ t: "ping" }));
			}, HostLink.PING_MS);
			this.#ping = ping;
		} catch (error) {
			attempt.end((error as Error).message, `Run ampi doctor; the node log is ${where.log}.`);
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
