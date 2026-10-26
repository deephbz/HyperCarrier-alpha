// The first model request of a fresh conversation, as Pi and the durable node send it for the same synthetic setup.
// `scripts/capture-pi-request.mjs` records Pi's side into `fixtures/pi-request.json`; `node-request-parity.test.ts`
// captures the node's side in-process and compares the two through `requestShape`.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The synthetic model both sides use: a reasoning Anthropic Messages model with image input. */
export const PARITY_MODEL = {
	id: "claude/claude-opus-5-5",
	name: "Claude Opus 5.5 (synthetic)",
	api: "anthropic-messages",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 1_000_000,
	maxTokens: 32_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as const;

export const PARITY_PROMPT = "Reply with OK.";
/** The provider name both sides register the synthetic model under. */
export const PARITY_PROVIDER = "parity-capture";

/**
 * Pi's resource layout for the capture: global settings that pick the synthetic model and its thinking level, two
 * context files, one global skill, and a Git project.
 */
export function writeParityFixture(base: string) {
	const w = (path: string, text: string) => {
		mkdirSync(dirname(join(base, path)), { recursive: true });
		writeFileSync(join(base, path), text);
	};
	const home = join(base, "user");
	const agent = join(home, ".pi", "agent");
	const project = join(base, "project");
	w("user/.pi/agent/settings.json", JSON.stringify({ defaultProvider: PARITY_PROVIDER, defaultModel: PARITY_MODEL.id, defaultTools: ["+codemode"], defaultThinkingLevel: "medium", compaction: { enabled: false }, retry: { enabled: false } }));
	w("user/.pi/agent/AGENTS.md", "Fixture global instructions.\n");
	w("user/.agents/skills/fixture-skill/SKILL.md", "---\nname: fixture-skill\ndescription: A synthetic skill for the request parity check.\n---\nbody\n");
	w("project/AGENTS.md", "Fixture project instructions.\n");
	mkdirSync(join(project, ".git"), { recursive: true });
	return { home, agent, project };
}

export type WireBlock = { type: string; text: string; cache_control?: unknown };
export type WireTool = { name: string; description: string; input_schema: unknown; cache_control?: unknown };
/** A whole first request: the wire body and the `anthropic-beta` header, with machine-specific strings replaced. */
export type RequestShape = {
	/** The `anthropic-beta` header, split; the SDK moves the body's `betas` parameter there. */
	betas: string[];
	/** Every body field as sent: model, stream, max_tokens, thinking, system blocks with their exact text and cache marks, tools, messages. */
	body: { system: WireBlock[]; tools: WireTool[]; [field: string]: unknown };
};

/**
 * The whole request with machine-specific text replaced in every string: each `paths` key by its placeholder, and
 * each `lines` key by its placeholder where it is a whole line. Nothing else changes; neither Pi 1.4.0 nor the node
 * sends a date line, so no date is replaced.
 */
export function requestShape(body: any, betaHeader: string | undefined, paths: Record<string, string>, lines: Record<string, string> = {}): RequestShape {
	const ordered = Object.entries(paths).sort((a, b) => b[0].length - a[0].length);
	const scrubText = (text: string) => {
		let out = text;
		for (const [path, placeholder] of ordered) out = out.split(path).join(placeholder);
		return out
			.split("\n")
			.map((line) => lines[line] ?? line)
			.join("\n");
	};
	const scrub = (value: unknown): unknown => {
		if (typeof value === "string") return scrubText(value);
		if (Array.isArray(value)) return value.map(scrub);
		if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, scrub(inner)]));
		return value;
	};
	return {
		betas: (betaHeader ?? "").split(",").map((beta) => beta.trim()).filter(Boolean),
		body: scrub(body) as RequestShape["body"],
	};
}
