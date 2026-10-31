import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PiEntry } from "../src/shared/protocol.ts";
import { countNew, newBelow, newBelowLabel } from "../web/src/components/new-below.ts";

// The "↓ new" chip names what arrived below the reader (owner request: "X new messages, Y tool uses").

const user = (id: string): PiEntry => ({ id, kind: "user", text: "Go on", images: 0 });
const prose = (id: string, extra: { type: "tool" | "thinking" }[] = []): PiEntry => ({ id, kind: "assistant", blocks: [{ type: "text", text: "Done." }, ...extra.map((b) => b.type === "tool" ? { type: "tool" as const, callId: `${id}-c`, name: "bash", args: { summary: "" } } : { type: "thinking" as const, text: "…" })] });
const tools = (id: string, n: number): PiEntry => ({ id, kind: "assistant", blocks: Array.from({ length: n }, (_, i) => ({ type: "tool" as const, callId: `${id}-${i}`, name: "read", args: { summary: "" } })) });
const result = (id: string): PiEntry => ({ id, kind: "tool-result", callId: "c", name: "read", isError: false, text: "", truncated: false });
const notice = (id: string): PiEntry => ({ id, kind: "custom", entryKind: "intercom", message: { kind: "intercom", label: "intercom", text: "hi" } });

test("countNew: prose counts as messages; tool calls, thinking and every non-prose entry count as tool use; results add nothing", () => {
	const table: [string, PiEntry[], { messages: number; steps: number }][] = [
		["a user prompt", [user("u")], { messages: 1, steps: 0 }],
		["prose with a thinking block and a tool call", [prose("a", [{ type: "thinking" }, { type: "tool" }])], { messages: 1, steps: 2 }],
		["tool calls and their results", [tools("t", 3), result("r1"), result("r2"), result("r3")], { messages: 0, steps: 3 }],
		["compaction, reset, extension message, model change", [{ id: "k", kind: "compaction", summary: "s" }, { id: "x", kind: "reset" }, notice("n"), { id: "m", kind: "system", changed: ["model"] }], { messages: 0, steps: 4 }],
		["an assistant error with no blocks", [{ id: "e", kind: "assistant", blocks: [], error: "overloaded" }], { messages: 1, steps: 0 }],
		["a blank text block beside a tool call", [{ id: "b", kind: "assistant", blocks: [{ type: "text", text: " " }, { type: "tool", callId: "c", name: "bash", args: { summary: "" } }] }], { messages: 0, steps: 1 }],
	];
	for (const [name, entries, want] of table) assert.deepEqual(countNew(entries), want, name);
});

test("newBelow: counts after the last-seen entry; a last-seen entry out of the window gives some; at the end gives nothing", () => {
	const list = [user("u1"), prose("a1"), tools("t1", 2), result("r1"), prose("a2")];
	assert.equal(newBelow(list, undefined), undefined, "the reader is at the end");
	assert.equal(newBelow(list, { last: "a2" }), undefined, "nothing arrived");
	assert.deepEqual(newBelow(list, { last: "a1" }), { messages: 1, steps: 2 });
	assert.deepEqual(newBelow(list, {}), { messages: 3, steps: 2 }, "an empty window when the reader left");
	assert.equal(newBelow(list, { last: "gone" }), "some");
});

test("newBelowLabel: omits a zero part; each count takes its own number", () => {
	assert.equal(newBelowLabel({ messages: 5, steps: 2 }), "↓ 5 new messages, 2 tool uses");
	assert.equal(newBelowLabel({ messages: 1, steps: 1 }), "↓ 1 new message, 1 tool use");
	assert.equal(newBelowLabel({ messages: 1, steps: 0 }), "↓ 1 new message");
	assert.equal(newBelowLabel({ messages: 0, steps: 5 }), "↓ 5 new tool uses");
	assert.equal(newBelowLabel({ messages: 0, steps: 1 }), "↓ 1 new tool use");
	assert.equal(newBelowLabel({ messages: 0, steps: 0 }), "↓ new");
	assert.equal(newBelowLabel("some"), "↓ new");
});
