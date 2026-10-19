import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { iso, line, setup } from "./pi-host-fixtures.ts";

// Each native field carries a unique sentinel. thread.entry must send none of them (A24, wire-boundary rule 1).
const SENTINELS = ["SENTINEL_MODEL", "SENTINEL_PROVIDER", "SENTINEL_API", "SENTINEL_SIGNATURE", "SENTINEL_RESPONSE", "SENTINEL_DETAILS", "SENTINEL_DATA", "SENTINEL_KEPT", "SENTINEL_FROM", "4242.5", "987654321", "\"parentId\""];
const ENTRY_KEYS: Record<string, string[]> = {
	user: ["id", "kind", "ts", "text", "images"],
	assistant: ["id", "kind", "ts", "blocks", "stop", "error"],
	"tool-result": ["id", "kind", "ts", "callId", "name", "isError", "text", "truncated"],
	compaction: ["id", "kind", "ts", "summary", "reason"],
	custom: ["id", "kind", "ts", "entryKind", "text"],
};
const BLOCK_KEYS: Record<string, string[]> = { text: ["type", "text"], thinking: ["type", "text"], tool: ["type", "callId", "name", "args"], image: ["type", "mimeType"] };
const LONG = "long prose ".repeat(2000);

const entries = [
	{ type: "message", id: "u1", parentId: null, timestamp: iso(1), message: { role: "user", content: [{ type: "text", text: LONG }], timestamp: 1 } },
	{
		type: "message",
		id: "a1",
		parentId: "u1",
		timestamp: iso(2),
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "weighing", thinkingSignature: "SENTINEL_SIGNATURE" },
				{ type: "text", text: LONG },
				{ type: "toolCall", id: "call-a1", name: "bash", arguments: { command: "ls" } },
			],
			api: "SENTINEL_API",
			provider: "SENTINEL_PROVIDER",
			model: "SENTINEL_MODEL",
			usage: { input: 987654321, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 4242.5 } },
			stopReason: "toolUse",
			responseId: "SENTINEL_RESPONSE",
			durationMs: 987654321,
			timestamp: 2,
		},
	},
	{ type: "message", id: "r1", parentId: "a1", timestamp: iso(3), message: { role: "toolResult", toolCallId: "call-a1", toolName: "bash", content: [{ type: "text", text: "a.txt" }], details: { note: "SENTINEL_DETAILS" }, isError: false } },
	{ type: "custom_message", id: "c1", parentId: "r1", timestamp: iso(4), customType: "intercom", content: "a peer wrote", display: true, details: { from: "SENTINEL_DATA" } },
	{ type: "compaction", id: "k1", parentId: "c1", timestamp: iso(5), summary: "kept work", firstKeptEntryId: "SENTINEL_KEPT", tokensBefore: 987654321 },
	{ type: "branch_summary", id: "b1", parentId: "k1", timestamp: iso(6), fromId: "SENTINEL_FROM", summary: "left branch" },
];

test("thread.entry sends only the allow-listed projected entry of every kind, never a native field", async (t) => {
	const { f, browser } = await setup(t);
	writeFileSync(f.sessionA, line({ type: "session", version: 3, id: "sess-a", timestamp: iso(0), cwd: "/work" }) + entries.map(line).join(""));
	await browser.until<any>(browser.sub("devbox", { kind: "threads" }), (v) => v.threads["pi:sess-a"]);
	const thread = browser.sub("devbox", { kind: "thread", threadId: "pi:sess-a" });
	const view = await browser.until<any>(thread, (v) => v.entries.length === entries.length);
	assert.deepEqual(view.entries.map((e: any) => e.kind), ["user", "assistant", "tool-result", "custom", "compaction", "compaction"]);
	for (const { id } of entries)
		await t.test(id, async () => {
			let text = "", offset = 0, version: string | undefined, page: any;
			do {
				page = await browser.req("devbox", "thread.entry", { threadId: "pi:sess-a", entry: id, offset, version });
				text += page.text; offset = page.next; version = page.version;
			} while (page.more);
			for (const sentinel of SENTINELS) assert.ok(!text.includes(sentinel), `${id} sends ${sentinel}`);
			assert.deepEqual(Object.keys(page).sort(), ["more", "next", "text", "version"]);
			const full = JSON.parse(text);
			for (const key of Object.keys(full)) assert.ok(ENTRY_KEYS[full.kind]!.includes(key), `${full.kind} sends ${key}`);
			for (const block of full.blocks ?? []) for (const key of Object.keys(block)) assert.ok(BLOCK_KEYS[block.type]!.includes(key), `${block.type} block sends ${key}`);
			if (id === "u1") assert.equal(full.text, LONG);
			if (id === "a1") assert.deepEqual(full.blocks.map((b: any) => b.type === "text" ? b.text.length : b.type), ["thinking", LONG.length, "tool"]);
		});
});
