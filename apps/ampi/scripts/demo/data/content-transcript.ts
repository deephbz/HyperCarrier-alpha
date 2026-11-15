import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DemoSession } from "../sessions.ts";

type DemoDataMode = "demo" | "worst" | "empty" | "one" | "huge";

const LINE = (value: unknown) => `${JSON.stringify(value)}\n`;
const TOOL_OUTPUT_CHARS = 48_000;
const TOOL_ARGS_JSON_CHARS = 2_048;
const PAGE_BYTES = 64 * 1024;

/** A full-length Find query used by the worst Session corpus. It appears in 220 entries. */
export const CONTENT_FIND_QUERY = (`Find boundary ${"needle ".repeat(68)}`).padEnd(500, "x");

/** Stable synthetic transcript data for the demo hub's worst-case content mode. */
export const CONTENT_TEXT = Object.freeze({
	toolOutput: `Synthetic command output begins.\n${"0123456789abcdef".repeat(2_997)}\nSynthetic command output ends.`,
	wideCode: `const result = await run({\n${"\tveryLongOptionName: \"realistic-value\",\n".repeat(18)}\t});`,
	diff: `diff --git a/src/reader.ts b/src/reader.ts\n${"+export const readerBoundary = \"preserve this complete line\";\n".repeat(80)}`,
	multilingual: "Đặng Thị Ngọc Hân · 王秀英 · نور الهدى عبد الرحمن · 🦊 Fox · 👩🏽‍💻 Priya",
});

const findCorpus = () => Array.from({ length: 220 }, (_, i) => `${CONTENT_FIND_QUERY} · result ${i + 1}`);

function message(id: string, parentId: string | null, timestamp: string, role: string, content: unknown[], extra: Record<string, unknown> = {}) {
	return { type: "message", id, parentId, timestamp, message: { role, content, timestamp: Date.parse(timestamp), ...extra } };
}

function writeSession(agentDir: string, now: number, mode: DemoDataMode): DemoSession[] {
	const name = `content-${mode}`;
	const cwd = "/work/synthetic/content";
	const id = `sess-${name}`;
	const dir = join(agentDir, "sessions", "--work-synthetic-content--");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${name}.jsonl`);
	const start = now - 60 * 60_000;
	const at = (n: number) => new Date(start + n * 1000).toISOString();
	const lines: unknown[] = [{ type: "session", version: 3, id, timestamp: at(0), cwd }];
	let parent: string | null = null;
	let seq = 0;
	const add = (role: string, content: unknown[], extra: Record<string, unknown> = {}) => {
		const entryId = `${name}-${++seq}`;
		lines.push(message(entryId, parent, at(seq), role, content, extra));
		parent = entryId;
	};

	if (mode === "one") {
		add("user", [{ type: "text", text: "One synthetic message." }]);
	} else if (mode === "worst") {
		add("user", [{ type: "text", text: `Inspect multilingual text: ${CONTENT_TEXT.multilingual}` }]);
		add("assistant", [{ type: "toolCall", id: "content-call-args", name: "read", arguments: { path: "/work/synthetic/content/large-input.json", command: "inspect", content: "x".repeat(TOOL_ARGS_JSON_CHARS * 2) } }], { stopReason: "toolUse" });
		add("toolResult", [{ type: "text", text: CONTENT_TEXT.toolOutput.slice(0, TOOL_OUTPUT_CHARS) }], { toolCallId: "content-call-args", toolName: "read", isError: true });
		add("assistant", [{ type: "text", text: `Wide code and diff samples follow.\n\n${CONTENT_TEXT.wideCode}\n\n${CONTENT_TEXT.diff}\n\n${CONTENT_TEXT.multilingual}` }], { stopReason: "error", errorMessage: "Synthetic tool failure: retry after checking the output." });
		// The page-boundary sample is measured in UTF-8 bytes and keeps its complete boundary value in the source.
		add("assistant", [{ type: "text", text: "p".repeat(PAGE_BYTES) }]);
		for (const hit of findCorpus()) add("user", [{ type: "text", text: hit }]);
	} else if (mode === "huge") {
		// A large single transcript exercises repeated entry rendering without changing component markup.
		for (let i = 0; i < 1_200; i++) {
			add(i % 2 ? "assistant" : "user", [{ type: "text", text: `Synthetic transcript row ${i + 1}: ${i % 5 === 0 ? CONTENT_TEXT.multilingual : "ordinary readable message"}` }]);
		}
	} // empty intentionally writes a valid header with no entries.

	writeFileSync(file, lines.map((line) => LINE(line)).join(""));
	return [{ name, file, id, cwd }];
}

/** Write transcript fixtures in the same Session directory and return normal demo Session records. */
export function writeContentSessions(agentDir: string, now: number, mode: DemoDataMode): DemoSession[] {
	if (mode === "demo") return [];
	return writeSession(agentDir, now, mode);
}
