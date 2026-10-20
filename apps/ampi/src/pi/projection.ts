import type { JsonValue } from "../node/durable-types.ts";
import { injectedMessage, toolArgsPreview } from "../shared/entry-shapes.ts";
import type { PiBlock, PiEntry } from "../shared/protocol.ts";
type ReaderEntry = {
	ref: string;
	id: string;
	parent: string | null;
	t: number | null;
	kind: "human" | "injected" | "assistant" | "tool" | "compaction" | "branch-summary" | "other";
	name?: string | null;
	role?: string;
	model?: string;
	usage?: { input?: number | null; output?: number | null; cacheRead?: number | null; cacheWrite?: number | null; cost?: number | null };
	blocks?: ({ type: "text"; text: string } | { type: "thinking"; text: string } | { type: "toolCall"; id: string; name: string; args: JsonValue } | { type: "image"; mimeType: string })[];
	result?: { callId: string; isError: boolean; text: string };
	customType?: string;
	summary?: string;
	text?: string;
	stop?: string;
	error?: string;
};

const TOOL_TEXT_LIMIT = 48_000;
const clip = (text: string, limit: number) => (text.length <= limit ? { text, truncated: false } : { text: text.slice(0, limit), truncated: true });

/**
 * The keys each projected entry kind and block type may carry to the browser in a full entry. Model, usage, cost,
 * provider, signatures, response IDs and parent links stay in the hub (A24).
 */
const ENTRY_KEYS: Record<PiEntry["kind"], readonly string[]> = {
	user: ["id", "kind", "ts", "text", "images"],
	assistant: ["id", "kind", "ts", "blocks", "stop", "error"],
	"tool-result": ["id", "kind", "ts", "callId", "name", "isError", "text", "truncated"],
	compaction: ["id", "kind", "ts", "summary", "reason"],
	custom: ["id", "kind", "ts", "entryKind", "message"],
	reset: ["id", "kind", "ts", "handoff"],
	system: ["id", "kind", "changed"],
};
const BLOCK_KEYS: Record<PiBlock["type"], readonly string[]> = {
	text: ["type", "text"],
	thinking: ["type", "text"],
	tool: ["type", "callId", "name", "args", "argsClipped"],
	image: ["type", "mimeType"],
};
const pick = <T extends object>(value: T, keys: readonly string[]): T =>
	Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key))) as T;

/** One full projected entry for the browser: only the allowed keys of its kind. */
export function wireEntry(e: PiEntry): PiEntry {
	const out = pick(e, ENTRY_KEYS[e.kind] ?? ["id", "kind"]);
	if (out.kind === "assistant") out.blocks = out.blocks.map((b) => pick(b, BLOCK_KEYS[b.type] ?? ["type"]));
	return out;
}

/** Projects one reader entry into the GUI's entry shape. Returns undefined for entries the transcript does not draw. */
export function projectEntry(e: ReaderEntry): PiEntry | undefined {
	const ts = e.t ?? undefined;
	switch (e.kind) {
		case "human": {
			const text = (e.blocks ?? []).filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n") || e.text || "";
			const images = (e.blocks ?? []).filter((b) => b.type === "image").length;
			return { id: e.id, kind: "user", ...(ts ? { ts } : {}), text, images };
		}
		case "injected":
		{
			const entryKind = e.customType ?? "message";
			const text = e.text ?? (e.blocks ?? []).map((b) => ("text" in b ? b.text : "")).join("\n");
			return { id: e.id, kind: "custom", entryKind, ...(ts ? { ts } : {}), message: injectedMessage(entryKind, text) };
		}
		case "assistant": {
			const blocks: PiBlock[] = [];
			for (const b of e.blocks ?? []) {
				if (b.type === "text" || b.type === "thinking") blocks.push({ type: b.type, text: b.text });
				else if (b.type === "toolCall") blocks.push({ type: "tool", callId: b.id, name: b.name, args: toolArgsPreview(b.name, b.args) });
				else if (b.type === "image") blocks.push({ type: "image", mimeType: b.mimeType });
			}
			return {
				id: e.id,
				kind: "assistant",
				...(ts ? { ts } : {}),
				blocks,
				...(e.stop ? { stop: e.stop } : {}),
				...(e.error ? { error: e.error } : {}),
			};
		}
		case "tool": {
			const r = e.result ?? { callId: "", isError: false, text: e.text ?? "" };
			const { text, truncated } = clip(r.text, TOOL_TEXT_LIMIT);
			return { id: e.id, kind: "tool-result", ...(ts ? { ts } : {}), callId: r.callId, name: e.name ?? "", isError: r.isError, text, truncated };
		}
		case "compaction":
			return { id: e.id, kind: "compaction", summary: e.summary ?? e.text ?? "", ...(ts ? { ts } : {}) };
		case "branch-summary":
			return { id: e.id, kind: "compaction", summary: e.summary ?? e.text ?? "", reason: "branch", ...(ts ? { ts } : {}) };
		default:
		{
			if (!e.text) return undefined;
			const entryKind = e.role ?? e.customType ?? e.kind;
			return { id: e.id, kind: "custom", entryKind, ...(ts ? { ts } : {}), message: injectedMessage(entryKind, e.text) };
		}
	}
}
