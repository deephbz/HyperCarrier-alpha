// ampi/1: the wire protocol between an AmPi node (owner of one pi-durable Harness on one host), the hub, and
// render-only clients. Frames are JSON objects, one per line on byte streams (unix socket, SSH stdio) and one per
// message on WebSockets. The node is the only authority; clients send requests and apply view deltas.

import type { Op } from "@earendil-works/chord/delta";

export const PROTOCOL = "ampi/1";

/** Request from a client. `id` is unique per connection; the response echoes it. */
export type RequestFrame = { t: "req"; id: number; op: string; args?: unknown };
export type ResponseFrame =
	| { t: "res"; id: number; ok: true; value?: unknown }
	| { t: "res"; id: number; ok: false; error: { code: string; message: string; pane?: string } };

/** Open a subscription to a topic; the node answers with one `snap` and then `ops` frames until `unsub`. */
export type SubscribeFrame = { t: "sub"; sid: number; topic: Topic };
export type UnsubscribeFrame = { t: "unsub"; sid: number };
export type SnapshotFrame = { t: "snap"; sid: number; value: unknown };
/** `n` counts ops frames since the snapshot (1, 2, …); a gap means the replica diverged and must resubscribe. */
export type OpsFrame = { t: "ops"; sid: number; n: number; ops: readonly Op[] };
export type SubscriptionEndFrame = { t: "end"; sid: number; reason: string };

/** Sent by the node first on every connection. */
export type HelloFrame = { t: "hello"; protocol: string; node: NodeInfo };

export type Topic =
	| { kind: "threads" }
	| { kind: "thread"; threadId: string }
	| { kind: "team"; teamId: string }
	| { kind: "rarebit"; threadId: string }
	| { kind: "terms" }
	| { kind: "term"; termId: string }
	| { kind: "login"; loginId: string }
	| { kind: "node" }
	/** A hub-side view of a Pi Host (src/pi/views): `view` names it; `threadId` scopes it to one Session. */
	| { kind: "view"; view: string; threadId?: string; [param: string]: unknown };

export type ClientFrame = RequestFrame | SubscribeFrame | UnsubscribeFrame | { t: "ping" };
export type NodeFrame =
	| HelloFrame
	| ResponseFrame
	| SnapshotFrame
	| OpsFrame
	| SubscriptionEndFrame
	| { t: "pong" };

export type NodeInfo = {
	/** Stable per storage: survives restarts. */
	nodeId: string;
	hostname: string;
	platform: string;
	user: string;
	home: string;
	version: string;
	/** Source fingerprint; differs from the hub's when the host runs an older or newer build. */
	build: string;
	pid: number;
	startedAt: number;
	storage: string;
};

/** Execution activity of a thread, derived from committed pi.live and pi.inbox (P5: one axis only). */
export type Activity = "idle" | "thinking" | "streaming" | "tools" | "retrying" | "compacting" | "waiting";

/** One row of the thread index, as clients see it. */
export type ThreadSummary = {
	id: string;
	title: string;
	cwd: string;
	createdAt: number;
	updatedAt: number;
	kind: "thread" | "worker" | "subagent" | "fork";
	parentId?: string;
	/** Team this thread leads or works for, when any. */
	team?: { teamId: string; role: "lead" | "worker"; worker?: string };
	archived?: boolean;
	model?: string;
	activity: Activity;
	queued: number;
	/** Last generation failure that ended a run; cleared by the next successful answer. */
	lastError?: string;
	/** Rarebit Summary status projection (C4), node Sessions only; undefined means unknown. */
	rarebit?: { status: string; reason?: string; asOf: number; fresh: boolean };
	/**
	 * Pi backend: the tier-2 Arc context head (C4, D16); undefined means not built. `asks` lists open Needs-you asks
	 * per kind with the oldest ask time (ms, null when unknown); `finished` means every tier-2 thread is done and
	 * nothing is open. An Assessment, never runtime, Task, or Project truth.
	 */
	arc?: { builtAt: string; stale: boolean; newMessages: number; finished: boolean; asks: { kind: "decision" | "approval" | "input" | "blocker"; n: number; since: number | null }[]; overtaken?: number };
	/** Positive evidence from other authorities that the owner is needed (for example a blocked or failed Task). */
	attention?: { source: string; reason: string }[];
	costUsd: number;
	contextTokens?: number;
	contextWindow?: number;
	workingBudget?: number;
	/** Pi backend: percent of the latest assistant prompt read from cache. */
	cacheHit?: number;
	/** The newest user/assistant prose, at most 160 characters, for the sidebar. */
	preview?: string;
	/** Pi backend: Host-qualified citation of the Session (`<host>/pi:<id>`). */
	ref?: string;
	/** Pi backend: where Herdr shows this Session. Auxiliary layout, not identity. */
	location?: { workspace?: string; workspaceLabel?: string; tab?: string; tabLabel?: string; pane?: string };
	/** Pi backend: a pane or the control extension runs this Session now. */
	live?: boolean;
	/** Pi backend: actions go through the control extension (admission evidence), not keys. */
	control?: boolean;
};

/** Herdr's workspace → tab → pane order on a Pi Host. */
export type HerdrLayout = { workspaces: { id: string; label?: string; tabs: { id: string; label?: string; panes: string[] }[] }[] };

export type ThreadsState = { threads: Record<string, ThreadSummary>; layout?: HerdrLayout; backend?: "pi" };
