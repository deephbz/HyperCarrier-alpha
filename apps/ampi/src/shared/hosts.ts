// Host configuration and state types for the wire contract.
// Hub host links produce these values; Pi adapters and web host consumers read them.
import type { NodeInfo } from "./protocol.ts";

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

/** What a negotiating link waits for: its transport (node socket, ssh, agent process), then the hello. */
export type LinkPhase = "transport" | "hello";

/**
 * Why a link failed. A build failure needs an update or `npm run prepare`, because the hub or the node runs the wrong
 * build or protocol; a retry cannot fix it. A reachability failure (the Host, ssh, the node process) can end with a
 * retry. A status without a class, as from an older hub, counts as reachability.
 */
export type ErrorClass = "build" | "reachability";

/**
 * A link's status. Every status but connected carries since when it holds, a hint that says what the link does or
 * what to do next, and the last failure, which stays through retries until a hello proves recovery. Connecting also
 * names its phase, and disconnected names its failure. So no view can show a bare "connecting" without its reason.
 */
export type LinkStatus =
	| { status: "connected"; connectedAt: number; since?: never; phase?: never; hint?: never; error?: never; errorClass?: never; retryAt?: never }
	| { status: "connecting"; phase: LinkPhase; since: number; hint: string; error?: string; errorClass?: ErrorClass; connectedAt?: never; retryAt?: never }
	| {
			status: "disconnected";
			since: number;
			error: string;
			errorClass?: ErrorClass;
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
	/**
	 * A Pi Host's re-derive after a start: `total` Session copies had no head of this build's derivation (an upgrade
	 * bumped it, or no head was saved), and `updated` of them have settled. Their rows list by identity only, marked
	 * updating. Absent when none remains.
	 */
	upgrade?: { updated: number; total: number };
	/**
	 * Frames after the hello that threw in this hub since it started, and the last such error. The link stays up, so a
	 * link that keeps throwing shows here.
	 */
	frameErrors?: number;
	lastFrameError?: string;
	/** The hub's route to this Host's source, `<id>#pi` or `<id>#durable`. Set by the hub; the web names a link by it. */
	link?: string;
};

export type HostState = HostBase & LinkStatus;
