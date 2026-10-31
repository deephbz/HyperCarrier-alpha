import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchEntry } from "../src/pi/search.ts";
import type { PiReaderEntry } from "../src/pi/views/types.ts";

// Session Find scans each entry once; the hit says whether the match is prose, so + Tools filters without a rescan.
const assistant = { id: "a1", kind: "assistant", blocks: [{ type: "text", text: "The rail marks prompts." }, { type: "tool-call", name: "bash" }] } as unknown as PiReaderEntry;
const native = { type: "message", message: { role: "assistant", content: [{ type: "text", text: "The rail marks prompts." }, { type: "toolCall", name: "bash", arguments: { command: "grep rail src" } }] } };
const tool = { id: "t1", kind: "tool", blocks: [] } as unknown as PiReaderEntry;
const toolNative = { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "src/rail.ts: rail" }] } };

test("session find: a match in agent text is prose and shows prose context", () => {
	assert.deepEqual(matchEntry(native, assistant, "rail marks"), { snippet: "The rail marks prompts.", prose: true });
});

test("session find: a match only in a tool call or tool result is not prose", () => {
	assert.equal(matchEntry(native, assistant, "grep rail")?.prose, false);
	assert.equal(matchEntry(toolNative, tool, "rail.ts")?.prose, false);
	assert.equal(matchEntry(native, assistant, "absent"), undefined);
});
