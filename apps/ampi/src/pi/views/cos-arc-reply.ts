// The reply shape of every Arc model call. Pi's CLI offers no structured output, so the Build parses text: this module
// is the only place that decides whether a reply has the shape its purpose needs. Callers read the typed result and
// never re-check shape.

/** What an Arc model call is for. */
export type ArcPurpose = "label" | "synthesis" | "context";
export type LabelReply = { chunks: unknown[] };
export type SynthesisReply = { headline: string; projects: unknown[]; transitions: unknown[] };
export type ContextReply = { asks: unknown[]; threads: unknown[]; unassigned: Record<string, unknown> };
type Replies = { label: LabelReply; synthesis: SynthesisReply; context: ContextReply };

/**
 * An invalid reply: `reason` names the first missing or mistyped field, for the retry note. `message` defaults to
 * the purpose and reason; a rule with owner-facing wording passes its own.
 */
export class InvalidReply extends Error {
	readonly code = "answer";
	/** The model that gave the reply, when the caller knows it. */
	model: string | null = null;
	readonly purpose: ArcPurpose;
	readonly reason: string;
	constructor(purpose: ArcPurpose, reason: string, message = `${purpose} reply invalid: ${reason}`) { super(message); this.purpose = purpose; this.reason = reason; }
}

/**
 * The first JSON object in a model answer. Fences and text around it are ignored, and a second object that some
 * models append is dropped, so only an answer without any complete object fails.
 */
export function json(source: string): unknown {
	const start = source.indexOf("{");
	if (start >= 0) {
		let depth = 0, quoted = false, escaped = false;
		for (let i = start; i < source.length; i++) {
			const ch = source[i];
			if (quoted) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') quoted = false; continue; }
			if (ch === '"') quoted = true;
			else if (ch === "{") depth++;
			else if (ch === "}" && --depth === 0) {
				try { return JSON.parse(source.slice(start, i + 1)); } catch { break; }
			}
		}
	}
	throw Object.assign(new Error("The model did not return an Arc JSON object. Try Build arc again with a JSON-capable model."), { code: "answer" });
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const REQUIRED: { [P in ArcPurpose]: [string, "array" | "object" | "text"][] } = {
	label: [["chunks", "array"]],
	synthesis: [["headline", "text"], ["projects", "array"], ["transitions", "array"]],
	context: [["asks", "array"], ["threads", "array"], ["unassigned", "object"]],
};

/**
 * The reply `text` as its purpose's shape, or InvalidReply. Each required top-level field must exist with its type,
 * and a headline must not be empty. A reply that echoes the prompt (the result nested under `shape`) is invalid.
 */
export function reply<P extends ArcPurpose>(purpose: P, text: string): Replies[P] {
	let value: unknown;
	try { value = json(text); } catch { throw new InvalidReply(purpose, "no complete JSON object"); }
	if (!isObject(value)) throw new InvalidReply(purpose, "not a JSON object");
	for (const [field, type] of REQUIRED[purpose]) {
		const v = value[field];
		const ok = type === "array" ? Array.isArray(v) : type === "object" ? isObject(v) : typeof v === "string" && v.trim().length > 0;
		if (!ok) throw new InvalidReply(purpose, `${v === undefined ? "missing" : type === "text" ? "empty or non-text" : `non-${type}`} ${field}${v === undefined && "shape" in value ? " (the reply echoed the prompt)" : ""}`);
	}
	return value as Replies[P];
}

/** The retry's extra system line: what was wrong, and what to return instead. */
export const retryNote = (e: InvalidReply) =>
	`\n\nYour previous reply was invalid (${e.reason}). Return only the result object with its required top-level fields (${REQUIRED[e.purpose].map(([f]) => f).join(", ")}). Do not repeat the input.`;
