// A Team input's origin, read from its `team.notice` entry data. The node names queued inputs with it, and the hub
// names delivered inputs in a durable transcript with it, so the queue row and the transcript row read alike.
import { injectedMessage } from "./entry-shapes.ts";
import type { InjectedMessage, QueueOrigin } from "./protocol.ts";

const DELIVERIES = new Set<QueueOrigin["delivery"]>(["task", "alert", "stop", "update"]);
const SUMMARY_LIMIT = 200;
const SENDER_LIMIT = 64;
/** durable-team's TASK_ID_MAX_LENGTH, copied so the hub reader does not load durable-team; a test pins the two equal. */
export const TEAM_TASK_ID_LIMIT = 128;
const line = (text: unknown) => (typeof text === "string" ? (text.split("\n").find((l) => l.trim()) ?? "").trim() : "");

/**
 * A Team input's origin from its `team.notice` entry data (durable-team's TeamNoticeData). The text only supplies the
 * readable summary: a Task's title, an Alert's first line, a stop's Task ID. A summary never shows the JSON it came from.
 * An entry from an older producer has no `delivery` and no `sender`, so it reads as a generic Team notice. Only the data
 * marks an interrupt Alert; the interruption outcome in the text is for the model.
 */
export function queueOrigin(entry: { kind?: unknown; data?: unknown } | undefined, text: string): QueueOrigin | undefined {
	const data = entry?.kind === "team.notice" && entry.data && typeof entry.data === "object" ? (entry.data as Record<string, unknown>) : undefined;
	if (data?.source !== "team" || (typeof data.deliveryId !== "string" && typeof data.pageId !== "string")) return undefined;
	const delivery = DELIVERIES.has(data.delivery as never) ? (data.delivery as QueueOrigin["delivery"]) : "notice";
	const sender = typeof data.sender === "string" && data.sender.trim() ? data.sender.trim().slice(0, SENDER_LIMIT) : undefined;
	// biome-ignore lint: the payload is parsed loosely; each field is checked where it is read
	let payload: any;
	try {
		payload = JSON.parse(text);
	} catch {}
	const task = delivery === "task" ? payload?.task?.id : delivery === "stop" ? payload?.task_id : undefined;
	// A Task ID is exact or absent: a cut ID could name another Task, so an invalid one leaves the generic text.
	const taskId = typeof task === "string" && task.length > 0 && task.length <= TEAM_TASK_ID_LIMIT ? task : undefined;
	let summary = "";
	if (delivery === "task") summary = line(payload?.task?.title) || (taskId ? `Task ${taskId}` : "");
	else if (delivery === "alert") summary = line(payload?.alert?.text);
	else if (delivery === "stop") summary = taskId ? `Attempt superseded; re-read Task ${taskId}` : "Attempt superseded; re-read Task authority";
	else if (delivery === "update") summary = "Team update";
	if (!summary) summary = "Team notice";
	const interrupt = delivery === "alert" && data.interrupt === true;
	return { kind: "team", delivery, ...(interrupt ? { interrupt: true as const } : {}), ...(sender ? { sender } : {}), summary: summary.slice(0, SUMMARY_LIMIT), ...(taskId ? { taskId } : {}) };
}

const BADGES: Record<QueueOrigin["delivery"], string> = { task: "task", alert: "alert", stop: "task changed", update: "team update", notice: "team notice" };
/** The kind badge of a Team input, in the queue and in the transcript. */
export function teamBadge(origin: Pick<QueueOrigin, "delivery" | "interrupt">): string {
	return origin.interrupt ? `${BADGES[origin.delivery]} · interrupt` : BADGES[origin.delivery];
}

/**
 * A delivered Team input as its transcript notice row shows it: the badge and author from the entry data, then the
 * summary line and the payload's readable fields. The row never shows the JSON the model reads, and never the
 * interruption outcome. An update or older notice keeps its text in the collapsed body, fenced only when it is JSON.
 * Undefined when the data names no Team origin.
 */
export function teamNoticeMessage(data: unknown, text: string): InjectedMessage | undefined {
	const origin = queueOrigin({ kind: "team.notice", data }, text);
	if (!origin) return undefined;
	// biome-ignore lint: the payload is parsed loosely; each field is checked where it is read
	let payload: any;
	try {
		payload = JSON.parse(text);
	} catch {}
	const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
	let body: string;
	if (origin.delivery === "alert") body = str(payload?.alert?.text) || origin.summary;
	else if (origin.delivery === "task") body = [origin.summary, str(payload?.task?.goal)].filter(Boolean).join("\n\n");
	else if (origin.delivery === "stop") body = [origin.summary, str(payload?.message)].filter(Boolean).join("\n\n");
	else if (!text.trim()) body = origin.summary;
	else body = payload === undefined ? `${origin.summary}\n\n${text.trim()}` : `${origin.summary}\n\n\`\`\`json\n${text.trim()}\n\`\`\``;
	return { kind: origin.delivery === "alert" ? "alert" : "team-update", label: teamBadge(origin), ...(origin.sender ? { sender: origin.sender } : {}), text: body };
}

/**
 * The notice row's message for a custom entry, on every path to the owner: the hub copy, the node's own projection
 * (a thread the hub holds no copy of), and the transcript's fallback for an older node that sends none.
 */
export function noticeMessage(entryKind: string, data: unknown, text: string): InjectedMessage {
	return (entryKind === "team.notice" && teamNoticeMessage(data, text)) || injectedMessage(entryKind, text);
}
