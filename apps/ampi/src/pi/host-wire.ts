// Wire readers for Host op requests and agent acks; the op table stays in host.ts (PiHost #hostOps). `defined`
// lives here because the readers need it and this module must not import host.ts.

import type { ActionAck, CommandAck, ControlSubmission, Every, HostOps, OpHandlers, OpRequest, SlashCommands, SubmittedPrompt } from "../shared/protocol.ts";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A command's acknowledgement from the remote agent; `ok: false` carries the refusal. */
export type AgentAck = {
	t: "ack"; id: number; ok: boolean; error?: string | { code?: string; message?: string; matches?: unknown[] }; pane?: string; name?: string;
	via?: string; evidence?: string; entryId?: string; submission?: string; submissions?: unknown[]; submitted?: SubmittedPrompt; warning?: string;
	watermark?: { size: number; mtimeMs: number };
	/** Slash commands: the `commands` list, or one command's outcome. */
	value?: SlashCommands; disposition?: CommandAck["disposition"]; notice?: string; effect?: CommandAck["effect"];
};

/** Replicated values are JSON: chord's diff cannot carry `undefined`, so drop such keys. */
export function defined<T extends Record<string, unknown>>(value: T): T {
	for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
	return value;
}

/**
 * The one reader of a control's submission record (pi-hc-control status and abort, relayed by the remote agent). The
 * status, submit and abort paths all read records through it, so each field reaches the hub on every path.
 */
function controlSubmission(raw: unknown): ControlSubmission | undefined {
	const r = raw as Record<string, unknown> | null;
	if (typeof r?.submission !== "string") return undefined;
	const record: Every<ControlSubmission> = {
		submission: r.submission,
		deliverAs: r.deliverAs === "steer" ? "steer" : "followUp",
		state: r.state as ControlSubmission["state"],
		at: Number(r.at),
		entryId: typeof r.entryId === "string" ? r.entryId : undefined,
		text: typeof r.text === "string" ? r.text : undefined,
		truncated: r.truncated === true || undefined,
		images: typeof r.images === "number" && r.images > 0 ? r.images : undefined,
		// A Pi control records no origin (QueueOrigin): its queue holds the owner's input only.
		origin: undefined,
	};
	return defined(record) as ControlSubmission;
}
export const controlSubmissions = (raw: unknown[]): ControlSubmission[] => raw.map(controlSubmission).filter((r) => r !== undefined);

/**
 * An action's reply: how it was delivered, its evidence, the Session entry it made when the Host names one, the
 * queued submission it made, and, for abort, what became of each queued submission.
 */
export function ackResult(ack: AgentAck): ActionAck {
	return defined({
		via: ack.via,
		evidence: ack.evidence,
		entryId: typeof ack.entryId === "string" ? ack.entryId : undefined,
		submission: typeof ack.submission === "string" ? ack.submission : undefined,
		submissions: Array.isArray(ack.submissions) ? controlSubmissions(ack.submissions) : undefined,
	});
}

/** A `thread.submit` request's images, text and delivery. Refuses an empty message, and slash text an older page sent. */
export function submitArgs(args: HostOps["thread.submit"]["args"]): { images: { data: string; mimeType: string }[]; text: string; deliverAs: "steer" | "followUp" } {
	const images = Array.isArray(args.images) ? args.images.map((i: { data?: unknown; mimeType?: unknown }) => ({ data: String(i?.data ?? ""), mimeType: String(i?.mimeType ?? "") })) : [];
	const text = String(args.content ?? "");
	if (!text.trim() && !images.length) throw Object.assign(new Error("Empty message"), { code: "invalid" });
	// Pi runs plain slash text as a command. A page built before `asText` sends a command it could not type
	// this way, so slash text goes as a message only when the owner chose it, before any route is chosen.
	// `unsupported`: the code older pages already show as a final refusal (composer-outcomes FINAL_REFUSAL).
	if (!images.length && text.trim().startsWith("/") && args.asText !== true)
		throw Object.assign(new Error("This page is older than the hub. Reload it."), { code: "unsupported" });
	const deliverAs = args.whenBusy === "steer" ? "steer" : "followUp";
	return { images, text, deliverAs };
}

/** A `thread.command` request as the frame the remote agent takes. */
export function commandFrame(args: HostOps["thread.command"]["args"]): { name: string; deliverAs: "steer" | undefined; cmd: Record<string, unknown> } {
	// The composer decides a draft is a command; the Host routes it by name and never sends it as a message.
	const name = String(args.name ?? "");
	const deliverAs = args.whenBusy === "steer" ? "steer" : undefined;
	const cmd = defined({
		t: "command",
		name,
		args: typeof args.args === "string" ? args.args : undefined,
		key: typeof args.key === "string" ? args.key : undefined,
		abort: args.abort === true ? true : undefined,
		deliverAs,
	});
	return { name, deliverAs, cmd };
}

/** A slash command's reply. Refuses an ack without a disposition: the outcome is unknown. */
export function commandResult(ack: AgentAck): CommandAck {
	if (!ack.disposition) throw Object.assign(new Error("The control sent no disposition; the outcome is unknown"), { code: "control_unconfirmed" });
	const result: CommandAck = defined({
		via: ack.via,
		disposition: ack.disposition,
		notice: typeof ack.notice === "string" ? ack.notice : undefined,
		effect: ack.effect && typeof ack.effect === "object" ? ack.effect : undefined,
		evidence: ack.evidence,
		entryId: typeof ack.entryId === "string" ? ack.entryId : undefined,
		submission: typeof ack.submission === "string" ? ack.submission : undefined,
	});
	return result;
}

/** The `threadId` a request names, if any. */
export function threadOf(args: unknown): string | undefined {
	return typeof args === "object" && args !== null && "threadId" in args && typeof args.threadId === "string" ? args.threadId : undefined;
}

/** Narrows a wire request to an op the table serves. Its arguments stay the sender's JSON. */
export function isOpRequest(ops: OpHandlers, request: { op: string; args: unknown }): request is OpRequest {
	return Object.hasOwn(ops, request.op);
}
