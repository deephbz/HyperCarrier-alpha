// Projects a pi-durable ConversationView into the render-only shape AmPi clients draw. Unchanged entries keep their
// projected object (memoized by the immutable EntryRecord), so chord's structural diff between two projections only
// walks what a commit changed.

import { clipInjected } from "../shared/entry-shapes.ts";
import type { Activity, InjectedMessage, PiQueuedItem, QueueOrigin, ThreadField } from "../shared/protocol.ts";
import type { ConversationView, EntryRecord, JsonValue } from "./durable-types.ts";
import { noticeMessage, queueOrigin } from "../shared/team-origin.ts";

export const TOOL_TEXT_LIMIT = 48_000;
const DETAILS_LIMIT = 24_000;

export type UiBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string; clipped?: boolean }
	| { type: "tool"; callId: string; name: string; args: JsonValue; argsClipped?: boolean }
	| { type: "image"; mimeType: string };

/** A card the preview shortened at its own bound; the card offers the source entry of `clippedBytes` UTF-8 bytes. */
export type Clipped = { clipped?: boolean; clippedBytes?: number };

export type UiEntry = { bodyAvailable?: boolean } & (
	| { id: string; kind: "user"; ts?: number; text: string; images: number; as?: string; data?: JsonValue }
	| {
			id: string;
			kind: "assistant";
			ts?: number;
			blocks: UiBlock[];
			stop?: string;
			error?: string;
			model?: string;
			usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
	  }
	| ({
			id: string;
			kind: "tool-result";
			ts?: number;
			callId: string;
			name: string;
			isError: boolean;
			text: string;
			truncated: boolean;
			details?: JsonValue;
	  } & Clipped)
	| ({ id: string; kind: "compaction"; summary: string; reason?: string; ts?: number; byTaskId?: string } & Clipped)
	| { id: string; kind: "reset"; handoff?: string; ts?: number }
	| { id: string; kind: "system"; changed: string[] }
	| ({ id: string; kind: "custom"; entryKind: string; ts?: number; data?: JsonValue; text?: string; message?: InjectedMessage } & Clipped));

export type UiThreadView = {
	/** Content key for bounded Pi pages and body reads. */
	sourceVersion?: string;
	conversationId: string;
	parent?: { conversationId: string; at: string };
	owner?: { conversationId: string; taskId: string };
	/** Entries before the active context's head that this view does not carry (compacted or reset away). */
	hiddenBefore: boolean;
	entries: UiEntry[];
	live: JsonValue;
	inbox: JsonValue;
	agent: JsonValue;
	usage: JsonValue;
};

const memo = new WeakMap<EntryRecord, UiEntry>();

function clip(text: string, limit: number): { text: string; truncated: boolean } {
	if (text.length <= limit) return { text, truncated: false };
	const head = Math.floor(limit * 0.3);
	const tail = limit - head;
	return {
		text: `${text.slice(0, head)}\n… ${text.length - limit} characters omitted …\n${text.slice(-tail)}`,
		truncated: true,
	};
}

function clipJson(value: JsonValue | undefined): JsonValue | undefined {
	if (value === undefined) return undefined;
	const text = JSON.stringify(value);
	if (text.length <= DETAILS_LIMIT) return value;
	return { truncated: true, preview: text.slice(0, DETAILS_LIMIT) };
}

type AnyContent = string | readonly { type: string; text?: string; thinking?: string; mimeType?: string }[];

export function contentText(content: AnyContent | undefined): string {
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

function countImages(content: AnyContent | undefined): number {
	if (content === undefined || typeof content === "string") return 0;
	return content.filter((part) => part.type === "image").length;
}

export function projectEntry(entry: EntryRecord): UiEntry {
	const cached = memo.get(entry);
	if (cached !== undefined) return cached;
	const projected = strip(projectEntryUncached(entry));
	memo.set(entry, projected);
	return projected;
}

function projectEntryUncached(entry: EntryRecord): UiEntry {
	const id = String(entry.id);
	// biome-ignore lint: pi-ai messages are loosely typed here on purpose
	const message = entry.model?.[0] as any;
	switch (entry.kind) {
		case "pi.user":
			return {
				id,
				kind: "user",
				ts: message?.timestamp,
				text: contentText(message?.content),
				images: countImages(message?.content),
			};
		case "pi.assistant": {
			const blocks: UiBlock[] = [];
			for (const part of (message?.content ?? []) as any[]) {
				if (part.type === "text" && part.text) blocks.push({ type: "text", text: part.text });
				else if (part.type === "thinking" && part.thinking) blocks.push({ type: "thinking", text: part.thinking });
				else if (part.type === "toolCall")
					blocks.push({ type: "tool", callId: String(part.id), name: part.name, args: part.arguments ?? {} });
			}
			const usage = message?.usage;
			return strip({
				id,
				kind: "assistant",
				ts: message?.timestamp,
				blocks,
				stop: message?.stopReason,
				error: message?.errorMessage,
				model: message?.model ? `${message.provider}/${message.model}` : undefined,
				usage: usage
					? {
							input: usage.input ?? 0,
							output: usage.output ?? 0,
							cacheRead: usage.cacheRead ?? 0,
							cacheWrite: usage.cacheWrite ?? 0,
							cost: usage.cost?.total ?? 0,
						}
					: undefined,
			}) as UiEntry;
		}
		case "pi.tool-result": {
			const { text, truncated } = clip(contentText(message?.content), TOOL_TEXT_LIMIT);
			return {
				id,
				kind: "tool-result",
				ts: message?.timestamp,
				callId: message?.toolCallId ?? "",
				name: message?.toolName ?? "",
				isError: message?.isError === true,
				text,
				truncated,
				details: clipJson(message?.details),
			};
		}
		case "pi.compaction":
			return {
				id,
				kind: "compaction",
				summary: unwrapSummary(contentText(message?.content)),
				reason: (entry.data as { reason?: string } | undefined)?.reason,
				ts: message?.timestamp,
				// The Auto Compact record of this compaction carries the same task ID.
				byTaskId: entry.byTaskId === undefined ? undefined : String(entry.byTaskId),
			};
		case "pi.reset":
			return { id, kind: "reset", handoff: message ? contentText(message.content) : undefined, ts: message?.timestamp };
		case "pi.system": {
			const changed: string[] = [];
			for (const m of (entry.model ?? []) as any[]) {
				for (const tool of m.toolsAdded ?? []) changed.push(`+${tool.name}`);
				for (const tool of m.toolsRemoved ?? []) changed.push(`-${typeof tool === "string" ? tool : tool.name}`);
			}
			return { id, kind: "system", changed };
		}
		default: {
			// An input placed with a custom entry kind (for example a Team notice) still has a user message for the
			// model; render it as its kind, never as human input.
			const data = clipJson(entry.data);
			const ts =
				message?.timestamp ?? ((entry.data as { ts?: number } | null | undefined)?.ts as number | undefined);
			const text = message ? contentText(message.content) : undefined;
			return {
				id,
				kind: "custom",
				entryKind: entry.kind,
				ts,
				data,
				text: text === undefined ? undefined : clip(text, TOOL_TEXT_LIMIT).text,
				// The row the hub copy would show (pi/projection.ts), so a thread without a copy reads alike.
				message: text === undefined ? undefined : clipInjected(noticeMessage(entry.kind, entry.data, text), TOOL_TEXT_LIMIT).message,
			};
		}
	}
}

// Durable wraps every placed summary (hook or native) for the model (pi-durable harness/compaction.js). The row shows
// the summary as written, as a Pi Session's compaction entry does.
const SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const SUMMARY_SUFFIX = "\n</summary>";
export function unwrapSummary(text: string): string {
	if (!text.startsWith(SUMMARY_PREFIX)) return text;
	const body = text.slice(SUMMARY_PREFIX.length);
	return body.endsWith(SUMMARY_SUFFIX) ? body.slice(0, -SUMMARY_SUFFIX.length) : body;
}

// biome-ignore lint: LiveState is loosely typed at this boundary
export function activityOf(live: any): Activity {
	if (!live) return "idle";
	if (live.compactions?.some((c: { blocking: boolean }) => c.blocking)) return "compacting";
	if (live.generation?.retry) return "retrying";
	if (live.tools?.some((t: { status: string }) => t.status !== "done")) return "tools";
	// A model request in flight is "streaming", as a Pi Session reports it, before its first token too.
	if (live.generation) return "streaming";
	if (live.run) return "waiting";
	// A background compaction with no run still works on the thread; Stop cancels it.
	if (live.compactions?.length) return "compacting";
	return "idle";
}

export const RETURNED_KIND = "ampi.returned";
export type ReturnedState = { items: { id: string; mode: "steer" | "followUp"; content: string; at: number; origin?: QueueOrigin }[] };

export { queueOrigin, TEAM_TASK_ID_LIMIT } from "../shared/team-origin.ts";

/**
 * The inbox a Pi Session shows: inputs still queued, then inputs Esc returned, each with its state. Queued text comes
 * from `pi.inbox`; passive writes are not owner input and stay out. Each item keeps the origin its entry data names.
 */
function projectInbox(inbox: JsonValue | undefined, returned: ReturnedState | undefined): { items: PiQueuedItem[] } {
	// biome-ignore lint: native inbox items are loosely typed here
	const queued = (((inbox as any)?.items ?? []) as any[])
		.filter((item) => item.mode !== "write")
		.map((item): PiQueuedItem => {
			const content = contentText(item.content);
			const origin = queueOrigin(item.entry, content);
			return { id: String(item.id), mode: item.mode, content, state: "queued", ...(origin ? { origin } : {}) };
		});
	const back = (returned?.items ?? []).map((item): PiQueuedItem => ({ id: item.id, mode: item.mode, content: item.content, state: "returned", ...(item.origin ? { origin: item.origin } : {}) }));
	return { items: [...back, ...queued] };
}

/** Pi's `live.run` is `{ activity }`. The streaming fields (`generation`, `tools`, `compactions`) stay for ThreadView. */
function trimLive(live: JsonValue | undefined): JsonValue {
	if (live === undefined || live === null || typeof live !== "object") return {};
	const value = { ...(live as Record<string, any>) };
	if (value.run) value.run = { activity: activityOf(live) };
	const tools = Array.isArray(value.tools)
		? value.tools.map((slot: any) =>
				strip({
					...slot,
					output: typeof slot.output === "string" ? clip(slot.output, 16_000).text : slot.output,
					details: clipJson(slot.details),
				}),
			)
		: undefined;
	return { ...value, ...(tools ? { tools } : {}) };
}

/** Removes undefined fields so the value is strict JSON for chord's diff and the wire. */
export function strip<T extends object>(value: T): T {
	for (const key of Object.keys(value) as (keyof T)[]) if (value[key] === undefined) delete value[key];
	return value;
}

/** Only `fields` of the thread view. It reads no entry, so a subscriber that asks for these fields costs no entry projection. */
export function projectViewFields(view: ConversationView, returned: ReturnedState | undefined, fields: readonly ThreadField[]): Partial<UiThreadView> {
	return {
		...(fields.includes("live") ? { live: trimLive(view.docs["pi.live"] as JsonValue) } : {}),
		...(fields.includes("inbox") ? { inbox: projectInbox(view.docs["pi.inbox"] as JsonValue, returned) } : {}),
	};
}

/** `returned` is the node's own `ampi.returned` document; the view mounts only pi-durable's built-in documents. */
export function projectView(view: ConversationView, returned?: ReturnedState): UiThreadView {
	const record = view.conversation;
	const first = view.entries[0];
	return strip({
		conversationId: String(record.id),
		parent: record.parent
			? { conversationId: String(record.parent.conversationId), at: String(record.parent.at) }
			: undefined,
		owner: record.owner
			? { conversationId: String(record.owner.conversationId), taskId: String(record.owner.taskId) }
			: undefined,
		hiddenBefore: first !== undefined && first.head !== undefined && first.kind !== "pi.user",
		entries: view.entries.map(projectEntry),
		live: trimLive(view.docs["pi.live"] as JsonValue),
		inbox: projectInbox(view.docs["pi.inbox"] as JsonValue, returned),
		agent: (view.docs["pi.agent"] as JsonValue) ?? {},
		usage: (view.docs["pi.usage"] as JsonValue) ?? { models: {}, tools: {} },
	});
}
