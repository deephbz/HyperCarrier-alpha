// Builds the modeled Pi entry shapes (protocol.ts) from native values: a tool call's arguments and a message an
// extension injected. The Pi projection is their only caller (docs/wire-boundary.md, rule 1 and design 4).
import type { InjectedMessage, ToolArgsOmitted, ToolArgsPreview } from "./protocol.ts";

type Args = Record<string, unknown>;

function one(value: unknown, max = 160): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	const flat = (text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
const str = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : "");

/** The call's one line, as the tool row's head shows it. */
export function argSummary(name: string, args: Args): string {
	switch (name) {
		case "bash":
			return one(args.command);
		case "read":
			return `${str(args.path)}${args.offset ? ` :${str(args.offset)}` : ""}${args.limit ? `+${str(args.limit)}` : ""}`;
		case "write":
			return `${str(args.path)}${typeof args.content === "string" ? ` · ${args.content.replace(/\n$/, "").split("\n").length} lines` : ""}`;
		case "edit":
			return `${str(args.path)}${Array.isArray(args.edits) ? ` · ${args.edits.length} edit(s)` : ""}`;
		case "task_update":
			return `${str(args.task_id)}${args.transition ? ` → ${str(args.transition)}` : ""}${args.current_context ? " · context" : ""}`;
		case "task_graph_apply":
			return `${Array.isArray(args.tasks) ? args.tasks.length : 0} task(s) · ${str(args.operation_id)}`;
		case "ensure_worker":
			return `${str(args.name)} — ${one(args.scope, 80)}`;
		case "alert_send":
			return `${args.to ? `${str(args.to)} · ` : ""}${str(args.kind)}: ${one(args.text, 100)}`;
		case "team_create":
			return `${str(args.name)} — ${one(args.purpose, 80)}`;
		default:
			return one(args);
	}
}

const SUMMARY_CHARS = 300, COMMAND_CHARS = 2000, PATH_CHARS = 220;
const PATH_KEYS = ["path", "file_path", "filePath", "file", "target"];

/**
 * A tool call's whole arguments as one preview: the summary, the targets (each capped), the change (`edits`,
 * `content`) and every other argument as `text`. The full entry serves it whole; boundToolArgs bounds a stored row.
 */
export function toolArgsPreview(name: string, raw: unknown): ToolArgsPreview {
	const args: Args = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Args) : {};
	const used = new Set<string>();
	const take = (key: string | undefined, max: number) => {
		if (key === undefined || typeof args[key] !== "string") return undefined;
		used.add(key);
		return (args[key] as string).slice(0, max);
	};
	const command = take("command", COMMAND_CHARS);
	const path = take(PATH_KEYS.find((key) => typeof args[key] === "string"), PATH_CHARS);
	const paths = Array.isArray(args.paths) ? (used.add("paths"), args.paths.filter((p): p is string => typeof p === "string").map((p) => p.slice(0, PATH_CHARS))) : undefined;
	const list = Array.isArray(args.edits) ? (args.edits as unknown[]) : undefined;
	const edits = list?.every((e) => e && typeof e === "object" && typeof (e as Args).oldText === "string" && typeof (e as Args).newText === "string")
		? (used.add("edits"), list.map((e) => ({ oldText: (e as Args).oldText as string, newText: (e as Args).newText as string })))
		: undefined;
	const content = take("content", Number.POSITIVE_INFINITY);
	const rest = Object.fromEntries(Object.entries(args).filter(([key]) => !used.has(key)));
	const text = Object.keys(rest).length ? JSON.stringify(rest, null, 2) : undefined;
	return {
		summary: argSummary(name, args).slice(0, SUMMARY_CHARS),
		...(command !== undefined ? { command } : {}),
		...(path !== undefined ? { path } : {}),
		...(paths ? { paths } : {}),
		...(edits ? { edits } : {}), ...(content !== undefined ? { content } : {}), ...(text !== undefined ? { text } : {}) };
}

const size = (value: unknown) => JSON.stringify(value).length;
/** The smallest limit boundToolArgs accepts: `{"summary":"","omitted":{…}}` with every key and two 10-digit counts is 133. */
export const TOOL_ARGS_MIN = 160;

/** The longest prefix of `text` for which `fits` holds, never ending inside a surrogate pair. */
function longest(text: string, fits: (prefix: string) => boolean): string {
	const cut = (n: number) => text.slice(0, /[\uD800-\uDBFF]/.test(text[n - 1] ?? "") ? n - 1 : n);
	let low = 0, high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (fits(cut(mid))) low = mid;
		else high = mid - 1;
	}
	return cut(low);
}

/**
 * Bounds a preview to `limit` characters of serialized JSON. A preview within the limit returns unchanged. Past it
 * the preview fills in order, measured in JSON: the summary, the path, the command cut to the remaining budget, then
 * whole paths from the front; the change and `text` drop. `omitted` names every cut, and `clipped` holds iff one
 * happened. `limit` must be at least TOOL_ARGS_MIN, which fits an empty summary with the largest `omitted`.
 */
export function boundToolArgs(args: ToolArgsPreview, limit: number): { args: ToolArgsPreview; clipped: boolean } {
	if (!(limit >= TOOL_ARGS_MIN)) throw new RangeError(`tool-args limit ${limit} is below ${TOOL_ARGS_MIN}`);
	if (size(args) <= limit) return { args, clipped: false };
	const { summary, path, command, paths = [], edits, content, text } = args;
	const omitted: ToolArgsOmitted = {
		...(edits ? { edits: edits.length } : {}),
		...(content !== undefined ? { content: true } : {}),
		...(text !== undefined ? { text: true } : {}),
	};
	// Reserve room for the largest `omitted` this preview can need, so later cuts never break the bound.
	const reserve: ToolArgsOmitted = { ...omitted, summary: true, ...(path !== undefined ? { path: true } : {}), ...(command !== undefined ? { command: true } : {}), ...(paths.length ? { paths: paths.length } : {}) };
	const out: ToolArgsPreview = { summary: "" };
	const fits = (extra: Partial<ToolArgsPreview>) => size({ ...out, ...extra, omitted: reserve }) <= limit;
	out.summary = longest(summary, (s) => fits({ summary: s }));
	if (out.summary !== summary) omitted.summary = true;
	if (path !== undefined) {
		if (fits({ path })) out.path = path;
		else omitted.path = true;
	}
	if (command !== undefined) {
		const kept = longest(command, (c) => fits({ command: c }));
		if (kept !== "") out.command = kept;
		if (kept !== command) omitted.command = true;
	}
	let kept = 0;
	while (kept < paths.length && fits({ paths: paths.slice(0, kept + 1) })) kept++;
	if (kept) out.paths = paths.slice(0, kept);
	if (kept < paths.length) omitted.paths = paths.length - kept;
	out.omitted = omitted;
	return { args: out, clipped: true };
}

/** A Pi Team Bright delivery: a preamble line, then `{ messages: [{ from, content }] }`. A shortened text still yields its first message. */
function deliveredMessages(text: string): { from?: string; text: string }[] {
	const start = text.indexOf("{");
	if (start < 0) return [];
	try {
		const { messages } = JSON.parse(text.slice(start)) as { messages?: { from?: unknown; content?: unknown }[] };
		if (Array.isArray(messages)) return messages.map((m) => ({ ...(typeof m.from === "string" ? { from: m.from } : {}), text: String(m.content ?? "") }));
	} catch {}
	const unquote = (s: string) => {
		try {
			return JSON.parse(`"${s.replace(/\\+$/, (tail) => (tail.length % 2 ? tail.slice(1) : tail))}"`) as string;
		} catch {
			return s;
		}
	};
	const from = /"from":\s*"((?:[^"\\]|\\.)*)"/.exec(text), content = /"content":\s*"((?:[^"\\]|\\.)*)/.exec(text);
	return content ? [{ ...(from ? { from: unquote(from[1]!) } : {}), text: unquote(content[1]!) }] : [];
}

/** One injected message from its extension's entry kind and text. Unknown kinds keep their text as `other`, or `alert` when their kind names one. */
export function injectedMessage(entryKind: string, text: string): InjectedMessage {
	if (entryKind === "intercom_message") {
		const head = /^\*\*From (.+?)\*\*[^\n]*\n+(?:_[^\n]*_\n+)?/.exec(text);
		return { kind: "intercom", label: "intercom", ...(head ? { sender: head[1]! } : {}), text: head ? text.slice(head[0].length) : text };
	}
	if (entryKind.startsWith("pi-team-bright.")) {
		const messages = deliveredMessages(text);
		if (messages.length) {
			const alert = /^\[PiTeams [^\]]*Alert\b/.test(messages[0]!.text);
			const event = entryKind.slice("pi-team-bright.".length);
			const senders = [...new Set(messages.flatMap((m) => (m.from ? [m.from] : [])))];
			return {
				kind: alert ? "alert" : event === "direct-message" ? "direct-message" : "team-update",
				label: alert ? "alert" : event.replaceAll("-", " "),
				...(senders.length ? { sender: senders.join(", ") } : {}),
				text: messages[0]!.text,
				...(messages.length > 1 ? { parts: messages } : {}),
			};
		}
	}
	if (entryKind.startsWith("auto-compact.")) return { kind: "auto-compact", label: entryKind.slice("auto-compact.".length), sender: "Auto Compact", text };
	return { kind: entryKind.includes("alert") ? "alert" : "other", label: entryKind, text };
}

/** Shortens a message to `limit` characters across its text and parts; `clipped` says whether anything was cut. */
export function clipInjected(message: InjectedMessage, limit: number): { message: InjectedMessage; clipped: boolean } {
	let budget = limit, clipped = false;
	const cut = (s: string) => {
		const out = s.slice(0, Math.max(0, budget));
		budget -= out.length;
		clipped ||= out.length < s.length;
		return out;
	};
	if (!message.parts) return { message: { ...message, text: cut(message.text) }, clipped };
	const parts = message.parts.map((p) => ({ ...p, text: cut(p.text) })).filter((p, i) => i === 0 || p.text !== "");
	return { message: { ...message, text: parts[0]!.text, parts }, clipped };
}
